# Database

Optimus uses native Postgres with pgvector.

## Schema

The initial schema is in `backend_py/sql/001_init.sql`.

It creates:

- `app_data`: JSONB key/value store for general app data.
- `knowledge_entries`: Knowledge Expert source entries and optional embeddings.
- `knowledge_uploads`: uploaded knowledge file metadata.
- `knowledge_source_chunks`: retained source blocks or structured rows used to derive entries.
- `knowledge_conversations`: Knowledge Expert chat conversations.
- `knowledge_turns`: Knowledge Expert turns, citations, traces, feedback, and optional message embeddings.

## myDATA intake tables

`backend_py/sql/002_mydata.sql` is applied idempotently during backend startup. It creates `mydata_companies`, `mydata_documents`, `mydata_invoices`, `mydata_audit_events` `mydata_extractions`, `mydata_remote_records` and `mydata_sync_jobs`. Extraction jobs hold saved invoice/company revision references, provider/consent metadata and page/field evidence, QR references, provider XML/checksums and conflicts; a partial unique index prevents concurrent active extraction for one purchase. Companies and drafts store revisioned JSONB facts; document metadata references private encrypted files. Foreign keys enforce company/document consistency. A module advisory transaction lock serializes mutations and backup/restore; edits require the current revision. Amounts and MARKs remain strings in snapshots. See [tool details](tools/mydata-invoices.md).

Read-only remote records are unique by company/environment/MARK, optionally linked by a company-consistent foreign key to a purchase. A partial index permits one linked remote record per invoice/environment. Parsed facts/classifications remain JSONB; original remote XML is encrypted with the module key. Durable sync jobs retain revision-bound company configuration aliases (never credentials), month/page checkpoints and encrypted full read responses. One active sync per company is enforced by a partial unique index. Evidence updates and cursor advancement commit in the same transaction. Remote changes clear the linked draft review/revision without overwriting its editable facts. Snapshots include both tables; older snapshots default them to empty and restored pending jobs are cancelled.

Classification choices remain in existing draft JSONB: optional document type, document/line VAT classification code and server-generated catalogue/check metadata. No new table is needed. Catalogue source files ship with the app; backups retain chosen values and catalogue version. Old snapshots default absent fields during normalization. Existing typed notes are retained for reviewer correction rather than rewritten during startup.

## app_data Keys

The backend currently uses these logical stores:

- `tool_catalog`
- `padelog_matches`
- `betlog_bets`
- `notelog_notes`
- `sticky_notes`: versioned encrypted notes envelope; see [Sticky Notes](tools/sticky-notes.md)
- `auth_security`: encrypted TOTP secret, pending enrollment, hashed recovery codes, replay counter, and authentication attempt limits; excluded from tool backup/restore. See [Two-factor authentication](operations/two-factor-authentication.md).
- `performance_insights`
- `knowledge_expert`
- `web_audit_history`

Some legacy JSON files can be imported into these stores when first read.

`web_audit_history` stores all successful SEO and GEO audit inputs, complete scored results, timestamps, and creator names as one JSONB document. It does not store fetched raw HTML. Individual saved audits can be deleted from their tool page.

## pgvector

`knowledge_entries.source_chunk_ids` links each derived Q&A to its retained source material. Text-like files retain content blocks with headings and character offsets; CSV and JSON retain row/entry locators; PDF chunks retain page numbers; DOCX chunks retain paragraph and table-row locators.

`knowledge_entries.embedding` and `knowledge_turns.user_message_embedding` use `vector(1536)`, matching the default `text-embedding-3-small` embedding size.

HNSW cosine indexes are created for vector search.

## Migration Notes

There is no full migration framework yet. Schema changes should be made carefully:

- Update `backend_py/sql/001_init.sql`.
- Keep `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` statements idempotent.
- Add compatibility code when persisted JSON shapes change.
- Update backup/restore docs and behavior if data contracts change.
