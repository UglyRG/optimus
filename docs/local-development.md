# Local Development

## Requirements

- Node.js with npm.
- Python 3.10 or newer.
- Postgres with the `vector` extension available.

## Database Setup

```bash
psql -d postgres -c "CREATE ROLE optimus WITH LOGIN PASSWORD 'optimus';"
psql -d postgres -c "CREATE DATABASE optimus OWNER optimus;"
psql -d optimus -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql -d optimus -f backend_py/sql/001_init.sql
```

The default backend connection string is:

```text
postgresql://optimus:optimus@localhost:5432/optimus
```

If local Postgres uses peer or trust auth instead of passwords, either set a password for the `optimus` role or override `DATABASE_URL` in `.env`.

## Backend Environment

```bash
cd backend_py
python -m venv .venv
source .venv/bin/activate
pip install -e .
```

Optional development dependencies:

```bash
pip install -e ".[dev]"
```

## Running the App

Run both services in one terminal:

```bash
npm run dev
```

Run services separately:

```bash
npm run backend
npm run frontend:react
```

Service URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8788`
- API docs: `http://localhost:8788/docs`
- OpenAPI JSON: `http://localhost:8788/openapi.json`

## Build Check

```bash
npm run build:react
```

Use this after frontend changes when practical.
