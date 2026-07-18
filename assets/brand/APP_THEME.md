# Lexi App Design System (app.getlexi.io)

Source of truth: `donna-frontend` repo (the actual logged-in product — chat, review,
tracker, vault, etc.), read directly from code on 2026-07-18:
- `tailwind.config.js` (color/font/animation tokens)
- `src/styles/tailwind.css` (base layer, `@font-face`, utility layer)
- `src/styles/citationCheck.css` (a hand-rolled CSS-custom-property tone system —
  the closest thing this repo has to a formal design-token file)
- `src/components/Layout/Sidebar.tsx` (nav rail — the one place a dark surface is
  used deliberately)
- `src/components/Layout/Layout.tsx` (root font/background wrapper)
- `src/components/Button/Button.tsx`, `src/helpers/chat.ts` (button + chat-bubble
  recipes)
- `src/components/Dashboard/KPICard.tsx`, `src/components/Vault/StatusBadge.tsx`,
  `src/components/CitationCheck/atoms/VBadge.tsx` (card / badge recipes)
- `src/components/Messages/composer/ComposerBox.tsx` (the app's most refined,
  most "designed" surface — the chat input)

**This is NOT the same brand as `BRAND.md` in this folder.** `BRAND.md` documents
the marketing site (getlexi.io) — dark, near-black, teal-accent, editorial-serif.
This document is the **product UI** users actually live in after login — light,
slate/navy, Basier Circle, restrained ink-colored buttons. Chrome-extension
surfaces sit *inside the product*, so this file (not `BRAND.md`) is the correct
reference for the side panel's palette/typography.

**Important caveat on dark mode:** `donna-frontend` sets `darkMode: 'class'` in
Tailwind but the app is, in practice, **light-mode only** — a repo-wide search
turns up `dark:` variants in exactly 4 files (SuggestionCard, CommandPalette),
and no app-wide dark theme toggle exists. Dark values below for tokens that
have no real app equivalent are **derived** (clearly marked "derived") from the
one deliberately-dark surface that *does* exist in the product: the navy nav
rail (`brand.navy` family), which is always-dark regardless of OS theme.

---

## 1. Palette

### Light (the app's actual, default, and only fully-realized theme)

| Token | Hex | Where it's used in-app |
|---|---|---|
| Page background | `#F8FAFC` (`bg_color.page` = Tailwind `slate-50`) | `Layout.tsx` root wrapper background |
| Card / panel / composer surface | `#FFFFFF` | `KPICard`, `ComposerBox`, most cards |
| Neutral alt surface ("ink" ramp, used interchangeably with slate in places) | `#F5F6F8` → `#0E1117` (`ink-50`…`ink-900`) | occasional alt-neutral scale in `tailwind.config.js` |
| Border, default/primary | `#CBD5E1` (`slate-300` = `border_color.primary`) | card borders |
| Border, subtle/secondary | `#E2E8F0` (`slate-200` = `border_color.secondary`) | dividers, composer border |
| Text, primary | `#0F172A` (`slate-900` = `text_color.primary`) | headings, body |
| Text, secondary | `#475569` (`slate-600` = `text_color.secondary`) | labels, KPI eyebrow text |
| Text, tertiary/muted | `#64748B` (`slate-500` = `text_color.tertiary`) | timestamps, helper text |
| Text, inverted | `#FFFFFF` | text on navy rail / dark buttons |
| **Primary action / CTA** ("brand.action") | `#0F172A` → hover `#1E293B` | **This is the real primary button color** — 158 call sites (`bg-brand-action`), vs. only 10 for the legacy teal below. Deliberately ink/near-black, not colorful. |
| Chrome / nav rail (always dark) | `#0E1522` (`brand.navy`) | Sidebar background, fixed regardless of theme |
| Nav rail hover/active fill | `#232E40` (`brand.navy-light`) | active/hovered nav item pill |
| Nav rail border | `#2E3A4D` (`brand.navy-border`) | rail dividers, dark-surface card borders |
| Nav rail muted label | `#94A3B8` (`slate-400`) | inactive nav icon/label on navy |
| Legacy teal (declining use, being replaced by brand.action) | `#005564` → hover `#045B6C` | a handful of older buttons (`Button.tsx`'s `bg_color.button.primary`) |
| **Secondary accent — purple** (used for focus rings / selected-state icons, NOT primary CTAs) | 50 `#F6F7FE` · 500 `#9182DE` · 600 `#775AD8` · 700 `#6434D5` | `focus:ring-primary-500`, `text-primary-600` selected-check icons, language switcher |
| Message-box gray (legacy) | `#E7E7E6` (`bg_color.messagebox`) | older message input skin (superseded in most flows by the white `ComposerBox` recipe below) |

### Semantic / status tones (from `StatusBadge.tsx`, `VBadge.tsx` + `citationCheck.css`'s `[data-tone]` system — the app's real 3-tone success/warn/danger language)

| Tone | Badge fill / text (pill usage) | Solid "dot"/accent (citation-check tone vars) |
|---|---|---|
| Success / ok / ready | bg `#DCFCE7` (green-100) · text `#166534` (green-800) | `--vfg #15803D` `--vbg #F3FBF5` `--vborder #BBF0C9` `--vdot #22C55E` |
| Warn / pending | bg `#FEF9C3` (yellow-100) · text `#854D0E` (yellow-800) | `--vfg #B45309` `--vbg #FFFBEB` `--vborder #FDE79A` `--vdot #D97706` |
| Danger / failed / risk | bg `#FEE2E2` (red-100) · text `#991B1B` (red-800) | `--vfg #B91C1C` `--vbg #FEF2F2` `--vborder #FECACA` `--vdot #DC2626` |
| Neutral / checking / still-verifying | — | `--vfg #64748B` `--vbg #F8FAFC` `--vborder #E2E8F0` `--vdot #CBD5E1` |

### Dark (derived — no first-class app dark theme exists; anchored to the navy rail, the one real dark surface)

| Token | Hex | Basis |
|---|---|---|
| Background | `#0E1522` | = `brand.navy`, the app's one true dark surface |
| Surface (raised) | `#232E40` | = `brand.navy-light`, the rail's own "raised/active" fill |
| Border | `#2E3A4D` | = `brand.navy-border`, the rail's real divider color |
| Text primary | `#F1F5F9` (slate-100) | app's actual text-on-navy is white/near-white |
| Text muted | `#94A3B8` (slate-400) | app's actual muted-label-on-navy color (used verbatim on rail nav items) |
| Accent (secondary purple, lightened for dark bg) | `#ABA4EA` (primary-400) → strong `#C9C8F4` (primary-300) | same purple family, stepped lighter for contrast on navy — app has no literal dark-purple token, this is the natural extension of `colors.primary` |

---

## 2. Typography

- **Family:** `"Basier Circle"` — self-hosted, licensed webfont (`@font-face` in
  `tailwind.css`, files in `/fonts/BasierCircle-{Regular,Medium,SemiBold,Bold}.*`),
  weights 400/500/600/700. Applied app-wide via a single `font-basier-circle`
  class on the root layout wrapper (`Layout.tsx`) — i.e. it's an intentional
  whole-app override of Tailwind's default sans, not a per-component choice.
- **Fallback stack** (Tailwind `defaultTheme.fontFamily.sans`, used when Basier
  Circle hasn't loaded yet): `ui-sans-serif, system-ui, -apple-system, "Segoe UI",
  Roboto, "Helvetica Neue", Arial, sans-serif, "Apple Color Emoji"` — i.e.
  system-first, same family the extension already targets.
- **No custom monospace** anywhere in the app — no mono `@font-face`, no
  `font-mono` config override found.
- **Sizes/weights actually used**, smallest to largest:
  - `10–11.5px`, weight 600, uppercase, `tracking-wide` — micro labels, badges, "MORE" nav label, citation-check verdict pills
  - `12–13px` — chips, helper text, secondary buttons
  - `13–14.5px` — body copy, chat bubbles, composer text (compact mode)
  - `15–16.5px` — composer text (full mode), section subheads
  - `30px` (`text-3xl`), weight 600 (semibold) — KPI stat numbers
- Buttons: weight 500 (`font-medium`) as the default; weight 600 reserved for
  active/selected states and stat numbers.

---

## 3. Radii

No single global `--radius` var — the app uses Tailwind's default radius scale
directly, chosen per-component by "how pill-like should this feel":

| Tailwind class | px | Used for |
|---|---|---|
| `rounded-md` | 6px | dense form fields (e.g. inline question editors) |
| `rounded-lg` | 8px | standard inputs, small dropdown menus |
| `rounded-xl` | 12px | cards (`KPICard`), CommandPalette rows |
| `rounded-2xl` | 16px | modals, elevated panels, chat bubble body |
| `rounded-[22px]` / `rounded-[26px]` | 22 / 26px | **bespoke** — the message composer, a near-pill but not-quite-full radius that's the single most-designed surface in the app |
| `rounded-full` | 9999px | all buttons, all badges/chips, avatars, nav-rail active pills |

---

## 4. Shadows

Also no single global shadow token — but the composer (`ComposerBox.tsx`) has a
genuinely bespoke, two-layer, **slate-tinted** (not neutral-black) soft shadow
that reads as the app's real elevation language:

```css
/* resting */
box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 34px rgba(15, 23, 42, 0.06);
/* focus / hover (deeper + tighter contact shadow) */
box-shadow: 0 1px 2px rgba(15, 23, 42, 0.05), 0 18px 48px rgba(15, 23, 42, 0.10);
```

`rgba(15, 23, 42, …)` is literally `slate-900` — every shadow in the app is
tinted with the same ink color as the text/CTA, not a generic black. Elsewhere,
plain Tailwind `shadow-sm` / `shadow-md` / `shadow-2xl` cover menus and
dropdowns (`CommandPalette`).

---

## 5. Component recipes

**Button — primary**
`rounded-full`, `bg-brand-action` (#0F172A), `text-white`, `text-sm`,
`font-medium`, `px-4 py-2` (or `px-5 py-2.5` for larger CTAs),
`hover:bg-brand-action-hover` (#1E293B), global `press-effect`
(`active:scale(0.97)`, 150ms), `transition-colors`.

**Button — secondary/white**
`bg-white`, `border-2 border-border_color-secondary` (slate-200/300),
`text-text_color-primary`, `hover:bg-bg_color-button-secondary-hover`
(slate-100), same `rounded-full` + press-effect.

**Button — disabled**
`bg-gray-400`, `border-gray-400`, `cursor-not-allowed`, no hover/press feedback.

**Card**
`bg-white`, `rounded-xl` (12px), `border border-border_color-primary`
(slate-300), `p-5`, flat (no shadow) for static dashboard cards; the elevated
variant (modals, popovers) adds `shadow-2xl` or the bespoke composer shadow.

**Input / textarea — standard field**
`bg-white`, `rounded-lg` (8px) or `rounded-md` (6px), `border border-gray-300`,
`focus:ring-2 focus:ring-primary-500 focus:border-primary-500` (purple ring —
`@tailwindcss/forms` default blue is explicitly overridden to slate/purple
project-wide in `tailwind.css`'s base layer).

**Input — composer (the app's flagship input)**
`bg-white`, `rounded-[26px]` (`22px` compact), `border border-slate-200`,
resting soft double-shadow (§4), `focus-within:border-slate-300` +
deeper double-shadow — **no visible focus ring**, the border+shadow shift
carries the whole focus affordance. Placeholder `text-slate-400`.

**Chip / Badge — status pill**
`inline-flex items-center`, `rounded-full`, `px-3 py-1`, `text-xs font-medium`,
tri-tone semantic fill (see §1 semantic table): `bg-{tone}-100 text-{tone}-800`.

**Chip / Badge — fine-grained verdict pill** (citation-check system, the most
"designed" badge in the app)
`inline-flex`, `gap-6px`, `font-size:11.5px`, `font-weight:600`,
`padding: 3px 10px 3px 8px`, `border-radius: 9999px`,
`background: var(--vbg)`, `color: var(--vfg)`, `border: 1px solid var(--vborder)`
— tone vars swapped via a `[data-tone]` attribute (see semantic table above).

**Chat bubble — user message**
Avatar: `w-8 h-8 rounded-full`, `shadow-md`, `border-2 border-white`, colored
per-user via a deterministic pastel hash (`bg-blue-100 text-blue-600`, etc.).
Bubble: `px-4 py-3 rounded-2xl rounded-tl-sm shadow-sm`, same pastel-100
background family, `text-gray-800`, `text-sm leading-relaxed`.

---

## 6. Mapping — extension `--lexi-*` variables → app token

Read from `src/sidepanel/sidepanel.css`'s `:root` / dark blocks. Every
`--lexi-*` variable that exists today, and its nearest real app equivalent.
**Recommendation column says whether to swap the exact hex, or keep as-is
because it's already close enough that swapping is not worth the diff risk.**

| Extension var | Current (light / dark) | App equivalent | Recommendation |
|---|---|---|---|
| `--lexi-bg` | `#ffffff` / `#14141c` | Light: app card/panel white `#FFFFFF` (exact match already). Dark: no app equivalent exists; nearest real dark surface is `brand.navy` `#0E1522`. | Light: keep. Dark: optionally tighten `#14141c` → `#0E1522` to literally reuse the app's one dark surface. |
| `--lexi-surface` | `#f7f7fb` / `#1e1e29` | Light: `bg_color.page` `#F8FAFC` (near-identical lightness/hue already). Dark: `brand.navy-light` `#232E40` (the rail's own "raised" fill). | Light: keep (already correct hue family). Dark: swap `#1e1e29` → `#232E40` for a true app-derived raised-dark tone. |
| `--lexi-text` | `#1a1a2e` / `#ececf5` | Light: `text_color.primary` = `slate-900` `#0F172A`. Dark: app's text-on-navy is white/`slate-100` `#F1F5F9`. | Light: swap `#1a1a2e` → `#0F172A` (exact app ink). Dark: `#ececf5` is already effectively equivalent to `#F1F5F9` — keep. |
| `--lexi-muted` | `#6b6b85` / `#9a9ab4` | Light: `text_color.secondary`/`tertiary` = `slate-600` `#475569` / `slate-500` `#64748B`. Dark: rail's actual muted-label color `slate-400` `#94A3B8`. | Light: swap to `#64748B` (slate-500, matches most muted-copy usages). Dark: `#9a9ab4` is already almost identical to `#94A3B8` — keep. |
| `--lexi-border` | `#e4e4ef` / `#2c2c3b` | Light: `border_color.secondary` = `slate-200` `#E2E8F0` (near-identical). Dark: rail's real divider `brand.navy-border` `#2E3A4D`. | Light: keep (already matches). Dark: swap `#2c2c3b` → `#2E3A4D` — near-identical, but literally reuses the app token. |
| `--lexi-accent` | `#5b5bd6` / `#8b8bf0` | App's actual primary CTA is ink-slate (`brand.action` `#0F172A`), **not** purple — but the app *does* have a real secondary purple accent scale (`colors.primary`, used for focus rings/selected icons): 600 `#775AD8` (light), 400 `#ABA4EA` (derived dark, lightened for contrast). | **Recommended (low-risk):** swap to `#775AD8` / dark `#ABA4EA` — reuses tokens that literally exist in `tailwind.config.js` today, keeps the extension's distinct "AI assistant" purple personality separate from the app's neutral CTA buttons. **Alternative (bolder, more "part of the app"):** swap to `brand.action` `#0F172A`/hover `#1E293B` instead — makes extension buttons literally match app buttons, but loses the extension's current purple identity. |
| `--lexi-accent-strong` | `#4a3aff` / `#a5a5f7` | Light: `colors.primary` 700 `#6434D5`. Dark: `colors.primary` 300 `#C9C8F4`. | Pair with whichever accent option chosen above: purple path → `#6434D5`/`#C9C8F4`; navy path → `#1E293B` (light) with a light slate for dark hover, e.g. `#334155`. |
| `--lexi-accent-tint` | `#eeeefb` / `#21213a` | Light: `colors.primary` 50 `#F6F7FE` (near-duplicate already). Dark: no app token exists — derived low-alpha tint. | Light: swap to `#F6F7FE` (exact app token). Dark: no change needed — `#21213a` is a reasonable derived tint, or use `rgba(171,164,234,0.14)` over navy for a token-consistent look. |
| `--lexi-risk` | `#e5484d` (same in both themes — extension never overrides it in dark mode) | citation-check's real "danger" dot: `#DC2626` (Tailwind `red-600`). | Optional swap to `#DC2626` — nearly identical to current, but is the app's actual literal danger-dot value. |
| `--lexi-warn` | `#f5a623` (same in both themes) | citation-check's real "warn" dot: `#D97706` (`amber-600`), or Tailwind `amber-500` `#F59E0B` for a closer brightness match. | Optional swap to `#F59E0B` — closest in perceived brightness to current, while being a stock Tailwind amber the app's yellow-status pills approximate. |
| `--lexi-ok` | `#30a46c` (same in both themes) | citation-check's real "success" dot: `#22C55E` (`green-500`); vault "ready" badge text is `#166534` (`green-800`). | Optional swap to `#16A34A` (`green-600`) — sits between the two app greens and is closer to current `#30a46c`'s slightly muted tone than pure `#22C55E`. |
| `--lexi-r` | `10px` | App has no single global radius; closest common "card" radius is `rounded-xl` = `12px`; closest "input" radius is `rounded-lg` = `8px`. | Keep `10px` — it already sits neatly between the app's two most common radii and needs no change. |
| `--lexi-shadow-sm` | `0 1px 2px rgba(20,20,30,.06)` | App's composer resting shadow, first layer: `0 1px 2px rgba(15,23,42,.04)`. | Swap the rgba base from `20,20,30` → `15,23,42` (slate-900) to match the app's ink-tinted shadow language; opacity is already in the right range. |
| `--lexi-shadow-md` | `0 4px 16px rgba(20,20,30,.1)` (light) / `0 8px 24px rgba(0,0,0,.45)` (dark) | App's composer resting shadow, full two-layer form: `0 1px 2px rgba(15,23,42,.04), 0 12px 34px rgba(15,23,42,.06)`. | Recommended: adopt the full two-layer app shadow verbatim for light mode; keep the dark-mode value as-is (app has no dark elevation reference to derive from). |
| `--lexi-font` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif` | App's real font is licensed/self-hosted "Basier Circle" (cannot be bundled into the extension), falling back to Tailwind's default sans: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`. | Keep as-is — the extension's stack is already a close, license-safe approximation of the app's own fallback stack (both system-first, same ordering philosophy). No change needed. |
| `--lexi-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace` | App defines no custom mono stack anywhere. | Keep as-is — nothing to align to. |

### Summary of recommended hex changes (light theme; dark deltas noted inline above)

```css
:root {
  --lexi-text: #0f172a;       /* was #1a1a2e — app's slate-900 */
  --lexi-muted: #64748b;      /* was #6b6b85 — app's slate-500 */
  --lexi-accent: #775ad8;     /* was #5b5bd6 — app's primary-600 */
  --lexi-accent-strong: #6434d5; /* was #4a3aff — app's primary-700 */
  --lexi-accent-tint: #f6f7fe;   /* was #eeeefb — app's primary-50 */
  --lexi-shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04);
  --lexi-shadow-md: 0 1px 2px rgba(15, 23, 42, 0.04), 0 12px 34px rgba(15, 23, 42, 0.06);
  /* --lexi-bg, --lexi-border, --lexi-r, --lexi-font, --lexi-mono, --lexi-risk,
     --lexi-warn, --lexi-ok: already close enough — optional/no change */
}
```

```css
@media (prefers-color-scheme: dark) {
  :root {
    --lexi-surface: #232e40;    /* was #1e1e29 — app's brand.navy-light */
    --lexi-border: #2e3a4d;     /* was #2c2c3b — app's brand.navy-border */
    --lexi-accent: #aba4ea;     /* was #8b8bf0 — app's primary-400 */
    --lexi-accent-strong: #c9c8f4; /* was #a5a5f7 — app's primary-300 */
  }
}
/* mirror the same 4 lines into :root[data-theme="dark"] */
```

All of the above are **value-only** changes to existing `--lexi-*` custom
properties — no id/class renames, no new variables, nothing that the e2e
suite's DOM selectors depend on.
