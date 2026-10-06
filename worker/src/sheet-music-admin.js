import {
  getSupabaseTableUrl,
  isBulkUploadAuthorized,
  jsonResponse,
  readJsonBody,
  supabaseRequest,
} from './http.js'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_DELETE_COUNT = 50

export async function handleSheetMusicDelete(request, env, origin) {
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'A valid administrator token is required.' }, 401, origin)
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.PDF_BUCKET) {
    console.error(JSON.stringify({ message: 'Sheet-music deletion configuration is incomplete.' }))
    return jsonResponse({ error: 'Sheet-music deletion is not configured.' }, 503, origin)
  }

  const body = await readJsonBody(request)
  if (body.error) return jsonResponse({ error: body.error }, body.status, origin)
  const { ids } = body.data || {}
  if (
    !Array.isArray(ids)
    || ids.length < 1
    || ids.length > MAX_DELETE_COUNT
    || ids.some((id) => typeof id !== 'string' || !UUID_PATTERN.test(id))
    || new Set(ids).size !== ids.length
  ) {
    return jsonResponse({
      error: `Provide 1–${MAX_DELETE_COUNT} unique sheet-music IDs.`,
    }, 400, origin)
  }

  let deletedRows
  try {
    const response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        id: `in.(${ids.join(',')})`,
        select: 'id,r2_key',
      }),
      {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
      },
    )
    if (!response.ok) {
      console.error(JSON.stringify({
        message: 'Supabase rejected the sheet-music delete request.',
        status: response.status,
      }))
      return jsonResponse({ error: 'Could not delete the selected catalogue entries.' }, 502, origin)
    }
    deletedRows = await response.json()
    if (!Array.isArray(deletedRows)) throw new TypeError('Supabase returned invalid deleted rows.')
    for (const row of deletedRows) {
      if (
        typeof row.id !== 'string'
        || !ids.includes(row.id)
        || typeof row.r2_key !== 'string'
        || !row.r2_key
      ) {
        throw new TypeError('Supabase returned invalid deleted sheet-music data.')
      }
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Sheet-music catalogue deletion failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not confirm catalogue deletion. Check the catalogue before retrying.' }, 502, origin)
  }

  if (deletedRows.length === 0) {
    return jsonResponse({ error: 'None of the selected catalogue entries exist.' }, 404, origin)
  }

  const keys = new Set(deletedRows.map((row) => row.r2_key))
  let deletedObjectCount = 0
  let retainedObjectCount = 0
  let cleanupFailureCount = 0

  for (const key of keys) {
    try {
      const referencesResponse = await supabaseRequest(
        env,
        getSupabaseTableUrl(env, 'sheet_music', {
          select: 'id',
          r2_key: `eq.${key}`,
          limit: '1',
        }),
      )
      if (!referencesResponse.ok) {
        throw new Error(`Supabase rejected the remaining-reference check (${referencesResponse.status}).`)
      }
      const references = await referencesResponse.json()
      if (!Array.isArray(references)) {
        throw new TypeError('Supabase returned invalid remaining references.')
      }
      if (references.length > 0) {
        retainedObjectCount += 1
        continue
      }

      await env.PDF_BUCKET.delete(key)
      deletedObjectCount += 1
    } catch (error) {
      cleanupFailureCount += 1
      console.error(JSON.stringify({
        message: 'R2 cleanup failed after sheet-music catalogue deletion.',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  if (cleanupFailureCount > 0) {
    return jsonResponse({
      error: 'Catalogue entries were deleted, but some unreferenced R2 files could not be removed.',
      deletedCount: deletedRows.length,
      deletedObjectCount,
      retainedObjectCount,
      cleanupFailureCount,
    }, 502, origin)
  }

  return jsonResponse({
    deletedCount: deletedRows.length,
    deletedObjectCount,
    retainedObjectCount,
  }, 200, origin)
}
