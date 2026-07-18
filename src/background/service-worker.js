// src/background/service-worker.js
//
// SW entry point: Port registry + heartbeat, message router, screenshot
// capture (+ downscale), content-script injection (dependency order),
// chrome.alarms keepalive, and the CDP + permission-manager wiring.
//
// This file is a near-stateless coordinator + tool executor per
// architecture_overview. It persists all durable state to
// chrome.storage.local (module-level variables — the Maps/Sets below — are
// NOT retained across SW teardown and are treated as pure caches).
//
// ES module (manifest declares "type":"module" for the background service
// worker), so this file may `import` freely — unlike content scripts.

import {
  MSG,
  PORT_NAME,
  ANTHROPIC_MODELS_URL,
  ANTHROPIC_VERSION,
  STORAGE_KEYS,
  RISKY_CLASSES,
  AGENT_MODE_AVAILABLE,
  CONNECT_ORIGINS,
  CONNECT_NONCE_KEY,
  SESSION_PATH,
  REVOKE_PATH,
} from '../config.js';
import { refreshChannelConfig, getActiveConfig, ensureActiveConfig } from './channel-config.js';
import * as permissionManager from './permission-manager.js';
import {
  attach,
  detach,
  detachAll,
  forgetDetached,
  isAttached,
  isCdpAvailable,
  wasEverAttached,
} from './cdp-driver.js';
import { execute as executeTool } from './action-executor.js';

// Read-only observability of the CDP attach state, for the acting-bar UI and
// the e2e harness (which asserts the trusted-input path really attached and
// then detached). Exposing two pure state-readers on the SW global is safe:
// the service-worker global is not reachable from any web page, and neither
// function mutates anything.
self.__lexiCdp = { isAttached, wasEverAttached };

// ---------------------------------------------------------------------------
// Content-script injection order (open_risks: no bundler => classic scripts
// injected in dependency order). Content scripts self-guard against double
// installation via `window.__lexi.*` presence checks, so re-injecting is
// harmless but wasteful; we still cache per-tab to avoid the extra round
// trip on every perception/action call within this SW lifetime.
// ---------------------------------------------------------------------------
const CONTENT_SCRIPT_FILES = [
  'src/content/extract-text.js',
  'src/content/dom-index.js',
  'src/content/overlay.js',
  'src/content/content-script.js',
];

// tabId -> true once we know content scripts are live there (best-effort
// cache; cleared if a message to the tab fails so we re-inject).
const injectedTabs = new Set();
// tabId -> in-flight injection Promise, to de-dupe concurrent callers.
const injectionInFlight = new Map();

async function ensureInjected(tabId) {
  if (injectedTabs.has(tabId)) return;
  if (injectionInFlight.has(tabId)) return injectionInFlight.get(tabId);

  const p = chrome.scripting
    .executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES })
    .then(() => {
      injectedTabs.add(tabId);
    })
    .finally(() => {
      injectionInFlight.delete(tabId);
    });
  injectionInFlight.set(tabId, p);
  return p;
}

/**
 * Send a message to the content script in a tab, injecting (or
 * re-injecting, if our cache is stale after a navigation) on demand.
 */
async function sendToContentScript(tabId, message) {
  await ensureInjected(tabId);
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    // Likely "Could not establish connection" after a navigation tore down
    // the previous injection (activeTab is per-gesture; SPA navigations can
    // invalidate it). Force a fresh injection and retry once.
    injectedTabs.delete(tabId);
    await ensureInjected(tabId);
    return chrome.tabs.sendMessage(tabId, message);
  }
}

// ---------------------------------------------------------------------------
// Port registry — one entry per connected side panel.
// ---------------------------------------------------------------------------
// portId -> {port, tabId}
const ports = new Map();

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function getTabOrigin(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return originOf(tab && tab.url);
}

function broadcast(message, filterTabId) {
  for (const { port, tabId } of ports.values()) {
    if (filterTabId !== undefined && filterTabId !== null && tabId !== filterTabId) continue;
    try {
      port.postMessage(message);
    } catch {
      // Port likely already disconnected; onDisconnect cleanup will remove it.
    }
  }
}

// ---------------------------------------------------------------------------
// Screenshot capture — delegates to action-executor's screenshot tool so the
// panel's CAPTURE_SCREENSHOT (perception) path and the agent's screenshot
// TOOL path share one implementation: same overlay hide/show, same
// non-active-tab handling, same downscale policy.
// ---------------------------------------------------------------------------

async function captureScreenshot(input, tabId) {
  const fullPage = !!(input && input.fullPage);
  const { ok, result, error } = await executeTool('screenshot', { fullPage }, tabId);
  if (!ok) throw new Error(error || 'Screenshot capture failed.');
  return result;
}

// ---------------------------------------------------------------------------
// Page extraction
// ---------------------------------------------------------------------------

async function extractPage(input, tabId) {
  const mode = (input && input.mode) || 'both';
  const result = { mode, truncated: false };

  if (mode === 'text' || mode === 'both') {
    const page = await sendToContentScript(tabId, { type: MSG.CS_EXTRACT, mode });
    result.text = page && page.text;
    result.truncated = !!(page && page.truncated);
    result.title = page && page.title;
    result.url = page && page.url;
  }
  if (mode === 'interactive' || mode === 'both') {
    const idx = await sendToContentScript(tabId, { type: MSG.CS_INDEX });
    result.elements = (idx && idx.elements) || [];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

async function validateKey(apiKey) {
  if (!apiKey) return { valid: false, error: 'No API key provided.' };
  try {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: 'That key was rejected by Anthropic (unauthorized).' };
    }
    if (!res.ok) {
      return { valid: false, error: `Anthropic returned HTTP ${res.status}.` };
    }
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: `Could not reach Anthropic: ${err && err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getSettings() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.API_KEY,
    STORAGE_KEYS.MODEL,
    STORAGE_KEYS.APPROVAL_MODE,
    STORAGE_KEYS.PROVIDER,
    STORAGE_KEYS.AUTH_MODE,
    STORAGE_KEYS.EXTENSION_TOKEN,
    STORAGE_KEYS.ACCOUNT_INFO,
  ]);
  const apiKey = data[STORAGE_KEYS.API_KEY] || null;
  const token = data[STORAGE_KEYS.EXTENSION_TOKEN] || null;

  // Effective auth mode. Exactly one path is ever selected (no runtime
  // fallback): an explicit AUTH_MODE wins; otherwise a token means account,
  // a bare API key means the BYOK escape hatch, and neither means signed out.
  let authMode = data[STORAGE_KEYS.AUTH_MODE] || null;
  if (authMode === 'account' && !token) authMode = null;
  if (!authMode) authMode = token ? 'account' : apiKey ? 'byok' : null;

  return {
    apiKey,
    model: data[STORAGE_KEYS.MODEL] || null,
    approvalMode: data[STORAGE_KEYS.APPROVAL_MODE] || 'manual',
    provider: data[STORAGE_KEYS.PROVIDER] || null,
    authMode,
    extensionToken: token,
    accountInfo: data[STORAGE_KEYS.ACCOUNT_INFO] || null,
  };
}

// ---------------------------------------------------------------------------
// Account auth — sign-in handoff, sign-out/revoke, session fetch.
// ---------------------------------------------------------------------------

/**
 * SIGN_IN_START: mint a single-use nonce into TRUSTED session storage and open
 * the lexi-frontend connect page in a new tab. The connect page authenticates
 * the browser's Clerk session and relays a token back via onMessageExternal.
 */
async function startSignIn() {
  const nonce = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [CONNECT_NONCE_KEY]: nonce });
  }
  // Resolve the connect page from the ACTIVE channel (prod app.getlexi.io or
  // staging.getlexi.io), so a channel flip sends new sign-ins to the matching
  // connect page without a new build. ensureActiveConfig (not the cache-first
  // getActiveConfig) so a brand-new install whose first background refresh has
  // not landed yet resolves the channel NOW rather than defaulting to prod —
  // otherwise a CWS reviewer on a staging build who clicks Sign in within the
  // first few seconds would be sent to the prod connect page.
  const { connect_url: connectUrl } = await ensureActiveConfig();
  await chrome.tabs.create({ url: `${connectUrl}?state=${encodeURIComponent(nonce)}` });
  return null; // no reply — the panel waits for the AUTH_CHANGED broadcast
}

/**
 * SIGN_OUT: best-effort server revoke (instant kill-switch), then clear the
 * three account keys locally and broadcast the change. Any stored BYOK key is
 * left untouched.
 */
async function signOut() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.EXTENSION_TOKEN);
  const token = stored[STORAGE_KEYS.EXTENSION_TOKEN];
  if (token) {
    try {
      const { api_base: apiBase } = await getActiveConfig();
      await fetch(`${apiBase}${REVOKE_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
    } catch {
      // Revoke is best-effort; the local clear below still signs the user out.
    }
  }
  await clearAccountKeys();
  broadcast({ type: MSG.AUTH_CHANGED, signedOut: true });
  return { type: MSG.AUTH_CHANGED, signedOut: true };
}

async function clearAccountKeys() {
  await chrome.storage.local.remove([
    STORAGE_KEYS.AUTH_MODE,
    STORAGE_KEYS.EXTENSION_TOKEN,
    STORAGE_KEYS.ACCOUNT_INFO,
  ]);
}

/**
 * GET_SESSION: fetch the account identity + usage meter for the account chip.
 * A 401 means the session was revoked/expired: clear it and report `expired`
 * so the panel shows the re-auth banner (never a silent BYOK fallback).
 */
async function getSession() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.EXTENSION_TOKEN);
  const token = stored[STORAGE_KEYS.EXTENSION_TOKEN];
  if (!token) return { type: MSG.SESSION, ok: false, signedOut: true, error: 'Not signed in.' };
  try {
    const { api_base: apiBase } = await getActiveConfig();
    const res = await fetch(`${apiBase}${SESSION_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await clearAccountKeys();
      broadcast({ type: MSG.AUTH_CHANGED, expired: true });
      return { type: MSG.SESSION, ok: false, expired: true, error: 'Session expired.' };
    }
    if (!res.ok) return { type: MSG.SESSION, ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    if (data && data.account) {
      await chrome.storage.local.set({ [STORAGE_KEYS.ACCOUNT_INFO]: data.account });
    }
    return {
      type: MSG.SESSION,
      ok: true,
      account: data.account,
      usage: data.usage,
      models: data.models,
    };
  } catch (err) {
    return { type: MSG.SESSION, ok: false, error: (err && err.message) || 'Network error.' };
  }
}

/**
 * Validate an inbound external LEXI_EXTENSION_CONNECT handoff. Pure so the SW
 * message logic (and tests) can assert the origin + replay-nonce checks.
 * @returns {boolean} true iff the message may be trusted.
 */
function isValidConnectMessage(message, senderOrigin, storedNonce) {
  if (!message || message.type !== MSG.CONNECT_RECEIVED) return false;
  if (!senderOrigin || !CONNECT_ORIGINS.includes(senderOrigin)) return false;
  if (!storedNonce || !message.state || message.state !== storedNonce) return false;
  if (!message.token) return false;
  return true;
}

/** onMessageExternal handler for the connect-page token handoff. */
async function handleExternalConnect(message, sender) {
  const senderOrigin = sender && sender.origin;
  const sessionData = chrome.storage.session
    ? await chrome.storage.session.get(CONNECT_NONCE_KEY)
    : {};
  const storedNonce = sessionData[CONNECT_NONCE_KEY];
  if (!isValidConnectMessage(message, senderOrigin, storedNonce)) return { ok: false };

  await chrome.storage.local.set({
    [STORAGE_KEYS.AUTH_MODE]: 'account',
    [STORAGE_KEYS.EXTENSION_TOKEN]: message.token,
    [STORAGE_KEYS.ACCOUNT_INFO]: message.account || null,
  });
  if (chrome.storage.session) await chrome.storage.session.remove(CONNECT_NONCE_KEY);
  broadcast({ type: MSG.AUTH_CHANGED, signedIn: true, account: message.account || null });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// EXEC_TOOL
// ---------------------------------------------------------------------------

async function execTool(message, tabId) {
  const { toolUseId, input } = message;
  // The tool name arrives under different keys depending on the caller:
  // agent-loop.js sends `name`, sidepanel.js's chat-mode loop sends
  // `toolName`, and the original SW contract used `tool`. Accept all three.
  const tool = message.tool ?? message.name ?? message.toolName;

  // Defense-in-depth: the panel gates confirmations client-side, but the SW is
  // the real execution boundary. Re-derive the policy here from the LIVE tab
  // origin (never a client-supplied value) and the SW's own classification of
  // the call — including the target element's accessible name, which
  // agent-loop.js forwards on the input for exactly this re-check.
  const origin = await getTabOrigin(tabId).catch(() => null);
  const actionClass = permissionManager.classifyAction(tool, input);
  const policy = await permissionManager.check(origin, actionClass, 'manual', toolUseId);

  // Hard denylist / browser-internal scheme: never execute.
  if (policy.decision === 'block') {
    return { toolUseId, ok: false, result: null, error: policy.reason };
  }

  // A RISKY_CLASSES action MUST carry an explicit human grant (once/always),
  // which the panel persists on CONFIRM_RESPONSE before dispatching EXEC_TOOL.
  // If we can't see that grant (policy is still 'confirm'), refuse rather than
  // trusting the panel-side gate alone — so a buggy or compromised panel-side
  // classification can't slip an unconfirmed pay/delete/submit through.
  if (RISKY_CLASSES.includes(actionClass) && policy.decision !== 'allow') {
    return {
      toolUseId,
      ok: false,
      result: null,
      error: `"${actionClass}" requires explicit confirmation, which was not on record — not executing.`,
    };
  }

  if (origin && toolUseId) {
    // Best-effort cleanup of any once-grant this call was consuming.
    await permissionManager.consumeOnceGrant(origin, actionClass, toolUseId).catch(() => {});
  }

  try {
    const { ok, result, error } = await executeTool(tool, input, tabId);
    return { toolUseId, ok: !!ok, result: result ?? null, error: error || null };
  } catch (err) {
    return { toolUseId, ok: false, result: null, error: (err && err.message) || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Control-mode announcement — attach the debugger up-front for an agent run and
// tell the panel whether we're driving the tab with TRUSTED CDP input events
// or the synthetic-event compatibility fallback.
// ---------------------------------------------------------------------------

async function announceControlMode(tabId) {
  let cdp = false;
  try {
    if (isCdpAvailable()) {
      const origin = await getTabOrigin(tabId).catch(() => null);
      const enabled = origin ? await permissionManager.isAgentEnabled(origin) : false;
      if (enabled) {
        await attach(tabId);
        cdp = isAttached(tabId);
      }
    }
  } catch (_e) {
    // DebuggerBusyError (DevTools open), permission denied, or a closed tab:
    // fall back to synthetic events. The forgetDetached/attachedTabs bookkeeping
    // in cdp-driver already left our state clean on a failed attach.
    cdp = false;
  }
  broadcast(
    { type: MSG.AGENT_ACTING, tabId, cdp, control: cdp ? 'trusted' : 'fallback' },
    tabId,
  );
}

// ---------------------------------------------------------------------------
// Central message handler — shared by the Port channel (side panel) and the
// one-off chrome.runtime.onMessage channel (options page).
// ---------------------------------------------------------------------------

async function handleMessage(message, senderTabIdHint) {
  if (!message || !message.type) return null;
  const tabId = message.tabId !== undefined ? message.tabId : senderTabIdHint;

  switch (message.type) {
    case MSG.HEARTBEAT:
      return { type: MSG.HEARTBEAT_ACK };

    case MSG.EXTRACT_PAGE: {
      const page = await extractPage(message.input || message, tabId);
      return { type: MSG.PAGE_CONTENT, ...page };
    }

    case MSG.CAPTURE_SCREENSHOT: {
      const shot = await captureScreenshot(message.input || message, tabId);
      return { type: MSG.SCREENSHOT_RESULT, ...shot };
    }

    case MSG.EXEC_TOOL: {
      const result = await execTool(message, tabId);
      return { type: MSG.TOOL_RESULT, ...result };
    }

    case MSG.CHECK_SITE_POLICY: {
      const { origin, actionClass, approvalMode, toolUseId } = message;
      // Prefer the live tab origin over the client-supplied one so the hard
      // denylist / scheme block can never be bypassed by a null or stale
      // client origin (e.g. when the panel never got a successful page
      // observation, leaving its lastKnownUrl null).
      const liveOrigin = await getTabOrigin(tabId).catch(() => null);
      const effectiveOrigin = liveOrigin || origin;
      const decision = await permissionManager.check(effectiveOrigin, actionClass, approvalMode, toolUseId);
      return { type: MSG.SITE_POLICY_RESULT, toolUseId, ...decision };
    }

    case MSG.CONFIRM_RESPONSE: {
      const { origin, actionClass, approved, toolUseId } = message;
      // "Always allow" arrives as `alwaysAllow` (SW contract), `always`
      // (agent-loop.js), or `remember` (sidepanel.js) — honor any of them.
      const alwaysAllow = message.alwaysAllow ?? message.always ?? message.remember;
      // Key the grant on the LIVE tab origin so it matches the origin EXEC_TOOL
      // re-derives when it enforces the confirm (both go through getTabOrigin).
      const liveOrigin = await getTabOrigin(tabId).catch(() => null);
      const grantOrigin = liveOrigin || origin;
      if (approved && grantOrigin && actionClass) {
        await permissionManager.grantSite(grantOrigin, {
          classes: [actionClass],
          duration: alwaysAllow ? 'always' : 'once',
          toolUseId,
        });
      }
      return { type: MSG.CONFIRM_RESPONSE, acked: true };
    }

    case MSG.REQUEST_AGENT_PERMISSION: {
      // Chat-only lite build: Agent Mode does not exist and the manifest
      // declares no optional debugger/tabs/<all_urls> permissions, so never
      // attempt to request them (chrome.permissions.request would reject an
      // undeclared permission anyway). Report "not granted" and stop.
      if (!AGENT_MODE_AVAILABLE) {
        return { type: MSG.AGENT_PERMISSION_RESULT, granted: false };
      }
      const { origin } = message;
      let granted = false;
      try {
        const originPattern = `${new URL(origin).origin}/*`;
        granted = await chrome.permissions.request({
          permissions: ['debugger'],
          origins: [originPattern],
        });
      } catch (err) {
        granted = false;
      }
      if (granted) {
        await permissionManager.grantSite(origin, { agentEnabled: true });
      }
      return { type: MSG.AGENT_PERMISSION_RESULT, granted };
    }

    case MSG.KEY_VALIDATE: {
      const result = await validateKey(message.apiKey);
      return { type: MSG.KEY_VALIDATE_RESULT, ...result };
    }

    case MSG.GET_SETTINGS: {
      const settings = await getSettings();
      return { type: MSG.SETTINGS, ...settings };
    }

    case MSG.SIGN_IN_START:
      return startSignIn();

    case MSG.SIGN_OUT:
      return signOut();

    case MSG.GET_SESSION:
      return getSession();

    case MSG.SETTINGS: {
      // Broadcast from options.js after a write — forward to every open panel.
      broadcast(message);
      return null;
    }

    case MSG.AGENT_START: {
      // Fire-and-forget from agent-loop.js when a run begins. Paint the page's
      // own red "Lexi is acting" border/pill (the third redundant acting
      // signal alongside the panel bar and Chrome's debugger infobar). The
      // overlay is torn down on AGENT_STOP / onDetach below.
      if (tabId !== undefined && tabId !== null) {
        sendToContentScript(tabId, { type: MSG.CS_OVERLAY, show: true }).catch(() => {});
        // Attach the debugger up-front, the way Claude for Chrome does (attach
        // at task start, not lazily on the first click), so Chrome's debugging
        // infobar and the panel's "controlling tab (trusted input)" state
        // appear immediately and any attach failure (DevTools already open,
        // permission not granted) surfaces before the first action rather than
        // mid-run. Best-effort + fire-and-forget: on any failure we simply stay
        // on the synthetic-event fallback and tell the panel so.
        void announceControlMode(tabId);
      }
      return null;
    }

    case MSG.AGENT_STOP: {
      if (tabId !== undefined && tabId !== null) {
        await detach(tabId).catch(() => {});
        await sendToContentScript(tabId, { type: MSG.CS_OVERLAY, show: false }).catch(() => {});
      } else {
        await detachAll().catch(() => {});
      }
      return { type: MSG.AGENT_STOP, acked: true };
    }

    case MSG.PORT_HELLO:
      return null;

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Request-type -> reply-type map, used when handleMessage THROWS so the error
// reply still carries the type the requester is waiting on (sidepanel.js's
// waitForPortMessage keys its pending queue by reply type; without this, a
// failed EXTRACT_PAGE would answer with type EXTRACT_PAGE and the panel would
// sit silent until its timeout instead of surfacing the real error).
// ---------------------------------------------------------------------------

const REPLY_TYPES = {
  [MSG.EXTRACT_PAGE]: MSG.PAGE_CONTENT,
  [MSG.CAPTURE_SCREENSHOT]: MSG.SCREENSHOT_RESULT,
  [MSG.EXEC_TOOL]: MSG.TOOL_RESULT,
  [MSG.CHECK_SITE_POLICY]: MSG.SITE_POLICY_RESULT,
  [MSG.REQUEST_AGENT_PERMISSION]: MSG.AGENT_PERMISSION_RESULT,
  [MSG.KEY_VALIDATE]: MSG.KEY_VALIDATE_RESULT,
  [MSG.GET_SETTINGS]: MSG.SETTINGS,
  [MSG.GET_SESSION]: MSG.SESSION,
  [MSG.SIGN_OUT]: MSG.AUTH_CHANGED,
};

function errorReplyFor(message, err) {
  return {
    type: (message && (REPLY_TYPES[message.type] || message.type)) || null,
    requestId: message && message.requestId,
    toolUseId: message && message.toolUseId,
    ok: false,
    error: (err && err.message) || String(err),
  };
}

// ---------------------------------------------------------------------------
// chrome.runtime.onConnect — the side panel's long-lived Port.
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME || !port.sender || port.sender.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }

  const portId = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random()}`;
  const entry = { port, tabId: null };
  ports.set(portId, entry);

  port.onMessage.addListener((message) => {
    if (message && message.type === MSG.PORT_HELLO && message.tabId !== undefined) {
      entry.tabId = message.tabId;
      return;
    }

    const tabId = message && message.tabId !== undefined ? message.tabId : entry.tabId;
    handleMessage(message, tabId)
      .then((response) => {
        if (response) {
          // agent-loop.js correlates every request/reply by a `requestId` it
          // stamps on the outgoing message; echo it verbatim so its
          // portRequest() promise resolves instead of timing out. Panel
          // (sidepanel.js) chat-mode requests carry no requestId and ignore it.
          if (message && message.requestId !== undefined) {
            response.requestId = message.requestId;
          }
          try {
            port.postMessage(response);
          } catch {
            // Port may have disconnected mid-flight; onDisconnect handles cleanup.
          }
        }
      })
      .catch((err) => {
        try {
          port.postMessage(errorReplyFor(message, err));
        } catch {
          // ignore
        }
      });
  });

  port.onDisconnect.addListener(() => {
    ports.delete(portId);
    if (entry.tabId !== undefined && entry.tabId !== null) {
      detach(entry.tabId).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// chrome.runtime.onMessage — one-off messages (options.js: KEY_VALIDATE,
// GET_SETTINGS, and the post-write SETTINGS broadcast).
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab && sender.tab.id;
  handleMessage(message, tabId)
    .then((response) => sendResponse(response))
    .catch((err) => sendResponse({ ok: false, error: (err && err.message) || String(err) }));
  return true; // keep the message channel open for the async sendResponse
});

// ---------------------------------------------------------------------------
// chrome.runtime.onMessageExternal — the ONLY cross-origin surface. The
// lexi-frontend /extension/connect page (gated by manifest
// externally_connectable) relays the minted account token here. Every message
// is origin- + replay-nonce-verified in handleExternalConnect before anything
// is written to storage; a mismatched origin/nonce/type is silently rejected.
// ---------------------------------------------------------------------------

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  handleExternalConnect(message, sender)
    .then((response) => sendResponse(response))
    .catch(() => sendResponse({ ok: false }));
  return true; // async sendResponse
});

// ---------------------------------------------------------------------------
// chrome.debugger.onDetach — Chrome's own infobar "Cancel", DevTools takeover,
// or a crashed/closed target all land here. Treat it as an implicit stop.
//
// "debugger" is an OPTIONAL permission: chrome.debugger is undefined until the
// user grants agent mode, so this registration MUST be guarded — touching
// chrome.debugger.onDetach unconditionally would throw at module evaluation
// and kill the entire service worker (no ports, no messaging, nothing) on
// every fresh install. If the permission arrives later (REQUEST_AGENT_
// PERMISSION), permissions.onAdded re-runs the registration.
// ---------------------------------------------------------------------------

function onDebuggerDetach(source, reason) {
  const tabId = source && source.tabId;
  if (tabId === undefined || tabId === null) return;
  // Chrome detached the session out from under us (infobar Cancel, DevTools
  // takeover, target closed). cdp-driver never calls chrome.debugger.detach in
  // this path, so we must sync its tracked-attached set here or a later attach
  // would wrongly no-op. See cdp-driver.forgetDetached contract.
  forgetDetached(tabId);
  broadcast({ type: MSG.AGENT_STOP, tabId, reason: reason || 'debugger_detached' }, tabId);
  sendToContentScript(tabId, { type: MSG.CS_OVERLAY, show: false }).catch(() => {});
}

function registerDebuggerDetachListener() {
  if (!chrome.debugger || !chrome.debugger.onDetach) return false;
  if (!chrome.debugger.onDetach.hasListener(onDebuggerDetach)) {
    chrome.debugger.onDetach.addListener(onDebuggerDetach);
  }
  return true;
}

if (!registerDebuggerDetachListener() && chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener((added) => {
    if (added && added.permissions && added.permissions.includes('debugger')) {
      registerDebuggerDetachListener();
    }
  });
}

// ---------------------------------------------------------------------------
// Install / startup — panel-open-on-click, session storage access level, and
// the 30s keepalive alarm that (alongside the open Port and any active
// debugger attach) keeps this SW alive through a multi-step agent run.
// ---------------------------------------------------------------------------

const KEEPALIVE_ALARM = 'keepalive';
// Low-frequency alarm that re-polls the channel control plane so a server-side
// LEXI_EXTENSION_CHANNEL flip reaches an already-running SW within ~30 min
// without a browser restart (the control plane itself caches for 5 min).
const CHANNEL_REFRESH_ALARM = 'channel-refresh';

function setup() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  }
  // The Anthropic API key lives in chrome.storage.local, whose default access
  // level is TRUSTED_AND_UNTRUSTED_CONTEXTS — i.e. readable by injected content
  // scripts. Restrict it to trusted contexts (panel/options/SW) so a content
  // script (which runs in the isolated world alongside untrusted page JS) can
  // never chrome.storage.local.get the key. This is the SPEC's stated design.
  if (chrome.storage.local && chrome.storage.local.setAccessLevel) {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  }
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(CHANNEL_REFRESH_ALARM, { periodInMinutes: 30 });
  // Resolve the active channel up-front on install/startup (cache-first: a
  // failure just leaves the previous cache / baked prod default in place).
  refreshChannelConfig().catch(() => {});
}

chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);

// Alarm tick. KEEPALIVE is a no-op whose only job is to give Chrome a recurring
// event so it does not tear the SW down mid multi-step agent run (state lives
// in chrome.storage / the ports Map). CHANNEL_REFRESH re-polls the control
// plane so a channel flip propagates to a long-lived SW.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CHANNEL_REFRESH_ALARM) {
    refreshChannelConfig().catch(() => {});
    return;
  }
  if (alarm.name !== KEEPALIVE_ALARM) return;
});

// Note: we deliberately do NOT declare/use the "webNavigation" permission to
// proactively invalidate the injected-tabs cache on SPA/full navigations —
// that would need a permission this extension doesn't request. Instead,
// sendToContentScript()'s catch-and-reinject retry (above) handles a stale
// cache reactively: if a navigated tab no longer has a live content script,
// the first failed sendMessage triggers a fresh inject-and-retry.

chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
  detach(tabId).catch(() => {});
});
