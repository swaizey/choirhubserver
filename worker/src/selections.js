import {
  getSupabaseTableUrl,
  jsonResponse,
  parsePagination,
  readJsonBody,
  supabaseRequest,
} from './http.js'

const SELECTION_PARTS = [
  'Entrance',
  'Kyrie',
  'Gloria',
  'Psalm',
  'Creed',
  'Prayer of the Faithful',
  'Offertory',
  'Sanctus',
  'Agnus',
  'Communion',
  'Recessional',
]
const MAX_SONGS_PER_PART = 20

function withUnavailableViewCounts(selections) {
  return selections.map((selection) => ({ ...selection, view_count: null }))
}

async function hashViewerAddress(address, secret) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(address)),
  )
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function handleSelectionList(request, env, origin) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Selection storage is not configured.' }, 503, origin)
  }

  const pagination = parsePagination(new URL(request.url))
  if (!pagination) {
    return jsonResponse({ error: 'Page must be positive and pageSize must be between 1 and 50.' }, 400, origin)
  }

  let supabaseResponse
  try {
    supabaseResponse = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'mass_selections', {
        select: 'id,title,service_date,parts,created_at',
        order: 'created_at.desc,id.desc',
        limit: String(pagination.limit),
        offset: String(pagination.offset),
      }),
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase selection-list request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load selections. Please try again.' }, 502, origin)
  }

  if (!supabaseResponse.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the selection-list request.',
      status: supabaseResponse.status,
    }))
    return jsonResponse({ error: 'Could not load selections. Please try again.' }, 502, origin)
  }

  try {
    const rows = await supabaseResponse.json()
    if (!Array.isArray(rows)) {
      throw new Error('Supabase returned an invalid selection list.')
    }
    const hasMore = rows.length > pagination.pageSize
    const selections = rows.slice(0, pagination.pageSize)
    if (selections.length === 0) {
      return jsonResponse({
        selections,
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasMore,
      }, 200, origin)
    }

    const viewerAddress = request.headers.get('CF-Connecting-IP')
    if (!viewerAddress) {
      console.error(JSON.stringify({ message: 'Cloudflare client IP header is missing.' }))
      return jsonResponse({
        selections: withUnavailableViewCounts(selections),
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasMore,
      }, 200, origin)
    }

    try {
      const viewerHash = await hashViewerAddress(viewerAddress, env.SUPABASE_SERVICE_ROLE_KEY)
      const viewResponse = await supabaseRequest(
        env,
        getSupabaseTableUrl(env, 'rpc/record_selection_views'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            p_selection_ids: selections.map((selection) => selection.id),
            p_viewer_hash: viewerHash,
          }),
        },
      )
      if (!viewResponse.ok) {
        console.error(JSON.stringify({
          message: 'Supabase rejected the selection-view request.',
          status: viewResponse.status,
        }))
        return jsonResponse({
          selections: withUnavailableViewCounts(selections),
          page: pagination.page,
          pageSize: pagination.pageSize,
          hasMore,
        }, 200, origin)
      }

      const viewCounts = await viewResponse.json()
      if (!Array.isArray(viewCounts)) {
        throw new Error('Supabase returned invalid selection view counts.')
      }
      const countsBySelectionId = new Map(
        viewCounts.map(({ selection_id, view_count }) => [selection_id, Number(view_count)]),
      )
      const selectionsWithCounts = selections.map((selection) => {
        const viewCount = countsBySelectionId.get(selection.id)
        if (!Number.isSafeInteger(viewCount) || viewCount < 0) {
          throw new Error(`Supabase returned an invalid view count for selection ${selection.id}.`)
        }
        return { ...selection, view_count: viewCount }
      })
      return jsonResponse({
        selections: selectionsWithCounts,
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasMore,
      }, 200, origin)
    } catch (error) {
      console.error(JSON.stringify({
        message: 'Could not load selection view counts.',
        error: error instanceof Error ? error.message : String(error),
      }))
      return jsonResponse({
        selections: withUnavailableViewCounts(selections),
        page: pagination.page,
        pageSize: pagination.pageSize,
        hasMore,
      }, 200, origin)
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Could not parse the Supabase selection list.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not load selections. Please try again.' }, 502, origin)
  }
}

function validateSelection(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: 'A selection object is required.' }
  }

  if (typeof data.title !== 'string' || !data.title.trim() || data.title.trim().length > 160) {
    return { error: 'Selection name is required and must be 160 characters or fewer.' }
  }

  if (
    typeof data.serviceDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(data.serviceDate)
    || !Number.isFinite(Date.parse(`${data.serviceDate}T00:00:00Z`))
    || new Date(`${data.serviceDate}T00:00:00Z`).toISOString().slice(0, 10) !== data.serviceDate
  ) {
    return { error: 'A valid liturgy date is required.' }
  }

  if (!Array.isArray(data.parts) || data.parts.length !== SELECTION_PARTS.length) {
    return { error: 'All liturgy parts must be included.' }
  }

  let songCount = 0
  const parts = []
  for (let index = 0; index < SELECTION_PARTS.length; index += 1) {
    const part = data.parts[index]
    if (!part || part.name !== SELECTION_PARTS[index] || !Array.isArray(part.songs)) {
      return { error: `The ${SELECTION_PARTS[index]} part is invalid.` }
    }
    if (part.songs.length > MAX_SONGS_PER_PART) {
      return { error: `Each part can contain at most ${MAX_SONGS_PER_PART} songs.` }
    }

    const songs = []
    for (const song of part.songs) {
      if (
        !song
        || typeof song.title !== 'string'
        || !song.title.trim()
        || song.title.trim().length > 200
        || (song.author !== undefined && typeof song.author !== 'string')
        || (typeof song.author === 'string' && song.author.trim().length > 160)
      ) {
        return { error: `A song in ${SELECTION_PARTS[index]} has invalid details.` }
      }

      songs.push({
        title: song.title.trim(),
        author: typeof song.author === 'string' ? song.author.trim() : '',
      })
      songCount += 1
    }

    parts.push({ name: SELECTION_PARTS[index], songs })
  }

  if (songCount === 0) {
    return { error: 'Add at least one song to the selection.' }
  }

  return {
    selection: {
      title: data.title.trim(),
      service_date: data.serviceDate,
      parts,
    },
  }
}

export async function handleSelectionSubmission(request, env, origin) {
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') {
    return jsonResponse({ error: 'Content-Type must be application/json.' }, 415, origin)
  }

  const body = await readJsonBody(request)
  if (body.error) {
    return jsonResponse({ error: body.error }, body.status, origin)
  }

  const validated = validateSelection(body.data)
  if (validated.error) {
    return jsonResponse({ error: validated.error }, 400, origin)
  }

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(JSON.stringify({ message: 'Supabase Worker configuration is missing.' }))
    return jsonResponse({ error: 'Selection storage is not configured.' }, 503, origin)
  }

  let supabaseResponse
  try {
    supabaseResponse = await supabaseRequest(
      env,
      getSupabaseTableUrl(env, 'mass_selections'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(validated.selection),
      },
    )
  } catch (error) {
    console.error(JSON.stringify({
      message: 'Supabase request failed.',
      error: error instanceof Error ? error.message : String(error),
    }))
    return jsonResponse({ error: 'Could not save the selection. Please try again.' }, 502, origin)
  }

  if (!supabaseResponse.ok) {
    console.error(JSON.stringify({
      message: 'Supabase rejected the selection.',
      status: supabaseResponse.status,
    }))
    return jsonResponse({ error: 'Could not save the selection. Please try again.' }, 502, origin)
  }

  return jsonResponse({ ok: true }, 201, origin)
}
