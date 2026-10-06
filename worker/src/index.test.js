import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { addLogoWatermark } from '../../../client/src/Songs/pdfWatermark.js'
import { readPdfBytes } from './bulk-import.js'
import worker from './index.js'
import { storePdfIfAbsent } from './pdf-storage.js'

const requireFromClient = createRequire(new URL('../../../client/package.json', import.meta.url))
const { PDFDocument } = requireFromClient('pdf-lib')
const allowedOrigin = 'http://localhost:5173'
const testBulkToken = 'admin-token'
const env = {
  SUPABASE_URL: 'https://project.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  R2_PUBLIC_BASE_URL: 'https://pdfs.example.com',
  ALLOWED_ORIGINS: `${allowedOrigin},https://choirhub.netlify.app`,
}

function makeSelection() {
  const partNames = [
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

  return {
    title: 'Sunday Mass',
    serviceDate: '2026-10-04',
    parts: partNames.map((name, index) => ({
      name,
      songs: index === 0 ? [{ title: 'Gather Us In', author: '' }] : [],
    })),
  }
}

test('bulk PDF reader accepts its configured size limit and rejects larger streams', async () => {
  const withinLimit = new Blob([new Uint8Array([37, 80, 68, 70, 45])]).stream()
  const overLimit = new Blob([new Uint8Array([37, 80, 68, 70, 45, 1])]).stream()

  assert.equal((await readPdfBytes(withinLimit, 5)).byteLength, 5)
  await assert.rejects(readPdfBytes(overLimit, 5), { name: 'RangeError' })
})

test('conditional R2 write reuses an object created after the existence check', async () => {
  let putOptions
  const bucket = {
    async head() {
      return null
    },
    async put(key, bytes, options) {
      putOptions = options
      return null
    },
  }

  assert.equal(await storePdfIfAbsent(bucket, 'pdfs/content.pdf', new Uint8Array([37, 80, 68, 70, 45])), true)
  assert.deepEqual(putOptions.onlyIf, { etagDoesNotMatch: '*' })
})

test('adds the ChoirHub watermark to every page and preserves the PDF page count', async () => {
  const source = await PDFDocument.create()
  source.addPage([612, 792])
  source.addPage([420, 595])
  const sourceBytes = await source.save()
  const logoBytes = await readFile(new URL('../../../client/src/assets/logo-dark.png', import.meta.url))

  const watermarkedBytes = await addLogoWatermark(sourceBytes, logoBytes)
  const result = await PDFDocument.load(watermarkedBytes)

  assert.equal(result.getPageCount(), 2)
  assert.ok(result.getPages().every((page) => page.node.Contents()))
})

test('preflight returns CORS headers for an allowed origin', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/api/selections', {
      method: 'OPTIONS',
      headers: { Origin: allowedOrigin },
    }),
    env,
  )

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, PATCH, OPTIONS')
})

test('lists saved selections from Supabase', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let supabaseHeaders
  let viewRpcPayload
  const selections = [{
    id: 'selection-1',
    title: 'Sunday Mass',
    service_date: '2026-10-04',
    parts: [{ name: 'Entrance', songs: [{ title: 'Gather Us In', author: '' }] }],
    created_at: '2026-10-04T12:00:00Z',
  }]

  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url))
    supabaseHeaders = options.headers
    if (requestUrl.pathname === '/rest/v1/mass_selections') {
      supabaseUrl = requestUrl
      return Response.json(selections)
    }
    assert.equal(requestUrl.pathname, '/rest/v1/rpc/record_selection_views')
    viewRpcPayload = JSON.parse(options.body)
    return Response.json([{ selection_id: 'selection-1', view_count: 4 }])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/selections', {
        method: 'GET',
        headers: {
          Origin: allowedOrigin,
          'CF-Connecting-IP': '203.0.113.42',
        },
      }),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
    assert.equal(supabaseUrl.pathname, '/rest/v1/mass_selections')
    assert.equal(supabaseUrl.searchParams.get('select'), 'id,title,service_date,parts,created_at')
    assert.equal(supabaseUrl.searchParams.get('order'), 'created_at.desc,id.desc')
    assert.equal(supabaseUrl.searchParams.get('limit'), '13')
    assert.equal(supabaseUrl.searchParams.get('offset'), '0')
    assert.equal(supabaseHeaders.apikey, env.SUPABASE_SERVICE_ROLE_KEY)
    assert.deepEqual(viewRpcPayload.p_selection_ids, ['selection-1'])
    assert.equal(
      viewRpcPayload.p_viewer_hash,
      createHmac('sha256', env.SUPABASE_SERVICE_ROLE_KEY).update('203.0.113.42').digest('hex'),
    )
    assert.deepEqual(data.selections, [{ ...selections[0], view_count: 4 }])
    assert.equal(data.page, 1)
    assert.equal(data.pageSize, 12)
    assert.equal(data.hasMore, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paginates selection results and requests view counts only for the current page', async () => {
  const originalFetch = globalThis.fetch
  let selectionUrl
  let viewPayload
  globalThis.fetch = async (url, options = {}) => {
    const requestUrl = new URL(String(url))
    if (requestUrl.pathname === '/rest/v1/mass_selections') {
      selectionUrl = requestUrl
      return Response.json([{ id: 'selection-page-2' }, { id: 'selection-page-3' }])
    }
    viewPayload = JSON.parse(options.body)
    return Response.json([{ selection_id: 'selection-page-2', view_count: 1 }])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/selections?page=2&pageSize=1', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': '203.0.113.42' },
      }),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(selectionUrl.searchParams.get('limit'), '2')
    assert.equal(selectionUrl.searchParams.get('offset'), '1')
    assert.deepEqual(viewPayload.p_selection_ids, ['selection-page-2'])
    assert.equal(data.page, 2)
    assert.equal(data.pageSize, 1)
    assert.equal(data.hasMore, true)
    assert.deepEqual(data.selections.map(({ id }) => id), ['selection-page-2'])
    assert.equal(data.selections[0].view_count, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('lists saved sheet music and its actual R2 PDF URL from Supabase', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  const sheetMusic = [{
    id: 'pdf-1',
    title: 'Advent Song',
    composer: 'ChoirHub',
    category: 'Advent & Christmas',
    r2_key: 'Advent & Christmas/song.pdf',
    created_at: '2026-10-05T08:00:00Z',
  }]

  globalThis.fetch = async (url, options = {}) => {
    supabaseUrl = new URL(String(url))
    assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY)
    return Response.json(sheetMusic)
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music', {
        method: 'GET',
        headers: { Origin: allowedOrigin },
      }),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
    assert.equal(supabaseUrl.pathname, '/rest/v1/sheet_music')
    assert.equal(supabaseUrl.searchParams.get('select'), 'id,title,composer,category,r2_key,created_at')
    assert.equal(supabaseUrl.searchParams.get('order'), 'id.asc')
    assert.equal(supabaseUrl.searchParams.get('limit'), '1000')
    assert.equal(supabaseUrl.searchParams.get('offset'), '0')
    assert.deepEqual(data.sheetMusic, [{
      id: 'pdf-1',
      title: 'Advent Song',
      composer: 'ChoirHub',
      category: 'Advent & Christmas',
      file_url: 'https://pdfs.example.com/Advent%20%26%20Christmas/song.pdf',
      created_at: '2026-10-05T08:00:00Z',
    }])
    assert.equal(data.page, 1)
    assert.equal(data.pageSize, 12)
    assert.equal(data.hasMore, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('keeps recent ordering available for the composer editor', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json([])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music?page=1&pageSize=12&order=recent'),
      env,
    )

    assert.equal(response.status, 200)
    assert.equal(supabaseUrl.searchParams.get('order'), 'created_at.desc,id.desc')
    assert.equal(supabaseUrl.searchParams.get('limit'), '13')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('paginates sheet music and applies catalogue search before selecting a page', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json([
      {
        id: 'pdf-page-2',
        title: 'Song in Advent',
        composer: 'Composer',
        category: 'Advent & Christmas',
        r2_key: 'Advent/song.pdf',
        created_at: '2026-10-05T08:00:00Z',
      },
      {
        id: 'pdf-page-3',
        title: 'Another Advent Song',
        composer: 'Composer',
        category: 'Advent & Christmas',
        r2_key: 'Advent/song-2.pdf',
        created_at: '2026-10-04T08:00:00Z',
      },
    ])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music?page=2&pageSize=1&q=Advent%20%26%20Christmas&category=Advent%20%26%20Christmas'),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(supabaseUrl.searchParams.get('limit'), '2')
    assert.equal(supabaseUrl.searchParams.get('offset'), '1')
    assert.equal(
      supabaseUrl.searchParams.get('or'),
      '(title.ilike.*a*d*v*e*n*t*c*h*r*i*s*t*m*a*s*,composer.ilike.*Advent & Christmas*,category.ilike.*Advent & Christmas*)',
    )
    assert.equal(supabaseUrl.searchParams.get('category'), 'eq.Advent & Christmas')
    assert.equal(data.page, 2)
    assert.equal(data.pageSize, 1)
    assert.equal(data.sheetMusic.length, 1)
    assert.equal(data.hasMore, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('randomizes all-song results and keeps the shuffled order stable across pages', async () => {
  const originalFetch = globalThis.fetch
  const supabaseRows = [
    {
      id: 'pdf-random-a',
      title: 'Alpha',
      composer: 'Composer A',
      category: 'Category A',
      r2_key: 'Category A/alpha.pdf',
      created_at: '2026-10-05T08:00:00Z',
    },
    {
      id: 'pdf-random-b',
      title: 'Bravo',
      composer: 'Composer B',
      category: 'Category B',
      r2_key: 'Category B/bravo.pdf',
      created_at: '2026-10-04T08:00:00Z',
    },
    {
      id: 'pdf-random-c',
      title: 'Charlie',
      composer: 'Composer C',
      category: 'Category C',
      r2_key: 'Category C/charlie.pdf',
      created_at: '2026-10-03T08:00:00Z',
    },
  ]
  let supabaseUrl
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json(supabaseRows)
  }

  try {
    const pageOneResponse = await worker.fetch(
      new Request('https://worker.example/api/sheet-music?page=1&pageSize=2&shuffle=test-seed'),
      env,
    )
    const pageOne = await pageOneResponse.json()
    const pageTwoResponse = await worker.fetch(
      new Request('https://worker.example/api/sheet-music?page=2&pageSize=2&shuffle=test-seed'),
      env,
    )
    const pageTwo = await pageTwoResponse.json()
    const resultIds = [...pageOne.sheetMusic, ...pageTwo.sheetMusic].map(({ id }) => id)

    assert.equal(pageOneResponse.status, 200)
    assert.equal(pageTwoResponse.status, 200)
    assert.equal(supabaseUrl.searchParams.get('order'), 'id.asc')
    assert.equal(supabaseUrl.searchParams.get('limit'), '1000')
    assert.equal(pageOne.hasMore, true)
    assert.equal(pageTwo.hasMore, false)
    assert.equal(new Set(resultIds).size, supabaseRows.length)
    assert.deepEqual(new Set(resultIds), new Set(supabaseRows.map(({ id }) => id)))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('matches title searches that omit spaces and punctuation', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    const orFilter = supabaseUrl.searchParams.get('or')
    assert.equal(
      orFilter,
      '(title.ilike.*k*a*n*y*i*j*e*n*a*,composer.ilike.*kanyije na*,category.ilike.*kanyije na*)',
    )
    return Response.json([{
      id: 'pdf-1',
      title: "K' anyi je na Bethlehem",
      composer: 'ChoirHub',
      category: 'Advent & Christmas',
      r2_key: 'Advent/song.pdf',
      created_at: '2026-10-05T08:00:00Z',
    }])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music?q=kanyije%20na'),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(data.sheetMusic.length, 1)
    assert.equal(data.sheetMusic[0].title, "K' anyi je na Bethlehem")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('lists distinct sheet-music categories from Supabase', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json([
      { category: 'Advent & Christmas' },
      { category: 'Mass' },
      { category: 'Advent & Christmas' },
      { category: '  ' },
    ])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/categories'),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(supabaseUrl.pathname, '/rest/v1/sheet_music')
    assert.equal(supabaseUrl.searchParams.get('select'), 'category')
    assert.equal(supabaseUrl.searchParams.get('category'), 'not.is.null')
    assert.deepEqual(data.categories, ['Advent & Christmas', 'Mass'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('requires the administrator token to update a sheet-music composer', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let updateOptions
  globalThis.fetch = async (url, options) => {
    supabaseUrl = new URL(String(url))
    updateOptions = options
    return Response.json([{
      id: '12345678-1234-1234-1234-123456789012',
      title: 'Song title',
      composer: 'Updated composer',
      category: 'Advent & Christmas',
    }])
  }

  try {
    const unauthorizedResponse = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/12345678-1234-1234-1234-123456789012/composer', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ composer: 'Updated composer' }),
      }),
      { ...env, BULK_UPLOAD_TOKEN: testBulkToken },
    )
    assert.equal(unauthorizedResponse.status, 401)

    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/12345678-1234-1234-1234-123456789012/composer', {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${testBulkToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ composer: ' Updated composer ' }),
      }),
      { ...env, BULK_UPLOAD_TOKEN: testBulkToken },
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(supabaseUrl.searchParams.get('id'), 'eq.12345678-1234-1234-1234-123456789012')
    assert.equal(updateOptions.method, 'PATCH')
    assert.equal(updateOptions.headers.Prefer, 'return=representation')
    assert.deepEqual(JSON.parse(updateOptions.body), { composer: 'Updated composer' })
    assert.equal(data.sheetMusic.composer, 'Updated composer')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('normalizes only the legacy Christmas category with the administrator token', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let updateOptions
  globalThis.fetch = async (url, options) => {
    supabaseUrl = new URL(String(url))
    updateOptions = options
    return Response.json([{ id: 'pdf-1' }, { id: 'pdf-2' }])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/admin/normalize-christmas-category', {
        method: 'POST',
        headers: { Authorization: `Bearer ${testBulkToken}` },
      }),
      { ...env, BULK_UPLOAD_TOKEN: testBulkToken },
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(supabaseUrl.searchParams.get('category'), 'eq.Advent & Christmass')
    assert.equal(updateOptions.method, 'PATCH')
    assert.deepEqual(JSON.parse(updateOptions.body), { category: 'Advent & Christmas' })
    assert.equal(data.updatedCount, 2)
    assert.equal(data.category, 'Advent & Christmas')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preflights composer updates with PATCH and Authorization headers', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/api/sheet-music/12345678-1234-1234-1234-123456789012/composer', {
      method: 'OPTIONS',
      headers: {
        Origin: allowedOrigin,
        'Access-Control-Request-Method': 'PATCH',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    }),
    env,
  )

  assert.equal(response.status, 204)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
  assert.match(response.headers.get('Access-Control-Allow-Methods'), /PATCH/)
  assert.match(response.headers.get('Access-Control-Allow-Headers'), /Authorization/)
})

test('downloads a catalogue PDF from R2 with a title-based ChoirHub filename', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let r2Key
  const pdfBucket = {
    async get(key) {
      r2Key = key
      return {
        body: new Blob(['%PDF-1.7']).stream(),
        size: 8,
      }
    },
  }
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json([{ title: 'Merry Christmas.pdf', r2_key: 'Advent & Christmas/merry.pdf' }])
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/123e4567-e89b-12d3-a456-426614174000/download', {
        method: 'GET',
        headers: { Origin: allowedOrigin },
      }),
      { ...env, PDF_BUCKET: pdfBucket },
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Content-Type'), 'application/pdf')
    assert.equal(response.headers.get('Content-Length'), '8')
    assert.equal(
      response.headers.get('Content-Disposition'),
      'attachment; filename="Merry Christmas-ChoirHub.pdf"; filename*=UTF-8\'\'Merry%20Christmas-ChoirHub.pdf',
    )
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
    assert.equal(supabaseUrl.pathname, '/rest/v1/sheet_music')
    assert.equal(supabaseUrl.searchParams.get('id'), 'eq.123e4567-e89b-12d3-a456-426614174000')
    assert.equal(supabaseUrl.searchParams.get('select'), 'title,r2_key')
    assert.equal(r2Key, 'Advent & Christmas/merry.pdf')
    assert.equal(await response.text(), '%PDF-1.7')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('returns sheet-music viewer metadata and streams byte ranges for PDF.js', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let r2Options
  const pdfBucket = {
    async get(key, options) {
      assert.equal(key, 'Advent & Christmas/song.pdf')
      r2Options = options
      return {
        body: new Blob(['PDF range']).stream(),
        size: 100,
        range: { offset: 10, length: 9 },
      }
    },
  }
  globalThis.fetch = async (url) => {
    supabaseUrl = new URL(String(url))
    return Response.json([{
      id: '123e4567-e89b-12d3-a456-426614174000',
      title: 'Advent Song',
      composer: 'ChoirHub',
      category: 'Advent & Christmas',
      r2_key: 'Advent & Christmas/song.pdf',
      created_at: '2026-10-05T08:00:00Z',
    }])
  }

  try {
    const detailsResponse = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/123e4567-e89b-12d3-a456-426614174000'),
      env,
    )
    const details = await detailsResponse.json()
    assert.equal(detailsResponse.status, 200)
    assert.equal(supabaseUrl.searchParams.get('id'), 'eq.123e4567-e89b-12d3-a456-426614174000')
    assert.equal(details.sheetMusic.title, 'Advent Song')
    assert.equal(details.sheetMusic.file_url, 'https://pdfs.example.com/Advent%20%26%20Christmas/song.pdf')
    assert.equal(
      details.sheetMusic.download_url,
      '/api/sheet-music/123e4567-e89b-12d3-a456-426614174000/download',
    )

    const rangeResponse = await worker.fetch(
      new Request('https://worker.example/api/sheet-music/123e4567-e89b-12d3-a456-426614174000/download', {
        headers: {
          Origin: allowedOrigin,
          Range: 'bytes=10-18',
        },
      }),
      { ...env, PDF_BUCKET: pdfBucket },
    )
    assert.equal(rangeResponse.status, 206)
    assert.deepEqual(r2Options, { range: { offset: 10, length: 9 } })
    assert.equal(rangeResponse.headers.get('Content-Range'), 'bytes 10-18/100')
    assert.equal(rangeResponse.headers.get('Content-Length'), '9')
    assert.equal(rangeResponse.headers.get('Access-Control-Allow-Origin'), allowedOrigin)
    assert.equal(await rangeResponse.text(), 'PDF range')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects invalid pagination parameters', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/api/sheet-music?page=0&pageSize=500'),
    env,
  )

  assert.equal(response.status, 400)
})

test('returns selections when Cloudflare does not provide a client IP', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json([{ id: 'selection-1' }])

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/selections', { method: 'GET' }),
      env,
    )

    const data = await response.json()
    assert.equal(response.status, 200)
    assert.equal(data.selections[0].view_count, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('returns selections when Supabase view counting is unavailable', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => (
    new URL(String(url)).pathname === '/rest/v1/mass_selections'
      ? Response.json([{ id: 'selection-1', title: 'Sunday Mass' }])
      : Response.json({ message: 'Function not found.' }, { status: 404 })
  )

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/selections', {
        method: 'GET',
        headers: { 'CF-Connecting-IP': '203.0.113.42' },
      }),
      env,
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.deepEqual(data.selections, [{
      id: 'selection-1',
      title: 'Sunday Mass',
      view_count: null,
    }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects requests from origins outside the allowlist', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/api/selections', {
      method: 'POST',
      headers: {
        Origin: 'https://unexpected.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(makeSelection()),
    }),
    env,
  )

  assert.equal(response.status, 403)
})

test('rejects invalid liturgy dates', async () => {
  const selection = makeSelection()
  selection.serviceDate = '2026-02-30'
  const response = await worker.fetch(
    new Request('https://worker.example/api/selections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(selection),
    }),
    env,
  )

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /date/)
})

test('saves normalized song data to Supabase', async () => {
  const originalFetch = globalThis.fetch
  let supabaseUrl
  let supabasePayload

  globalThis.fetch = async (url, options) => {
    supabaseUrl = url
    supabasePayload = JSON.parse(options.body)
    assert.equal(options.headers.apikey, env.SUPABASE_SERVICE_ROLE_KEY)
    return new Response(null, { status: 201 })
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/selections', {
        method: 'POST',
        headers: {
          Origin: allowedOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(makeSelection()),
      }),
      env,
    )

    assert.equal(response.status, 201)
    assert.equal(new URL(supabaseUrl).pathname, '/rest/v1/mass_selections')
    assert.equal(supabasePayload.service_date, '2026-10-04')
    assert.deepEqual(supabasePayload.parts[0].songs, [{ title: 'Gather Us In', author: '' }])
    assert.equal((await response.json()).ok, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('requires the administrator token for bulk imports', async () => {
  const response = await worker.fetch(
    new Request('https://worker.example/api/bulk-import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderUrl: 'https://drive.google.com/drive/folders/folder-id', category: 'Advent' }),
    }),
    {
      ...env,
      BULK_UPLOAD_TOKEN: testBulkToken,
    },
  )

  assert.equal(response.status, 401)
})

test('accepts account-qualified Google Drive folder URLs', async () => {
  const originalFetch = globalThis.fetch
  let driveListUrl

  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url))
    if (requestUrl.hostname === 'project.supabase.co') return Response.json([])
    driveListUrl = requestUrl
    return Response.json({
      files: [{ id: 'drive-file-1', name: 'hymn.pdf', mimeType: 'application/pdf' }],
    })
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/bulk-import', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testBulkToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderUrl: 'https://drive.google.com/drive/u/0/folders/1fU-GEgz_6CujfhB3Etyy0oO4ih-A_t96',
          category: 'Choir',
        }),
      }),
      {
        ...env,
        GOOGLE_DRIVE_API_KEY: 'test-drive-api-key',
        BULK_UPLOAD_TOKEN: 'admin-token',
      },
    )

    assert.equal(response.status, 200)
    assert.match(driveListUrl.searchParams.get('q'), /'1fU-GEgz_6CujfhB3Etyy0oO4ih-A_t96' in parents/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('lists and prepares imports for folders with more than 50 PDFs in batches', async () => {
  const originalFetch = globalThis.fetch
  const supabaseBatchSizes = []
  let drivePageCount = 0

  globalThis.fetch = async (url) => {
    const requestUrl = new URL(String(url))
    if (requestUrl.hostname === 'project.supabase.co') {
      const ids = requestUrl.searchParams.get('drive_file_id').slice(4, -1).split(',')
      supabaseBatchSizes.push(ids.length)
      return Response.json([])
    }

    drivePageCount += 1
    const pageToken = requestUrl.searchParams.get('pageToken')
    if (!pageToken) {
      return Response.json({
        files: Array.from({ length: 50 }, (_, index) => ({
          id: `drive-file-${index + 1}`,
          name: `hymn-${index + 1}.pdf`,
          mimeType: 'application/pdf',
        })),
        nextPageToken: 'second-page',
      })
    }
    return Response.json({
      files: [{
        id: 'drive-file-51',
        name: 'hymn-51.pdf',
        mimeType: 'application/pdf',
      }],
    })
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/bulk-import', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testBulkToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderUrl: 'https://drive.google.com/drive/folders/folder-id',
          category: 'Advent',
        }),
      }),
      {
        ...env,
        GOOGLE_DRIVE_API_KEY: 'test-drive-api-key',
        BULK_UPLOAD_TOKEN: testBulkToken,
      },
    )
    const data = await response.json()

    assert.equal(response.status, 200)
    assert.equal(data.files.length, 51)
    assert.match(data.files[0].downloadTicket, /^\d{13}\.[0-9a-f]{64}$/)
    assert.equal(data.batchSize, 50)
    assert.equal(data.skipped, 0)
    assert.equal(drivePageCount, 2)
    assert.deepEqual(supabaseBatchSizes, [50, 1])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('imports Drive PDF metadata, stores the PDF in R2, and saves its public URL', async () => {
  const sourcePdf = await PDFDocument.create()
  const pdfBytes = await sourcePdf.save()
  const originalFetch = globalThis.fetch
  const storedObjects = new Map()
  let supabaseRow

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input))
    if (url.hostname === 'www.googleapis.com' && url.pathname === '/drive/v3/files' && !url.searchParams.has('alt')) {
      return Response.json({
        files: [{ id: 'drive-file-1', name: 'hymn.pdf', mimeType: 'application/pdf', size: `${pdfBytes.byteLength}` }],
      })
    }
    if (url.hostname === 'www.googleapis.com' && url.pathname.endsWith('/drive-file-1') && !url.searchParams.has('alt')) {
      return Response.json({
        id: 'drive-file-1',
        name: 'hymn.pdf',
        mimeType: 'application/pdf',
        size: `${pdfBytes.byteLength}`,
      })
    }
    if (url.hostname === 'www.googleapis.com' && url.searchParams.get('alt') === 'media') {
      return new Response(pdfBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    }
    if (url.hostname === 'project.supabase.co' && options.method === 'POST') {
      supabaseRow = JSON.parse(options.body)
      return new Response(null, { status: 201 })
    }
    if (url.hostname === 'project.supabase.co') {
      return Response.json([])
    }
    throw new Error(`Unexpected request: ${url.href}`)
  }

  const testEnv = {
    ...env,
    GOOGLE_DRIVE_API_KEY: 'test-drive-api-key',
    BULK_UPLOAD_TOKEN: 'admin-token',
    R2_PUBLIC_BASE_URL: 'https://pdfs.example.com',
    PDF_BUCKET: {
      async head(key) {
        return storedObjects.has(key) ? { key } : null
      },
      async put(key, stream) {
        storedObjects.set(key, await new Response(stream).arrayBuffer())
        return { key }
      },
      async delete(key) {
        storedObjects.delete(key)
      },
    },
  }

  try {
    const listResponse = await worker.fetch(
      new Request('https://worker.example/api/bulk-import', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testBulkToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderUrl: 'https://drive.google.com/drive/folders/folder-id',
          category: 'Advent & Christmas',
        }),
      }),
      testEnv,
    )
    const listData = await listResponse.json()

    assert.equal(listResponse.status, 200)
    assert.equal(listData.files.length, 1)
    assert.equal(listData.skipped, 0)

    const downloadResponse = await worker.fetch(
      new Request('https://worker.example/api/bulk-import/download', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'folder-id',
          fileId: 'drive-file-1',
          downloadTicket: listData.files[0].downloadTicket,
        }),
      }),
      testEnv,
    )
    assert.equal(downloadResponse.status, 200)
    assert.equal(downloadResponse.headers.get('Content-Type'), 'application/pdf')

    const uploadResponse = await worker.fetch(
      new Request('https://worker.example/api/bulk-import/upload', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/pdf',
          'X-Drive-File-Id': 'drive-file-1',
          'X-Metadata-Title': encodeURIComponent('Hymn of Hope'),
          'X-Metadata-Composer': encodeURIComponent('A. Composer'),
          'X-Metadata-Category': encodeURIComponent('Advent & Christmas'),
        },
        body: pdfBytes,
      }),
      testEnv,
    )
    const uploadData = await uploadResponse.json()

    assert.equal(uploadResponse.status, 201)
    assert.equal(storedObjects.size, 1)
    assert.equal(supabaseRow.title, 'Hymn of Hope')
    assert.equal(supabaseRow.composer, 'A. Composer')
    assert.equal(supabaseRow.category, 'Advent & Christmas')
    assert.match(supabaseRow.file_url, /^https:\/\/pdfs\.example\.com\/pdfs\/[0-9a-f]{64}\.pdf$/)
    assert.equal(supabaseRow.drive_file_id, 'drive-file-1')
    assert.equal(uploadData.fileUrl, supabaseRow.file_url)
    assert.equal(uploadData.deduplicated, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects Drive downloads without a valid folder-list ticket', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('Drive should not be contacted for an invalid download ticket.')
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/bulk-import/download', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${testBulkToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          folderId: 'folder-id',
          fileId: 'drive-file-1',
          downloadTicket: 'invalid-ticket',
        }),
      }),
      {
        ...env,
        GOOGLE_DRIVE_API_KEY: 'test-drive-api-key',
        BULK_UPLOAD_TOKEN: 'admin-token',
      },
    )

    assert.equal(response.status, 403)
    assert.match((await response.json()).error, /current import list/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('accepts a public PDF upload and stores its metadata reference in Supabase', async () => {
  const sourcePdf = await PDFDocument.create()
  const pdfBytes = await sourcePdf.save()
  const originalFetch = globalThis.fetch
  const savedMetadata = []
  const storedObjects = new Map()
  let r2PutCount = 0
  let storedValueType

  globalThis.fetch = async (url, options = {}) => {
    assert.equal(new URL(String(url)).hostname, 'project.supabase.co')
    if (options.method === 'POST') {
      savedMetadata.push(JSON.parse(options.body))
      return new Response(null, { status: 201 })
    }
    throw new Error('Unexpected Supabase request')
  }

  try {
    const response = await worker.fetch(
      new Request('https://worker.example/api/public-upload', {
        method: 'POST',
        headers: {
          Origin: allowedOrigin,
          'Content-Type': 'application/pdf',
          'X-Metadata-Title': 'Community Hymn',
          'X-Metadata-Composer': '',
          'X-Metadata-Category': 'Worship',
        },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(pdfBytes)
            controller.close()
          },
        }),
        duplex: 'half',
      }),
      {
        ...env,
        R2_PUBLIC_BASE_URL: 'https://pdfs.example.com',
        PDF_BUCKET: {
          async head(key) {
            return storedObjects.has(key) ? { key } : null
          },
          async put(key, value, options) {
            r2PutCount += 1
            storedValueType = value.constructor.name
            storedObjects.set(key, {
              bytes: value,
              options,
            })
            return { key }
          },
          async delete(key) {
            storedObjects.delete(key)
          },
        },
      },
    )
    const result = await response.json()
    const duplicateResponse = await worker.fetch(
      new Request('https://worker.example/api/public-upload', {
        method: 'POST',
        headers: {
          Origin: allowedOrigin,
          'Content-Type': 'application/pdf',
          'X-Metadata-Title': 'Community Hymn, alternate listing',
          'X-Metadata-Composer': '',
          'X-Metadata-Category': 'Choir',
        },
        body: pdfBytes.slice(),
        duplex: 'half',
      }),
      {
        ...env,
        R2_PUBLIC_BASE_URL: 'https://pdfs.example.com',
        PDF_BUCKET: {
          async head(key) {
            return storedObjects.has(key) ? { key } : null
          },
          async put(key, value, options) {
            r2PutCount += 1
            storedValueType = value.constructor.name
            storedObjects.set(key, {
              bytes: value,
              options,
            })
            return { key }
          },
          async delete(key) {
            storedObjects.delete(key)
          },
        },
      },
    )
    const duplicateResult = await duplicateResponse.json()

    assert.equal(response.status, 201)
    assert.equal(duplicateResponse.status, 201)
    assert.equal(result.ok, true)
    assert.equal(storedObjects.size, 1)
    assert.equal(r2PutCount, 1)
    assert.equal(savedMetadata.length, 2)
    assert.equal(savedMetadata[0].drive_file_id, null)
    assert.equal(savedMetadata[0].title, 'Community Hymn')
    assert.equal(savedMetadata[0].composer, '')
    assert.equal(savedMetadata[0].category, 'Worship')
    assert.match(savedMetadata[0].r2_key, /^pdfs\/[0-9a-f]{64}\.pdf$/)
    assert.equal(savedMetadata[0].r2_key, savedMetadata[1].r2_key)
    assert.equal(savedMetadata[0].file_url, result.fileUrl)
    assert.equal(duplicateResult.deduplicated, true)
    assert.equal(duplicateResult.fileUrl, result.fileUrl)
    assert.equal(storedValueType, 'Uint8Array')
    assert.equal(
      storedObjects.get(savedMetadata[0].r2_key).options.httpMetadata.contentType,
      'application/pdf',
    )
    assert.deepEqual(
      storedObjects.get(savedMetadata[0].r2_key).options.onlyIf,
      { etagDoesNotMatch: '*' },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rejects non-PDF bodies on the public upload endpoint', async () => {
  let stored = false
  const response = await worker.fetch(
    new Request('https://worker.example/api/public-upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/pdf',
        'X-Metadata-Title': 'Not a PDF',
        'X-Metadata-Composer': '',
        'X-Metadata-Category': 'Worship',
      },
      body: 'plain text',
    }),
    {
      ...env,
      R2_PUBLIC_BASE_URL: 'https://pdfs.example.com',
      PDF_BUCKET: {
        async put(key, stream) {
          await new Response(stream).arrayBuffer()
          stored = true
        },
        async delete() {},
      },
    },
  )

  assert.equal(response.status, 400)
  assert.equal(stored, false)
})
