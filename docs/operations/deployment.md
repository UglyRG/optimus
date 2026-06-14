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
2. Fetches tags from the target branch.
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
