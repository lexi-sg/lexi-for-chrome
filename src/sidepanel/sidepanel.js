// src/sidepanel/sidepanel.js
//
// Side panel controller. Owns the long-lived Port to the service worker,
// the Chat<->Agent mode switch, quick actions / slash menu, settings load,
// and wires streaming render (chat-render.js) for both Chat mode (a local
// SEE_ONLY_TOOLS tool loop run directly against the Anthropic client) and
// Agent mode (delegates the full observe/plan/act loop to agent-loop.js,
// this file only renders its events and relays confirm/stop UI).
//
// ES module — loaded via <script type="module" src="sidepanel.js"> from
// sidepanel.html. Never injected as a content script.

import {
  MSG,
  PORT_NAME,
  MODELS,
  DEFAULT_MODEL,
  LIMITS,
  STORAGE_KEYS,
  AGENT_MODE_AVAILABLE,
  LEXI_API_BASE,
  CONNECT_ORIGINS,
} from '../config.js';
import { streamMessage, imageBlock } from '../agent/anthropic-client.js';
import { TOOLS, SEE_ONLY_TOOLS } from '../agent/tools.js';
import { createAgentRun } from '../agent/agent-loop.js';
import { nanoAvailability } from '../agent/gemini-nano.js';
import {
  buildChatSystem,
  wrapUntrusted,
  sanitize,
  scrubOutbound,
} from '../prompts/system-prompts.js';
import { QUICK_ACTIONS, SECONDARY } from '../prompts/quick-action-templates.js';
import { isAgentEnabled } from '../background/permission-manager.js';
import { createRenderer } from './chat-render.js';
import { streamProductChat } from './product-chat-client.js';

// ---------------------------------------------------------------------------
// DOM handles
// ---------------------------------------------------------------------------

const el = {
  modelPicker: document.getElementById('model-picker'),
  settingsBtn: document.getElementById('settings-btn'),
  contextChip: document.getElementById('context-chip'),
  contextFavicon: document.getElementById('context-favicon'),
  contextTitle: document.getElementById('context-title'),
  contextToggle: document.getElementById('context-toggle'),
  contextToggleLabel: document.getElementById('context-toggle-label'),
  keyBanner: document.getElementById('key-banner'),
  keyBannerText: document.getElementById('key-banner-text'),
  keyBannerBtn: document.getElementById('key-banner-btn'),
  // Account chip + sign-in screen
  accountChip: document.getElementById('account-chip'),
  accountChipBtn: document.getElementById('account-chip-btn'),
  accountAvatar: document.getElementById('account-avatar'),
  accountEmail: document.getElementById('account-email'),
  accountMenu: document.getElementById('account-menu'),
  accountUsage: document.getElementById('account-usage'),
  accountSignoutBtn: document.getElementById('account-signout-btn'),
  signinScreen: document.getElementById('signin-screen'),
  signinBtn: document.getElementById('signin-btn'),
  signinWaiting: document.getElementById('signin-waiting'),
  messages: document.getElementById('messages'),
  confirmTemplate: document.getElementById('confirm-card-template'),
  actingBar: document.getElementById('acting-bar'),
  actingIntent: document.getElementById('acting-intent'),
  actingControl: document.getElementById('acting-control'),
  stopBtn: document.getElementById('stop-btn'),
  agentEnableRow: document.getElementById('agent-enable-row'),
  agentEnableBtn: document.getElementById('agent-enable-btn'),
  quickActions: document.getElementById('quick-actions'),
  quickActionsMore: document.getElementById('quick-actions-more'),
  secondaryMenu: document.getElementById('secondary-actions-menu'),
  costHint: document.getElementById('cost-hint'),
  composer: document.getElementById('composer'),
  modeToggle: document.getElementById('mode-toggle'),
  modeChatBtn: document.getElementById('mode-chat-btn'),
  modeAgentBtn: document.getElementById('mode-agent-btn'),
  promptInput: document.getElementById('prompt-input'),
  sendBtn: document.getElementById('send-btn'),
  slashMenu: document.getElementById('slash-menu'),
};

const renderer = createRenderer(el.messages);

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {chrome.runtime.Port|null} */
let port = null;
let heartbeatTimer = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

let settings = {
  apiKey: null,
  model: DEFAULT_MODEL,
  approvalMode: 'manual',
  provider: 'anthropic',
  authMode: null, // 'account' | 'byok' | null (signed out)
  extensionToken: null,
  accountInfo: null,
};
let nanoAvailable = false;
/** True once a session-expiry re-auth is being shown; blocks sending. */
let sessionExpired = false;

/** The tab Lexi is currently reading (may be a Playwright ?testTabId fixture). */
let currentTab = null;
let includePageContext = true;

/** 'chat' | 'agent' */
let currentMode = 'chat';

/** Chat-mode Anthropic conversation history (Messages API `messages` array). */
let chatConversation = [];
let chatAbortController = null;
let chatRunActive = false;

/** Product-chat (account mode) conversation id, adopted from stream_start. */
let productConversationId = 0;

/** Agent-mode run handle from createAgentRun(). */
let agentRun = null;
let agentAssistantHandle = null;
/** toolUseId of an in-flight ask_user the agent is parked on, if any. */
let pendingAgentAsk = null;
/** Quick action awaiting the user's question in the composer ("Screenshot &
 * ask" arms this; the next composer submit runs it). window.prompt() is not
 * usable here — Chrome disables blocking dialogs in extension side panels. */
let pendingScreenshotAction = null;

// Pending single-flight Port request/response queues, keyed by reply MSG
// type. TOOL_RESULT is correlated separately by the Anthropic tool_use id
// (toolUseId), since several tool calls can be in flight across a run.
const pendingByType = new Map();
const pendingToolResults = new Map();

// ---------------------------------------------------------------------------
// Port plumbing
// ---------------------------------------------------------------------------

function connectPort() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    // Extension context invalidated (e.g. the extension was reloaded). The
    // panel itself is dead; a full reload is required — stop trying.
    port = null;
    return;
  }
  port.onMessage.addListener(handlePortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    // The service worker was evicted/restarted (or the port otherwise
    // dropped) while the panel is still open. Reconnect with backoff and
    // re-register the target tab so messaging (and any in-flight chat request,
    // via waitForPortMessage's timeout) recovers instead of hanging forever.
    scheduleReconnect();
  });
  heartbeatTimer = setInterval(() => {
    port?.postMessage({ type: MSG.HEARTBEAT });
  }, LIMITS.HEARTBEAT_MS);
  // On a reconnect (currentTab already resolved), re-register the tab so the
  // SW can route tab-scoped broadcasts back to this panel. At first boot
  // currentTab is still null; boot() sends the initial PORT_HELLO instead.
  if (currentTab && currentTab.id !== undefined && currentTab.id !== null) {
    try {
      port.postMessage({ type: MSG.PORT_HELLO, tabId: currentTab.id });
    } catch {
      /* will be retried by the next reconnect */
    }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(500 * 2 ** reconnectAttempts, 5000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!port) connectPort();
  }, delay);
}

function waitForPortMessage(type, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const queue = pendingByType.get(type) || [];
    const entry = { resolve, reject };
    queue.push(entry);
    pendingByType.set(type, queue);
    if (timeoutMs) {
      entry.timer = setTimeout(() => {
        const q = pendingByType.get(type) || [];
        const i = q.indexOf(entry);
        if (i >= 0) q.splice(i, 1);
        reject(new Error('Lost the connection to Lexi’s background service. Please try again.'));
      }, timeoutMs);
    }
  });
}

function handlePortMessage(msg) {
  if (!msg || !msg.type) return;
  // Any inbound message means the port is live — reset the backoff.
  reconnectAttempts = 0;

  if (msg.type === MSG.TOOL_RESULT) {
    const resolve = pendingToolResults.get(msg.toolUseId);
    if (resolve) {
      pendingToolResults.delete(msg.toolUseId);
      resolve(msg);
    }
    return;
  }

  if (msg.type === MSG.SETTINGS && msg.ok !== false) {
    const incoming = msg.settings || msg;
    applySettings(incoming);
    // options.js broadcasts `hasApiKey` (never the raw key). If a key now
    // exists but this panel doesn't hold it yet, pull the real value via
    // GET_SETTINGS so chat/agent can actually authenticate.
    if (incoming && incoming.hasApiKey && !settings.apiKey) {
      requestSettings().then((s) => applySettings(s.settings || s)).catch(() => {});
    }
  }

  if (msg.type === MSG.AUTH_CHANGED) {
    // The SW broadcasts this on sign-in / sign-out / session-expiry. Re-pull
    // the resolved settings and re-render the account UI.
    requestSettings()
      .then((s) => {
        applySettings(s.settings || s);
        if (msg.signedIn) {
          sessionExpired = false;
          hideSigninScreen();
          refreshAccountChip();
        } else if (msg.signedOut || msg.expired) {
          onAuthLost(!!msg.expired);
        }
      })
      .catch(() => {});
    return;
  }

  if (msg.type === MSG.CONFIRM_REQUIRED) {
    renderConfirmCard(msg);
    return;
  }

  if (msg.type === MSG.AGENT_STATUS) {
    applyAgentStatus(msg);
    return;
  }

  if (msg.type === MSG.AGENT_ACTING) {
    // The SW sends this at run start with {cdp, control} to report whether it
    // attached the debugger (trusted CDP input) or is on the synthetic-event
    // fallback, and may also carry an intent string.
    if (msg.control) setActingControl(msg.control);
    setActingBar(true, msg.intent || el.actingIntent.textContent || 'Lexi is acting');
    return;
  }

  const queue = pendingByType.get(msg.type);
  if (queue && queue.length) {
    const entry = queue.shift();
    if (entry.timer) clearTimeout(entry.timer);
    // The SW answers a failed request with the SAME reply type the caller is
    // waiting on, plus {ok:false, error} (see service-worker.js errorReplyFor).
    // Surface that as a rejection so callers show the real error immediately
    // instead of sitting silent until the timeout above fires.
    if (msg.ok === false && msg.error) {
      entry.reject(new Error(msg.error));
    } else {
      entry.resolve(msg);
    }
  }
}

function requestExtractPage(tabId, mode = 'both') {
  port?.postMessage({ type: MSG.EXTRACT_PAGE, tabId, mode });
  return waitForPortMessage(MSG.PAGE_CONTENT);
}

function requestScreenshot(tabId, fullPage = false) {
  port?.postMessage({ type: MSG.CAPTURE_SCREENSHOT, tabId, fullPage });
  return waitForPortMessage(MSG.SCREENSHOT_RESULT);
}

function requestSettings() {
  port?.postMessage({ type: MSG.GET_SETTINGS });
  return waitForPortMessage(MSG.SETTINGS);
}

function requestSession() {
  port?.postMessage({ type: MSG.GET_SESSION });
  return waitForPortMessage(MSG.SESSION);
}

function requestSignOut() {
  port?.postMessage({ type: MSG.SIGN_OUT });
  return waitForPortMessage(MSG.AUTH_CHANGED, { timeoutMs: 10000 }).catch(() => null);
}

function requestAgentPermission(origin) {
  port?.postMessage({ type: MSG.REQUEST_AGENT_PERMISSION, origin });
  return waitForPortMessage(MSG.AGENT_PERMISSION_RESULT);
}

/**
 * Executes a SEE_ONLY_TOOLS tool call (chat mode) through the same SW
 * EXEC_TOOL path agent mode uses. read_page/screenshot/scroll/find_element
 * all route to their non-CDP implementations in action-executor.js, so this
 * is safe to call unconditionally without a risk/confirm check.
 * @param {string} toolUseId - the Anthropic tool_use block's id.
 */
function execTool(toolUseId, toolName, input, tabId) {
  return new Promise((resolve) => {
    pendingToolResults.set(toolUseId, resolve);
    port?.postMessage({ type: MSG.EXEC_TOOL, toolUseId, toolName, input, tabId });
  });
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function applySettings(next) {
  settings = { ...settings, ...next };
  el.modelPicker.value = settings.model || DEFAULT_MODEL;
  refreshAuthUI();
}

/** Is the user able to send at all (signed in, or a keyless nano fallback)? */
function isAuthenticated() {
  if (settings.authMode === 'account' && settings.extensionToken) return true;
  if (settings.authMode === 'byok' && settings.apiKey) return true;
  return false;
}

/**
 * Reconcile the top-level auth surfaces from `settings`:
 *   - signed out  -> full-panel "Sign in with Lexi" screen
 *   - account     -> account chip pinned top
 *   - byok        -> neither (legacy escape-hatch path stays invisible)
 */
function refreshAuthUI() {
  const signedIn = isAuthenticated();
  const account = settings.authMode === 'account';

  // First-run sign-in screen: shown only when NOT authenticated and no keyless
  // nano fallback is available.
  const showSignin = !signedIn && !nanoAvailable && !sessionExpired;
  if (el.signinScreen) el.signinScreen.hidden = !showSignin;

  // Account chip only in account mode.
  if (el.accountChip) el.accountChip.hidden = !account;
  if (account) refreshAccountChip();

  // The re-auth banner is driven separately by the session-expiry flow.
  if (!sessionExpired && el.keyBanner) el.keyBanner.hidden = true;
}

function hideSigninScreen() {
  if (el.signinScreen) el.signinScreen.hidden = true;
  if (el.signinWaiting) el.signinWaiting.hidden = true;
}

/** Populate the account chip (email + initials) and its usage meter. */
function refreshAccountChip() {
  const info = settings.accountInfo || {};
  const email = info.email || 'Signed in';
  if (el.accountEmail) el.accountEmail.textContent = email;
  if (el.accountAvatar) el.accountAvatar.textContent = initialsFor(info);
  // Refresh the live usage meter from the server (chip stays usable meanwhile).
  requestSession()
    .then((s) => {
      if (!s || s.ok === false) return;
      if (s.account) {
        settings.accountInfo = s.account;
        if (el.accountEmail) el.accountEmail.textContent = s.account.email || email;
        if (el.accountAvatar) el.accountAvatar.textContent = initialsFor(s.account);
      }
      renderUsageMeter(s.usage, s.account);
    })
    .catch(() => {});
}

function initialsFor(info) {
  const base = (info.first_name || info.email || 'L').trim();
  return base.slice(0, 1).toUpperCase();
}

function renderUsageMeter(usage, account) {
  if (!el.accountUsage) return;
  const tier = (account && account.tier) || (settings.accountInfo && settings.accountInfo.tier) || '';
  if (!usage) {
    el.accountUsage.textContent = tier ? `Plan: ${tier}` : '';
    return;
  }
  const used = usage.used ?? 0;
  const limit = usage.limit;
  const period = usage.period || 'month';
  const meter =
    limit === null || limit === undefined
      ? `${used} used this ${period}`
      : `${used} / ${limit} this ${period}`;
  el.accountUsage.textContent = tier ? `${tier} · ${meter}` : meter;
}

// ---------------------------------------------------------------------------
// Sign-in / sign-out / session-expiry UX
// ---------------------------------------------------------------------------

function startSignIn() {
  port?.postMessage({ type: MSG.SIGN_IN_START });
  if (el.signinScreen) el.signinScreen.hidden = false;
  if (el.signinWaiting) el.signinWaiting.hidden = false;
  if (el.signinBtn) el.signinBtn.disabled = true;
}

/** Session ended (sign-out or a 401). Never fall back to a stored key. */
/**
 * Wipes every trace of the previous session's conversation: the rendered
 * transcript DOM, the in-memory BYOK history (which accumulates full page
 * text/screenshots), and the adopted product-chat conversation id. Called on
 * sign-out and session-expiry so a shared/kiosk profile never leaks the prior
 * user's chat, and a subsequent account never resumes a stale conversation id.
 */
function clearChatSession() {
  chatConversation = [];
  productConversationId = 0;
  if (el.messages) el.messages.innerHTML = '';
}

function onAuthLost(expired) {
  clearChatSession();
  settings.authMode = null;
  settings.extensionToken = null;
  settings.accountInfo = null;
  if (el.accountChip) el.accountChip.hidden = true;
  if (el.accountMenu) el.accountMenu.hidden = true;
  if (expired) {
    showSessionExpiredBanner();
  } else {
    sessionExpired = false;
    if (el.keyBanner) el.keyBanner.hidden = true;
    refreshAuthUI();
  }
}

function showSessionExpiredBanner() {
  sessionExpired = true;
  if (el.keyBannerText) el.keyBannerText.textContent = 'Your Lexi session ended — sign in again.';
  if (el.keyBannerBtn) el.keyBannerBtn.textContent = 'Sign in';
  if (el.keyBanner) el.keyBanner.hidden = false;
  if (el.signinScreen) el.signinScreen.hidden = true;
  el.sendBtn.disabled = true; // disable the composer until re-auth
}

async function doSignOut() {
  if (el.accountMenu) el.accountMenu.hidden = true;
  await requestSignOut();
  onAuthLost(false);
}

function populateModelPicker() {
  el.modelPicker.innerHTML = '';
  for (const m of MODELS) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    el.modelPicker.appendChild(opt);
  }
  el.modelPicker.value = settings.model || DEFAULT_MODEL;
}

el.modelPicker.addEventListener('change', () => {
  settings.model = el.modelPicker.value;
  chrome.storage.local.set({ [STORAGE_KEYS.MODEL]: settings.model });
});

el.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Sign-in / re-auth entry points.
el.signinBtn?.addEventListener('click', () => startSignIn());
el.keyBannerBtn.addEventListener('click', () => {
  // Re-auth from the session-expiry banner: clear the expired state and start
  // a fresh sign-in (never silently reuse a stored key).
  sessionExpired = false;
  el.sendBtn.disabled = false;
  el.keyBanner.hidden = true;
  startSignIn();
});

// Account chip dropdown (usage + sign out).
el.accountChipBtn?.addEventListener('click', () => {
  const willShow = el.accountMenu.hidden;
  el.accountMenu.hidden = !willShow;
  el.accountChipBtn.setAttribute('aria-expanded', String(willShow));
});
el.accountSignoutBtn?.addEventListener('click', () => doSignOut());
document.addEventListener('click', (e) => {
  if (!el.accountMenu || el.accountMenu.hidden) return;
  if (!el.accountChip.contains(e.target)) {
    el.accountMenu.hidden = true;
    el.accountChipBtn.setAttribute('aria-expanded', 'false');
  }
});

// ---------------------------------------------------------------------------
// Context chip (active tab)
// ---------------------------------------------------------------------------

async function resolveTargetTab() {
  const params = new URLSearchParams(location.search);
  const testTabId = params.get('testTabId');

  if (testTabId) {
    try {
      return await chrome.tabs.get(Number(testTabId));
    } catch (err) {
      return { id: Number(testTabId), url: '', title: 'Test fixture tab' };
    }
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  } catch (err) {
    return null;
  }
}

function renderContextChip() {
  if (!currentTab) {
    el.contextTitle.textContent = 'No page detected';
    el.contextFavicon.removeAttribute('src');
    return;
  }
  el.contextTitle.textContent = currentTab.title || currentTab.url || 'Untitled page';
  if (currentTab.favIconUrl) {
    el.contextFavicon.src = currentTab.favIconUrl;
  } else {
    el.contextFavicon.removeAttribute('src');
  }
}

el.contextToggle.addEventListener('click', () => {
  includePageContext = !includePageContext;
  el.contextToggle.setAttribute('aria-pressed', String(includePageContext));
  el.contextToggleLabel.textContent = includePageContext
    ? 'Reading this page'
    : 'Not reading';
});

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return url || '';
  }
}

// ---------------------------------------------------------------------------
// Quick actions + slash menu
// ---------------------------------------------------------------------------

function renderQuickActions() {
  el.quickActions.innerHTML = '';
  for (const action of QUICK_ACTIONS) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lexi-chip';
    chip.textContent = action.label;
    chip.dataset.actionId = action.id;
    chip.addEventListener('click', () => runQuickAction(action));
    el.quickActions.appendChild(chip);
  }

  el.secondaryMenu.innerHTML = '';
  for (const action of SECONDARY || []) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      el.secondaryMenu.hidden = true;
      el.quickActionsMore.setAttribute('aria-expanded', 'false');
      runQuickAction(action);
    });
    el.secondaryMenu.appendChild(btn);
  }
}

el.quickActionsMore.addEventListener('click', () => {
  const willShow = el.secondaryMenu.hidden;
  el.secondaryMenu.hidden = !willShow;
  el.quickActionsMore.setAttribute('aria-expanded', String(willShow));
});

document.addEventListener('click', (e) => {
  if (
    !el.secondaryMenu.hidden &&
    !el.secondaryMenu.contains(e.target) &&
    e.target !== el.quickActionsMore
  ) {
    el.secondaryMenu.hidden = true;
    el.quickActionsMore.setAttribute('aria-expanded', 'false');
  }
});

/** All quick actions (flagship + secondary), used by the slash popover. */
function allActions() {
  return [...QUICK_ACTIONS, ...(SECONDARY || [])];
}

function runQuickAction(action) {
  clearScreenshotArm();

  if (currentMode === 'agent') {
    el.promptInput.value = `Please help with: ${action.label}.`;
    autosizePromptInput();
    el.promptInput.focus();
    return;
  }

  if (action.needs === 'screenshot') {
    armScreenshotAction(action);
    return;
  }

  runTextQuickAction(action);
}

/** Arms "Screenshot & ask": the user types their question in the composer and
 * the next submit captures the screenshot + sends both together. */
function armScreenshotAction(action) {
  if (!ensureReadyToSend()) return;
  pendingScreenshotAction = action;
  showCostHintForScreenshot();
  el.promptInput.placeholder = 'What would you like to ask about a screenshot of this page?';
  el.promptInput.focus();
}

function clearScreenshotArm() {
  if (!pendingScreenshotAction) return;
  pendingScreenshotAction = null;
  el.costHint.hidden = true;
  el.promptInput.placeholder =
    currentMode === 'agent'
      ? 'Describe the task Lexi should do on this page…'
      : 'Ask about this page, or type / for quick actions…';
}

/**
 * Reads the user's current text selection on the target tab. Runs in response
 * to the quick-action click (a user gesture), so activeTab covers it; failures
 * (no host access, restricted page) degrade silently to no selection.
 */
async function getPageSelection(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (window.getSelection ? String(window.getSelection()) : ''),
    });
    return (res && typeof res.result === 'string') ? res.result.trim() : '';
  } catch {
    return '';
  }
}

async function runTextQuickAction(action) {
  if (!ensureReadyToSend()) return;
  renderer.appendUser(action.label);

  try {
    // For selection-aware actions (Explain this clause, etc.), capture the
    // user's current on-page text selection so the prompt operates on exactly
    // what they highlighted rather than falling back to "the most relevant
    // clause". `needs` is a '|'-joined capability string (e.g. 'selection|page').
    const wantsSelection = typeof action.needs === 'string' && action.needs.split('|').includes('selection');
    const selection = wantsSelection ? await getPageSelection(currentTab.id) : '';

    // Quick-action templates return ONLY the instruction.
    const messageText = action.prompt({
      selection,
      pageText: '',
      userQuestion: '',
    });

    // Account mode -> the instruction becomes a product-chat turn (the page
    // context is attached by runProductChat; the server owns tools/prompt).
    if (settings.authMode === 'account') {
      await runProductChat(messageText);
      return;
    }

    const pageData = includePageContext ? await requestExtractPage(currentTab.id) : null;
    // BYOK: page content is appended (sanitized + <untrusted_page_content>-wrapped)
    // as its own block by buildContentBlocks().
    await runChatCompletion(buildContentBlocks(messageText, pageData));
  } catch (err) {
    renderer.appendSystemNote(describeError(err));
  }
}

async function runScreenshotAskAction(action, question) {
  if (!ensureReadyToSend()) return;
  if (!question) return;

  renderer.appendUser(`${action.label}: ${question}`);
  showCostHintForScreenshot();
  try {
    const shot = await requestScreenshot(currentTab.id, false);
    el.costHint.hidden = true;

    const messageText = action.prompt({ selection: '', pageText: '', userQuestion: question });

    // Account mode -> attach the screenshot as an inline image on a product-chat turn.
    if (settings.authMode === 'account') {
      await runProductChat(messageText, {
        inlineImages: [dataUrlToInlineImage(shot.dataUrl)],
        previewImage: shot.dataUrl,
      });
      return;
    }

    const blocks = [imageBlock(shot.dataUrl), { type: 'text', text: messageText }];
    await runChatCompletion(blocks, { previewImage: shot.dataUrl });
  } catch (err) {
    el.costHint.hidden = true;
    renderer.appendSystemNote(describeError(err));
  }
}

function showCostHintForScreenshot(width = 1568, height = 1176) {
  const approxTokens = Math.round((width * height) / 750);
  el.costHint.hidden = false;
  el.costHint.textContent = `~1 image ≈ ${approxTokens.toLocaleString()} tokens`;
}

// --- Slash command popover -------------------------------------------------

let slashActiveIndex = -1;

el.promptInput.addEventListener('input', () => {
  autosizePromptInput();
  updateSlashMenu();
});

el.promptInput.addEventListener('keydown', (e) => {
  if (el.slashMenu.hidden) return;
  const items = [...el.slashMenu.querySelectorAll('.lexi-slash-item')];
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    slashActiveIndex = Math.min(slashActiveIndex + 1, items.length - 1);
    highlightSlashItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    slashActiveIndex = Math.max(slashActiveIndex - 1, 0);
    highlightSlashItem(items);
  } else if (e.key === 'Enter' && slashActiveIndex >= 0) {
    e.preventDefault();
    items[slashActiveIndex]?.click();
  } else if (e.key === 'Escape') {
    closeSlashMenu();
  }
});

function highlightSlashItem(items) {
  items.forEach((item, i) => item.classList.toggle('lexi-slash-active', i === slashActiveIndex));
}

function closeSlashMenu() {
  el.slashMenu.hidden = true;
  el.slashMenu.innerHTML = '';
  slashActiveIndex = -1;
}

function updateSlashMenu() {
  const value = el.promptInput.value;
  const slashIndex = value.lastIndexOf('/');
  if (slashIndex === -1) {
    closeSlashMenu();
    return;
  }
  const query = value.slice(slashIndex + 1).toLowerCase();
  if (query.includes(' ')) {
    closeSlashMenu();
    return;
  }

  const matches = allActions().filter(
    (a) => a.slash.toLowerCase().includes(query) || a.label.toLowerCase().includes(query)
  );
  if (!matches.length) {
    closeSlashMenu();
    return;
  }

  el.slashMenu.innerHTML = '';
  matches.forEach((action, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'lexi-slash-item';
    const cmd = document.createElement('span');
    cmd.className = 'lexi-slash-cmd';
    cmd.textContent = action.slash;
    const label = document.createElement('span');
    label.className = 'lexi-slash-label';
    label.textContent = action.label;
    item.append(cmd, label);
    item.addEventListener('click', () => {
      el.promptInput.value = '';
      closeSlashMenu();
      runQuickAction(action);
    });
    el.slashMenu.appendChild(item);
  });
  el.slashMenu.hidden = false;
  slashActiveIndex = 0;
  highlightSlashItem([...el.slashMenu.querySelectorAll('.lexi-slash-item')]);
}

function autosizePromptInput() {
  el.promptInput.style.height = 'auto';
  el.promptInput.style.height = `${Math.min(el.promptInput.scrollHeight, 120)}px`;
}

// ---------------------------------------------------------------------------
// Mode toggle (Chat | Agent)
// ---------------------------------------------------------------------------

el.modeChatBtn.addEventListener('click', () => setMode('chat'));
// Only wire the Agent tab in a build where Agent Mode exists. In the chat-only
// lite build the button is also removed from the DOM in applyBuildFlags().
if (AGENT_MODE_AVAILABLE) {
  el.modeAgentBtn.addEventListener('click', () => setMode('agent'));
}

function setMode(mode) {
  // In the chat-only lite build Agent Mode is not available — never switch to
  // it even if some stray entry point tries to (defense-in-depth alongside the
  // removed Agent tab and gated listener above).
  if (mode === 'agent' && !AGENT_MODE_AVAILABLE) return;
  currentMode = mode;
  pendingScreenshotAction = null;
  el.costHint.hidden = true;
  el.modeChatBtn.setAttribute('aria-selected', String(mode === 'chat'));
  el.modeAgentBtn.setAttribute('aria-selected', String(mode === 'agent'));
  el.promptInput.placeholder =
    mode === 'agent'
      ? 'Describe the task Lexi should do on this page…'
      : 'Ask about this page, or type / for quick actions…';

  if (mode === 'agent') {
    refreshAgentEnableRow();
  } else {
    el.agentEnableRow.hidden = true;
  }
}

async function refreshAgentEnableRow() {
  if (!currentTab) return;
  const origin = originOf(currentTab.url);
  const enabled = await isAgentEnabled(origin);
  el.agentEnableRow.hidden = enabled;
}

el.agentEnableBtn.addEventListener('click', async () => {
  const origin = originOf(currentTab.url);
  const { granted } = await requestAgentPermission(origin);
  if (granted) {
    el.agentEnableRow.hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Composer submit
// ---------------------------------------------------------------------------

el.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el.promptInput.value.trim();
  if (!text) return;
  el.promptInput.value = '';
  autosizePromptInput();
  closeSlashMenu();

  // If the agent parked on an ask_user, this submit is the human's answer —
  // feed it back into the loop rather than starting a new task.
  if (pendingAgentAsk && agentRun) {
    renderer.appendUser(text);
    agentRun.provideAnswer(pendingAgentAsk, text);
    pendingAgentAsk = null;
    el.promptInput.placeholder = 'Describe the task Lexi should do on this page…';
    return;
  }

  // An armed "Screenshot & ask": this submit carries the user's question.
  if (currentMode === 'chat' && pendingScreenshotAction) {
    const action = pendingScreenshotAction;
    clearScreenshotArm();
    runScreenshotAskAction(action, text);
    return;
  }

  if (currentMode === 'agent') {
    handleAgentSend(text);
  } else {
    handleChatSend(text);
  }
});

el.promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && el.slashMenu.hidden) {
    e.preventDefault();
    el.composer.requestSubmit();
  }
});

function ensureReadyToSend() {
  if (sessionExpired) {
    showSessionExpiredBanner();
    return false;
  }
  if (!isAuthenticated() && !nanoAvailable) {
    // Signed out — surface the sign-in screen rather than sending.
    if (el.signinScreen) el.signinScreen.hidden = false;
    return false;
  }
  if (!currentTab) {
    renderer.appendSystemNote('No page detected — open a tab and try again.');
    return false;
  }
  return true;
}

async function handleChatSend(text) {
  if (!ensureReadyToSend()) return;
  renderer.appendUser(text);
  // Account mode -> the real product chat pipeline (/llm/chat). BYOK escape
  // hatch -> the local Anthropic see-only tool loop (unchanged).
  if (settings.authMode === 'account') {
    await runProductChat(text);
    return;
  }
  try {
    const pageData = includePageContext ? await requestExtractPage(currentTab.id) : null;
    await runChatCompletion(buildContentBlocks(text, pageData), { userVisibleText: text });
  } catch (err) {
    renderer.appendSystemNote(describeError(err));
  }
}

function buildContentBlocks(text, pageData) {
  const blocks = [];
  let finalText = text;
  if (pageData && !text.includes('<untrusted_page_content>')) {
    finalText = `${wrapUntrusted(sanitize(pageData.text))}\n\n${text}`;
  }
  blocks.push({ type: 'text', text: finalText });
  return blocks;
}

// ---------------------------------------------------------------------------
// Chat mode: local SEE_ONLY_TOOLS tool loop against the Anthropic client
// ---------------------------------------------------------------------------

const CHAT_TOOLS = TOOLS.filter((t) => SEE_ONLY_TOOLS.includes(t.name));
const MAX_CHAT_TOOL_STEPS = 6;

async function runChatCompletion(userContentBlocks, opts = {}) {
  if (chatRunActive) return;
  chatRunActive = true;
  el.sendBtn.disabled = true;

  chatConversation.push({ role: 'user', content: userContentBlocks });

  let previewImage = opts.previewImage || null;
  let steps = 0;

  try {
    while (steps < MAX_CHAT_TOOL_STEPS) {
      steps++;
      const handle = renderer.startAssistant();
      if (previewImage) {
        handle.appendImage(previewImage);
        previewImage = null;
      }

      chatAbortController = new AbortController();
      let stopReason = null;
      const toolBlocks = [];
      const thinkingBlocks = [];
      let currentToolBlock = null;

      try {
        for await (const ev of streamMessage({
          apiKey: settings.apiKey,
          model: settings.model || DEFAULT_MODEL,
          system: buildChatSystem({ jurisdictionNeutral: true }),
          messages: chatConversation,
          tools: CHAT_TOOLS,
          maxTokens: LIMITS.MAX_TOKENS_STEP,
          signal: chatAbortController.signal,
        })) {
          if (ev.type === 'text') {
            handle.pushDelta(ev.delta);
          } else if (ev.type === 'tool_use_start') {
            currentToolBlock = { id: ev.id, name: ev.name, inputJson: '' };
            toolBlocks.push(currentToolBlock);
          } else if (ev.type === 'tool_use_delta') {
            if (currentToolBlock) currentToolBlock.inputJson += ev.partialJson || '';
          } else if (ev.type === 'thinking_block') {
            // Captured for replay ahead of tool_use (thinking-enabled models
            // like Fable 5 require it when continuing a tool-using turn).
            thinkingBlocks.push(ev.block);
          } else if (ev.type === 'stop') {
            stopReason = ev.stopReason;
          }
        }
      } catch (err) {
        handle.finalize();
        renderer.appendSystemNote(describeError(err));
        return;
      }

      const scrub = scrubOutbound(handle.text);
      handle.finalize({ injectionFlagged: scrub.flagged });

      if (stopReason !== 'tool_use' || toolBlocks.length === 0) {
        chatConversation.push({ role: 'assistant', content: [{ type: 'text', text: handle.text }] });
        return;
      }

      await runChatToolStep(handle, toolBlocks, thinkingBlocks);
    }

    renderer.appendSystemNote('Lexi stopped after several tool calls — try rephrasing your question.');
  } finally {
    chatRunActive = false;
    el.sendBtn.disabled = false;
  }
}

async function runChatToolStep(handle, toolBlocks, thinkingBlocks = []) {
  const parsedTools = toolBlocks.map((tb) => ({
    ...tb,
    input: safeParseJson(tb.inputJson),
  }));

  const assistantContent = [];
  // Thinking blocks must be replayed verbatim, ahead of any tool_use block.
  for (const tb of thinkingBlocks) assistantContent.push(tb);
  if (handle.text) assistantContent.push({ type: 'text', text: handle.text });
  for (const tb of parsedTools) {
    assistantContent.push({ type: 'tool_use', id: tb.id, name: tb.name, input: tb.input });
  }
  chatConversation.push({ role: 'assistant', content: assistantContent });

  const toolResultContent = [];
  for (const tb of parsedTools) {
    if (tb.name === 'finish' || tb.name === 'ask_user') {
      const text = tb.input?.answer || tb.input?.question || '';
      if (text) renderer.appendSystemNote(text);
      toolResultContent.push({ type: 'tool_result', tool_use_id: tb.id, content: 'acknowledged' });
      continue;
    }

    const result = await execTool(tb.id, tb.name, tb.input, currentTab.id);
    toolResultContent.push(formatToolResult(tb, result));
  }
  chatConversation.push({ role: 'user', content: toolResultContent });
}

function formatToolResult(tb, msg) {
  if (!msg.ok) {
    return { type: 'tool_result', tool_use_id: tb.id, content: String(msg.error || 'Tool failed'), is_error: true };
  }
  if (tb.name === 'screenshot' && msg.result?.dataUrl) {
    return {
      type: 'tool_result',
      tool_use_id: tb.id,
      content: [imageBlock(msg.result.dataUrl), { type: 'text', text: 'Screenshot captured.' }],
    };
  }
  return {
    type: 'tool_result',
    tool_use_id: tb.id,
    content: JSON.stringify(msg.result ?? {}).slice(0, 24000),
  };
}

function safeParseJson(json) {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch (err) {
    return {};
  }
}

/** Friendly text for a serialized agent-loop error {type, message, status}. */
function describeAgentError(err) {
  if (!err) return '';
  const type = err.type || '';
  if (type === 'SessionExpiredError') return 'Your Lexi session ended — sign in again.';
  if (type === 'AuthError') return 'Your API key was rejected. Check it in Settings.';
  if (type === 'ForbiddenError') return 'Your API key lacks access to this model. Try another model in Settings.';
  if (type === 'RateLimitError') return 'Rate limited by Anthropic — please wait a moment and try again.';
  if (type === 'OverloadedError') return 'Anthropic is currently overloaded — please try again shortly.';
  if (type === 'MaxFailuresReachedError' || type === 'MaxStepsReachedError' || type === 'RefusedByPolicy') {
    return err.message || 'Lexi stopped this task.';
  }
  return err.message || 'Something went wrong during the task.';
}

function describeError(err) {
  const name = err?.name || '';
  if (name === 'AuthError') return 'Your API key was rejected. Check it in Settings.';
  if (name === 'RateLimitError') return 'Rate limited by Anthropic — please wait a moment and try again.';
  if (name === 'OverloadedError') return 'Anthropic is currently overloaded — please try again shortly.';
  if (name === 'AbortError') return 'Stopped.';
  // chrome.scripting injection denied: Chrome's activeTab grant for this tab
  // expired (navigation) or was never given (panel opened without a gesture
  // on that tab). A fresh toolbar click re-grants it.
  if (/cannot access contents of the page|must request permission/i.test(err?.message || '')) {
    return 'Lexi can’t read this page yet — click the Lexi toolbar icon on that tab to grant access, then try again.';
  }
  return `Something went wrong: ${err?.message || err}`;
}

// ---------------------------------------------------------------------------
// Chat mode (account): the real product pipeline (/llm/chat, v2 block-SSE)
// ---------------------------------------------------------------------------

/** Captures the current page as a <page_context> payload for product chat. */
async function capturePageContext() {
  try {
    const page = await requestExtractPage(currentTab.id);
    return {
      url: page.url || currentTab.url || '',
      title: page.title || currentTab.title || '',
      text: sanitize(page.text || ''),
    };
  } catch {
    return null;
  }
}

/** Splits a data: URL into the inline-image shape the product chat expects. */
function dataUrlToInlineImage(dataUrl) {
  const comma = typeof dataUrl === 'string' ? dataUrl.indexOf(',') : -1;
  return {
    base64: comma === -1 ? dataUrl : dataUrl.slice(comma + 1),
    media_type: 'image/png',
  };
}

/**
 * Runs one product-chat turn against /llm/chat and drives chat-render from the
 * normalized SSE events. `opts.inlineImages` attaches transient screenshots;
 * `opts.previewImage` renders a preview bubble.
 */
async function runProductChat(userMessage, opts = {}) {
  if (chatRunActive) return;
  chatRunActive = true;
  el.sendBtn.disabled = true;

  const handle = renderer.startAssistant();
  if (opts.previewImage) handle.appendImage(opts.previewImage);
  chatAbortController = new AbortController();

  // block_index -> {kind, toolId} so a block_stop (which carries only the
  // index + final payload) can settle the right thinking/tool affordance.
  const blockMeta = new Map();

  const onEvent = (evt) => {
    switch (evt.type) {
      case 'stream_start':
        productConversationId = evt.conversationId;
        break;
      case 'text':
        handle.pushDelta(evt.delta);
        break;
      case 'snapshot':
        if (evt.content) handle.pushDelta(evt.content);
        break;
      case 'block_start':
        blockMeta.set(evt.blockIndex, { kind: evt.kind, toolId: evt.toolId });
        if (evt.kind === 'tool') handle.openTool(evt.toolId, evt.name, evt.status);
        else if (evt.kind === 'artifact') handle.openArtifact(evt.title, artifactDeepLink(evt));
        break;
      case 'block_delta':
        if (evt.kind === 'text') handle.pushDelta(evt.delta);
        else if (evt.kind === 'thinking') handle.pushThinking(evt.delta);
        // input_json / artifact_content: not surfaced in v1.
        break;
      case 'block_stop': {
        const meta = blockMeta.get(evt.blockIndex) || {};
        if (meta.kind === 'thinking') handle.settleThinking();
        else if (meta.kind === 'tool' && evt.final) handle.settleTool(meta.toolId, evt.final.status);
        break;
      }
      case 'thinking':
        handle.pushThinking(evt.delta);
        break;
      case 'status_line':
        handle.setStatusLine(evt.message);
        break;
      case 'banner':
        handle.showBanner(evt.message);
        break;
      case 'follow_ups':
        renderer.appendFollowUps(evt.questions, (q) => {
          renderer.appendUser(q);
          runProductChat(q);
        });
        break;
      case 'complete':
        handle.finalize();
        break;
      case 'cancel':
        handle.finalize();
        renderer.appendSystemNote('Generation stopped.');
        break;
      case 'error':
        handle.finalize();
        renderer.appendSystemNote(evt.message || 'Lexi hit an error.');
        break;
      default:
        break;
    }
  };

  try {
    const pageContext = includePageContext ? await capturePageContext() : null;
    await streamProductChat({
      baseUrl: LEXI_API_BASE,
      token: settings.extensionToken,
      conversationId: productConversationId,
      userMessage,
      pageContext,
      inlineImages: opts.inlineImages || [],
      sources: [],
      mode: 'chat',
      signal: chatAbortController.signal,
      onEvent,
    });
    handle.finalize();
  } catch (err) {
    handle.finalize();
    if (err && err.name === 'AuthError') {
      onAuthLost(true);
    } else if (err && err.name === 'AbortError') {
      renderer.appendSystemNote('Stopped.');
    } else {
      renderer.appendSystemNote(describeError(err));
    }
  } finally {
    chatRunActive = false;
    chatAbortController = null;
    el.sendBtn.disabled = sessionExpired;
  }
}

/** Best-effort Open-in-Lexi deep link for a streamed artifact card. */
function artifactDeepLink() {
  const appOrigin = (CONNECT_ORIGINS && CONNECT_ORIGINS[0]) || '';
  if (!appOrigin || !productConversationId) return null;
  return `${appOrigin}/chat/${productConversationId}`;
}

// ---------------------------------------------------------------------------
// Agent mode: delegate to agent-loop.js, render its events
// ---------------------------------------------------------------------------

/** Auth descriptor for Agent Mode's transport (proxy in account mode, direct
 * Anthropic in the BYOK escape hatch). */
function agentAuthDescriptor() {
  if (settings.authMode === 'account' && settings.extensionToken) {
    return { mode: 'account', token: settings.extensionToken, baseUrl: LEXI_API_BASE };
  }
  return { mode: 'byok', apiKey: settings.apiKey };
}

async function handleAgentSend(task) {
  if (!ensureReadyToSend()) return;
  const origin = originOf(currentTab.url);
  const enabled = await isAgentEnabled(origin);
  if (!enabled) {
    el.agentEnableRow.hidden = false;
    return;
  }

  renderer.appendUser(task);
  agentAssistantHandle = null;
  setActingControl(null); // reset; the SW reports trusted/fallback on AGENT_ACTING
  setActingBar(true, 'Lexi is starting…');

  agentRun = createAgentRun({
    port,
    tabId: currentTab.id,
    task,
    model: settings.model || DEFAULT_MODEL,
    approvalMode: settings.approvalMode || 'manual',
    auth: agentAuthDescriptor(),
    onEvent: handleAgentEvent,
  });
  agentRun.start();
}

function handleAgentEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'text':
      if (!agentAssistantHandle) agentAssistantHandle = renderer.startAssistant();
      agentAssistantHandle.pushDelta(event.delta);
      break;

    // agent-loop.js emits 'tool_intent' (underscore) with {name, id, input?}.
    case 'tool_intent':
      setActingBar(true, intentTextFor(event));
      break;

    case 'status':
      applyAgentStatus(event);
      break;

    // agent-loop.js emits {type:'tokensSaved', tokens, total}.
    case 'tokensSaved':
      agentAssistantHandle?.addTokensSaved(event.tokens || 0);
      break;

    case 'confirm':
      renderConfirmCard(event);
      break;

    case 'ask_user':
      renderAskUser(event);
      break;

    case 'sw_event':
      // Passthrough of an unsolicited AGENT_STATUS/AGENT_ACTING from the SW.
      break;

    default:
      break;
  }
}

/** Human-readable acting-bar text for a tool_intent event from agent-loop. */
function intentTextFor(event) {
  const INTENTS = {
    read_page: 'Reading the page…',
    screenshot: 'Taking a screenshot…',
    click: 'Clicking…',
    type_text: 'Typing…',
    press_key: 'Pressing a key…',
    scroll: 'Scrolling…',
    navigate: 'Navigating…',
    go_back: 'Going back…',
    find_element: 'Locating an element…',
    ask_user: 'Waiting for you…',
    finish: 'Finishing up…',
  };
  return INTENTS[event.name] || 'Lexi is acting';
}

function applyAgentStatus(event) {
  const status = event.status || event.state;
  if (status === 'thinking') {
    setActingBar(false);
  } else if (status === 'acting' || status === 'awaiting_confirm') {
    setActingBar(true, event.intent || 'Lexi is acting');
  } else if (status === 'done' || status === 'stopped' || status === 'error') {
    finishAgentRun(status, event);
  }
}

function finishAgentRun(status, event) {
  if (agentAssistantHandle) {
    agentAssistantHandle.finalize();
    agentAssistantHandle = null;
  }
  if (status === 'error') {
    // agent-loop.js emits errors as {status:'error', error:{type, message}}.
    const errMsg = (event && event.error && event.error.message) || (event && event.message);
    if (errMsg) renderer.appendSystemNote(describeAgentError(event.error) || errMsg);
    // A session-expiry (account 401) must surface the re-auth banner and never
    // silently fall back to a stored key.
    if (event && event.error && event.error.type === 'SessionExpiredError') {
      onAuthLost(true);
    }
  }

  el.actingBar.classList.add('lexi-acting-done');
  el.actingIntent.textContent = status === 'error' ? 'Lexi hit an error' : 'Done';
  setActingControl(null);
  setTimeout(() => {
    el.actingBar.hidden = true;
    el.actingBar.classList.remove('lexi-acting-done');
  }, 1500);

  agentRun = null;
  if (pendingAgentAsk) {
    pendingAgentAsk = null;
    el.promptInput.placeholder = 'Describe the task Lexi should do on this page…';
  }
}

function setActingBar(visible, intentText) {
  el.actingBar.hidden = !visible;
  if (intentText) el.actingIntent.textContent = intentText;
  // The control badge lives inside the bar; re-render it whenever the bar shows
  // so the trusted/fallback state persists across the run's thinking↔acting
  // toggles (it is only reset to null when the whole run ends).
  if (visible) renderControlBadge();
}

// The SW-reported control mode for the CURRENT run: 'trusted' (chrome.debugger
// attached — real trusted input, like Claude for Chrome) or 'fallback'
// (synthetic DOM events). Persists for the whole run; cleared at run end.
let agentControlMode = null;

function setActingControl(control) {
  agentControlMode = control || null;
  renderControlBadge();
}

function renderControlBadge() {
  const badge = el.actingControl;
  if (!badge) return;
  if (!agentControlMode) {
    badge.hidden = true;
    badge.textContent = '';
    badge.classList.remove('lexi-control-fallback');
    return;
  }
  const trusted = agentControlMode === 'trusted';
  badge.hidden = false;
  badge.textContent = trusted ? 'Controlling tab' : 'Compatibility mode';
  badge.title = trusted
    ? 'Driving this tab with trusted native input events via chrome.debugger.'
    : 'Debugger not attached — using synthetic DOM events (compatibility fallback).';
  badge.classList.toggle('lexi-control-fallback', !trusted);
}

el.stopBtn.addEventListener('click', () => {
  agentRun?.stop();
  chatAbortController?.abort();
  setActingBar(false);
});

// ---------------------------------------------------------------------------
// Confirmation card (risky agent actions)
// ---------------------------------------------------------------------------

function renderConfirmCard(event) {
  const fragment = el.confirmTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.lexi-confirm-card');
  const desc = fragment.querySelector('#confirm-desc');
  const remember = fragment.querySelector('#confirm-remember');
  const approveBtn = fragment.querySelector('#confirm-approve');
  const denyBtn = fragment.querySelector('#confirm-deny');

  desc.textContent = describeAction(event);

  const respond = (approved) => {
    card.remove();
    const remembered = Boolean(remember.checked);
    if (typeof event.respond === 'function') {
      // A caller that supplied its own responder (defensive contract).
      event.respond({ approved, remember: remembered });
    } else if (agentRun && typeof agentRun.resolveConfirm === 'function') {
      // Agent mode: the parked loop unblocks IN-PROCESS via resolveConfirm().
      // agent-loop separately fire-and-forgets a CONFIRM_RESPONSE Port message
      // to persist an "always allow" grant, so we must NOT also post one here
      // (and a Port CONFIRM_RESPONSE alone would never unblock the loop).
      agentRun.resolveConfirm(event.toolUseId, approved, { always: remembered });
    } else {
      // Fallback: a SW-driven CONFIRM_REQUIRED (no active local run).
      port?.postMessage({
        type: MSG.CONFIRM_RESPONSE,
        tabId: currentTab && currentTab.id,
        toolUseId: event.toolUseId,
        approved,
        alwaysAllow: remembered,
        actionClass: event.actionClass || null,
        origin: event.origin || (currentTab && originOf(currentTab.url)) || null,
      });
    }
  };

  approveBtn.addEventListener('click', () => respond(true));
  denyBtn.addEventListener('click', () => respond(false));

  el.messages.appendChild(fragment);
  el.messages.scrollTop = el.messages.scrollHeight;
}

const CONFIRM_VERBS = {
  SUBMIT: 'submit this form',
  NAVIGATE_NEW_DOMAIN: 'navigate to a new site',
  PAY: 'make a payment',
  SEND_MESSAGE: 'send a message',
  UPLOAD: 'upload a file',
  DOWNLOAD: 'download a file',
  DELETE: 'delete something',
  CLICK: 'click an element',
  TYPE: 'type into a field',
};

function describeAction(event) {
  if (event.description) return event.description;
  const verb = CONFIRM_VERBS[event.actionClass] || `run ${event.name || event.toolName || 'an action'}`;
  const reason = event.reason ? ` — ${event.reason}` : '';
  const where = (currentTab && currentTab.title) || 'this page';
  return `${verb} on ${where}${reason}`;
}

function renderAskUser(event) {
  pendingAgentAsk = event.toolUseId;
  renderer.appendSystemNote(`Lexi needs your input: ${event.question || 'Please clarify how to proceed.'}`);
  setActingBar(true, 'Waiting for you…');
  el.promptInput.placeholder = 'Type your answer to Lexi…';
  el.promptInput.focus();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Chat-only lite build: physically remove the Agent tab from the DOM and hide
 * the (now single-option) mode toggle, so there is no agent-mode entry point in
 * the panel at all. No-op in the full build (AGENT_MODE_AVAILABLE === true), so
 * the full panel is byte-for-byte unchanged.
 */
function applyBuildFlags() {
  if (AGENT_MODE_AVAILABLE) return;
  el.modeAgentBtn?.remove();
  if (el.modeToggle) el.modeToggle.hidden = true;
  if (el.agentEnableRow) el.agentEnableRow.hidden = true;
}

async function boot() {
  applyBuildFlags();
  connectPort();
  populateModelPicker();
  renderQuickActions();
  setMode('chat');

  const [loadedSettings, resolvedTab, nano] = await Promise.all([
    requestSettings().catch(() => ({})),
    resolveTargetTab(),
    nanoAvailability(),
  ]);

  applySettings(loadedSettings.settings || loadedSettings);
  nanoAvailable = nano === 'available';
  refreshAuthUI();

  currentTab = resolvedTab;
  renderContextChip();

  // Register this panel's target tab with the SW so it can route tab-scoped
  // broadcasts (e.g. the debugger-infobar Cancel / DevTools takeover surfacing
  // as AGENT_STOP, or an onDetach) back to this specific panel. Must be the
  // first substantive Port message per the SW's Port contract.
  if (currentTab && currentTab.id !== undefined) {
    port?.postMessage({ type: MSG.PORT_HELLO, tabId: currentTab.id });
  }
}

boot();
