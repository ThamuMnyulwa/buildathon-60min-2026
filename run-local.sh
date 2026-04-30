#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
BACKEND_URL="${BACKEND_URL:-http://localhost:${BACKEND_PORT}}"

if [[ -f "${ROOT_DIR}/backend/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "${ROOT_DIR}/backend/.env"
  set +a
fi

cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]]; then
    kill "${BACKEND_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "Starting Sentinel Health backend on ${BACKEND_URL}"
(
  cd "${ROOT_DIR}/backend"
  uv run uvicorn main:app --host 0.0.0.0 --port "${BACKEND_PORT}" --reload
) &
BACKEND_PID=$!

sleep 2

echo "Starting Sentinel Health frontend on http://localhost:${FRONTEND_PORT}"
(
  cd "${ROOT_DIR}/frontend"
  if [[ ! -d node_modules ]]; then
    npm install
  fi
  VITE_BACKEND_URL="${BACKEND_URL}" npm run dev -- --port "${FRONTEND_PORT}"
)
