#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON_SIMILARITY_DIR="$PROJECT_ROOT/python-similarity"

PYTHON_EXE=""
for candidate in \
  "$PROJECT_ROOT/.venv/bin/python" \
  "$PYTHON_SIMILARITY_DIR/.venv/bin/python"; do
  if [ -x "$candidate" ]; then
    PYTHON_EXE="$candidate"
    break
  fi
done

if [ -z "$PYTHON_EXE" ]; then
  PYTHON_EXE=$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)
fi

if [ -z "$PYTHON_EXE" ]; then
  echo "[dev:python] Error: Python not found." >&2
  exit 1
fi

echo "[dev:python] using Python: $PYTHON_EXE"
cd "$PYTHON_SIMILARITY_DIR"
exec "$PYTHON_EXE" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
