import {
  getSupabaseTableUrl,
  isBulkUploadAuthorized,
  jsonResponse,
  parsePagination,
  readJsonBody,
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
    .replace(/[^\p{L}\p{N}\s&'’-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const category = (url.searchParams.get('category') || '').trim()
  if (
    category.length > 120
    || (category && !/^[\p{L}\p{N}\s&'’-]+$/u.test(category))
  ) {
    return jsonResponse({ error: 'Category contains invalid characters.' }, 400, origin)
  }

  const query = {
    select: 'id,title,composer,category,r2_key,created_at',
    order: 'created_at.desc,id.desc',
    limit: String(pagination.limit),
    offset: String(pagination.offset),
  }
  if (search) {
    const pattern = `*${search}*`
    const normalizedTitleSearch = search.replace(/[^\p{L}\p{N}]/gu, '').toLocaleLowerCase()
    const titlePattern = `*${Array.from(normalizedTitleSearch).join('*')}*`
    query.or = `(title.ilike.${titlePattern},composer.ilike.${pattern},category.ilike.${pattern})`
  }
  if (category) query.category = `eq.${category}`

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

export async function handleSheetMusicCategories(env, origin) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Sheet music categories are not configured.' }, 503, origin)
  }

  const categories = new Set()
  const pageSize = 1000
  let offset = 0

  try {
    while (true) {
      const response = await supabaseRequest(
        env,
        getSupabaseTableUrl(env, 'sheet_music', {
          select: 'category',
          category: 'not.is.null',
          order: 'category.asc',
          limit: String(pageSize),
          offset: String(offset),
        }),
      )
      if (!response.ok) {
        console.error(JSON.stringify({
          message: 'Supabase rejected the sheet-music category request.',
          status: response.status,
        }))
        return jsonResponse({ error: 'Could not load categories. Please try again.' }, 502, origin)
      }

      const rows = await response.json()
      if (!Array.isArray(rows)) throw new TypeError('Supabase returned an invalid category list.')
      for (const row of rows) {
        if (typeof row.category !== 'string') {
          throw new TypeError('Supabase returned an invalid sheet-music category.')
        }
        const category = row.category.trim()
        if (category) categories.add(category)
      }

      if (rows.length < pageSize) break
      offset += pageSize
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet-music category request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load categories. Please try again.' }, 502, origin)
  }

  return jsonResponse({ categories: [...categories].sort((left, right) => left.localeCompare(right)) }, 200, origin)
}

export async function handleSheetMusicDetails(env, origin, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.R2_PUBLIC_BASE_URL) {
    console.error(JSON.stringify({ message: 'Sheet music storage configuration is incomplete.' }))
    return jsonResponse({ error: 'Sheet music storage is not configured.' }, 503, origin)
  }

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        select: 'id,title,composer,category,r2_key,created_at',
        id: `eq.${id}`,
        limit: '1',
      }),
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet-music detail request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load this sheet music.' }, 502, origin)
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the sheet-music detail request.',
      status: response.status,
    }))
    return jsonResponse({ error: 'Could not load this sheet music.' }, 502, origin)
  }

  try {
    const rows = await response.json()
    const record = Array.isArray(rows) ? rows[0] : null
    if (
      !record
      || typeof record.id !== 'string'
      || typeof record.title !== 'string'
      || typeof record.composer !== 'string'
      || typeof record.category !== 'string'
      || typeof record.r2_key !== 'string'
      || !record.r2_key.includes('/')
    ) {
      return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
    }
    return jsonResponse({
      sheetMusic: {
        id: record.id,
        title: record.title,
        composer: record.composer,
        category: record.category,
        file_url: makePublicObjectUrl(env.R2_PUBLIC_BASE_URL, record.r2_key),
        download_url: `/api/sheet-music/${encodeURIComponent(record.id)}/download`,
        created_at: record.created_at,
      },
    }, 200, origin)
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase returned invalid sheet-music details.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load this sheet music.' }, 502, origin)
  }
}

export async function handleSheetMusicComposerUpdate(request, env, origin, id) {
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'A valid administrator token is required.' }, 401, origin)
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Sheet music updates are not configured.' }, 503, origin)
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415, origin)
  }

  const body = await readJsonBody(request)
  if (body.error) return jsonResponse({ error: body.error }, body.status, origin)
  if (
    !body.data
    || typeof body.data.composer !== 'string'
    || body.data.composer.trim().length > 160
  ) {
    return jsonResponse({ error: 'Composer must be a string of 160 characters or fewer.' }, 400, origin)
  }
  const composer = body.data.composer.trim()

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        id: `eq.${id}`,
        select: 'id,title,composer,category',
      }),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ composer }),
      },
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase sheet-music composer update failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not update the composer. Please try again.' }, 502, origin)
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the sheet-music composer update.',
      status: response.status,
    }))
    return jsonResponse({ error: 'Could not update the composer. Please try again.' }, 502, origin)
  }

  try {
    const rows = await response.json()
    const record = Array.isArray(rows) ? rows[0] : null
    if (!record) return jsonResponse({ error: 'Sheet music was not found.' }, 404, origin)
    return jsonResponse({
      sheetMusic: {
        id: record.id,
        title: record.title,
        composer: record.composer,
        category: record.category,
      },
    }, 200, origin)
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase returned invalid composer update data.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not confirm the composer update.' }, 502, origin)
  }
}

export async function handleChristmasCategoryNormalization(request, env, origin) {
  if (!await isBulkUploadAuthorized(request, env)) {
    return jsonResponse({ error: 'A valid administrator token is required.' }, 401, origin)
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Category updates are not configured.' }, 503, origin)
  }

  let response
  try {
    response = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'sheet_music', {
        category: 'eq.Advent & Christmass',
      }),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ category: 'Advent & Christmas' }),
      },
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase Christmas-category normalization failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not update the category. Please try again.' }, 502, origin)
  }
  if (!response.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the Christmas-category normalization.',
      status: response.status,
    }))
    return jsonResponse({ error: 'Could not update the category. Please try again.' }, 502, origin)
  }

  try {
    const rows = await response.json()
    if (!Array.isArray(rows)) throw new TypeError('Supabase returned an invalid category update.')
    return jsonResponse({
      updatedCount: rows.length,
      category: 'Advent & Christmas',
    }, 200, origin)
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase returned invalid category update data.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not confirm the category update.' }, 502, origin)
  }
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
  const rangeHeader = request.headers.get('Range')
  let requestedRange
  if (rangeHeader) {
    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/)
    if (!match || (!match[1] && !match[2])) {
      return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes' } })
    }
    requestedRange = match[1]
      ? {
        offset: Number(match[1]),
        ...(match[2] ? { length: Number(match[2]) - Number(match[1]) + 1 } : {}),
      }
      : { suffix: Number(match[2]) }
    if (
      Object.values(requestedRange).some((value) => !Number.isSafeInteger(value) || value < 0)
      || ('length' in requestedRange && requestedRange.length < 1)
      || ('suffix' in requestedRange && requestedRange.suffix < 1)
    ) {
      return new Response(null, { status: 416, headers: { 'Accept-Ranges': 'bytes' } })
    }
  }
  try {
    object = await env.PDF_BUCKET.get(record.r2_key, requestedRange ? { range: requestedRange } : undefined)
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
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
  })
  let status = 200
  if (requestedRange) {
    const offset = object.range?.offset ?? requestedRange.offset ?? 0
    const length = object.range?.length ?? object.size
    const totalSize = object.size
    if (Number.isSafeInteger(totalSize) && Number.isSafeInteger(offset) && Number.isSafeInteger(length)) {
      headers.set('Content-Range', `bytes ${offset}-${offset + length - 1}/${totalSize}`)
      headers.set('Content-Length', String(length))
      status = 206
    }
  } else if (Number.isSafeInteger(object.size)) {
    headers.set('Content-Length', String(object.size))
  }
  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Disposition')
    headers.set('Vary', 'Origin')
  }

  return new Response(object.body, { status, headers })
}
