import { getSupabaseTableUrl, jsonResponse, supabaseRequest } from './http.js'
import {
  makePublicObjectUrl,
  MAX_PUBLIC_PDF_BYTES,
  readPdfBytes,
  validateCategory,
} from './bulk-import.js'

function decodeMetadataHeader(value) {
  if (typeof value !== 'string') return ''
  try {
    return decodeURIComponent(value)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
}

export async function handlePublicPdfUpload(request, env, origin) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/pdf') {
    return jsonResponse({ error: 'Choose a PDF file to upload.' }, 415, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PDF_BUCKET || !env.R2_PUBLIC_BASE_URL) {
    console.error(JSON.stringify({ message: 'Public PDF upload storage configuration is incomplete.' }))
    return jsonResponse({ error: 'PDF uploads are not configured.' }, 503, origin)
  }

  const titleValue = decodeMetadataHeader(request.headers.get('X-Metadata-Title'))
  const composerValue = decodeMetadataHeader(request.headers.get('X-Metadata-Composer'))
  const categoryValue = decodeMetadataHeader(request.headers.get('X-Metadata-Category'))
  if (titleValue === null || composerValue === null || categoryValue === null) {
    return jsonResponse({ error: 'PDF metadata must be URL-encoded.' }, 400, origin)
  }
  const title = titleValue.trim()
  const composer = composerValue.trim()
  const category = categoryValue.trim()

  if (!title || title.length > 200) {
    return jsonResponse({ error: 'A title of 1–200 characters is required.' }, 400, origin)
  }
  if (composer.length > 160) {
    return jsonResponse({ error: 'Composer must be 160 characters or fewer.' }, 400, origin)
  }
  if (!validateCategory(category)) {
    return jsonResponse({ error: 'A category of 1–120 characters is required; slashes are not allowed.' }, 400, origin)
  }
  if (!request.body) {
    return jsonResponse({ error: 'Choose a PDF file to upload.' }, 400, origin)
  }

  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_PUBLIC_PDF_BYTES) {
    return jsonResponse({ error: 'PDF exceeds the 15 MB per-file limit.' }, 413, origin)
  }

  let objectKey
  let fileUrl
  try {
    objectKey = `${category}/${crypto.randomUUID()}.pdf`
    fileUrl = makePublicObjectUrl(env.R2_PUBLIC_BASE_URL, objectKey)
  } catch (error) {
    if (error instanceof TypeError) {
      console.error(JSON.stringify({ message: 'R2 public URL is invalid.' }))
      return jsonResponse({ error: 'PDF uploads are not configured.' }, 503, origin)
    }
    throw error
  }

  try {
    const pdfBytes = await readPdfBytes(request.body, MAX_PUBLIC_PDF_BYTES)
    await env.PDF_BUCKET.put(objectKey, pdfBytes, {
      httpMetadata: {
        contentType: 'application/pdf',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    })
  } catch (error) {
    console.error(JSON.stringify({
      message: 'R2 public PDF upload failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    await env.PDF_BUCKET.delete(objectKey).catch((cleanupError) => {
      console.error(JSON.stringify({
        message: 'R2 cleanup failed after rejected public PDF upload.',
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }))
    })
    return jsonResponse({
      error: error instanceof RangeError
        ? error.message
        : error instanceof TypeError
          ? error.message
          : 'Could not store the PDF. Please try again.',
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
          drive_file_id: null,
          title,
          composer,
          category,
          file_url: fileUrl,
          r2_key: objectKey,
        }),
      },
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase public PDF metadata insert failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    insertResponse = null
  }

  if (!insertResponse?.ok) {
    if (insertResponse) {
      console.error(JSON.stringify({
        message: 'Supabase rejected public PDF metadata.',
        status: insertResponse.status,
      }))
    }
    await env.PDF_BUCKET.delete(objectKey).catch((error) => {
      console.error(JSON.stringify({
        message: 'R2 cleanup failed after Supabase insert failure.',
        error: error instanceof Error ? error.message : String(error),
      }))
    })
    return jsonResponse({ error: 'Could not save PDF metadata. Please try again.' }, 502, origin)
  }

  return jsonResponse({
    ok: true,
    title,
    composer,
    category,
    fileUrl,
  }, 201, origin)
}
