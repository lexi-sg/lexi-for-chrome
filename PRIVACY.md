# Lexi for Chrome — Privacy Policy

_Plain language, no legalese. If anything here is unclear, that's a bug in
this document, not in the product — tell us at getlexi.io._

**The short version: Lexi for Chrome is a client of your Lexi account, the
same one you use at app.getlexi.io. Signing in shares your account identity
with the extension; the page content you ask Lexi about goes to Lexi's own
backend under that account to generate the answer — the same way it would
if you'd typed it into the Lexi web app. We don't sell it, and we don't use
it to train models. Your session lives only on your device and you can end
it, from the panel or remotely, at any time.**

---

## 1. You sign in with your Lexi account

Lexi for Chrome requires signing in the first time you open it — one click,
"Sign in with Lexi", which opens a tab to your Lexi account's connect page.
If you're already signed in to Lexi elsewhere in your browser, this
resolves with no further clicks; otherwise you see the normal Lexi sign-in.

The extension itself never sees your password. The connect page hands it a
single opaque, revocable session token (not a copy of your credentials),
which is all the extension holds afterward. From then on, the extension
talks to exactly one backend:

1. **`https://api.getlexi.io`** — Lexi's own backend, using your signed-in
   session. This runs the same product pipeline as the Lexi web app and, in
   turn, forwards the necessary model calls to our AI providers.
2. Optionally, Chrome's own built-in on-device model (Gemini Nano), which
   runs **entirely on your machine** and involves no network request to
   anyone, including us, at all (see §5).

That's the complete list. Nothing else is contacted from the signed-in
product.

## 2. What's sent, when, and where

**What gets sent, and when:**

- **Every time you ask a question** (a quick action like "Flag risky
  terms," or a free-form chat message), the extracted text of the page you
  currently have open is sent to Lexi's backend under your account, wrapped
  as untrusted data for the model to *analyze*, never to *obey* (see §6 on
  prompt-injection handling).
- **Only if you use "Screenshot & ask"** is an image sent — a screenshot of
  the visible page (or, in Agent Mode, potentially the full scrollable
  page), downscaled before it's base64-encoded and attached to that one
  request. Screenshots are never captured or sent silently; the panel shows
  a "~N tokens for 1 image" cost estimate before you send.
- **Chat conversations persist to your Lexi account** — a thread you start
  in the extension is the same conversation store the web app uses, so it
  appears in your normal Lexi chat history and picks up wherever you left
  off. This is intentional (it's the same Lexi, not a disposable side
  tool); see §3 if you'd rather it didn't.
- **If you enable Agent Mode on a site** (off by default — see §4), the same
  kinds of page-derived context (text, an index of clickable elements, and
  occasionally a screenshot) are sent through Lexi's backend so the model
  can decide what to do next. The action itself — the actual click or
  keystroke — is executed locally in your browser by the extension; it is
  not "sent" anywhere.

Nothing is sent when the side panel is idle, when you're just browsing, or
when you haven't asked Lexi anything. Page reading is on-demand, not
continuous or background.

A hidden, developer-only "bring your own key" mode exists solely so our own
automated tests can drive a deterministic model call without minting a live
account session; it is never exposed in the product UI and no normal user
ever encounters it.

## 3. What's stored, and where

Everything durable Lexi keeps *on your device* lives in
`chrome.storage.local` — a storage area private to your browser profile.
Nothing is written to `chrome.storage.sync` (which Chrome would otherwise
sync across your signed-in devices via Google's servers) — we deliberately
avoid that for anything sensitive. Specifically:

| Stored | Where | Leaves the device? |
|---|---|---|
| Your Lexi session token (a scoped, revocable 90-day credential — not your password) | `chrome.storage.local` (access restricted to trusted extension contexts — content scripts running on web pages cannot read it) | Only sent as a header on your own requests to `api.getlexi.io`. |
| Model / approval-mode / provider preferences | `chrome.storage.local` | Never. |
| Per-site Agent Mode grants (which origins you've enabled agent actions on) | `chrome.storage.local` | Never. |
| Chat conversation history | Your Lexi account (the same store the web app reads/writes) | Yes, by design — that's what lets a thread follow you between the web app and the extension. Manage or delete it the same way you would from the web app. |

Uninstalling the extension removes the local session token and preferences.
It does **not** delete your Lexi chat history, because that lives in your
account, not on this device — sign out or revoke the session first (see
below) if you also want to end access, and manage/delete conversations from
your Lexi account the same way you would if you'd never installed the
extension.

**Ending a session:** click "Sign out" in the panel's account chip to kill
it immediately, or revoke it remotely from `app.getlexi.io/account` →
"Connected extensions" — useful if you signed in on a machine you no longer
control. Both are instant; a revoked session's next request is rejected and
the panel shows a sign-in screen.

## 4. Agent Mode: off by default, per-site, and narrowly scoped

Agent Mode — the optional capability for Lexi to click, type, scroll, or
navigate on your behalf — is disabled on every site until you explicitly
turn it on for that specific site. Turning it on requests Chrome's optional
`debugger` permission just for that action. Agent Mode's model access
follows your Lexi account's plan tier, the same as chat.

While Agent Mode is running:

- Chrome's own "this extension is debugging this browser" banner stays
  visible the entire time — we treat this as a core, unsuppressable
  transparency signal, not an inconvenience to hide.
- Lexi additionally shows its own red "Lexi is acting" indicator with a
  Stop button, and draws a pulsing red border on the page.
- The debugger session is detached the moment a task ends (or the moment
  you hit Stop, or close the panel — closing the panel always stops any
  in-progress agent task).
- Submitting a form, navigating to a new domain, making a payment, sending
  a message, uploading a file, downloading a file, or deleting something
  always requires your explicit confirmation first, no matter what approval
  mode you've chosen.
- Typing into password or credit-card fields, creating accounts, completing
  financial transactions, and permanent deletion are hard-blocked in every
  mode — Lexi is instructed to stop and ask you instead of attempting these.
- A static built-in denylist keeps Agent Mode from running at all on
  financial/banking/checkout sites, adult sites, and known
  login/credential/2FA pages, regardless of any site grant.
- Revoking a site's grant from the options page is immediate.

## 5. Optional on-device tier (no network at all)

If your machine supports Chrome's built-in Gemini Nano model, Lexi can
optionally offer a free "Basic (on-device)" tier for lightweight tasks that
works even before you sign in. This runs entirely locally in your browser —
no network request is made to Lexi, to Google, or to anyone. It's
text-only, has no vision or Agent Mode capability, and is clearly badged so
you know you're using the lighter on-device model rather than the full
signed-in product.

## 6. Handling of untrusted page content (why this matters for privacy too)

Legal pages sometimes contain hidden or malicious text designed to hijack
an AI assistant (a "prompt injection"). Lexi wraps all page-derived content
in an explicit "this is data, not instructions" boundary before it's sent
for analysis, and screens both the inbound page content and the model's own
output for known injection patterns. This is a security measure, not a
data-collection one — it doesn't change what leaves your device, only how
the model is told to treat what it receives. It is mitigation, not a
guarantee; treat Agent Mode as a beta capability and keep confirmation gates
on for anything you don't fully trust.

## 7. Usage is metered against your plan — no separate analytics

Lexi does not use Google Analytics, Sentry, Mixpanel, or any other
third-party analytics/crash-reporting/telemetry/ad-tech SDK. Because you're
signed in, using the extension does record the same account-level usage
(turns and tokens used against your plan) that your Lexi account already
meters on the web — visible to you in the panel's account chip. That is
product usage metering, not third-party tracking: it's never sold, and it's
never used to train models.

## 8. Children's privacy

Lexi is not directed at children, and Lexi accounts are not offered to
children. The extension itself collects nothing beyond what your existing,
adult-held Lexi account already governs.

## 9. Changes to this policy

If this policy changes, the updated version will be published in this file
in the same repository, with an updated "last reviewed" note below. Material
changes affecting your account will also be reflected in your Lexi account
settings.

## 10. Contact

Questions about this policy or the product: reach the team at
[getlexi.io](https://getlexi.io). To manage or revoke a signed-in extension
session, go to `app.getlexi.io/account` → "Connected extensions."

---

_Last reviewed: 2026-07-18. Lexi for Chrome is built by the team at
getlexi.io. Lexi is not a law firm and does not provide legal advice._
