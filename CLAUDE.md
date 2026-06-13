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
with `lang=en|bg`. No build step, no database.

Front-end logic lives in `static/hub.js` (served via StaticFiles, re-read per
request — JS/CSS changes deploy with just a browser refresh, no restart). New
UI styles are injected from hub.js rather than the `app.py` template for the
same reason (see the empty-state and to-do-filter blocks). The jot modal
(to-do/ideas) supports done/active/all filtering, drag-to-reorder (pointer
events, mouse+touch), and a per-row ⋯ menu to promote/demote/remove. Rows show
sequential reference numbers (for terse references like "to-do 3") — ranked
over the full list so they're filter-stable; to-dos number active items only
(done are skipped), ideas number all.

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
  re-read per request and need no restart.

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
  reload. Env knobs: `HUB_PERSIST=0` restores in-process ptys,
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
