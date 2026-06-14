# Troubleshooting

## Backend Cannot Connect to Postgres

Check that Postgres is running and that the role/database exist:

```bash
psql -d postgres -c "CREATE ROLE optimus WITH LOGIN PASSWORD 'optimus';"
psql -d postgres -c "CREATE DATABASE optimus OWNER optimus;"
```

If the role or database already exists, those commands may fail harmlessly. Confirm `DATABASE_URL` matches local auth settings.

## Missing pgvector

Run:

```bash
psql -d optimus -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

If this fails, install pgvector for the local Postgres version.

## Login Fails Locally

If no `OPTIMUS_ACCESS_KEY` is set, the development key is:

```text
optimus
```

## Provider-Backed Tools Fail

Some tools need external provider keys:

- Padelog and Betlog AI insights need `ANTHROPIC_API_KEY`.
- Knowledge Expert embeddings need `OPENAI_API_KEY`.
- Knowledge Expert answers need `ANTHROPIC_API_KEY`.
- Token usage reports need `OPENAI_ADMIN_KEY` or `ANTHROPIC_ADMIN_KEY`.

## Knowledge Document Extraction Fails

- Password-protected PDFs are not supported.
- Scanned or image-only PDFs need OCR before upload.
- DOCX files must contain a valid `word/document.xml` document body.
- Re-upload older Knowledge Expert documents to generate source chunks and coverage metrics.

## Generated Output Is Missing

Generated files are written under `Outputs/`. This folder is ignored by Git except for `.gitkeep`.

Backup and restore do not include generated output files.
