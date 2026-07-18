# Chrome Web Store Listing — Lexi for Chrome

This file is the CWS-ready source of truth for the store listing copy, the
Privacy Practices tab, and the per-permission justifications. Copy the
relevant section into the Developer Dashboard field it's labeled with.

---

## Two-track submission (read first)

We ship the same product in two build tracks. Submit them in this order:

1. **Submit the LITE build first** — `dist/lexi-for-chrome-lite-1.0.0.zip`
   (built by `node scripts/build-lite.mjs`). This is the **chat-only** variant:
   the "see + answer" product (explain clauses, flag risky terms, dates,
   summaries, Screenshot & ask) with **Agent Mode compiled out**. Its manifest
   declares **no `debugger`, `tabs`, or `<all_urls>` optional permissions** at
   all, so it stays in the Chrome Web Store's **fast automated-review lane**.
   Get the core product live and in users' hands quickly.

2. **Then submit the FULL build as a version update** —
   `dist/lexi-for-chrome-1.0.0.zip` (built by `scripts/package.sh`). This adds
   the off-by-default, per-site **Agent Mode** and therefore re-declares the
   `debugger` / `tabs` / `<all_urls>` **optional** permissions. Expect a
   **manual review** because of `debugger`; the per-permission justifications
   further down this file are written for exactly that review.

Both builds share one codebase. The only differences in the lite build are a
baked `AGENT_MODE_AVAILABLE = false` flag (which removes every agent-mode entry
point) and the trimmed manifest — the store title, description, and all listing
copy below apply verbatim to both. Which ZIP is which:

| ZIP | Build command | Agent Mode | Optional permissions | Review lane |
|---|---|---|---|---|
| `dist/lexi-for-chrome-lite-1.0.0.zip` | `node scripts/build-lite.mjs` | compiled out | none | fast / automated |
| `dist/lexi-for-chrome-1.0.0.zip` | `scripts/package.sh` | included (off by default) | `debugger`, `tabs`, `<all_urls>` | manual |

---

## Single purpose statement

> Lexi is an AI legal assistant for the web: it reads the legal document or
> page you're viewing and answers your questions about it (explain a clause,
> flag risky terms, extract dates, summarize a judgment) using your own
> Anthropic API key.

---

## Store title

**Lexi — The AI Operating System for Law**

## Category

Productivity

## Short description (CWS "Summary", 132-char limit)

> AI legal co-pilot in your side panel — explain clauses, flag risky terms,
> summarize judgments. Grounded, private. Not legal advice.

## Detailed description

> Lexi is the AI operating system for law, in your Chrome side panel —
> covering legal review, contract analysis, and legal drafting for
> whatever legal document you're looking at: a contract sent as a Google
> Doc, a scroll-forever Terms of Service, a lease, an NDA, a court
> judgment, or an e-filing form.
>
> **WHAT IT DOES (see + answer):**
> - **Explain this clause** — plain-English, jurisdiction-neutral, jargon
>   defined.
> - **Flag risky terms** — a ranked risk list (auto-renewal, broad
>   indemnity, arbitration/class-waiver, unilateral amendment, liquidated
>   damages) with severity and location.
> - **Key dates & obligations** — a structured, copyable table.
> - **Summarize a judgment or statute** — holding, reasoning, disposition,
>   authorities.
> - **What am I agreeing to?** — a consumer-friendly bottom line before you
>   click "I agree".
> - **Screenshot & ask** — capture a chart, table, or signature block and
>   ask about it.
>
> **PRIVATE BY DESIGN:** Lexi has no server of its own. The page content
> you ask about goes directly to the AI provider and nowhere else — never
> to Lexi, never to any third party. (Setup note: today that means adding
> your own Anthropic (Claude) API key in the options page; pick your model
> — Sonnet 5 by default, Opus 4.8 or Fable 5 for heavy analysis, Haiku 4.5
> for speed.)
>
> **OPTIONAL AGENT MODE:** for power users, Lexi can also take actions in
> the browser (click, type, fill forms) to help with tasks like completing
> a filing. This is OFF by default, must be enabled per-site, shows a clear
> "Lexi is acting" indicator plus Chrome's own debugging banner, and always
> asks before anything risky (submitting a form, navigating away, sending a
> message). It will never enter passwords or make payments.
>
> **PRIVACY:** When you ask a question, the page's text — and, only if you
> use Screenshot & ask, an image of the page — are sent to Anthropic's API
> using your key. Nothing goes to Lexi or any third party. Your API key is
> stored locally on your device only.
>
> Lexi is built by the team at getlexi.io. Lexi is not a law firm and does
> not provide legal advice; its output is informational only.

## Keywords

legal AI · legal review · contract review · contract analysis · legal
drafting · judgment summary · legal research · law OS / legal operating
system · terms of service · AI legal assistant · clause explainer · risk
flagging · Claude · BYOK · side panel · legal document analysis

---

## Guardrail-integrity statement (CWS Aug-1-2026 rule)

Lexi does not claim, imply, or attempt to bypass, jailbreak, or circumvent
the safety guardrails of any AI service (including Anthropic's). All model
calls go through Anthropic's standard, documented Messages API using the
user's own credentials and standard request parameters. Agent Mode's
confirmation gates and hard-blocked action list (below) are *additional*
restrictions layered on top of the underlying model's own behavior, never a
workaround of it.

---

## Data disclosure (prominent, user-facing — also shown in-product on the
## options/onboarding page)

> **What data is sent, when, and to whom.**
>
> When you ask Lexi a question, the current page's extracted text — and,
> only if you use the "Screenshot & ask" action, a downscaled image of the
> page — is sent directly to Anthropic's API (`api.anthropic.com`) using
> **your own** API key. No Lexi-operated server or any other third party
> ever receives this data; there is no Lexi backend in this product at all.
>
> If you enable the optional Agent Mode on a specific site, the same
> perception data (page text, the interactive-element index, and
> occasionally a screenshot) is sent to Anthropic to decide what action to
> take next; the action itself (a click, a keystroke, a scroll) is executed
> locally in your browser and never leaves your machine.
>
> Your API key, model preference, approval-mode setting, and per-site Agent
> Mode grants are stored only in `chrome.storage.local` on your device.
> Nothing is synced to a Lexi account (there is no Lexi account) and
> nothing is sent anywhere except the direct-to-Anthropic calls described
> above.
>
> Lexi collects no analytics, no telemetry, and no usage tracking of any
> kind.

---

## Agent Mode — off by default, per-site opt-in (data-use relevant excerpt)

> Agent Mode (the ability for Lexi to click, type, or navigate on your
> behalf) is **off by default on every site**. To use it, you must
> explicitly click "Enable agent actions on this site" for that specific
> site, which requests Chrome's `debugger` permission just for that
> session. While active, Chrome's own unsuppressable "this extension is
> debugging this browser" banner stays visible for the entire duration —
> this is deliberately embraced as the primary transparency signal — and
> Lexi additionally shows its own red "Lexi is acting — `<intent>`" bar
> with a persistent Stop button, plus a pulsing red border drawn on the
> page itself. Any of the following always require your explicit
> confirmation before Lexi proceeds, regardless of your chosen approval
> mode: submitting a form, navigating to a new domain, making a payment,
> sending a message, uploading a file, downloading a file, or deleting
> something. The following are hard-blocked in every mode — Lexi will stop
> and ask you instead: typing into password or payment-card fields,
> creating an account, completing a financial transaction, or permanently
> deleting something. Revoking a site's grant (from the options page) is
> immediate and also removes the associated Chrome permission if no other
> site still needs it.

---

## Trust signal — published attack-success-rate

> Like other AI browser agents, Lexi is exposed to prompt-injection attempts
> hidden in page content (e.g., invisible text instructing the model to
> "ignore previous instructions"). Lexi treats all page-derived content as
> untrusted data (wrapped and never followed as instructions) and screens
> for known injection patterns on the way in and scans its own output for
> leaked injected instructions on the way out. We publish a
> prompt-injection attack-success-rate measured against our own red-team
> evaluation harness as an ongoing trust signal, and treat this as
> mitigation, not elimination — Agent Mode should be treated as a beta
> capability and used with the confirmation gates on.

---

## Permissions — Privacy Practices tab justifications

Use these strings verbatim in the Developer Dashboard's per-permission
justification fields.

### Required permissions

**`sidePanel`**
> The entire product is a side-panel chat UI; this key hosts sidepanel.html.

**`activeTab`**
> Grants temporary, user-gesture-scoped access to only the tab the user is
> actively viewing so Lexi can extract that page's text to answer legal
> questions — no persistent all-sites access. This keeps the base extension
> in the Chrome Web Store fast-review lane.

**`scripting`**
> Injects the read-only text/element extraction content scripts into the
> active tab on user action (clicking a quick action or the toolbar icon)
> to read the page the user asked about. Never injected in the background.

**`storage`**
> Stores the user's own Anthropic API key (`chrome.storage.local` with
> `setAccessLevel TRUSTED_CONTEXTS` so content scripts can never read it),
> model preference, per-site agent-mode grants, and approval mode. Nothing
> is sent to any Lexi/third-party server.

**`alarms`**
> A 30s keepalive ping so the service worker survives a multi-step agent
> task; also powers optional scheduled re-checks. No background network
> activity.

**Host permission `https://api.anthropic.com/*`**
> Sends the user's own API key + the page content they asked about directly
> to Anthropic's API to generate the answer. No intermediary server.
> Disclosed prominently in-product and in the listing.

### Optional permissions (requested just-in-time, never at install)

**`debugger`**
> OPTIONAL, requested just-in-time only when the user explicitly enables
> 'agent actions' on a specific site. Uses the Chrome DevTools Protocol to
> send trusted click/type/scroll events so Lexi can help complete tasks
> like filling a court e-filing form. Chrome's visible debugging infobar
> stays up the entire time as the transparency signal; the session is
> detached immediately after each task. Off by default, per-site,
> revocable.

**`tabs`**
> OPTIONAL, requested only for the 'Compare with the other tab' feature so
> Lexi can read the title/URL of the user's other open tab to compare two
> contract drafts.

**Optional host permission `<all_urls>`**
> OPTIONAL, requested together with `debugger` only when the user enables
> agent actions on a site outside `activeTab` scope, so the agent can act
> across a multi-page legal portal flow the user initiated.

---

## Privacy Practices tab — quick-answer checklist

| CWS question | Answer |
|---|---|
| Does this item collect or use personal data? | No personal data is collected by Lexi. Page content and screenshots the user chooses to analyze are sent directly to Anthropic (a third-party AI provider) under the user's own API key; Lexi itself has no server and stores nothing about the user remotely. |
| Is data sold to third parties? | No. There is no data collection to sell. |
| Is data used for purposes unrelated to the item's core functionality? | No. The only data leaving the device (page text/screenshots, sent to Anthropic) is used exclusively to answer the user's question or perform the user-requested agent action. |
| Is data used to determine creditworthiness or for lending purposes? | No. |
| Certify compliance with the Developer Program Policies | Yes — no remote code execution beyond the declared Anthropic API host, no obfuscated code, single narrow purpose, minimal permissions requested (optional ones just-in-time), no guardrail-bypass claims. |

---

## Support / links

- Homepage: https://getlexi.io
- Privacy policy: see [`PRIVACY.md`](./PRIVACY.md) in this repository (link
  to its hosted/raw URL from the Developer Dashboard's Privacy Policy URL
  field once published).
- Support contact: via getlexi.io.
