# Lexi for Chrome — Operations Runbook

Everything you need to run, switch, and deploy the **Lexi for Chrome** extension
across environments. **No secret values live in this file** — only the *names*
and *locations* of config so you know where to look.

Repos:
- Extension (this repo): `lexi-sg/lexi-for-chrome` (public, MV3).
- Backend: `Getlexi/donna-backend` (FastAPI, Azure Container Apps).
- Frontend: `Getlexi/lexi-frontend` (Next.js, Vercel) — hosts the
  `/extension/connect` sign-in handoff page.

---

## 1. TL;DR — switch the whole install between Production and Staging

**One server flag flips every already-installed copy of the extension. No
re-upload, no new ZIP, no user action.** It propagates within ~5 min (endpoint
cache) — usually ~55s.

```bash
# → PRODUCTION (public users: api.getlexi.io + app.getlexi.io)
az containerapp update -n lexi-backend -g lexi-prod \
  --set-env-vars LEXI_EXTENSION_CHANNEL=production -o none

# → STAGING (CWS reviewers: api-staging.getlexi.io + staging.getlexi.io)
az containerapp update -n lexi-backend -g lexi-prod \
  --set-env-vars LEXI_EXTENSION_CHANNEL=staging -o none
```

**Verify (this is the source of truth the extension reads):**

```bash
curl -s https://api.getlexi.io/api/extension/runtime-config
# production → {"channel":"production","api_base":"https://api.getlexi.io",
#              "connect_url":"https://app.getlexi.io/extension/connect", ...}
# staging    → {"channel":"staging","api_base":"https://api-staging.getlexi.io",
#              "connect_url":"https://staging.getlexi.io/extension/connect", ...}
```

Default when the flag is unset = `production`.

---

## 2. How the channel switch actually works

The published ZIP bakes exactly ONE URL — a **control plane** that is *always
prod*:

```
RUNTIME_CONFIG_URL = https://api.getlexi.io/api/extension/runtime-config
```

The extension polls it on install/startup + every 30 min + on panel open, and
resolves **all** of its backend/connect URLs from the answer. So flipping the
server flag repoints every install without touching the ZIP.

```
┌────────────────────┐   GET /api/extension/runtime-config   ┌──────────────────────┐
│  Extension (ZIP)   │ ────────────────────────────────────▶ │  api.getlexi.io      │
│  bakes only the    │                                        │  (prod, ALWAYS)      │
│  control-plane URL │ ◀──────────────────────────────────── │  reads               │
└────────────────────┘   {channel, api_base, connect_url}     │  LEXI_EXTENSION_     │
         │                                                    │  CHANNEL env var     │
         │ then talks to whatever api_base / connect_url      └──────────────────────┘
         ▼ the response named (prod OR staging hosts)
```

**Safety:** the response is chosen from a hardcoded 2-entry map on the server
(`_CHANNEL_CONFIG`), and the extension re-validates every host against a baked
allowlist (`*.getlexi.io` only) before trusting it. No env var or request input
can inject an arbitrary host.

---

## 3. Where every piece of config lives

### 3a. Azure (backend) — the channel flag
| What | Value |
|------|-------|
| Prod container app | `lexi-backend` in resource group `lexi-prod` (fqdn `api.getlexi.io`) |
| Staging container app | `lexi-backend-staging` in rg `lexi-corpus-staging` |
| **Channel flag** | env var **`LEXI_EXTENSION_CHANNEL`** = `production` \| `staging` (unset ⇒ `production`) |
| Read by | `core/config.py::get_extension_channel()` |
| Channel→hosts map | `app/extension/api/extension_config.py::_CHANNEL_CONFIG` (the only two host sets ever served) |
| Endpoint | `GET /api/extension/runtime-config` (public, no auth), 5-min `Cache-Control` |

Check / set the flag:
```bash
az containerapp show -n lexi-backend -g lexi-prod \
  --query "properties.template.containers[0].env[?name=='LEXI_EXTENSION_CHANNEL']" -o json
```

### 3b. Vercel (frontend) — the connect page + extension IDs
The frontend hosts `pages/extension/connect.tsx` (the "Sign in with Lexi"
handoff). It hands the freshly-minted token to the installed extension via
`chrome.runtime.sendMessage(<extensionId>, …)`, so it must know which extension
IDs to target.

| What | Where |
|------|-------|
| Target extension IDs | `src/constants/env.constants.ts` → `LEXI_EXTENSION_IDS` array + `getLexiExtensionIds()` |
| Env override (optional) | Vercel env var **`NEXT_PUBLIC_LEXI_EXTENSION_ID`** (comma-separated; merged with the committed list) |
| Dev (unpacked) ID | `nomkapnpfhdajmeadfaebcegbdajoeje` (from the manifest `key`) |
| Published (Web Store) ID | **append to `LEXI_EXTENSION_IDS` once CWS assigns it, then deploy** |
| Connect page | `src/pages/extension/connect.tsx` |
| i18n strings | `src/locales/<lang>/misc.json` → `extensionConnect.*` (called as `t('misc.extensionConnect.…')`) |

> Extension IDs are **public**, not secrets — hardcoding them is fine and is the
> intended path. We target *all* known IDs and let whichever build is actually
> installed answer, so dev + published both work with no per-env var.

### 3c. Extension (baked into the ZIP)
| What | Where |
|------|-------|
| Control-plane URL | `src/config.js` → `RUNTIME_CONFIG_URL` (always `api.getlexi.io`) |
| Host allowlist | `src/config.js` → `CHANNEL_ALLOWLIST` (`*.getlexi.io`) |
| Build channel (dev only) | `src/config.js` → `BUILD_CHANNEL` (`staging` in source for unpacked dev; packagers rewrite → `prod`) |
| Channel cache/refresh | `src/background/channel-config.js` (`refreshChannelConfig` / `getActiveConfig`), cached in `chrome.storage` key `lexi_channel_config` |
| Store `host_permissions` | `api.getlexi.io` + `api-staging.getlexi.io` (both, so one ZIP serves both channels) |
| Manifest `key` (dev ID) | present in source (→ stable dev ID); **stripped** by the store packagers (CWS assigns the published ID) |

---

## 4. Secrets & keys (names only — never commit values)

| Secret (env var name) | Where stored | Purpose |
|-----------------------|--------------|---------|
| `API_KEY_ENCRYPTION_KEY` | backend env (Azure Container App config; local `.env`) | Fernet key + HMAC used to hash extension tokens before storage (same as `user__api_keys`) |
| `EXTENSION_TOKEN_TTL_DAYS` | backend env (default `90`) | Sliding expiry window for extension tokens |
| `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` | GitHub Actions secrets (frontend repo) | Vercel deploy from CI |
| Clerk keys (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`) | Vercel env (frontend) / backend env | Auth. Prod = `clerk.getlexi.io` (pk_live, SSO + email-OTP, password disabled); staging = pk_test dev instance |

**Token storage:** opaque tokens (`lexiext_…`) are handed to the extension once
and **only their HMAC hash** is stored — table `user__extension_tokens`
(`hashed_token` unique, `token_prefix` masked display, sliding `expires_at`,
`revoked_at` kill-switch). The plaintext token is never persisted server-side.

---

## 5. Deploy flows

### Backend (donna-backend)
Squash-merge `staging` → `main`, push, realign `staging` (see the repo's
`deploy-prod` skill). Azure Container Apps auto-builds `main`.
The channel flip in §1 is **not** a deploy — it's just an env-var update that
rolls a new revision in ~55s.

### Frontend (lexi-frontend)
CI = `.github/workflows/deploy-vercel.yml`:
- push to **`main`** → Vercel **production** (`--prod`) = `app.getlexi.io`
- push to **`staging`** → Vercel **preview**

So any connect-page / extension-ID change must land on **`main`** to reach
production.

### Extension (this repo → Chrome Web Store)
```bash
./scripts/package.sh          # → dist/lexi-for-chrome-<ver>.zip   (full, Agent Mode)
node scripts/build-lite.mjs   # → dist/lexi-for-chrome-lite-<ver>.zip (chat-only, fast review)
```
Both rewrite `BUILD_CHANNEL→prod`, set `host_permissions` to the two Lexi hosts,
drop the manifest `key` + the Anthropic host. Upload a ZIP in the CWS developer
dashboard. A code change to the extension itself **requires a new upload +
review** — but a *backend/frontend* change (channel flip, connect page, IDs)
does not.

---

## 6. CWS reviewer login

Point the channel at **staging** during review so reviewers use the Clerk
**dev** instance: any `…+clerk_test@…` email + the fixed OTP `424242` (no real
inbox, no password). Flip back to **production** for public users.

```bash
# during review
az containerapp update -n lexi-backend -g lexi-prod --set-env-vars LEXI_EXTENSION_CHANNEL=staging -o none
# after approval
az containerapp update -n lexi-backend -g lexi-prod --set-env-vars LEXI_EXTENSION_CHANNEL=production -o none
```

---

## 7. Common runbook tasks

**"Move the extension to production" / "to staging"** → §1 (one `az` command +
the `curl` verify).

**"Published build says extension-not-found"** → the store ID isn't in the
frontend target list. Add it to `LEXI_EXTENSION_IDS` in
`src/constants/env.constants.ts` (or set Vercel `NEXT_PUBLIC_LEXI_EXTENSION_ID`)
and push to **`main`**.

**"Connect page shows raw `extensionConnect.*` text"** → i18n keys must be
called with the `misc.` namespace: `t('misc.extensionConnect.…')`, strings in
`src/locales/<lang>/misc.json`.

**"Kill a specific device/token"** → set `revoked_at` on its
`user__extension_tokens` row (or the in-app session manager); the next request
401s immediately.

**Firewall for direct DB debugging** → add `harshit-YYYY-MM-DD` rule to the pg
server (staging rg `lexi-corpus-staging`, prod rg `lexi-prod`) when your IP
rotates.
