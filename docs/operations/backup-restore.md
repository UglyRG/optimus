# Backup and Restore

Backup and restore are available from the Manage Tools dashboard.

## Backup

Backup downloads a zip containing JSON exports for:

- `tool-catalog`
- `padelog-matches`
- `betlog-bets`
- `notelog-notes`
- `performance-insights`
- Knowledge Expert snapshot generated from the database, including retained source chunks and entry-to-source links

Generated files in `Outputs/` are not included.

Private `.env` values are not included.

## Restore

Restore accepts the backup zip and replaces local persisted Optimus data for:

- tool layout
- Padelog
- Betlog
- Notelog
- saved AI insight data
- Knowledge Expert snapshot data

Use restore carefully because it replaces current local data for the included stores.

## Documentation Rule

When adding persisted data for a new tool, update:

- backup creation
- restore behavior
- this document
- the tool's documentation page
