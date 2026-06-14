# Overview

Optimus is a local productivity platform that hosts a growing catalog of small, focused tools. It is designed to run locally, keep data under the user's control, and use external AI providers only when a tool needs them.

## Services

- React frontend: the application shell, dashboard, hosted tool screens, admin UI, and client-side utilities.
- FastAPI backend: authentication, tool APIs, file generation, backup/restore, AI-provider calls, and persistence.
- Postgres: stores app data, Knowledge Expert source chunks, knowledge entries, conversations, vector embeddings, and metadata.
- Outputs folder: stores generated files such as PDFs, HTML exports, and Base64 iframe source files.

## Main Capabilities

- Tool catalog dashboard with admin-managed groups, visibility, and display order.
- Personal tracking tools: Padelog, Betlog, and Notelog.
- Knowledge Expert: upload structured files or prose documents, including PDF and DOCX, retain source provenance, visualize the knowledge structure, measure lexical coverage, and ask grounded questions with citations.
- Builder tools: Demo Builder and Presentation Suite Builder.
- Utility tools: Base64 iframe conversion, PDF combination, CSV conversion, and AI token usage reporting.
- Backup and restore for persisted Optimus data.

## Documentation Model

`README.md` is intentionally short. It should help someone start the app and find the correct deeper document.

Use `docs/` for durable project knowledge:

- Setup and local workflow.
- Architecture and persistence.
- API contracts.
- Tool behavior.
- Operations and troubleshooting.

Generated markdown in `Outputs/` is user output, not project documentation.
