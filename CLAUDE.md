# CLAUDE.md

Local FastAPI app serving a start page for `~/Projects` on
`http://localhost:7700` (systemd user unit `hub.service`; see `install.sh`).
Single module: `app.py` — discovery (`scan`/`detect`), action endpoints
(spawn konsole/kioclient/dolphin in the user session), inline HTML rendering,
and an embedded terminal: `/terminal/<name>` serves an xterm.js page (vendored
in `static/vendor/`) that connects to `/ws/terminal/<name>`, a WebSocket↔pty
bridge spawning `claude` in the project dir (JSON frames in: input/resize;
binary frames out; SIGHUP on disconnect; `?session=<id>` →
`claude --resume <id>`). `GET /api/sessions` lists past sessions across
projects by reading the transcripts under `~/.claude/projects/<encoded-cwd>/`
(cwd with `/`→`-`) — powers the v3 conversation manager. `POST /api/dictate`
is local voice dictation: a recorded audio blob (from the phone toolbar's
🎤en/🎤бг buttons) → ffmpeg → 16 kHz PCM → the shared Whisper daemon's Unix
socket (`whisper-dictation.sock`, the babble-building/Babi engine) → text,
with `lang=en|bg`. `POST /api/upload` accepts multipart images and normalises
each to a downscaled JPEG via Pillow (HEIC included; orientation baked in,
EXIF/GPS stripped on re-encode) under `data/attachments/` (git-ignored), served
read-only at `/attachments/<id>`. No build step, no database — notes and
uploads are plain files under `data/`.

The **shelf self-organizes into bands**: *pinned* (★ favorites, alphabetical) →
*in motion* (touched within `ACTIVE_DAYS`=30, most recent first; "touched" =
max of last commit and newest Claude-session transcript mtime, see
`last_session_mtime`) → *the rest* (alphabetical), with an **archive** fold
(`<details>`) below the grid for retired projects. Banding is computed twice on
purpose: server-side in `index()` for the initial paint, and client-side in
`reorderCards()` (hub.js) so ★/archive toggles re-band without a reload — keep
the two in sync (`ACTIVE_DAYS` is mirrored). `archived` lives in `notes.json`
next to `favorites`; the card menu's archive/unarchive item toggles it. Search
reaches into the archive (auto-unfolds on a hit, refolds on clear). Each card's
**glyph** is a chain: the project's own icon file (`icon.svg`/`favicon.svg`,
root or `static/`, served via `/api/projects/{name}/icon`) beats a `hub.json`
`"glyph"` character (≤3 chars) beats an auto ink **monogram** — initials on a
plate tinted by a stable name-hash over the five accent pigments. Cards render
BOTH marks (the per-project one + the old per-type icon, class `tglyph`); the
theme modal's "shelf · project marks" section offers the two styles as option
cards whose samples are cloned from the live grid, swapping via
`body.type-glyphs` (localStorage `hubGlyphs`, per-project is the default). Band heads carry a
`band-hint` explaining what earns a project its band. Regression suite:
`tests/test_shelf.py` (hermetic, same intercept pattern as the jot tests).

Jots can be **sent into a claude chat** (row ⋯ → "→ claude ▸"): a picker
offers a fresh chat for the note's project (untagged → the root `~` session)
or any live drawer session. The note text (+ attachment paths under
`data/attachments/`) is bracketed-pasted into the chat's input — never
auto-submitted; `injectIntoSession` waits for first pty output on fresh chats
before pasting. The jot project filter shows per-project note counts, busiest
first, plus a pinned "untagged · N" option (sentinel `UNTAGGED` — adding while
in that view files the item untagged). To-do checkboxes are custom-inked
(`appearance:none`), and marking done raises an `undoToast` — accidental taps
get one-tap recovery, no confirmation friction. Every done-flip goes through
`setDone()`, which stamps `doneAt` (epoch) on completion and deletes it on
revert; done rows render the date as a faint `✓ YYYY-MM-DD` (items finished
before the stamp existed simply lack it). Inbox items hold **one or more images** (`imgs` array; legacy `img`
read via `inboxImgs()`): a multi-file drop forms ONE item, "+ image" grows it,
per-thumb ✕ appears at ≥2, and promote carries every image onto the note.

Front-end logic lives in `static/hub.js` (served via StaticFiles, re-read per
request — JS/CSS changes deploy with just a browser refresh, no restart). New
UI styles are injected from hub.js rather than the `app.py` template for the
same reason (see the empty-state and to-do-filter blocks). The jot modal
(to-do/ideas) supports done/active/all filtering, drag-to-reorder (pointer
events, mouse+touch), and a per-row ⋯ menu to promote/demote/remove. Rows show
sequential reference numbers (for terse references like "to-do 3") — ranked
over the full list so they're filter-stable; to-dos number active items only
(done are skipped), ideas number all. Jots can carry **image attachments**: the
📎 on the compose inputs files an image with the new note (with no text, it
drops into the image **inbox** instead); the per-row ⋯ menu attaches to an
existing jot; a ✕ on a thumbnail detaches it; thumbnails open an in-page
**lightbox** (no new tab). The **inbox** (📥 / `notes.inbox`) captures
standalone image drops — handy from the phone over `tailscale serve` — to
triage into to-dos/ideas later. Detached image files are left on disk (harmless).

Themes live in `static/themes.js`: the `THEME` registry drives the hub's CSS
variables, the picker preview, and each theme's 16-colour terminal palette
(terminals stay dark even under light hub themes). A theme may carry a `skin` —
extra scoped CSS and/or a mounted overlay, in the `SKIN` map in hub.js —
including generative **p5.js "worlds"** (the flow-field; `grove`, the *old
growth* forest with amber light shafts + dust motes) that lazy-load p5 on
selection and tear down on theme change. The picker auto-groups any
`skin`-carrying theme under "special · worlds". To add a world: a `THEME` entry
with `skin:"name"` plus a matching `SKIN[name]` (`{ css, mount? }`) — `apply()`
mounts/tears it down and the picker lists it automatically. Five accent pigments
(`lapis`/`sanguine`/`verdigris`/`ochre`/`plum`) keep stable semantics across
every theme.

**Prototype new worlds visually in the theme lab first** —
`static/theme-worlds.html` (a standalone page, linked from the picker's
*special · worlds* row, reachable on the phone over `tailscale serve`). Append a
`{ palette, sketch }` entry to its `DRAFTS` array to preview a candidate live as
a sample tile (palette + type + generative canvas + a mini sampler card), judge
it side-by-side, then **graduate the approved one** into `themes.js` + a `SKIN`
entry. The lab is the staging ground; drafts never touch the live picker until
they ship. This visual-first loop is the expected way to design any new theme.

On the phone the **back button closes the topmost open overlay before leaving**
(idea 24). One self-contained handler at the end of hub.js keeps a single
history entry armed while anything is open and closes layers in z-order on
`popstate` (lightbox → theme → action → sessions → jot/inbox → drawer-minimise),
re-synced by a `MutationObserver` on `hidden`/body-`class` — so it needs no
rewiring of the individual open/close paths. **Any new modal-like layer must be
added to its `topClosers()` list** to participate (transient popovers — the row
⋯ menu, project picker — are intentionally excluded; they dismiss on any tap/Esc).

Tests live in `tests/`. UI suites drive the live app with Playwright (venv at
`~/.venvs/playwright`): `test_jot.py`, `test_sessions.py`, `test_phone_ux.py`
— they intercept `/api/notes` and `/api/sessions` with fixtures so real data
is **never touched** (use that pattern for any UI test). Lifecycle/integration
suites spin up their own uvicorn on a scratch port (hub `.venv`):
`test_persist.py` (:7799, pty survives SIGKILL + reattach), `test_services.py`
(:7798, service launcher + the `hub.json` type override), `test_blank_drawer.py`
(:7797, the reattach repaint against an ink-mimicking mini TUI). Suites that
spawn pty daemons set `HUB_PTY_DIR`, which switches the unit prefix to
`hub-pty-test-*` so cleanup can never glob-match a real `hub-pty-*` session.

Constraints:

- **NEVER `systemctl --user restart hub.service` without checking your own
  cgroup first** (`cat /proc/self/cgroup`). Claude sessions opened from the
  hub's drawer used to run *inside* hub.service — restarting killed every
  drawer session, including, if you are one, yourself mid-command (happened
  2026-06-08). Since 2026-06-10, drawer chats run in **hub_ptyd** daemons
  (transient `hub-pty-*` user units, own cgroups) and *survive* restarts —
  but sessions started before that deploy, and any non-attach fallback
  session, still die with the service. Check `/api/ptys` / your cgroup before
  advising a restart. Static files (`static/`) and `data/notes.json` are
  re-read per request and need no restart — and `app.py` links its JS/CSS via
  `sv()`, which appends `?v=<mtime>` for cache-busting so browsers (notably
  Android Chrome, which otherwise heuristically serves a stale cached copy)
  refetch the instant a file changes. **`app.py` changes do need a restart** —
  and `py_compile` is not enough to vet one: it checks syntax only, so a missing
  dep or a bad route definition still crash the app on startup. Load it for real
  first (`.venv/bin/python -c "import app"`), then restart, then `curl` the port.

- **Dependencies** beyond the base `fastapi`/`uvicorn`/`websockets`: image
  uploads need `pillow`, `pillow-heif`, and `python-multipart` (all in
  `install.sh`). A venv missing them crashes the app on startup — the
  `/api/upload` route fails to build (this caused an outage 2026-06-27).

- **Persistent sessions**: `tools/hub_ptyd.py` holds each chat's pty and
  serves it on a Unix socket under `~/.local/state/hub/ptys/` (framed
  protocol: i/r/k in, o out). On a client's first reattach it jiggles the pty
  width to force a SIGWINCH repaint — the two halves (shrink, then restore)
  are spaced ~120 ms apart **on purpose**: back-to-back `TIOCSWINSZ` calls
  coalesce into a single no-change SIGWINCH that ink/Claude ignores, which was
  the blank-drawer bug (fixed 2026-06-13, regression `tests/test_blank_drawer.py`
  + `tests/mini_tui.py`). The hub bridges WS ↔ socket
  (`?attach=<token>`); disconnect = detach, `{"type":"kill"}` (drawer ✕) ends
  the session; multiple clients may attach (drawer + ⤢ full page mirror the
  same chat). `GET /api/ptys` lists live sessions → reattach pills after a
  reload. **Copy/selection:** newer Claude Code turns on mouse reporting (clicks
  navigate between messages), which hands every drag to the program and breaks
  text selection + right-click copy. The hub **suppresses mouse reporting**
  client-side — two `term.parser.registerCsiHandler({prefix:"?",final:"h"/"l"})`
  swallow the mouse-tracking DECSET/DECRST modes (1000/1002/1003/1006…) so xterm
  never enters mouse mode (covers live AND replayed-on-attach sequences). A plain
  drag then selects natively; since the xterm selection is canvas-drawn (not a
  DOM selection) the browser can't copy it, so `onSelectionChange` auto-copies a
  settled selection (debounced). Wired in both terminals — `createSession` in
  `static/hub.js` and the `/terminal/` template in `app.py`. Deliberate
  trade-off: **click-to-navigate is disabled**. **Scroll:** without mouse
  reporting xterm turns the wheel into arrow keys (Claude navigates, doesn't
  scroll — it scrolls on PgUp/PgDn), so on **desktop** a capture-phase `wheel`
  handler intercepts it and sends `\x1b[5~`/`\x1b[6~` (PgUp/PgDn), throttled
  (snappy, a page per notch). On **phone** the touch handler instead sends SGR
  mouse-wheel reports straight to the pty (`\x1b[<64/65;col;rowM`) — Claude still
  has mouse mode on (only xterm was stopped from entering it), so it scrolls a
  few lines per report: smooth, line-by-line. `attachTouchScroll` in
  `static/hub.js` and the inline touch handler in the `/terminal/` template.
  Env knobs:
  `HUB_PERSIST=0` restores in-process ptys,
  `HUB_CLAUDE_CMD` overrides the command (tests use bash),
  `HUB_PTY_DIR` relocates sockets. Lifecycle test:
  `tests/test_persist.py` (its own uvicorn on :7799 — never touches the
  live hub).

- KDE Plasma on Wayland host: launched processes must inherit the session
  environment — the unit runs in `graphical-session.target` for that reason.
  Don't move it to `default.target`.
- Localhost only by design; never bind beyond 127.0.0.1 — action endpoints
  execute programs.
- **Project types** come from `detect()` — `_heuristic_type()` (index.html →
  site, .desktop → app, pyproject/src → code, *.md → notes) overlaid with
  `hub.json` overrides. A `hub.json` with `serve`+`port` adds the service
  controls (▶ open / ■ stop / status dot, transient `hub-svc-<name>` unit);
  an optional `"type"` field keeps the project in its own category while still
  wiring those controls (e.g. linux-learning stays `notes` but serves mkdocs).
  Card render, `/api/services`, and the service endpoints key off `serve`/
  `port`, not `type == "service"`.
- Static-site projects (`index.html`) are served **dynamically** by
  `serve_site` under `/sites/<name>/` (path-traversal guarded) — a freshly
  cloned/created site works immediately, no restart.
- The user dictates by voice (`[voice]` message prefix = transcribed speech;
  odd words are likely mis-transcriptions — decode phonetically/contextually).
