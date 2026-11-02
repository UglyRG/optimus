# API

The backend runs at `http://localhost:8788` in local development.

Interactive FastAPI docs are available while the backend is running:

- `GET /docs`
- `GET /openapi.json`

## Authentication

Browser-authenticated endpoints use the `optimus_session` cookie created by:

```text
POST /api/auth/login
```

Login accepts `{name, accessKey, code?}`. When 2FA is enabled, valid credentials without a code return `{requiresTwoFactor: true}` without issuing a session cookie. Resubmit the credentials with `code` containing a current six-digit TOTP or unused recovery code. Successful login retains the existing `{user, expiresAt}` response. Invalid credentials/codes return 401; ten failed attempts within five minutes block authentication with 429 until the window expires. Codes cannot be reused.

Session-authenticated security endpoints:

- `GET /api/auth/2fa`: `{enabled, recoveryCodesRemaining}`.
- `POST /api/auth/2fa/setup`: `{accessKey}` → `{secret, qrCode}` (inline SVG data URL); pending setup lasts ten minutes and is bound to the current session.
- `POST /api/auth/2fa/enable`: `{accessKey, code}` → `{enabled: true, recoveryCodes}`. Recovery codes appear only in this response.
- `POST /api/auth/2fa/disable`: `{accessKey, code}` → `{enabled: false}`; requires a valid TOTP or recovery code.

Enable/disable invalidates other browser sessions. Security responses use `Cache-Control: no-store`. These endpoints configure one authenticator for the installation. See [setup, storage, and recovery](operations/two-factor-authentication.md).

Public ingestion endpoints do not use the browser session cookie. Send either:

```text
Authorization: Bearer <key>
```

or:

```text
X-API-Key: <key>
```

The accepted public key comes from `OPTIMUS_PUBLIC_API_KEY`, then `OPTIMUS_API_KEY`, then `OPTIMUS_ACCESS_KEY`.

## Public Padelog Endpoint

```bash
curl -X POST http://localhost:8788/api/public/padelog/matches \
  -H "Authorization: Bearer $OPTIMUS_PUBLIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "club": "Padel Club",
    "date": "2026-05-29",
    "teammate": "Alex",
    "opponents": "Nikos / Maria",
    "result": "Won",
    "sets": "2-1"
  }'
```

Accepted wrapper payloads:

```json
{ "match": { "...": "..." } }
```

```json
{ "matches": [{ "...": "..." }] }
```

## Public Betlog Endpoint

```bash
curl -X POST http://localhost:8788/api/public/betlog/bets \
  -H "Authorization: Bearer $OPTIMUS_PUBLIC_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-05-29",
    "time": "21:00",
    "betId": "BET-1001",
    "betType": "Single",
    "stake": 10,
    "freeBet": false,
    "status": "Open",
    "returnAmount": 0,
    "selection": "Team A win",
    "odds": 1.85,
    "market": "Match winner",
    "match": "Team A vs Team B",
    "score": "",
    "outcomeType": "single",
    "legs": 1
  }'
```

Accepted wrapper payloads:

```json
{ "bet": { "...": "..." } }
```

```json
{ "bets": [{ "...": "..." }] }
```

## Internal Tool APIs

Internal tool routes live under `/api/tools/...` and require a logged-in browser session. Use `/docs` as the source of truth for route details while the backend is running.

SEO and GEO page audits use:

```text
POST /api/tools/seo-checker
POST /api/tools/geo-checker
```

Both accept a JSON object with a required public `url` and optional `topic` and `locale`. Responses contain framework version `1.0`, the capped and uncapped score, rating, category weights and scores, individual check evidence, any critical caps, summary counts, and limitations. Every successful response is saved in Postgres; fetched raw HTML is not retained.

Saved audit routes are:

```text
GET  /api/tools/{seo|geo}-checker/history
POST /api/tools/{seo|geo}-checker/history/delete
GET  /api/tools/{seo|geo}-checker/history/{audit_id}/pdf
```

The history response contains complete saved records. Delete accepts `{ "id": "..." }`. The PDF route returns the saved result as an attachment and does not rerun the audit.

Knowledge Expert uploads use:

```text
POST /api/tools/knowledge-expert/upload
```

The JSON body accepts `mode` (`append` or `replace`) and between 1 and 20 Base64-encoded files. Supported extensions are CSV, JSON, HTML, TXT, Markdown, PDF, and DOCX. The response includes added entry and source-chunk counts.

Knowledge Expert source analysis is available at:

```text
GET /api/tools/knowledge-expert/admin/reports/source-coverage
```

The response includes aggregate traceability, Unicode-aware lexical coverage, answer-support metrics, per-document coverage, uncovered or partially covered chunks, low-support entries, and scoring limitations. Structured CSV and JSON Q&A coverage uses recognized question and answer values while retaining the complete row or object for source traceability.

The structural Knowledge Map is available at:

```text
GET /api/tools/knowledge-expert/knowledge-map
```

The response contains bounded document, source-chunk, and Q&A nodes; structural edges; optional Q&A semantic-similarity edges; coverage status; retrieval/citation counts; graph totals; and a truncation flag for large datasets. Similarity edges use existing pgvector embeddings, keep up to three nearest neighbors per embedded Q&A entry, and require cosine similarity of at least `0.82`.

## Sticky Notes

These routes require the browser session cookie:

```text
GET  /api/tools/sticky-notes/notes
POST /api/tools/sticky-notes/notes
POST /api/tools/sticky-notes/delete
```

GET returns `{ "notes": [...] }` sorted by order and creation time. POST save accepts `text`, `color` (`yellow`, `pink`, `blue`, `green`, `orange`), `size` (`small`, `large`), integer `order`, and boolean `showOnHome`. New notes omit `id` and `revision`; updates require both. Save returns `{ "note": {...} }`, including server-generated ID, revision, and timestamps. Delete accepts `{ "id": "...", "revision": "..." }` and returns `{ "note": null }`.

Limits are 500 notes and 20,000 characters per note. Invalid data returns 400; stale revisions/deleted notes return 409. Missing or malformed encryption keys return 503; wrong-key authentication or damaged encrypted documents return 400. Read/save responses use `Cache-Control: no-store`. Plaintext is sent only to authenticated browser requests; storage and backup note entries are encrypted. See [Sticky Notes](tools/sticky-notes.md).

## myDATA Purchases (preparation release)

All routes below are under `/api/tools/mydata-invoices`, require the `optimus_session` cookie and return `Cache-Control: no-store`. Public API keys do not grant access. Mutation requests reject cross-site browser requests and untrusted Origin headers. All monetary values and MARKs are JSON strings.

| Method/path | Purpose |
|---|---|
| GET /companies | List up to three companies and disabled AADE capability status |
| POST /companies | Create/update company; updates require `id` and current `revision` |
| GET /companies/{id}/invoices | List with inclusive `start`/`end` review months, `offset`, and `status` (`all`, `needs_review`, `reviewed`); 100 per page plus period progress |
| POST /companies/{id}/invoices | Create/save a manual draft; edits require `id` and `revision`; `markReviewed: true` checks required facts/totals, otherwise clears review |
| POST /companies/{id}/documents | Multipart `file`, `reviewMonth`, optional `lookupQr` (default false); return draft, duplicate flag and queued extraction |
| GET /companies/{id}/documents/{documentId}/content | Authorized decrypted original preview |
| GET /companies/{id}/invoices/{invoiceId}/history | Saved fact revisions and display-name audit history |
| POST /backup | Return encrypted module envelope (or null when no companies exist) |
| POST /restore | Validate encrypted envelope and replace module records transactionally; reset reviews/revisions |

Stale revisions return 409; malformed facts return 400; missing company/document scope returns 404. Uploads are limited to 25 MB and supported PDF/image formats. No sync, submission, approval or tax-validation endpoint exists yet. New document uploads automatically queue local extraction. See [myDATA Purchases](tools/mydata-invoices.md).

### myDATA extraction APIs

Under the same session-only prefix, mutations use the same origin checks:

| Method/path | Purpose |
|---|---|
| GET /extraction-capabilities | Parser version, QR/PDF/OCR readiness, supported QR providers, AI configuration availability and configured model name; no secrets or filesystem paths |
| GET /companies/{id}/invoices/{invoiceId}/extractions | Latest job, progress and evidence-backed result (or null) |
| POST /companies/{id}/invoices/{invoiceId}/extractions | Queue a job for the saved `revision`; `provider` defaults to `local`; `anthropic` requires explicit `consent: true` and configured key/model; `lookupQr: true` enables recognised-provider reads, and optional `qrChoice` selects a decoded SHA-256 reference |
| POST /companies/{id}/invoices/{invoiceId}/extractions/{jobId}/cancel | Cancel pending/running extraction |
| POST /companies/{id}/invoices/{invoiceId}/extractions/{jobId}/apply | Apply selected result `fields` at the expected `revision`; reject stale invoice/company revisions and clear review |

Applying an outdated parser result returns 409 and requires a new extraction; stored draft facts/history are preserved. Results may contain layout text, original PDF text and bounded header-image OCR evidence. Only one active job per purchase is allowed. Extraction never directly changes purchase facts. List responses include `extractionState` for progress display. Errors retain the existing HTTP error shape; provider/parser diagnostics are redacted. Jobs, text, evidence and source versions participate in encrypted module backup/restore.

Document review also provides authenticated `GET /companies/{id}/documents/{documentId}/metadata` (safe filename/MIME/page-count/size) and `GET /companies/{id}/documents/{documentId}/preview?page=1` (a locally rendered PDF page or the original image). Page access uses the same company scope and no-store headers; previews use a credential-free subprocess with a 25-second timeout.

### myDATA QR lookup results

Extraction result `qr` holds recognised references, selected hash, status, safe verification links, source conflicts and optional provider XML/evidence. Statuses include `not_found`, `unsupported`, `needs_selection`, `invalid_selection`, `lookup_disabled`, `unavailable`, `aade_reference`, `receipt_reference`, `provider_reference`, `conflict`, `review_required`, and `retrieved`. `aadeVerified` stays false for this read-only provider feature. Browser requests cannot supply a URL or custom host. Provider-derived suggestions use `basis: provider_xml`; unverified receipt hints use `qr_unverified` and are not preselected. Successful QR reads add a redacted audit event; full URLs/XML remain inside protected extraction records and encrypted backups. See [QR policy](tools/mydata-invoices.md#qr-references-and-provider-retrieval).

QR references identify `source: embedded_image` or `rendered_page` where applicable. Embedded-image evidence retains its native `imageSize`, pixel bounding box, image index and PDF image bounds; coordinates are not silently treated as page-render coordinates. `qrVerificationProviders` separately lists recognised verification-only providers (currently Epsilon Digital) from providers supporting XML retrieval. Version-v3 and older extraction results need regeneration before applying after this update.
