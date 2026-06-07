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

- KDE Plasma on Wayland host: launched processes must inherit the session
  environment — the unit runs in `graphical-session.target` for that reason.
  Don't move it to `default.target`.
- Localhost only by design; never bind beyond 127.0.0.1 — action endpoints
  execute programs.
- Static-site projects are mounted at startup; a new site project needs a
  service restart to appear under `/sites/`.
- The user dictates by voice (`[voice]` message prefix = transcribed speech;
  odd words are likely mis-transcriptions — decode phonetically/contextually).
