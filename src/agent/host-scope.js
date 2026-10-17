// src/agent/host-scope.js
//
// A run's host allowlist ("scope"): the sites one agent run may act on.
// Whoever starts a run (a task type, the web app, a test) passes
// allowedHosts to createAgentRun; the service worker enforces it on every
// action (permission-manager.js) and the agent loop tells the model when the
// tab has wandered off it. Pure functions, no chrome.* usage — imported by
// both the side panel and the service worker.
//
// ES module.

/**
 * Lower-cased bare hostnames from task input ("https://www.Example.com/x" ->
 * "www.example.com"). Anything that is not a dotted hostname is dropped, so a
 * bare TLD ("com"), a wildcard or junk can never widen a scope to every site.
 */
export function normalizeAllowedHosts(list) {
  if (!Array.isArray(list)) return [];
  const out = new Set();
  for (const item of list) {
    const raw = String(item || '').trim().toLowerCase();
    if (!raw) continue;
    let host;
    try {
      host = new URL(raw.includes('://') ? raw : `https://${raw}`).hostname;
    } catch {
      continue;
    }
    host = host.replace(/^\.+|\.+$/g, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) out.add(host);
  }
  return [...out];
}

/** Hostname of an absolute http(s) URL, or null. */
export function httpHostOf(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when `host` is one of `allowedHosts` or a subdomain of one. */
export function isAllowedHost(host, allowedHosts) {
  if (!host || !Array.isArray(allowedHosts) || !allowedHosts.length) return false;
  const h = String(host).toLowerCase();
  return allowedHosts.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}
