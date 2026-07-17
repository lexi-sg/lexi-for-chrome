// test/debug-panel.mjs — standalone debug harness (plain playwright, not
// @playwright/test). Mirrors e2e.spec.js's beforeAll (including the
// TEST-ONLY patched extension copy — see e2e.spec.js buildTestExtensionCopy
// for the rationale), clicks "Flag risky terms", and dumps panel console,
// pageerrors, SW console, DOM state, and any api.anthropic.com traffic.
//
// Run: ANTHROPIC_API_KEY=... node test/debug-panel.mjs
// NEVER echo the key.

import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_FILE = path.join(__dirname, 'test-fixtures.html');

const STORAGE_KEYS = {
  API_KEY: 'lexi_api_key',
  MODEL: 'lexi_model',
  APPROVAL_MODE: 'lexi_approval_mode',
  SITE_GRANTS: 'lexi_site_grants',
  PROVIDER: 'lexi_provider',
};

const log = (...a) => console.log('[dbg]', ...a);

function buildTestExtensionCopy() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-dbg-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const fixtureHtml = fs.readFileSync(FIXTURES_FILE);
  const server = http.createServer((req, res) => {
    if (req.url === '/' || (req.url && req.url.startsWith('/test-fixtures.html'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const fixturesUrl = `http://127.0.0.1:${port}/test-fixtures.html`;
  const fixturesOrigin = new URL(fixturesUrl).origin;
  log('fixtures at', fixturesUrl);

  const extDir = buildTestExtensionCopy();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-dbg-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
      '--no-first-run',
    ],
  });

  // Node-side relay for org-blocked browser calls (mirrors e2e.spec.js's
  // installAnthropicRelay — real request, real response, no Origin header).
  await context.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const headers = {};
    for (const [k, v] of Object.entries(req.headers())) {
      const lk = k.toLowerCase();
      if (['origin', 'referer', 'host', 'content-length', 'connection', 'accept-encoding'].includes(lk)) continue;
      if (lk.startsWith('sec-') || lk.startsWith(':')) continue;
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
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k.toLowerCase())) resHeaders[k] = v;
      });
      await route.fulfill({ status: res.status, headers: resHeaders, body: Buffer.from(await res.arrayBuffer()) });
    } catch {
      await route.abort('failed').catch(() => {});
    }
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(sw.url()).host;
  log('extensionId', extensionId);
  sw.on('console', (m) => log('SW console:', m.type(), m.text()));

  await sw.evaluate(
    async ({ keys, apiKey, origin }) => {
      await chrome.storage.local.set({
        [keys.API_KEY]: apiKey,
        [keys.MODEL]: 'claude-sonnet-5',
        [keys.APPROVAL_MODE]: 'manual',
        [keys.SITE_GRANTS]: {
          [origin]: { agentEnabled: true, classes: [], expiresAt: null, onceGrants: [] },
        },
      });
    },
    { keys: STORAGE_KEYS, apiKey, origin: fixturesOrigin },
  );

  const fixturesPage = await context.newPage();
  await fixturesPage.goto(fixturesUrl, { waitUntil: 'load' });

  const tabId = await sw.evaluate(
    () => new Promise((resolve) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs[0]?.id));
    }),
  );
  log('fixtures tabId', tabId);

  const anthropicRequests = [];
  const panel = await context.newPage();
  panel.on('console', (m) => log('PANEL console:', m.type(), m.text()));
  panel.on('pageerror', (e) => log('PANEL pageerror:', e.message));
  panel.on('request', (req) => {
    if (req.url().includes('api.anthropic.com')) {
      anthropicRequests.push(req.url());
      log('>>> ANTHROPIC REQUEST', req.method(), req.url());
    }
  });

  await panel.goto(
    `chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`,
    { waitUntil: 'load' },
  );
  await panel.waitForTimeout(2000);

  const swDbg = await sw.evaluate(() => ({
    dbgApi: typeof chrome.debugger,
    hasOnConnect: chrome.runtime.onConnect.hasListeners(),
    hasOnMessage: chrome.runtime.onMessage.hasListeners(),
  }));
  log('SW dbg:', JSON.stringify(swDbg));

  const probe = await panel.evaluate(() => new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'lexi-sidepanel' });
    const timer = setTimeout(() => resolve({ timeout: true }), 5000);
    p.onMessage.addListener((msg) => {
      clearTimeout(timer);
      resolve({ reply: msg && msg.type, hasKey: !!(msg && msg.apiKey) });
    });
    p.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve({ disconnected: true, err: chrome.runtime.lastError && chrome.runtime.lastError.message });
    });
    p.postMessage({ type: 'GET_SETTINGS' });
  }));
  log('port probe:', JSON.stringify(probe));

  const probe2 = await panel.evaluate(() => new Promise((resolve) => {
    const p = chrome.runtime.connect({ name: 'lexi-sidepanel' });
    const timer = setTimeout(() => resolve({ timeout: true }), 4000);
    p.onMessage.addListener((msg) => { clearTimeout(timer); resolve({ reply: msg && msg.type }); });
    p.postMessage({ type: 'HEARTBEAT' });
  }));
  log('HEARTBEAT probe:', JSON.stringify(probe2));

  const probe3 = await panel.evaluate(() => new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ timeout: true }), 4000);
    chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (resp) => {
      clearTimeout(timer);
      resolve({ reply: resp && resp.type, lastErr: chrome.runtime.lastError && chrome.runtime.lastError.message });
    });
  }));
  log('runtime.sendMessage probe:', JSON.stringify(probe3));

  const alarms = await sw.evaluate(() => new Promise((r) => chrome.alarms.getAll((a) => r(a.map((x) => x.name)))));
  log('alarms (setup() ran if keepalive present):', JSON.stringify(alarms));

  const apiProbe = await panel.evaluate(async () => {
    const data = await chrome.storage.local.get('lexi_api_key');
    const key = data.lexi_api_key || '';
    const headers = {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    };
    const models = await fetch('https://api.anthropic.com/v1/models', { headers }).then((r) => r.status).catch((e) => `ERR:${e.message}`);
    const msg = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    }).then(async (r) => ({ status: r.status, body: (await r.text()).slice(0, 200) })).catch((e) => `ERR:${e.message}`);
    return { keyLen: key.length, models, msg };
  });
  log('API probe from panel:', JSON.stringify(apiProbe));

  const state = await panel.evaluate(() => ({
    keyBannerHidden: document.getElementById('key-banner')?.hidden,
    chips: [...document.querySelectorAll('#quick-actions button')].map((b) => b.textContent),
  }));
  log('PANEL state:', JSON.stringify(state));

  const scenario = process.env.LEXI_DEBUG_SCENARIO || 'A';

  if (scenario === 'A') {
    log('clicking Flag risky terms chip...');
    await panel.locator('#quick-actions').getByRole('button', { name: /flag risky/i }).click();

    const start = Date.now();
    while (Date.now() - start < 60000) {
      if ((await panel.locator('.lexi-risk-item').count()) > 0) break;
      await panel.waitForTimeout(500);
    }
    log('anthropicRequests count:', anthropicRequests.length);
    log('risk items:', await panel.locator('.lexi-risk-item').count());
  } else if (scenario === 'B') {
    log('clicking Screenshot & ask chip...');
    await panel.locator('#quick-actions').getByRole('button', { name: /screenshot.*ask/i }).click();
    await panel.locator('#prompt-input').fill('What fields does this form have?');
    await panel.locator('#send-btn').click();

    const start = Date.now();
    while (Date.now() - start < 45000) {
      if ((await panel.locator('#messages img').count()) > 0) break;
      await panel.waitForTimeout(500);
    }
    log('anthropicRequests count:', anthropicRequests.length);
    log('imgs in messages:', await panel.locator('#messages img').count());
  }
  log('final #messages text (first 800 chars):',
    ((await panel.locator('#messages').textContent()) || '').slice(0, 800));

  await context.close();
  await new Promise((r) => server.close(r));
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
