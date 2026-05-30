#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/argyris/Optimus}"
BRANCH="${BRANCH:-main}"

cd "$APP_DIR"

git fetch --tags origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

npm ci
npm run build:react

backend_py/.venv/bin/pip install -e backend_py

sudo systemctl restart optimus
sudo systemctl is-active --quiet optimus
