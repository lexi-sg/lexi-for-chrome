// test/agent-tools.spec.js
//
// Hermetic tests for the general Agent Mode capabilities: find_text (whole-page
// search with paragraph/page context), wait_for, select_option, a run's host
// allowlist (scope), and the sign-in / CAPTCHA hand-over. No ANTHROPIC_API_KEY,
// no live network: the fixture pages and a scripted Anthropic-shaped model are
// served from loopback, and the agent loop runs against that mock.
//
// Run: LEXI_AGENT_TOOLS=1 npx playwright test
// (opt-in behind LEXI_AGENT_TOOLS, like the other non-default suites — see
// playwright.config.js).
//
// 127.0.0.1 and localhost reach the same fixture server; scoped runs allow
// 127.0.0.1 only, so localhost stands in for "a site outside the scope".

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const http = require('node:http');
const { test, expect, chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIND_TEXT_FILE = path.join(REPO_ROOT, 'src', 'content', 'find-text.js');
const LEGACY_FIXTURES_FILE = path.join(__dirname, 'test-fixtures.html');

// The quote the suite looks for: it sits in paragraph 27 of the judgment
// fixture, past the stretch read_page cuts from long pages, after the
// reporter's page-412 marker, with a footnote mark inside it.
const TARGET_QUOTE =
  'the right to be heard before an adverse order is passed is an essential facet of fairness in every proceeding';
const TARGET_PARA = '27';
const TARGET_PAGE = '412';

// ---------------------------------------------------------------------------
// Matcher (pure) — find-text.js loaded under node:vm
// ---------------------------------------------------------------------------

function loadFindText() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(FIND_TEXT_FILE, 'utf8'), sandbox);
  return sandbox.__lexi.findText;
}

const JUDGMENT_LINES = [
  'IN THE SUPREME COURT OF INDIA',
  '1. Natural justice.',
  '2. Livelihood.',
  '3. Costs.',
  '1. This appeal arises from the order of the High Court dated 12.03.2019.',
  '2. The appellant contends that the right to life under Article 21 includes the right to livelihood.',
  '3. Section 5 of the Act reads:',
  '(1) Every person shall be heard.',
  '(2) No order shall be passed without notice.',
  '4. We have considered the rival submissions [*345] and find that the eviction was arbitrary.',
  '5. Two questions arise:',
  '1. Whether the eviction was lawful?',
  '2. Whether compensation is due?',
  '6. For the reasons above, the appeal is allowed.',
  'Page 346',
  '7. No order as to costs. The Court directs consti- tution of a committee.',
];

test.describe('find_text matcher (pure)', () => {
  const ft = loadFindText();
  const paras = ft.buildParas(JUDGMENT_LINES.map((text) => ({ text })));

  function find(query) {
    const res = ft.matchQuote(paras, query);
    return { ...res, results: res.hits.map((h) => ft.describeHit(paras, h)) };
  }

  test('normalization folds case, curly quotes, footnote marks, hyphens and spacing', () => {
    const norm = (s) => ft.normalizeWithMap(s).text;
    expect(norm('The  “Right” to Life¹')).toBe('the "right" to life');
    expect(norm('consti-\n tution of self-defence[12]')).toBe('constitution of selfdefence');
    expect(ft.queryFragments('“The appellant contends … the right to livelihood.”')).toEqual([
      'the appellant contends',
      'the right to livelihood',
    ]);
  });

  test('numbered paragraphs: the body numbering wins; quoted sub-clauses and inner lists stay inside their paragraph', () => {
    const labels = paras.map((p) => p.label);
    // Headnotes 1-3, then the judgment's own 1-7. "(1)", "(2)" (a quoted
    // section) and the "1.", "2." list inside paragraph 5 are not paragraphs.
    expect(labels).toEqual([null, '1', '2', '3', '1', '2', '3', '4', '5', '6', '7']);
    expect(paras[6].text).toContain('(1) Every person shall be heard.');
    expect(paras[8].text).toContain('1. Whether the eviction was lawful?');
  });

  test('exact match reports the paragraph and the page marker in effect', () => {
    const r = find('find that the eviction was arbitrary');
    expect(r.match).toBe('exact');
    expect(r.results[0]).toMatchObject({ para: '4', page: '345' });
    expect(find('the appeal is allowed').results[0]).toMatchObject({ para: '6', page: '345' });
    expect(find('No order as to costs').results[0]).toMatchObject({ para: '7', page: '346' });
  });

  test('a quote across two paragraphs is a span ("1-2")', () => {
    const r = find('dated 12.03.2019. The appellant contends');
    expect(r.match).toBe('span');
    expect(r.results[0].para).toBe('1-2');
  });

  test('"..." skips omitted words; hyphenated line breaks still match', () => {
    expect(find('The appellant contends ... the right to livelihood').results[0].para).toBe('2');
    expect(find('constitution of a committee').results[0].para).toBe('7');
  });

  test('near-verbatim text is a fuzzy match at >= 0.90; anything weaker is not_found', () => {
    const r = find('the right to life under article 21 include the right of livelyhood');
    expect(r.match).toBe('fuzzy');
    expect(r.score).toBeGreaterThanOrEqual(0.9);
    expect(r.results[0].para).toBe('2');
    const miss = find('the right to property under article 300A includes compensation for land');
    expect(miss.match).toBe('not_found');
    expect(miss.results).toEqual([]);
  });

  test('every exact occurrence is returned in document order', () => {
    const r = find('order');
    expect(r.match).toBe('exact');
    expect(r.total).toBe(3);
    expect(r.results.map((x) => x.para)).toEqual(['1', '3', '7']);
  });
});

// Shapes seen in judgment text taken from court PDFs (indiankanoon.org): the
// number in its own column, footnote bodies that start with a number, and
// citations that open with a year.
test.describe('find_text matcher — PDF-derived judgment text (pure)', () => {
  const ft = loadFindText();
  const labelsOf = (lines) => ft.buildParas(lines.map((text) => ({ text }))).map((p) => p.label);

  test('a bare number counts when set off by spaces, or by one space before a sentence', () => {
    const lines = [
      '97         The petitioners rely on the covenants India has ratified under Articles 14 and',
      '21 of the Constitution, read with the Directive Principles.',
      '98         Those covenants are recognised rules and principles.',
      '99         The obligations extend to privacy and dignity.',
      '100 The human rights treaties require equal protection of the law.',
      '101 The Committee has said that other status includes orientation.',
    ];
    // "21 of the Constitution" is a wrapped line, not paragraph 21.
    expect(labelsOf(lines)).toEqual(['97', '98', '99', '100', '101']);
  });

  test('footnote bodies are not paragraphs: their numbers were cited earlier glued to a word', () => {
    const lines = [
      'Author: Example J',
      '1      The petitioners challenge the provision in its present form.',
      '2      The provision was enacted in another epoch.4',
      '3      History owes an apology to the members of this community.5 Its reach was harsh.6',
      '4      Maneka Gandhi v Union of India, (1978) 1 SCC 248.',
      '5      Kharak Singh v State of UP, AIR 1963 SC 1295.',
      '6      Gobind v State of MP, (1975) 2 SCC 148.',
    ];
    const paras = ft.buildParas(lines.map((text) => ({ text })));
    expect(paras.map((p) => p.label)).toEqual([null, '1', '2', '3']);
    expect(paras[3].text).toContain('Kharak Singh v State of UP');
  });

  test('a footnote printed between two paragraphs never stands in for the paragraph with its number', () => {
    const lines = [
      '1      The petitioners challenge the provision in its present form.',
      '2      The provision was enacted in another epoch.4',
      '3      History owes an apology to the members of this community.5',
      '4      Maneka Gandhi v Union of India, (1978) 1 SCC 248.',
      '5      Kharak Singh v State of UP, AIR 1963 SC 1295.',
      '4      The respondents defend the provision as a reasonable restriction.',
      '5      We are unable to accept that defence.',
    ];
    expect(labelsOf(lines)).toEqual(['1', '2', '3', '4', '5']);
  });

  test('a later run must restart the numbering or carry it on; citation years are not numbers', () => {
    const lines = [
      '1      The petitioners challenge the provision in its present form.',
      '2      The provision was enacted in another epoch.',
      '3      Its reach was harsh.',
      'Notes',
      '229    Dominic McGoldrick, The Development and Status of Sexual Orientation (2016).',
      '230    Bowers, at para 190.',
      '231    National Coalition, at para 32.',
    ];
    expect(labelsOf(lines)).toEqual(['1', '2', '3']);
    expect(labelsOf(['Notes', '(1970) 1 SCC 248', '(1971) 2 SCC 1', '(1973) 4 SCC 225'])).toEqual([null]);
  });
});

// ---------------------------------------------------------------------------
// Fixture pages
// ---------------------------------------------------------------------------

const FILLER_WORDS = (
  'record submission tribunal evidence statute notice hearing counsel petition reasoning ' +
  'precedent jurisdiction remand affidavit inquiry finding compliance authority discretion'
).split(' ');

function filler(n, sentences) {
  const out = [];
  for (let s = 0; s < sentences; s += 1) {
    const words = [];
    for (let w = 0; w < 14; w += 1) words.push(FILLER_WORDS[(n * 7 + s * 5 + w * 3) % FILLER_WORDS.length]);
    out.push(`In paragraph ${n} the ${words.join(' ')} were examined at stage ${s + 1}.`);
  }
  return out.join(' ');
}

function judgmentHtml() {
  const paras = [];
  for (let n = 1; n <= 40; n += 1) {
    let body = filler(n, 14);
    if (n === 9) {
      paras.push(`<p>${n}. Section 11 of the Act reads:</p>`);
      paras.push('<p class="quote">(1) Every person shall be heard.</p>');
      paras.push(`<p class="quote">(2) No order shall be passed without notice. ${body}</p>`);
      continue;
    }
    if (n === 15) {
      paras.push(`<p>${n}. The questions are: ${body}</p>`);
      paras.push('<p>1. Whether the notice was valid?</p>');
      paras.push('<p>2. Whether the order was reasoned?</p>');
      continue;
    }
    if (n === 16) body = `The notice under Section 11 was never served on the appellant. ${body}`;
    if (n === 26) body = `${body} <span class="pagebreak">Page ${TARGET_PAGE}</span> The respondent relied on the record.`;
    if (n === 27) {
      body =
        `${filler(n, 6)} We hold that the right to be heard<sup>3</sup> before an adverse order is passed is an ` +
        `essential facet of fairness in every proceeding. ${filler(n + 100, 6)}`;
    }
    paras.push(`<p>${n}. ${body}</p>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>State v. Example (Judgment)</title></head>
<body>
<header><nav><form role="search" action="/search"><input id="site-search" name="searchText" placeholder="Search judgments"><button>Search</button></form></nav></header>
<main>
<h1>State v. Example</h1>
<h2>Headnotes</h2>
<p>1. Natural justice requires a hearing.</p>
<p>2. Reasoned orders.</p>
<p>3. Costs.</p>
<h2>JUDGMENT</h2>
${paras.join('\n')}
</main>
</body></html>`;
}

const FORM_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Land records</title></head>
<body>
<form role="search" action="/search" onsubmit="return false"><input id="q" name="q" placeholder="Search records"><button type="button">Search</button></form>
<p><label for="district">District</label>
<select id="district"><option value="">Select district</option><option value="pune">Pune</option><option value="nashik">Nashik</option><option value="nagpur">Nagpur</option></select></p>
<p><label for="tehsil">Tehsil</label><select id="tehsil"><option value="">Select tehsil</option></select></p>
<p><label for="remarks">Remarks</label><textarea id="remarks"></textarea></p>
<p><label for="otp">Enter OTP</label><input id="otp" name="otpCode"></p>
<p><button id="delete-btn" type="button">Delete record</button></p>
<form id="lookup" action="/form" method="get"><input name="survey" aria-label="Survey number"><button>Go</button></form>
<p><input id="legacy" aria-label="Legacy lookup"></p>
<p style="position:relative"><span id="lang-label">EN</span>
<select id="lang" aria-label="Language" style="opacity:0;position:absolute;left:0;top:0;width:60px">
<option value="en">English</option><option value="hi">Hindi</option><option value="mr">Marathi</option></select></p>
<p id="status">Nothing selected</p>
<script>
  document.getElementById('legacy').addEventListener('keydown', (e) => {
    if (e.keyCode === 13) document.getElementById('status').textContent = 'Legacy lookup: ' + e.target.value;
  });
  document.getElementById('lang').addEventListener('change', (e) => {
    document.getElementById('lang-label').textContent = e.target.value.toUpperCase();
  });
  const TEHSILS = { pune: ['Haveli', 'Mulshi', 'Maval'], nashik: ['Igatpuri'], nagpur: ['Kamptee'] };
  const district = document.getElementById('district');
  const tehsil = document.getElementById('tehsil');
  district.addEventListener('change', () => {
    tehsil.innerHTML = '<option value="">Select tehsil</option>';
    setTimeout(() => {
      for (const name of TEHSILS[district.value] || []) {
        const o = document.createElement('option');
        o.value = name.toLowerCase();
        o.textContent = name;
        tehsil.appendChild(o);
      }
    }, 600);
  });
  tehsil.addEventListener('change', () => {
    document.getElementById('status').textContent =
      'Selected: ' + district.options[district.selectedIndex].text + ' / ' + tehsil.options[tehsil.selectedIndex].text;
  });
</script>
</body></html>`;

// Judgment text as indiankanoon.org serves PDF-derived judgments: several
// paragraphs packed into one <p>, set apart only by blank lines in the text,
// the number in its own column, footnote bodies between paragraphs, and an
// inline heading inside a block wrapper (as on wikipedia.org).
const PDF_JUDGMENT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Petitioner v Union of India</title></head>
<body><h1>Petitioner v Union of India</h1>
<div class="heading-wrap"><h2 style="display:inline">Opinion of the Court</h2> <a href="#top">[edit]</a></div>
<p>

1      The petitioners challenge the provision under Articles 14 and
21 of the Constitution as it stood when the petitions were filed.


2      The provision was enacted in another epoch.4


3      History owes an apology to the members of this community and their families.5


4      Maneka Gandhi v Union of India, (1978) 1 SCC 248.


5      Kharak Singh v State of UP, AIR 1963 SC 1295.</p>
<p>4      The respondents defend the provision as a reasonable restriction on liberty.</p>
<p>5      We are unable to accept that defence for the reasons that follow.</p>
</body></html>`;

const LOGIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head>
<body><h1>Sign in to continue</h1>
<form onsubmit="return false"><label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="password"></label><button>Sign in</button></form>
</body></html>`;

const CAPTCHA_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Verify</title></head>
<body><h1>Search records</h1>
<p><img id="captchaImage" src="/no-such-image.png" alt="captcha" width="120" height="40"></p>
<p><label>Type the characters <input name="txtCaptcha"></label></p>
</body></html>`;

// Links a read-only task follows without a prompt, and ones that act.
const LINKS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Links</title></head>
<body><h1 id="top">Results</h1>
<p><a href="/judgment">Kesavananda Bharati v. State of Kerala</a></p>
<p><a href="/logout">Sign out</a></p>
<p><a href="javascript:void(0)">Open panel</a></p>
<p><a href="/judgment.pdf" download>Get the PDF</a></p>
<p><a href="#top">Back to top</a></p>
<p><a href="/items/7" data-method="post">Mark item 7</a></p>
</body></html>`;

function startFixtureServer() {
  const pages = {
    '/links': LINKS_HTML,
    '/judgment': judgmentHtml(),
    '/pdf-judgment': PDF_JUDGMENT_HTML,
    '/form': FORM_HTML,
    '/login': LOGIN_HTML,
    '/captcha': CAPTCHA_HTML,
    '/fixtures': fs.readFileSync(LEGACY_FIXTURES_FILE, 'utf8'),
  };
  return http.createServer((req, res) => {
    const page = pages[(req.url || '').split('?')[0]];
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
// Scripted Anthropic-shaped model (POST /api/extension/messages)
// ---------------------------------------------------------------------------

function startMockModel(script) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'POST',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/extension/messages') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(JSON.parse(body));
      const step = script[Math.min(calls.length - 1, script.length - 1)];
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'access-control-allow-origin': '*',
      });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message: { id: `msg_${calls.length}`, usage: { input_tokens: 10, output_tokens: 0 } } });
      send('content_block_start', {
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_${calls.length}`, name: step.name, input: {} },
      });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
      send('content_block_stop', { index: 0 });
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

// Test-only extension copy: identical product code; <all_urls> host access so
// content scripts inject into the loopback fixtures without a user gesture,
// and the mock model's origin allowed by the extension CSP.
function buildTestExtensionCopy(mockOrigin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-agent-tools-ext-'));
  for (const entry of ['manifest.json', 'icons', 'src']) {
    fs.cpSync(path.join(REPO_ROOT, entry), path.join(dir, entry), { recursive: true });
  }
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...(manifest.host_permissions || []), '<all_urls>'];
  manifest.content_security_policy.extension_pages += ` ${mockOrigin}`;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return dir;
}

// ---------------------------------------------------------------------------
// Browser suite
// ---------------------------------------------------------------------------

test.describe('agent tools — real extension, loopback fixtures, mock model', () => {
  test.describe.configure({ mode: 'serial' });

  let context;
  let sw;
  let page; // the tab the agent works on
  let panel; // an extension page that talks to the SW over the panel Port
  let tabId;
  let fixtureServer;
  let fixturePort;
  let mock;
  let mockOrigin;
  let userDataDir;
  let extDir;

  const allowedUrl = (p) => `http://127.0.0.1:${fixturePort}${p}`;
  const offScopeUrl = (p) => `http://localhost:${fixturePort}${p}`;

  test.beforeAll(async () => {
    fixtureServer = startFixtureServer();
    fixturePort = await listen(fixtureServer);
    mock = startMockModel([
      { name: 'find_text', input: { query: TARGET_QUOTE } },
      { name: 'finish', input: { answer: `Paragraph ${TARGET_PARA}, page ${TARGET_PAGE}.` } },
    ]);
    mockOrigin = `http://127.0.0.1:${await listen(mock.server)}`;

    extDir = buildTestExtensionCopy(mockOrigin);
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-agent-tools-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
    });
    [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;

    page = await context.newPage();
    await page.goto(allowedUrl('/judgment'), { waitUntil: 'load' });
    tabId = await sw.evaluate(
      () => new Promise((resolve) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t[0]?.id))),
    );
    expect(tabId).toBeTruthy();

    panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`, {
      waitUntil: 'load',
    });
    // A Port of our own, shaped exactly like agent-loop.js's portRequest().
    await panel.evaluate(() => {
      const port = chrome.runtime.connect({ name: 'lexi-sidepanel' });
      const waiting = new Map();
      port.onMessage.addListener((msg) => {
        const done = msg && waiting.get(msg.requestId);
        if (done) {
          waiting.delete(msg.requestId);
          done(msg);
        }
      });
      window.__port = port;
      window.__sw = (message) =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          waiting.set(requestId, resolve);
          port.postMessage({ ...message, requestId });
        });
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

  const sw$ = (message) => panel.evaluate((m) => window.__sw(m), message);
  const post = (message) => panel.evaluate((m) => window.__port.postMessage(m), message);
  const exec = (name, input = {}) => sw$({ type: 'EXEC_TOOL', tabId, toolUseId: `t_${Date.now()}`, name, input });
  const policy = (actionClass, name, input = {}, approvalMode = 'manual') =>
    sw$({ type: 'CHECK_SITE_POLICY', tabId, actionClass, approvalMode, name, input });

  async function gotoTab(url) {
    await page.goto(url, { waitUntil: 'load' });
  }

  async function refByName(name) {
    const res = await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'interactive' });
    const el = (res.elements || []).find((e) => e.name === name);
    expect(el, `no element named "${name}" in ${JSON.stringify((res.elements || []).map((e) => e.name))}`).toBeTruthy();
    return el;
  }

  test('find_text finds a quote read_page cut from a long page, with para, page, heading and a ref', async () => {
    await gotoTab(allowedUrl('/judgment'));
    const read = await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'text' });
    expect(read.truncated).toBe(true);
    expect(read.text).not.toContain('essential facet of fairness');

    const found = await exec('find_text', { query: `“${TARGET_QUOTE}.”` });
    expect(found.ok, found.error).toBe(true);
    expect(found.result.match).toBe('exact');
    expect(found.result.results[0]).toMatchObject({ para: TARGET_PARA, page: TARGET_PAGE, heading: 'JUDGMENT' });
    expect(found.result.results[0].snippet).toContain('essential facet of fairness');
    expect(found.result.results[0].snippet.length).toBeLessThan(300);

    // The ref scrolls the paragraph into view.
    const ref = found.result.results[0].ref;
    expect(ref).toMatch(/^e\d+$/);
    expect((await exec('scroll', { direction: 'down', ref })).ok).toBe(true);
    await expect
      .poll(() => page.evaluate((r) => {
        const rect = document.querySelector(`[data-lexi-ref="${r}"]`).getBoundingClientRect();
        return rect.top < window.innerHeight && rect.bottom > 0;
      }, ref))
      .toBe(true);

    // Numbering survives the quoted "(1)"/"(2)" and the inner "1."/"2." list.
    const p16 = await exec('find_text', { query: 'The notice under Section 11 was never served on the appellant' });
    expect(p16.result.results[0].para).toBe('16');

    const fuzzy = await exec('find_text', {
      query: 'the right to be heard before an adverse order is made is an essential facet of fairness in every proceedings',
    });
    expect(fuzzy.result.match).toBe('fuzzy');
    expect(fuzzy.result.results[0].para).toBe(TARGET_PARA);

    const missing = await exec('find_text', { query: 'the doctrine of legitimate expectation binds the state in contract' });
    expect(missing.result).toMatchObject({ match: 'not_found', results: [] });
  });

  test('find_text on PDF-derived text: packed paragraphs, footnotes between them, an inline heading', async () => {
    await gotoTab(allowedUrl('/pdf-judgment'));
    const apology = await exec('find_text', { query: 'History owes an apology to the members of this community' });
    expect(apology.result.results[0]).toMatchObject({ para: '3', heading: 'Opinion of the Court' });
    expect((await exec('find_text', { query: 'a reasonable restriction on liberty' })).result.results[0].para).toBe('4');
    expect((await exec('find_text', { query: 'We are unable to accept that defence' })).result.results[0].para).toBe('5');
    // A footnote body belongs to the paragraph it is printed under, and the
    // wrapped "21 of the Constitution" is still paragraph 1.
    expect((await exec('find_text', { query: 'Kharak Singh v State of UP' })).result.results[0].para).toBe('3');
    expect((await exec('find_text', { query: 'as it stood when the petitions were filed' })).result.results[0].para).toBe('1');
  });

  test('without the debugger, Enter still submits a form and reaches keyCode handlers; a transparent select is usable', async () => {
    await gotoTab(allowedUrl('/form'));
    // Enter in a field outside a search is a SUBMIT: approve it the way the
    // panel does, then execute under the same tool-use id.
    const approvedSubmit = async (toolUseId, input) => {
      await sw$({ type: 'CONFIRM_RESPONSE', tabId, toolUseId, approved: true, actionClass: 'SUBMIT' });
      return sw$({ type: 'EXEC_TOOL', tabId, toolUseId, name: 'type_text', input });
    };
    const legacy = await refByName('Legacy lookup');
    const typedLegacy = await approvedSubmit('t_legacy', { ref: legacy.ref, text: 'S-12', submit: true });
    expect(typedLegacy.ok, typedLegacy.error).toBe(true);
    expect(typedLegacy.result).toMatchObject({ submitted: true, fallback: true });
    await expect(page.locator('#status')).toHaveText('Legacy lookup: S-12');

    // Laid transparently over a styled label, the way wikipedia.org does it.
    const lang = await refByName('Language');
    const picked = await exec('select_option', { ref: lang.ref, option: 'Marathi' });
    expect(picked.result.selected).toEqual({ value: 'mr', label: 'Marathi' });
    await expect(page.locator('#lang-label')).toHaveText('MR');

    const survey = await refByName('Survey number');
    const typed = await approvedSubmit('t_survey', { ref: survey.ref, text: '42/1', submit: true });
    expect(typed.ok, typed.error).toBe(true);
    await expect(page).toHaveURL(/\/form\?survey=42%2F1$/);
  });

  test('select_option drives a cascading dropdown; wait_for waits for the next one to fill', async () => {
    await gotoTab(allowedUrl('/form'));
    const district = await refByName('District');
    const picked = await exec('select_option', { ref: district.ref, option: 'pune' });
    expect(picked.ok, picked.error).toBe(true);
    expect(picked.result.selected).toEqual({ value: 'pune', label: 'Pune' });

    const waited = await exec('wait_for', { selector: '#tehsil option[value="haveli"]', timeout_ms: 5000 });
    expect(waited.result).toMatchObject({ matched: true });
    expect(waited.result.waited_ms).toBeGreaterThan(300);

    const tehsil = await refByName('Tehsil');
    const miss = await exec('select_option', { ref: tehsil.ref, option: 'Baramati' });
    expect(miss.result.selected).toBeNull();
    expect(miss.result.options).toEqual(['Select tehsil', 'Haveli', 'Mulshi', 'Maval']);

    expect((await exec('select_option', { ref: tehsil.ref, option: 'Haveli' })).ok).toBe(true);
    await expect(page.locator('#status')).toHaveText('Selected: Pune / Haveli');

    const timedOut = await exec('wait_for', { text: 'This never appears', timeout_ms: 600 });
    expect(timedOut.ok).toBe(true);
    expect(timedOut.result).toMatchObject({ matched: false, timed_out: true });

    const bad = await exec('wait_for', { selector: '###', timeout_ms: 600 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Invalid selector/);

    expect((await exec('wait_for', { text: 'Selected: Pune' })).result.matched).toBe(true);
  });

  test('a scoped run: allowed sites run without prompts, risky actions still confirm, everything else is blocked', async () => {
    await gotoTab(allowedUrl('/form'));
    const search = await refByName('Search records');
    const remarks = await refByName('Remarks');

    // Unscoped baseline: manual mode confirms a click and a non-search submit;
    // a search runs without a prompt anywhere.
    expect((await policy('CLICK', 'click', {})).decision).toBe('confirm');
    expect((await policy('SUBMIT', 'type_text', { ref: remarks.ref, text: 'x', submit: true })).decision).toBe('confirm');
    expect((await policy('SUBMIT', 'type_text', { ref: search.ref, text: 'x', submit: true })).decision).toBe('allow');

    // AGENT_START over a content-script-style one-off message must NOT set a scope.
    await panel.evaluate((id) => chrome.runtime.sendMessage({ type: 'AGENT_START', tabId: id, allowedHosts: ['127.0.0.1'] }), tabId);
    expect((await policy('CLICK', 'click', {})).decision).toBe('confirm');

    post({ type: 'AGENT_START', tabId, task: 'scope test', allowedHosts: ['http://127.0.0.1/', 'com', '*'] });
    await expect.poll(async () => (await policy('CLICK', 'click', {})).decision).toBe('allow');
    expect((await policy('SELECT', 'select_option', {})).decision).toBe('allow');
    expect((await policy('READ', 'find_text', {})).decision).toBe('allow');
    expect((await policy('SUBMIT', 'type_text', { ref: search.ref, text: 'x', submit: true })).decision).toBe('allow');
    expect((await policy('SUBMIT', 'type_text', { ref: remarks.ref, text: 'x', submit: true })).decision).toBe('confirm');
    expect((await policy('DELETE', 'click', {})).decision).toBe('confirm');
    expect((await policy('NAVIGATE_NEW_DOMAIN', 'navigate', { url: allowedUrl('/judgment') })).decision).toBe('allow');
    const offNav = await policy('NAVIGATE_NEW_DOMAIN', 'navigate', { url: offScopeUrl('/form') });
    expect(offNav.decision).toBe('block');
    expect(offNav.reason).toMatch(/outside this run's allowed sites/);

    // The SW enforces it at execution too: off the allowed hosts, acting is
    // refused while reading still works.
    const navOff = await exec('navigate', { url: offScopeUrl('/form') });
    expect(navOff.ok).toBe(false);
    await gotoTab(offScopeUrl('/form'));
    const offDelete = await refByName('Delete record');
    const clickOff = await exec('click', { ref: offDelete.ref });
    expect(clickOff.ok).toBe(false);
    expect(clickOff.error).toMatch(/outside this run's allowed sites/);
    expect((await exec('read_page', { mode: 'interactive' })).ok).toBe(true);
    expect((await exec('go_back', {})).ok).toBe(true);

    await sw$({ type: 'AGENT_STOP', tabId });
    expect((await policy('CLICK', 'click', {})).decision).toBe('confirm');
  });

  test('manual mode: looking and browsing never ask, changing the page does, a denylisted site stays blocked', async () => {
    await gotoTab(allowedUrl('/form'));
    const looks = [
      ['READ', 'read_page'],
      ['READ', 'find_text'],
      ['SCREENSHOT', 'screenshot'],
      ['SCROLL', 'scroll'],
      ['WAIT', 'wait_for'],
    ];
    for (const [actionClass, name] of looks) {
      expect((await policy(actionClass, name, {})).decision, name).toBe('allow');
    }
    expect((await policy('CLICK', 'click', {})).decision).toBe('confirm');
    expect((await policy('TYPE', 'type_text', {})).decision).toBe('confirm');
    expect((await policy('KEY', 'press_key', { keys: 'Tab' })).decision).toBe('confirm');
    expect((await policy('DELETE', 'click', {}, 'trusted')).decision).toBe('confirm');

    // A site's own search is browsing: typing the query, keys in the box,
    // Enter, and the search button. A form that holds more than search boxes
    // still asks.
    const search = await refByName('Search records');
    const searchBtn = (await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'interactive' })).elements.find(
      (e) => e.name === 'Search' && e.role === 'button',
    );
    expect((await policy('TYPE', 'type_text', { ref: search.ref, text: 'survey 42' })).decision).toBe('allow');
    expect((await policy('SUBMIT', 'type_text', { ref: search.ref, text: 'x', submit: true })).decision).toBe('allow');
    expect((await policy('CLICK', 'click', { ref: searchBtn.ref })).decision).toBe('allow');
    expect((await policy('CLICK', 'click', { ref: search.ref })).decision).toBe('allow');
    await page.focus('#q');
    expect((await policy('SUBMIT', 'press_key', { keys: 'Enter' })).decision).toBe('allow');
    expect((await policy('KEY_PRESS', 'press_key', { keys: 'ctrl+a' })).decision).toBe('allow');
    const remarks = await refByName('Remarks');
    const survey = await refByName('Survey number');
    const go = await refByName('Go');
    expect((await policy('TYPE', 'type_text', { ref: remarks.ref, text: 'x' })).decision).toBe('confirm');
    expect((await policy('SUBMIT', 'type_text', { ref: survey.ref, text: '42/1', submit: true })).decision).toBe('confirm');
    expect((await policy('CLICK', 'click', { ref: go.ref })).decision).toBe('confirm');
    await page.focus('#remarks');
    expect((await policy('KEY_PRESS', 'press_key', { keys: 'Backspace' })).decision).toBe('confirm');

    // A paging key only scrolls; both classifiers agree.
    const classes = await panel.evaluate(async () => {
      const { toolActionClass } = await import('/src/agent/tools.js');
      const { classifyAction } = await import('/src/background/permission-manager.js');
      return ['PageDown', 'End', 'ctrl+a', 'Enter', 'Tab'].map((keys) => [
        toolActionClass('press_key', { keys }),
        classifyAction('press_key', { keys }),
      ]);
    });
    expect(classes).toEqual([
      ['SCROLL', 'SCROLL'],
      ['SCROLL', 'SCROLL'],
      ['SELECT_TEXT', 'SELECT_TEXT'],
      ['SUBMIT', 'SUBMIT'],
      ['KEY_PRESS', 'KEY'],
    ]);
    expect((await policy('SELECT_TEXT', 'press_key', { keys: 'ctrl+a' })).decision).toBe('allow');

    // Plain links are browsing; links that act still ask.
    await gotoTab(allowedUrl('/links'));
    const links = (await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'interactive' })).elements;
    const linkRef = (name) => links.find((e) => e.name === name).ref;
    expect((await policy('CLICK', 'click', { ref: linkRef('Kesavananda Bharati v. State of Kerala') })).decision).toBe('allow');
    for (const name of ['Sign out', 'Open panel', 'Get the PDF', 'Back to top', 'Mark item 7']) {
      expect((await policy('CLICK', 'click', { ref: linkRef(name) })).decision, name).toBe('confirm');
    }

    // Another page of the same site and going back are browsing; another
    // site, or a same-site address that acts, still asks.
    const nav = (actionClass, url) => policy(actionClass, 'navigate', { url });
    expect((await nav('NAVIGATE_SAME_DOMAIN', allowedUrl('/judgment'))).decision).toBe('allow');
    expect((await nav('NAVIGATE_NEW_DOMAIN', allowedUrl('/judgment'))).decision).toBe('allow');
    expect((await nav('NAVIGATE_SAME_DOMAIN', allowedUrl('/logout'))).decision).toBe('confirm');
    expect((await nav('NAVIGATE_NEW_DOMAIN', offScopeUrl('/judgment'))).decision).toBe('confirm');
    expect((await nav('NAVIGATE_SAME_DOMAIN', offScopeUrl('/judgment'))).decision).toBe('confirm');
    expect((await policy('NAVIGATE_BACK', 'go_back', {})).decision).toBe('allow');
    await gotoTab(allowedUrl('/form'));

    await page.route('https://www.paypal.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Sign in</title><p>Pay</p>' }),
    );
    try {
      await gotoTab('https://www.paypal.com/signin');
      for (const [actionClass, name] of looks) {
        expect((await policy(actionClass, name, {})).decision, name).toBe('block');
      }
    } finally {
      await page.unroute('https://www.paypal.com/**');
    }
  });

  test('page signals: sign-in walls and CAPTCHAs are flagged; OTP and CAPTCHA fields are untouchable', async () => {
    const signalsAt = async (url) => {
      await gotoTab(url);
      return (await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'interactive' })).signals;
    };
    expect((await signalsAt(allowedUrl('/login'))).loginWall).toMatchObject({ blocking: true });
    expect(await signalsAt(allowedUrl('/judgment'))).toEqual({ loginWall: null, captcha: null });
    // The original e-filing fixture has a password field inside a longer form.
    expect((await signalsAt(allowedUrl('/fixtures'))).loginWall).toBeNull();
    expect((await signalsAt(allowedUrl('/captcha'))).captcha).toMatchObject({ blocking: true });

    await gotoTab(allowedUrl('/form'));
    const otp = await refByName('Enter OTP');
    expect(otp.sensitive).toBe(true);
    const typed = await exec('type_text', { ref: otp.ref, text: '123456' });
    expect(typed.ok).toBe(false);
    await expect(page.locator('#otp')).toHaveValue('');
  });

  test('agent loop: hands a sign-in wall to the user, then finds the quote and finishes', async () => {
    test.setTimeout(90_000);
    await gotoTab(allowedUrl('/login'));
    await panel.evaluate(
      async ({ tabId: id, baseUrl }) => {
        const { createAgentRun } = await import('/src/agent/agent-loop.js');
        window.__events = [];
        window.__run = createAgentRun({
          port: window.__port,
          tabId: id,
          task: 'Find which paragraph of the judgment holds the quote about the right to be heard.',
          approvalMode: 'manual',
          allowedHosts: ['127.0.0.1'],
          auth: { mode: 'account', token: 'lexiext_test_token', baseUrl },
          onEvent: (e) => window.__events.push(e),
        });
        window.__run.start();
      },
      { tabId, baseUrl: mockOrigin },
    );

    // The loop stops for the user before ever calling the model.
    const handover = await expect
      .poll(() => panel.evaluate(() => window.__events.find((e) => e.type === 'ask_user') || null), { timeout: 15_000 })
      .not.toBeNull()
      .then(() => panel.evaluate(() => window.__events.find((e) => e.type === 'ask_user')));
    expect(handover.handover).toBe(true);
    expect(handover.question).toMatch(/sign in on 127\.0\.0\.1/);
    expect(mock.calls).toHaveLength(0);

    // The user "signs in" (lands on the judgment) and replies.
    await gotoTab(allowedUrl('/judgment'));
    await panel.evaluate((id) => window.__run.provideAnswer(id, 'Signed in, carry on.'), handover.toolUseId);

    await expect
      .poll(() => panel.evaluate(() => window.__events.find((e) => e.type === 'status' && e.status === 'done') || null), {
        timeout: 60_000,
      })
      .not.toBeNull();
    const events = await panel.evaluate(() => window.__events);
    expect(events.filter((e) => e.type === 'confirm')).toEqual([]); // find_text needed no prompt in scope
    expect(events.find((e) => e.status === 'done').answer).toContain(`Paragraph ${TARGET_PARA}`);

    expect(mock.calls).toHaveLength(2);
    const first = JSON.stringify(mock.calls[0].messages);
    expect(first).toContain('The user was asked to take over and replied');
    expect(first).toContain('Signed in, carry on.');
    expect(first).toContain('Allowed sites for this task: 127.0.0.1');
    expect(mock.calls[0].tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['find_text', 'wait_for', 'select_option']),
    );
    const toolResult = mock.calls[1].messages.at(-1).content.find((b) => b.type === 'tool_result');
    expect(toolResult.is_error).toBe(false);
    expect(toolResult.content).toContain('<untrusted_page_content>');
    expect(toolResult.content).toContain(`"para":"${TARGET_PARA}"`);
    expect(toolResult.content).toContain(`"page":"${TARGET_PAGE}"`);
  });
});

// Trusted input (chrome.debugger granted and Agent Mode enabled on the site):
// type_text clicks the field for real and inserts text, so it must select what
// the field held first or the text lands wherever the click put the caret.
test.describe('agent tools — trusted typing', () => {
  let context;
  let page;
  let panel;
  let tabId;
  let fixtureServer;
  let fixtureOrigin;
  let userDataDir;
  let extDir;

  test.beforeAll(async () => {
    fixtureServer = startFixtureServer();
    fixtureOrigin = `http://127.0.0.1:${await listen(fixtureServer)}`;
    extDir = buildTestExtensionCopy('http://127.0.0.1:9');
    const manifestPath = path.join(extDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.permissions = [...new Set([...(manifest.permissions || []), 'debugger'])];
    manifest.optional_permissions = (manifest.optional_permissions || []).filter((p) => p !== 'debugger');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-trusted-typing-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--no-first-run'],
    });
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    await sw.evaluate(
      (origin) =>
        chrome.storage.local.set({
          lexi_site_grants: { [origin]: { agentEnabled: true, classes: [], expiresAt: null, onceGrants: [] } },
        }),
      fixtureOrigin,
    );
    page = await context.newPage();
    await page.goto(`${fixtureOrigin}/form`, { waitUntil: 'load' });
    tabId = await sw.evaluate(
      () => new Promise((resolve) => chrome.tabs.query({ active: true, lastFocusedWindow: true }, (t) => resolve(t[0]?.id))),
    );
    panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(sw.url()).host}/src/sidepanel/sidepanel.html?testTabId=${tabId}`);
    await panel.evaluate(() => {
      const port = chrome.runtime.connect({ name: 'lexi-sidepanel' });
      const waiting = new Map();
      port.onMessage.addListener((msg) => {
        const done = msg && waiting.get(msg.requestId);
        if (done) {
          waiting.delete(msg.requestId);
          done(msg);
        }
      });
      window.__sw = (message) =>
        new Promise((resolve) => {
          const requestId = crypto.randomUUID();
          waiting.set(requestId, resolve);
          port.postMessage({ ...message, requestId });
        });
    });
  });

  test.afterAll(async () => {
    if (context) await context.close();
    if (fixtureServer) await new Promise((resolve) => fixtureServer.close(resolve));
    for (const dir of [userDataDir, extDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('type_text replaces what the field held; an empty string clears it', async () => {
    const sw$ = (message) => panel.evaluate((m) => window.__sw(m), message);
    const exec = (name, input) => sw$({ type: 'EXEC_TOOL', tabId, toolUseId: `t_${Date.now()}`, name, input });
    await page.fill('#q', 'Maneka Gandhi v Union of India');
    const elements = (await sw$({ type: 'EXTRACT_PAGE', tabId, mode: 'interactive' })).elements;
    const search = elements.find((e) => e.name === 'Search records');

    const typed = await exec('type_text', { ref: search.ref, text: 'Vishaka' });
    expect(typed.ok, JSON.stringify(typed)).toBe(true);
    expect(typed.result.fallback).toBeUndefined(); // the trusted path ran
    expect(await page.inputValue('#q')).toBe('Vishaka');

    const cleared = await exec('type_text', { ref: search.ref, text: '' });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(await page.inputValue('#q')).toBe('');
  });
});
