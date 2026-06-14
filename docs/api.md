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

Knowledge Expert uploads use:

```text
POST /api/tools/knowledge-expert/upload
```

The JSON body accepts `mode` (`append` or `replace`) and between 1 and 20 Base64-encoded files. Supported extensions are CSV, JSON, HTML, TXT, Markdown, PDF, and DOCX. The response includes added entry and source-chunk counts.

Knowledge Expert source analysis is available at:

```text
GET /api/tools/knowledge-expert/admin/reports/source-coverage
```

The response includes aggregate traceability, lexical coverage, answer-support metrics, per-document coverage, uncovered or partially covered chunks, low-support entries, and scoring limitations.

The structural Knowledge Map is available at:

```text
GET /api/tools/knowledge-expert/knowledge-map
```

The response contains bounded document, source-chunk, and Q&A nodes; structural edges; coverage status; retrieval/citation counts; graph totals; and a truncation flag for large datasets.
