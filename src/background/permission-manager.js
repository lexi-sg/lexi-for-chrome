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
    case 'press_key': {
      const keys = String(safeInput.keys || '');
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
    case 'ask_user':
      return 'ASK_USER';
    case 'finish':
      return 'FINISH';
    default:
      return 'UNKNOWN';
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/**
 * check(origin, actionClass, approvalMode, toolUseId?) -> {decision, reason}
 * decision is one of 'allow' | 'confirm' | 'block'.
 *
 * Order of precedence:
 *  1. Static DENYLIST always blocks, regardless of any grant or mode.
 *  2. An explicit per-origin grant (always- or once-duration, matching this
 *     actionClass) allows, even for an otherwise-RISKY_CLASSES action — this
 *     is what backs the confirm card's "always allow SUBMIT on this site"
 *     checkbox and a single already-approved toolUseId.
 *  3. RISKY_CLASSES always require confirm, regardless of approvalMode.
 *  4. Otherwise, gate purely on approvalMode.
 */
export async function check(origin, actionClass, approvalMode = 'manual', toolUseId = null) {
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
  return { decision: 'confirm', reason: 'Manual approval mode requires confirmation for every action.' };
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
