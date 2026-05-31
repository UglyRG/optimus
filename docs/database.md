# Database

Optimus uses native Postgres with pgvector.

## Schema

The initial schema is in `backend_py/sql/001_init.sql`.

It creates:

- `app_data`: JSONB key/value store for general app data.
- `knowledge_entries`: Knowledge Expert source entries and optional embeddings.
- `knowledge_uploads`: uploaded knowledge file metadata.
- `knowledge_conversations`: Knowledge Expert chat conversations.
- `knowledge_turns`: Knowledge Expert turns, citations, traces, feedback, and optional message embeddings.

## app_data Keys

The backend currently uses these logical stores:

- `tool_catalog`
- `padelog_matches`
- `betlog_bets`
- `notelog_notes`
- `performance_insights`
- `knowledge_expert`

Some legacy JSON files can be imported into these stores when first read.

## pgvector

`knowledge_entries.embedding` and `knowledge_turns.user_message_embedding` use `vector(1536)`, matching the default `text-embedding-3-small` embedding size.

HNSW cosine indexes are created for vector search.

## Migration Notes

There is no full migration framework yet. Schema changes should be made carefully:

- Update `backend_py/sql/001_init.sql`.
- Keep `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements idempotent.
- Add compatibility code when persisted JSON shapes change.
- Update backup/restore docs and behavior if data contracts change.
