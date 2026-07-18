#!/bin/bash
# Builds the chat-only lite variant, then runs its verification suite
# (test/lite.spec.js) with ANTHROPIC_API_KEY loaded from the donna-backend
# environment WITHOUT printing it. Local dev only — never commit keys, never
# echo env here. Mirrors scripts/run-e2e.sh but sets LEXI_LITE=1 so
# playwright.config.js discovers ONLY the lite spec.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND=/Users/harshitgarg/Documents/Lexi/Code.nosync/donna-backend

# 1. Stage + zip the lite build so the suite loads the exact shipped bytes.
node "$REPO/scripts/build-lite.mjs"

# 2. Load the key (never printed) and run the lite suite.
export ANTHROPIC_API_KEY="$(cd "$BACKEND" && venv/bin/python -c 'from core.config import ANTHROPIC_API_KEY; import sys; sys.stdout.write(ANTHROPIC_API_KEY or "")' 2>/dev/null)"
if [ -z "${ANTHROPIC_API_KEY}" ]; then
  echo "ERROR: could not load ANTHROPIC_API_KEY from backend config" >&2
  exit 1
fi
echo "API key loaded (len=${#ANTHROPIC_API_KEY})"
cd "$REPO"
LEXI_LITE=1 exec npx playwright test "$@"
