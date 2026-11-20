// src/background/bridge-ask.js
//
// Asks the user, in a small Chrome window, before Lexi chat (the browser
// bridge) uses a site that is not on their list, and before it does anything
// Agent Mode would confirm (submit, pay, send, upload, download, delete).
// Chat runs on the server, so this window is the only place the user can say
// yes. One window at a time; closing it, or no answer within
// BRIDGE_ASK_TIMEOUT_MS, is a no.
//
// Only the ask page itself, in the window opened for that question, can
// answer it (answerAsk checks the sender), so a content script or a page
// cannot approve anything.

import { BRIDGE_ASK_TIMEOUT_MS } from '../config.js';

const ASK_PAGE = 'src/bridge/ask.html';

// What each action class asks for ("Lexi chat wants to <label> on <site>").
const ACTION_LABELS = {
  SUBMIT: 'submit a form',
  PAY: 'make a payment',
  SEND_MESSAGE: 'send a message',
  UPLOAD: 'upload a file',
  DOWNLOAD: 'download a file',
  DELETE: 'delete something',
  NAVIGATE_NEW_DOMAIN: 'go to another site',
  CLICK: 'click',
  TYPE: 'type into a field',
  KEY: 'press a key',
  KEY_PRESS: 'press a key',
  SELECT: 'choose an option',
};

// id -> {finish(answer), windowId}
const pending = new Map();
let queue = Promise.resolve();

/** A label for the action class, for the ask window and error messages. */
export function actionLabel(actionClass) {
  return ACTION_LABELS[actionClass] || `do “${String(actionClass || 'this').toLowerCase()}”`;
}

/**
 * ask(question) -> Promise<'once' | 'always' | 'no'>
 *
 * question:
 *   {kind: 'site', hosts: string[]}            — Allow for this task / Always / No
 *   {kind: 'action', host, action, element?, text?} — Allow / No
 */
export function ask(question) {
  const run = queue.then(() => show(question));
  queue = run.catch(() => {});
  return run;
}

function show(question) {
  const id = crypto.randomUUID();
  const params = new URLSearchParams({ id, kind: question.kind });
  if (question.kind === 'site') {
    params.set('hosts', (question.hosts || []).join(','));
  } else {
    params.set('host', question.host || '');
    params.set('action', actionLabel(question.action));
    if (question.element) params.set('element', String(question.element).slice(0, 120));
    if (question.text) params.set('text', String(question.text).slice(0, 200));
  }

  return new Promise((resolve) => {
    let timer = null;
    const entry = {
      windowId: null,
      finish(answer) {
        if (!pending.has(id)) return;
        pending.delete(id);
        clearTimeout(timer);
        if (entry.windowId !== null) chrome.windows.remove(entry.windowId).catch(() => {});
        resolve(answer);
      },
    };
    pending.set(id, entry);
    timer = setTimeout(() => entry.finish('no'), BRIDGE_ASK_TIMEOUT_MS);
    chrome.windows
      .create({
        url: chrome.runtime.getURL(`${ASK_PAGE}?${params}`),
        type: 'popup',
        width: 460,
        height: 360,
        focused: true,
      })
      .then((win) => {
        entry.windowId = win.id;
        if (!pending.has(id)) chrome.windows.remove(win.id).catch(() => {});
      })
      .catch(() => entry.finish('no'));
  });
}

/**
 * The ask page's answer. Accepted only from the ask page in the window opened
 * for that question; returns whether it was.
 */
export function answerAsk(id, answer, sender) {
  const entry = pending.get(id);
  if (!entry || !sender || !sender.tab) return false;
  const page = chrome.runtime.getURL(ASK_PAGE);
  if (!String(sender.url || '').startsWith(page) || sender.tab.windowId !== entry.windowId) return false;
  entry.finish(['once', 'always'].includes(answer) ? answer : 'no');
  return true;
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of [...pending.values()]) {
    if (entry.windowId === windowId) entry.finish('no');
  }
});
