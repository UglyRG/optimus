# Deployment

Production deployment is handled by `scripts/deploy-prod.sh`.

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
5. Runs `npm ci`.
6. Builds the React frontend.
7. Installs the backend package into the backend virtual environment.
8. Restarts the `optimus` systemd service.
9. Verifies that the service is active.

## Production Assumptions

- A systemd service named `optimus` exists.
- `backend_py/.venv` exists on the server.
- Postgres and pgvector are available.
- Production `.env` values are already present on the server.
