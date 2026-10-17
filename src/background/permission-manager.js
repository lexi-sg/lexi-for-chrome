// src/background/permission-manager.js
//
// Per-domain / per-action-class grant store + static site policy (deny/allow)
// + approval-mode gate. Pure logic + chrome.storage.local — no network calls
// (the static DENYLIST replaces a server-side domain_info endpoint).
//
// ES module. Imported only by service-worker.js (and, transitively, by
// anything else that runs in the SW context). Never imported by a content
// script (classic scripts can't `import` anyway — see config.js header).
//
// Storage shape (chrome.storage.local[STORAGE_KEYS.SITE_GRANTS]):
//   {
//     [origin]: {
//       agentEnabled: boolean,        // "Enable agent actions on this site" toggle
//       classes: string[],            // action classes always-allowed here ("always" duration)
//       expiresAt: number|null,       // optional expiry for the whole record; null = never
//       onceGrants: [{actionClass, toolUseId}]  // single-use approvals, cleared after use
//     }
//   }

import { RISKY_CLASSES, STORAGE_KEYS, DENYLIST } from '../config.js';
import { httpHostOf, isAllowedHost } from '../agent/host-scope.js';

// ---------------------------------------------------------------------------
// origin / host helpers
// ---------------------------------------------------------------------------

function hostOf(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return String(origin || '').replace(/^[a-z]+:\/\//i, '').split('/')[0];
  }
}

function isDenylisted(origin) {
  const host = hostOf(origin);
  return DENYLIST.some((pattern) => pattern.test(host) || pattern.test(String(origin || '')));
}

// Browser-internal / privileged schemes Lexi must never act on. file:// is
// deliberately NOT included: agent mode over a local file (via the synthetic-
// event fallback) is an intentionally-supported, test-covered path. The
// hostname-based DENYLIST above can't catch these (a chrome:// or file:// URL
// has no matching hostname), so they need an explicit scheme check.
const BLOCKED_SCHEME_RE = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;

function isBlockedScheme(origin) {
  return !!origin && BLOCKED_SCHEME_RE.test(String(origin));
}

// ---------------------------------------------------------------------------
// storage helpers
// ---------------------------------------------------------------------------

async function readAllGrants() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SITE_GRANTS);
  return (data && data[STORAGE_KEYS.SITE_GRANTS]) || {};
}

async function writeAllGrants(grants) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SITE_GRANTS]: grants });
}

function emptyRecord() {
  return { agentEnabled: false, classes: [], expiresAt: null, onceGrants: [] };
}

function isRecordFresh(record) {
  if (!record) return false;
  return !record.expiresAt || Date.now() < record.expiresAt;
}

function hasAlwaysGrant(record, actionClass) {
  if (!record || !isRecordFresh(record)) return false;
  const classes = record.classes || [];
  return classes.includes(actionClass) || classes.includes('*');
}

function hasOnceGrant(record, actionClass, toolUseId) {
  if (!record || !toolUseId) return false;
  return (record.onceGrants || []).some(
    (g) => g.actionClass === actionClass && g.toolUseId === toolUseId
  );
}

// ---------------------------------------------------------------------------
// action classification
// ---------------------------------------------------------------------------

// Keyword hints applied when the caller (agent-loop, which has the read_page
// interactive index in hand) enriches a tool's input with the target
// element's accessible name/text as `elementName`/`elementText`. This lets a
// plain `click` on a button literally labelled "Delete account" or "Pay now"
// classify as DELETE/PAY even though the raw tool schema is just {ref}.
const KEYWORD_CLASS_MAP = [
  { re: /\b(pay|checkout|purchase|place\s+order|buy\s+now|proceed\s+to\s+payment)\b/i, cls: 'PAY' },
  { re: /\b(delete|remove|deactivate|close\s+account|permanently)\b/i, cls: 'DELETE' },
  { re: /\b(upload|attach\s+file|choose\s+file|browse\s+files)\b/i, cls: 'UPLOAD' },
  { re: /\b(download|export|save\s+as|save\s+file)\b/i, cls: 'DOWNLOAD' },
  { re: /\b(send\s+message|send\b|reply|post\s+comment)\b/i, cls: 'SEND_MESSAGE' },
  { re: /\b(submit|apply\s+now|confirm\s+order|file\s+now|e-?file)\b/i, cls: 'SUBMIT' },
];

function classifyByKeyword(text) {
  if (!text) return null;
  for (const { re, cls } of KEYWORD_CLASS_MAP) {
    if (re.test(text)) return cls;
  }
  return null;
}

// A lone paging key only scrolls; in a text field it just moves the caret.
// Select-all only selects. Mirrored in tools.js toolActionClass.
const PAGING_KEYS_RE = /^\s*(page\s?up|page\s?down|page_up|page_down|home|end)\s*$/i;
const SELECT_ALL_RE = /^\s*(ctrl|cmd|meta|command|control)\s*\+\s*a\s*$/i;

function safeHost(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * classifyAction(toolName, input) -> actionClass string
 *
 * Mirrors tools.js's toolActionClass so both the panel (pre-check, before
 * ever calling CHECK_SITE_POLICY) and the SW (defense-in-depth, inside
 * EXEC_TOOL) agree on the same classification for the same call.
 */
export function classifyAction(toolName, input) {
  const safeInput = input || {};
  switch (toolName) {
    case 'click': {
      const hint = classifyByKeyword(safeInput.elementName || safeInput.elementText);
      return hint || 'CLICK';
    }
    case 'type_text': {
      if (safeInput.submit) return 'SUBMIT';
      const hint = classifyByKeyword(safeInput.elementName || safeInput.elementText);
      return hint || 'TYPE';
    }
    case 'select_option': {
      const hint = classifyByKeyword(safeInput.elementName || safeInput.elementText);
      return hint || 'SELECT';
    }
    case 'press_key': {
      const keys = String(safeInput.keys || '');
      if (PAGING_KEYS_RE.test(keys)) return 'SCROLL';
      if (SELECT_ALL_RE.test(keys)) return 'SELECT_TEXT';
      return /\b(enter|return)\b/i.test(keys) ? 'SUBMIT' : 'KEY';
    }
    case 'navigate': {
      const targetHost = safeHost(safeInput.url);
      const currentHost = safeHost(safeInput.currentUrl);
      if (targetHost && currentHost && targetHost !== currentHost) return 'NAVIGATE_NEW_DOMAIN';
      return 'NAVIGATE';
    }
    case 'go_back':
      return 'NAVIGATE';
    case 'scroll':
      return 'SCROLL';
    case 'screenshot':
      return 'SCREENSHOT';
    case 'read_page':
      return 'READ';
    case 'find_element':
      return 'READ';
    case 'find_text':
      return 'READ';
    case 'wait_for':
      return 'WAIT';
    case 'ask_user':
      return 'ASK_USER';
    case 'finish':
      return 'FINISH';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// run scope (a run's host allowlist — see src/agent/host-scope.js)
// ---------------------------------------------------------------------------

// Only look at (or wait on) the page. Allowed in every approval mode, and in a
// scoped run on any site, so the agent can always see where it landed and
// find its way back.
const OBSERVE_CLASSES = new Set(['READ', 'SCREENSHOT', 'SCROLL', 'SELECT_TEXT', 'WAIT', 'FIND', 'ASK_USER', 'FINISH']);
const NAVIGATE_CLASSES = new Set(['NAVIGATE', 'NAVIGATE_SAME_DOMAIN', 'NAVIGATE_NEW_DOMAIN', 'NAVIGATE_BACK']);
// On a scope's allowed sites these run without a prompt in every approval
// mode. Every RISKY_CLASSES action (pay, delete, upload, download, send, a
// submit that is not a search) still pauses for the user.
const SCOPE_PREAPPROVED = new Set(['CLICK', 'TYPE', 'KEY', 'KEY_PRESS', 'SELECT']);

function scopedNavigation(targetUrl, allowedHosts) {
  const target = httpHostOf(targetUrl);
  if (!target || !isAllowedHost(target, allowedHosts)) {
    return {
      decision: 'block',
      reason: `${target || 'That address'} is outside this run's allowed sites (${allowedHosts.join(', ')}).`,
    };
  }
  if (isDenylisted(`https://${target}`)) {
    return { decision: 'block', reason: 'That site is on Lexi’s hard denylist — Lexi will not act there.' };
  }
  return { decision: 'allow', reason: `${target} is one of this run's allowed sites.` };
}

// ---------------------------------------------------------------------------
// browsing (reading a site, not changing it)
// ---------------------------------------------------------------------------

// A same-site address that reads like an action rather than a page.
const ACTION_PATH_RE =
  /(^|[/_.?=&-])(log-?out|sign-?out|unsubscribe|delete|remove|cancel|deactivate|checkout|pay|purchase|buy)([/_.?=&-]|$)/i;

function sameOriginPage(origin, targetUrl) {
  if (!origin || !targetUrl) return false;
  try {
    const target = new URL(targetUrl, origin);
    if (!/^https?:$/.test(target.protocol) || target.origin !== new URL(origin).origin) return false;
    return !ACTION_PATH_RE.test(`${target.pathname}${target.search}`);
  } catch {
    return false;
  }
}

/**
 * Browsing for information changes nothing on a site: typing a query into
 * its search box (keys included) and running it, following a plain link (dom-index
 * isPlainLink), moving to another page of the same site, going back. These
 * run without a prompt in every approval mode, so a read-only task never asks.
 */
function browseDecision(origin, actionClass, { isSearch, isLink, isBack, targetUrl } = {}) {
  if (isSearch && ['TYPE', 'SUBMIT', 'CLICK', 'KEY', 'KEY_PRESS'].includes(actionClass)) {
    return { decision: 'allow', reason: 'Searching a site needs no approval.' };
  }
  if (isLink && actionClass === 'CLICK') {
    return { decision: 'allow', reason: 'Following a link needs no approval.' };
  }
  if (NAVIGATE_CLASSES.has(actionClass) && (isBack || sameOriginPage(origin, targetUrl))) {
    return { decision: 'allow', reason: 'Moving around the same site needs no approval.' };
  }
  return null;
}

function scopeDecision(origin, actionClass, { allowedHosts, isSearch } = {}) {
  if (OBSERVE_CLASSES.has(actionClass) || NAVIGATE_CLASSES.has(actionClass)) {
    // Navigation with a target was decided before the origin checks; this is
    // go_back, which is how the agent leaves a page outside the scope.
    return { decision: 'allow', reason: 'Looking at the page or going back is always allowed in a scoped run.' };
  }
  const host = hostOf(origin);
  if (!isAllowedHost(host, allowedHosts)) {
    return {
      decision: 'block',
      reason: `This page (${host || 'unknown site'}) is outside this run's allowed sites (${allowedHosts.join(', ')}). Go back or navigate to an allowed site.`,
    };
  }
  if (SCOPE_PREAPPROVED.has(actionClass)) {
    return { decision: 'allow', reason: `${host} is one of this run's allowed sites.` };
  }
  if (actionClass === 'SUBMIT' && isSearch) {
    return { decision: 'allow', reason: `A search on ${host}, one of this run's allowed sites.` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * check(origin, actionClass, approvalMode, toolUseId?, context?) -> {decision, reason}
 * decision is one of 'allow' | 'confirm' | 'block'.
 *
 * context (all optional, supplied by the SW, never by the page):
 *   allowedHosts — the run's scope (host allowlist); empty = unscoped run
 *   targetUrl    — where a navigate call is going
 *   isSearch     — the call types into, presses Enter in or clicks the button
 *                  of a search-only form (dom-index fieldInfo)
 *   isLink       — a click lands on a plain link (dom-index isPlainLink)
 *   isBack       — the call is go_back
 *
 * Order of precedence:
 *  0. Scoped run, navigation with a target: allowed only to an allowed,
 *     non-denylisted host — decided first, so a run may start from a new tab.
 *  1. Static DENYLIST always blocks, regardless of any grant or mode.
 *  2. Scoped run: observing and go_back are allowed; any other action off the
 *     allowed hosts is blocked; click/type/key/select and search submits on
 *     them are allowed without a prompt.
 *  2b. Observing (read, screenshot, scroll, wait, find) and browsing (a site
 *     search, a plain link, another page of the same site, going back) are
 *     allowed in every approval mode.
 *  3. An explicit per-origin grant (always- or once-duration, matching this
 *     actionClass) allows, even for an otherwise-RISKY_CLASSES action — this
 *     is what backs the confirm card's "always allow SUBMIT on this site"
 *     checkbox and a single already-approved toolUseId.
 *  4. RISKY_CLASSES always require confirm, regardless of approvalMode.
 *  5. Otherwise, gate purely on approvalMode.
 */
export async function check(origin, actionClass, approvalMode = 'manual', toolUseId = null, context = {}) {
  const allowedHosts = (context && context.allowedHosts) || [];
  const scoped = allowedHosts.length > 0;
  if (scoped && NAVIGATE_CLASSES.has(actionClass) && context.targetUrl) {
    return scopedNavigation(context.targetUrl, allowedHosts);
  }
  if (isBlockedScheme(origin)) {
    return {
      decision: 'block',
      reason: 'This is a browser-internal or extension page — Lexi can’t act here.',
    };
  }
  if (isDenylisted(origin)) {
    return {
      decision: 'block',
      reason:
        'This site is on a hard denylist (financial/payment/checkout or credential login page) — Lexi will not act here.',
    };
  }

  if (scoped) {
    const decision = scopeDecision(origin, actionClass, { allowedHosts, isSearch: !!context.isSearch });
    if (decision) return decision;
  }

  // Looking at the page changes nothing on it, so it runs without a prompt in
  // every approval mode. Manual mode confirms the actions that change a page.
  if (OBSERVE_CLASSES.has(actionClass)) {
    return { decision: 'allow', reason: 'Looking at the page needs no approval.' };
  }
  const browse = browseDecision(origin, actionClass, context || {});
  if (browse) return browse;

  const grants = await readAllGrants();
  const record = grants[origin];
  if (hasAlwaysGrant(record, actionClass) || hasOnceGrant(record, actionClass, toolUseId)) {
    return { decision: 'allow', reason: 'Previously approved for this site.' };
  }

  if (RISKY_CLASSES.includes(actionClass)) {
    return {
      decision: 'confirm',
      reason: `"${actionClass}" always requires your confirmation, regardless of approval mode.`,
    };
  }

  if (approvalMode === 'trusted') {
    return { decision: 'allow', reason: 'Trusted mode is enabled — non-blocked actions run automatically.' };
  }
  if (approvalMode === 'auto') {
    return { decision: 'allow', reason: 'Auto-approve mode — low-risk action runs automatically.' };
  }
  return { decision: 'confirm', reason: 'Manual approval mode requires confirmation for every action that changes the page.' };
}

/** isAgentEnabled(origin) -> boolean */
export async function isAgentEnabled(origin) {
  const grants = await readAllGrants();
  const record = grants[origin];
  return !!(record && record.agentEnabled && isRecordFresh(record));
}

/**
 * grantSite(origin, options) -> the updated record
 * options: {
 *   agentEnabled?: boolean,
 *   classes?: string[],
 *   duration?: 'once'|'always'  (default 'always'),
 *   toolUseId?: string,          (required when duration === 'once')
 *   expiresAt?: number|null,
 * }
 */
export async function grantSite(origin, options = {}) {
  const { agentEnabled, classes = [], duration = 'always', toolUseId = null, expiresAt } = options;
  const grants = await readAllGrants();
  const record = grants[origin] || emptyRecord();

  if (agentEnabled !== undefined) record.agentEnabled = !!agentEnabled;
  if (expiresAt !== undefined) record.expiresAt = expiresAt;

  if (classes.length) {
    if (duration === 'once') {
      record.onceGrants = record.onceGrants || [];
      for (const cls of classes) {
        record.onceGrants.push({ actionClass: cls, toolUseId });
      }
    } else {
      record.classes = Array.from(new Set([...(record.classes || []), ...classes]));
    }
  }

  grants[origin] = record;
  await writeAllGrants(grants);
  return record;
}

/** revokeSite(origin) -> void. Wipes all grants (agent-enable + classes) for an origin. */
export async function revokeSite(origin) {
  const grants = await readAllGrants();
  delete grants[origin];
  await writeAllGrants(grants);
}

/**
 * consumeOnceGrant(origin, actionClass, toolUseId) -> void
 * Clears a single-use grant right after the SW has executed the tool call it
 * was scoped to, per the "once (tied to toolUseId, cleared after use)"
 * duration semantics.
 */
export async function consumeOnceGrant(origin, actionClass, toolUseId) {
  if (!toolUseId) return;
  const grants = await readAllGrants();
  const record = grants[origin];
  if (!record || !record.onceGrants || !record.onceGrants.length) return;
  record.onceGrants = record.onceGrants.filter(
    (g) => !(g.actionClass === actionClass && g.toolUseId === toolUseId)
  );
  grants[origin] = record;
  await writeAllGrants(grants);
}
