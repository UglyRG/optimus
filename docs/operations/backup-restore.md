# Backup and Restore

Backup and restore are available from the Manage Tools dashboard.

## Backup

Backup downloads a zip containing JSON exports for:

- `tool-catalog`
- `padelog-matches`
- `betlog-bets`
- `notelog-notes`
- `sticky-notes`, when initialized: encrypted note text and card settings
- `performance-insights`
- `web-audit-history`, including complete saved SEO and GEO results
- Knowledge Expert snapshot generated from the database, including retained source chunks and entry-to-source links

Generated files in `Outputs/` are not included.

Private `.env` values are not included.

## Restore

Restore accepts the backup zip and replaces local persisted Optimus data for:

- tool layout
- Padelog
- Betlog
- Notelog
- Sticky Notes, when the archive contains its encrypted entry
- saved AI insight data
- saved SEO and GEO audit history
- Knowledge Expert snapshot data

Use restore carefully because it replaces current local data for the included stores.

## Documentation Rule

When adding persisted data for a new tool, update:

- backup creation
- restore behavior
- this document
- the tool's documentation page

## Encrypted Sticky Notes

The sticky-notes entry remains encrypted in the ZIP. The other JSON entries remain plaintext; this does not encrypt the whole backup. The notes encryption key at `data/.sticky-notes.key` is **not included**. Back it up separately in secure storage and install the original key before restoring on another installation. Lost keys cannot be recovered.

Restore authenticates and validates encrypted notes before replacing any tool data. An incorrect/missing key or corrupt notes entry rejects the restore. Older archives without notes preserve current sticky notes. An encrypted empty list replaces current notes with an empty board. Refresh the notes board after restoration; restored revisions invalidate stale edits from open tabs.

See [Sticky Notes recovery](../tools/sticky-notes.md) before moving backups between installations with different keys.
