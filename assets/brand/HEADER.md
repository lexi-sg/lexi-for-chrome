# Side-panel chat header — design research & decisions

Source of truth: the REAL Lexi product (app.getlexi.io) frontend at
`donna-frontend`, cross-checked against `REAL_LEXI_SPEC.json`
(`chat_transport_decision`). Captured 2026-07-18.

## What the REAL app shows at the top of a chat

The product chat header is `ChatConversationTitleBar.tsx` — a slim 56px bar
(`donna-frontend/src/components/Chat/ChatConversationTitleBar.tsx`). Left→right
it contains ONLY chat-management chrome:

1. Show-chats sidebar toggle (only when the history sidebar is closed)
2. New-chat button (pencil icon, only when sidebar closed)
3. Inline-editable conversation title ("New Conversation", click to rename)
4. Artifacts button + count (only when `artifactCount > 0`)

There is **NO model picker, NO mode toggle, NO deep-think control, and NO gear
in the top bar.** Just chat-management chrome plus the title.

### The mode control lives in the COMPOSER, not the header

There IS a response-mode control, but it sits in the composer bottom bar
(`donna-frontend/src/components/Messages/composer/ModeButton.tsx` +
`ModeMenu.tsx`), styled as a borderless pill. Its options are response *modes*,
never model names: `standard | deep | draft` (Standard / Deep think / Draft).
The client sends only two booleans to `/llm/chat` — `deepThink` and
`draftMode`. **No `model` field is ever sent for a chat message; the server
owns model selection** (`get_llm` / server tiers). Retry/regenerate hits a
dedicated endpoint with just `{ message_id }` and the server rotates the model.

### Raw model names are deliberately hidden

`RenderMessage.test.tsx` asserts that for a message carrying
`model: 'claude-sonnet-4-6'`, the string "Sonnet 4.6" is NOT in the document.
No user-visible "Sonnet"/"GPT" label appears anywhere in the product chat.

### Logo rendering in the app

Raster/SVG `<img>`, never plain text. Left nav rail uses
`/img/logos/lexi_logo.png` (`Sidebar.tsx`); the top `Header.tsx` uses the SVG
wordmark `/img/logos/Asset 1.svg`. There is no shared `Logo` component — each
site inlines an `<img>`/`next Image`.

## Claude for Chrome side-panel header (reference)

Minimal: product mark + a new-chat / settings affordance. No raw model name in
the header. Confirms the "clean mark, no model picker" direction.

## Decisions for THIS extension side panel

The extension side panel is a docked chat surface, so it should mirror the
product's restraint:

- **Remove the BETA badge entirely** (`#lexi-beta-pill` — HTML, CSS, and the
  narrow-width media rule; plus the options-page `.beta-pill`).
- **Real logo lockup**: the teal six-arrow mark (`icons/icon48.png`, referenced
  as `../../icons/icon48.png` — resolves in the side panel, options page, and
  the `chrome-extension://` screenshot pipeline) next to the "Lexi" wordmark
  (now `--lexi-text`, not accent, so the teal mark carries the brand color).
- **No raw model picker in account mode.** The `#model-picker` select is kept
  in the DOM but `hidden` (retained solely for the UI-less BYOK agent-mode e2e
  seam, which still reads `settings.model` → `DEFAULT_MODEL`). The options-page
  "Default model" section is wrapped in `#default-model-section` and hidden
  whenever the user is signed into an account (`renderAccount()`), shown only
  in the signed-out/BYOK path.
- **Keep the gear** (`#settings-btn`, now `margin-left:auto` to anchor the
  right edge) and the composer **Chat/Agent mode toggle** (`#mode-toggle`) —
  Chat vs Agent is a real extension concept (product `/llm/chat` pipeline vs the
  CDP agent proxy), not a raw-model choice, so it stays.

Net header: **[ teal mark + "Lexi" ] ............................ [ gear ]**
