// src/background/channel-config.js
//
// Runtime channel resolution — the seam that lets ONE published extension be
// pointed at the prod or the staging Lexi backend by flipping a single
// server-side env var (LEXI_EXTENSION_CHANNEL), with NO new ZIP upload.
//
// The extension bakes ONE stable control-plane URL (RUNTIME_CONFIG_URL, always
// on the prod host). refreshChannelConfig() GETs it, validates the returned
// {channel, api_base, connect_url, connect_origin} against the BAKED
// CHANNEL_ALLOWLIST, and — only if every host checks out AND the trio matches a
// baked CHANNELS entry byte-for-byte — caches the canonical config in
// chrome.storage.local[LEXI_CHANNEL_CONFIG]. getActiveConfig() is cache-first:
// it returns the cached channel if present+valid, else the baked
// DEFAULT_CHANNEL (production). It NEVER returns an off-allowlist host, so a
// spoofed/compromised control plane can never redirect backend traffic.
//
// ES module — imported by the service worker, the side panel, and the options
// page (all trusted extension contexts with chrome.storage access). It is NOT
// for content scripts (classic scripts, no `import`); nothing here should ever
// be needed there.

import {
  RUNTIME_CONFIG_URL,
  CHANNELS,
  CHANNEL_ALLOWLIST,
  DEFAULT_CHANNEL,
  LEXI_CHANNEL_CONFIG,
} from '../config.js';

// Short timeout: config resolution is cache-first, so a slow/unreachable
// control plane must never block a launch — we just keep the previous cache
// (or the baked default) and try again on the next tick.
const FETCH_TIMEOUT_MS = 5000;

/** The baked default channel config (production). Never off-allowlist. */
export function bakedDefaultConfig() {
  return { ...CHANNELS[DEFAULT_CHANNEL] };
}

/**
 * Return the canonical baked config for a candidate payload, or null if the
 * candidate is not a byte-for-byte match of a baked, allowlisted channel entry.
 *
 * This is intentionally strict: the runtime-config response only SELECTS which
 * channel is active — the actual hosts are always the baked ones. So a payload
 * with a known `channel` whose api_base/connect_url/connect_origin all equal
 * that channel's baked entry (and whose hosts are on the flat allowlist) is
 * accepted and canonicalized to the baked object; anything else is rejected.
 */
function canonicalConfigFor(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  // Guard the CHANNELS lookup with hasOwnProperty so an attacker-chosen
  // `channel` of "__proto__"/"constructor"/"toString" resolves to `undefined`
  // (and is rejected here) rather than to an Object.prototype member — the
  // byte-for-byte + allowlist checks below must NOT be the only thing standing
  // between a malformed channel value and a trusted config.
  if (typeof candidate.channel !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(CHANNELS, candidate.channel)) return null;
  const baked = CHANNELS[candidate.channel];
  if (!baked) return null;
  if (candidate.api_base !== baked.api_base) return null;
  if (candidate.connect_url !== baked.connect_url) return null;
  if (candidate.connect_origin !== baked.connect_origin) return null;
  // Defense-in-depth: the baked entry itself must be on the flat allowlist.
  if (!CHANNEL_ALLOWLIST.api_base.includes(baked.api_base)) return null;
  if (!CHANNEL_ALLOWLIST.connect_origin.includes(baked.connect_origin)) return null;
  return { ...baked };
}

/**
 * Fetch the runtime channel config from the control plane, validate it, and —
 * on success — cache the canonical config. On ANY failure (network error,
 * timeout, non-2xx, unparseable body, or an off-allowlist payload) the existing
 * cached value is left UNTOUCHED. Returns the resolved active config.
 */
export async function refreshChannelConfig() {
  let payload = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(RUNTIME_CONFIG_URL, { method: 'GET', signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return getActiveConfig();
    payload = await res.json();
  } catch {
    // Network/timeout/parse failure — keep whatever is already cached.
    return getActiveConfig();
  }

  const canonical = canonicalConfigFor(payload);
  if (!canonical) {
    // Off-allowlist / malformed payload — never trust it; keep the cache.
    return getActiveConfig();
  }

  try {
    await chrome.storage.local.set({ [LEXI_CHANNEL_CONFIG]: canonical });
  } catch {
    // A storage write failure is non-fatal: getActiveConfig still returns a
    // safe value (the previous cache or the baked default).
  }
  return canonical;
}

/**
 * Like getActiveConfig(), but if NO valid channel is cached yet (e.g. a brand-
 * new install/relaunch whose first background refresh hasn't landed), resolve
 * one NOW — awaiting a single bounded refreshChannelConfig() — instead of
 * silently returning the baked prod default. Used by the security-sensitive
 * sign-in handoff so a staging build's very first sign-in is not sent to the
 * prod connect page just because the user clicked before the boot-time fetch
 * completed. On any failure refreshChannelConfig() itself falls back to the
 * baked default, so this still NEVER returns an off-allowlist host and is
 * bounded by FETCH_TIMEOUT_MS.
 */
export async function ensureActiveConfig() {
  try {
    const stored = (await chrome.storage.local.get(LEXI_CHANNEL_CONFIG))[LEXI_CHANNEL_CONFIG];
    const canonical = canonicalConfigFor(stored);
    if (canonical) return canonical;
  } catch {
    // Fall through to a one-shot refresh on any storage read error.
  }
  return refreshChannelConfig();
}

/**
 * Cache-first resolution of the active channel config. Reads the cached value
 * and returns it iff it still validates against the baked allowlist; otherwise
 * returns the baked DEFAULT_CHANNEL (production) config. NEVER blocks on the
 * network and NEVER returns an off-allowlist host.
 */
export async function getActiveConfig() {
  try {
    const stored = (await chrome.storage.local.get(LEXI_CHANNEL_CONFIG))[LEXI_CHANNEL_CONFIG];
    const canonical = canonicalConfigFor(stored);
    if (canonical) return canonical;
  } catch {
    // Fall through to the baked default on any storage read error.
  }
  return bakedDefaultConfig();
}
