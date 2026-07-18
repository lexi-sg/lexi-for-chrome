// scripts/shoot-screenshots.mjs
//
// Chrome Web Store listing screenshots for "Lexi for Chrome". Loads the real
// unpacked MV3 extension in a headed, persistent Chromium context — the same
// pattern test/e2e.spec.js's beforeAll uses (serve test/test-fixtures.html
// over loopback HTTP rather than file://, since content scripts / chrome.
// scripting need a real origin; resolve the extension id off its service
// worker; open the side panel as a plain chrome-extension:// tab with
// ?testTabId=<fixturesTabId> because Playwright cannot drive Chrome's native
// side-panel chrome — see that file's header comments for the full
// reasoning, which applies unchanged here).
//
// Produces 4 store screenshots at assets/store/screenshot-{1..4}.png, each
// composed as a believable "browser window" at exactly 1280x800: a thin fake
// chrome/tab bar on top, the underlying page fixture on the left, and the
// real side panel docked on the right — mirroring how Lexi actually looks
// docked in Chrome. (screenshot-3, the options/onboarding page, uses the
// same chrome bar over the full-width options page instead of a split.)
//
// ---------------------------------------------------------------------------
// TWO MODES
// ---------------------------------------------------------------------------
// --static-only (safe to run any time, including while the extension is
//   mid-debug): never calls the live Anthropic API and never depends on
//   sidepanel.js's/agent-loop.js's own message-handling logic being correct.
//   It loads the real sidepanel.html/options.html (so the real CSS, stable
//   ids, and layout are what's on screen), then injects DOM nodes *directly*
//   into #messages via page.evaluate(), using the EXACT class-name contract
//   chat-render.js's real renderer produces (.lexi-msg/.lexi-msg-user/
//   .lexi-msg-assistant/.lexi-msg-body/.lexi-disclaimer-line for chat,
//   .lexi-risk-item/.lexi-risk-{high,med,low}/.lexi-risk-dot/.lexi-risk-body
//   for "Flag risky terms", and a clone of #confirm-card-template's own
//   .lexi-confirm-card markup for the agent confirmation scenario — see
//   src/sidepanel/chat-render.js and src/sidepanel/sidepanel.html, read but
//   not modified by this script). This means the screenshots are pixel-
//   faithful to what the real renderer would produce, without needing
//   sidepanel.js's boot()/runQuickAction()/agent-loop.js wiring to actually
//   work end-to-end. Demo copy is realistic and lease/e-filing-fixture-
//   grounded (drawn from the seeded HIGH-severity clauses in
//   test/test-fixtures.html and the real prompt copy in
//   src/prompts/quick-action-templates.js), never placeholder lorem ipsum.
//
// --live (default; requires ANTHROPIC_API_KEY): drives the real UI —
//   clicking the actual "Flag risky terms" chip, actually switching to Agent
//   mode and typing a real task — and waits for the real streamed Anthropic
//   response / real confirm-card event before screenshotting. This is the
//   "real" mode for once the extension's current mid-debug work has settled;
//   per the build instructions this mode is intentionally NOT exercised by
//   this task (the extension is mid-debug in another concurrent session) —
//   only implemented and left ready to run later via:
//     ANTHROPIC_API_KEY=sk-ant-... node scripts/shoot-screenshots.mjs
//
// Run static (safe, no network, no live extension logic required):
//   node scripts/shoot-screenshots.mjs --static-only
//
// Run live (real API calls, real $ spend on your own key):
//   ANTHROPIC_API_KEY=sk-ant-... node scripts/shoot-screenshots.mjs
//
// Never prints the API key (only ever passed through in-memory to
// chrome.storage.local inside the browser context, exactly like
// test/e2e.spec.js's beforeAll seeding step).

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_FILE = path.join(REPO_ROOT, 'test', 'test-fixtures.html');

const STATIC_ONLY = process.argv.includes('--static-only');
// --out-dir=<path>: redirect output away from the final assets/store/
// screenshot-*.png files (used e.g. to capture raw, unframed product shots
// into assets/raw-captures/ for the frame-embedding pipeline in
// assets/screenshot-frames/ without clobbering the branded store PNGs).
const outDirArg = process.argv.find((a) => a.startsWith('--out-dir='));
const OUT_DIR = outDirArg
  ? path.resolve(REPO_ROOT, outDirArg.slice('--out-dir='.length))
  : path.join(REPO_ROOT, 'assets', 'store');

// Mirrors src/config.js's STORAGE_KEYS byte-for-byte (this is a plain Node
// script, not an ES-module-aware content script, and can't import an
// extension-context ES module directly — same convention test/e2e.spec.js
// already documents/uses for the same reason).
const STORAGE_KEYS = {
  API_KEY: 'lexi_api_key',
  MODEL: 'lexi_model',
  APPROVAL_MODE: 'lexi_approval_mode',
  SITE_GRANTS: 'lexi_site_grants',
  PROVIDER: 'lexi_provider',
};

const SCENE = {
  width: 1280,
  height: 800,
  chromeBarHeight: 44,
  leftWidth: 860,
  rightWidth: 420,
};

async function main() {
  if (!STATIC_ONLY && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'Live mode requires ANTHROPIC_API_KEY. Run with --static-only for a demo-content run that ' +
        'never touches the live API, e.g.:\n  node scripts/shoot-screenshots.mjs --static-only',
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { fixturesServer, fixturesUrl, fixturesOrigin } = await startFixturesServer();
  let context;
  let userDataDir;

  try {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lexi-shots-'));
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${REPO_ROOT}`,
        `--load-extension=${REPO_ROOT}`,
        '--no-first-run',
      ],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;

    const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
    console.log(`Loaded extension "${manifest.name}" (${extensionId})`);

    // ---- Screenshot 3 FIRST, deliberately, with NO API key seeded yet -----
    // so options.html renders its real "Add your Anthropic API key"
    // onboarding card (the BYOK positioning) rather than the post-onboarding
    // settings summary. This is a genuinely no-JS-required screenshot: the
    // onboarding card is the default state of static HTML/CSS with an empty
    // chrome.storage.local, so it works identically in --static-only and
    // live mode.
    await shootOptionsPage(context, extensionId, path.join(OUT_DIR, 'screenshot-3.png'));

    // ---- Now seed the key + settings + agent-mode site grant, mirroring --
    // test/e2e.spec.js's beforeAll exactly (SITE_GRANTS shape from
    // permission-manager.js: { [origin]: { agentEnabled, classes, expiresAt,
    // onceGrants } }).
    const apiKey = STATIC_ONLY
      ? 'sk-ant-demo-static-only-not-a-real-key-0000000000000000000000'
      : process.env.ANTHROPIC_API_KEY;
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

    // ---- Open the fixtures tab, then the panel as a plain tab (same tabId --
    // resolution trick as e2e.spec.js: grab {active:true,lastFocusedWindow}
    // immediately after navigating, before opening the panel tab steals
    // "active").
    const fixturesPage = await context.newPage();
    await fixturesPage.goto(fixturesUrl, { waitUntil: 'load' });
    const tabId = await sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => resolve(tabs[0]?.id));
        }),
    );

    const panel = await context.newPage();
    await panel.setViewportSize({ width: SCENE.rightWidth, height: SCENE.height - SCENE.chromeBarHeight });
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/sidepanel.html?testTabId=${tabId}`, {
      waitUntil: 'load',
    });
    // Give sidepanel.js's boot() a moment to populate quick actions / context
    // chip even in static mode (harmless if it fails — the injected demo DOM
    // below does not depend on it).
    await panel
      .waitForSelector('#quick-actions .lexi-chip', { timeout: 8000 })
      .catch(() => console.warn('  (quick-action chips did not render — continuing with static injection anyway)'));

    await fixturesPage.setViewportSize({ width: SCENE.leftWidth, height: SCENE.height - SCENE.chromeBarHeight });

    // ---- Screenshot 1: rich legal Q&A answer ------------------------------
    if (STATIC_ONLY) {
      await injectQAAnswer(panel);
    } else {
      await runLiveExplainClause(panel);
    }
    await tidyPanelChrome(panel, {
      contextTitle: 'Residential Lease Agreement (Test Fixture)',
      actingBarText: null,
    });
    await composeSplitScene(context, {
      leftPage: fixturesPage,
      rightPage: panel,
      urlLabel: 'acme-rentals.example/lease-agreement',
      outPath: path.join(OUT_DIR, 'screenshot-1.png'),
    });

    // ---- Screenshot 2: "Flag risky terms" on the lease fixture ------------
    if (STATIC_ONLY) {
      await clearMessages(panel);
      await injectRiskFlagResult(panel);
    } else {
      await clearMessages(panel);
      await runLiveFlagRisk(panel);
    }
    await tidyPanelChrome(panel, {
      contextTitle: 'Residential Lease Agreement (Test Fixture)',
      actingBarText: null,
    });
    await composeSplitScene(context, {
      leftPage: fixturesPage,
      rightPage: panel,
      urlLabel: 'acme-rentals.example/lease-agreement',
      outPath: path.join(OUT_DIR, 'screenshot-2.png'),
    });

    // ---- Screenshot 4: agent-mode confirmation card -----------------------
    if (STATIC_ONLY) {
      await clearMessages(panel);
      await injectAgentConfirmCard(panel, fixturesPage);
    } else {
      await clearMessages(panel);
      await runLiveAgentConfirm(panel, fixturesPage);
    }
    await tidyPanelChrome(panel, {
      contextTitle: 'E-Filing Test Form',
      actingBarText: 'Lexi is acting — filling the e-filing form',
    });
    await composeSplitScene(context, {
      leftPage: fixturesPage,
      rightPage: panel,
      urlLabel: 'acme-legal-portal.example/e-filing',
      outPath: path.join(OUT_DIR, 'screenshot-4.png'),
    });

    console.log(`Wrote 4 screenshots to ${path.relative(REPO_ROOT, OUT_DIR)}/`);
  } finally {
    if (context) await context.close();
    await new Promise((resolve) => fixturesServer.close(resolve));
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup only */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixtures HTTP server (same reasoning as test/e2e.spec.js: content scripts
// need a real http(s) origin, not file://, without the manual "allow file
// URLs" toggle).
// ---------------------------------------------------------------------------

function startFixturesServer() {
  const fixtureHtml = fs.readFileSync(FIXTURES_FILE);
  const fixturesServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url?.startsWith('/test-fixtures.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    fixturesServer.listen(0, '127.0.0.1', () => {
      const { port } = fixturesServer.address();
      const fixturesUrl = `http://127.0.0.1:${port}/test-fixtures.html`;
      resolve({ fixturesServer, fixturesUrl, fixturesOrigin: new URL(fixturesUrl).origin });
    });
  });
}

// ---------------------------------------------------------------------------
// Options/onboarding page screenshot (full-width, no split needed).
// ---------------------------------------------------------------------------

async function shootOptionsPage(context, extensionId, outPath) {
  const page = await context.newPage();
  await page.setViewportSize({ width: SCENE.width, height: SCENE.height - SCENE.chromeBarHeight });
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`, { waitUntil: 'load' });
  await page.waitForTimeout(150); // let webfont-free layout settle
  const shot = await page.screenshot();
  await page.close();
  await composeScene({
    context,
    panes: [{ buffer: shot, width: SCENE.width }],
    urlLabel: 'Lexi — Settings & Onboarding',
    outPath,
  });
}

// ---------------------------------------------------------------------------
// Static-mode DOM injection — bypasses sidepanel.js's message pipeline
// entirely and writes directly into #messages using chat-render.js's exact
// class-name contract (read from src/sidepanel/chat-render.js). See file
// header for why this is safe to run against a mid-debug extension.
// ---------------------------------------------------------------------------

async function clearMessages(panel) {
  await panel.evaluate(() => {
    const messages = document.getElementById('messages');
    if (messages) messages.innerHTML = '';
    const actingBar = document.getElementById('acting-bar');
    if (actingBar) actingBar.hidden = true;
  });
}

// KNOWN ISSUE (as of this writing, sidepanel.css is mid-edit by another
// concurrent agent — do not "fix" this here, just work around it for clean
// demo screenshots): #key-banner, #secondary-actions-menu, #agent-enable-row,
// and #acting-bar are all styled with an unconditional ID-selector
// `display: flex`, with no `#id[hidden] { display: none }` override. An ID
// selector outranks the UA stylesheet's `[hidden] { display: none }` rule,
// so setting `.hidden = true` (or never un-hiding the markup's default
// `hidden` attribute) silently fails to actually hide these elements — they
// render permanently visible regardless of app state (this would also bite
// real users, e.g. the key-banner staying up after a key is saved; worth
// flagging upstream, but out of scope for this asset-pipeline task since
// src/ is owned by a concurrent edit). This script forces the chrome-only
// elements closed (and the acting bar to an explicit, deliberate state) with
// an `!important` inline override so demo screenshots stay clean regardless
// of that CSS bug's current state (idempotent and harmless once the bug is
// fixed upstream). Also settles the `.lexi-msg { animation: lexi-fade-in
// 160ms ease; }` entrance animation and gives the context chip a realistic
// "reading this page" label instead of a "No page detected" default
// (harmless cosmetic override, no functional state is changed).
async function tidyPanelChrome(panel, { contextTitle, actingBarText } = {}) {
  await panel.evaluate(
    ({ contextTitle, actingBarText }) => {
      const forceHide = (id) => {
        const el = document.getElementById(id);
        if (el) el.style.setProperty('display', 'none', 'important');
      };
      forceHide('key-banner');
      forceHide('secondary-actions-menu');
      forceHide('agent-enable-row');

      const actingBar = document.getElementById('acting-bar');
      const actingIntent = document.getElementById('acting-intent');
      if (actingBar) {
        if (actingBarText) {
          actingBar.style.setProperty('display', 'flex', 'important');
          if (actingIntent) actingIntent.textContent = actingBarText;
        } else {
          actingBar.style.setProperty('display', 'none', 'important');
        }
      }

      const moreBtn = document.getElementById('quick-actions-more');
      if (moreBtn) moreBtn.setAttribute('aria-expanded', 'false');

      if (contextTitle) {
        const title = document.getElementById('context-title');
        const toggle = document.getElementById('context-toggle');
        const label = document.getElementById('context-toggle-label');
        if (title) title.textContent = contextTitle;
        if (toggle) toggle.setAttribute('aria-pressed', 'true');
        if (label) label.textContent = 'Reading this page';
      }
    },
    { contextTitle, actingBarText },
  );
  // Let the .lexi-fade-in 160ms entrance animation on freshly-injected
  // .lexi-msg / .lexi-confirm-card nodes finish before screenshotting.
  await panel.waitForTimeout(260);
}

async function injectQAAnswer(panel) {
  await panel.evaluate(
    ({ userText, paragraphs }) => {
      const messages = document.getElementById('messages');
      if (!messages) return;

      const userEl = document.createElement('div');
      userEl.className = 'lexi-msg lexi-msg-user';
      userEl.textContent = userText;
      messages.appendChild(userEl);

      const root = document.createElement('div');
      root.className = 'lexi-msg lexi-msg-assistant';
      const body = document.createElement('div');
      body.className = 'lexi-msg-body';
      for (const para of paragraphs) {
        const p = document.createElement('p');
        p.textContent = para;
        body.appendChild(p);
      }
      root.appendChild(body);
      const disclaimer = document.createElement('div');
      disclaimer.className = 'lexi-disclaimer-line';
      disclaimer.textContent = 'Not legal advice.';
      root.appendChild(disclaimer);
      messages.appendChild(root);
      messages.scrollTop = messages.scrollHeight;
    },
    {
      userText: 'Explain this clause',
      paragraphs: [
        'Clause 22 (Dispute Resolution) means that if you and the landlord ever disagree about ' +
          'something in this lease, neither of you can take it to a public court — you both have ' +
          'to go through private, binding arbitration instead, and that decision is final.',
        "It also means you're giving up the right to join a class action: even if many tenants " +
          'have the same complaint, each person has to bring their own individual arbitration case ' +
          'rather than banding together.',
        'In practice this tends to favor the landlord — arbitration is usually faster and cheaper ' +
          "for a repeat filer, and losing the class-action option removes tenants' main source of " +
          'leverage on a widely shared issue (e.g. a building-wide habitability problem).',
      ],
    },
  );
}

async function injectRiskFlagResult(panel) {
  await panel.evaluate(
    ({ userText, items }) => {
      const messages = document.getElementById('messages');
      if (!messages) return;

      const userEl = document.createElement('div');
      userEl.className = 'lexi-msg lexi-msg-user';
      userEl.textContent = userText;
      messages.appendChild(userEl);

      const root = document.createElement('div');
      root.className = 'lexi-msg lexi-msg-assistant';
      const body = document.createElement('div');
      body.className = 'lexi-msg-body';

      for (const item of items) {
        const row = document.createElement('div');
        row.className = `lexi-risk-item lexi-risk-${item.severity}`;
        const dot = document.createElement('span');
        dot.className = 'lexi-risk-dot';
        row.appendChild(dot);
        const rowBody = document.createElement('div');
        rowBody.className = 'lexi-risk-body';
        const strong = document.createElement('strong');
        strong.textContent = item.title;
        rowBody.appendChild(strong);
        rowBody.appendChild(document.createElement('br'));
        rowBody.appendChild(document.createTextNode(item.text));
        row.appendChild(rowBody);
        body.appendChild(row);
      }
      root.appendChild(body);

      const disclaimer = document.createElement('div');
      disclaimer.className = 'lexi-disclaimer-line';
      disclaimer.textContent = 'Not legal advice.';
      root.appendChild(disclaimer);
      messages.appendChild(root);
      messages.scrollTop = messages.scrollHeight;
    },
    {
      userText: 'Flag risky terms',
      items: [
        {
          severity: 'high',
          title: 'Auto-renewal (Clause 7)',
          text: ' the lease silently renews for another full year unless you give written notice at least 60 days before the term ends.',
        },
        {
          severity: 'high',
          title: 'Broad indemnification (Clause 14)',
          text: " you must cover the landlord's legal costs and damages even for claims partly caused by the landlord's own negligence.",
        },
        {
          severity: 'high',
          title: 'Arbitration + class-action waiver (Clause 22)',
          text: ' disputes go to private binding arbitration only, and you cannot join a class action with other tenants.',
        },
        {
          severity: 'med',
          title: 'Liquidated damages (Clause 26)',
          text: " leaving early without written consent costs a flat 3 months' rent, regardless of actual loss to the landlord.",
        },
      ],
    },
  );
}

async function injectAgentConfirmCard(panel, fixturesPage) {
  // Make the underlying fixtures page look mid-task: the agent has already
  // typed the claimant name and is now paused before the risky SUBMIT action.
  await fixturesPage.evaluate(() => {
    const el = document.getElementById('claimant');
    if (el) el.value = 'Ada Lovelace';
    const resp = document.getElementById('respondent');
    if (resp) resp.value = 'Beacon Property Group LLC';
    const cn = document.getElementById('case-number');
    if (cn) cn.value = 'CV-2026-04471';
  });

  await panel.evaluate(() => {
    const messages = document.getElementById('messages');
    const actingBar = document.getElementById('acting-bar');
    const actingIntent = document.getElementById('acting-intent');
    const template = document.getElementById('confirm-card-template');
    if (!messages || !template) return;

    // Reflect Agent mode in the Chat|Agent segmented toggle (aria-selected
    // drives #mode-toggle's visual pill in sidepanel.css) — this scenario is
    // agent-mode-only, so the composer chrome should show it as active.
    const chatBtn = document.getElementById('mode-chat-btn');
    const agentBtn = document.getElementById('mode-agent-btn');
    if (chatBtn) chatBtn.setAttribute('aria-selected', 'false');
    if (agentBtn) agentBtn.setAttribute('aria-selected', 'true');

    const userEl = document.createElement('div');
    userEl.className = 'lexi-msg lexi-msg-user';
    userEl.textContent = 'Fill out the e-filing form for Ada Lovelace and submit it.';
    messages.appendChild(userEl);

    if (actingBar) {
      actingBar.hidden = false;
      if (actingIntent) actingIntent.textContent = 'Lexi is acting — filling the e-filing form';
    }

    const fragment = template.content.cloneNode(true);
    const desc = fragment.querySelector('#confirm-desc');
    if (desc) desc.textContent = 'submit this form on E-Filing Test Form';
    messages.appendChild(fragment);
    messages.scrollTop = messages.scrollHeight;
  });
}

// ---------------------------------------------------------------------------
// Live-mode helpers (real API calls; not exercised by this build task — see
// file header). Left implemented and ready for a future, non-mid-debug run.
// ---------------------------------------------------------------------------

async function runLiveExplainClause(panel) {
  await panel.locator('#prompt-input').fill('Explain the dispute resolution clause on this page.');
  await panel.locator('#send-btn').click();
  await panel
    .locator('.lexi-msg-assistant .lexi-disclaimer-line')
    .first()
    .waitFor({ timeout: 60_000 });
}

async function runLiveFlagRisk(panel) {
  await panel.locator('#quick-actions').getByRole('button', { name: /flag risky/i }).click();
  await panel.locator('.lexi-risk-item').first().waitFor({ timeout: 60_000 });
}

async function runLiveAgentConfirm(panel, fixturesPage) {
  await panel.locator('#mode-agent-btn').click();
  const enableBtn = panel.locator('#agent-enable-btn');
  if (await enableBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await enableBtn.click().catch(() => {});
  }
  await panel
    .locator('#prompt-input')
    .fill('Type "Ada Lovelace" into the Claimant field, then submit the filing form.');
  await panel.locator('#send-btn').click();
  await panel.locator('.lexi-confirm-card').first().waitFor({ timeout: 120_000 });
  await fixturesPage.locator('#claimant').inputValue().catch(() => {});
}

// ---------------------------------------------------------------------------
// Scene compositing — wraps one or two raw page screenshots in a believable
// browser-chrome bar (traffic-light dots + a rounded fake address pill) to
// produce the final, exactly-1280x800 store screenshot.
// ---------------------------------------------------------------------------

async function composeSplitScene(context, { leftPage, rightPage, urlLabel, outPath }) {
  const [leftBuf, rightBuf] = await Promise.all([leftPage.screenshot(), rightPage.screenshot()]);
  await composeScene({
    context,
    panes: [
      { buffer: leftBuf, width: SCENE.leftWidth },
      { buffer: rightBuf, width: SCENE.rightWidth, divider: true },
    ],
    urlLabel,
    outPath,
  });
}

async function composeScene({ context, panes, urlLabel, outPath }) {
  const paneHtml = panes
    .map((pane, i) => {
      const b64 = pane.buffer.toString('base64');
      const dividerStyle = pane.divider
        ? 'box-shadow: -1px 0 0 rgba(11,18,32,0.10), -8px 0 16px -8px rgba(11,18,32,0.12);'
        : '';
      return `<img src="data:image/png;base64,${b64}" style="display:block;width:${pane.width}px;height:${
        SCENE.height - SCENE.chromeBarHeight
      }px;${dividerStyle}" />`;
    })
    .join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; width:${SCENE.width}px; height:${SCENE.height}px; overflow:hidden;
    font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif; background:#E7E9F0; }
  .chrome-bar { height:${SCENE.chromeBarHeight}px; display:flex; align-items:center; gap:10px;
    padding: 0 14px; background: linear-gradient(180deg,#F3F4F8 0%,#E9EBF2 100%);
    border-bottom: 1px solid rgba(11,18,32,0.08); }
  .dots { display:flex; gap:6px; }
  .dot { width:11px; height:11px; border-radius:50%; }
  .dot.r { background:#FF6159; } .dot.y { background:#FFBD2E; } .dot.g { background:#28C93F; }
  .addr { flex:1; height:24px; margin-left:8px; border-radius:7px; background:#ffffff;
    border:1px solid rgba(11,18,32,0.08); display:flex; align-items:center; padding:0 10px;
    font-size:12px; color:#4B5468; gap:6px; }
  .row { display:flex; width:${SCENE.width}px; height:${SCENE.height - SCENE.chromeBarHeight}px; }
</style></head>
<body>
  <div class="chrome-bar">
    <div class="dots"><span class="dot r"></span><span class="dot y"></span><span class="dot g"></span></div>
    <div class="addr">🔒 ${escapeHtml(urlLabel)}</div>
  </div>
  <div class="row">${paneHtml}</div>
</body></html>`;

  const page = await context.newPage();
  await page.setViewportSize({ width: SCENE.width, height: SCENE.height });
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: SCENE.width, height: SCENE.height } });
  await page.close();
  console.log(`wrote ${path.relative(REPO_ROOT, outPath)} (${SCENE.width}x${SCENE.height})`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
