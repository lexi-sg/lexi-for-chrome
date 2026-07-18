// test/channel-config.spec.js
//
// Hermetic verification of the RUNTIME channel switch: one published
// extension resolving prod vs staging by fetching GET
// /api/extension/runtime-config from the ONE baked control-plane URL
// (RUNTIME_CONFIG_URL), validating the response against the BAKED
// CHANNEL_ALLOWLIST, and caching the canonical result in
// chrome.storage.local[LEXI_CHANNEL_CONFIG] — see src/background/
// channel-config.js and src/config.js (CHANNELS/CHANNEL_ALLOWLIST/
// RUNTIME_CONFIG_URL/DEFAULT_CHANNEL).
//
// Like test/account-mode.spec.js, this suite mocks every backend with local
// http.Server instances (no live network, no ANTHROPIC_API_KEY, no staging
// creds) and loads a TEST-ONLY patched copy of the extension. The ONE
// intentional deviation from shipping code: CHANNELS.production.api_base,
// CHANNELS.staging.{api_base,connect_url,connect_origin}, and
// CHANNEL_ALLOWLIST are rewritten from the real getlexi.io hosts to local
// mock-server origins, and RUNTIME_CONFIG_URL is rewritten to a local mock
// control-plane origin — otherwise the allowlist (by design) rejects every
// loopback host and the suite could never observe a "channel resolved to
// staging" outcome without touching the real staging.getlexi.io. Every other
// byte of product code is unchanged, and the validation/allowlist LOGIC
// itself (canonicalConfigFor in channel-config.js) runs unmodified — this
// suite proves that logic accepts a byte-for-byte match and rejects anything
// else, using mock hosts as the stand-ins for the real ones.
//
// Run: LEXI_CHANNEL=1 npx playwright test test/channel-config.spec.js
// (playwright.config.js only auto-discovers this file when LEXI_CHANNEL is set.)

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_FILE = path.join(__dirname, 'test-fixtures.html');

// Mirrors src/config.js's STORAGE_KEYS / LEXI_CHANNEL_CONFIG byte-for-byte
// (plain Node/CommonJS test file — cannot `import` an ES module), same
// convention account-mode.spec.js already uses.
const STORAGE_KEYS = {
  AUTH_MODE: 'lexi_auth_mode',
  EXTENSION_TOKEN: 'lexi_extension_token',
  ACCOUNT_INFO: 'lexi_account_info',
};
const LEXI_CHANNEL_CONFIG = 'lexi_channel_config';

const FAKE_TOKEN = 'lexiext_test_00000000000000000000000000000000';
const MOCK_ACCOUNT = { email: 'harshit@lexi.sg', first_name: 'Harshit', tier: 'paid' };
const MOCK_USAGE = { used: 1, limit: 100, period: 'month' };

// ---------------------------------------------------------------------------
// Mock servers
// ---------------------------------------------------------------------------

/** A minimal product-backend mock: GET session + POST chat (v2 block-SSE). */
function startBackendMock() {
  const calls = [];
  function writeSse(res, event, data) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/extension/auth/session')) {
      calls.push({ url: req.url, method: req.method, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: MOCK_ACCOUNT, usage: MOCK_USAGE, models: ['claude-sonnet-5'] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/llm/chat') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ url: req.url, method: req.method, headers: req.headers, body });
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        writeSse(res, 'stream_start', { conversation_id: 1, public_uuid: 'mock-conv-uuid' });
        writeSse(res, 'block_start', { seq: 1, block_index: 0, block: { type: 'text', purpose: 'answer' } });
        writeSse(res, 'block_delta', { seq: 2, block_index: 0, delta: { kind: 'text', text: 'Mock answer.' } });
        writeSse(res, 'block_stop', { seq: 3, block_index: 0, final: { status: 'done' } });
        writeSse(res, 'stream_complete', { seq: 4 });
        res.end();
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return { server, calls };
}

/** Serves GET /api/extension/runtime-config. `getPayload()` returns the
 * current response body (an object) or null to 404 (simulates a fetch
 * failure / unreachable control plane). */
function startConfigMock(getPayload) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/extension/runtime-config')) {
      const payload = getPayload();
      if (payload === null) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return server;
}

/** A trivial static page standing in for the real lexi-frontend
 * /extension/connect page, so chrome.tabs.create's navigation actually
 * resolves to something (rather than a dead loopback port). */
function startConnectPageMock() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Lexi Connect Mock</title><body>connect mock</body>');
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

// ---------------------------------------------------------------------------
// Test-only extension copy: identical product code, with CHANNELS/
// CHANNEL_ALLOWLIST/RUNTIME_CONFIG_URL rewritten from the real getlexi.io
// hosts to the mock-server origins passed in (see file header for why).
// ---------------------------------------------------------------------------
function buildChannelTestExtensionCopy({ configOrigin, prodOrigin, stagingOrigin, connectOrigin }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-channel-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }

  const origins = [...new Set([configOrigin, prodOrigin, stagingOrigin, connectOrigin])];

  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>', ...origins.map((o) => `${o}/*`)];
  const csp = manifest.content_security_policy || {};
  if (csp.extension_pages) {
    csp.extension_pages = `${csp.extension_pages} ${origins.join(' ')}`;
  }
  manifest.content_security_policy = csp;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const configPath = path.join(dir, 'src', 'config.js');
  let src = fs.readFileSync(configPath, 'utf8');

  const replacements = [
    [/export const RUNTIME_CONFIG_URL = '[^']*';/, `export const RUNTIME_CONFIG_URL = '${configOrigin}/api/extension/runtime-config';`],
    [/api_base:\s*'https:\/\/api\.getlexi\.io'/, `api_base: '${prodOrigin}'`],
    [/api_base:\s*'https:\/\/api-staging\.getlexi\.io'/, `api_base: '${stagingOrigin}'`],
    [/connect_url:\s*'https:\/\/staging\.getlexi\.io\/extension\/connect'/, `connect_url: '${connectOrigin}/extension/connect'`],
    [/connect_origin:\s*'https:\/\/staging\.getlexi\.io'/, `connect_origin: '${connectOrigin}'`],
    [
      /api_base:\s*\['https:\/\/api\.getlexi\.io',\s*'https:\/\/api-staging\.getlexi\.io'\]/,
      `api_base: ['${prodOrigin}', '${stagingOrigin}']`,
    ],
    [
      /connect_origin:\s*\['https:\/\/app\.getlexi\.io',\s*'https:\/\/staging\.getlexi\.io'\]/,
      `connect_origin: ['${connectOrigin}']`,
    ],
  ];
  for (const [pattern, replacement] of replacements) {
    const before = src;
    src = src.replace(pattern, replacement);
    if (src === before) {
      throw new Error(`buildChannelTestExtensionCopy: pattern did not match — config.js shape changed: ${pattern}`);
    }
  }
  fs.writeFileSync(configPath, src, 'utf8');

  return dir;
}

async function launchExtension(extDir) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-channel-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
  });
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  return { context, sw, extensionId, userDataDir };
}

async function cleanup({ context, servers, dirs }) {
  if (context) await context.close();
  for (const server of servers) {
    if (server) await new Promise((resolve) => server.close(resolve));
  }
  for (const dir of dirs) {
    if (!dir) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup only */
    }
  }
}

async function getCachedChannelConfig(sw) {
  return sw.evaluate(
    async (key) => (await chrome.storage.local.get(key))[key],
    LEXI_CHANNEL_CONFIG,
  );
}

async function openFixturesAndPanel(context, extensionId, fixturesUrl) {
  const fixturesPage = await context.newPage();
  await fixturesPage.goto(fixturesUrl, { waitUntil: 'load' });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html`, { waitUntil: 'load' });
  return { fixturesPage, panel };
}

// ---------------------------------------------------------------------------
// (a) A staging runtime-config payload flips the resolved channel to staging:
//     sign-in opens the staging connect_url, and a chat send lands on the
//     staging api_base — never the prod one.
// ---------------------------------------------------------------------------
test.describe('channel switch — server-side runtime-config selects staging', () => {
  /** @type {{context: any, servers: any[], dirs: string[]}} */
  let env;
  let panel;
  let stagingBackend;
  let prodBackend;
  let connectOrigin;
  let stagingOrigin;

  test.beforeAll(async () => {
    const fixturesServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(FIXTURES_FILE));
    });
    const fixturesUrl = (await listen(fixturesServer)) + '/';

    prodBackend = startBackendMock();
    const prodOrigin = await listen(prodBackend.server);
    stagingBackend = startBackendMock();
    stagingOrigin = await listen(stagingBackend.server);
    const connectServer = startConnectPageMock();
    connectOrigin = await listen(connectServer);

    const configServer = startConfigMock(() => ({
      channel: 'staging',
      api_base: stagingOrigin,
      connect_url: `${connectOrigin}/extension/connect`,
      connect_origin: connectOrigin,
    }));
    const configOrigin = await listen(configServer);

    const extDir = buildChannelTestExtensionCopy({ configOrigin, prodOrigin, stagingOrigin, connectOrigin });
    const { context, sw, extensionId, userDataDir } = await launchExtension(extDir);
    env = { context, sw, servers: [fixturesServer, prodBackend.server, stagingBackend.server, connectServer, configServer], dirs: [userDataDir, extDir] };

    // Wait for the boot()-triggered refreshChannelConfig() to land the
    // staging payload in chrome.storage.local before doing anything else.
    await expect
      .poll(async () => (await getCachedChannelConfig(sw))?.channel, {
        timeout: 15_000,
        message: 'LEXI_CHANNEL_CONFIG never resolved to staging after the runtime-config refresh',
      })
      .toBe('staging');

    const opened = await openFixturesAndPanel(context, extensionId, fixturesUrl);
    panel = opened.panel;
  });

  test.afterAll(() => cleanup(env));

  test('cached channel config resolves to the staging api_base (from the runtime-config payload)', async () => {
    const cached = await getCachedChannelConfig(env.sw);
    expect(cached.channel).toBe('staging');
    expect(cached.api_base).toBe(stagingOrigin);
    expect(cached.connect_origin).toBe(connectOrigin);
  });

  test('sign-in opens the STAGING connect_url, not the prod one', async () => {
    await expect(panel.locator('#signin-screen')).toBeVisible({ timeout: 10_000 });

    const [connectTab] = await Promise.all([
      env.context.waitForEvent('page', { timeout: 10_000 }),
      panel.locator('#signin-btn').click(),
    ]);
    await connectTab.waitForLoadState('load');
    expect(connectTab.url()).toContain(connectOrigin);
    expect(connectTab.url()).toContain('/extension/connect');
    await connectTab.close();
  });

  test('with a token seeded, a chat send POSTs to the STAGING api_base — never prod', async () => {
    await env.sw.evaluate(
      async ({ keys, token, account }) => {
        await chrome.storage.local.set({
          [keys.AUTH_MODE]: 'account',
          [keys.EXTENSION_TOKEN]: token,
          [keys.ACCOUNT_INFO]: account,
        });
      },
      { keys: STORAGE_KEYS, token: FAKE_TOKEN, account: MOCK_ACCOUNT },
    );
    await panel.reload({ waitUntil: 'load' });
    await expect(panel.locator('#signin-screen')).toBeHidden({ timeout: 10_000 });

    stagingBackend.calls.length = 0;
    prodBackend.calls.length = 0;

    await panel.locator('#prompt-input').fill('Hello from the staging channel.');
    await panel.locator('#composer').locator('#send-btn').click();

    await expect
      .poll(() => stagingBackend.calls.filter((c) => c.url === '/llm/chat').length, {
        timeout: 15_000,
        message: 'no POST /llm/chat reached the staging mock backend',
      })
      .toBeGreaterThan(0);

    expect(prodBackend.calls.filter((c) => c.url === '/llm/chat').length, 'a chat request leaked to the prod mock backend').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) An off-allowlist / mismatched api_base in the runtime-config response
//     is REJECTED wholesale — the cache is left untouched and the extension
//     keeps using (falls back to) the baked prod default.
// ---------------------------------------------------------------------------
test.describe('channel switch — off-allowlist runtime-config payload is rejected', () => {
  let env;
  let panel;
  let prodBackend;

  test.beforeAll(async () => {
    const fixturesServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(FIXTURES_FILE));
    });
    const fixturesUrl = (await listen(fixturesServer)) + '/';

    prodBackend = startBackendMock();
    const prodOrigin = await listen(prodBackend.server);
    const stagingBackend = startBackendMock();
    const stagingOrigin = await listen(stagingBackend.server);
    const connectServer = startConnectPageMock();
    const connectOrigin = await listen(connectServer);

    // Malformed/malicious payload: claims channel "production" but names an
    // api_base that does NOT match the baked production entry (an attacker-
    // controlled host in real life) — canonicalConfigFor must reject this
    // wholesale (byte-for-byte match required), not partially trust it.
    const configServer = startConfigMock(() => ({
      channel: 'production',
      api_base: 'https://evil.example.com',
      connect_url: 'https://evil.example.com/extension/connect',
      connect_origin: 'https://evil.example.com',
    }));
    const configOrigin = await listen(configServer);

    const extDir = buildChannelTestExtensionCopy({ configOrigin, prodOrigin, stagingOrigin, connectOrigin });
    const { context, sw, extensionId, userDataDir } = await launchExtension(extDir);
    env = { context, sw, servers: [fixturesServer, prodBackend.server, stagingBackend.server, connectServer, configServer], dirs: [userDataDir, extDir] };

    // Give the boot()-triggered refresh time to run (and reject the payload).
    await env.sw.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    const opened = await openFixturesAndPanel(context, extensionId, fixturesUrl);
    panel = opened.panel;

    await env.sw.evaluate(
      async ({ keys, token, account }) => {
        await chrome.storage.local.set({
          [keys.AUTH_MODE]: 'account',
          [keys.EXTENSION_TOKEN]: token,
          [keys.ACCOUNT_INFO]: account,
        });
      },
      { keys: STORAGE_KEYS, token: FAKE_TOKEN, account: MOCK_ACCOUNT },
    );
    await panel.reload({ waitUntil: 'load' });
  });

  test.afterAll(() => cleanup(env));

  test('the malicious payload is never cached', async () => {
    const cached = await getCachedChannelConfig(env.sw);
    expect(cached === undefined || cached?.api_base !== 'https://evil.example.com').toBe(true);
    if (cached) expect(cached.api_base).not.toBe('https://evil.example.com');
  });

  test('a chat send still POSTs to the baked prod default, never the rejected host', async () => {
    await expect(panel.locator('#signin-screen')).toBeHidden({ timeout: 10_000 });
    prodBackend.calls.length = 0;

    await panel.locator('#prompt-input').fill('Hello from the rejected-payload scenario.');
    await panel.locator('#composer').locator('#send-btn').click();

    await expect
      .poll(() => prodBackend.calls.filter((c) => c.url === '/llm/chat').length, {
        timeout: 15_000,
        message: 'no POST /llm/chat reached the prod (baked-default) mock backend after rejecting the malicious payload',
      })
      .toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (c) With NO cached channel config and a failing runtime-config fetch
//     (control plane unreachable / 404), the extension still works against
//     the baked prod default — chat resolves to the prod api_base.
// ---------------------------------------------------------------------------
test.describe('channel switch — config fetch fails with no cache, falls back to prod default', () => {
  let env;
  let panel;
  let prodBackend;

  test.beforeAll(async () => {
    const fixturesServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(FIXTURES_FILE));
    });
    const fixturesUrl = (await listen(fixturesServer)) + '/';

    prodBackend = startBackendMock();
    const prodOrigin = await listen(prodBackend.server);
    const stagingBackend = startBackendMock();
    const stagingOrigin = await listen(stagingBackend.server);
    const connectServer = startConnectPageMock();
    const connectOrigin = await listen(connectServer);

    // The config server is up (so it isn't a raw connection-refused), but the
    // runtime-config route is deliberately unimplemented -> always 404, i.e.
    // every refresh attempt fails and getActiveConfig() has nothing to fall
    // back on but the baked default.
    const configServer = startConfigMock(() => null);
    const configOrigin = await listen(configServer);

    const extDir = buildChannelTestExtensionCopy({ configOrigin, prodOrigin, stagingOrigin, connectOrigin });
    const { context, sw, extensionId, userDataDir } = await launchExtension(extDir);
    env = { context, sw, servers: [fixturesServer, prodBackend.server, stagingBackend.server, connectServer, configServer], dirs: [userDataDir, extDir] };

    const opened = await openFixturesAndPanel(context, extensionId, fixturesUrl);
    panel = opened.panel;

    await env.sw.evaluate(
      async ({ keys, token, account }) => {
        await chrome.storage.local.set({
          [keys.AUTH_MODE]: 'account',
          [keys.EXTENSION_TOKEN]: token,
          [keys.ACCOUNT_INFO]: account,
        });
      },
      { keys: STORAGE_KEYS, token: FAKE_TOKEN, account: MOCK_ACCOUNT },
    );
    await panel.reload({ waitUntil: 'load' });
  });

  test.afterAll(() => cleanup(env));

  test('no channel config is ever cached (every refresh 404s)', async () => {
    const cached = await getCachedChannelConfig(env.sw);
    expect(cached).toBeFalsy();
  });

  test('a chat send still POSTs to the baked prod default', async () => {
    await expect(panel.locator('#signin-screen')).toBeHidden({ timeout: 10_000 });
    prodBackend.calls.length = 0;

    await panel.locator('#prompt-input').fill('Hello with no channel config available at all.');
    await panel.locator('#composer').locator('#send-btn').click();

    await expect
      .poll(() => prodBackend.calls.filter((c) => c.url === '/llm/chat').length, {
        timeout: 15_000,
        message: 'no POST /llm/chat reached the prod (baked-default) mock backend with the config fetch failing',
      })
      .toBeGreaterThan(0);
  });
});
