# Browser bridge: Lexi chat drives the user's Chrome

Lexi's chat agent runs on the server. The bridge lets it use a tab in the
user's own Chrome, through this extension, on sites the user has switched on
(first: SCC Online and Manupatra, to pin a judgment's reporter citation, page
and paragraph). A cloud browser can't do this: it doesn't have the user's
subscription logins, and firm subscriptions are often tied to the office's IP.

```
web chat → POST /api/chat (Deep Agents turn, any worker)
              │ browser tool call
              ▼
            Redis: command to the user's connection, result back to the tool
              ▲
              │ whichever worker holds the socket
   wss /api/extension/bridge/ws ⇄ extension service worker
                                   → execTool (policy, run scope, denylist)
                                   → a background tab in the "Lexi" tab group
```

## What the user controls

- **Sites.** Options → "Sites Lexi chat can use". Each site the user switches
  on asks Chrome for host access to it (a remote run has no click to grant
  `activeTab`). The bridge connects only while the user is signed in and at
  least one site is on.
- **Run scope.** A session's tab is scoped to the hosts the server asks for
  that are also switched on. Everything outside them is refused, navigation
  included.
- **Read and search only.** Remote sessions can read, find text, search,
  click, type into fields, select, scroll, navigate and go back. Anything that
  needs a confirmation (submit, pay, delete, upload, download, send) is
  refused: chat can't show the extension's confirm card yet. Stored "always
  allow" grants from Agent Mode do not apply to remote sessions.
- **Visible.** The tab sits in a green "Lexi" tab group with the red acting
  border. Closing the tab ends the session; the server is told.

## Auth

1. `POST {api_base}/api/extension/bridge/ticket` with
   `Authorization: Bearer lexiext_…` → `200 {"ticket": "<opaque>", "expires_in": 60}`.
   401 means the extension token is invalid, expired or revoked.
2. Open `wss://{api_host}/api/extension/bridge/ws?ticket=<ticket>`. The ticket
   is single-use and expires after 60 s. A bad ticket closes the socket with
   code 4401.

## Messages

JSON text frames. Unknown fields are ignored; unknown `type`s are ignored.

### Extension → server

| type | fields | when |
|---|---|---|
| `hello` | `protocol: 1`, `extension_version`, `sites: string[]` | first frame after open |
| `sites` | `sites: string[]` | the user changed their sites |
| `ping` | — | every 20 s (also keeps the MV3 service worker alive) |
| `result` | `id`, `ok: true`, `result` / `ok: false`, `error`, `code` | reply to a `command` |
| `ended` | `session`, `reason: "tab_closed" \| "user_stopped"` | the user closed a session's tab, or cancelled Chrome's debugging bar on it |

`sites` are bare hosts, lower-case, no `www.` (`scconline.com`,
`manupatrafast.in`). A host covers its subdomains.

### Server → extension

| type | fields |
|---|---|
| `welcome` | `connection_id` |
| `pong` | — |
| `command` | `id`, `session`, `op`, `args` |

`id` is unique per command; `session` is chosen by the server and groups the
commands of one browsing task (one tab).

### Commands

- **`open`** `args: {url, allowed_hosts: string[]}`. Opens a background tab at
  `url` in the "Lexi" tab group, scoped to `allowed_hosts` ∩ the user's sites,
  and waits for it to load. If the session already has a tab, navigates it
  instead. `result: {url, title}`.
- **`tool`** `args: {name, input}`. Runs one tool on the session's tab.
  `name` is one of `read_page`, `find_text`, `click`, `type_text`,
  `select_option`, `press_key`, `scroll`, `navigate`, `go_back`, `wait_for`;
  `input` is that tool's input as defined in `src/agent/tools.js`.
  `result` is the tool's result plus `page: {url, title}` (where the tab is
  after the call).
- **`close`** `args: {keep_tab?: boolean}`. Ends the session: clears the scope,
  removes the overlay, detaches the debugger, and closes the tab unless
  `keep_tab` is true. `result: {closed: true}`, also for a session that is
  already gone.

A session nobody uses for 5 minutes is released the same way (tab kept), so a
turn that dies without `close` doesn't leave the tab scoped and bordered.

### Error codes (`result` with `ok: false`)

| code | meaning |
|---|---|
| `site_not_enabled` | the URL or `allowed_hosts` has no host the user switched on |
| `no_session` | `tool` for a session with no tab (never opened, closed, or released) |
| `tab_closed` | the user closed the session's tab |
| `needs_confirmation` | the action needs a human confirmation, which remote sessions can't get |
| `blocked` | the policy blocked it (denylist, outside the run scope) |
| `bad_request` | unknown op or tool, or missing args |
| `tool_failed` | the tool ran and failed (element gone, a password field refused, …); `error` says why |

### Timeouts (server side)

`open` 40 s, `tool` 45 s (`wait_for` waits up to 20 s and navigation settles
up to 10 s on the extension), `close` 10 s.

## Backend routing (lexi-backend)

The socket and the chat turn usually live in different processes, so commands
and results go through Redis, the way chat cancel already does:

- presence per user: which connections are live, their sites, last ping;
- one command channel per connection, subscribed by the worker holding the
  socket before presence lists the connection;
- one result channel per command id, subscribed by the tool before it sends
  the command.

Each SUBSCRIBE is awaited until Redis confirms it: a PUBLISH before then
reaches no one, and on the staging cluster a reply sent 20 ms after an
unconfirmed SUBSCRIBE was lost about a third of the time.
