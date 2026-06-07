# CLAUDE.md

Local FastAPI app serving a start page for `~/Projects` on
`http://localhost:7700` (systemd user unit `hub.service`; see `install.sh`).
Single module: `app.py` — discovery (`scan`/`detect`), action endpoints
(spawn konsole/kioclient/dolphin in the user session), inline HTML rendering,
and an embedded terminal: `/terminal/<name>` serves an xterm.js page (vendored
in `static/vendor/`) that connects to `/ws/terminal/<name>`, a WebSocket↔pty
bridge spawning `claude` in the project dir (JSON frames in: input/resize;
binary frames out; SIGHUP on disconnect). No build step, no database, no test
suite; verify by restarting the service and loading the page.

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
