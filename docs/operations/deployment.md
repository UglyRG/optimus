# Deployment

Production deployment is handled by `scripts/deploy-prod.sh`. The GitHub Actions workflow runs for pushes to `main` and for version tags matching `v*`.

## Defaults

```bash
APP_DIR=/home/argyris/Optimus
BRANCH=main
```

Both can be overridden with environment variables.

## Script Flow

The deployment script:

1. Changes into `APP_DIR`.
2. Fetches the target branch and synchronizes release tags with origin, accepting corrected tags in this deployment checkout.
3. Checks out the branch.
4. Pulls with `--ff-only`.
5. Resolves the latest Git release tag, falling back to the short commit SHA when no tag exists, and writes it to `.optimus-version`.
6. Runs `npm ci`.
7. Builds the React frontend.
8. Installs the backend package into the backend virtual environment.
9. Restarts the `optimus` systemd service.
10. Verifies that the service is active.

The backend reads `.optimus-version` before runtime environment overrides or fallbacks. This keeps `/api/version` aligned with the latest fetched release tag even when the systemd process cannot access Git metadata. Pushing a new `v*` tag triggers deployment again, so the displayed version updates without editing application source files.

## Production Assumptions

- A systemd service named `optimus` exists.
- `backend_py/.venv` exists on the server.
- Postgres and pgvector are available.
- Production `.env` values are already present on the server.

## Sticky Notes encryption key

Deployment installs the `cryptography` dependency automatically. On the first note save, a fresh production installation creates a random key at `data/.sticky-notes.key` with owner-only permissions (`0600`). With the default `APP_DIR`, this is `/home/argyris/Optimus/data/.sticky-notes.key`. If `DATA_DIR` is configured, the key lives in that directory instead. The backend service account needs permission to create and read the file.

The deployment script updates the existing checkout without clearing `data/`, so normal redeployments preserve the key. The key is ignored by Git and excluded from application backup ZIPs. Preserve it on persistent storage if changing to containers or replacing the server, and back it up separately in secure storage.

Before restoring local notes on production, securely install their original key with owner-only permissions, then restore the archive. A separately generated production key cannot decrypt local notes. If production already has notes under a different key, preserve its archive/database and original key before replacing either; cross-key merging is not supported.

If encrypted notes exist but the key is missing or incorrect, the app locks the notes and refuses to overwrite them. It does not generate a replacement key. See [Sticky Notes](../tools/sticky-notes.md) and [Backup and Restore](backup-restore.md).

## v8 myDATA rollout

Deployment installs the new Python PDF/QR/XML dependencies and applies `002_mydata.sql` idempotently during startup. The normal backend starts both local extraction and AADE read workers; no separate worker service is needed. The bundled classification catalogue and public source workbook ship with the backend package.

Keep existing `data/` and the installation's `data/.mydata.key` on persistent storage. Configure optional AADE production/sandbox slots only in the server's private `.env`, then restart. Local credentials and company/original data are never deployed from Git. Moving module data from another installation requires its original encryption key and encrypted backup; reconfigure credentials separately.

Local extraction works without provider keys. For scanned originals install Tesseract with `ell` and `eng`; missing OCR leaves PDF text/QR extraction and manual review available. See [configuration](../configuration.md) and [myDATA operations](../tools/mydata-invoices.md). A deployed read connector makes no AADE requests until a reviewer starts Test connection or Sync from AADE. v8 exposes no tax-submission or AADE cancellation endpoint.
