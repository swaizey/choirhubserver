import { getSupabaseTableUrl, jsonResponse, supabaseRequest } from './http.js'
import { makePublicObjectUrl } from './bulk-import.js'

export async function handleSheetMusicList(env, origin) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.R2_PUBLIC_BASE_URL) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Sheet music storage is not configured.' }, 503, origin)
  }

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        select: 'id,title,composer,category,r2_key,created_at',
        order: 'created_at.desc',
        limit: '100',
      }),
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
  try {
    const rows = await response.json()
    if (!Array.isArray(rows)) throw new TypeError('Supabase returned an invalid sheet-music list.')
    records = rows.map((record) => {
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

  return jsonResponse({ sheetMusic: records }, 200, origin)
}
