# Tool Catalog

The backend exposes the tool catalog at:

```text
GET /api/tools
```

The frontend dashboard renders tools from this metadata.

## Hosted Tools

Hosted tool definitions live in `backend_py/optimus_api/catalog.py`.

Each hosted tool has a stable `id`, `title`, and `description`. The `id` is important because it connects:

- backend catalog metadata
- frontend routes
- frontend tool UI mapping
- persisted admin layout
- documentation

Avoid renaming tool IDs unless there is an explicit migration plan.

## Admin Layout

The Manage Tools dashboard lets the user control:

- groups
- display order
- enabled/disabled state

The layout is persisted in Postgres through the `tool_catalog` app data key.

## Adding a Tool

When adding a new hosted tool:

1. Add it to `HOSTED_TOOLS`.
2. Add its default placement to `DEFAULT_TOOL_CATALOG_CONFIG`.
3. Add the frontend route and UI.
4. Add backend endpoints or services if needed.
5. Include it in backup/restore if it persists data.
6. Add or update docs under `docs/tools/`.
