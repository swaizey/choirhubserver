export const MAX_REQUEST_BYTES = 64 * 1024

export function jsonResponse(body, status, origin) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })

  if (origin) {
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Drive-File-Id, X-Metadata-Title, X-Metadata-Composer, X-Metadata-Category',
    )
    headers.set('Vary', 'Origin')
  }

  return new Response(body === null ? null : JSON.stringify(body), { status, headers })
}

export async function readJsonBody(request) {
  const contentLength = Number(request.headers.get('Content-Length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return { error: 'Request body is too large.', status: 413 }
  }

  if (!request.body) {
    return { error: 'A JSON request body is required.', status: 400 }
  }

  const reader = request.body.getReader()
  const chunks = []
  let totalBytes = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_REQUEST_BYTES) {
      await reader.cancel()
      return { error: 'Request body is too large.', status: 413 }
    }
    chunks.push(value)
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return { data: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { error: 'Request body must contain valid JSON.', status: 400 }
    }
    throw error
  }
}

export function getSupabaseTableUrl(env, table, query = {}) {
  const url = new URL(env.SUPABASE_URL)
  if (url.protocol !== 'https:') {
    throw new Error('Supabase URL must use HTTPS.')
  }
  url.pathname = `/rest/v1/${table}`
  url.search = ''
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value)
  }
  return url
}

export async function supabaseRequest(env, url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...options.headers,
    },
  })
}

export async function isBulkUploadAuthorized(request, env) {
  const authorization = request.headers.get('Authorization') || ''
  const candidateToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  if (!env.BULK_UPLOAD_TOKEN || !candidateToken) return false

  const encoder = new TextEncoder()
  const [candidateHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidateToken)),
    crypto.subtle.digest('SHA-256', encoder.encode(env.BULK_UPLOAD_TOKEN)),
  ])
  const candidateBytes = new Uint8Array(candidateHash)
  const expectedBytes = new Uint8Array(expectedHash)
  let difference = 0
  for (let index = 0; index < candidateBytes.length; index += 1) {
    difference |= candidateBytes[index] ^ expectedBytes[index]
  }
  return difference === 0
}
