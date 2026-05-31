# Agent Guidance for Optimus

This file gives coding agents project-specific instructions. Keep it short, current, and practical.

## Product Shape

Optimus is a local-first tool platform:

- React frontend in `frontend-react/`.
- FastAPI backend in `backend_py/optimus_api/`.
- Postgres persistence with JSONB app data and pgvector-backed Knowledge Expert tables.
- Generated user files in `Outputs/`.

Treat `Outputs/` and `data/*.json` as user/generated data unless the user explicitly asks to inspect or modify them. Do not treat generated files as source documentation.

## Engineering Principles

- Prefer existing patterns in `frontend-react/src/main.jsx` and `backend_py/optimus_api/` before adding new abstractions.
- Keep hosted tool IDs stable. They connect the backend catalog, frontend routing, persisted layout, and documentation.
- Put backend validation and normalization in domain/service modules, not only in the UI.
- Preserve local-first behavior. Features should work gracefully when optional provider keys are missing.
- Keep backup/restore compatibility in mind whenever changing persisted shapes.
- Avoid unrelated refactors while making feature changes.

## Documentation Principles

- Update docs in the same change that alters behavior, setup, API contracts, persistence, or operations.
- Keep `README.md` as the front door: quick start, project map, links.
- Put deeper material in `docs/`:
  - `docs/local-development.md` for setup and commands.
  - `docs/architecture.md` for system structure.
  - `docs/configuration.md` for environment variables.
  - `docs/database.md` for persistence and schema.
  - `docs/api.md` for API contracts.
  - `docs/tools/` for tool behavior.
  - `docs/operations/` for backup, deployment, and troubleshooting.
- For each new hosted tool, update:
  - `backend_py/optimus_api/catalog.py`
  - the frontend tool route/UI
  - any backend endpoints/services
  - backup/restore docs if it persists data
  - the matching page under `docs/tools/`
- Keep docs factual and operational. Avoid marketing copy.

## Local Commands

```bash
npm run dev
npm run backend
npm run frontend:react
npm run build:react
```

Backend setup lives in `docs/local-development.md`.

## API and Persistence

- FastAPI docs are available at `http://localhost:8788/docs` while the backend is running.
- Public API endpoints use `OPTIMUS_PUBLIC_API_KEY`, then `OPTIMUS_API_KEY`, then `OPTIMUS_ACCESS_KEY` as fallback.
- Browser-authenticated endpoints use the `optimus_session` cookie.
- `app_data` stores general JSON documents.
- Knowledge Expert uses dedicated relational/vector tables.

## Before Finishing Work

- Run focused validation when practical.
- For frontend changes, run `npm run build:react` when practical.
- Mention any validation that could not be run.
- Do not revert user changes in generated data files.
