#!/bin/bash
# Runs the Playwright e2e suite with ANTHROPIC_API_KEY loaded from the
# donna-backend environment WITHOUT printing it. Local dev only — never commit
# keys, never echo env here.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND=/Users/harshitgarg/Documents/Lexi/Code.nosync/donna-backend

export ANTHROPIC_API_KEY="$(cd "$BACKEND" && venv/bin/python -c 'from core.config import ANTHROPIC_API_KEY; import sys; sys.stdout.write(ANTHROPIC_API_KEY or "")' 2>/dev/null)"
if [ -z "${ANTHROPIC_API_KEY}" ]; then
  echo "ERROR: could not load ANTHROPIC_API_KEY from backend config" >&2
  exit 1
fi
echo "API key loaded (len=${#ANTHROPIC_API_KEY})"
cd "$REPO"
exec npx playwright test "$@"
