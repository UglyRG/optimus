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

## myDATA Purchases (read-only intake)

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

Stale revisions return 409; malformed facts return 400; missing company/document scope returns 404. Uploads are limited to 25 MB and supported PDF/image formats. No submission, approval or tax-validation endpoint exists. Read-only sync routes are listed below. New document uploads automatically queue local extraction. See [myDATA Purchases](tools/mydata-invoices.md).

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

### myDATA AADE intake APIs

All routes use the same session, origin and no-store policy. `companyRevision`, draft `revision` and `remoteRevision` are opaque UUID preconditions. Stale versions return 409. `GET /companies` now reports `stage: read-only-intake`, `aadeReads: true`, `aadeWrites: false`; per-company availability is reported separately.

| Method | Path (under myDATA prefix) | Behaviour |
|---|---|---|
| GET | `/companies/{company}/connection` | Fixed connection options, configured booleans, safe configuration message, latest read job and last completed sync timestamp. No credentials/usernames. |
| GET | `/companies/{company}/sync` | Same read status; includes pending matching count across company periods. |
| POST | `/companies/{company}/connection/test` | Queue one-page read test; body `{start, end, companyRevision}` uses YYYY-MM. No draft import. |
| POST | `/companies/{company}/sync` | Queue monthly range refresh using the same body. Returns `{job}`; returns an already-active company job rather than queueing a second. |
| POST | `/companies/{company}/sync/{job}/cancel` | Cancel queued/running work. Committed pages remain. |
| GET | `/companies/{company}/remote-records?start=YYYY-MM&end=YYYY-MM&offset=0` | Paginated 100-record read model with environment, immutable remote facts/revision, candidates or conflicts. No raw ciphertext. |
| GET | `/companies/{company}/invoices/{invoice}/remote-records` | Linked remote evidence, exact amounts/line references, classification events, cancellations, conflicts and editable field proposals. |
| POST | `/companies/{company}/remote-records/{remote}/match` | Explicit link: `{remoteRevision, invoiceId, revision}`. Conflicting fields reject with 400. Or `{remoteRevision, create:true}` creates a separate unreviewed draft. No remote fields silently copied into existing drafts. |
| POST | `/companies/{company}/invoices/{invoice}/remote-records/{remote}/apply` | Apply selected supported fields with `{revision, remoteRevision, fields:[…]}`; clears review. Returns `{invoice}`. |
| POST | `/companies/{company}/invoices/{invoice}/document` | Attach an original to a saved draft without one: multipart `revision`, `file`, optional `lookupQr` (false by default). Enforces company hash uniqueness; returns the updated invoice and optional queued extraction/warning. |

Company save accepts `readConnection: "" | "slot_1_test" | "slot_1_prod" | …` (slots 1–3), and `readPrincipal: company | representative`; these are configuration aliases, never arbitrary variable names. Defaults preserve local preparation. Drafts accept a separate `series` string (100 characters). Browser-supplied provenance fields are ignored; source/environment are server-owned. Invoice list results include server-derived `remoteLinks` with environment/MARK/cancellation metadata.

Jobs expose mode, selected months, environment, counts, safe progress and lifecycle state. Full upstream responses, internal tokens and company revision snapshots are not returned. Failed/partial jobs do not establish complete period coverage. No upstream error body or credentials are returned. Only the connector's fixed AADE GET RequestDocs route can be called; the browser cannot supply a method, base URL, headers, key values or arbitrary query parameters.

The AADE reader accepts either direct namespaced `RequestedDoc` XML or one `{http://schemas.microsoft.com/2003/10/Serialization/}string` envelope containing escaped XML, as observed from production. Both layers use secure XML parsing and size limits; arbitrary/nested wrappers remain rejected. Response hashes and encrypted evidence always cover the original wire bytes.

### myDATA classification choices

`GET /classification-options` returns the pinned offline catalogue and an empty context for a new/local draft. `GET /companies/{company}/invoices/{invoice}/classification-options` returns the same catalogue and company-scoped remote invoice-type context. Both require the Optimus session and return no-store responses. No upstream request is made.

Draft saves accept optional `mydataInvoiceType` and `vatClassification`; each `lines[]` entry accepts optional `vatClassification` alongside `category`/`type`. `vatTreatment` remains free-text notes for compatibility. New selections must be official catalogue values; available explicit category/E3 pairings are checked server-side using linked AADE type first, then the manually selected type. A new conflicting manual type is rejected. Invalid new values/pairs return 400. Unchanged pre-existing typed notes remain savable and receive warnings. Partial optional choices can be saved. `classificationCheck` is server-generated metadata with catalogue version, effective type, validation scope and warnings, not a claim of tax eligibility. Browser-supplied check metadata is ignored.

### Delete a manually uploaded purchase

`DELETE /companies/{company}/invoices/{invoice}` accepts JSON `{revision}` and uses the existing session/origin checks. Only local purchases with an uploaded original are eligible; AADE-origin drafts are rejected with 400 even if they have an attachment. Stale revisions return 409 and missing/cross-company purchases return 404. The list exposes a server-derived `canDelete` boolean.

The response is `{deleted:true, invoiceId, originalCleanupPending, remoteLinksPreserved}`. Deletion transactionally removes the purchase/document/extractions, retains audit history, and unlinks any remote evidence while changing its revision. Encrypted file removal happens after commit; `originalCleanupPending:true` is a visible local cleanup warning. Existing backups are unchanged. No AADE write occurs.
