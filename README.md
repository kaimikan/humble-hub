# hub

A local start page for everything in `~/Projects` — the place where projects
are seen, launched, and worked on. Born from the observation that ideas get
*built* easily but then don't enter daily life; the fix is a hub that lives
where the day already starts (the browser's new-tab page), with every project
one click from being used.

It is a single FastAPI module on `http://localhost:7700`, run as a systemd
user service. No build step, no database, no framework on the front end —
one `app.py` (~1100 lines) and one `static/hub.js` (~1200 lines), re-read per
request, so frontend changes deploy with a browser refresh. Localhost-only by
design: the action endpoints execute programs, so the app never binds beyond
127.0.0.1.

## The shelf

On load the hub scans `~/Projects` and renders a card per project: README
excerpt, type badge, last commit, uncommitted-changes marker. The type is
detected from what's in the directory and decides the card's actions:

- **service** (`hub.json` manifest) → start/stop a dev server (see below)
- **site** (`index.html`) → served by the hub itself under `/sites/<name>/`
- **app** (a `.desktop` file) → launch it
- **code** / **notes** / empty → the common actions: open a Claude Code
  chat in the project, open the folder, open a real Konsole

Plus a search box, type filter chips, switchable themes (the default
da-Vinci-notebook parchment, a green phosphor "matrix", a clean "dragon"),
and **jottings** — file-backed to-do and ideas lists (`data/notes.json`)
with drag-to-reorder, done/active filtering, filter-stable reference
numbers, and promote/demote between the two lists.

## Embedded Claude Code terminals

The centerpiece. Any card (and the root `~/Projects` itself) opens a Claude
Code chat in a slide-in drawer — a real terminal, not a chat widget:

```
browser clients (laptop drawer · full-page tab · phone)
    xterm.js
      │  WebSocket  /ws/terminal/<name>?attach=<token>
      ▼
hub.service — FastAPI, app.py — localhost:7700
      │  Unix socket  ~/.local/state/hub/ptys/<project>__<token>.sock
      ▼  framed protocol: i=input, r=resize, k=kill → o=output
hub_ptyd — transient systemd user unit  hub-pty-<project>__<token>
      │  pty
      ▼
claude — Claude Code running in the project directory
```

The key piece is `tools/hub_ptyd.py`, a ~200-line stdlib-only dtach
equivalent: it runs one program on a pty and serves its I/O over a Unix
socket so any number of clients can attach, detach, and reattach without
disturbing the program. Each chat's daemon is spawned with `systemd-run
--user` into its own transient unit — its own cgroup — so chats **survive
hub restarts, page reloads, and tab closes**. Disconnecting the WebSocket
just detaches; the drawer's ✕ sends an explicit kill frame. After a reload,
`GET /api/ptys` lists the still-live sessions and the page offers them back
as ⟲ reattach pills.

Because attachment is by token, multiple clients can share one session: the
drawer's ⤢ opens the *same live chat* as a full page, and the phone can join
too — laptop and phone become live mirrors of one conversation, tmux-style.
The daemon also tracks the DEC private modes the program sets at startup
(alt screen, bracketed paste, mouse tracking) and replays them to
late-attaching clients, which would otherwise have missed them.

Newer Claude Code turns on terminal **mouse reporting** (so clicks navigate
between messages) — but that hands every drag to the program, breaking plain
text selection and right-click copy. The hub deliberately **suppresses mouse
reporting** client-side (a parser handler swallows the mouse-tracking DECSET
sequences), trading click-to-navigate for a normal terminal: a plain drag
selects text. Since xterm's selection is canvas-drawn rather than a DOM
selection, the browser's own copy can't see it, so the terminal copies it for
you — a settled selection lands on the clipboard automatically (no key combo,
no right-click needed).

New chats can pick a permission-mode preset (default / accept-edits / plan);
there is deliberately no bypass-permissions preset. A resume picker and the
conversation manager (below) wire `claude --resume <id>` through the same
bridge.

### War story: the blank drawer

Reattach is harder than it looks. A TUI like Claude Code (built on ink) only
repaints when something changes — so a freshly attached client sees nothing
until the program is provoked into a redraw. The classic trick is a
"jiggle": resize the pty one column down and back up, forcing a SIGWINCH
repaint. Ours stopped working: two back-to-back `TIOCSWINSZ` calls coalesce
into a *single* SIGWINCH at the final — unchanged — size, which
size-comparing TUIs ignore entirely. Result: a blank drawer showing only the
replayed empty alt screen.

The fix is to space the two halves of the jiggle 120 ms apart (shrink now,
restore on a timer), and to jiggle only on a client's *first* same-size
resize — later jiggles would dump duplicate frames into scrollback. The bug
is pinned down by `tests/test_blank_drawer.py`, which drives a mini TUI
(`tests/mini_tui.py`) that mimics exactly the traits that matter: alt
screen, cursor hiding, and repainting *only* on SIGWINCH.

## Conversation manager

The ❧ chats trigger opens a searchable list of every past Claude Code
session across projects, read straight from the transcripts Claude Code
keeps under `~/.claude/projects/<encoded-cwd>/*.jsonl`. One pass per
transcript extracts a title (the AI-generated one if present, else the first
real user line), preview, turn count, and recency. Clicking a row resumes
that session into the drawer, where it joins the live status pills like any
other chat.

## Service launcher

A project that ships a `hub.json` (`{"serve": "<cmd>", "port": N}`) gets
service controls: ▶ starts the command as a transient `hub-svc-<name>`
user unit (own cgroup, survives hub restarts) and opens
`localhost:<port>`; a status dot polls whether the port answers; ■ stops the
unit. By default such a project is typed *service*; an optional `"type"`
field keeps it in its own category while still wiring the controls — so
`linux-learning` stays a *notes* project but can serve its mkdocs site, and
`do-it-diet` is a *site* whose menu links the regime pages.

## From the phone

The hub is reachable from the phone over **Tailscale Serve** — a private
WireGuard tailnet that proxies `localhost:7700` to HTTPS without the app
ever binding beyond localhost (see `docs/mobile-access.md` for why the
public-tunnel alternatives were rejected for an app that executes shell
commands). On touch devices the drawer goes full-width and grows a key
toolbar — arrows, Esc, Tab, Enter, ⌃C — because soft keyboards can't drive
Claude Code's selection prompts; vertical finger swipes are translated into
wheel events so TUI scrollback works.

The toolbar also carries two mic buttons (🎤en / 🎤бг) for **fully local
voice dictation**: the phone records with MediaRecorder, POSTs the blob to
`/api/dictate`, ffmpeg converts it to 16 kHz PCM, and a faster-whisper
daemon on the laptop's GPU (the same engine behind the desktop's Babi
dictation tool, reached over a Unix socket) transcribes it. The text is
typed into the chat's pty with a `[voice]`/`[глас]` prefix; you still press
⏎ to send. English and Bulgarian; nothing leaves the machine.

## Testing

Playwright UI suites plus lifecycle tests, all careful never to touch real
data or live sessions:

- `test_jot.py`, `test_sessions.py`, `test_phone_ux.py` — drive the live
  page but intercept `/api/notes` and `/api/sessions` with fixtures, so
  `data/notes.json` and real transcripts are never written.
- `test_persist.py` — its own uvicorn on :7799 with `HUB_CLAUDE_CMD=bash`;
  proves a session survives a SIGKILL of the server (harsher than a
  restart), reattaches by token, and dies on the kill frame.
- `test_services.py` — its own uvicorn on :7798; starts and stops a real
  `hub-svc-*` unit from a real manifest.
- `test_blank_drawer.py` — its own uvicorn on :7797 against the
  ink-mimicking mini TUI; regression net for the repaint jiggle.

Tests that spawn pty daemons set `HUB_PTY_DIR`, which switches the unit
prefix to `hub-pty-test-*` — so test cleanup can never glob-match a real
session.

## Design philosophy

- One Python module, one JS file. No bundler, no npm, no database.
- Stdlib where possible — `hub_ptyd` has zero dependencies; the server needs
  only fastapi, uvicorn, websockets (xterm.js is vendored, offline-capable).
- Static files and notes are re-read per request: most changes deploy on
  refresh, and new UI styles are injected from `hub.js` rather than the page
  template precisely so a deploy never needs a service restart.
- Persistence through the OS, not a job system: systemd transient units give
  each chat and each dev server its own cgroup for free.
- Localhost-only, with remote access layered on *outside* the app.

## Install

```bash
./install.sh
```

Creates the venv (via `uv`), installs the user service, starts it. Then set
`http://localhost:7700` as the browser homepage/new-tab page.

## Roadmap

Near-term: image paste/drag-drop into chats (upload endpoint + a path typed
into the pty, covering phone camera shots too), wiring docs-serving projects
(mkdocs) into the service launcher, and an in-hub reader for a curated feed.
Further out: voice-orchestrated sessions — "let's work on X" spoken to the
root chat spawns a project chat with its own status pill.
