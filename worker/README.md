# Selection and sheet-music uploads

The form sends selection names, liturgy dates, and the 11 liturgy parts to the Cloudflare Worker. Each part may contain multiple songs; song authors are stored as an empty string when omitted. The Worker saves submissions in Supabase, and the Music selections section reads the latest records in pages of 12. Each list load records one unique view per selection and client IP on the current page; the Worker stores an HMAC of the IP rather than the raw address. PDF handling is separate and is not part of this endpoint.

## Worker code layout

- `src/index.js` contains only routing, origin checks, and method handling.
- `src/http.js` contains shared JSON, body-reading, Supabase, and bulk-token helpers.
- `src/selections.js` validates and stores mass selections.
- `src/sheet-music.js` loads public catalogue records from Supabase and builds PDF links from their R2 keys.
- `src/bulk-import.js` handles Drive folder listing, per-PDF download, and R2/Supabase storage.

## Bulk PDF import

The sheet-music page has a public **Upload a PDF** form and a separate admin bulk-import form. Public users can submit one PDF, title, optional composer, and category without an account or bulk token. The Worker validates each PDF within the 15 MB limit, writes its bytes to R2 at `<category>/random-id.pdf`, and saves the metadata and public file URL in Supabase as the catalogue reference. Writing a bounded byte array gives R2 a known content length even when a local development proxy forwards the request as a stream. The file is publicly accessible to anyone with its URL. The R2 category prefix preserves the category name and casing; slash characters are not allowed in category names.

The library calls `GET /api/sheet-music` to load catalogue records from Supabase in pages of 12. Both list endpoints accept `page` (starting at 1) and `pageSize` (1–50) query parameters and return `hasMore` for next-page navigation. Unfiltered “All songs” requests include a shuffle seed, so each new selection gets a randomized order that stays consistent while paging through that selection. Category and search filters continue to apply their own filtered catalogue results. The sheet-music endpoint accepts `q` to search titles (ignoring spacing and punctuation), composers, and categories, and an exact `category` filter. `GET /api/sheet-music/categories` returns the distinct categories currently used in the Supabase catalogue; the home page uses these for category filters and the single-upload category selector. The `/edit-composers` page lists the catalogue with individual composer editors and requires the existing bulk-upload administrator token for each update. Recently edited PDFs move to the bottom of that editor page only. The same token is required to run the narrowly scoped legacy Christmas-category normalization. Home-page cards use the browser's native PDF preview, while `/pdf/{id}` uses the custom PDF.js viewer. The viewer uses `GET /api/sheet-music/{id}/download`, which supports byte-range reads and streams the stored R2 object with an attachment filename of `<title>-ChoirHub.pdf`. The viewer's WhatsApp share button sends the public PDF URL; WhatsApp Web does not permit a website to attach a file directly to a message.

The admin bulk-import form accepts one publicly shared Google Drive folder URL, a category name, and the administrative bulk-upload token. The Worker uses the Drive API to enumerate PDFs; the browser reads the embedded PDF title and author/composer (falling back to the file name when title metadata is absent), adds the ChoirHub logo as a subtle watermark at the bottom right of every page, and uploads the watermarked PDF through the Worker to R2. Public single-PDF uploads receive the same watermark before upload. The Worker saves the title, composer, category, public URL, R2 key, and Drive file ID in Supabase. Re-imported Drive files are skipped.

Public single-PDF uploads are limited to 15 MB; admin bulk-import PDFs can be up to 40 MB each. The bulk limit stays below Cloudflare's 100 MB request-body maximum and leaves room for the Worker to buffer and watermark files. All PDFs in a Drive folder are imported directly (subfolders are not scanned), with progress grouped into batches of up to 50 files. Files are handled one at a time; individual failures are reported while remaining PDFs continue importing. The R2 public URL is built from `R2_PUBLIC_BASE_URL`; configure a public R2 custom domain (recommended for production) or the R2 development domain. Public buckets expose their contents to anyone with the URL.

The public upload endpoint currently has no Turnstile or other upload verification, by design. Add Turnstile verification and configure Cloudflare rate limiting before opening it to production traffic to reduce automated abuse and unexpected storage usage.

## Supabase and Google setup

1. Run all five SQL files in `migrations/` in timestamp order in the Supabase SQL Editor. The third migration allows direct public uploads without a Google Drive file ID; the fourth adds unique selection views; the fifth rewrites existing R2 development-domain URLs to the production custom domain.
2. Set `SUPABASE_URL` in `worker/wrangler.jsonc` to the project's HTTPS URL.
3. Enable the Google Drive API in Google Cloud and create an API key restricted to the Drive API. Share each source folder so that anyone with its link can view it.
4. Set `R2_PUBLIC_BASE_URL` in `worker/wrangler.jsonc` to the public HTTPS domain of the R2 bucket, without a query string or trailing object path.
5. Bind an existing R2 bucket in `worker/wrangler.jsonc` by changing `bucket_name` from `choirhub-pdfs` to the actual bucket name. Enable public access and connect the domain used in `R2_PUBLIC_BASE_URL` in Cloudflare.
6. Create `worker/.dev.vars` from `.dev.vars.example`. Set `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_DRIVE_API_KEY`, and `BULK_UPLOAD_TOKEN` there for local development. Keep these credentials on the Worker only; never expose them in frontend environment variables.
7. For production, set secrets with `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --config worker/wrangler.jsonc`, `npx wrangler secret put GOOGLE_DRIVE_API_KEY --config worker/wrangler.jsonc`, and `npx wrangler secret put BULK_UPLOAD_TOKEN --config worker/wrangler.jsonc`. Use a long, randomly generated value for the bulk-upload token.

See [Google Drive files.list](https://developers.google.com/drive/api/reference/rest/v3/files/list), [Google Drive files.get](https://developers.google.com/drive/api/reference/rest/v3/files/get), [Cloudflare R2 public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/), and [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) for provider setup and access details.

## Local development

Run `npm run worker:dev` and `npm run dev` in separate terminals. Vite proxies `/api` requests to the local Worker on port 8787. The Worker and R2 binding run locally, so PDFs are stored only in Wrangler's local R2 simulation and are not sent to Cloudflare. Before testing uploads in the browser, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the ignored `worker/.env` to a separate test Supabase project; otherwise metadata could be written to the production database while the PDF remains local. Keep the production values for deployed configuration. Wrangler's local R2 data is persisted under `worker/.wrangler/state`. R2 has no separate folder objects: a key such as `Advent and Christmas/<uuid>.pdf` is grouped under that category prefix.

## Deployment

The Worker is configured with the `api.choirhub.ng` custom domain; it requires `choirhub.ng` to be an active Cloudflare zone. The production frontend at `https://choirhub.ng` sends selection, bulk-import, and public PDF upload requests to this API hostname by default. Set `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` to the exact deployed frontend origins before deploying. Override `VITE_SELECTIONS_API_URL` at frontend build time only if using a different Worker API URL; bulk import and both PDF upload flows derive their endpoint URLs from the same API base. `R2_PUBLIC_BASE_URL` is separate from the API domain; it points to the R2 custom domain `https://choirhub-pdfs.choirhub.ng` and controls public PDF links.

The Drive bulk-import endpoints require the Worker-only `BULK_UPLOAD_TOKEN`, which the administrator enters into the form for each import; it is not stored by the frontend. The public direct-upload endpoint does not require this token. The separate mass-selection endpoint still requires a dedicated authentication/anti-abuse control before accepting public submissions in production.
