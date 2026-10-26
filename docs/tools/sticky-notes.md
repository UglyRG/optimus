# Sticky Notes

Sticky Notes stores plain-text cards separately from handwritten Notelog notes. Open the tool from the catalog, or edit pinned cards directly on the homepage.

## Editing

- Add notes from either view. New notes appear on the homepage by default.
- Click a card's text to edit; line breaks are preserved. HTML is displayed as text.
- Changes autosave after 600 ms of inactivity and when the text field loses focus. The save queue stays active when navigating within Optimus.
- Choose yellow, pink, blue, green, or orange; choose a small or large card.
- Use the arrow buttons to reorder notes. Uncheck Home to hide a card from the homepage; it remains available in the tool.
- Delete removes a note after confirmation. Recovery requires a prior backup.
- Limits: 500 notes, 20,000 characters per note.

On wide screens, the board appears beside the tool catalog. At widths of 1350 px or less, it appears below the catalog. Disabling Sticky Notes in Manage Tools hides the homepage board without deleting notes.

Save errors preserve the local draft. Retry save handles temporary failures. If another tab changed or deleted the note, copy any local text you want to keep and use Discard edits / reload before editing again. Refresh reloads the board only when no unsaved edits remain. Browser reload/close and logout warn or stop while changes are unsaved. Drafts are kept in browser memory, not local storage; a crash or forced close can lose unsaved edits.

## Encrypted persistence

The Postgres `app_data` key `sticky_notes` contains a versioned AES-256-GCM envelope. The entire notes document, including content, IDs, revisions, colors, order, visibility, and timestamps, is encrypted. The envelope exposes an algorithm, version, key identifier, nonce, and ciphertext. Each write uses a fresh random 12-byte nonce and authenticates the tool/format identifier.

A random 32-byte key is created on the first note save at:

```text
data/.sticky-notes.key
```

The file is created with owner-only permissions (`0600`) and excluded from Git. All backend workers must use the same key and database. Do not change the key file to rotate it: existing notes and old backups require their original key. There is no automated key rotation or password recovery in this version.

If the key is missing, malformed, or incorrect, existing notes cannot be read or overwritten. Restore the original key file, then refresh. The application never regenerates a missing key when an encrypted notes document already exists.

Application-level encryption protects database copies and the notes backup entry. The running backend decrypts notes for authenticated browser sessions; this is not end-to-end encryption. Access to both the key file and database permits decryption. Production deployments should also protect transport and the host filesystem. Note responses use `Cache-Control: no-store`.

Writes serialize through a Postgres transaction/advisory lock and compare per-note revisions. Restore generates new revisions to prevent open tabs from overwriting restored notes silently.

## Backup and recovery

The Manage Tools ZIP includes `data/sticky-notes.json` when an encrypted notes document exists. This entry contains ciphertext, including card settings. Other tool entries retain their existing plaintext format; the ZIP as a whole is not encrypted.

**Back up `data/.sticky-notes.key` separately in secure storage.** The application backup excludes the key and private configuration. Losing the original key makes its notes and backups unrecoverable.

To restore on another installation:

1. Install the original key at `data/.sticky-notes.key` with owner-only permissions before restoring the ZIP.
2. Restore from Manage Tools. Notes are authenticated and validated before any tool data is replaced. An incorrect key or corrupted notes entry rejects the restore.
3. Refresh the notes board to load the restored cards. Resolve or discard any local unsaved drafts first.

Do not overwrite a target installation's key if it already has notes encrypted with a different key. Back up its database/archive and its key separately first; there is no built-in merge or cross-key import.

Older ZIPs without a sticky-notes entry preserve current sticky notes. A backup containing an encrypted empty notes list clears current notes when restored. Before the first save, no notes entry or key is created.
