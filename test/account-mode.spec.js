// test/account-mode.spec.js
//
// Hermetic account-mode + product-chat verification. UNLIKE test/e2e.spec.js
// (which drives the real Anthropic API for Agent Mode / BYOK), this suite
// mocks the LEXI PRODUCT BACKEND with a local http server that emits the v2
// block-SSE frames per REAL_LEXI_SPEC.json's event map, so it is fully
// deterministic and needs no live network access, no ANTHROPIC_API_KEY, and
// no staging credentials. It seeds chrome.storage.local with
// AUTH_MODE='account' + a fake lexiext_ token (the "account-mode
// token-injection" e2e seam byok_fate documents as the PRIMARY seam for
// product-chat tests) and points LEXI_API_BASE at the mock via a test-only
// patched copy of src/config.js (same pattern buildTestExtensionCopy() in
// e2e.spec.js uses for manifest.json — identical product code, one
// intentional config deviation).
//
// Run: npx playwright test test/account-mode.spec.js
// (playwright.config.js's testMatch only auto-discovers e2e.spec.js/
// lite.spec.js by default — this file is run explicitly, by name, exactly
// like the referee instructions specify.)

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_FILE = path.join(__dirname, 'test-fixtures.html');

// Mirrors src/config.js's MSG / STORAGE_KEYS byte-for-byte (plain
// Node/CommonJS test file — cannot `import` an ES module).
const STORAGE_KEYS = {
  AUTH_MODE: 'lexi_auth_mode',
  EXTENSION_TOKEN: 'lexi_extension_token',
  ACCOUNT_INFO: 'lexi_account_info',
};

const FAKE_TOKEN = 'lexiext_test_00000000000000000000000000000000';
const MOCK_ACCOUNT = { email: 'harshit@lexi.sg', first_name: 'Harshit', tier: 'paid' };
const MOCK_USAGE = { used: 3, limit: 100, period: 'month' };
const ANSWER_TEXT =
  'This lease has a risky auto-renewal clause and a broad indemnification clause worth flagging.';
const FOLLOW_UPS = ['What does the indemnification clause require?', 'Can the tenant terminate early?'];

// ---------------------------------------------------------------------------
// Mock product backend — a real local http.Server (not a Playwright route
// stub) implementing exactly the two endpoints account-mode chat needs:
// GET /api/extension/auth/session (account chip + usage meter) and
// POST /llm/chat (v2 block-SSE). Records every request so tests can assert
// on headers/body (Bearer auth, page_context, no x-api-key).
// ---------------------------------------------------------------------------
function startMockBackend() {
  const calls = [];

  function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function handleSession(req, res) {
    calls.push({ url: req.url, method: req.method, headers: req.headers, body: '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ account: MOCK_ACCOUNT, usage: MOCK_USAGE, models: ['claude-sonnet-5'] }));
  }

  function handleChat(req, res, body) {
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      /* malformed body — fall through with {} */
    }
    const userMessage = parsed.user_message || '';

    if (/TRIGGER_401/.test(userMessage)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Invalid or expired token' }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    writeSse(res, 'stream_start', { conversation_id: 4242, public_uuid: 'mock-conv-uuid' });
    writeSse(res, 'block_start', { seq: 1, block_index: 0, block: { type: 'text', purpose: 'answer' } });
    writeSse(res, 'block_delta', {
      seq: 2,
      block_index: 0,
      delta: { kind: 'text', text: ANSWER_TEXT },
    });
    writeSse(res, 'block_stop', { seq: 3, block_index: 0, final: { status: 'done' } });
    writeSse(res, 'follow_up_questions', { follow_up_questions: FOLLOW_UPS });
    writeSse(res, 'stream_complete', { seq: 4 });
    res.end();
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/extension/auth/session')) {
      handleSession(req, res);
      return;
    }
    if (req.method === 'POST' && req.url === '/llm/chat') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handleChat(req, res, body));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });

  return { server, calls };
}

// ---------------------------------------------------------------------------
// Test-only extension copy: identical product code, config.js's staging
// apiBase rewritten to the mock server's loopback origin (mirrors
// buildTestExtensionCopy()'s manifest-only patch in e2e.spec.js), plus the
// same `<all_urls>` host_permissions promotion so content-script injection
// works against the loopback fixtures page.
// ---------------------------------------------------------------------------
function buildAccountModeExtensionCopy(mockOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-account-mode-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>', `${mockOrigin}/*`];
  const csp = manifest.content_security_policy || {};
  if (csp.extension_pages && !csp.extension_pages.includes(mockOrigin)) {
    csp.extension_pages = `${csp.extension_pages} ${mockOrigin}`;
  }
  manifest.content_security_policy = csp;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  // The backend channel is now RUNTIME-resolved (getActiveConfig): with no
  // cached LEXI_CHANNEL_CONFIG the extension falls back to the baked
  // DEFAULT_CHANNEL ('production'), so point CHANNELS.production.api_base at the
  // mock. (In production this host is baked + allowlisted; here we rewrite the
  // baked default itself, which getActiveConfig returns without an allowlist
  // check — the loopback mock would fail the allowlist if fed through the
  // fetched-config path, so it MUST be the baked default that carries it.)
  const configPath = path.join(dir, 'src', 'config.js');
  let configSrc = fs.readFileSync(configPath, 'utf8');
  const before = configSrc;
  configSrc = configSrc.replace(
    /api_base:\s*'https:\/\/api\.getlexi\.io'/,
    `api_base: '${mockOrigin}'`,
  );
  if (configSrc === before) {
    throw new Error('buildAccountModeExtensionCopy: failed to patch CHANNELS.production.api_base — config.js shape changed');
  }
  // Neutralize the control-plane URL so the startup refreshChannelConfig() can
  // never reach (and cache) the REAL prod runtime-config — which would override
  // the baked-default patch above and send chat to real prod instead of the
  // mock. Pointing it at an unimplemented mock path makes the fetch 404, so the
  // refresh fails safe and getActiveConfig keeps returning the patched default.
  const beforeUrl = configSrc;
  configSrc = configSrc.replace(
    /export const RUNTIME_CONFIG_URL = '[^']*';/,
    `export const RUNTIME_CONFIG_URL = '${mockOrigin}/__no_runtime_config__';`,
  );
  if (configSrc === beforeUrl) {
    throw new Error('buildAccountModeExtensionCopy: failed to patch RUNTIME_CONFIG_URL — config.js shape changed');
  }
  fs.writeFileSync(configPath, configSrc, 'utf8');

  return dir;
}

test.describe('account mode — hermetic product-chat (mocked backend)', () => {
  /** @type {import('@playwright/test').BrowserContext} */
  let context;
  /** @type {import('@playwright/test').Page} */
  let fixturesPage;
  /** @type {import('@playwright/test').Page} */
  let panel;
  /** @type {http.Server} */
  let fixturesServer;
  /** @type {http.Server} */
  let mockServer;
  let mockCalls;
  let fixturesUrl;
  let mockOrigin;
  let extensionId;
  let userDataDir;
  let testExtensionDir;

  test.beforeAll(async () => {
    // ---- 1. Serve the fixture (lease clauses) over loopback HTTP ----------
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
    fixturesUrl = `http://127.0.0.1:${fixturesServer.address().port}/test-fixtures.html`;

    // ---- 2. Start the mock product backend --------------------------------
    const mock = startMockBackend();
    mockServer = mock.server;
    mockCalls = mock.calls;
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    mockOrigin = `http://127.0.0.1:${mockServer.address().port}`;

    // ---- 3. Launch the extension (test-only copy, apiBase -> mock) --------
    testExtensionDir = buildAccountModeExtensionCopy(mockOrigin);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-account-mode-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${testExtensionDir}`,
        `--load-extension=${testExtensionDir}`,
        '--no-first-run',
      ],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    extensionId = new URL(sw.url()).host;

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.name).toContain('Lexi');

    // ---- 4. Seed account-mode storage (the primary e2e seam) --------------
    await sw.evaluate(
      async ({ keys, token, account }) => {
        await chrome.storage.local.set({
          [keys.AUTH_MODE]: 'account',
          [keys.EXTENSION_TOKEN]: token,
          [keys.ACCOUNT_INFO]: account,
        });
      },
      { keys: STORAGE_KEYS, token: FAKE_TOKEN, account: MOCK_ACCOUNT },
    );

    // ---- 5. Open the fixtures tab, then the panel as a plain tab ----------
    fixturesPage = await context.newPage();
    await fixturesPage.goto(fixturesUrl, { waitUntil: 'load' });

    const tabId = await sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs[0]?.id));
        }),
    );
    expect(tabId, 'could not resolve the fixtures tab id').toBeTruthy();

    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`, {
      waitUntil: 'load',
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    for (const server of [fixturesServer, mockServer]) {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of [userDataDir, testExtensionDir]) {
      if (!dir) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup only */
      }
    }
  });

  test('sign-in state renders the account chip (email + usage from GET_SESSION)', async () => {
    const chip = panel.locator('#account-chip');
    await expect(chip, 'account chip stayed hidden in account mode').toBeVisible({ timeout: 10_000 });

    const email = panel.locator('#account-email');
    await expect
      .poll(() => email.textContent(), { timeout: 10_000, message: 'account chip never showed the mocked email' })
      .toContain(MOCK_ACCOUNT.email);

    // Sign-in screen must NOT be showing once authenticated.
    await expect(panel.locator('#signin-screen')).toBeHidden();

    // requestSession() must have actually hit the mock GET /api/extension/auth/session.
    const sessionCalls = mockCalls.filter((c) => c.url.startsWith('/api/extension/auth/session'));
    expect(sessionCalls.length, 'GET_SESSION never reached the mock backend').toBeGreaterThan(0);
    expect(sessionCalls[0].headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  test('a chat send POSTs /llm/chat with Bearer auth + page_context carrying the fixture lease text', async () => {
    mockCalls.length = 0;

    await panel.locator('#prompt-input').fill('Flag anything risky in this lease.');
    await panel.locator('#composer').locator('#send-btn').click();

    await expect
      .poll(() => mockCalls.filter((c) => c.url === '/llm/chat').length, {
        timeout: 15_000,
        message: 'no POST /llm/chat request reached the mock backend',
      })
      .toBeGreaterThan(0);

    const chatCall = mockCalls.find((c) => c.url === '/llm/chat');
    expect(chatCall.method).toBe('POST');
    expect(chatCall.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(chatCall.headers['x-api-key'], 'chat-mode request must NOT carry a raw x-api-key header').toBeUndefined();

    const parsedBody = JSON.parse(chatCall.body);
    expect(parsedBody.metadata.source_channel).toBe('chrome_extension');
    expect(parsedBody.metadata.page_context, 'page_context missing from the request body').toBeTruthy();
    expect(/auto-renew|indemnif|arbitration/i.test(parsedBody.metadata.page_context.text)).toBe(true);
  });

  test('streamed v2 block-SSE frames render the answer, and follow-up chips appear', async () => {
    const messages = panel.locator('#messages');
    await expect
      .poll(async () => (await messages.textContent()) || '', {
        timeout: 15_000,
        message: 'streamed answer text never rendered into #messages',
      })
      .toEqual(expect.stringContaining('auto-renewal'));

    const chips = panel.locator('.lexi-follow-up-chip');
    await expect
      .poll(() => chips.count(), { timeout: 10_000, message: 'no .lexi-follow-up-chip rendered' })
      .toBeGreaterThan(0);
    const chipTexts = (await chips.allTextContents()).join(' | ');
    expect(FOLLOW_UPS.some((q) => chipTexts.includes(q))).toBe(true);
  });

  test('a 401 from the mock flips the session-expiry banner and disables the composer', async () => {
    await panel.locator('#prompt-input').fill('TRIGGER_401 please.');
    await panel.locator('#composer').locator('#send-btn').click();

    const banner = panel.locator('#key-banner');
    await expect(banner, 'session-expiry banner never appeared after a 401').toBeVisible({ timeout: 15_000 });
    await expect(panel.locator('#key-banner-text')).toContainText(/session ended/i);

    await expect
      .poll(() => panel.locator('#send-btn').isDisabled(), {
        timeout: 5_000,
        message: 'composer send button was not disabled after session expiry',
      })
      .toBe(true);
  });
});
