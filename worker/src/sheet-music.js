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
