// src/config.js
// Single source of truth for message-type constants, model list, endpoints,
// action classes, storage keys, limits, and the CSS design-token contract.
//
// Imported as an ES module by the side panel, options page, and the service
// worker. Content scripts (classic scripts, no `import`) do NOT import this
// file directly — service-worker.js and sidepanel.js are the modules that
// read it; any constant a content script needs is passed over messages
// rather than duplicated, to keep this file the single source of truth.

// ---------------------------------------------------------------------------
// Message-type constants (MSG) — every runtime message name used across
// Panel<->SW (Port) and SW<->Content-script (tabs.sendMessage) channels.
// Other agents' files depend on these EXACT string values.
// ---------------------------------------------------------------------------
export const MSG = {
  // Port lifecycle (Panel <-> SW)
  PORT_HELLO: 'PORT_HELLO',
  HEARTBEAT: 'HEARTBEAT',
  HEARTBEAT_ACK: 'HEARTBEAT_ACK',

  // Perception (Panel -> SW -> Content script -> SW -> Panel)
  EXTRACT_PAGE: 'EXTRACT_PAGE',
  PAGE_CONTENT: 'PAGE_CONTENT',
  CAPTURE_SCREENSHOT: 'CAPTURE_SCREENSHOT',
  SCREENSHOT_RESULT: 'SCREENSHOT_RESULT',

  // Agent lifecycle (Panel <-> SW)
  AGENT_START: 'AGENT_START',
  AGENT_STOP: 'AGENT_STOP',
  AGENT_STATUS: 'AGENT_STATUS',
  AGENT_ACTING: 'AGENT_ACTING',

  // Tool execution (Panel -> SW -> Panel)
  EXEC_TOOL: 'EXEC_TOOL',
  TOOL_RESULT: 'TOOL_RESULT',

  // Confirmation flow (Panel <-> SW <-> Panel)
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  CONFIRM_RESPONSE: 'CONFIRM_RESPONSE',

  // Site policy / permissions (Panel <-> SW)
  CHECK_SITE_POLICY: 'CHECK_SITE_POLICY',
  SITE_POLICY_RESULT: 'SITE_POLICY_RESULT',
  REQUEST_AGENT_PERMISSION: 'REQUEST_AGENT_PERMISSION',
  AGENT_PERMISSION_RESULT: 'AGENT_PERMISSION_RESULT',

  // Settings (Panel/Options <-> SW)
  GET_SETTINGS: 'GET_SETTINGS',
  SETTINGS: 'SETTINGS',
  KEY_VALIDATE: 'KEY_VALIDATE',
  KEY_VALIDATE_RESULT: 'KEY_VALIDATE_RESULT',

  // Account auth (Panel/Options <-> SW; SW <-> connect page via onMessageExternal)
  SIGN_IN_START: 'SIGN_IN_START', // panel -> SW: mint nonce + open the connect tab
  SIGN_OUT: 'SIGN_OUT', // panel -> SW: revoke the token, clear account keys
  GET_SESSION: 'GET_SESSION', // panel/options -> SW: fetch account + usage meter
  SESSION: 'SESSION', // SW -> panel/options: {account, usage, models} reply
  AUTH_CHANGED: 'AUTH_CHANGED', // SW -> all panels: auth state changed (sign in/out/expiry)
  // Type of the external message the lexi-frontend /extension/connect page
  // sends via chrome.runtime.sendMessage(EXTENSION_ID, ...). MUST match the
  // literal the connect page posts (see donna-frontend connect.tsx).
  CONNECT_RECEIVED: 'LEXI_EXTENSION_CONNECT',

  // Content-script channel (SW <-> Content script, via tabs.sendMessage)
  CS_EXTRACT: 'CS_EXTRACT',
  CS_PAGE: 'CS_PAGE',
  CS_INDEX: 'CS_INDEX',
  CS_ELEMENTS: 'CS_ELEMENTS',
  CS_OVERLAY: 'CS_OVERLAY',
  CS_HIDE_FOR_TOOL: 'CS_HIDE_FOR_TOOL',
  CS_SHOW_AFTER_TOOL: 'CS_SHOW_AFTER_TOOL',
  CS_RESOLVE_REF: 'CS_RESOLVE_REF',
  CS_REF_INFO: 'CS_REF_INFO',
  CS_SYNTHETIC_ACTION: 'CS_SYNTHETIC_ACTION',
  CS_ACTION_RESULT: 'CS_ACTION_RESULT',
};

// Name of the long-lived Port the side panel opens against the SW.
export const PORT_NAME = 'lexi-sidepanel';

// ---------------------------------------------------------------------------
// Build flag — whether Agent Mode (Lexi clicking/typing/acting on the page)
// is available in THIS build.
//
//   true  → the full extension: Chat + Agent modes, optional debugger/tabs/
//           <all_urls> permissions requested just-in-time.
//   false → the chat-only "lite" build produced by scripts/build-lite.mjs,
//           which also strips the optional_permissions/optional_host_permissions
//           from the manifest for a fast Chrome Web Store review lane.
//
// scripts/build-lite.mjs rewrites the SINGLE line below (`= true;` → `= false;`)
// in its staged copy — the source here MUST stay `true` so the full build is
// unchanged. Every agent-mode entry point (side-panel Agent tab, options agent
// settings, the REQUEST_AGENT_PERMISSION handler) gates on this constant, so
// the product behaves correctly with the flag either way.
// ---------------------------------------------------------------------------
export const AGENT_MODE_AVAILABLE = true;

// ---------------------------------------------------------------------------
// Backend channel — which Lexi backend (+ connect-page origin) this build
// talks to. RUNTIME-RESOLVED, not baked: on startup (and periodically) the
// extension GETs RUNTIME_CONFIG_URL — the ONE stable control-plane URL, always
// on the always-up prod host — and caches the active channel in
// chrome.storage.local[LEXI_CHANNEL_CONFIG]. Every backend call then resolves
// its base from that cache (see background/channel-config.js getActiveConfig).
// The maps below are the BAKED fallback AND the ONLY host values ever accepted
// (see CHANNEL_ALLOWLIST). Until the first refresh completes — and whenever the
// fetch fails or returns an off-allowlist payload — DEFAULT_CHANNEL is used, so
// the product works offline-of-config on first launch (defaults to prod).
//
// A single server-side env var (LEXI_EXTENSION_CHANNEL: production | staging)
// flips which channel RUNTIME_CONFIG_URL reports, so one published ZIP can be
// pointed at staging (for the Chrome Web Store review login) or prod (public)
// with NO new upload.
//
// BUILD_CHANNEL is retained ONLY for backwards-compat with the packagers
// (scripts/package.sh, build-lite.mjs) which still rewrite this one line; it no
// longer drives the API base, which is runtime-resolved.
// ---------------------------------------------------------------------------
export const BUILD_CHANNEL = 'staging';

// The active channel until a runtime-config refresh says otherwise.
export const DEFAULT_CHANNEL = 'production';

// Baked channel maps. Keys align with the backend's get_extension_channel()
// values ('production' | 'staging'). Each entry is the EXACT, canonical set of
// hosts for that channel; a fetched runtime-config is accepted only if it
// matches one of these entries byte-for-byte (see channel-config.js).
export const CHANNELS = {
  production: {
    channel: 'production',
    api_base: 'https://api.getlexi.io',
    connect_url: 'https://app.getlexi.io/extension/connect',
    connect_origin: 'https://app.getlexi.io',
  },
  staging: {
    channel: 'staging',
    api_base: 'https://staging-api.getlexi.io',
    connect_url: 'https://staging.getlexi.io/extension/connect',
    connect_origin: 'https://staging.getlexi.io',
  },
};

// The ONE stable control-plane URL baked into every build. ALWAYS the prod
// host (the always-up backend), regardless of the active channel: this is how
// a published extension learns whether to point itself at prod or staging.
export const RUNTIME_CONFIG_URL = 'https://api.getlexi.io/api/extension/runtime-config';

// Baked host allowlist. A fetched/stored channel config is REJECTED WHOLESALE
// unless every host it names is on these lists — so a compromised or spoofed
// control plane can never point the extension at an attacker origin.
export const CHANNEL_ALLOWLIST = {
  api_base: ['https://api.getlexi.io', 'https://staging-api.getlexi.io'],
  connect_origin: ['https://app.getlexi.io', 'https://staging.getlexi.io'],
};

// Origins onMessageExternal accepts a LEXI_EXTENSION_CONNECT handoff from.
// Kept BAKED (both channels) and NEVER narrowed to the fetched value — the
// connect-page origin check must not depend on runtime-fetched data.
export const CONNECT_ORIGINS = ['https://app.getlexi.io', 'https://staging.getlexi.io'];

// chrome.storage.local key holding the cached, validated active channel config.
export const LEXI_CHANNEL_CONFIG = 'lexi_channel_config';

// Agent-mode proxy (Anthropic-shaped SSE passthrough) + Chat-mode product pipeline.
export const EXTENSION_PROXY_PATH = '/api/extension/messages';
export const CHAT_PATH = '/llm/chat';
export const SESSION_PATH = '/api/extension/auth/session';
export const REVOKE_PATH = '/api/extension/auth/revoke';

// ---------------------------------------------------------------------------
// Anthropic API endpoints — RETAINED for the UI-less BYOK escape hatch (the
// hermetic Agent-Mode e2e seam). Not part of the shipping login-only UX.
// ---------------------------------------------------------------------------
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
export const ANTHROPIC_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Model picker (config.js MODELS, current 2026 ids)
// ---------------------------------------------------------------------------
export const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5 · balanced (default)', vision: true },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 · deep analysis', vision: true },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 · fast', vision: true },
  { id: 'claude-fable-5', label: 'Fable 5 · max reasoning', vision: true },
];

export const DEFAULT_MODEL = 'claude-sonnet-5';
// Model used for the nested find_element disambiguation call.
export const FIND_MODEL = 'claude-haiku-4-5';

// ---------------------------------------------------------------------------
// Action classes that ALWAYS require an explicit human confirm, regardless
// of the user's chosen approval mode.
// ---------------------------------------------------------------------------
export const RISKY_CLASSES = [
  'SUBMIT',
  'NAVIGATE_NEW_DOMAIN',
  'PAY',
  'SEND_MESSAGE',
  'UPLOAD',
  'DOWNLOAD',
  'DELETE',
];

// ---------------------------------------------------------------------------
// Numeric/behavioral limits shared by agent-loop, perception, and clients.
// ---------------------------------------------------------------------------
export const LIMITS = {
  MAX_ELEMENTS: 150, // interactive-element index cap (set-of-marks)
  MAX_TEXT_TOKENS: 12000, // ~48k chars extracted-text cap
  MAX_IMAGE_PX: 1568, // downscale target, long edge, before base64
  MAX_STEPS: 24, // agent loop step ceiling
  MAX_FAILURES: 3, // consecutive tool failures before aborting the run
  HEARTBEAT_MS: 25000, // Panel -> SW heartbeat interval
  MAX_TOKENS_STEP: 4096, // max_tokens per Anthropic Messages call
};

// ---------------------------------------------------------------------------
// chrome.storage.local keys. All durable state lives here (module-level
// globals are NOT retained across SW teardown).
// ---------------------------------------------------------------------------
export const STORAGE_KEYS = {
  // Account mode (the shipping login-only path).
  AUTH_MODE: 'lexi_auth_mode', // 'account' | 'byok' | (unset = signed out)
  EXTENSION_TOKEN: 'lexi_extension_token', // opaque lexiext_ Bearer token
  ACCOUNT_INFO: 'lexi_account_info', // {email, first_name, tier, ...} for the chip
  // BYOK escape hatch — retained UI-less, seeded by the e2e suite (and by any
  // pre-existing BYOK user). Presence of API_KEY implies BYOK mode when
  // AUTH_MODE is unset, so the storage-seeding e2e seam keeps working.
  API_KEY: 'lexi_api_key',
  MODEL: 'lexi_model',
  APPROVAL_MODE: 'lexi_approval_mode',
  SITE_GRANTS: 'lexi_site_grants',
  PROVIDER: 'lexi_provider',
};

// chrome.storage.session key holding the in-flight sign-in nonce (state) minted
// by SIGN_IN_START and verified by onMessageExternal (replay/CSRF guard). Lives
// in session storage (TRUSTED_CONTEXTS), never in local, so it clears on browser
// restart and is unreadable by content scripts.
export const CONNECT_NONCE_KEY = 'lexi_connect_nonce';

// ---------------------------------------------------------------------------
// Static site-policy denylist — hard-blocks Agent Mode entirely (chat/see+
// answer still works but shows a warning banner). Host regexes matched
// against a tab's origin/hostname by permission-manager.js.
// ---------------------------------------------------------------------------
export const DENYLIST = [
  // Financial / banking / brokerage / payment processors
  /(^|\.)bank(ing)?\./i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /checkout\.stripe\.com$/i,
  /(^|\.)coinbase\.com$/i,
  /(^|\.)binance\.com$/i,
  /(^|\.)venmo\.com$/i,
  /(^|\.)wise\.com$/i,
  /(^|\.)chase\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
  /(^|\.)americanexpress\.com$/i,
  /pay\.google\.com$/i,
  /(^|\.)gov$/i, // *.gov payment portals — treat broadly conservative

  // Adult content
  /(^|\.)pornhub\.com$/i,
  /(^|\.)xvideos\.com$/i,
  /(^|\.)onlyfans\.com$/i,

  // Known credential / 2FA / identity-provider pages
  /accounts\.google\.com$/i,
  /login\.microsoftonline\.com$/i,
  /(^|\.)okta\.com$/i,
  /(^|\.)auth0\.com$/i,
  /login\.yahoo\.com$/i,
  /(^|\.)duosecurity\.com$/i,
];

// ---------------------------------------------------------------------------
// CSS_TOKENS — the --lexi-* custom properties every UI file (sidepanel.css,
// options.html reusing sidepanel.css) MUST use instead of hardcoding colors.
// Defined concretely (with light + dark values) in sidepanel.css; this is a
// documentation-only contract listing the token names for other files.
//
//   --lexi-bg              page/panel background
//   --lexi-surface         raised surface (cards, chips, header)
//   --lexi-text            primary text color
//   --lexi-muted           secondary/meta text color
//   --lexi-border          hairline border color
//   --lexi-accent          brand teal accent (#045b6c light / #24cda5 dark)
//   --lexi-accent-strong   stronger accent (hover/active states)
//   --lexi-accent-tint     faint accent background tint (hover/selected)
//   --lexi-user-bubble     flat neutral user-message surface (app messagebox)
//   --lexi-risk            severity: HIGH / danger / stop
//   --lexi-warn            severity: MED / caution
//   --lexi-ok              severity: LOW / success
//   --lexi-r               base border radius (10px)
// ---------------------------------------------------------------------------
export const CSS_TOKENS = [
  '--lexi-bg',
  '--lexi-surface',
  '--lexi-text',
  '--lexi-muted',
  '--lexi-border',
  '--lexi-accent',
  '--lexi-accent-strong',
  '--lexi-accent-tint',
  '--lexi-user-bubble',
  '--lexi-risk',
  '--lexi-warn',
  '--lexi-ok',
  '--lexi-r',
];
