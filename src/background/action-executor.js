// src/background/action-executor.js
//
// Maps a single agent tool call to its execution path: CDP (primary, trusted
// input events dispatched by cdp-driver.js) when the debugger is attached, or
// a content-script synthetic-event FALLBACK when it isn't (no "debugger"
// permission granted for this origin yet, or another debugger -- e.g.
// DevTools -- already owns the tab). Every mutating action re-verifies the
// tab's origin immediately before dispatch (TOCTOU / mid-navigation defense)
// and hard-blocks typing into password/payment fields.
//
// Runs inside the service worker. service-worker.js's EXEC_TOOL handler
// delegates directly to execute() and relays the result back to the panel as
// TOOL_RESULT. Detaching the debugger at the end of a run is the caller's
// responsibility (cdp.detach / cdp.detachAll), not this module's.

import { MSG, LIMITS } from '../config.js';
import * as cdp from './cdp-driver.js';
import { isAgentEnabled } from './permission-manager.js';

/** Thrown internally when CDP is unavailable for this tab/origin and we must
 * fall back to the content-script synthetic-event path. Never leaks out of
 * execute() -- it's always translated into a fallback attempt or a plain
 * {ok:false, error} result. */
class NoDebuggerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NoDebuggerError';
  }
}

// Content scripts have no bundler and cannot use `import`; service-worker.js
// (and this module, independently, since it also needs to guarantee the
// content script is present before messaging it) injects them in dependency
// order via chrome.scripting.executeScript. Paths are extension-root-relative.
const CONTENT_SCRIPT_FILES = [
  'src/content/extract-text.js',
  'src/content/dom-index.js',
  'src/content/overlay.js',
  'src/content/content-script.js',
];

function describeError(err) {
  if (!err) return 'Unknown error.';
  return err.message || String(err);
}

function isDebuggerUnavailable(err) {
  return err instanceof cdp.DebuggerBusyError || err instanceof NoDebuggerError;
}

/** Re-read the tab's current URL origin straight from chrome.tabs (no CDP
 * dependency -- this must work even before any debugger is attached). */
async function currentOrigin(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).origin;
  } catch (_e) {
    return null;
  }
}

/** Ensure the content-script bundle is present in the tab, injecting it (in
 * dependency order) exactly once per navigation via the window.__lexiInjected
 * guard that content-script.js sets. */
async function ensureContentScript(tabId) {
  let injected = false;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => !!window.__lexiInjected,
    });
    injected = results?.[0]?.result === true;
  } catch (_e) {
    injected = false;
  }
  if (injected) return;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES,
  });
}

async function resolveRef(tabId, ref) {
  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_RESOLVE_REF, ref });
  return res || { found: false };
}

/** Lazily attach the debugger for a mutating action, but only if the user has
 * explicitly enabled agent actions on this origin. Throws NoDebuggerError
 * (caught by callers as a signal to use the synthetic-event fallback) rather
 * than a hard failure, since not having agent-mode enabled is an expected,
 * recoverable state -- not a bug. */
async function ensureAttached(tabId, origin) {
  if (cdp.isAttached(tabId)) return;
  if (!cdp.isCdpAvailable()) {
    throw new NoDebuggerError('chrome.debugger API is unavailable (optional permission not granted).');
  }
  let enabled = false;
  try {
    enabled = await isAgentEnabled(origin);
  } catch (_e) {
    enabled = false;
  }
  if (!enabled) {
    throw new NoDebuggerError('Agent actions are not enabled for this site; using the synthetic-event fallback.');
  }
  await cdp.attach(tabId);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Decode a data: URL into a Blob WITHOUT fetch() — the extension CSP's
 * connect-src ('self' + api.anthropic.com only) blocks fetching data: URLs,
 * so a fetch(dataUrl) here would throw "Failed to fetch". */
function dataUrlToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, comma);
  const mime = (/^data:([^;,]+)/.exec(meta) || [])[1] || 'image/png';
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/** Downscale a data: PNG so its long edge is <= maxLongEdgePx (LIMITS.MAX_IMAGE_PX
 * by default), matching the vision cost-control policy in the spec. Exported
 * so service-worker.js's own CAPTURE_SCREENSHOT (perception) path can reuse
 * the exact same downscale behaviour as the screenshot TOOL path below. */
export async function downscaleDataUrl(dataUrl, maxLongEdgePx = LIMITS.MAX_IMAGE_PX) {
  const blob = dataUrlToBlob(dataUrl);
  const bitmap = await createImageBitmap(blob);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale = longEdge > maxLongEdgePx ? maxLongEdgePx / longEdge : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  const outBlob = await canvas.convertToBlob({ type: 'image/png' });
  const buffer = await outBlob.arrayBuffer();
  return {
    dataUrl: `data:image/png;base64,${arrayBufferToBase64(buffer)}`,
    width,
    height,
  };
}

async function execReadPage(input, tabId) {
  const mode = input?.mode || 'both';
  await ensureContentScript(tabId);
  const out = { text: '', truncated: false, elements: [] };
  if (mode === 'text' || mode === 'both') {
    const page = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_EXTRACT, mode });
    out.text = page?.text || '';
    out.truncated = !!page?.truncated;
  }
  if (mode === 'interactive' || mode === 'both') {
    const idx = await chrome.tabs.sendMessage(tabId, { type: MSG.CS_INDEX });
    out.elements = idx?.elements || [];
  }
  return out;
}

/** captureVisibleTab can only photograph the tab the user is currently
 * looking at in that window. In real side-panel usage the target tab IS the
 * active tab, so this is a straight capture. If the target tab is NOT active
 * (the ?testTabId harness, or the user switched tabs mid-run), briefly
 * activate it, capture, and restore the previously active tab — photographing
 * whatever unrelated tab happens to be focused would be silently wrong. */
async function captureTargetTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.active) {
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  }
  const [prevActive] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  await chrome.tabs.update(tabId, { active: true });
  // Give the newly-activated tab a moment to paint before capturing.
  await new Promise((resolve) => setTimeout(resolve, 350));
  try {
    return await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (prevActive && prevActive.id !== undefined && prevActive.id !== tabId) {
      await chrome.tabs.update(prevActive.id, { active: true }).catch(() => {});
    }
  }
}

async function execScreenshot(input, tabId) {
  const fullPage = !!input?.fullPage;
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { type: MSG.CS_HIDE_FOR_TOOL }).catch(() => {});
  try {
    let dataUrl;
    if (fullPage) {
      const origin = await currentOrigin(tabId);
      await ensureAttached(tabId, origin);
      const base64 = await cdp.captureFullPage(tabId);
      dataUrl = `data:image/png;base64,${base64}`;
    } else {
      dataUrl = await captureTargetTab(tabId);
    }
    return await downscaleDataUrl(dataUrl, LIMITS.MAX_IMAGE_PX);
  } finally {
    await chrome.tabs.sendMessage(tabId, { type: MSG.CS_SHOW_AFTER_TOOL }).catch(() => {});
  }
}

async function execScroll(input, tabId) {
  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, {
    type: MSG.CS_SYNTHETIC_ACTION,
    action: 'scroll',
    direction: input?.direction || 'down',
    ref: input?.ref,
  });
  return res || { ok: true };
}

async function execGoBack(tabId) {
  await chrome.tabs.goBack(tabId);
  return { wentBack: true };
}

async function execNavigate(input, tabId) {
  // Compare the LIVE origin against the origin captured when the tool call was
  // queued (passed down as input.originAtQueue by agent-loop.js), so the
  // TOCTOU window actually spans the classify → confirm → dispatch gap. Reading
  // currentOrigin twice back-to-back here would be a no-op — there is no
  // intervening async work for a navigation to race with.
  const originBefore = input.originAtQueue || (await currentOrigin(tabId));
  const originNow = await currentOrigin(tabId);
  if (originBefore && originNow && originBefore !== originNow) {
    return { ok: false, error: 'tab navigated mid-action, aborted' };
  }
  try {
    await chrome.tabs.update(tabId, { url: input.url });
    return { ok: true, result: { navigatedTo: input.url } };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

async function execClick(input, tabId) {
  // Queue-time origin (from when agent-loop.js first classified the call, ahead
  // of the confirm wait) so the re-check below spans the whole time-of-check to
  // time-of-use window, including ensureAttached's real attach round trip.
  const originBefore = input.originAtQueue || (await currentOrigin(tabId));
  const refInfo = await resolveRef(tabId, input.ref);
  if (!refInfo.found) {
    return { ok: false, error: `Element ${input.ref} was not found on the page (it may have scrolled away or changed).` };
  }
  if (refInfo.sensitive) {
    return { ok: false, error: 'Refusing to click a sensitive (password/payment) field. Call ask_user instead.' };
  }
  const { x, y, w, h } = refInfo.bbox;
  const cx = x + w / 2;
  const cy = y + h / 2;
  try {
    await ensureAttached(tabId, await currentOrigin(tabId));
    // Re-verify the origin immediately before dispatch — AFTER the debugger
    // attach (the one genuinely slow async step) — so a navigation during
    // attach can't land a trusted click on the new, unverified page.
    const originNow = await currentOrigin(tabId);
    if (originBefore && originNow && originBefore !== originNow) {
      return { ok: false, error: 'tab navigated mid-action, aborted' };
    }
    await cdp.clickAt(tabId, cx, cy, input.button || 'left');
    return { ok: true, result: { clicked: input.ref } };
  } catch (err) {
    if (isDebuggerUnavailable(err)) {
      const originNow = await currentOrigin(tabId);
      if (originBefore && originNow && originBefore !== originNow) {
        return { ok: false, error: 'tab navigated mid-action, aborted' };
      }
      const res = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CS_SYNTHETIC_ACTION, action: 'click', ref: input.ref,
      });
      if (res?.ok) return { ok: true, result: { clicked: input.ref, fallback: true } };
      return { ok: false, error: res?.error || 'Synthetic click fallback failed.' };
    }
    return { ok: false, error: describeError(err) };
  }
}

async function execTypeText(input, tabId) {
  const originBefore = input.originAtQueue || (await currentOrigin(tabId));
  const refInfo = await resolveRef(tabId, input.ref);
  if (!refInfo.found) {
    return { ok: false, error: `Element ${input.ref} was not found on the page (it may have scrolled away or changed).` };
  }
  if (refInfo.sensitive) {
    return { ok: false, error: 'Refusing to type into a password or payment field. Call ask_user instead.' };
  }
  const { x, y, w, h } = refInfo.bbox;
  const cx = x + w / 2;
  const cy = y + h / 2;
  try {
    await ensureAttached(tabId, await currentOrigin(tabId));
    // Re-verify origin after the attach round trip, immediately before dispatch.
    const originNow = await currentOrigin(tabId);
    if (originBefore && originNow && originBefore !== originNow) {
      return { ok: false, error: 'tab navigated mid-action, aborted' };
    }
    await cdp.clickAt(tabId, cx, cy);
    await cdp.typeText(tabId, input.text ?? '');
    if (input.submit) {
      await cdp.pressKeys(tabId, 'Enter');
    }
    return { ok: true, result: { typed: input.ref, submitted: !!input.submit } };
  } catch (err) {
    if (isDebuggerUnavailable(err)) {
      const originNow = await currentOrigin(tabId);
      if (originBefore && originNow && originBefore !== originNow) {
        return { ok: false, error: 'tab navigated mid-action, aborted' };
      }
      const typeRes = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CS_SYNTHETIC_ACTION, action: 'type', ref: input.ref, text: input.text ?? '',
      });
      if (!typeRes?.ok) {
        return { ok: false, error: typeRes?.error || 'Synthetic type fallback failed.' };
      }
      if (input.submit) {
        await chrome.tabs.sendMessage(tabId, {
          type: MSG.CS_SYNTHETIC_ACTION, action: 'keys', ref: input.ref, keys: 'Enter',
        }).catch(() => {});
      }
      return { ok: true, result: { typed: input.ref, submitted: !!input.submit, fallback: true } };
    }
    return { ok: false, error: describeError(err) };
  }
}

async function execPressKey(input, tabId) {
  const originBefore = input.originAtQueue || (await currentOrigin(tabId));
  try {
    await ensureAttached(tabId, await currentOrigin(tabId));
    const originNow = await currentOrigin(tabId);
    if (originBefore && originNow && originBefore !== originNow) {
      return { ok: false, error: 'tab navigated mid-action, aborted' };
    }
    await cdp.pressKeys(tabId, input.keys);
    return { ok: true, result: { pressed: input.keys } };
  } catch (err) {
    if (isDebuggerUnavailable(err)) {
      const res = await chrome.tabs.sendMessage(tabId, {
        type: MSG.CS_SYNTHETIC_ACTION, action: 'keys', keys: input.keys,
      });
      if (res?.ok) return { ok: true, result: { pressed: input.keys, fallback: true } };
      return { ok: false, error: res?.error || 'Synthetic key-press fallback failed.' };
    }
    return { ok: false, error: describeError(err) };
  }
}

/**
 * Execute a single agent tool call. Returns {ok, result?, error?}.
 *
 * toolName is one of the names in tools.js's TOOLS (read_page, screenshot,
 * click, type_text, press_key, scroll, navigate, go_back, find_element).
 * ask_user and finish never reach here -- they terminate/park the loop
 * entirely client-side in agent-loop.js.
 */
export async function execute(toolName, input, tabId) {
  try {
    switch (toolName) {
      case 'read_page':
        return { ok: true, result: await execReadPage(input, tabId) };
      case 'screenshot':
        return { ok: true, result: await execScreenshot(input, tabId) };
      case 'scroll':
        return { ok: true, result: await execScroll(input, tabId) };
      case 'go_back':
        return { ok: true, result: await execGoBack(tabId) };
      case 'navigate':
        return await execNavigate(input, tabId);
      case 'click':
        return await execClick(input, tabId);
      case 'type_text':
        return await execTypeText(input, tabId);
      case 'press_key':
        return await execPressKey(input, tabId);
      case 'find_element':
        // find_element is resolved client-side by agent-loop.js: it needs a
        // nested Anthropic (Haiku) call over the read_page index text the
        // panel already holds, so it never crosses into EXEC_TOOL. Guarded
        // here defensively in case a caller dispatches it anyway.
        return {
          ok: false,
          error: 'find_element is resolved in agent-loop.js via a nested model call and should not be sent as EXEC_TOOL.',
        };
      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
