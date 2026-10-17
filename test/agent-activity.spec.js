// test/agent-activity.spec.js
//
// Hermetic check of the Agent Mode activity timeline in the side panel
// (src/sidepanel/agent-activity.js): the run's thinking, each tool step with
// its label, detail and status, the narration between steps and the answer,
// laid out like the Lexi web app's SegmentTimeline. A loopback fixture page
// and a scripted mock model (Anthropic SSE on /api/extension/messages) stand
// in for a real site and the backend.
//
// Run: LEXI_AGENT_ACTIVITY=1 npx playwright test

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');

const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Case search</title></head>
<body>
  <h1>Case search</h1>
  <p>Search the judgments database.</p>
  <form onsubmit="event.preventDefault()">
    <label>Query <input name="q" aria-label="Query"></label>
    <button type="button" onclick="document.body.dataset.searched = '1'">Search</button>
    <button type="button" onclick="document.body.dataset.deleted = '1'">Delete draft</button>
  </form>
</body></html>`;

const ANSWER = 'Found it: **Vishaka v. State of Rajasthan**.';

// One model reply per call, in order. `ref` names an element in the page's
// interactive index, resolved from the request so the mock needs no fixed refs.
const SCRIPT = [
  { delayMs: 1200, text: 'Let me read the page first.', tool: { name: 'read_page', input: {} } },
  {
    thinking: "**Planning**\n\nThe page has a *Query* box; I'll type the case name.",
    tool: { name: 'type_text', input: { ref: 'Query', text: 'Vishaka' } },
  },
  { tool: { name: 'click', input: { ref: 'e999' } } },
  { tool: { name: 'click', input: { ref: 'Delete draft' } } },
  { tool: { name: 'click', input: { ref: 'Search' } } },
  { tool: { name: 'finish', input: { answer: ANSWER } } },
];

function startMockModel() {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/api/extension/auth/session')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { email: 'agent@example.test', tier: 'paid' }, usage: null }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/extension/messages') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      calls.push(body);
      const step = SCRIPT[Math.min(calls.length - 1, SCRIPT.length - 1)];
      if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
      const input = { ...step.tool.input };
      if (input.ref && !/^e\d+$/.test(input.ref)) {
        const escaped = input.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = body.match(new RegExp(`\\[(e\\d+)\\]<[^>]+> ${escaped}(?:\\\\n|$|")`));
        input.ref = m ? m[1] : 'e_missing';
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message: { id: `msg_${calls.length}`, usage: { input_tokens: 10, output_tokens: 0 } } });
      let index = 0;
      if (step.thinking) {
        send('content_block_start', { index, content_block: { type: 'thinking', thinking: '' } });
        send('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: step.thinking } });
        send('content_block_delta', { index, delta: { type: 'signature_delta', signature: 'sig' } });
        send('content_block_stop', { index });
        index += 1;
      }
      if (step.text) {
        send('content_block_start', { index, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index, delta: { type: 'text_delta', text: step.text } });
        send('content_block_stop', { index });
        index += 1;
      }
      send('content_block_start', {
        index,
        content_block: { type: 'tool_use', id: `toolu_${calls.length}`, name: step.tool.name, input: {} },
      });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      send('content_block_stop', { index });
      send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } });
      send('message_stop', {});
      res.end();
    });
  });
  return { server, calls };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Identical product code; the production channel points at the mock and the
// runtime-config fetch is disabled so nothing reaches the real backend.
function buildTestExtensionCopy(mockOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-agent-activity-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>'];
  manifest.content_security_policy.extension_pages += ` ${mockOrigin}`;
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

test.describe('agent activity timeline', () => {
  test.describe.configure({ mode: 'serial' });

  let context;
  let page;
  let panel;
  let fixtureServer;
  let mock;
  let userDataDir;
  let extDir;

  test.beforeAll(async () => {
    fixtureServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE_HTML);
    });
    const fixtureOrigin = `http://127.0.0.1:${await listen(fixtureServer)}`;
    mock = startMockModel();
    const mockOrigin = `http://127.0.0.1:${await listen(mock.server)}`;

    extDir = buildTestExtensionCopy(mockOrigin);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-agent-activity-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;

    // Signed in, Agent Mode enabled on the fixture site, trusted approval (a
    // delete still asks: it is a risky class in every mode).
    await sw.evaluate(
      (origin) =>
        chrome.storage.local.set({
          lexi_auth_mode: 'account',
          lexi_extension_token: 'lexiext_test_activity',
          lexi_account_info: { email: 'agent@example.test', tier: 'paid' },
          lexi_approval_mode: 'trusted',
          lexi_site_grants: { [origin]: { agentEnabled: true, classes: [], expiresAt: null, onceGrants: [] } },
        }),
      fixtureOrigin,
    );

    page = await context.newPage();
    await page.goto(`${fixtureOrigin}/`, { waitUntil: 'load' });
    const tabId = await sw.evaluate(
      () => new Promise((resolve) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t[0]?.id))),
    );
    expect(tabId).toBeTruthy();
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`, {
      waitUntil: 'load',
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    for (const server of [fixtureServer, mock && mock.server]) {
      if (server) await new Promise((resolve) => server.close(resolve));
    }
    for (const dir of [userDataDir, extDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('titles, details and thinking text; a run split by a question; a stopped run', async () => {
    const out = await panel.evaluate(async () => {
      const m = await import('/src/sidepanel/agent-activity.js');
      const box = document.createElement('div');
      document.body.appendChild(box);
      const texts = (sel, root = box) => [...root.querySelectorAll(sel)].map((n) => n.textContent);

      // A group ends when something else lands below the run's message: the
      // run carries on in a new message underneath.
      const a = m.createAgentActivity(box);
      a.thinking();
      const liveTitle = texts('.lexi-seg-title')[0];
      const liveWait = texts('.lexi-thinking-wait')[0];
      a.toolIntent({ id: 't1', name: 'read_page' });
      const afterIntent = texts('.lexi-thinking-wait').length;
      a.toolResult({ id: 't1', ok: true });
      const note = document.createElement('div');
      note.textContent = 'Lexi needs your input';
      box.appendChild(note);
      a.thinking();
      a.toolIntent({ id: 't2', name: 'navigate', input: { url: 'https://example.com/' } });
      const split = {
        messages: box.querySelectorAll('.lexi-agent-msg').length,
        firstTitle: texts('.lexi-seg-title')[0],
        firstEnd: texts('.lexi-step-end-text')[0],
        firstOpen: !box.querySelector('.lexi-seg-body').hidden,
      };
      // Stop with a step still running.
      a.finish('stopped');
      const stopped = {
        badge: texts('.lexi-step-badge'),
        ends: texts('.lexi-step-end-text'),
        collapsed: [...box.querySelectorAll('.lexi-seg-body')].every((b) => b.hidden),
        label: texts('.lexi-step-label').at(-1),
      };
      box.remove();

      return {
        liveTitle,
        liveWait,
        afterIntent,
        split,
        stopped,
        titles: [
          m.segmentTitle(['read_page']),
          m.segmentTitle(['read_page', 'type_text', 'click', 'click']),
          m.segmentTitle(['read_page', 'type_text', 'click', 'scroll']),
          m.segmentTitle([]),
          m.segmentTitle(['web_search']),
        ],
        details: [
          m.stepDetail('type_text', { ref: 'e3', text: 'x'.repeat(60) }, 'Query'),
          m.stepDetail('click', { ref: 'e7' }, null),
          m.stepDetail('press_key', { keys: 'Enter' }),
          m.stepDetail('read_page', { mode: 'text' }),
          m.stepDetail('web_search', { query: 'bail', limit: 3 }),
        ],
        thought: m.plainThinking('**Planning**\n\nThe *Query* box takes __names__.\n\n**Next**\nType it.'),
      };
    });

    expect(out.liveTitle).toBe('Thinking…');
    expect(out.liveWait).toBe('Thinking…');
    expect(out.afterIntent).toBe(0);
    expect(out.split).toEqual({ messages: 2, firstTitle: 'Read the page', firstEnd: 'Done', firstOpen: true });
    expect(out.stopped).toEqual({ badge: ['stopped'], ends: ['Done', 'Stopped'], collapsed: true, label: 'Open page' });
    expect(out.titles).toEqual([
      'Read the page',
      'Read the page, typed and clicked',
      'Read the page, typed, clicked and more',
      'Thought it over',
      'Used Web Search',
    ]);
    expect(out.details).toEqual([
      `text: ${'x'.repeat(47)}… · field: Query`,
      'element: e7',
      'keys: Enter',
      '',
      'query: bail · limit: 3',
    ]);
    expect(out.thought).toBe('The Query box takes names.\n\nType it.');
  });

  test('a real run: thinking, steps with labels and status, narration, the answer, then one collapsed group', async () => {
    test.setTimeout(90_000);
    await panel.locator('#mode-agent-btn').click();
    await panel.locator('#prompt-input').fill('Search for Vishaka and tell me what you find.');
    await panel.locator('#send-btn').click();

    const msg = panel.locator('.lexi-agent-msg').last();
    // While the model works out the first step: an open group headed
    // "Thinking…" with a pulsing "Thinking…" row.
    await expect(msg.locator('.lexi-thinking-wait')).toHaveText('Thinking…', { timeout: 15_000 });
    await expect(msg.locator('.lexi-seg-title').first()).toHaveText('Thinking…');

    // The delete asks for approval: its row waits, labelled while running.
    const card = panel.locator('.lexi-confirm-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    const deleteRow = msg.locator('.lexi-step-tool[data-status="running"]');
    await expect(deleteRow.locator('.lexi-step-label')).toHaveText('Clicking');
    await expect(deleteRow.locator('.lexi-step-detail')).toHaveText('element: Delete draft');
    await expect(deleteRow.locator('.lexi-step-progress')).toHaveText('Waiting for your approval…');
    await expect(deleteRow.locator('.lexi-step-spinner')).toBeVisible();
    await expect(msg.locator('.lexi-seg-title').last()).toHaveText('Thinking…');
    await panel.locator('#confirm-deny').click();

    // The run finishes: narration, one collapsed group, then the answer.
    await expect(msg.locator('.lexi-agent-answer')).toContainText('Found it: Vishaka v. State of Rajasthan.', {
      timeout: 30_000,
    });
    await expect(msg.locator('.lexi-agent-answer strong')).toHaveText('Vishaka v. State of Rajasthan');
    const order = await msg.evaluate((root) =>
      [...root.children].map((c) =>
        c.classList.contains('lexi-seg') ? 'group' : c.classList.contains('lexi-agent-narration') ? 'narration' : c.classList.contains('lexi-agent-answer') ? 'answer' : c.className,
      ),
    );
    expect(order).toEqual(['narration', 'group', 'answer']);
    await expect(msg.locator('.lexi-agent-narration')).toHaveText('Let me read the page first.');
    const group = msg.locator('.lexi-seg');
    await expect(group.locator('.lexi-seg-title')).toHaveText('Read the page, typed and clicked');
    await expect(group.locator('.lexi-seg-body')).toBeHidden();
    await expect(group.locator('.lexi-seg-head')).toHaveAttribute('aria-expanded', 'false');

    // Opening it shows every step in order, then "Done".
    await group.locator('.lexi-seg-head').click();
    await expect(group.locator('.lexi-seg-body')).toBeVisible();
    const rows = await group.locator('.lexi-step').evaluateAll((els) =>
      els.map((r) => ({
        kind: r.classList.contains('lexi-step-tool') ? r.dataset.tool : r.classList.contains('lexi-thought') ? 'thought' : 'end',
        status: r.dataset.status || null,
        label: (r.querySelector('.lexi-step-label') || r.querySelector('.lexi-thought-text') || r.querySelector('.lexi-step-end-text')).textContent,
        detail: r.querySelector('.lexi-step-detail')?.textContent || null,
        badge: r.querySelector('.lexi-step-badge')?.textContent || null,
        check: !!r.querySelector('.lexi-step-check'),
        icon: r.querySelector('.lexi-step-icon')?.dataset.icon || null,
      })),
    );
    expect(rows).toEqual([
      { kind: 'read_page', status: 'ok', label: 'Read the page', detail: null, badge: null, check: true, icon: 'file-text' },
      { kind: 'thought', status: null, label: "The page has a Query box; I'll type the case name.", detail: null, badge: null, check: false, icon: 'clock' },
      { kind: 'type_text', status: 'ok', label: 'Typed', detail: 'text: Vishaka · field: Query', badge: null, check: true, icon: 'text-cursor-input' },
      { kind: 'click', status: 'error', label: 'Click', detail: 'element: e999', badge: 'error', check: false, icon: 'mouse-pointer-click' },
      { kind: 'click', status: 'denied', label: 'Click', detail: 'element: Delete draft', badge: 'denied', check: false, icon: 'mouse-pointer-click' },
      { kind: 'click', status: 'ok', label: 'Clicked', detail: 'element: Search', badge: null, check: true, icon: 'mouse-pointer-click' },
      { kind: 'end', status: null, label: 'Done', detail: null, badge: null, check: false, icon: 'circle-check' },
    ]);

    // The failed click explains itself on request.
    const failed = group.locator('.lexi-step-tool[data-status="error"]');
    await expect(failed.locator('.lexi-step-result-text')).toHaveCount(0);
    await failed.locator('.lexi-step-chip').click();
    await expect(failed.locator('.lexi-step-result-text')).not.toBeEmpty();

    // The tool behind each step is named on hover.
    await expect(group.locator('.lexi-step-tool .lexi-step-label').first()).toHaveAttribute('title', 'Tool: read_page');

    // The page saw the search click and not the denied delete.
    expect(await page.evaluate(() => ({ ...document.body.dataset }))).toEqual({ searched: '1' });
    expect(mock.calls).toHaveLength(SCRIPT.length);
  });
});
