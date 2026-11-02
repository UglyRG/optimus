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

## myDATA local extraction

Install current backend dependencies with `backend_py/.venv/bin/python -m pip install -e ./backend_py`. PDF text extraction works without OCR. Scans and receipt images require Tesseract plus Greek (`ell`) and English (`eng`) language data; see [OCR setup](tools/mydata-invoices.md#ocr-setup). Start the backend normally; its extraction worker uses durable Postgres jobs. No separate worker command or model key is required for local extraction.

QR extraction additionally uses the declared `zxing-cpp` and `defusedxml` dependencies. Reinstall the backend package after updating source. Provider QR tests mock all network responses; the explicit local test database remains separate from user records. Live source verification is performed separately using a supplied document and never runs as part of the test suite.

## myDATA read-only intake

The normal backend starts the extraction worker and a separate durable AADE read worker. No extra service is needed. Configure optional connection slots in private `.env`, restart, then save the slot/access type in each company profile. No AADE traffic occurs until **Test connection** or **Sync from AADE** is explicitly used. See [connection setup](configuration.md#read-only-aade-connections). Intake tests mock every upstream read; integration tests require `MYDATA_TEST_DATABASE_URL` pointing to an isolated disposable database. Tests create/drop their own schemas and never use production as a test environment.
