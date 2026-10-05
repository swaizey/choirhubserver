import {
  getSupabaseTableUrl,
  isBulkUploadAuthorized,
  jsonResponse,
  readJsonBody,
  supabaseRequest,
} from './http.js'

const BULK_IMPORT_BATCH_SIZE = 50
export const MAX_PDF_BYTES = 15 * 1024 * 1024

function extractDriveFolderId(value) {
  try {
    const url = new URL(value)
    if (url.hostname !== 'drive.google.com' || url.protocol !== 'https:') return null
    const match = url.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)\/?$/)
      || url.pathname.match(/^\/folders\/([a-zA-Z0-9_-]+)\/?$/)
    return match?.[1] || null
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
}

function makeDriveApiUrl(path, params, apiKey) {
  const url = new URL(`https://www.googleapis.com/drive/v3/${path}`)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('key', apiKey)
  return url
}

async function createDriveDownloadTicket(folderId, fileId, expiresAt, bulkToken) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(bulkToken),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const payload = `${folderId}\n${fileId}\n${expiresAt}`
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(payload)),
  )
  const signatureHex = Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${expiresAt}.${signatureHex}`
}

async function isValidDriveDownloadTicket(ticket, folderId, fileId, bulkToken) {
  if (typeof ticket !== 'string') return false
  const match = ticket.match(/^(\d{13})\.([0-9a-f]{64})$/)
  if (!match) return false

  const expiresAt = Number(match[1])
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false

  const expected = await createDriveDownloadTicket(folderId, fileId, expiresAt, bulkToken)
  const expectedSignature = expected.slice(expected.indexOf('.') + 1)
  let difference = 0
  for (let index = 0; index < expectedSignature.length; index += 1) {
    difference |= expectedSignature.charCodeAt(index) ^ match[2].charCodeAt(index)
  }
  return difference === 0
}

async function listDrivePdfs(folderId, apiKey) {
  const files = []
  let pageToken

  do {
    const url = makeDriveApiUrl('files', {
      q: `'${folderId}' in parents and trashed = false`,
      pageSize: '100',
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      ...(pageToken ? { pageToken } : {}),
    }, apiKey)
    const response = await fetch(url)
    if (!response.ok) {
      console.error(JSON.stringify({ message: 'Google Drive file listing failed.', status: response.status }))
      throw new Error('Could not read the shared Google Drive folder. Check that it is public and the Drive API is enabled.')
    }

    const result = await response.json()
    if (!Array.isArray(result.files)) {
      throw new Error('Google Drive returned an invalid file list.')
    }
    files.push(...result.files.filter((file) => (
      file.mimeType === 'application/pdf' || file.name?.toLowerCase().endsWith('.pdf')
    )))

    pageToken = result.nextPageToken
  } while (pageToken)

  return files
}

export function makePublicObjectUrl(baseUrl, objectKey) {
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('R2 public base URL must be a clean HTTPS URL.')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/')
  url.pathname = `${basePath}/${encodedKey}`
  return url.toString()
}

export function validateCategory(category) {
  return typeof category === 'string'
    && Boolean(category.trim())
    && category.trim().length <= 120
    && !category.includes('/')
    && !category.includes('\\')
    && category.trim() !== '.'
    && category.trim() !== '..'
    && !Array.from(category).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
}

function decodeMetadataHeader(value) {
  if (typeof value !== 'string') return null
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}

function addPdfCorsHeaders(headers, origin) {
  if (!origin) return
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization, Content-Type, X-Drive-File-Id, X-Metadata-Title, X-Metadata-Composer, X-Metadata-Category',
  )
  headers.set('Vary', 'Origin')
}

export async function readPdfBytes(stream) {
  const reader = stream.getReader()
  const chunks = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_PDF_BYTES) {
      await reader.cancel()
      throw new RangeError('PDF exceeds the 15 MB per-file limit.')
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
    throw new TypeError('The uploaded file is not a valid PDF.')
  }

  return bytes
}

export async function handleBulkImport(request, env, origin) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415, origin)
  }
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'Bulk upload authorization failed.' }, 401, origin)
  }
  if (!env.GOOGLE_DRIVE_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Bulk upload Worker configuration is incomplete.' }))
    return jsonResponse({ error: 'Bulk upload is not configured.' }, 503, origin)
  }

  const body = await readJsonBody(request)
  if (body.error) return jsonResponse({ error: body.error }, body.status, origin)

  const data = body.data
  if (
    !data
    || typeof data !== 'object'
    || typeof data.folderUrl !== 'string'
    || !validateCategory(data.category)
  ) {
    return jsonResponse({ error: 'A Google Drive folder URL and category (1–120 characters, no slashes) are required.' }, 400, origin)
  }

  const folderId = extractDriveFolderId(data.folderUrl)
  if (!folderId) {
    return jsonResponse({ error: 'Enter a valid Google Drive folder URL.' }, 400, origin)
  }

  let files
  try {
    files = await listDrivePdfs(folderId, env.GOOGLE_DRIVE_API_KEY)
  } catch (error) {
    if (error instanceof Error) {
      return jsonResponse({ error: error.message }, 400, origin)
    }
    throw error
  }
  if (files.length === 0) {
    return jsonResponse({ error: 'The shared folder contains no PDF files.' }, 400, origin)
  }

  const existingIds = new Set()
  try {
    for (let index = 0; index < files.length; index += BULK_IMPORT_BATCH_SIZE) {
      const fileBatch = files.slice(index, index + BULK_IMPORT_BATCH_SIZE)
      const existingResponse = await supabaseRequest(
        env,
        getSupabaseTableUrl(env, 'sheet_music', {
          select: 'drive_file_id',
          drive_file_id: `in.(${fileBatch.map((file) => file.id).join(',')})`,
        }),
      )
      if (!existingResponse.ok) {
        console.error(JSON.stringify({
          message: 'Supabase duplicate check failed.',
          status: existingResponse.status,
        }))
        return jsonResponse({ error: 'Could not prepare the import. Check the sheet_music table in Supabase.' }, 502, origin)
      }

      const existingRows = await existingResponse.json()
      if (!Array.isArray(existingRows)) {
        console.error(JSON.stringify({ message: 'Supabase returned an invalid duplicate-check response.' }))
        return jsonResponse({ error: 'Could not prepare the import.' }, 502, origin)
      }
      for (const row of existingRows) {
        existingIds.add(row.drive_file_id)
      }
    }
  } catch {
    console.error(JSON.stringify({ message: 'Could not check existing Supabase records.' }))
    return jsonResponse({ error: 'Could not prepare the import. Check Supabase configuration.' }, 502, origin)
  }

  const pendingFiles = files.filter((file) => !existingIds.has(file.id))
  const ticketExpiry = Date.now() + 24 * 60 * 60 * 1000
  const filesWithTickets = await Promise.all(pendingFiles.map(async ({ id, name, size }) => ({
    id,
    name,
    size,
    downloadTicket: await createDriveDownloadTicket(
      folderId,
      id,
      ticketExpiry,
      env.BULK_UPLOAD_TOKEN,
    ),
  })))
  return jsonResponse({
    files: filesWithTickets,
    skipped: files.length - pendingFiles.length,
    batchSize: BULK_IMPORT_BATCH_SIZE,
  }, 200, origin)
}

export async function handleBulkDownload(request, env, origin) {
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'Bulk upload authorization failed.' }, 401, origin)
  }
  if (!env.GOOGLE_DRIVE_API_KEY) {
    console.error(JSON.stringify({ message: 'Google Drive API key is not configured.' }))
    return jsonResponse({ error: 'Google Drive import is not configured.' }, 503, origin)
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415, origin)
  }

  const body = await readJsonBody(request)
  if (body.error) return jsonResponse({ error: body.error }, body.status, origin)

  const { folderId, fileId, downloadTicket } = body.data || {}
  if (
    typeof folderId !== 'string'
    || !/^[a-zA-Z0-9_-]+$/.test(folderId)
    || typeof fileId !== 'string'
    || !/^[a-zA-Z0-9_-]+$/.test(fileId)
  ) {
    return jsonResponse({ error: 'A valid Drive folder ID and PDF file ID are required.' }, 400, origin)
  }
  if (!await isValidDriveDownloadTicket(downloadTicket, folderId, fileId, env.BULK_UPLOAD_TOKEN)) {
    return jsonResponse({ error: 'This PDF is not in the current import list. Refresh the folder list and try again.' }, 403, origin)
  }

  let metadataResponse
  try {
    metadataResponse = await fetch(makeDriveApiUrl(`files/${encodeURIComponent(fileId)}`, {
      fields: 'id,name,mimeType,size,parents',
      supportsAllDrives: 'true',
    }, env.GOOGLE_DRIVE_API_KEY))
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Google Drive metadata request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not verify this PDF in Google Drive.' }, 502, origin)
  }

  if (!metadataResponse.ok) {
    return jsonResponse({ error: 'Could not verify this PDF in Google Drive.' }, 400, origin)
  }

  const metadata = await metadataResponse.json()
  if (Array.isArray(metadata.parents) && !metadata.parents.includes(folderId)) {
    return jsonResponse({ error: 'The PDF is not in the selected Drive folder.' }, 400, origin)
  }
  if (metadata.mimeType !== 'application/pdf' && !metadata.name?.toLowerCase().endsWith('.pdf')) {
    return jsonResponse({ error: 'The selected Drive file is not a PDF.' }, 400, origin)
  }
  if (metadata.size && Number(metadata.size) > MAX_PDF_BYTES) {
    return jsonResponse({ error: 'PDF exceeds the 15 MB per-file limit.' }, 413, origin)
  }

  let downloadResponse
  try {
    downloadResponse = await fetch(makeDriveApiUrl(`files/${encodeURIComponent(fileId)}`, {
      alt: 'media',
      supportsAllDrives: 'true',
    }, env.GOOGLE_DRIVE_API_KEY))
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Google Drive download failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not download this PDF from Google Drive.' }, 502, origin)
  }

  if (!downloadResponse.ok || !downloadResponse.body) {
    return jsonResponse({ error: 'Could not download this PDF from Google Drive.' }, 502, origin)
  }

  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  const contentLength = downloadResponse.headers.get('Content-Length')
  if (contentLength) headers.set('Content-Length', contentLength)
  addPdfCorsHeaders(headers, origin)
  return new Response(downloadResponse.body, { status: 200, headers })
}

export async function handleBulkPdfUpload(request, env, origin) {
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'Bulk upload authorization failed.' }, 401, origin)
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/pdf') {
    return jsonResponse({ error: 'Content-Type must be application/pdf.' }, 415, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PDF_BUCKET || !env.R2_PUBLIC_BASE_URL) {
    console.error(JSON.stringify({ message: 'Bulk upload storage configuration is incomplete.' }))
    return jsonResponse({ error: 'Bulk upload storage is not configured.' }, 503, origin)
  }

  const driveFileId = request.headers.get('X-Drive-File-Id') || ''
  const title = decodeMetadataHeader(request.headers.get('X-Metadata-Title'))
  const composer = decodeMetadataHeader(request.headers.get('X-Metadata-Composer'))
  const category = decodeMetadataHeader(request.headers.get('X-Metadata-Category'))
  if (
    !/^[a-zA-Z0-9_-]+$/.test(driveFileId)
    || !title?.trim()
    || title.trim().length > 200
    || composer === null
    || composer.length > 160
    || !validateCategory(category)
  ) {
    return jsonResponse({ error: 'PDF metadata is invalid.' }, 400, origin)
  }
  if (!request.body) {
    return jsonResponse({ error: 'A PDF body is required.' }, 400, origin)
  }
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
    return jsonResponse({ error: 'PDF exceeds the 15 MB per-file limit.' }, 413, origin)
  }

  let existingResponse
  try {
    existingResponse = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        select: 'id',
        drive_file_id: `eq.${driveFileId}`,
      }),
    )
  } catch {
    console.error(JSON.stringify({ message: 'Could not check for an existing sheet music record.' }))
    return jsonResponse({ error: 'Could not prepare the PDF upload.' }, 502, origin)
  }
  if (!existingResponse.ok) {
    console.error(JSON.stringify({
      message: 'Supabase duplicate check failed.',
      status: existingResponse.status,
    }))
    return jsonResponse({ error: 'Could not prepare the PDF upload.' }, 502, origin)
  }
  const existingRows = await existingResponse.json()
  if (!Array.isArray(existingRows)) {
    return jsonResponse({ error: 'Could not prepare the PDF upload.' }, 502, origin)
  }
  if (existingRows.length > 0) {
    return jsonResponse({ error: 'This Drive PDF has already been imported.' }, 409, origin)
  }

  let fileUrl
  try {
    fileUrl = makePublicObjectUrl(env.R2_PUBLIC_BASE_URL, `${category.trim()}/${crypto.randomUUID()}.pdf`)
  } catch (error) {
    if (error instanceof TypeError) {
      console.error(JSON.stringify({ message: 'R2_PUBLIC_BASE_URL is invalid.' }))
      return jsonResponse({ error: 'PDF storage is not configured.' }, 503, origin)
    }
    throw error
  }
  const objectKey = decodeURIComponent(new URL(fileUrl).pathname.split('/').slice(-2).join('/'))

  try {
    const pdfBytes = await readPdfBytes(request.body)
    await env.PDF_BUCKET.put(objectKey, pdfBytes, {
      httpMetadata: {
        contentType: 'application/pdf',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: { driveFileId },
    })
  } catch (error) {
    console.error(JSON.stringify({
      message: 'R2 bulk PDF upload failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    await env.PDF_BUCKET.delete(objectKey).catch((cleanupError) => {
      console.error(JSON.stringify({
        message: 'R2 cleanup failed after rejected PDF stream.',
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }))
    })
    return jsonResponse({
      error: error instanceof RangeError
        ? error.message
        : error instanceof TypeError
          ? error.message
          : 'Could not store the PDF in R2.',
    }, error instanceof RangeError ? 413 : error instanceof TypeError ? 400 : 502, origin)
  }

  let insertResponse
  try {
    insertResponse = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify({
          drive_file_id: driveFileId,
          title: title.trim(),
          composer: composer.trim(),
          category: category.trim(),
          file_url: fileUrl,
          r2_key: objectKey,
        }),
      },
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet music insert failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    insertResponse = null
  }

  if (!insertResponse?.ok) {
    if (insertResponse) {
      console.error(JSON.stringify({
        message: 'Supabase rejected the sheet music upload.',
        status: insertResponse.status,
      }))
    }
    await env.PDF_BUCKET.delete(objectKey).catch((error) => {
      console.error(JSON.stringify({
        message: 'R2 cleanup failed after Supabase insert failure.',
        error: error instanceof Error ? error.message : String(error),
      }))
    })
    return jsonResponse({ error: 'Could not save this PDF in the catalogue.' }, 502, origin)
  }

  return jsonResponse({
    ok: true,
    title: title.trim(),
    composer: composer.trim(),
    category: category.trim(),
    fileUrl,
  }, 201, origin)
}
