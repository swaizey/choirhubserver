import {
  handleBulkDownload,
  handleBulkImport,
  handleBulkPdfUpload,
} from './bulk-import.js'
import { jsonResponse } from './http.js'
import { handlePublicPdfUpload } from './public-uploads.js'
import { handleSelectionList, handleSelectionSubmission } from './selections.js'
import { handleSheetMusicList } from './sheet-music.js'

const routes = new Map([
  ['/api/selections', handleSelectionSubmission],
  ['/api/bulk-import', handleBulkImport],
  ['/api/bulk-import/download', handleBulkDownload],
  ['/api/bulk-import/upload', handleBulkPdfUpload],
  ['/api/public-upload', handlePublicPdfUpload],
])

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const allowedOrigins = (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const origin = request.headers.get('Origin')

    if (origin && !allowedOrigins.includes(origin)) {
      return jsonResponse({ error: 'This origin is not allowed.' }, 403)
    }

    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true }, 200, origin)
    }

    const handler = routes.get(url.pathname)
    const isSheetMusicPath = url.pathname === '/api/sheet-music'
    if (!handler && !isSheetMusicPath) {
      return jsonResponse({ error: 'Not found.' }, 404, origin)
    }

    if (request.method === 'OPTIONS') {
      return jsonResponse(null, 204, origin)
    }

    if (url.pathname === '/api/selections' && request.method === 'GET') {
      return handleSelectionList(request, env, origin)
    }
    if (url.pathname === '/api/sheet-music' && request.method === 'GET') {
      return handleSheetMusicList(env, origin)
    }
    if (isSheetMusicPath) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }

    if (request.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }

    return handler(request, env, origin)
  },
}
