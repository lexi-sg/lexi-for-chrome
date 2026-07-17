// src/background/cdp-driver.js
//
// Owns the chrome.debugger lifecycle and the low-level CDP command recipes
// used by action-executor.js to dispatch trusted input events (click / type /
// key) and to capture true full-page screenshots. A tab is attached lazily on
// the first agentic action that needs it and detached at the end of every
// agent loop (defense-in-depth: minimizes Chrome's debugging infobar and
// avoids "another debugger already attached" collisions with DevTools).
//
// This module has NO knowledge of tool names, refs, or bboxes -- that
// resolution lives in action-executor.js. It only knows tabIds, coordinates,
// and CDP wire calls. Runs inside the service worker (ES module).

const PROTOCOL_VERSION = '1.3';

/** @type {Set<number>} tabIds currently attached via chrome.debugger. */
const attachedTabs = new Set();

/**
 * Thrown when chrome.debugger.attach fails because some other debugger
 * (typically Chrome DevTools) already owns the tab. The agent loop should
 * surface this to the user and fall back to the synthetic-event path.
 */
export class DebuggerBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DebuggerBusyError';
  }
}

/** True if the (optional) "debugger" permission is currently granted. */
export function isCdpAvailable() {
  return typeof chrome !== 'undefined' && !!chrome.debugger;
}

/** True if we currently hold a live chrome.debugger session on this tab. */
export function isAttached(tabId) {
  return attachedTabs.has(tabId);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlreadyAttachedMessage(message) {
  return typeof message === 'string' && /already attached/i.test(message);
}

/** Promise wrapper around chrome.debugger.sendCommand. */
function sendCommand(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!isCdpAvailable()) {
      reject(new Error('chrome.debugger API is unavailable (optional permission not granted).'));
      return;
    }
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || `CDP command ${method} failed.`));
        return;
      }
      resolve(result);
    });
  });
}

/**
 * Attach the debugger to a tab and enable the domains we need. No-op if
 * already attached. Throws DebuggerBusyError if another debugger (e.g. open
 * DevTools) owns the tab.
 */
export async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  if (!isCdpAvailable()) {
    throw new Error('chrome.debugger API is unavailable (optional permission not granted).');
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        if (isAlreadyAttachedMessage(err.message)) {
          reject(new DebuggerBusyError(
            'Another debugger (e.g. Chrome DevTools) is already attached to this tab. '
            + 'Close it and try again.',
          ));
        } else {
          reject(new Error(err.message || 'Failed to attach chrome.debugger to the tab.'));
        }
        return;
      }
      resolve();
    });
  });
  attachedTabs.add(tabId);
  try {
    await sendCommand(tabId, 'Page.enable');
    await sendCommand(tabId, 'DOM.enable');
    await sendCommand(tabId, 'Runtime.enable');
  } catch (err) {
    attachedTabs.delete(tabId);
    throw err;
  }
}

/** Detach the debugger session for a single tab. Safe to call if not attached. */
export async function detach(tabId) {
  if (!attachedTabs.has(tabId)) return;
  attachedTabs.delete(tabId);
  if (!isCdpAvailable()) return;
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      // Swallow errors: the tab may already be closed, or Chrome may have
      // already detached us (e.g. the user hit the infobar's Cancel button).
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

/** Detach every currently-attached tab. Called on panel disconnect / stop. */
export async function detachAll() {
  const tabIds = Array.from(attachedTabs);
  await Promise.all(tabIds.map((tabId) => detach(tabId)));
}

/**
 * Sync our tracked state when Chrome detaches a session out from under us
 * (chrome.debugger.onDetach, e.g. reason "canceled_by_user" from the
 * infobar, or "target_closed"). service-worker.js should call this from its
 * onDetach listener; it does not itself call chrome.debugger.detach.
 */
export function forgetDetached(tabId) {
  attachedTabs.delete(tabId);
}

const MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

const SPECIAL_KEYS = {
  enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
};

/** Click at viewport-relative CSS pixel coordinates via a trusted CDP event. */
export async function clickAt(tabId, x, y, button = 'left') {
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', buttons: 0,
  });
  await delay(60);
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, buttons: 1, clickCount: 1,
  });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1,
  });
}

/** Type text into whatever element currently holds focus, char by char. */
export async function typeText(tabId, text) {
  const chars = Array.from(String(text));
  for (const ch of chars) {
    if (ch === '\n') {
      await pressKeys(tabId, 'Enter');
    } else {
      await sendCommand(tabId, 'Input.insertText', { text: ch });
    }
    await delay(40);
  }
}

function buildKeyDescriptor(token) {
  const lower = token.toLowerCase();
  const special = SPECIAL_KEYS[lower];
  if (special) return special;
  if (Array.from(token).length === 1) {
    const upper = token.toUpperCase();
    return { key: token, code: /[a-zA-Z]/.test(token) ? `Key${upper}` : token, text: token };
  }
  return { key: token, code: token };
}

/**
 * Send a key or key-combo, e.g. "Enter", "Escape", "ctrl+a". Modifiers are
 * '+'-joined and precede the final key token.
 */
export async function pressKeys(tabId, keys) {
  const parts = String(keys).split('+').map((p) => p.trim()).filter(Boolean);
  const mainToken = parts.length ? parts[parts.length - 1] : 'Enter';
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit) modifiers |= bit;
  }
  const keyDef = buildKeyDescriptor(mainToken);
  const base = {
    modifiers,
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
  };
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown', ...base, text: keyDef.text,
  });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', ...base,
  });
}

/** Read the tab's current URL via CDP (used for TOCTOU-safe re-checks). */
export async function currentUrl(tabId) {
  const result = await sendCommand(tabId, 'Runtime.evaluate', {
    expression: 'location.href',
    returnByValue: true,
  });
  return result?.result?.value;
}

/**
 * Capture a true full-page screenshot (beyond the viewport) via CDP.
 * Requires the debugger to already be attached. Returns raw base64 PNG data
 * (no data: prefix) -- callers are responsible for downscaling.
 */
export async function captureFullPage(tabId) {
  let width = 1280;
  let height = 800;
  try {
    const metrics = await sendCommand(tabId, 'Runtime.evaluate', {
      expression: 'JSON.stringify({'
        + 'w: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),'
        + 'h: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)'
        + '})',
      returnByValue: true,
    });
    const parsed = JSON.parse(metrics?.result?.value || '{}');
    if (parsed.w) width = parsed.w;
    if (parsed.h) height = parsed.h;
  } catch (_e) {
    // fall back to the defaults above
  }
  await sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  try {
    const shot = await sendCommand(tabId, 'Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    return shot?.data;
  } finally {
    try {
      await sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
    } catch (_e) {
      // best-effort cleanup only
    }
  }
}
