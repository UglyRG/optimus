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

## Backend

The active backend lives in `backend_py/optimus_api/`.

Important modules:

- `main.py`: FastAPI app, routes, auth, backup/restore orchestration.
- `catalog.py`: hosted tools and default catalog layout.
- `domain.py`: normalization and validation for persisted tool data.
- `tools.py`: file generators, usage reports, performance analysis, and utility services.
- `knowledge.py`: Knowledge Expert text/PDF/DOCX parsing, source traceability, storage, retrieval, chat, coverage reports, structural and pgvector similarity Knowledge Map data, traces, and migration.
- `store.py`: Postgres-backed JSON store.
- `config.py`: environment-backed settings.

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
