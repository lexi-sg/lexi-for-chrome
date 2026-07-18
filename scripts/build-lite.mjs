// scripts/build-lite.mjs
//
// Builds the CHAT-ONLY "lite" Chrome Web Store upload ZIP.
//
// The lite variant is the exact same product code as the full build, with two
// deterministic differences applied to a staged copy:
//
//   1. Manifest: the optional_permissions ("debugger", "tabs") and
//      optional_host_permissions ("<all_urls>") are removed entirely. The name,
//      description, and everything else are identical. With no debugger
//      permission ever requestable, the lite build stays in the Chrome Web
//      Store's fast automated-review lane.
//
//   2. src/config.js: the single line `export const AGENT_MODE_AVAILABLE = true;`
//      is rewritten to `= false;`. Every agent-mode entry point in the product
//      (the side-panel Agent tab, the options agent settings, the
//      REQUEST_AGENT_PERMISSION handler) gates on this constant, so the staged
//      copy has no reachable Agent Mode surface at all.
//
// WHY WE DO NOT STRIP THE AGENT-ONLY MODULES
// ------------------------------------------
// It is tempting to also delete cdp-driver.js and the agent-tool branches in
// action-executor.js from the lite stage. We deliberately DON'T:
//   - service-worker.js `import`s both cdp-driver.js and action-executor.js at
//     module-evaluation time, and action-executor.js `import`s cdp-driver.js.
//     Removing either file (without also surgically editing every importer)
//     breaks module resolution and the service worker fails to boot — which
//     would take the whole extension (chat included) down.
//   - The screenshot path that lite genuinely needs (execScreenshot →
//     chrome.tabs.captureVisibleTab in action-executor.js) lives in the SAME
//     module as the agent tool branches, so it can't be cleanly excised.
//   - chrome.debugger is simply `undefined` without the (now-absent) optional
//     "debugger" permission, so cdp-driver.isCdpAvailable() is false and none
//     of the CDP code can run regardless. The flag + the absent permissions
//     already make Agent Mode unreachable; keeping the files inert costs a few
//     KB and keeps the build a pure, low-risk transform of the full source.
// Net: KEEP all modules, rely on the build flag + the trimmed manifest.
//
// No npm dependencies. Uses the system `zip` binary (same as scripts/package.sh)
// to produce a ZIP with manifest.json at the ROOT, as CWS requires.
//
// Usage:  node scripts/build-lite.mjs
// Output: dist/lite-stage/                     (the staged, unpacked lite build)
//         dist/lexi-for-chrome-lite-<version>.zip

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO, 'dist');
const STAGE = path.join(OUT_DIR, 'lite-stage');

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

// ---------------------------------------------------------------------------
// 1. Stage the production surface (manifest.json, icons/, src/) into
//    dist/lite-stage/, mirroring scripts/package.sh's copy set exactly.
// ---------------------------------------------------------------------------
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
for (const entry of ['manifest.json', 'icons', 'src']) {
  fs.cpSync(path.join(REPO, entry), path.join(STAGE, entry), { recursive: true });
}

// ---------------------------------------------------------------------------
// 2a. Manifest: drop the optional permissions entirely. Leave everything else
//     (name, description, permissions, host_permissions, CSP, …) untouched.
// ---------------------------------------------------------------------------
const manifestPath = path.join(STAGE, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
delete manifest.optional_permissions;
delete manifest.optional_host_permissions;
// Prod store build declares BOTH Lexi backend hosts: the runtime channel
// switch means one published ZIP may talk to EITHER api.getlexi.io (prod) or
// staging-api.getlexi.io (the CWS-review login window), flipped server-side, so
// both are needed (api.getlexi.io is also the config control plane).
// api.anthropic.com is dropped (the agent proxy goes through the Lexi backend).
// Also drop the baked "key": the Chrome Web Store assigns the published item's
// ID from its own key, and a mismatched manifest key is rejected on upload.
if ((process.env.CHANNEL || 'prod') === 'prod') {
  manifest.host_permissions = [
    'https://api.getlexi.io/*',
    'https://staging-api.getlexi.io/*',
  ];
  delete manifest.key;
}
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// ---------------------------------------------------------------------------
// 2b. config.js: flip the single build-flag line true → false. Assert the
//     rewrite matched exactly once so a future refactor that renames/moves the
//     flag fails loudly here instead of silently shipping an agent-capable lite
//     build.
// ---------------------------------------------------------------------------
const configPath = path.join(STAGE, 'src', 'config.js');
const configSrc = fs.readFileSync(configPath, 'utf8');
const FLAG_TRUE = 'export const AGENT_MODE_AVAILABLE = true;';
const FLAG_FALSE = 'export const AGENT_MODE_AVAILABLE = false;';
const occurrences = configSrc.split(FLAG_TRUE).length - 1;
if (occurrences !== 1) {
  throw new Error(
    `Expected exactly one \`${FLAG_TRUE}\` line in src/config.js, found ${occurrences}. ` +
      'Aborting so a lite build can never silently ship with Agent Mode enabled.',
  );
}
let litewritten = configSrc.replace(FLAG_TRUE, FLAG_FALSE);

// The store build must talk to prod (api.getlexi.io). Source keeps
// BUILD_CHANNEL='staging' for unpacked dev; rewrite the staged copy only.
// Override with CHANNEL=staging for a staging ZIP.
const channel = process.env.CHANNEL || 'prod';
const channelMatches = litewritten.match(/export const BUILD_CHANNEL = '[^']*';/g) || [];
if (channelMatches.length !== 1) {
  throw new Error(
    `Expected exactly one BUILD_CHANNEL assignment in src/config.js, found ${channelMatches.length}.`,
  );
}
litewritten = litewritten.replace(
  /export const BUILD_CHANNEL = '[^']*';/,
  `export const BUILD_CHANNEL = '${channel}';`,
);
fs.writeFileSync(configPath, litewritten);

// ---------------------------------------------------------------------------
// 3. Sanity checks. Re-run package.sh's manifest-reference check (every
//    referenced path must exist in the stage) AND assert the lite-specific
//    invariants: the optional permissions are gone and the staged config flag
//    is now false.
// ---------------------------------------------------------------------------
const staged = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

const refs = [];
refs.push(...Object.values(staged.icons || {}));
const action = staged.action || {};
if (action.default_popup) refs.push(action.default_popup);
if (action.default_icon && typeof action.default_icon === 'object') {
  refs.push(...Object.values(action.default_icon));
}
if (staged.background) refs.push(staged.background.service_worker);
if (staged.side_panel) refs.push(staged.side_panel.default_path);
if (staged.options_page) refs.push(staged.options_page);
if (staged.options_ui && staged.options_ui.page) refs.push(staged.options_ui.page);

const present = refs.filter(Boolean);
const missing = present.filter((r) => !fs.existsSync(path.join(STAGE, r)));
if (missing.length) {
  throw new Error(`manifest references missing files: ${JSON.stringify(missing)}`);
}

if ('optional_permissions' in staged || 'optional_host_permissions' in staged) {
  throw new Error('lite manifest still declares optional permissions — build is not lite.');
}
if (!fs.readFileSync(configPath, 'utf8').includes(FLAG_FALSE)) {
  throw new Error('lite config.js did not get AGENT_MODE_AVAILABLE = false.');
}

log(
  `manifest v${staged.manifest_version} '${staged.name}' ${staged.version}: ` +
    `all ${present.length} referenced paths present; optional permissions removed; ` +
    'AGENT_MODE_AVAILABLE=false',
);

// ---------------------------------------------------------------------------
// 4. Zip the staged CONTENTS (manifest.json at the ZIP root, per CWS).
// ---------------------------------------------------------------------------
const version = staged.version;
const zipPath = path.join(OUT_DIR, `lexi-for-chrome-lite-${version}.zip`);
fs.rmSync(zipPath, { force: true });
execFileSync('zip', ['-qr', zipPath, '.', '-x', '*.DS_Store'], { cwd: STAGE, stdio: 'inherit' });

const sizeBytes = fs.statSync(zipPath).size;
log(`Built ${zipPath} (${(sizeBytes / 1024).toFixed(0)}K)`);
const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
process.stdout.write(`${listing.trimEnd().split('\n').slice(-3).join('\n')}\n`);
