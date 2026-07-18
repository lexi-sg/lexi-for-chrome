# Lexi App Design System (app.getlexi.io) — v2 (CORRECTED)

**v2 supersedes v1 in full.** v1's headline recommendation — "use the purple/violet
`primary` scale (#775AD8) as the extension's accent" — was **wrong**, per direct
founder correction. This version re-derives the accent from the actual product
(chat UI + brand mark), explains exactly where the violet came from, and why it
was a bad signal to follow.

Re-verified 2026-07-18, same source repo (`donna-frontend`), but this time
tracing every color to (a) its **actual render frequency in the real chat page**
(`src/components/Chat/ChatView.tsx` → `MessagesList` → `RenderMessage` →
`EditableUserMessage`, **not** the unused legacy `ChatBubble.tsx`), and (b) **git
history** on `tailwind.config.js`, plus (c) pixel-sampling the two founder-supplied
reference images (`icons/icon128.png`, `assets/brand/ref-1.png`) and two more
marketing screenshots (`ref-2.png`, `ref-3.png`) already sitting in this folder.

---

## 0. The headline correction

**The purple is boilerplate scaffolding, not brand.** `git log -p` on
`tailwind.config.js` shows the `primary: {50…900}` violet scale (`600` =
`#775AD8`) has existed **since the repo's literal first commit** (`643de3a95
feat: init commit`) — it is a generic starter-kit color ramp that was never
replaced with real brand colors. In the current codebase it survives in exactly
**9 call sites**, all decorative/incidental, **none in the chat message list or
composer**:
- `LocaleDropdown.tsx` / `LanguageSwitcher.tsx` — a checkmark icon color
- `EditableQuestion.tsx` / `EnhancedEditableQuestion.tsx` — a hover icon tint
- `CaseRulesAdmin/*` — an internal admin tool, 3 files
- `Vault/UploadChooserDialog.tsx` — a focus ring

v1's own analysis *said* "the app's actual primary CTA is ink-slate, not
purple" — and then recommended purple anyway, reasoning that it'd give the
extension "a distinct AI-assistant personality." That reasoning is the bug:
it treated an unused legacy color ramp as if it were an intentional secondary
brand accent. It isn't. Per the founder: **stop treating #775AD8 as a Lexi
color at all.**

**The real brand accent is teal — and it genuinely does appear inside the
chat product**, just not on buttons. See §1.

---

## 1. What color is the chat, really? (three different teals + one navy — read this whole section, they are NOT interchangeable)

There are four distinct color families in play across Lexi surfaces. Conflating
them is exactly how v1 went wrong.

### (A) The chat product's functional/interactive color = **dark navy-slate, not teal**
Verified in `git log -p tailwind.config.js`: **two days before this analysis**
(commit `8e85ff504`, "deploy: ZIP download + batch translation…", 2026-07-16),
`brand.action` — the token behind every primary button, including the chat
send button (`SendStopButton.tsx`, `bg-brand-action`) — was changed **from
teal to navy**:
```diff
- action: '#005564',        // deep teal (the OLD brand.action)
- 'action-hover': '#045B6C',
+ action: '#0F172A',        // dark slate/navy (the CURRENT brand.action)
+ 'action-hover': '#1E293B',
```
And before *that* (an earlier commit), the token literally named `brand.teal`
was renamed/repointed to navy, with a comment in the config explaining it:
> "Navy is now the sole brand/chrome color (#0E1522) … Teal keys retained but
> repointed to navy so all existing `*-brand-teal*` utility classes remap with
> zero JSX edits."

**So: as of today, the color behind the send button, the sidebar rail, active
nav pills, and every `bg-brand-*`/`bg_color-button-primary` surface is navy
(`#0E1522` chrome / `#0F172A` action), not teal.** Message bubbles carry no
color at all (see §2) — they're neutral gray/white. This is the ground truth
for "what accent does the chat UI's *chrome* use": none, functionally — it's
achromatic ink/slate.

### (B) The brand mark that **literally renders inside the chat welcome screen** = teal `#045B6C`
This is the piece v1 missed by reading the wrong avatar component. The real
welcome/greeting screen users see before their first message
(`src/components/Chat/GreetingHero.tsx`) renders:
```tsx
<img src="/img/logos/lexi-mark-teal.png" alt="Lexi" ... />
```
Pixel-sampled: **solid `#045B6C`, no other colors, no gradient** (14,641/14,641
opaque pixels are that exact value). The same file is reused in
`Home/NewUserHome.tsx`'s "Ask Lexi" badge pill (a small `w-3 h-3` teal mark next
to badge text). This is the *only* color asset that appears directly, verbatim,
inside the logged-in product's chat/home screens outside of neutrals — and it's
teal, confirming the founder's instinct. (Aside: `NewUserHome.tsx` names its own
badge-text color constant `BRAND_TEAL` — but sets it to `'#0E1522'`, i.e. navy.
That's a leftover-naming bug from the same teal→navy rename in (A); it's a good
illustration of exactly how a naive grep for "teal" in this codebase misleads
you into navy. Don't repeat that mistake.)

The Chrome extension's own `icons/icon128.png` (founder-supplied) samples to
the **identical** `#045B6C` (dominant pixel `(4, 91, 108)` across the solid
background). Extension logo and in-app greeting mark are the same teal,
literally the same hex, not just "similar."

### (C) The marketing site (getlexi.io, `ref-1/2/3.png`) = a brighter teal-green accent, ~`#24CDA5`
Pixel-sampled from the "● PROVEN RESULTS" / "● CLIENT ONBOARDING" / "● DRAFTING
& REVIEW" section-eyebrow dots in `ref-2.png`/`ref-3.png`: solid **`(36, 205,
165)` ≈ `#24CDA5`** (a vivid teal-green, distinct from both the dark logo teal
and any Tailwind stock teal/emerald shade — it's a bespoke marketing-site
token, not present in `donna-frontend`'s own config; that site is a separate
repo/theme per the comment in `tailwind.config.js`: *"#025D6C used in
lexi-landing-page-v2"*). `ref-1.png` (the page's very top, above the fold) is
mid-scroll/hero-only and shows no accent dot in frame — the teal dots appear
further down the same page, which is why a single above-the-fold screenshot
alone under-reports it.

### (D) Historical brand teal (pre-navy-migration), still in git history
Before the navy migration, this exact repo's `brand` token block read:
```js
teal: '#045B6C',
'teal-hover': '#034552',
'teal-tint': '#B2DFE5'
```
Notice **(B) and (D) are the same base hex** — `#045B6C` is not a one-off; it's
the deliberate, designed brand teal this whole product used before the navy
pivot, and it's the same value baked into the current extension icon.

### Bottom line
| Family | Hex | Where it actually lives today |
|---|---|---|
| Chat chrome / CTAs (current) | `#0E1522` navy · `#0F172A` action | send button, sidebar, active pills — **not teal, not purple** |
| **Brand teal (logo/mark, in-chat)** | **`#045B6C`** | GreetingHero mark, "Ask Lexi" badge icon, extension's own `icon128.png` |
| Marketing accent (bright teal-green) | `#24CDA5` (sampled) | getlexi.io section-eyebrow dots (separate repo/theme) |
| Legacy/scaffolding — **not brand** | `#775AD8` violet | 9 incidental call sites, present since init commit, **do not use** |

---

## 2. Chat layout recipes (the REAL components — corrected from v1)

v1 sourced "chat bubble" styling from `src/components/Chat/ChatBubble.tsx` —
**this component is not used by the actual chat page.** It's dead-ish legacy
code only wired into `src/pages/meetings/[id].tsx`. The real chat render tree,
confirmed via `ChatView.tsx → MessagesList.tsx → RenderMessage.tsx →
EditableUserMessage.tsx`, is materially different:

- **No avatars at all**, for either user or assistant. (v1 incorrectly
  documented a pastel-hashed `w-8 h-8` circular initials avatar — that's the
  unused `ChatBubble.tsx`/`createUserMessage()` recipe, real chat has none.)
- **User message**: flat bubble, right-aligned, `max-w-[70%]`, classes
  `bg-bg_color-messagebox mr-2 ml-auto px-4 py-2.5 rounded-2xl` where
  `bg_color.messagebox = #e7e7e6` (flat neutral gray, **not** a brand color,
  **not** teal/navy/purple). Text `text-base`, markdown-rendered
  (`UserMessageMarkdown`). Hover-reveal action row (copy / save-as-template /
  edit / timestamp+sender) sits absolutely-positioned below the bubble,
  `opacity-0 group-hover:opacity-100`.
- **Assistant message**: **no bubble background at all** — `text-gray-800`,
  left-aligned, `w-full max-w-[85%]`, small `pl-4` offset (in place of an
  avatar gutter). Content renders through `BlockRenderer` (the v2 block-stream
  renderer — text/thinking/tool/artifact/citation blocks), not a plain markdown
  string. Feedback row (copy/regenerate/sources chip) below, only once
  streaming finishes.
- **Streaming/loading cue**: three small pulsing gray dots
  (`bg-gray-400 animate-pulse`, staggered 150ms), not a spinner or colored
  indicator.
- **Spacing**: `mb-4` between messages, max content width
  `max-w-4xl`→`2xl:max-w-6xl`, `pt-8` top padding on the whole list.
- **Radius**: bubbles `rounded-2xl` (16px); the composer uses a bespoke
  `rounded-[26px]` / `rounded-[22px]` compact — the single most "designed"
  radius in the app.
- **Font sizes**: user/assistant body `text-base` (16px)/`text-sm` in older
  paths; composer textarea `text-[16.5px]` full / `text-[14.5px]` compact;
  micro chip/badge text `13px`; section-eyebrow eyebrow-style labels
  `10–11.5px` uppercase.
- **Suggestion chips** (`SuggestionChips.tsx`, shown on the empty/welcome
  chat state): plain outline pills, `rounded-full border border-slate-200
  bg-white px-[13px] py-[7px] text-[13px] text-slate-600`, icon
  `text-slate-400`, hover → `border-slate-300 text-slate-900 shadow-sm`. **No
  teal, no purple, no colored dot** — fully neutral, unlike the marketing
  site's colored-dot eyebrow style in §1(C).
- **Composer** (`ComposerBox.tsx`, the app's most refined surface):
  `bg-white`, border `border-slate-200`, bespoke two-layer slate-tinted shadow
  (`rgba(15,23,42,...)` both layers — i.e. shadow color = the same ink as
  `brand.action` text, not generic black), `focus-within` deepens the shadow
  and darkens the border — **no visible focus ring**, the shadow/border shift
  *is* the focus affordance. Textarea `placeholder:text-slate-400`.
- **Send/stop button** (`SendStopButton.tsx`): circular `rounded-full`,
  `bg-brand-action` (`#0F172A`) → `hover:bg-brand-action-hover` (`#1E293B`),
  disabled state `bg-slate-200 text-slate-400`. This is the one place a solid
  color fill appears in the whole composer, and it is navy, confirmed.
- **Mode/model picker** (`ModeButton.tsx`): borderless, "Claude-style" —
  `text-slate-600`, active/open state `bg-slate-100 text-slate-900`. No accent
  color anywhere in this control either.

**Net read on the real chat UI's own palette: it is almost entirely
achromatic** (white/slate/gray/navy-ink), by deliberate design — the *only*
splash of color a user sees in the whole chat surface is the small teal Lexi
mark in the empty-state greeting (§1B). Bear this in mind for §4's
recommendation: pixel-matching "how the app does chats" for *layout* means
neutral/flat/no-avatar/no-bubble-color — it does **not** mean the chat is
teal-themed internally.

---

## 3. Neutrals, dark values, typography, radii, shadows (unchanged from v1 — these were correct)

### Light (the app's actual, default, and only fully-realized theme)
| Token | Hex | Where |
|---|---|---|
| Page background | `#F8FAFC` (`slate-50`) | `Layout.tsx` root |
| Card/panel/composer surface | `#FFFFFF` | composer, cards |
| Border, primary/secondary | `#CBD5E1` / `#E2E8F0` (`slate-300`/`200`) | card + composer borders |
| Text primary/secondary/tertiary | `#0F172A` / `#475569` / `#64748B` (`slate-900/600/500`) | headings/body / labels / timestamps |
| Text inverted | `#FFFFFF` | on navy rail, on `brand-action` buttons |
| User-message bubble | `#E7E7E6` (`bg_color.messagebox`) | flat neutral, not brand-colored |

### Dark (still **derived** — `donna-frontend` is light-mode-only in practice; `darkMode:'class'` exists in Tailwind config but only 4 files anywhere in the repo use a `dark:` variant, none of them accent-colored — `SuggestionCard.tsx`, `CommandPalette.tsx`, and two `Editor` files, all plain gray shifts)
| Token | Hex | Basis |
|---|---|---|
| Background | `#0E1522` | `brand.navy`, the one real always-dark surface (sidebar) |
| Raised surface | `#232E40` | `brand.navy-light` |
| Border | `#2E3A4D` | `brand.navy-border` |
| Text primary/muted | `#F1F5F9` / `#94A3B8` | rail text-on-navy (real, verbatim) |

### Semantic tones (unchanged — real, from `StatusBadge`/`VBadge`/`citationCheck.css`)
| Tone | Pill | Dot |
|---|---|---|
| Success | bg `#DCFCE7` text `#166534` | `#22C55E` |
| Warn | bg `#FEF9C3` text `#854D0E` | `#D97706` |
| Danger | bg `#FEE2E2` text `#991B1B` | `#DC2626` |
| Neutral | — | `#CBD5E1` |

### Typography
`"Basier Circle"` self-hosted webfont, app-wide via one `font-basier-circle`
class on the root layout; fallback `ui-sans-serif, system-ui, -apple-system,
"Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. No custom monospace
anywhere.

### Radii
`rounded-md`(6)/`rounded-lg`(8) inputs · `rounded-xl`(12) cards ·
`rounded-2xl`(16) bubbles/modals · `rounded-[22–26px]` composer (bespoke) ·
`rounded-full` buttons/badges/pills.

### Shadows
Composer's bespoke ink-tinted double shadow:
```css
/* resting */   0 1px 2px rgba(15,23,42,.04), 0 12px 34px rgba(15,23,42,.06);
/* focus/hover */ 0 1px 2px rgba(15,23,42,.05), 0 18px 48px rgba(15,23,42,.10);
```

---

## 4. Recommendation for the extension

**Do not use `#775AD8` (violet) anywhere.** It is boilerplate scaffolding, not
a Lexi color, confirmed by both usage-site audit and git blame to its origin.

**Do use teal — anchored on `#045B6C`, the exact hex shared by:**
1. the extension's own current icon (`icons/icon128.png` samples to this value
   exactly),
2. the teal mark that renders live inside the in-app chat welcome screen
   (`lexi-mark-teal.png` in `GreetingHero.tsx` / `NewUserHome.tsx`'s "Ask Lexi"
   badge),
3. this repo's own pre-migration `brand.teal` token (before the Jul-16 navy
   pivot) — i.e. this is a *designed*, historically-stable brand teal, not a
   one-off asset color.

Recommended token values (reusing the repo's own historical teal ramp, which
still exists verbatim in git history — nothing invented):
```css
:root {
  --lexi-accent: #045b6c;        /* was #5b5bd6 → do NOT use #775ad8 either */
  --lexi-accent-strong: #034552; /* historical brand.teal-hover, verbatim */
  --lexi-accent-tint: #b2dfe5;   /* historical brand.teal-tint, verbatim */
}
@media (prefers-color-scheme: dark) {
  :root {
    /* Lift to the marketing site's brighter teal-green for dark-surface
       contrast — this exact value is already proven to read cleanly on a
       near-black background (sampled straight off getlexi.io's own dark
       hero/section dots, ref-2.png/ref-3.png). */
    --lexi-accent: #24cda5;
    --lexi-accent-strong: #1aab88; /* darkened ~15% for a hover/pressed step */
    --lexi-accent-tint: rgba(36, 205, 165, 0.16);
  }
}
/* mirror into :root[data-theme="dark"] to match the toggle-stamped attribute */
```

**Layout/chrome should still mirror the *real* chat recipe from §2** — flat
neutral message surfaces, no avatars, no colored bubbles, ink-tinted shadows,
navy/slate neutrals, `rounded-2xl`/pill radii — teal shows up only where the
app itself puts brand color: the logo mark and small accent touches (links,
focus rings, active/selected chip state, the send button if you want a
branded touch the in-app version currently doesn't have). Don't tint the
message bubbles or the whole surface teal — the real product doesn't, and
doing so would make the extension look less like the app, not more.

All of the above are value-only token changes — no id/class renames, nothing
the e2e suite's DOM selectors (`.lexi-risk-item`, `.lexi-confirm-card`,
`#mode-agent-btn`, etc.) depend on.
