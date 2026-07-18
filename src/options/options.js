// src/options/options.js
//
// Controller for the login-only settings page (src/options/options.html).
// Reads/writes chrome.storage.local DIRECTLY for the account, approval-mode,
// on-device-model, and per-site-grant settings. There is NO API-key UI and NO
// raw model picker: the Lexi server owns model/tier selection (product-chat
// sends no model). The BYOK escape hatch (the hermetic e2e seam) still works
// when a key is seeded into chrome.storage.local, but has ZERO visible UI.
//
// ES module (loaded via <script type="module">) — safe to use import/export.

import {
  MSG,
  DEFAULT_MODEL,
  STORAGE_KEYS,
  AGENT_MODE_AVAILABLE,
  LEXI_CHANNEL_CONFIG,
} from '../config.js';
import { getActiveConfig } from '../background/channel-config.js';
import { nanoAvailability } from '../agent/gemini-nano.js';

const ALL_STORAGE_KEYS = Object.values(STORAGE_KEYS);

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

// Account section
const accountSignedOut = $('account-signed-out');
const accountSignedIn = $('account-signed-in');
const accountSigninBtn = $('account-signin-btn');
const accountSignoutBtn = $('account-signout-btn');
const accountEmailText = $('account-email-text');
const accountTierText = $('account-tier-text');
const accountUsageText = $('account-usage-text');
const accountManageLink = $('account-manage-link');

const approvalRadios = () =>
  Array.from(document.querySelectorAll('input[name="approval-mode"]'));
const nanoToggle = $('nano-tier-toggle');
const nanoNote = $('nano-tier-note');
const nanoDownloadBtn = $('nano-download-btn');
const siteGrantsList = $('site-grants-list');
const siteGrantsEmpty = $('site-grants-empty');

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init();

async function init() {
  applyBuildFlags();
  wireEvents();
  await loadSettings();
  await refreshAccount();
  await refreshNanoRow();
}

/**
 * Chat-only lite build: hide the agent-only settings (approval mode + the
 * agent-enabled-sites list), since Agent Mode does not exist in this build.
 * No-op in the full build, so the full options page is unchanged.
 */
function applyBuildFlags() {
  if (AGENT_MODE_AVAILABLE) return;
  hideSectionWithDivider(document.getElementById('approval-mode-group'));
  hideSectionWithDivider(document.getElementById('site-grants-group'));
}

function hideSectionWithDivider(node) {
  if (!node) return;
  const prev = node.previousElementSibling;
  if (prev && prev.classList.contains('divider')) prev.hidden = true;
  node.hidden = true;
}

function wireEvents() {
  accountSigninBtn?.addEventListener('click', onAccountSignInClick);
  accountSignoutBtn?.addEventListener('click', onAccountSignOutClick);
  refreshManageAccountLink();
  approvalRadios().forEach((radio) =>
    radio.addEventListener('change', onApprovalModeChange)
  );
  nanoToggle.addEventListener('change', onNanoToggleChange);
  nanoDownloadBtn.addEventListener('click', onNanoDownloadClick);

  // Sign-in completes in another tab (the connect handoff), so re-render the
  // account section when the auth keys change under us. Also re-resolve the
  // "Manage account" link when the active channel config changes, so an
  // options tab left open across a server-side channel flip does not keep
  // pointing "Manage account" at the pre-flip environment's origin.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (
        changes[STORAGE_KEYS.EXTENSION_TOKEN] ||
        changes[STORAGE_KEYS.AUTH_MODE] ||
        changes[STORAGE_KEYS.ACCOUNT_INFO]
      ) {
        refreshAccount();
      }
      if (changes[LEXI_CHANNEL_CONFIG]) {
        refreshManageAccountLink();
      }
    });
  }
}

/**
 * Resolve the "Manage account" link's origin from the ACTIVE channel (prod
 * app.getlexi.io or staging.getlexi.io), cache-first, so it tracks a channel
 * flip. Async — the link is (re)populated once the config resolves.
 */
function refreshManageAccountLink() {
  if (!accountManageLink) return;
  getActiveConfig()
    .then((cfg) => {
      accountManageLink.href = `${cfg.connect_origin}/account`;
    })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Load current settings from chrome.storage.local and render them
// ---------------------------------------------------------------------------
async function loadSettings() {
  const stored = await chrome.storage.local.get(ALL_STORAGE_KEYS);

  const approvalMode = stored[STORAGE_KEYS.APPROVAL_MODE] || 'manual';
  const matchingRadio = approvalRadios().find((r) => r.value === approvalMode);
  if (matchingRadio) {
    matchingRadio.checked = true;
  }

  renderSiteGrants(stored[STORAGE_KEYS.SITE_GRANTS] || {});
}

// ---------------------------------------------------------------------------
// Account section (login-only primary path)
// ---------------------------------------------------------------------------

/** Fetch the session via the SW and render signed-in / signed-out state. */
async function refreshAccount() {
  let session = null;
  try {
    session = await chrome.runtime.sendMessage({ type: MSG.GET_SESSION });
  } catch {
    session = null;
  }
  renderAccount(session);
}

function renderAccount(session) {
  const signedIn = !!(session && session.ok);
  if (accountSignedOut) accountSignedOut.hidden = signedIn;
  if (accountSignedIn) accountSignedIn.hidden = !signedIn;
  if (!signedIn) return;

  const account = session.account || {};
  if (accountEmailText) accountEmailText.textContent = account.email || 'Signed in';
  if (accountTierText) accountTierText.textContent = account.tier || '—';
  if (accountUsageText) accountUsageText.textContent = formatUsage(session.usage);
}

function formatUsage(usage) {
  if (!usage) return '—';
  const used = usage.used ?? 0;
  const period = usage.period || 'month';
  if (usage.limit === null || usage.limit === undefined) return `${used} used this ${period}`;
  return `${used} / ${usage.limit} this ${period}`;
}

async function onAccountSignInClick() {
  try {
    await chrome.runtime.sendMessage({ type: MSG.SIGN_IN_START });
  } catch {
    // SW may be asleep; the message wakes it. No inline error needed here.
  }
}

async function onAccountSignOutClick() {
  try {
    await chrome.runtime.sendMessage({ type: MSG.SIGN_OUT });
  } catch {
    // Best-effort — the SW clears the keys and broadcasts AUTH_CHANGED.
  }
  await refreshAccount();
}

// ---------------------------------------------------------------------------
// Approval mode
// ---------------------------------------------------------------------------
async function onApprovalModeChange(event) {
  const radio = event.currentTarget;
  if (!radio.checked) return;
  await chrome.storage.local.set({
    [STORAGE_KEYS.APPROVAL_MODE]: radio.value,
  });
  await broadcastSettings();
}

// ---------------------------------------------------------------------------
// Gemini Nano (on-device) tier
// ---------------------------------------------------------------------------
async function refreshNanoRow() {
  const availability = await nanoAvailability();
  const stored = await chrome.storage.local.get(STORAGE_KEYS.PROVIDER);
  const prefersNano = stored[STORAGE_KEYS.PROVIDER] === 'nano';

  nanoDownloadBtn.hidden = availability !== 'downloadable';

  if (availability === 'available') {
    nanoToggle.disabled = false;
    nanoToggle.checked = prefersNano;
    nanoNote.textContent =
      'Ready to use as an on-device fallback for quick explain/summarize actions when you are offline or signed out.';
  } else if (availability === 'downloadable') {
    nanoToggle.disabled = true;
    nanoToggle.checked = false;
    nanoNote.textContent =
      'Available to download on this device (a few GB, one-time). Download it below, then enable it here.';
  } else if (availability === 'downloading') {
    nanoToggle.disabled = true;
    nanoToggle.checked = false;
    nanoNote.textContent =
      'Downloading the on-device model… this can take a while.';
  } else {
    nanoToggle.disabled = true;
    nanoToggle.checked = false;
    nanoNote.textContent =
      'Not available on this device (needs Chrome 138+, sufficient free disk space, and a supported GPU). For careful contract analysis, sign in with your Lexi account above.';
  }
}

async function onNanoToggleChange() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.PROVIDER]: nanoToggle.checked ? 'nano' : 'anthropic',
  });
  await broadcastSettings();
}

async function onNanoDownloadClick() {
  nanoDownloadBtn.disabled = true;
  nanoNote.textContent = 'Starting on-device model download…';

  try {
    if (typeof LanguageModel !== 'undefined') {
      const session = await LanguageModel.create({
        expectedInputs: [{ type: 'text', languages: ['en'] }],
      });
      if (session && typeof session.destroy === 'function') {
        try {
          session.destroy();
        } catch (err) {
          // Best-effort cleanup only.
        }
      }
    }
  } catch (err) {
    // The user may cancel Chrome's own download prompt, or the device may
    // not actually meet the hardware bar despite reporting 'downloadable'.
    // Non-fatal: refreshNanoRow() below re-reads the true availability.
  } finally {
    nanoDownloadBtn.disabled = false;
    await refreshNanoRow();
  }
}

// ---------------------------------------------------------------------------
// Per-site agent grants
// ---------------------------------------------------------------------------
function renderSiteGrants(grants) {
  const origins = Object.keys(grants || {});
  siteGrantsList.innerHTML = '';
  siteGrantsEmpty.hidden = origins.length > 0;

  for (const origin of origins) {
    const li = document.createElement('li');

    const label = document.createElement('span');
    label.className = 'site-origin';
    label.textContent = origin;

    const revokeBtn = document.createElement('button');
    revokeBtn.type = 'button';
    revokeBtn.className = 'btn btn-muted btn-small';
    revokeBtn.textContent = 'Revoke';
    revokeBtn.addEventListener('click', () => revokeGrant(origin, revokeBtn));

    li.appendChild(label);
    li.appendChild(revokeBtn);
    siteGrantsList.appendChild(li);
  }
}

async function revokeGrant(origin, triggerBtn) {
  if (triggerBtn) triggerBtn.disabled = true;

  // Prefer the shared permission-manager module (the single source of truth
  // for grant bookkeeping, per SPEC) when it's reachable; fall back to a
  // direct storage mutation so this page degrades gracefully if that module
  // isn't present in the loaded build.
  let revokedViaManager = false;
  try {
    const permissionManager = await import(
      '../background/permission-manager.js'
    );
    if (typeof permissionManager.revokeSite === 'function') {
      await permissionManager.revokeSite(origin);
      revokedViaManager = true;
    }
  } catch (err) {
    // permission-manager.js not present/loadable in this build — fall
    // through to the direct-storage fallback below.
  }

  if (!revokedViaManager) {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.SITE_GRANTS);
    const grants = { ...(stored[STORAGE_KEYS.SITE_GRANTS] || {}) };
    delete grants[origin];
    await chrome.storage.local.set({ [STORAGE_KEYS.SITE_GRANTS]: grants });
  }

  const afterStored = await chrome.storage.local.get(STORAGE_KEYS.SITE_GRANTS);
  const remainingGrants = afterStored[STORAGE_KEYS.SITE_GRANTS] || {};
  const remainingOrigins = Object.keys(remainingGrants);

  // Drop the host-permission grant for this specific origin...
  try {
    await chrome.permissions.remove({ origins: [toOriginPattern(origin)] });
  } catch (err) {
    // Origin may never have needed a separate host grant (e.g. it was
    // covered by activeTab) — nothing to clean up, non-fatal.
  }

  // ...and if no site has agent actions enabled anymore, drop the optional
  // 'debugger' permission entirely rather than leaving it dangling.
  if (remainingOrigins.length === 0) {
    try {
      await chrome.permissions.remove({ permissions: ['debugger'] });
    } catch (err) {
      // Already absent — non-fatal.
    }
  }

  renderSiteGrants(remainingGrants);
  await broadcastSettings();
}

function toOriginPattern(origin) {
  return origin.endsWith('/*') ? origin : `${origin.replace(/\/$/, '')}/*`;
}

// ---------------------------------------------------------------------------
// Broadcast: any open side panel refreshes its settings after a write here.
// ---------------------------------------------------------------------------
async function broadcastSettings() {
  const stored = await chrome.storage.local.get(ALL_STORAGE_KEYS);
  const settings = {
    model: stored[STORAGE_KEYS.MODEL] || DEFAULT_MODEL,
    approvalMode: stored[STORAGE_KEYS.APPROVAL_MODE] || 'manual',
    provider: stored[STORAGE_KEYS.PROVIDER] || 'anthropic',
    hasApiKey: Boolean(stored[STORAGE_KEYS.API_KEY]),
    siteGrants: stored[STORAGE_KEYS.SITE_GRANTS] || {},
  };

  try {
    await chrome.runtime.sendMessage({ type: MSG.SETTINGS, settings });
  } catch (err) {
    // No open panel/listener to receive it right now — expected and
    // harmless (chrome.runtime.sendMessage rejects when nothing is
    // listening on the other end).
  }
}
