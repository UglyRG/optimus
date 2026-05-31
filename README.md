# Optimus

Version: `v6`

Optimus is a local productivity platform made of a React frontend, a FastAPI backend, and Postgres/pgvector persistence. It hosts a growing catalog of tools for personal tracking, knowledge work, demos, document utilities, and AI usage reporting.

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
- [Backup and Restore](docs/operations/backup-restore.md)
- [Deployment](docs/operations/deployment.md)
- [Troubleshooting](docs/operations/troubleshooting.md)

Agent/project guidance lives in [AGENTS.md](AGENTS.md). Update it when the engineering or documentation principles change.

## Current Tools

- Padelog
- Betlog
- Notelog
- Knowledge Expert
- Demo Builder
- Presentation Suite Builder
- HTML to iframe Base64
- PDF to iframe Base64
- Combine PDFs
- CSV to JSON Rows
- CSV Q&A to Markdown
- Check My Token Usage

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
