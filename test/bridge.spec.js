// test/bridge.spec.js
//
// Hermetic tests for the browser bridge (src/background/bridge-client.js,
// docs/browser-bridge.md): Lexi's server-side chat driving a tab in this
// browser. A local mock plays Lexi's backend — the ticket endpoint and the
// bridge WebSocket — and sends commands the way the chat's browser tools
// would. "SCC Online" and a site the user did not switch on are served from
// loopback HTTPS (see startSiteServer), so nothing leaves the machine.
//
// Run: LEXI_BRIDGE=1 npx playwright test
// (opt-in behind LEXI_BRIDGE, like the other non-default suites — see
// playwright.config.js). Add LEXI_BROWSER_CHANNEL=chrome (or msedge) to run
// it in an installed browser instead of Playwright's Chromium.

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const selfsigned = require('selfsigned');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');

// Mirrors src/config.js STORAGE_KEYS (a CommonJS test can't import the module).
const STORAGE_KEYS = {
  AUTH_MODE: 'lexi_auth_mode',
  EXTENSION_TOKEN: 'lexi_extension_token',
  SITE_GRANTS: 'lexi_site_grants',
  BRIDGE_SITES: 'lexi_bridge_sites',
};

const FAKE_TOKEN = 'lexiext_test_bridge_000000000000000000000000';
const SCC = 'https://www.scconline.com';
const TARGET_QUOTE = 'no one shall be condemned unheard, and the order passed without notice cannot stand';

// ---------------------------------------------------------------------------
// "SCC Online" fixture pages
// ---------------------------------------------------------------------------

function judgmentHtml() {
  const paras = [];
  for (let n = 1; n <= 30; n += 1) {
    let body = `In paragraph ${n} the Court considered the record, the submissions and the precedents cited at the bar.`;
    if (n === 12) body = `We are clear that ${TARGET_QUOTE}. ${body}`;
    paras.push(`<p>${n}. ${body}</p>`);
    if (n === 8) paras.push('<p>Page 126</p>');
    if (n === 20) paras.push('<p>Page 127</p>');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>State of Example v. Rao</title></head>
<body><h1>State of Example v. Rao</h1>
<p class="cite">(2019) 4 SCC 123</p>
<p>Page 125</p>
${paras.join('\n')}
</body></html>`;
}

const SCC_PAGES = {
  '/': `<!doctype html><html><head><meta charset="utf-8"><title>SCC Online</title></head>
<body><form action="/results" method="get" role="search">
<input type="search" name="q" aria-label="Search judgments"><button type="submit">Search</button>
</form></body></html>`,
  '/results': `<!doctype html><html><head><meta charset="utf-8"><title>Results</title></head>
<body><h1>Results</h1><p><a href="/judgment/2019-4-scc-123">State of Example v. Rao</a></p></body></html>`,
  '/judgment/2019-4-scc-123': judgmentHtml(),
  '/feedback': `<!doctype html><html><head><meta charset="utf-8"><title>Feedback</title></head>
<body><form action="/thanks" method="post">
<label>Your name <input name="name"></label>
<label>Comment <textarea name="comment"></textarea></label>
<button type="submit">Submit feedback</button>
</form></body></html>`,
  '/login': `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head>
<body><form action="/session" method="post">
<label>Email <input name="email" type="email"></label>
<label>Password <input name="password" type="password"></label>
</form></body></html>`,
};

// The sites are served over loopback HTTPS: the browser resolves their hosts
// to this server (--host-resolver-rules) and every other host to nothing, so
// no request leaves the machine. (Playwright's context.route does not reliably
// catch the first load of a tab the extension creates.)
const SITE_HOSTS = ['www.scconline.com', 'scconline.com', 'indiankanoon.org'];

async function startSiteServer() {
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'lexi-bridge-test' }], { days: 1 });
  return https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
    const host = String(req.headers.host || '').split(':')[0];
    const page = host === 'indiankanoon.org'
      ? '<title>Indian Kanoon</title><p>Search</p>'
      : SCC_PAGES[new URL(req.url, 'https://x').pathname];
    if (!page) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
}

// ---------------------------------------------------------------------------
// Mock Lexi backend: ticket endpoint + bridge WebSocket
// ---------------------------------------------------------------------------

function startMockLexi() {
  const state = { ticketCalls: [], tickets: new Set(), frames: [], closes: [], socket: null };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/extension/bridge/ticket') {
      state.ticketCalls.push({ authorization: req.headers.authorization });
      if (req.headers.authorization !== `Bearer ${FAKE_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"detail":"Invalid or expired token"}');
        return;
      }
      const ticket = crypto.randomUUID();
      state.tickets.add(ticket);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ticket, expires_in: 60 }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://mock');
    if (url.pathname !== '/api/extension/bridge/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!state.tickets.delete(url.searchParams.get('ticket'))) {
        ws.close(4401, 'bad ticket');
        return;
      }
      state.socket = ws;
      ws.send(JSON.stringify({ type: 'welcome', connection_id: 'conn-1' }));
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data));
        state.frames.push(frame);
        if (frame.type === 'ping') ws.send('{"type":"pong"}');
      });
      ws.on('close', (code) => {
        state.closes.push(code);
        if (state.socket === ws) state.socket = null;
      });
    });
  });

  let seq = 0;
  async function command(op, session, args = {}) {
    const id = `cmd-${(seq += 1)}`;
    state.socket.send(JSON.stringify({ type: 'command', id, op, session, args }));
    let reply;
    await expect
      .poll(() => (reply = state.frames.find((f) => f.type === 'result' && f.id === id)), { timeout: 45000 })
      .toBeTruthy();
    return reply;
  }

  return { server, state, command };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Test-only extension copy: identical product code; the backend pointed at
// the mock, and host access to SCC Online granted at install (in the product
// the settings page requests it when the user switches the site on).
function buildTestExtensionCopy(mockOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-bridge-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [
    ...(manifest.host_permissions || []),
    `${mockOrigin}/*`,
    'https://scconline.com/*',
    'https://*.scconline.com/*',
  ];
  const wsOrigin = mockOrigin.replace(/^http/, 'ws');
  manifest.content_security_policy.extension_pages += ` ${mockOrigin} ${wsOrigin}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const configPath = path.join(dir, 'src', 'config.js');
  const before = fs.readFileSync(configPath, 'utf8');
  const after = before
    .replace(/api_base:\s*'https:\/\/api\.getlexi\.io'/, `api_base: '${mockOrigin}'`)
    .replace(/export const RUNTIME_CONFIG_URL = '[^']*';/, `export const RUNTIME_CONFIG_URL = '${mockOrigin}/__none__';`);
  if (!after.includes(`api_base: '${mockOrigin}'`) || !after.includes('/__none__')) {
    throw new Error('buildTestExtensionCopy: config.js shape changed');
  }
  fs.writeFileSync(configPath, after);
  return dir;
}

// The browser with the extension loaded, and the extension's service worker.
// LEXI_BROWSER_CHANNEL picks it: Playwright's Chromium by default, msedge
// where that can't start (e.g. a managed Windows machine that blocks unsigned
// binaries), or chrome. Google Chrome ignores --load-extension since 137, so
// there the extension goes in through the DevTools protocol
// (Extensions.loadUnpacked), which needs --enable-unsafe-extension-debugging
// and Playwright's default --disable-extensions left off.
async function launchWithExtension(userDataDir, extDir, args) {
  const channel = process.env.LEXI_BROWSER_CHANNEL || 'chromium';
  if (channel !== 'chrome') {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, ...args],
    });
    const [sw] = context.serviceWorkers();
    return { context, sw: sw || (await context.waitForEvent('serviceworker', { timeout: 15000 })) };
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', ...args],
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  const ours = (worker) => new URL(worker.url()).host === id;
  const sw =
    context.serviceWorkers().find(ours) ||
    (await context.waitForEvent('serviceworker', { predicate: ours, timeout: 15000 }));
  return { context, sw };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe('browser bridge — real extension, mock Lexi backend', () => {
  test.describe.configure({ mode: 'serial' });

  let context;
  let sw;
  let extensionId;
  let mock;
  let mockOrigin;
  let siteServer;
  let userDataDir;
  let extDir;

  test.beforeAll(async () => {
    mock = startMockLexi();
    mockOrigin = `http://127.0.0.1:${await listen(mock.server)}`;
    siteServer = await startSiteServer();
    const sitePort = await listen(siteServer);
    const resolverRules = [
      ...SITE_HOSTS.map((host) => `MAP ${host} 127.0.0.1:${sitePort}`),
      'MAP * ~NOTFOUND',
      'EXCLUDE 127.0.0.1',
    ].join(', ');
    extDir = buildTestExtensionCopy(mockOrigin);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-bridge-'));
    ({ context, sw } = await launchWithExtension(userDataDir, extDir, [
      '--no-first-run',
      `--host-resolver-rules=${resolverRules}`,
      '--ignore-certificate-errors',
    ]));
    extensionId = new URL(sw.url()).host;
    if (process.env.LEXI_DEBUG_SW) sw.on('console', (m) => console.log(`[sw ${m.type()}] ${m.text()}`));
  });

  test.afterAll(async () => {
    if (context) await context.close();
    for (const server of [mock && mock.server, siteServer]) {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of [userDataDir, extDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const setStorage = (values) => sw.evaluate((v) => chrome.storage.local.set(v), values);
  const sessionTabs = () =>
    sw.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.scconline.com/*' });
      return Promise.all(
        tabs.map(async (t) => ({
          id: t.id,
          url: t.url,
          active: t.active,
          group: t.groupId === -1 ? null : (await chrome.tabGroups.get(t.groupId)).title,
        })),
      );
    });

  async function refByName(session, name) {
    const read = await mock.command('tool', session, { name: 'read_page', input: { mode: 'interactive' } });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const el = read.result.elements.find((e) => e.name === name);
    expect(el, `no "${name}" in ${JSON.stringify(read.result.elements.map((e) => e.name))}`).toBeTruthy();
    return el.ref;
  }

  test('stays off until the user switches a site on, then connects with a ticket and says hello', async () => {
    await setStorage({ [STORAGE_KEYS.AUTH_MODE]: 'account', [STORAGE_KEYS.EXTENSION_TOKEN]: FAKE_TOKEN });
    await new Promise((r) => setTimeout(r, 1500));
    expect(mock.state.ticketCalls).toHaveLength(0);

    await setStorage({ [STORAGE_KEYS.BRIDGE_SITES]: ['scconline.com'] });
    await expect.poll(() => mock.state.frames.find((f) => f.type === 'hello'), { timeout: 15000 }).toBeTruthy();
    expect(mock.state.ticketCalls[0].authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    const hello = mock.state.frames.find((f) => f.type === 'hello');
    expect(hello).toMatchObject({ protocol: 1, sites: ['scconline.com'] });
    expect(typeof hello.extension_version).toBe('string');

    // The settings page shows the bridge as connected, with SCC Online on.
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
    await expect(options.locator('#bridge-status')).toHaveText(/^Connected/);
    await expect(options.locator('#bridge-site-scc')).toBeChecked();
    await expect(options.locator('#bridge-site-manupatra')).not.toBeChecked();
    await options.close();
  });

  test('open puts a background tab on the site, in the Lexi tab group', async () => {
    const reply = await mock.command('open', 's1', { url: `${SCC}/`, allowed_hosts: ['scconline.com'] });
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(reply.result).toMatchObject({ url: `${SCC}/`, title: 'SCC Online' });
    const tabs = await sessionTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ active: false, group: 'Lexi' });
  });

  // Chat sends its next command the moment open or navigate answers, and the
  // extension answers it within milliseconds (a live run lost those quick
  // replies to a backend pub/sub race; here the extension's side is pinned).
  test('a command sent the moment a page has loaded is answered', async () => {
    const quick = (name, input) => mock.command('tool', 'quick', { name, input });
    const opened = await mock.command('open', 'quick', { url: `${SCC}/`, allowed_hosts: ['scconline.com'] });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    const read = await quick('read_page', { mode: 'interactive' });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    expect(read.result.elements.map((e) => e.name)).toContain('Search judgments');

    const nav = await quick('navigate', { url: `${SCC}/judgment/2019-4-scc-123` });
    expect(nav.ok, JSON.stringify(nav)).toBe(true);
    const found = await quick('find_text', { query: TARGET_QUOTE });
    expect(found.ok, JSON.stringify(found)).toBe(true);
    expect(found.result.results[0]).toMatchObject({ para: '12', page: '126' });

    expect(await mock.command('close', 'quick', {})).toMatchObject({ ok: true });
  });

  test('search, follow the result, and pin the quote to its paragraph and reporter page', async () => {
    const box = await refByName('s1', 'Search judgments');
    const typed = await mock.command('tool', 's1', {
      name: 'type_text',
      input: { ref: box, text: 'State of Example v. Rao', submit: true },
    });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    const landed = await mock.command('tool', 's1', { name: 'wait_for', input: { url_contains: '/results' } });
    expect(landed.result.matched).toBe(true);

    const link = await refByName('s1', 'State of Example v. Rao');
    const clicked = await mock.command('tool', 's1', { name: 'click', input: { ref: link } });
    expect(clicked.ok, JSON.stringify(clicked)).toBe(true);
    const opened = await mock.command('tool', 's1', { name: 'wait_for', input: { text: '4 SCC 123' } });
    expect(opened.result.matched).toBe(true);
    expect(opened.result.page.url).toBe(`${SCC}/judgment/2019-4-scc-123`);

    const found = await mock.command('tool', 's1', { name: 'find_text', input: { query: TARGET_QUOTE } });
    expect(found.ok, JSON.stringify(found)).toBe(true);
    expect(found.result.match).toBe('exact');
    expect(found.result.results[0]).toMatchObject({ para: '12', page: '126' });

    const read = await mock.command('tool', 's1', { name: 'read_page', input: { mode: 'text' } });
    expect(read.result.text).toContain('(2019) 4 SCC 123');
  });

  test('anything needing a confirmation is refused, even with a stored grant or a disguised name', async () => {
    await setStorage({
      [STORAGE_KEYS.SITE_GRANTS]: {
        [SCC]: { agentEnabled: false, classes: ['SUBMIT', 'CLICK', 'TYPE'], onceGrants: [], expiresAt: null },
      },
    });
    const nav = await mock.command('tool', 's1', { name: 'navigate', input: { url: `${SCC}/feedback` } });
    expect(nav.ok, JSON.stringify(nav)).toBe(true);
    const button = await refByName('s1', 'Submit feedback');
    const reply = await mock.command('tool', 's1', {
      name: 'click',
      input: { ref: button, elementName: 'Read more' },
    });
    expect(reply).toMatchObject({ ok: false, code: 'needs_confirmation' });

    const field = await refByName('s1', 'Your name');
    const submit = await mock.command('tool', 's1', {
      name: 'type_text',
      input: { ref: field, text: 'A', submit: true },
    });
    expect(submit).toMatchObject({ ok: false, code: 'needs_confirmation' });
  });

  test('a password field is refused', async () => {
    await mock.command('tool', 's1', { name: 'navigate', input: { url: `${SCC}/login` } });
    const field = await refByName('s1', 'Password');
    const reply = await mock.command('tool', 's1', { name: 'type_text', input: { ref: field, text: 'hunter2' } });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/password/i);
  });

  test('sites the user did not switch on are refused, at open and on navigation', async () => {
    const open = await mock.command('open', 's2', {
      url: 'https://indiankanoon.org/',
      allowed_hosts: ['indiankanoon.org'],
    });
    expect(open).toMatchObject({ ok: false, code: 'site_not_enabled' });

    // Asking for more hosts than the user allows narrows the scope to theirs.
    const widened = await mock.command('open', 's3', {
      url: `${SCC}/`,
      allowed_hosts: ['scconline.com', 'indiankanoon.org'],
    });
    expect(widened.ok).toBe(true);
    const off = await mock.command('tool', 's3', { name: 'navigate', input: { url: 'https://indiankanoon.org/' } });
    expect(off).toMatchObject({ ok: false, code: 'blocked' });

    const tool = await mock.command('tool', 's3', { name: 'screenshot', input: {} });
    expect(tool).toMatchObject({ ok: false, code: 'bad_request' });
  });

  test('close ends the session and closes its tab; later calls say no_session', async () => {
    const closed = await mock.command('close', 's3', {});
    expect(closed).toMatchObject({ ok: true, result: { closed: true } });
    await expect.poll(async () => (await sessionTabs()).length).toBe(1); // s1's tab is left
    const after = await mock.command('tool', 's3', { name: 'read_page', input: {} });
    expect(after).toMatchObject({ ok: false, code: 'no_session' });
    expect(await mock.command('close', 's3', {})).toMatchObject({ ok: true });
  });

  test('closing a session tab tells the server', async () => {
    const [tab] = await sessionTabs();
    await sw.evaluate((id) => chrome.tabs.remove(id), tab.id);
    await expect
      .poll(() => mock.state.frames.find((f) => f.type === 'ended'), { timeout: 10000 })
      .toMatchObject({ session: 's1', reason: 'tab_closed' });
    const after = await mock.command('tool', 's1', { name: 'read_page', input: {} });
    expect(after).toMatchObject({ ok: false, code: 'no_session' });
  });

  test('switching every site off closes the connection', async () => {
    await setStorage({ [STORAGE_KEYS.BRIDGE_SITES]: [] });
    await expect.poll(() => mock.state.closes.length, { timeout: 10000 }).toBe(1);
    expect(mock.state.closes[0]).toBe(1000);
    expect(mock.state.socket).toBeNull();
  });

  test('a rejected session token signs the extension out instead of retrying', async () => {
    const ticketsBefore = mock.state.ticketCalls.length;
    await setStorage({
      [STORAGE_KEYS.EXTENSION_TOKEN]: 'lexiext_revoked_000000000000000000000000000',
      [STORAGE_KEYS.BRIDGE_SITES]: ['scconline.com'],
    });
    await expect
      .poll(() => sw.evaluate((k) => chrome.storage.local.get(k).then((d) => d[k] || null), STORAGE_KEYS.EXTENSION_TOKEN), {
        timeout: 10000,
      })
      .toBeNull();
    expect(mock.state.ticketCalls.length).toBe(ticketsBefore + 1);
    expect(mock.state.socket).toBeNull();
  });
});
