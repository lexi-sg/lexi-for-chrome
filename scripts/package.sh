#!/bin/bash
# Build the Chrome Web Store upload ZIP: production extension files only.
# Output: dist/lexi-for-chrome-<version>.zip
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT_DIR="$REPO/dist"
STAGE="$(mktemp -d)/lexi-for-chrome"
mkdir -p "$STAGE" "$OUT_DIR"

# Production surface only — no tests, docs, research, assets pipeline, node_modules.
cp manifest.json "$STAGE/"
cp -R icons "$STAGE/icons"
cp -R src "$STAGE/src"

# The store build must talk to prod (api.getlexi.io). The source keeps
# BUILD_CHANNEL='staging' so an unpacked dev build hits staging out of the box;
# rewrite the STAGED copy only. Override with CHANNEL=staging for a staging ZIP.
CHANNEL="${CHANNEL:-prod}"
python3 - "$STAGE/src/config.js" "$CHANNEL" <<'EOF'
import re, sys
path, channel = sys.argv[1], sys.argv[2]
src = open(path).read()
new, n = re.subn(r"export const BUILD_CHANNEL = '[^']*';",
                 f"export const BUILD_CHANNEL = '{channel}';", src)
assert n == 1, f"expected exactly one BUILD_CHANNEL assignment, found {n}"
open(path, 'w').write(new)
print(f"staged build channel: {channel}")
EOF

# Sanity: manifest must be valid JSON and every referenced file must exist.
python3 - "$STAGE" <<'EOF'
import json, os, sys
stage = sys.argv[1]
m = json.load(open(os.path.join(stage, 'manifest.json')))
refs = []
refs += list(m.get('icons', {}).values())
a = m.get('action', {})
refs += [a.get('default_popup')] if a.get('default_popup') else []
refs += list(a.get('default_icon', {}).values()) if isinstance(a.get('default_icon'), dict) else []
if 'background' in m: refs.append(m['background'].get('service_worker'))
if 'side_panel' in m: refs.append(m['side_panel'].get('default_path'))
if 'options_page' in m: refs.append(m['options_page'])
if m.get('options_ui', {}).get('page'): refs.append(m['options_ui']['page'])
missing = [r for r in refs if r and not os.path.exists(os.path.join(stage, r))]
assert not missing, f"manifest references missing files: {missing}"
print(f"manifest v{m['manifest_version']} '{m['name']}' {m['version']}: all {len([r for r in refs if r])} referenced paths present")
EOF

# CWS requires manifest.json at the ZIP root — zip the staged CONTENTS.
ZIP="$OUT_DIR/lexi-for-chrome-$VERSION.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qr "$ZIP" . -x '*.DS_Store')
rm -rf "$(dirname "$STAGE")"
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
unzip -l "$ZIP" | tail -3
