import {
  handleBulkDownload,
  handleBulkImport,
  handleBulkPdfUpload,
} from './bulk-import.js'
import { jsonResponse } from './http.js'
import { handlePublicPdfUpload } from './public-uploads.js'
import { handleSheetMusicDelete } from './sheet-music-admin.js'
import { handleSelectionList, handleSelectionSubmission } from './selections.js'
import {
  handleChristmasCategoryNormalization,
  handleSheetMusicCategories,
  handleSheetMusicComposerUpdate,
  handleSheetMusicDetails,
  handleSheetMusicDownload,
  handleSheetMusicList,
} from './sheet-music.js'

const routes = new Map([
  ['/api/selections', handleSelectionSubmission],
  ['/api/bulk-import', handleBulkImport],
  ['/api/bulk-import/download', handleBulkDownload],
  ['/api/bulk-import/upload', handleBulkPdfUpload],
  ['/api/public-upload', handlePublicPdfUpload],
  ['/api/admin/delete-sheet-music', handleSheetMusicDelete],
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
    const isSheetMusicCategoriesPath = url.pathname === '/api/sheet-music/categories'
    const isChristmasCategoryNormalizationPath = url.pathname === '/api/admin/normalize-christmas-category'
    const composerUpdateMatch = url.pathname.match(/^\/api\/sheet-music\/([^/]+)\/composer$/)
    const downloadMatch = url.pathname.match(/^\/api\/sheet-music\/([^/]+)\/download$/)
    const sheetMusicMatch = url.pathname.match(/^\/api\/sheet-music\/([^/]+)$/)
    if (
      !handler
      && !isSheetMusicPath
      && !isSheetMusicCategoriesPath
      && !isChristmasCategoryNormalizationPath
      && !composerUpdateMatch
      && !downloadMatch
      && !sheetMusicMatch
    ) {
      return jsonResponse({ error: 'Not found.' }, 404, origin)
    }

    if (request.method === 'OPTIONS') {
      return jsonResponse(null, 204, origin)
    }

    if (url.pathname === '/api/selections' && request.method === 'GET') {
      return handleSelectionList(request, env, origin)
    }
    if (url.pathname === '/api/sheet-music' && request.method === 'GET') {
      return handleSheetMusicList(request, env, origin)
    }
    if (isSheetMusicCategoriesPath && request.method === 'GET') {
      return handleSheetMusicCategories(env, origin)
    }
    if (isSheetMusicCategoriesPath) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }
    if (isChristmasCategoryNormalizationPath && request.method === 'POST') {
      return handleChristmasCategoryNormalization(request, env, origin)
    }
    if (isChristmasCategoryNormalizationPath) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }
    if (composerUpdateMatch && request.method === 'PATCH') {
      return handleSheetMusicComposerUpdate(request, env, origin, composerUpdateMatch[1])
    }
    if (composerUpdateMatch) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }
    if (downloadMatch && request.method === 'GET') {
      return handleSheetMusicDownload(request, env, origin, downloadMatch[1])
    }
    if (downloadMatch) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
    }
    if (sheetMusicMatch && request.method === 'GET') {
      return handleSheetMusicDetails(env, origin, sheetMusicMatch[1])
    }
    if (sheetMusicMatch) {
      return jsonResponse({ error: 'Method not allowed.' }, 405, origin)
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
