# Optimus

Version: `v8`

Optimus is a local productivity platform made of a React frontend, a FastAPI backend, and Postgres/pgvector persistence. It hosts a growing catalog of tools for personal tracking, knowledge work, demos, document utilities, and AI usage reporting.

## v8

- Adds myDATA Purchases for monthly review and historical intake across three companies, with optional accountant involvement.
- Imports incoming AADE records read-only, with matching, classification/cancellation evidence and editable drafts.
- Includes local PDF/OCR extraction, QR-assisted provider lookup, optional AI suggestions, official classification dropdowns and deletion of local uploads.
- Keeps originals private and supports encrypted backup/restore. Tax submissions remain disabled.

See [v8 release notes](docs/releases/v8.md), [myDATA workflow](docs/tools/mydata-invoices.md) and [connection setup](docs/configuration.md#read-only-aade-connections).

## Quick Start

```bash
npm run dev
```

This starts both local services:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:8788`
- API docs: `http://localhost:8788/docs`

You can also run them separately:

```bash
npm run backend
npm run frontend:react
```

The `optimus` command is installed in `~/.local/bin` and can be run from anywhere. It switches to this project directory and runs `npm run dev`.

## Project Map

- `frontend-react/`: React frontend and all hosted tool UIs.
- `backend_py/optimus_api/`: FastAPI backend, domain logic, persistence, and tool services.
- `backend_py/sql/001_init.sql`: Postgres and Knowledge Expert schema.
- `backend_py/sql/002_mydata.sql`: myDATA companies, drafts, extraction, remote evidence and read jobs.
- `scripts/dev.js`: local multi-service runner.
- `scripts/deploy-prod.sh`: production deployment helper.
- `Outputs/`: generated user files. These are not source documentation.
- `docs/`: project documentation.

## Documentation

Start here:

- [Overview](docs/overview.md)
- [Local Development](docs/local-development.md)
- [Architecture](docs/architecture.md)
- [Configuration](docs/configuration.md)
- [Database](docs/database.md)
- [API](docs/api.md)
- [Tool Catalog](docs/tools/tool-catalog.md)
- [SEO Checker](docs/tools/seo-checker.md)
- [GEO Checker](docs/tools/geo-checker.md)
- [Backup and Restore](docs/operations/backup-restore.md)
- [Two-factor Authentication](docs/operations/two-factor-authentication.md)
- [Deployment](docs/operations/deployment.md)
- [Troubleshooting](docs/operations/troubleshooting.md)

Agent/project guidance lives in [AGENTS.md](AGENTS.md). Update it when the engineering or documentation principles change.

## Current Tools

- [myDATA Purchases](docs/tools/mydata-invoices.md): read-only AADE purchase intake, QR-assisted provider lookup and editable PDF/OCR review for three companies; tax submission remains disabled.

- Padelog
- Betlog
- Notelog
- [Sticky Notes](docs/tools/sticky-notes.md): editable homepage text cards with encrypted storage and backup.
- Knowledge Expert
- Demo Builder
- Presentation Suite Builder
- HTML to iframe Base64
- PDF to iframe Base64
- Combine PDFs
- CSV to JSON Rows
- CSV Q&A to Markdown
- FAQPage JSON-LD Generator
- Document to Markdown
- Check My Token Usage
- SEO Checker
- GEO Checker

Tool-specific notes live under [docs/tools/](docs/tools/).

## Private Configuration

Create a local `.env` file for secrets. It is ignored by Git.

```env
OPTIMUS_ACCESS_KEY=your-login-password
OPTIMUS_PUBLIC_API_KEY=your-public-api-key
ANTHROPIC_API_KEY=your-anthropic-api-key
ANTHROPIC_MODEL=your-default-anthropic-model
KNOWLEDGE_EXPERT_CHAT_MODEL=your-knowledge-expert-chat-model
OPENAI_API_KEY=your-openai-api-key
ANTHROPIC_ADMIN_KEY=your-anthropic-admin-api-key
OPENAI_ADMIN_KEY=your-openai-admin-api-key
```

If `OPTIMUS_ACCESS_KEY` is not set, the local development key is `optimus`.
