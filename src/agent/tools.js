// src/agent/tools.js
//
// The Anthropic tool JSON schemas used by the agent loop (and, filtered to
// SEE_ONLY_TOOLS, by chat mode) plus a client-side action-class classifier
// that mirrors the service worker's permission-manager.classifyAction. This
// module is imported by both the side panel (agent-loop.js, sidepanel.js)
// and, where useful, by the service worker for a consistent view of what an
// action "is" — but it never itself talks to chrome.* APIs.
//
// ES module. No chrome.* usage here — pure data + pure functions.

/**
 * TOOLS — the full tool surface available to the model in Agent Mode.
 * Each entry is a valid Anthropic `tools[]` item: {name, description, input_schema}.
 * Field names below (ref, mode, fullPage, button, text, submit, keys,
 * direction, url, query, question, answer) are the exact input_schema
 * properties other files (action-executor.js, content scripts) expect.
 */
export const TOOLS = [
  {
    name: 'read_page',
    description:
      "Extract the current page as clean readable text plus a numbered index of interactive elements (each with a ref like e12). Use before answering questions or before any click/type. Nothing is executed — this only reads the page.",
    input_schema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['text', 'interactive', 'both'],
          description: "What to extract. 'text' = readable article text only. 'interactive' = the numbered element index only. 'both' (default) = both.",
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description:
      'Capture what is currently visible (or the full scrollable page) so you can reason about layout, charts, tables, signature blocks, or scanned exhibits that are not clean text. Prefer read_page for ordinary text.',
    input_schema: {
      type: 'object',
      properties: {
        fullPage: {
          type: 'boolean',
          description: 'Capture the full scrollable page instead of just the visible viewport. Default false. Only available in Agent Mode with the debugger already attached.',
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'click',
    description: 'Click the interactive element with the given ref (from read_page). Performs a trusted native click.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: "The element ref from read_page's interactive index, e.g. 'e12'." },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button to use. Default left.' },
      },
      required: ['ref'],
      additionalProperties: false,
    },
  },
  {
    name: 'type_text',
    description:
      'Type text into the element with the given ref. Never use this for passwords or payment fields — call ask_user instead; it will be blocked automatically.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: "The element ref from read_page's interactive index, e.g. 'e27'." },
        text: { type: 'string', description: 'The text to type into the field.' },
        submit: {
          type: 'boolean',
          description: 'If true, press Enter after typing (treated as a form submission and will require confirmation).',
        },
      },
      required: ['ref', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'press_key',
    description: "Send a key or key-combo, e.g. 'Enter', 'Tab', 'Escape', 'ctrl+a'.",
    input_schema: {
      type: 'object',
      properties: {
        keys: { type: 'string', description: "Key or '+'-joined combo, e.g. 'Enter' or 'ctrl+a'." },
      },
      required: ['keys'],
      additionalProperties: false,
    },
  },
  {
    name: 'scroll',
    description: "Scroll the page up/down/top/bottom, or scroll a specific ref into view, to reveal more content. Prefer this over screenshotting the whole page for long documents.",
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction.' },
        ref: { type: 'string', description: 'Optional element ref to scroll into view instead of scrolling the whole page.' },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the active tab to a URL. Always confirmed with the user when it crosses to a new domain, and blocked entirely for denylisted (financial/adult/auth) domains.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The absolute URL to navigate to.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'go_back',
    description: 'Go back one step in the tab history.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'find_element',
    description:
      'Natural-language search for an element when the numbered index from read_page is ambiguous or too large to reason about directly. Returns the best-matching ref.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: "Plain-language description of the element you're looking for, e.g. 'the submit button' or 'claimant name field'." },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_user',
    description:
      'Pause and hand control back to the human. REQUIRED for logins, credentials, captchas, payment, or anything ambiguous or risky. Never attempt these yourself.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question or clarification request to show the user.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'End the task and give the final answer to the user. Call this once the task is complete or you have the information the user asked for.',
    input_schema: {
      type: 'object',
      properties: {
        answer: { type: 'string', description: 'The final answer or summary to show the user.' },
      },
      required: ['answer'],
      additionalProperties: false,
    },
  },
];

/**
 * SEE_ONLY_TOOLS — the subset chat mode is allowed to pass to the model, so
 * chat can read_page/screenshot/find_element/finish/ask_user but can never
 * click or type. sidepanel.js filters TOOLS by this list for chat-mode calls.
 */
export const SEE_ONLY_TOOLS = ['read_page', 'screenshot', 'find_element', 'finish', 'ask_user'];

/** Action classes that never touch chrome.debugger / the DOM. */
const NON_MUTATING_CLASSES = new Set(['READ', 'SCREENSHOT', 'SCROLL', 'FIND', 'ASK_USER', 'FINISH', 'NAVIGATE_BACK']);

// Keyword heuristics used to upgrade a generic click / type_text to a
// RISKY_CLASSES action based on the target element's accessible name/text
// (populated as input.elementName by agent-loop.js before classification).
// Mirrors permission-manager.js's KEYWORD_CLASS_MAP so the panel's pre-check
// and the service worker's authoritative check agree on the same class — e.g.
// a click on a button literally labelled "Delete account" or "Pay now"
// classifies as DELETE / PAY (both in RISKY_CLASSES) and therefore always
// pauses for confirmation, in every approval mode.
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

/**
 * toolActionClass(name, input, currentUrl?)
 *
 * Mirrors permission-manager.js's classifyAction(toolName, input) for a
 * local, client-side pre-check (e.g. to decide whether it's even worth
 * round-tripping to the service worker). The service worker's
 * permission-manager.classifyAction is the source of truth for the actual
 * gating decision — this is a best-effort mirror so the panel can render
 * sensible UI (acting-bar intent text, optimistic risk badges) without
 * waiting on a round trip.
 *
 * `currentUrl` is optional context (the last page URL the agent observed).
 * When navigating and currentUrl is unknown, this conservatively classifies
 * the navigation as cross-domain (NAVIGATE_NEW_DOMAIN) so it is never
 * silently treated as safe.
 */
export function toolActionClass(name, input, currentUrl) {
  const safeInput = input || {};
  switch (name) {
    case 'read_page':
      return 'READ';
    case 'screenshot':
      return 'SCREENSHOT';
    case 'click':
      return classifyByKeyword(safeInput.elementName || safeInput.elementText) || 'CLICK';
    case 'type_text': {
      if (safeInput.submit) return 'SUBMIT';
      return classifyByKeyword(safeInput.elementName || safeInput.elementText) || 'TYPE';
    }
    case 'press_key':
      // An Enter/Return keypress typically submits a form — treat it as SUBMIT
      // (a RISKY_CLASSES action) rather than a benign keypress, matching
      // permission-manager.classifyAction.
      return /\b(enter|return)\b/i.test(String(safeInput.keys || '')) ? 'SUBMIT' : 'KEY_PRESS';
    case 'scroll':
      return 'SCROLL';
    case 'navigate':
      return isCrossDomain(safeInput.url, currentUrl) ? 'NAVIGATE_NEW_DOMAIN' : 'NAVIGATE_SAME_DOMAIN';
    case 'go_back':
      return 'NAVIGATE_BACK';
    case 'find_element':
      return 'FIND';
    case 'ask_user':
      return 'ASK_USER';
    case 'finish':
      return 'FINISH';
    default:
      return 'UNKNOWN';
  }
}

/** True if `actionClass` never mutates the page/tab and needs no CDP/debugger. */
export function isNonMutatingClass(actionClass) {
  return NON_MUTATING_CLASSES.has(actionClass);
}

function isCrossDomain(targetUrl, currentUrl) {
  if (!targetUrl) return true;
  if (!currentUrl) return true; // unknown origin — treat conservatively as cross-domain
  try {
    const targetOrigin = new URL(targetUrl, currentUrl).origin;
    const currentOrigin = new URL(currentUrl).origin;
    return targetOrigin !== currentOrigin;
  } catch {
    return true;
  }
}
