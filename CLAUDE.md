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
(cwd with `/`→`-`) — powers the v3 conversation manager. No build step, no
database.

Front-end logic lives in `static/hub.js` (served via StaticFiles, re-read per
request — JS/CSS changes deploy with just a browser refresh, no restart). New
UI styles are injected from hub.js rather than the `app.py` template for the
same reason (see the empty-state and to-do-filter blocks). The jot modal
(to-do/ideas) supports done/active/all filtering, drag-to-reorder (pointer
events, mouse+touch), and a per-row ⋯ menu to promote/demote/remove. Rows show
sequential reference numbers (for terse references like "to-do 3") — ranked
over the full list so they're filter-stable; to-dos number active items only
(done are skipped), ideas number all.

Tests: `tests/test_jot.py` drives the live app with Playwright (venv at
`~/.venvs/playwright`; run `~/.venvs/playwright/bin/python tests/test_jot.py`
with the service up). It intercepts `/api/notes` so it seeds a fixture and
captures saves **without touching `data/notes.json`** — use that pattern for
any UI test so real data stays safe.

Constraints:

- **NEVER `systemctl --user restart hub.service` without checking your own
  cgroup first** (`cat /proc/self/cgroup`). Claude sessions opened from the
  hub's drawer run *inside* hub.service — restarting it kills every drawer
  session, including, if you are one, yourself mid-command (this happened on
  2026-06-08). If you are inside `hub.service`, ask the user to restart from
  the shelf or a Konsole session instead. Static files (`static/`) and
  `data/notes.json` are re-read per request and need no restart.

- KDE Plasma on Wayland host: launched processes must inherit the session
  environment — the unit runs in `graphical-session.target` for that reason.
  Don't move it to `default.target`.
- Localhost only by design; never bind beyond 127.0.0.1 — action endpoints
  execute programs.
- Static-site projects are mounted at startup; a new site project needs a
  service restart to appear under `/sites/`.
- The user dictates by voice (`[voice]` message prefix = transcribed speech;
  odd words are likely mis-transcriptions — decode phonetically/contextually).
