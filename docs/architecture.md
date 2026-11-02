# Architecture

## High-Level Flow

```text
Browser
  |
  | React app, session cookie, JSON requests
  v
FastAPI backend
  |
  | app JSON, knowledge records, vector search
  v
Postgres + pgvector

FastAPI backend
  |
  | generated PDFs, HTML, Base64 source files
  v
Outputs/
```

## Frontend

The active frontend lives in `frontend-react/`.

Important areas:

- `frontend-react/src/main.jsx`: application shell, routing, dashboard, admin UI, tool pages, and shared helpers.
- `frontend-react/src/styles.css`: app styling.
- `frontend-react/public/assets/`: branding and favicon assets.

Tool routing is driven by stable hosted tool IDs. The frontend maps each tool ID to a local UI.

The app background follows the active light or dark theme through the `--bg-image` CSS variable in `styles.css`. Light mode uses `public/assets/optimus-bg-light.png`; dark mode uses `public/assets/optimus-bg-dark.png`. Both use a centered, fixed, cover-sized image with a theme-specific overlay and solid fallback color. The existing theme toggle switches the background along with the UI colors and saves the theme in browser local storage.

## Backend

The active backend lives in `backend_py/optimus_api/`.

Important modules:

- `main.py`: FastAPI app, routes, auth, backup/restore orchestration.
- `catalog.py`: hosted tools and default catalog layout.
- `domain.py`: normalization and validation for persisted tool data.
- `tools.py`: file generators, usage reports, performance analysis, and utility services.
- `knowledge.py`: Knowledge Expert text/PDF/DOCX parsing, source traceability, storage, retrieval, chat, coverage reports, structural and pgvector similarity Knowledge Map data, traces, and migration.
- `store.py`: Postgres-backed JSON store.
- `sticky_notes.py`: encrypted sticky-note persistence, domain validation, and revision checks.
- `two_factor.py`: single-installation TOTP enrollment, encrypted security state, recovery codes, replay prevention, and persistent attempt limits.
- `config.py`: environment-backed settings.

## myDATA Purchases

The `mydata-invoices` tool uses `frontend-react/src/mydata/` and `backend_py/optimus_api/mydata/`. A session-only router is registered in `main.py`; the repository uses dedicated tables, explicit transactions, revision checks and private encrypted original files. A separate durable worker performs read-only AADE RequestDocs period refreshes using fixed private configuration slots and exact AADE hosts/routes. Remote evidence, matching and editable drafts remain separate; source changes invalidate review. There are no tax submission jobs or upstream write methods. A durable extraction worker processes local PDF/OCR work in credential-free subprocesses; optional text-only Anthropic assistance requires per-job consent. Recognised public QR references can be resolved by a credential-free, allowlisted provider client with pinned DNS/TLS and secure XML parsing. AADE/receipt QR verification links are recognised without claiming authenticated import. Suggestions are applied separately under revision checks. An offline classification catalogue derives dropdowns from pinned official combinations/schema/labels; category/E3 selections are checked in the domain service while existing typed notes remain reviewable. See [myDATA Purchases](tools/mydata-invoices.md).

## Persistence

General app data is stored in Postgres `app_data` as JSONB documents. Knowledge Expert uses dedicated tables for entries, uploads, retained source chunks, conversations, and turns. Entries store source-chunk IDs so derived Q&A remains traceable to the uploaded content.

Older JSON files under `data/` can be migrated into Postgres by the store/repository code. `data/*.json` is ignored by Git and should be treated as local user data.

## Outputs

Generated user files live in `Outputs/`. Examples include:

- Notelog PDF exports.
- Demo Builder HTML files.
- Presentation Suite HTML files.
- Base64 iframe text files.
- Combined PDFs.
- CSV conversion outputs.

`Outputs/` is ignored by Git except for `.gitkeep`.
