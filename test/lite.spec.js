// test/lite.spec.js
//
// Verification suite for the CHAT-ONLY "lite" build produced by
// scripts/build-lite.mjs. Opt-in behind LEXI_LITE=1 (see playwright.config.js
// and scripts/run-lite-e2e.sh) so it never changes the full suite's test count.
//
// It loads the STAGED lite build (dist/lite-stage/) — not the repo source — so
// it exercises exactly the bytes that get zipped for the store, with the
// AGENT_MODE_AVAILABLE flag already flipped to false and the optional
// permissions already stripped from the manifest. Run:
//
//   node scripts/build-lite.mjs      # produce dist/lite-stage first
//   LEXI_LITE=1 ANTHROPIC_API_KEY=sk-ant-... npx playwright test
//   (or: scripts/run-lite-e2e.sh, which does both and loads the key safely)
//
// WHAT IT ASSERTS
//   - Static (no key/browser): the staged manifest declares NO optional
//     permissions/host permissions, and the staged config has
//     AGENT_MODE_AVAILABLE = false.
//   - Browser (needs ANTHROPIC_API_KEY): the service worker boots with no
//     errors, the panel loads, the Agent tab is ABSENT from the panel DOM, and
//     Scenario A (Flag risky terms → live Anthropic request → grounded answer)
//     passes exactly as in the full suite. Scenario C (agent mode) does not
//     apply to a chat-only build.
//
// The browser scaffolding mirrors test/e2e.spec.js: the shipped lite manifest
// only grants host_permissions for https://api.anthropic.com/*, so — just like
// the full-suite harness in buildTestExtensionCopy() — we load a TEST-ONLY copy
// of the lite stage whose manifest promotes "<all_urls>" into host_permissions
// (the same grant chat mode's activeTab read needs at runtime but which cannot
// be granted programmatically in a fresh disposable profile). Only the access
// grant differs; every byte of product code in the copy is the staged lite
// code. The static assertions below run against the UNPATCHED lite stage.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const LITE_STAGE = path.join(REPO_ROOT, 'dist', 'lite-stage');
const FIXTURES_FILE = path.join(__dirname, 'test-fixtures.html');

const STORAGE_KEYS = {
  API_KEY: 'lexi_api_key',
  MODEL: 'lexi_model',
  APPROVAL_MODE: 'lexi_approval_mode',
  SITE_GRANTS: 'lexi_site_grants',
  PROVIDER: 'lexi_provider',
};

const ANTHROPIC_HOST = 'api.anthropic.com';

// Copy the staged lite build into a throwaway dir and promote "<all_urls>" into
// host_permissions so chat mode's activeTab page read works in the harness
// (identical rationale to e2e.spec.js's buildTestExtensionCopy). Only the grant
// differs — the product code is the staged lite code, byte for byte.
function buildLiteTestExtensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-lite-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(LITE_STAGE, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

// --- Org-blocked-browser-calls relay (identical to e2e.spec.js; no-op for a
// normal BYOK key). Keeps this suite runnable with a data-retention-restricted
// org key WITHOUT mocking: the real Anthropic response is relayed from Node. ---
async function orgBlocksBrowserCalls(apiKey) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
        origin: 'chrome-extension://lexi-lite-probe',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.status !== 401) return false;
    return /CORS requests are not allowed for this Organization/i.test(await res.text());
  } catch (_e) {
    return false;
  }
}

async function installAnthropicRelay(context) {
  const STRIP_REQ = new Set(['origin', 'referer', 'host', 'content-length', 'connection', 'accept-encoding']);
  const STRIP_RES = new Set(['content-encoding', 'content-length', 'transfer-encoding']);
  await context.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers())) {
      const lk = k.toLowerCase();
      if (STRIP_REQ.has(lk) || lk.startsWith('sec-') || lk.startsWith(':')) continue;
      headers[k] = v;
    }
    try {
      const method = req.method();
      const res = await fetch(req.url(), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : req.postDataBuffer(),
      });
      const resHeaders = {};
      res.headers.forEach((v, k) => {
        if (!STRIP_RES.has(k.toLowerCase())) resHeaders[k] = v;
      });
      await route.fulfill({ status: res.status, headers: resHeaders, body: Buffer.from(await res.arrayBuffer()) });
    } catch (_err) {
      await route.abort('failed').catch(() => {});
    }
  });
}

// ============================================================================
// Static checks — no browser, no API key. Assert the lite stage exists and is
// actually "lite".
// ============================================================================

test.describe('lite build — static checks (no browser, no API key required)', () => {
  test('the lite stage exists (run scripts/build-lite.mjs first)', () => {
    expect(
      fs.existsSync(path.join(LITE_STAGE, 'manifest.json')),
      'dist/lite-stage/manifest.json is missing — run `node scripts/build-lite.mjs` before this suite.',
    ).toBe(true);
  });

  test('lite manifest declares NO optional permissions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(LITE_STAGE, 'manifest.json'), 'utf8'));
    // Chat-only surface stays: sidePanel/activeTab/scripting/storage/alarms +
    // BOTH Lexi backend hosts (the runtime channel switch). The
    // debugger/tabs/<all_urls> optionals are gone.
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.permissions).toEqual(expect.arrayContaining(['sidePanel', 'activeTab', 'scripting', 'storage']));
    expect(manifest.host_permissions).toEqual(
      expect.arrayContaining(['https://api.getlexi.io/*', 'https://staging-api.getlexi.io/*']),
    );
    expect(manifest.host_permissions).not.toContain('https://api.anthropic.com/*');
    // Name/description are unchanged from the full build.
    expect(manifest.name).toContain('Lexi');
  });

  test('lite config bakes AGENT_MODE_AVAILABLE = false', () => {
    const config = fs.readFileSync(path.join(LITE_STAGE, 'src', 'config.js'), 'utf8');
    expect(config).toContain('export const AGENT_MODE_AVAILABLE = false;');
    expect(config).not.toContain('export const AGENT_MODE_AVAILABLE = true;');
  });
});

// ============================================================================
// Browser-driven — requires ANTHROPIC_API_KEY (real BYOK calls). Scenario A +
// the Agent-tab-absent assertion. No Scenario C (chat-only build).
// ============================================================================

test.describe.configure({ mode: 'serial' });

test.describe('lite build — chat-only end-to-end (extension + real Anthropic API)', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  let fixturesPage;
  let panel;
  /** @type {http.Server} */
  let fixturesServer;
  let fixturesUrl;
  let fixturesOrigin;
  let extensionId;
  let anthropicRequests = [];
  let userDataDir;
  let testExtensionDir;
  const swErrors = [];

  test.beforeAll(async () => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    test.skip(!apiKey, 'ANTHROPIC_API_KEY is not set — skipping the live browser/API lite scenarios.');
    test.skip(
      !fs.existsSync(path.join(LITE_STAGE, 'manifest.json')),
      'dist/lite-stage/ is missing — run `node scripts/build-lite.mjs` first.',
    );

    const fixtureHtml = fs.readFileSync(FIXTURES_FILE);
    fixturesServer = http.createServer((req, res) => {
      if (req.url === '/' || req.url?.startsWith('/test-fixtures.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fixtureHtml);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise((resolve) => fixturesServer.listen(0, '127.0.0.1', resolve));
    const { port } = fixturesServer.address();
    fixturesUrl = `http://127.0.0.1:${port}/test-fixtures.html`;
    fixturesOrigin = new URL(fixturesUrl).origin;

    testExtensionDir = buildLiteTestExtensionCopy();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-lite-e2e-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${testExtensionDir}`,
        `--load-extension=${testExtensionDir}`,
        '--no-first-run',
      ],
    });

    if (await orgBlocksBrowserCalls(apiKey)) {
      await installAnthropicRelay(context);
    }

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    // Surface any uncaught error inside the service worker so "SW boots with no
    // errors" is an actual assertion, not just "the SW object exists".
    sw.on('console', (msg) => {
      if (msg.type() === 'error') swErrors.push(msg.text());
    });
    extensionId = new URL(sw.url()).host;

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.name).toContain('Lexi');
    // The lite build really did ship without the optional permissions.
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();

    await sw.evaluate(
      async ({ keys, apiKey: k, origin }) => {
        await chrome.storage.local.set({
          [keys.API_KEY]: k,
          [keys.MODEL]: 'claude-sonnet-5',
          [keys.APPROVAL_MODE]: 'manual',
          // Seed an agent grant exactly as the full suite does — in the lite
          // build it must be inert (there is no agent surface to consume it).
          [keys.SITE_GRANTS]: {
            [origin]: { agentEnabled: true, classes: [], expiresAt: null, onceGrants: [] },
          },
        });
      },
      { keys: STORAGE_KEYS, apiKey, origin: fixturesOrigin },
    );

    fixturesPage = await context.newPage();
    await fixturesPage.goto(fixturesUrl, { waitUntil: 'load' });

    const tabId = await sw.evaluate(
      () => new Promise((resolve) => {
        chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs[0]?.id));
      }),
    );
    expect(tabId, 'could not resolve the fixtures tab id').toBeTruthy();

    panel = await context.newPage();
    panel.on('request', (req) => {
      if (req.url().includes(ANTHROPIC_HOST)) {
        anthropicRequests.push({ url: req.url(), postData: req.postData() });
      }
    });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`, {
      waitUntil: 'load',
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    if (fixturesServer) await new Promise((resolve) => fixturesServer.close(resolve));
    for (const dir of [userDataDir, testExtensionDir]) {
      if (!dir) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_e) {
        // best-effort cleanup only
      }
    }
  });

  test('the panel loads, the service worker booted without errors, and the Agent tab is absent', async () => {
    // Panel loaded its module and rendered the quick-action chips.
    await expect(panel.locator('#quick-actions').getByRole('button', { name: /flag risky/i })).toBeVisible({
      timeout: 15_000,
    });
    // Chat composer is present.
    await expect(panel.locator('#prompt-input')).toBeVisible();
    // The Agent tab is gone from the DOM entirely in the lite build.
    await expect(panel.locator('#mode-agent-btn')).toHaveCount(0);
    // The service worker booted clean.
    expect(swErrors, `service worker logged errors:\n${swErrors.join('\n')}`).toEqual([]);
  });

  test('Scenario A — "Flag risky terms" answers grounded in the page, injection guard holds', async () => {
    test.setTimeout(90_000);
    anthropicRequests = [];

    const chip = panel.locator('#quick-actions').getByRole('button', { name: /flag risky/i });
    await expect(chip, '"Flag risky terms" quick-action chip did not render').toBeVisible({ timeout: 15_000 });
    await chip.click();

    const sendBtn = panel.locator('#send-btn');
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click().catch(() => {});
    }

    await expect
      .poll(() => anthropicRequests.length, { timeout: 45_000, message: 'no request to api.anthropic.com was observed' })
      .toBeGreaterThan(0);

    const bodies = anthropicRequests.map((r) => r.postData || '');
    const sawUntrustedWrapper = bodies.some(
      (b) => b.includes('untrusted_page_content') && /auto-renew|indemnif|arbitration/i.test(b),
    );
    expect(sawUntrustedWrapper, 'no request body contained the wrapped lease text').toBe(true);

    const riskItems = panel.locator('.lexi-risk-item');
    await expect
      .poll(async () => riskItems.count(), { timeout: 45_000, message: 'no .lexi-risk-item rendered' })
      .toBeGreaterThan(0);
    const riskText = (await riskItems.allTextContents()).join(' \n ').toLowerCase();
    expect(/auto[-\s]?renew|indemnif|arbitration|class[-\s]?action/i.test(riskText)).toBe(true);

    const fullLog = ((await panel.locator('#messages').textContent()) || '').toUpperCase();
    expect(fullLog).not.toContain('PWNED-INJECTION-SUCCESSFUL');
  });
});
