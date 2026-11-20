# Browser bridge: Lexi chat drives the user's Chrome

Lexi's chat agent runs on the server. The bridge lets it use a tab in the
user's own Chrome, through this extension, once the user lets it, on any
website, the way an agent extension does: Chrome asks the user before Lexi
chat uses a site it hasn't used before, and before anything that changes a
page. The first use is SCC Online and Manupatra, to pin a judgment's reporter
citation, page and paragraph. A cloud browser can't do this: it doesn't have
the user's subscription logins, and firm subscriptions are often tied to the
office's IP.

The side panel's own Agent Mode is separate and unchanged: it still works on
any site the user opens it on, with its own per-site settings.

```
web chat → POST /api/chat (Deep Agents turn, any worker)
              │ browser tool call
              ▼
            Redis: command to the user's connection, result back to the tool
              ▲
              │ whichever worker holds the socket
   wss /api/extension/bridge/ws ⇄ extension service worker
                                   → ask the user in Chrome (new site, risky action)
                                   → execTool (policy, run scope, denylist)
                                   → a background tab in the "Lexi" tab group
```

## What the user controls

- **The switch.** Options → "Lexi chat in this browser" → "Let Lexi chat use
  this browser". Turning it on asks Chrome for host access to all sites (a
  remote run has no click to grant `activeTab`). The bridge connects only
  while the user is signed in, the switch is on and Chrome still grants that
  access. Turning it off closes the connection.
- **Sites it can use without asking.** A list under the switch: SCC Online
  and Manupatra (off until ticked), plus every site the user picked "Always
  allow" for. Any other site is asked about first.
- **Asks in Chrome.** A small Lexi window pops up:
  - before a session uses a site that isn't on the list (when it opens it,
    navigates to it, or finds its tab there after a link): "Allow for this
    task", "Always allow" (adds the site to the list) or "Don't allow";
  - before anything that changes something for real: submitting a form
    (a search doesn't count), paying, sending a message, uploading,
    downloading or deleting. It names the element and any text to type:
    "Allow" or "Don't allow". Reading, searching, clicking, typing into
    fields and scrolling on a site the user let it use don't ask.

  Closing the window, or no answer within 45 s, is a no. One window at a
  time; later asks wait their turn. Only the ask page in its own window can
  answer.
- **Run scope.** A session's tab is scoped to the sites the user let it use.
  Everything outside them is asked about again, navigation included.
- **Never.** Lexi's denylist (payment, checkout and credential pages) is
  refused outright, as are password and payment fields. Stored "always
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
| `hello` | `protocol: 1`, `extension_version`, `sites: string[]`, `any_site: true` | first frame after open |
| `sites` | `sites: string[]`, `any_site: true` | the user's list changed |
| `ping` | — | every 20 s (also keeps the MV3 service worker alive) |
| `result` | `id`, `ok: true`, `result` / `ok: false`, `error`, `code` | reply to a `command` |
| `ended` | `session`, `reason: "tab_closed" \| "user_stopped"` | the user closed a session's tab, or cancelled Chrome's debugging bar on it |

`sites` are the sites the user lets Lexi chat use without asking: bare hosts,
lower-case, no `www.` (`scconline.com`, `manupatrafast.in`). A host covers
its subdomains.

`any_site: true` says the extension asks the user in Chrome about any other
site, so the server may offer browsing on any website. An extension that
doesn't send it (protocol 1 as first shipped) only works on its `sites` and
refuses anything that needs a confirmation.

### Server → extension

| type | fields |
|---|---|
| `welcome` | `connection_id` |
| `pong` | — |
| `command` | `id`, `session`, `op`, `args` |

`id` is unique per command; `session` is chosen by the server and groups the
commands of one browsing task (one tab).

### Commands

- **`open`** `args: {url, allowed_hosts?: string[]}`. `url` is an absolute
  http(s) URL; `allowed_hosts` defaults to its host (without `www.`) and must
  cover it. Asks the user about any of `allowed_hosts` not on their list,
  then opens a background tab at `url` in the "Lexi" tab group, scoped to
  `allowed_hosts`, and waits for it to load. If the session already has a
  tab, navigates it instead. `result: {url, title}`.
- **`tool`** `args: {name, input}`. Runs one tool on the session's tab.
  `name` is one of `read_page`, `find_text`, `click`, `type_text`,
  `select_option`, `press_key`, `scroll`, `navigate`, `go_back`, `wait_for`;
  `input` is that tool's input as defined in `src/agent/tools.js`. A
  `navigate` elsewhere, or a tab that a link took elsewhere, asks about the
  new site first; an action that needs a confirmation asks too.
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
| `declined` | the user said no in Chrome (or closed the ask, or didn't answer); nothing was done |
| `no_session` | `tool` for a session with no tab (never opened, closed, or released) |
| `tab_closed` | the user closed the session's tab |
| `blocked` | the policy blocked it (denylist, a browser-internal page) |
| `bad_request` | unknown op or tool, missing args, a URL that isn't http(s), or `url` outside `allowed_hosts` |
| `tool_failed` | the tool ran and failed (element gone, a password field refused, the page changed while the user was deciding, …); `error` says why |
| `site_not_enabled` | extensions without `any_site` only: the URL or `allowed_hosts` has no host the user switched on |
| `needs_confirmation` | extensions without `any_site` only: the action needs a confirmation they can't ask for |

### Timeouts (server side)

`open` 90 s, `tool` 140 s, `close` 10 s. They cover the user deciding: an
ask waits up to 45 s, a `tool` may ask twice (the site, then the action), and
on the extension `wait_for` waits up to 20 s, navigation settles up to 10 s
and a new tab loads up to 30 s.

## Backend routing (lexi-backend)

The socket and the chat turn usually live in different processes, so commands
and results go through Redis, the way chat cancel already does:

- presence per user: which connections are live, their sites, whether they
  ask about other sites (`any_site`), last ping;
- one command channel per connection, subscribed by the worker holding the
  socket before presence lists the connection;
- one result channel per command id, subscribed by the tool before it sends
  the command.

Each SUBSCRIBE is awaited until Redis confirms it: a PUBLISH before then
reaches no one, and on the staging cluster a reply sent 20 ms after an
unconfirmed SUBSCRIBE was lost about a third of the time.
