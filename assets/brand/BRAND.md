# Lexi Visual Brand Brief

Source of truth: **live site (https://getlexi.io) as captured 2026-07-18**, cross-checked
against `lexi-landing-page-v2` repo code. Where the two differed, the live site won (see
"Repo vs. live" note at the bottom). Reference captures for this brief:
`ref-1.png` (hero, top of page), `ref-2.png` (stats + onboarding section),
`ref-3.png` (drafting/product feature section) — all in this folder, 1440x900.

---

## 1. Palette (exact hex / rgba)

| Token | Value | Use |
|---|---|---|
| `--color-primary` (teal/mint) | `#24CFA6` | Brand accent — CTA highlight dot, success states, glow. **Sparingly**, as an accent, never a fill for large areas. |
| `--color-primary-hover` | `#1EB893` | Hover state of the teal accent |
| `--color-primary-light` | `rgba(36, 207, 166, 0.10)` | Faint teal halo / inset glow behind cards |
| `--color-primary-glow` | `rgba(36, 207, 166, 0.30)` | Bloom/blur glow effects |
| `--bg-primary` / `--bg-secondary` | `#0A0A0A` | Page background — near-black, not pure `#000` |
| `--color-dark` | `#000000` | True black, used only for isolated flat panels (e.g. ProductShowcase panel) |
| `--bg-card` | `#060606` | Card surfaces, marginally darker than page bg |
| `--bg-card-hover` | `#0C0C0C` | Card hover state |
| `--bg-elev` / `--bg-elev-hover` | `#1A1A22` / `#20202A` | Elevated chips/toasts, slightly blue-black |
| `--color-light` | `#F9F9F9` | Off-white (rarely used; site is dark-mode-first) |
| `--color-white` | `#FFFFFF` | Primary CTA button fill, headline text |
| `--text-primary` | `#FFFFFF` | Headlines, primary copy |
| `--text-secondary` / `--color-neutral` | `#969696` | Body copy on dark, secondary labels |
| `--text-muted` | `#7A7F88` (component-local `text-muted` var also seen as `#6B7280`) | Captions, stat labels, footnotes |
| `--border-color` | `rgba(255,255,255,0.10)` | Card borders, dividers |
| `--border-subtle` | `rgba(255,255,255,0.05)` | Faint internal dividers |
| `--glass-bg` | `rgba(255,255,255,0.03)` | Glass-morphism panel fill |
| `--glass-border` | `rgba(255,255,255,0.08)` | Glass-morphism panel border |
| `--button-primary-bg` / `--button-primary-text` | `#FFFFFF` / `#000000` | Primary pill CTA ("Book a Demo", "Schedule a Call") |
| `--button-secondary-bg` / `--button-secondary-text` | `rgba(255,255,255,0.08)` / `#FFFFFF` | Secondary/ghost pill buttons |
| Error red (toast only) | `#F56565` | Error toast accent — not a marketing color |

**There is no colorful gradient identity.** Lexi's palette is monochrome (black →
off-white/grey) with **one** accent color, teal-mint `#24CFA6`, used only as a small dot,
thin glow, or icon-fill accent — never as a background wash or big gradient blob. This is
the single most distinctive trait vs. typical "AI startup" gradients (purple/blue blobs):
**Lexi is deliberately restrained, almost editorial-black**, like a law journal, not a SaaS
demo.

---

## 2. Typography

| Role | Family | Notes |
|---|---|---|
| Display / headings | **"Lovato"** (custom, self-hosted — `public/fonts/lovato/Lovato Regular.woff2`, also Light/Bold/Demi/Black weights exist as `.otf`) | **This is a serif display face** — confirmed visually on the live site (serif feet on "T", "l", flared apex on "A"). All `h1`/`h2` headings and the big stat numbers (`4,047,219+`) use it at `font-weight: 400`, `line-height: 110-115%`, `letter-spacing: -0.02em`. |
| Body / UI | **Inter** (Google Font, `next/font/google`) | All paragraph copy, labels, buttons, nav. Weight 400-500. Body line-height 160-170%, letter-spacing -0.01em. |
| RTL (Arabic locales only) | IBM Plex Arabic | Not relevant for English promo assets. |

**Self-contained HTML fallback** (no font files needed to be embedded, since the Chrome
Web Store assets don't have to pixel-match the live font license):
- Headline stack: `"Georgia", "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif`
  — a warm, humanist serif with similar restrained elegance to Lovato. Avoid anything
  slab or overly geometric (e.g. avoid Times New Roman's very high contrast).
- Body stack: `-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif`
  — Inter is very likely present as a system/web font already if the design tool renders
  it; otherwise this fallback chain reads nearly identically at UI sizes.
- If exact Lovato is wanted and embeddable: `public/fonts/lovato/Lovato Regular.woff2`
  (and Bold/Demi/Black `.otf`, ~free to base64 — Regular woff2 is small) live in the
  landing-page-v2 repo and can be inlined as a `data:` URI `@font-face` in the promo
  HTML if a designer wants pixel-perfect serif headlines.

**Heading scale** (desktop, from Hero.tsx / section components):
- Hero H1: `text-4xl sm:text-5xl md:text-6xl lg:text-7xl` (~36px → 72px), weight 400,
  line-height 110%, letter-spacing -0.02em, centered.
- Section H2: `text-3xl md:text-4xl lg:text-5xl` (~30px → 48px), same weight/tracking.
- Stat numbers: `text-3xl sm:text-4xl lg:text-5xl` in Lovato, weight 400.
- Section eyebrow/label: `text-xs font-medium tracking-widest uppercase`, Inter, color
  `--label-text` (`#969696`), preceded by a small teal dot (`--accent-dot: #24CFA6`,
  `w-2 h-2 rounded-full`).

---

## 3. Backgrounds & gradient recipes

- **Hero background**: photographic — a moody, warm-lit law-library / bookshelf photo
  (`/bg/hero.jpg`), covered by a vertical dark overlay:
  `linear-gradient(to bottom, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.5) 50%, rgba(0,0,0,0.8) 100%)`,
  then a bottom fade into the page's flat `#0A0A0A` to blend into the next section:
  `linear-gradient(to bottom, transparent 0%, #0A0A0A 100%)`.
  This is the ONLY place a photographic image appears full-bleed; every section below it
  is flat `#0A0A0A`.
- **All other sections**: flat `background: #0A0A0A` (var `--bg-primary`). No gradient
  meshes, no colorful blobs, no glassmorphic full-page washes.
- **Card fills**: subtle only — `rgba(255,255,255,0.02)` to `rgba(255,255,255,0.05)`,
  i.e. barely-there frosted panels on the black page, with a 1px border at
  `rgba(255,255,255,0.08-0.10)`.
- **Dividers**: thin 1px lines that fade at both ends —
  `linear-gradient(to right, transparent, rgba(255,255,255,0.10), transparent)` (or
  `to bottom` for vertical dividers) — used between stat columns and benefit items,
  never a solid line.
- **Glow/accent**: on hover or success states only, a soft teal glow —
  `rgba(36,207,166,0.3)` blurred, or an `inset 0 0 0 1px rgba(36,207,166,0.1)` halo. Used
  extremely sparingly (e.g. one card, one toast) — never as a page-wide background.

---

## 4. Component recipes

**Primary CTA button** (`Book a Demo`, `Schedule a Call`, `Schedule a Demo`):
```css
background: #FFFFFF;
color: #000000;
border-radius: 9999px; /* full pill */
padding: 0.5rem 1.25rem; /* py-2 px-5, scales up to py-2.5 px-6 on larger screens */
font-family: Inter;
font-weight: 500;
font-size: 0.75rem–0.875rem; /* text-xs/sm */
transition: all 0.3s cubic-bezier(0.25,0.1,0.25,1);
/* hover */ transform: scale(1.05) translateY(-2px);
/* active */ transform: scale(0.97);
```
Never colored (never teal-filled) — the primary CTA is always a stark white pill on
black, which is what makes it pop against the otherwise monochrome page.

**Secondary/nav pill buttons**: `background: rgba(255,255,255,0.08)`, `color: #FFFFFF`,
same pill radius, used for secondary nav items.

**Navbar**: floating rounded pill/rounded-rectangle bar, `background: rgba(255,255,255,0.05)`
with `backdrop-filter: blur(24px)` (Tailwind `backdrop-blur-xl`), `border-radius: 0.75rem`
(mobile) scaling to fully transparent/borderless on desktop nav items — logo mark + "Lexi"
wordmark left, nav links center, white pill CTA right.

**Section eyebrow/label** ("PROVEN RESULTS", "WHY LAW FIRMS CHOOSE LEXI"):
small teal dot (`8px`, `#24CFA6`, `border-radius: 999px`) + uppercase Inter label,
`letter-spacing: 0.1em` (`tracking-widest`), color `#969696`, size `12px`.

**Stat blocks** (used in Credibility section, 2x2 grid): big Lovato serif number
(e.g. `5,000,000+`), small Inter muted label underneath, separated by faint 1px fading
dividers (see above), no card chrome/border around each stat — just whitespace + dividers.

**Feature/benefit cards**: no heavy card chrome. Icon (24px, `stroke-width:1.5`,
outline-only Lucide-style SVG, color `--text-secondary`) → Inter title (16-18px, weight
400) → Inter description (14px, `#7A7F88`/`#969696`, line-height 160%). Items separated
by faint fading dividers, not boxes.

**Certification badges** (ISO 27001, ISO 42001, SOC 2, GDPR, DPDP): grayscale, opacity 0.5,
hover to opacity 0.8 + slight scale — logos desaturated to sit quietly, never full color.

**Partner-logo marquee** (Y Combinator, Plug and Play, Google, Lovable, seen under hero):
grayscale/white monochrome logo marks, low-key, small, horizontally scrolling.

**Corner radii**: pills = `9999px` (buttons, nav, tags). Cards/panels = `12-16px`
(`rounded-xl`/`rounded-2xl`). Never sharp 0px corners on interactive elements.

**Shadows**: mostly none (flat dark design). Where used (toasts), a soft dark shadow:
`0 10px 40px -12px rgba(0,0,0,0.7)`.

---

## 5. Spacing rhythm

- Section vertical padding: `py-16 md:py-20 lg:py-24` → roughly 64px → 80px → 96px.
- Content max-width: `max-w-7xl` (1280px) for two-column sections, `max-w-5xl` (1024px)
  for the centered hero copy, `max-w-3xl` for the hero subheading paragraph.
- Two-column sections (benefits, credibility, compliance) use `gap-12 lg:gap-20`.
- Hero content sits centered, `pt-28 sm:pt-32 md:pt-36` from top (clears the floating navbar).

---

## 6. Logo usage

- Use the **existing official mark** at
  `/Users/harshitgarg/Documents/Lexi/Code.nosync/lexi-for-chrome/icons/icon128.png`
  (teal six-arrow/snowflake mark on a rounded square). Do not invent a new mark.
- On the live site the mark appears **white/monochrome** (inverted) in the dark navbar,
  next to a serif/display "Lexi" wordmark — i.e. on a black background, use a white
  version of the mark + white wordmark, not the teal-on-white app-icon treatment.
  (Repo confirms a pre-made `lexi-logo-white-v2.png` exists for exactly this purpose,
  alongside a full-color `lexi-logo-v2.png` for light contexts.)
- On a light/white background, use the mark as shipped in `icon128.png` (teal on
  white/rounded square) or the full-color wordmark lockup.
- Keep clear space around the mark roughly equal to the mark's own corner radius; never
  stretch, recolor the arrows to non-teal, or drop the rounded-square backing when the
  mark is used standalone at small sizes (favicon-scale).

---

## 7. Headline voice (verbatim examples from copy)

- **Hero H1**: "The AI operating system for law."
- **Hero subheading**: "One intelligence layer for everyone who works with the law —
  lawyers, legal teams, enterprises, governments, and the courts. Draft, review,
  research, and run matters in 100+ languages, with verified citations. 5M+ documents
  processed · 200,000+ cases · 200+ organizations."
- **Hero CTA**: "Book a Demo"
- **Benefits eyebrow**: "WHY LAW FIRMS CHOOSE LEXI"
- **Benefits H2**: "Stop Drowning in Repetitive Legal Tasks" (first two words are the
  visually "highlighted" span, differentiated by being first, not by color)
- **Benefit items**: "Speed — Free up 10+ hours per attorney per week on legal research
  and document review." / "Precision — Lexi cites sources, verifies citations, and
  learns your firm's standards." / "Scale — Take on 45% more cases without adding
  headcount."
- **Credibility eyebrow**: "Proven Results"
- **Credibility H2**: "Trusted by Leading Law Firms Worldwide"
- **Credibility stats**: "5,000,000+ Documents Processed", "200,000+ Cases Handled",
  "45% More Cases Per Attorney", "200+ Organizations & Law Firms"
- **CTA section**: eyebrow "Get Started", H2 "Ready to Transform Your Legal Practice?",
  button "Schedule a Call"
- **Feature section labels seen live**: "DRAFTING & REVIEW" → "What Lexi drafts and
  reviews", with sub-cards "Drafting — Polished drafts in minutes", "Tabular Review —
  Answers from hundreds of docs", "Contract Review — Spot risks before they bite."

**Voice characteristics**: short, declarative, confident, numbers-forward (always cites
a concrete stat: hours saved, % more cases, documents processed). Sentence case for
H1/H2 (not Title Case, except where a word is capitalized as a proper emphasis, e.g.
"Stop Drowning"). No exclamation points, no emoji, no hype adjectives ("revolutionary",
"game-changing") — the tone is closer to a law firm's own site than a consumer SaaS
landing page: measured, factual, quietly premium.

---

## 8. Do / Don't for marketing tiles (Chrome Web Store promo assets)

1. **Do** keep backgrounds flat near-black (`#0A0A0A`) or the warm dark library photo
   with the dark gradient overlay — never introduce a colorful gradient mesh, blob, or
   bright-colored background; that reads as generic "AI startup," not Lexi.
2. **Do** use the teal `#24CFA6` as a tiny accent only — one dot, one thin glow, one icon
   stroke — never as a large fill, button background, or big color block.
3. **Do** pair a serif display headline (Lovato, or the Georgia/Iowan fallback stack)
   with Inter/system-sans body copy and small uppercase tracked-out labels with a teal
   dot — this serif/sans pairing plus restraint is Lexi's most recognizable signature.
4. **Don't** stretch, recolor, or replace the official six-arrow mark (`icons/icon128.png`)
   — use it as-is (white version on dark backgrounds, teal-on-white on light ones), and
   don't invent alternate logo treatments.
5. **Don't** overcrowd tiles with card chrome, drop shadows, or heavy borders — Lexi's
   real UI separates content with whitespace and 1px fading-gradient dividers, not boxed
   cards; keep promo layouts similarly airy, with generous negative space and one clear
   focal statement (numbers-forward if possible, e.g. "5M+ documents", "10+ hours saved").

---

## Repo vs. live — notes

- Live and repo code matched closely; no meaningful divergence found. The repo's
  `page.tsx` hero background (`/bg/hero.jpg` + gradient overlay) matches `ref-1.png`
  exactly. Stats in `ref-2.png` show live/animated counter values above the copy's
  base numbers (e.g. "4,047,219+" documents, "161,888+" cases, "41%" more cases,
  "183+" organizations) — these are a client-side count-up animation seeded from real
  backend numbers at capture time; the canonical marketing numbers to quote in any
  static promo copy are the **repo's stated baselines**: "5,000,000+ Documents
  Processed", "200,000+ Cases Handled", "45% More Cases Per Attorney", "200+
  Organizations & Law Firms" (do not use the mid-animation snapshot numbers).
- One correction versus a same-repo comment: `globals.css` sets `--section-padding-y:
  120px` as a CSS custom property, but no component actually consumes it — real
  section padding in the rendered site is the Tailwind `py-16 md:py-20 lg:py-24`
  classes documented in §5 above. Use the Tailwind-derived numbers, not the unused CSS var.
