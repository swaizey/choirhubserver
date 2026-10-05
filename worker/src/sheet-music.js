import {
  getSupabaseTableUrl,
  jsonResponse,
  parsePagination,
  supabaseRequest,
} from './http.js'
import { makePublicObjectUrl } from './bulk-import.js'

export async function handleSheetMusicList(request, env, origin) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.R2_PUBLIC_BASE_URL) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Sheet music storage is not configured.' }, 503, origin)
  }

  const url = new URL(request.url)
  const pagination = parsePagination(url)
  if (!pagination) {
    return jsonResponse({ error: 'Page must be positive and pageSize must be between 1 and 50.' }, 400, origin)
  }
  const search = (url.searchParams.get('q') || '')
    .trim()
    .slice(0, 100)
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const query = {
    select: 'id,title,composer,category,r2_key,created_at',
    order: 'created_at.desc,id.desc',
    limit: String(pagination.limit),
    offset: String(pagination.offset),
  }
  if (search) {
    const pattern = `*${search}*`
    query.or = `(title.ilike.${pattern},composer.ilike.${pattern},category.ilike.${pattern})`
  }

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', query),
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet-music list request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load sheet music. Please try again.' }, 502, origin)
  }

  if (!response.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the sheet-music list request.',
      status: response.status,
    }))
    return jsonResponse({ error: 'Could not load sheet music. Please try again.' }, 502, origin)
  }

  let records
  let hasMore
  try {
    const rows = await response.json()
    if (!Array.isArray(rows)) throw new TypeError('Supabase returned an invalid sheet-music list.')
    hasMore = rows.length > pagination.pageSize
    records = rows.slice(0, pagination.pageSize).map((record) => {
      if (
        typeof record.id !== 'string'
        || typeof record.title !== 'string'
        || typeof record.composer !== 'string'
        || typeof record.category !== 'string'
        || typeof record.r2_key !== 'string'
        || !record.r2_key.includes('/')
      ) {
        throw new TypeError('Supabase returned an invalid sheet-music record.')
      }
      return {
        id: record.id,
        title: record.title,
        composer: record.composer,
        category: record.category,
        file_url: makePublicObjectUrl(env.R2_PUBLIC_BASE_URL, record.r2_key),
        created_at: record.created_at,
      }
    })
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase returned invalid sheet-music data.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load sheet music. Please try again.' }, 502, origin)
  }

  return jsonResponse({
    sheetMusic: records,
    page: pagination.page,
    pageSize: pagination.pageSize,
    hasMore,
  }, 200, origin)
}

function makeDownloadFilename(title) {
  const safeTitle = title
    .trim()
    .replace(/\.pdf$/i, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'sheet-music'
  return `${safeTitle}-ChoirHub.pdf`
}

function encodeFileName(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

export async function handleSheetMusicDownload(request, env, origin, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PDF_BUCKET) {
    console.error(JSON.stringify({ message: 'Sheet music download configuration is incomplete.' }))
    return jsonResponse({ error: 'Sheet music downloads are not configured.' }, 503, origin)
  }

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        select: 'title,r2_key',
        id: `eq.${id}`,
        limit: '1',
      }),
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet-music download lookup failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not prepare the PDF download.' }, 502, origin)
  }

  if (!response.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the sheet-music download lookup.',
      status: response.status,
    }))
    return jsonResponse({ error: 'Could not prepare the PDF download.' }, 502, origin)
  }

  let record
  try {
    const rows = await response.json()
    if (!Array.isArray(rows)) throw new TypeError('Supabase returned invalid download metadata.')
    record = rows[0]
    if (
      !record
      || typeof record.title !== 'string'
      || typeof record.r2_key !== 'string'
      || !record.r2_key.includes('/')
    ) {
      return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase returned invalid sheet-music download metadata.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not prepare the PDF download.' }, 502, origin)
  }

  let object
  try {
    object = await env.PDF_BUCKET.get(record.r2_key)
  } catch (error) {
    console.error(JSON.stringify({
      message: 'R2 sheet-music download failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not retrieve the PDF.' }, 502, origin)
  }
  if (!object?.body) {
    return jsonResponse({ error: 'The PDF file could not be found.' }, 404, origin)
  }

  const filename = makeDownloadFilename(record.title)
  const fallbackFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const headers = new Headers({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodeFileName(filename)}`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  if (Number.isSafeInteger(object.size)) headers.set('Content-Length', String(object.size))
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Vary', 'Origin')
  }

  return new Response(object.body, { status: 200, headers })
}
