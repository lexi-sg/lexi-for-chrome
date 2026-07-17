# Lexi for Chrome — Privacy Policy

_Plain language, no legalese. If anything here is unclear, that's a bug in
this document, not in the product — tell us at getlexi.io._

**The short version: everything stays on your device except the exact page
content you ask Lexi about, which goes straight to the AI provider you
configured, using a key that's yours, not ours. There is no Lexi server in
this product. We don't collect analytics. We don't sell or share anything,
because we don't have anything to sell — we never see your data at all.**

---

## 1. There is no Lexi server

Lexi for Chrome does not talk to any backend operated by Lexi or getlexi.io.
There is no account to create, no sign-in, and no Lexi-run API in the
request path. The only two network destinations this extension ever talks
to are:

1. **`https://api.anthropic.com`** — the AI provider whose model you
   configured with your own API key (see §2).
2. Optionally, Chrome's own built-in on-device model (Gemini Nano), which
   runs **entirely on your machine** and involves no network request to
   anyone, including us, at all (see §5).

That's the complete list. Nothing else is contacted.

## 2. Everything sent to an AI provider is sent using your key, at your request

Lexi is "bring your own key" (BYOK). When you paste an Anthropic API key
into the options page, it is stored only in `chrome.storage.local` on your
device. Every request Lexi makes to Anthropic uses that key, and every
token — input and output — is billed by Anthropic directly to your
account. We never see your key, and we have no visibility into your usage
or spend.

**What gets sent, and when:**

- **Every time you ask a question** (a quick action like "Flag risky
  terms," or a free-form chat message), the extracted text of the page you
  currently have open is sent to Anthropic's Messages API, wrapped as
  untrusted data for the model to *analyze*, never to *obey* (see §6 on
  prompt-injection handling).
- **Only if you use "Screenshot & ask"** is an image sent — a screenshot of
  the visible page (or, in Agent Mode, potentially the full scrollable
  page), downscaled before it's base64-encoded and attached to that one
  request. Screenshots are never captured or sent silently; the panel shows
  a "~N tokens for 1 image" cost estimate before you send.
- **If you enable Agent Mode on a site** (off by default — see §4), the same
  kinds of page-derived context (text, an index of clickable elements, and
  occasionally a screenshot) are sent to Anthropic so the model can decide
  what to do next. The action itself — the actual click or keystroke — is
  executed locally in your browser by the extension; it is not "sent"
  anywhere.

Nothing is sent to Anthropic (or anyone) when the side panel is idle, when
you're just browsing, or when you haven't asked Lexi anything. Page reading
is on-demand, not continuous or background.

## 3. What's stored, and where

Everything durable Lexi keeps lives in `chrome.storage.local` — a storage
area private to your browser profile on your device. Nothing is written to
`chrome.storage.sync` (which Chrome would otherwise sync across your signed-in
devices via Google's servers) — we deliberately avoid that for anything
sensitive. Specifically:

| Stored | Where | Leaves the device? |
|---|---|---|
| Your Anthropic API key | `chrome.storage.local` (access restricted to trusted extension contexts — content scripts running on web pages cannot read it) | Only sent as a header on your own requests to `api.anthropic.com`. |
| Model / approval-mode / provider preferences | `chrome.storage.local` | Never. |
| Per-site Agent Mode grants (which origins you've enabled agent actions on) | `chrome.storage.local` | Never. |
| Chat conversation history | Kept in the side panel's in-memory state for the current session | Only the messages you send are relayed to Anthropic as part of answering your question; nothing is persisted to a Lexi server because there is no Lexi server. |

Uninstalling the extension removes all of this. There is nothing left
behind anywhere else, because it was never anywhere else to begin with.

## 4. Agent Mode: off by default, per-site, and narrowly scoped

Agent Mode — the optional capability for Lexi to click, type, scroll, or
navigate on your behalf — is disabled on every site until you explicitly
turn it on for that specific site. Turning it on requests Chrome's optional
`debugger` permission just for that action.

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

If your machine supports Chrome's built-in Gemini Nano model and you
haven't added an Anthropic key yet, Lexi can optionally offer a free,
keyless "Basic (on-device)" tier for lightweight tasks. This runs entirely
locally in your browser — no network request is made to Anthropic, to
Google, or to anyone. It's text-only, has no vision or Agent Mode
capability, and is clearly badged so you know you're using the lighter
on-device model rather than Claude.

## 6. Handling of untrusted page content (why this matters for privacy too)

Legal pages sometimes contain hidden or malicious text designed to hijack
an AI assistant (a "prompt injection"). Lexi wraps all page-derived content
in an explicit "this is data, not instructions" boundary before it's sent
to the model, and screens both the inbound page content and the model's
own output for known injection patterns. This is a security measure, not a
data-collection one — it doesn't change what leaves your device, only how
the model is told to treat what it receives. It is mitigation, not a
guarantee; treat Agent Mode as a beta capability and keep confirmation gates
on for anything you don't fully trust.

## 7. No analytics, no telemetry, no tracking

Lexi does not use Google Analytics, Sentry, Mixpanel, or any other
analytics/crash-reporting/telemetry SDK. There is no error reporting that
phones home. There is no tracking pixel, no fingerprinting, and no
advertising integration of any kind. We have no way to know how many people
use Lexi, what they ask it, or how they configure it — because none of that
is ever transmitted to us.

## 8. Children's privacy

Lexi is not directed at children and we do not knowingly collect any
information relating to children — consistent with §7, we don't collect
information relating to *anyone*, of any age, since we operate no backend.

## 9. Changes to this policy

If this policy changes, the updated version will be published in this file
in the same repository, with an updated "last reviewed" note below. Because
there is no Lexi account or telemetry, we cannot notify you individually;
please check back here if you want to review changes.

## 10. Contact

Questions about this policy or the product: reach the team at
[getlexi.io](https://getlexi.io).

---

_Last reviewed: 2026-07-18. Lexi for Chrome is built by the team at
getlexi.io. Lexi is not a law firm and does not provide legal advice — see
the in-product disclaimer on every answer._
