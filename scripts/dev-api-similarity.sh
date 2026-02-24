#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HEALTH_URL="http://127.0.0.1:8000/health"
MAX_ATTEMPTS=120

echo "[dev:api:similarity] waiting for Python similarity API: $HEALTH_URL"

for i in $(seq 1 $MAX_ATTEMPTS); do
  if curl -sf --max-time 2 "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[dev:api:similarity] similarity API is ready."
    break
  fi
  if [ "$i" -eq "$MAX_ATTEMPTS" ]; then
    echo "[dev:api:similarity] Error: Similarity API not ready." >&2
    exit 1
  fi
  sleep 1
done

cd "$PROJECT_ROOT"
export SIMILARITY_API_BASE_URL="http://127.0.0.1:8000"
exec pnpm --filter @gov-sync/api dev
