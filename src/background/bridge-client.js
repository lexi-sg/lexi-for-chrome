// src/background/bridge-client.js
//
// The extension end of the browser bridge: a WebSocket from this service
// worker to Lexi's backend, over which Lexi's server-side chat drives a tab in
// this browser once the user lets it (Options → "Lexi chat in this browser").
// Wire protocol: docs/browser-bridge.md.
//
// Chat may use any site, but a session only acts on the sites the user lets
// it: those on their list (Options), and others they allow when Chrome asks
// (bridge-ask.js) as the session opens a site, navigates to one, or finds its
// tab on one after a link. Every tool call runs through the service worker's
// execTool in remote mode: the denylist, sensitive-field blocks and the
// session's run scope apply, stored Agent Mode grants don't, and anything
// Agent Mode would confirm is asked in Chrome too. A session's tab is a
// background tab in a "Lexi" tab group with the red acting border.
//
// ES module. createBridge() takes the service-worker helpers it needs, so this
// file has no import cycle with service-worker.js.

import {
  AGENT_MODE_AVAILABLE,
  STORAGE_KEYS,
  BRIDGE_TICKET_PATH,
  BRIDGE_WS_PATH,
  BRIDGE_PROTOCOL,
  BRIDGE_PING_MS,
  BRIDGE_BACKOFF_MS,
  BRIDGE_OPEN_TIMEOUT_MS,
  BRIDGE_TOOLS,
  BRIDGE_SESSIONS_KEY,
  BRIDGE_HOST_ACCESS,
} from '../config.js';
import { normalizeAllowedHosts, httpHostOf, isAllowedHost } from '../agent/host-scope.js';
import { getActiveConfig } from './channel-config.js';
import { isDenylisted } from './permission-manager.js';
import { ask } from './bridge-ask.js';

const TAB_GROUP_TITLE = 'Lexi';
// A session the server stops using (a crashed turn never sends `close`) gives
// its tab back to the user after this long.
const SESSION_IDLE_MS = 5 * 60 * 1000;
// Fields the panel's agent loop adds to a tool input. A remote caller must not
// supply them: the element name decides risky-action classification, and the
// queue-time origin is the panel's own TOCTOU check.
const PANEL_ONLY_INPUT_FIELDS = ['elementName', 'elementText', 'originAtQueue'];

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Whether the user lets Lexi chat use this browser: the switch is on and
 * Chrome still grants the host access it asked for. */
export async function bridgeAllowed() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.BRIDGE_ENABLED);
  if (!data[STORAGE_KEYS.BRIDGE_ENABLED]) return false;
  return chrome.permissions.contains(BRIDGE_HOST_ACCESS).catch(() => false);
}

/** The hosts Lexi chat may use without asking. */
export async function trustedSites() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.BRIDGE_SITES);
  return normalizeAllowedHosts(data[STORAGE_KEYS.BRIDGE_SITES] || []);
}

async function trustSites(hosts) {
  const sites = await trustedSites();
  await chrome.storage.local.set({ [STORAGE_KEYS.BRIDGE_SITES]: [...new Set([...sites, ...hosts])] });
}

/** "www.example.com" -> "example.com": a site covers its subdomains. */
function bareHost(host) {
  return String(host || '').replace(/^www\./, '');
}

function hostOfOrigin(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

async function accountToken() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.AUTH_MODE, STORAGE_KEYS.EXTENSION_TOKEN]);
  const token = data[STORAGE_KEYS.EXTENSION_TOKEN] || null;
  const mode = data[STORAGE_KEYS.AUTH_MODE] || null;
  return token && (!mode || mode === 'account') ? token : null;
}

async function tabExists(tabId) {
  if (typeof tabId !== 'number') return false;
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function pageOf(tabId) {
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url || tab.pendingUrl || '', title: tab.title || '' };
}

/** Resolves once the tab has finished loading, or after timeoutMs. */
function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab.status === 'complete' && !tab.pendingUrl) finish();
      })
      .catch(finish);
  });
}

/** Put the tab in the "Lexi" tab group, reusing the group if it still exists. */
async function addToLexiGroup(tabId) {
  if (!chrome.tabs.group) return;
  try {
    const [existing] = chrome.tabGroups ? await chrome.tabGroups.query({ title: TAB_GROUP_TITLE }) : [];
    if (existing) {
      await chrome.tabs.group({ groupId: existing.id, tabIds: [tabId] });
      return;
    }
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    if (chrome.tabGroups) await chrome.tabGroups.update(groupId, { title: TAB_GROUP_TITLE, color: 'green' });
  } catch {
    // Grouping only labels the tab; the session works without it.
  }
}

function cleanInput(input) {
  const out = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  for (const field of PANEL_ONLY_INPUT_FIELDS) delete out[field];
  return out;
}

/**
 * createBridge(deps) -> {sync, status, onTabRemoved, onTabStopped}
 *
 * deps (service-worker helpers):
 *   execTool(message, tabId, {remote})  -> {ok, result, error, code}
 *   setRunScope(tabId, allowedHosts)
 *   startControl(tabId)  - acting overlay + debugger attach where allowed
 *   endControl(tabId)    - clear scope, overlay off, debugger detached
 *   onAuthExpired()      - the ticket endpoint rejected the session token
 */
export function createBridge({ execTool, setRunScope, startControl, endControl, onAuthExpired }) {
  /** @type {WebSocket|null} */
  let ws = null;
  let wsApiBase = null;
  let sentSites = [];
  let pingTimer = null;
  let retryTimer = null;
  let attempt = 0;
  let lastError = null;
  let connectionId = null;
  let syncChain = Promise.resolve();

  // sessionId -> {tabId, allowedHosts, lastUsed}; mirrored to session storage.
  const sessions = new Map();
  let sessionsLoaded = false;

  async function loadSessions() {
    if (sessionsLoaded) return;
    const data = await chrome.storage.session.get(BRIDGE_SESSIONS_KEY).catch(() => ({}));
    for (const [id, s] of Object.entries((data && data[BRIDGE_SESSIONS_KEY]) || {})) {
      if (!sessions.has(id)) sessions.set(id, s);
    }
    sessionsLoaded = true;
  }

  async function saveSessions() {
    await chrome.storage.session.set({ [BRIDGE_SESSIONS_KEY]: Object.fromEntries(sessions) }).catch(() => {});
  }

  function send(frame) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  // -- connection ---------------------------------------------------------

  /**
   * Bring the socket in line with the current state: connected while the user
   * is signed in and lets Lexi chat use this browser, closed otherwise.
   * `now` skips a pending reconnect delay (the user just changed something).
   */
  function sync({ now = false } = {}) {
    syncChain = syncChain.then(() => doSync(now)).catch(() => {});
    return syncChain;
  }

  async function doSync(now) {
    await sweepIdleSessions();
    const token = AGENT_MODE_AVAILABLE ? await accountToken() : null;
    if (!token || !(await bridgeAllowed())) {
      closeSocket();
      await endAllSessions();
      lastError = null;
      return;
    }
    const sites = await trustedSites();
    const { api_base: apiBase } = await getActiveConfig();
    if (ws && wsApiBase !== apiBase) closeSocket(); // the backend channel flipped
    if (ws) {
      if (ws.readyState === WebSocket.OPEN && sites.join(',') !== sentSites.join(',')) {
        if (send({ type: 'sites', sites, any_site: true })) sentSites = sites;
      }
      return;
    }
    if (retryTimer) {
      if (!now) return;
      clearTimeout(retryTimer);
      retryTimer = null;
      attempt = 0;
    }
    await connect(apiBase, token, sites);
  }

  async function connect(apiBase, token, sites) {
    let ticket;
    try {
      const res = await fetch(`${apiBase}${BRIDGE_TICKET_PATH}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      });
      if (res.status === 401) {
        lastError = 'Your Lexi session expired. Sign in again.';
        await onAuthExpired();
        return;
      }
      if (!res.ok) throw new Error(`Lexi refused the connection (HTTP ${res.status}).`);
      ticket = (await res.json()).ticket;
      if (!ticket) throw new Error('Lexi sent no connection ticket.');
    } catch (err) {
      lastError = (err && err.message) || 'Could not reach Lexi.';
      scheduleRetry();
      return;
    }

    const url = new URL(BRIDGE_WS_PATH, apiBase.replace(/^http/, 'ws'));
    url.searchParams.set('ticket', ticket);
    const socket = new WebSocket(url.toString());
    ws = socket;
    wsApiBase = apiBase;

    socket.onopen = () => {
      if (ws !== socket) return;
      attempt = 0;
      lastError = null;
      sentSites = sites;
      send({
        type: 'hello',
        protocol: BRIDGE_PROTOCOL,
        extension_version: chrome.runtime.getManifest().version,
        sites,
        any_site: true,
      });
      pingTimer = setInterval(() => {
        send({ type: 'ping' });
        sweepIdleSessions().catch(() => {});
      }, BRIDGE_PING_MS);
    };
    socket.onmessage = (event) => {
      if (ws === socket) onFrame(event.data);
    };
    socket.onerror = () => {
      if (ws === socket && !lastError) lastError = 'The connection to Lexi failed.';
    };
    socket.onclose = (event) => {
      if (ws !== socket) return; // closed on purpose by closeSocket()
      dropSocket();
      lastError = event.code === 4401 ? 'Lexi refused the connection ticket.' : lastError || 'Disconnected from Lexi.';
      scheduleRetry();
    };
  }

  function dropSocket() {
    ws = null;
    wsApiBase = null;
    connectionId = null;
    sentSites = [];
    clearInterval(pingTimer);
    pingTimer = null;
  }

  function closeSocket() {
    clearTimeout(retryTimer);
    retryTimer = null;
    attempt = 0;
    if (!ws) return;
    const socket = ws;
    dropSocket();
    try {
      socket.close(1000, 'bridge off');
    } catch {
      // Already closing.
    }
  }

  function scheduleRetry() {
    if (retryTimer) return;
    const delay = BRIDGE_BACKOFF_MS[Math.min(attempt, BRIDGE_BACKOFF_MS.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      sync();
    }, delay);
  }

  function onFrame(data) {
    let frame;
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'welcome') {
      connectionId = typeof frame.connection_id === 'string' ? frame.connection_id : null;
    } else if (frame.type === 'command') {
      runCommand(frame).then((reply) => send(reply));
    }
  }

  // -- commands -------------------------------------------------------------

  async function runCommand({ id, op, session, args }) {
    try {
      if (typeof session !== 'string' || !session) throw new BridgeError('bad_request', 'A command needs a session.');
      const a = args && typeof args === 'object' ? args : {};
      let result;
      if (op === 'open') result = await openSession(session, a);
      else if (op === 'tool') result = await runTool(session, a, id);
      else if (op === 'close') result = await closeSession(session, a);
      else throw new BridgeError('bad_request', `Unknown op: ${op}`);
      return { type: 'result', id, ok: true, result };
    } catch (err) {
      return {
        type: 'result',
        id,
        ok: false,
        code: (err && err.code) || 'tool_failed',
        error: (err && err.message) || String(err),
      };
    }
  }

  /**
   * Let session `s` use `hosts`: those on the user's list or already allowed
   * for it pass, Chrome asks about the rest (several at once: one site's
   * hosts). Adds them to its scope; a no throws `declined`.
   */
  async function allowHosts(s, hosts) {
    const blocked = hosts.find((host) => isDenylisted(`https://${host}`));
    if (blocked) throw new BridgeError('blocked', `${blocked} is on Lexi's denylist.`);
    const trusted = await trustedSites();
    const asking = hosts.filter((host) => !isAllowedHost(host, trusted) && !isAllowedHost(host, s.allowedHosts));
    if (asking.length) {
      const answer = await ask({ kind: 'site', hosts: asking });
      if (answer === 'no') {
        throw new BridgeError('declined', `The user did not let Lexi chat use ${asking.join(', ')}.`);
      }
      if (answer === 'always') await trustSites(asking);
    }
    s.allowedHosts = normalizeAllowedHosts([...(s.allowedHosts || []), ...hosts]);
  }

  /** execTool's confirm hook: ask the user about one action that needs it. */
  async function confirmAction({ actionClass, tool, input, origin }) {
    const answer = await ask({
      kind: 'action',
      host: bareHost(hostOfOrigin(origin)),
      action: actionClass,
      element: (input && input.elementName) || '',
      text: tool === 'type_text' ? (input && input.text) || '' : '',
    });
    return answer !== 'no';
  }

  async function openSession(sessionId, { url, allowed_hosts: allowedHosts }) {
    let target;
    try {
      target = new URL(String(url || ''));
    } catch {
      throw new BridgeError('bad_request', 'open needs an absolute http(s) URL.');
    }
    const host = httpHostOf(target.href);
    if (!host) throw new BridgeError('bad_request', 'open needs an absolute http(s) URL.');
    const wanted = normalizeAllowedHosts(allowedHosts).map(bareHost);
    const scope = wanted.length ? wanted : [bareHost(host)];
    if (!isAllowedHost(host, scope)) {
      throw new BridgeError('bad_request', `${host} is not one of allowed_hosts (${scope.join(', ')}).`);
    }

    await loadSessions();
    const existing = sessions.get(sessionId);
    const live = !!existing && (await tabExists(existing.tabId));
    const s = live ? existing : { tabId: null, allowedHosts: [] };
    await allowHosts(s, scope);
    s.lastUsed = Date.now();
    if (live) {
      sessions.set(sessionId, s);
      await saveSessions();
      await setRunScope(s.tabId, s.allowedHosts);
      const res = await execTool({ tool: 'navigate', input: { url: target.href } }, s.tabId, { remote: true });
      if (!res.ok) throw new BridgeError(res.code || 'tool_failed', res.error || 'Navigation failed.');
    } else {
      const tab = await chrome.tabs.create({ url: target.href, active: false });
      s.tabId = tab.id;
      sessions.set(sessionId, s);
      await saveSessions();
      await setRunScope(s.tabId, s.allowedHosts);
      await addToLexiGroup(s.tabId);
      await waitForLoad(s.tabId, BRIDGE_OPEN_TIMEOUT_MS);
    }
    await startControl(s.tabId).catch(() => {});
    return pageOf(s.tabId);
  }

  async function sessionTab(sessionId) {
    await loadSessions();
    const s = sessions.get(sessionId);
    if (!s) throw new BridgeError('no_session', 'This browsing session has no tab. Open one first.');
    if (!(await tabExists(s.tabId))) {
      sessions.delete(sessionId);
      await saveSessions();
      throw new BridgeError('tab_closed', 'The user closed this session’s tab.');
    }
    s.lastUsed = Date.now();
    return s;
  }

  async function runTool(sessionId, { name, input }, commandId) {
    if (!BRIDGE_TOOLS.includes(name)) throw new BridgeError('bad_request', `Unknown tool: ${name}`);
    const s = await sessionTab(sessionId);
    const args = cleanInput(input);
    // Where a navigate goes, and the page the tab is on now (a link may have
    // led off the session's sites), must be sites the user lets it use.
    let host = null;
    if (name === 'navigate') host = httpHostOf(String(args.url || ''));
    else if (name !== 'go_back') host = httpHostOf((await pageOf(s.tabId).catch(() => ({}))).url || '');
    if (host && !isAllowedHost(host, s.allowedHosts)) {
      await allowHosts(s, [bareHost(host)]);
      await saveSessions();
    }
    // Re-assert the session's scope: a side panel closing on this tab clears
    // whatever scope the tab had.
    await setRunScope(s.tabId, s.allowedHosts);
    const res = await execTool({ tool: name, input: args, toolUseId: `bridge:${commandId}` }, s.tabId, {
      remote: true,
      confirm: confirmAction,
    });
    if (!res.ok) throw new BridgeError(res.code || 'tool_failed', res.error || `${name} failed.`);
    const result = res.result && typeof res.result === 'object' && !Array.isArray(res.result) ? res.result : { value: res.result };
    return { ...result, page: await pageOf(s.tabId).catch(() => null) };
  }

  async function closeSession(sessionId, { keep_tab: keepTab }) {
    await loadSessions();
    const s = sessions.get(sessionId);
    if (!s) return { closed: true };
    sessions.delete(sessionId);
    await saveSessions();
    await endControl(s.tabId).catch(() => {});
    if (!keepTab) await chrome.tabs.remove(s.tabId).catch(() => {});
    return { closed: true };
  }

  /** Give the tab back to the user (scope off, overlay off, debugger detached). */
  async function releaseSession(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return;
    sessions.delete(sessionId);
    await saveSessions();
    await endControl(s.tabId).catch(() => {});
  }

  async function endAllSessions() {
    await loadSessions();
    for (const sessionId of [...sessions.keys()]) await releaseSession(sessionId);
  }

  async function sweepIdleSessions() {
    await loadSessions();
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [sessionId, s] of [...sessions]) {
      if ((s.lastUsed || 0) < cutoff) await releaseSession(sessionId);
    }
  }

  async function sessionIdForTab(tabId) {
    await loadSessions();
    for (const [sessionId, s] of sessions) if (s.tabId === tabId) return sessionId;
    return null;
  }

  // -- events from the service worker --------------------------------------

  /** The user closed a tab; if it was a session's, tell the server. */
  async function onTabRemoved(tabId) {
    const sessionId = await sessionIdForTab(tabId);
    if (!sessionId) return;
    sessions.delete(sessionId);
    await saveSessions();
    send({ type: 'ended', session: sessionId, reason: 'tab_closed' });
  }

  /** The user stopped control of a tab (Chrome's debugging infobar Cancel). */
  async function onTabStopped(tabId) {
    const sessionId = await sessionIdForTab(tabId);
    if (!sessionId) return;
    await releaseSession(sessionId);
    send({ type: 'ended', session: sessionId, reason: 'user_stopped' });
  }

  function status() {
    return {
      connected: !!ws && ws.readyState === WebSocket.OPEN,
      connectionId,
      sites: sentSites,
      error: lastError,
    };
  }

  return { sync, status, onTabRemoved, onTabStopped };
}
