"""hub — local start-page for everything in ~/Projects.

Scans the projects directory, renders a card per project with type-aware
actions (launch app, open site, open a Claude Code terminal in the project),
serves static-site projects directly, and embeds a browser terminal
(xterm.js + a WebSocket pty bridge) running Claude Code per project.
Localhost only.
"""
import asyncio
import fcntl
import html
import json
import os
import pty
import re
import signal
import struct
import subprocess
import sys
import termios
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

PROJECTS_DIR = Path.home() / "Projects"
HUB_DIR = Path(__file__).resolve().parent
SKIP = re.compile(r"^(\.|watch_)")

app = FastAPI(title="hub")


# ---------------------------------------------------------------------------
# Project discovery


def readme_excerpt(path: Path) -> str:
    """The README's first prose paragraph (markdown intact — rendered later)."""
    readme = path / "README.md"
    if not readme.is_file():
        return ""
    para: list[str] = []
    for line in readme.read_text(errors="replace").splitlines():
        s = line.strip()
        if not s:
            if para:
                break          # blank line ends the first paragraph
            continue
        if s.startswith(("#", "<", "!", "|", "```", "- ", "* ", "+ ", "> ")):
            if para:
                break          # a heading/list/quote after prose ends it
            continue           # …or skip it while still looking for prose
        para.append(s)
    return " ".join(para)


_MD_LINK = re.compile(r"\[([^\]]+)\]\((https?://[^\s)]+)\)")
_MD_BOLD = re.compile(r"\*\*([^*]+)\*\*")
_MD_ITALIC = re.compile(r"(?<![\w*])[*_]([^*_\s][^*_]*)[*_](?![\w*])")
_MD_CODE = re.compile(r"`([^`]+)`")


def md_inline(text: str) -> str:
    """Render a safe subset of inline markdown (link/bold/italic/code).

    Everything is HTML-escaped first, then our own tags are layered on — so
    README text can never inject markup; links are restricted to http(s)."""
    out = html.escape(text)
    out = _MD_LINK.sub(
        lambda m: f'<a href="{m.group(2)}" target="_blank" rel="noopener">{m.group(1)}</a>', out)
    out = _MD_BOLD.sub(r"<strong>\1</strong>", out)
    out = _MD_ITALIC.sub(r"<em>\1</em>", out)
    out = _MD_CODE.sub(r"<code>\1</code>", out)
    return out


def git_info(path: Path) -> dict:
    if not (path / ".git").is_dir():
        return {}
    run = lambda *args: subprocess.run(  # noqa: E731
        ["git", "-C", str(path), *args], capture_output=True, text=True
    ).stdout.strip()
    remote = run("remote", "get-url", "origin")
    web = ""
    if "github.com" in remote:
        web = re.sub(r"^git@github\.com:", "https://github.com/", remote)
        web = re.sub(r"\.git$", "", web)
    return {
        "last_commit": run("log", "-1", "--format=%ad — %s", "--date=format:%Y-%m-%d"),
        "dirty": bool(run("status", "--porcelain")),
        "remote": remote,
        "github": web,
    }


def _heuristic_type(path: Path) -> dict:
    """Classify a project by what's in its directory (no manifest)."""
    desktop_files = sorted(path.glob("*.desktop"))
    if (path / "index.html").is_file():
        return {"type": "site", "site": f"/sites/{path.name}/"}
    if desktop_files:
        return {"type": "app", "desktop": str(desktop_files[0])}
    if (path / "pyproject.toml").is_file() or (path / "src").is_dir():
        return {"type": "code"}
    if any(path.glob("*.md")):
        return {"type": "notes"}
    return {"type": "empty"}


def detect(path: Path) -> dict:
    """Classify a project and derive its available actions.

    A hub.json with serve+port wires the service controls (▶ open / ■ stop /
    status dot). Such a project is typed "service" by default; an optional
    "type" field keeps the project in its own category while still getting the
    controls — e.g. linux-learning stays "notes" but can serve its mkdocs site.
    """
    svc, forced_type = {}, None
    manifest = path / "hub.json"
    if manifest.is_file():
        try:
            m = json.loads(manifest.read_text())
            if m.get("serve") and m.get("port"):
                svc = {"serve": m["serve"], "port": int(m["port"])}
            if m.get("type"):
                forced_type = m["type"]
        except (json.JSONDecodeError, ValueError, TypeError):
            pass  # malformed manifest → heuristics only

    info = _heuristic_type(path)
    if forced_type:
        info["type"] = forced_type
    elif svc:
        info["type"] = "service"
    info.update(svc)
    return info


def scan() -> list:
    projects = []
    for path in sorted(PROJECTS_DIR.iterdir()):
        if not path.is_dir() or SKIP.match(path.name) or path == HUB_DIR:
            continue
        projects.append(
            {
                "name": path.name,
                "path": str(path),
                "excerpt": readme_excerpt(path),
                **detect(path),
                **git_info(path),
            }
        )
    return projects


app.mount("/static", StaticFiles(directory=HUB_DIR / "static"))


# ---------------------------------------------------------------------------
# Actions


def project_path(name: str) -> Path:
    if name == "~":  # the root claude — a session over all of ~/Projects
        return PROJECTS_DIR
    path = PROJECTS_DIR / name
    if not path.is_dir() or SKIP.match(name) or "/" in name:
        raise HTTPException(404, f"no such project: {name}")
    return path


# Static-site projects served dynamically — a freshly created/cloned site
# project works immediately, no hub restart (mounts froze the list at boot).
@app.get("/sites/{name}")
def site_root(name: str):
    from fastapi.responses import RedirectResponse
    project_path(name)
    return RedirectResponse(f"/sites/{name}/", status_code=308)


@app.get("/sites/{name}/{path:path}")
def serve_site(name: str, path: str = ""):
    from fastapi.responses import FileResponse
    base = project_path(name).resolve()
    target = (base / path).resolve() if path else base / "index.html"
    if target.is_dir():
        target = target / "index.html"
    if not str(target).startswith(str(base) + os.sep):
        raise HTTPException(403, "path escapes the project")
    if not target.is_file():
        raise HTTPException(404, f"no such file in {name}: {path}")
    return FileResponse(target)


@app.post("/api/projects/{name}/terminal")
def open_terminal(name: str):
    """Open Konsole in the project directory with Claude Code running."""
    path = project_path(name)
    subprocess.Popen(["konsole", "--workdir", str(path), "-e", "claude"])
    return {"ok": True}


@app.post("/api/projects/{name}/launch")
def launch_app(name: str):
    info = detect(project_path(name))
    if "desktop" not in info:
        raise HTTPException(400, f"{name} has no .desktop launcher")
    subprocess.Popen(["kioclient", "exec", info["desktop"]])
    return {"ok": True}


@app.post("/api/projects/{name}/folder")
def open_folder(name: str):
    subprocess.Popen(["dolphin", str(project_path(name))])
    return {"ok": True}


@app.get("/api/projects")
def api_projects():
    return scan()


# --- service projects (hub.json: {"serve": "<cmd>", "port": N}) -------------
# Server apps the hub can start on demand. Each runs as a transient systemd
# user unit (hub-svc-<name>) — own cgroup, so it survives hub restarts, same
# pattern as the pty daemons.


def _port_open(port: int) -> bool:
    import socket as so
    s = so.socket(so.AF_INET, so.SOCK_STREAM)
    s.settimeout(0.3)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    finally:
        s.close()


@app.get("/api/services")
def api_services():
    return {p["name"]: _port_open(p["port"])
            for p in scan() if p.get("port")}


@app.post("/api/projects/{name}/service/open")
def service_open(name: str):
    import shlex
    import time
    path = project_path(name)
    info = detect(path)
    if not info.get("serve") or not info.get("port"):
        raise HTTPException(400, f"{name} has no hub.json service manifest")
    port, url = info["port"], f"http://localhost:{info['port']}"
    if _port_open(port):
        return {"ok": True, "url": url, "started": False}
    argv = shlex.split(info["serve"])
    if argv[0].startswith("."):  # resolve project-relative commands
        argv[0] = str(path / argv[0])
    env_path = f"{Path.home()}/.local/bin:{os.environ.get('PATH', '/usr/bin')}"
    # the port isn't answering, but a unit with this name may still linger —
    # failed, or running a stale config (e.g. an old port after a hub.json
    # edit). systemd-run would collide on the name; clear it first so the
    # fresh config takes effect.
    unit = f"hub-svc-{name}.service"
    subprocess.run(["systemctl", "--user", "stop", unit], capture_output=True)
    subprocess.run(["systemctl", "--user", "reset-failed", unit], capture_output=True)
    try:
        subprocess.run(
            ["systemd-run", "--user", "--collect", "--quiet",
             f"--unit=hub-svc-{name}", f"--working-directory={path}",
             f"--setenv=PATH={env_path}", *argv],
            check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as exc:
        raise HTTPException(500, f"could not start {name}: "
                                 f"{(exc.stderr or '').strip() or exc}")
    for _ in range(100):  # wait for the port (max ~10 s)
        if _port_open(port):
            return {"ok": True, "url": url, "started": True}
        time.sleep(0.1)
    raise HTTPException(502, f"{name} did not open port {port} — check: "
                             f"journalctl --user -u hub-svc-{name}")


@app.post("/api/projects/{name}/service/stop")
def service_stop(name: str):
    """Stop the service however it was started: the hub's transient unit if
    one exists, otherwise (manually-launched instance) kill by port."""
    import time
    path = project_path(name)
    info = detect(path)
    subprocess.run(["systemctl", "--user", "stop", f"hub-svc-{name}.service"],
                   capture_output=True)
    if not info.get("port"):
        return {"ok": True, "stopped": True}
    for _ in range(8):  # give the unit a moment to release the port
        if not _port_open(info["port"]):
            return {"ok": True, "stopped": True}
        time.sleep(0.25)
    subprocess.run(["fuser", "-k", f"{info['port']}/tcp"], capture_output=True)
    time.sleep(0.6)
    return {"ok": True, "stopped": not _port_open(info["port"])}


# --- notes & to-dos (file-backed, see data/notes.json) ---

NOTES_FILE = HUB_DIR / "data" / "notes.json"


@app.get("/api/notes")
def get_notes():
    if NOTES_FILE.is_file():
        return json.loads(NOTES_FILE.read_text())
    return {"todos": [], "ideas": []}


@app.put("/api/notes")
def put_notes(doc: dict):
    NOTES_FILE.parent.mkdir(exist_ok=True)
    NOTES_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1))
    return {"ok": True}


# --- phone dictation (T32) ---------------------------------------------------
# The phone records audio (MediaRecorder over the https tailnet proxy) and
# POSTs the blob here; Babi's whisper daemon transcribes it locally — the same
# engine and socket as the desktop hotkeys, nothing leaves the laptop. ffmpeg
# converts whatever container the browser produced (webm/opus on Chrome,
# ogg/opus on Firefox) into the raw s16le/16kHz/mono stream whisperd expects.

WHISPER_SOCK = Path(os.environ.get("XDG_RUNTIME_DIR", "/tmp")) / "whisper-dictation.sock"


@app.post("/api/dictate")
async def dictate(request: Request, lang: str = "en"):
    if lang not in ("en", "bg"):
        raise HTTPException(400, "lang must be 'en' or 'bg'")
    if not WHISPER_SOCK.is_socket():
        raise HTTPException(503, "whisper-dictation.service is not running on the laptop")
    blob = await request.body()
    if not blob:
        raise HTTPException(400, "empty audio")
    if len(blob) > 32 * 1024 * 1024:
        raise HTTPException(413, "audio too large (32 MB cap ≈ many minutes of opus)")

    import tempfile
    with tempfile.NamedTemporaryFile(prefix="hub-dictate-", delete=False) as src:
        src.write(blob)
    raw = src.name + ".raw"
    try:
        ff = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-i", src.name, "-f", "s16le", "-ar", "16000", "-ac", "1", raw,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        if await ff.wait() != 0:
            raise HTTPException(400, "ffmpeg could not decode the audio")

        def ask_whisper() -> str:
            import socket as so
            s = so.socket(so.AF_UNIX, so.SOCK_STREAM)
            s.settimeout(120)  # first request may sit behind a model (re)load
            try:
                s.connect(str(WHISPER_SOCK))
                s.sendall(f"{raw}\t{lang}\n".encode())
                chunks = []
                while chunk := s.recv(65536):
                    chunks.append(chunk)
                return b"".join(chunks).decode()
            finally:
                s.close()

        text = await asyncio.to_thread(ask_whisper)
    except OSError as exc:
        raise HTTPException(502, f"whisper daemon error: {exc}")
    finally:
        for p in (src.name, raw):
            try:
                os.unlink(p)
            except OSError:
                pass
    return {"text": text}


# --- conversation manager (v3) ---------------------------------------------
# Lists past Claude Code sessions per project by reading the transcripts under
# ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl. Resume wires back through
# the terminal WebSocket with ?session=<id> → `claude --resume <id>`.

CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"


def _encode_cwd(path: Path) -> str:
    """Mirror Claude Code's transcript-dir naming: the cwd with / → -."""
    return str(path).replace("/", "-")


def _user_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # tool results are not real user turns — skip those messages entirely
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return ""
        return " ".join(b.get("text", "") for b in content
                        if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _session_meta(f: Path) -> dict:
    """Title (ai-title if present, else first real user line), preview, turn
    count, and mtime — one pass over the transcript."""
    title, first_user, count = "", "", 0
    try:
        with f.open(errors="replace") as fh:
            for line in fh:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("aiTitle"):
                    title = d["aiTitle"]
                t = d.get("type")
                if t in ("user", "assistant"):
                    count += 1
                if t == "user" and not first_user:
                    txt = _user_text(d.get("message", {}).get("content")).strip()
                    if txt and not txt.startswith("<"):
                        first_user = txt[:160]
    except OSError:
        return {}
    return {
        "title": title or first_user or "(untitled)",
        "preview": first_user,
        "count": count,
        "mtime": f.stat().st_mtime,
    }


@app.get("/api/sessions")
def api_sessions():
    # map each known project (root + children of ~/Projects) to its transcript dir
    known = {_encode_cwd(PROJECTS_DIR): "~"}
    for p in sorted(PROJECTS_DIR.iterdir()):
        if p.is_dir() and not SKIP.match(p.name):
            known[_encode_cwd(p)] = p.name
    out = []
    if CLAUDE_PROJECTS.is_dir():
        for enc, name in known.items():
            d = CLAUDE_PROJECTS / enc
            if not d.is_dir():
                continue
            for f in d.glob("*.jsonl"):
                meta = _session_meta(f)
                if meta and meta["count"]:  # skip empty/aborted transcripts
                    out.append({"id": f.stem, "project": name, **meta})
    out.sort(key=lambda s: s["mtime"], reverse=True)
    return out


# ---------------------------------------------------------------------------
# Embedded terminal — WebSocket pty bridge running Claude Code per project


# permission-mode presets for spawned chats; unknown values fall back to
# default. Deliberately no bypass/--dangerously-skip-permissions preset —
# launch that manually in a real terminal when truly needed.
MODE_ARGS = {
    "default": [],
    "accept-edits": ["--permission-mode", "acceptEdits"],
    "plan": ["--permission-mode", "plan"],
}


def build_argv(resume: bool = False, mode: str = "default", session: str = "") -> list:
    """The claude command line for a new chat. HUB_CLAUDE_CMD overrides the
    base command (tests run a plain shell instead of claude)."""
    import shlex
    base = shlex.split(os.environ.get("HUB_CLAUDE_CMD", "claude"))
    if session:
        resume_args = ["--resume", session]
    elif resume:
        resume_args = ["--resume"]
    else:
        resume_args = []
    return [*base, *MODE_ARGS.get(mode, []), *resume_args]


def spawn_claude(path: Path, resume: bool = False, mode: str = "default",
                 session: str = ""):
    """Start `claude` on a pty in the project dir. Returns (pid, master fd).

    `session` resumes that specific session id (`claude --resume <id>`);
    `resume` without it opens claude's interactive resume picker.
    """
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    env["PATH"] = f"{Path.home()}/.local/bin:{env.get('PATH', '/usr/bin')}"
    argv = build_argv(resume, mode, session)
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.chdir(path)
        os.execvpe("claude", argv, env)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return pid, fd


# --- persistent sessions (hub_ptyd) -----------------------------------------
# Each chat runs inside tools/hub_ptyd.py, spawned as a transient systemd
# *user* unit — its own cgroup, so it survives hub.service restarts. The hub
# only bridges WebSocket ↔ the daemon's Unix socket; disconnecting detaches
# (session lives on), an explicit kill frame ends it. HUB_PERSIST=0 restores
# the old in-process ptys.

PTY_DIR = Path(os.environ.get("HUB_PTY_DIR",
                              Path.home() / ".local" / "state" / "hub" / "ptys"))
PERSIST = os.environ.get("HUB_PERSIST", "1") != "0"


def _sock_path(name: str, token: str) -> Path:
    proj = "root" if name == "~" else name
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{proj}__{token}")
    return PTY_DIR / f"{safe}.sock"


def _sock_alive(sock: Path) -> bool:
    if not sock.exists():
        return False
    import socket as so
    s = so.socket(so.AF_UNIX, so.SOCK_STREAM)
    try:
        s.connect(str(sock))
        return True
    except OSError:
        sock.unlink(missing_ok=True)  # stale socket from a crashed daemon
        return False
    finally:
        s.close()


def ensure_ptyd(name: str, path: Path, token: str, resume: bool, mode: str,
                session: str) -> Path:
    """Return the session's socket, spawning the daemon if it isn't running."""
    import time
    sock = _sock_path(name, token)
    if _sock_alive(sock):
        return sock
    PTY_DIR.mkdir(parents=True, exist_ok=True)
    env_path = f"{Path.home()}/.local/bin:{os.environ.get('PATH', '/usr/bin')}"
    # Tests (which set HUB_PTY_DIR) get a distinct unit prefix so their cleanup
    # can NEVER glob-match real sessions — a bare 'hub-pty-*' stop has killed
    # the live Claude running the tests three separate times.
    prefix = "hub-pty-test" if os.environ.get("HUB_PTY_DIR") else "hub-pty"
    unit = f"{prefix}-{sock.stem}"
    subprocess.run(
        ["systemd-run", "--user", "--collect", "--quiet", f"--unit={unit}",
         f"--working-directory={path}",
         f"--setenv=PATH={env_path}", "--setenv=TERM=xterm-256color",
         "--setenv=COLORTERM=truecolor",
         sys.executable, str(HUB_DIR / "tools" / "hub_ptyd.py"), str(sock), "--",
         *build_argv(resume, mode, session)],
        check=True, capture_output=True, text=True)
    for _ in range(100):  # wait for the daemon's socket (max ~5 s)
        if sock.exists() and _sock_alive(sock):
            return sock
        time.sleep(0.05)
    raise RuntimeError(f"pty daemon for {unit} did not come up")


@app.get("/api/ptys")
def api_ptys():
    """Live persistent sessions — lets the UI offer reattach after a reload."""
    out = []
    if PTY_DIR.is_dir():
        for sock in PTY_DIR.glob("*.sock"):
            if not _sock_alive(sock):
                continue
            proj, _, token = sock.stem.partition("__")
            out.append({"project": "~" if proj == "root" else proj,
                        "token": token, "since": sock.stat().st_mtime})
    out.sort(key=lambda s: s["since"])
    return out


@app.websocket("/ws/terminal/{name}")
async def terminal_ws(ws: WebSocket, name: str, resume: bool = False,
                      mode: str = "default", session: str = "",
                      attach: str = ""):
    path = project_path(name)
    await ws.accept()
    if PERSIST and attach:
        await _persist_ws(ws, name, path, attach, resume, mode, session)
        return
    pid, fd = spawn_claude(path, resume, mode, session)
    loop = asyncio.get_running_loop()
    pty_data = asyncio.Queue()
    loop.add_reader(fd, lambda: _drain(fd, pty_data, loop))

    async def pty_to_ws():
        while True:
            data = await pty_data.get()
            if data is None:  # EOF — claude exited
                await ws.close()
                return
            await ws.send_bytes(data)

    sender = asyncio.create_task(pty_to_ws())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg["type"] == "input":
                os.write(fd, msg["data"].encode())
            elif msg["type"] == "resize":
                winsz = struct.pack("HHHH", msg["rows"], msg["cols"], 0, 0)
                fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        sender.cancel()
        loop.remove_reader(fd)
        os.close(fd)
        try:
            os.kill(pid, signal.SIGHUP)
            await asyncio.sleep(0)
            os.waitpid(pid, os.WNOHANG)
        except (ProcessLookupError, ChildProcessError):
            pass


async def _persist_ws(ws: WebSocket, name: str, path: Path, attach: str,
                      resume: bool, mode: str, session: str) -> None:
    """Bridge a WebSocket to a hub_ptyd session (attach/detach semantics).

    Disconnect = detach: the session survives. A {"type":"kill"} frame ends
    the session for real (drawer ✕). Multiple clients may attach at once —
    drawer and full-page view mirror the same chat.
    """
    try:
        sock = ensure_ptyd(name, path, attach, resume, mode, session)
    except (RuntimeError, subprocess.CalledProcessError):
        await ws.close(code=1011)
        return
    reader, writer = await asyncio.open_unix_connection(str(sock))

    async def daemon_to_ws():
        try:
            while True:
                head = await reader.readexactly(5)
                payload = await reader.readexactly(struct.unpack(">I", head[1:5])[0])
                if head[0:1] == b"o":
                    await ws.send_bytes(payload)
        except (asyncio.IncompleteReadError, ConnectionError, RuntimeError):
            try:
                await ws.close()
            except RuntimeError:
                pass

    pump = asyncio.create_task(daemon_to_ws())
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            if msg["type"] == "input":
                data = msg["data"].encode()
                writer.write(b"i" + struct.pack(">I", len(data)) + data)
            elif msg["type"] == "resize":
                payload = struct.pack(">HH", msg["rows"], msg["cols"])
                writer.write(b"r" + struct.pack(">I", len(payload)) + payload)
            elif msg["type"] == "kill":
                writer.write(b"k" + struct.pack(">I", 0))
            await writer.drain()
    except (WebSocketDisconnect, RuntimeError, ConnectionError):
        pass
    finally:
        pump.cancel()
        writer.close()


def _drain(fd: int, queue: asyncio.Queue, loop) -> None:
    try:
        data = os.read(fd, 65536)
    except (BlockingIOError, InterruptedError):
        return
    except OSError:
        data = b""
    queue.put_nowait(data or None)
    if not data:
        loop.remove_reader(fd)


@app.get("/terminal/{name}", response_class=HTMLResponse)
def terminal_page(name: str, resume: bool = False, attach: str = "",
                  mode: str = "default"):
    project_path(name)  # 404 unknown names
    safe = html.escape(name)
    import uuid
    params = []
    if PERSIST:  # no attach given → a fresh persistent session
        params.append("attach=" + (attach or uuid.uuid4().hex[:12]))
    if resume:
        params.append("resume=1")
    if mode != "default":
        params.append(f"mode={mode}")
    ws_query = ("?" + "&".join(params)) if params else ""
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>{safe} — claude</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/static/favicon.ico" sizes="any">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/static/vendor/xterm.min.css">
<script src="/static/themes.js"></script>
<script>
  // skin the page chrome from the saved hub theme's TERMINAL palette (always
  // dark) before first paint — no flash. The terminal itself is themed below.
  (function(){{
    var k = resolveTheme(localStorage.getItem('hubTheme') || 'codex');
    var d = THEME[k].term, r = document.documentElement.style;
    r.setProperty('--t-bg', d.bg); r.setProperty('--t-fg', d.fg);
    r.setProperty('--t-panel', _shade(d.bg, 10)); r.setProperty('--t-border', _shade(d.bg, 20));
    r.setProperty('--t-accent', d.ansi[12] || d.ansi[4]); r.setProperty('--t-faint', d.ansi[8]);
    r.setProperty('--t-font', THEME[k].font);
  }})();
</script>
<style>
  body {{ margin:0; height:100vh; height:100dvh; display:flex; flex-direction:column;
    background:var(--t-bg,#1a1b26); color:var(--t-fg,#c0caf5);
    font:15px var(--t-font, "EB Garamond","Noto Serif",Georgia,serif); }}
  header {{ display:flex; align-items:center; gap:.8rem; padding:.45rem .9rem;
    color:var(--t-fg,#c0caf5); border-bottom:1.5px solid var(--t-border,#2a2b3c); }}
  header a {{ color:var(--t-accent,#7aa2f7); text-decoration:none; }}
  header h1 {{ margin:0; font-size:1rem; font-weight:600; font-variant:small-caps;
    letter-spacing:.08em; flex:1; }}
  header .sub {{ font-style:italic; font-size:.85rem; color:var(--t-faint,#565f89); }}
  #term {{ flex:1; padding:.4rem; background:var(--t-bg,#1a1b26); }}
  /* on-screen key toolbar — touch devices only (phone) */
  #kbar {{ display:none; flex-wrap:wrap; gap:.3rem; padding:.4rem;
    padding-bottom:max(.4rem, env(safe-area-inset-bottom));
    background:var(--t-bg,#1a1b26); border-top:1px solid var(--t-border,#2a2b3c); }}
  @media (pointer: coarse) {{ #kbar {{ display:flex; }} }}
  #kbar button {{ flex:0 0 auto; min-width:2.6rem; padding:.55rem .6rem;
    font:1rem/1 "JetBrains Mono","Noto Sans Mono",monospace; background:var(--t-panel,#24283b);
    color:var(--t-fg,#c0caf5); border:1px solid var(--t-border,#3b4261); border-radius:4px; cursor:pointer;
    user-select:none; touch-action:manipulation; }}
  #kbar button:active {{ background:var(--t-border,#3b4261); }}
  #kbar .wide {{ min-width:3.6rem; font-variant:small-caps; letter-spacing:.04em; }}
  #kbar .mic.rec {{ background:#7a2733; border-color:#f7768e; animation:micpulse 1.2s infinite; }}
  #kbar svg {{ width:1.15em; height:1.15em; fill:none; stroke:currentColor; stroke-width:2;
    stroke-linecap:round; stroke-linejoin:round; vertical-align:-.18em; }}
  .xterm, .xterm-viewport {{ touch-action:none; }}
  @keyframes micpulse {{ 50% {{ opacity:.55; }} }}
</style></head>
<body>
  <header>
    <a href="/" title="back to the humble hub">⌂ hub</a>
    <h1>{safe}</h1>
    <span class="sub">claude code</span>
  </header>
  <div id="term"></div>
  <div id="kbar"></div>
  <script src="/static/vendor/xterm.min.js"></script>
  <script src="/static/vendor/addon-fit.min.js"></script>
  <script>
    const term = new Terminal({{
      fontFamily: "'JetBrains Mono', 'Hack', 'Noto Sans Mono', monospace",
      fontSize: 14, cursorBlink: true, customGlyphs: true,
      theme: xtermTheme(resolveTheme(localStorage.getItem("hubTheme") || "codex")),
    }});
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById("term"));
    fit.fit();
    term.focus();

    // live-sync the theme if it's changed on the hub in another tab
    window.addEventListener("storage", e => {{
      if (e.key !== "hubTheme") return;
      const k = resolveTheme(e.newValue || "codex");
      term.options.theme = xtermTheme(k);
      term.refresh(0, term.rows - 1);
      const d = THEME[k].term, r = document.documentElement.style;
      r.setProperty("--t-bg", d.bg); r.setProperty("--t-fg", d.fg);
      r.setProperty("--t-panel", _shade(d.bg, 10)); r.setProperty("--t-border", _shade(d.bg, 20));
      r.setProperty("--t-accent", d.ansi[12] || d.ansi[4]); r.setProperty("--t-faint", d.ansi[8]);
      r.setProperty("--t-font", THEME[k].font);
    }});

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${{wsProto}}://${{location.host}}/ws/terminal/{safe}{ws_query}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({{type:"resize", cols:term.cols, rows:term.rows}}));
    ws.onmessage = e => term.write(new Uint8Array(e.data));
    ws.onclose = () => term.write("\\r\\n\\x1b[33m[session ended — refresh to start a new one]\\x1b[0m\\r\\n");
    term.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({{type:"input", data:d}})));
    new ResizeObserver(() => {{
      fit.fit();
      ws.readyState === 1 && ws.send(JSON.stringify({{type:"resize", cols:term.cols, rows:term.rows}}));
    }}).observe(document.getElementById("term"));

    // on-screen key toolbar (touch): arrows/Enter/Space/Esc/Tab/Ctrl-C → pty.
    // No term.focus() after sends — refocusing xterm's hidden textarea pops
    // the phone's soft keyboard open on every tap.
    const sendKey = seq => {{
      if (ws.readyState === 1) ws.send(JSON.stringify({{type:"input", data:seq}}));
    }};
    const _ic = s => '<svg viewBox="0 0 24 24" aria-hidden="true">' + s + '</svg>';
    const I_UP = _ic('<path d="M12 19V6"/><path d="M6 12l6-6 6 6"/>');
    const I_DOWN = _ic('<path d="M12 5v13"/><path d="M6 12l6 6 6-6"/>');
    const I_LEFT = _ic('<path d="M19 12H6"/><path d="M12 6l-6 6 6 6"/>');
    const I_RIGHT = _ic('<path d="M5 12h13"/><path d="M12 6l6 6-6 6"/>');
    const I_ENTER = _ic('<path d="M20 6v5a3 3 0 0 1-3 3H5"/><path d="M9 10l-4 4 4 4"/>');
    const I_MIC = _ic('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>');
    const keys = [["up","\\x1b[A","",I_UP],["down","\\x1b[B","",I_DOWN],
      ["left","\\x1b[D","",I_LEFT],["right","\\x1b[C","",I_RIGHT],
      ["enter","\\r","wide",I_ENTER],["space"," ","wide"],["esc","\\x1b","wide"],
      ["tab","\\t","wide"],["⌃C","\\x03","wide"]];
    const kbar = document.getElementById("kbar");
    for (const [label, seq, cls, ic] of keys) {{
      const btn = document.createElement("button");
      if (ic) {{ btn.innerHTML = ic; }} else {{ btn.textContent = label; }}
      if (cls) btn.className = cls;
      btn.title = label;
      btn.addEventListener("pointerdown", e => e.preventDefault());
      btn.addEventListener("click", () => sendKey(seq));
      kbar.appendChild(btn);
    }}

    // phone: translate vertical swipes into wheel events (TUIs have no
    // native scrollback for finger panning)
    let _ty = null;
    const termEl = document.getElementById("term");
    termEl.addEventListener("touchstart", e => {{ _ty = e.touches[0].clientY; }}, {{passive:true}});
    termEl.addEventListener("touchmove", e => {{
      if (_ty === null) return;
      const y = e.touches[0].clientY, dy = _ty - y;
      if (Math.abs(dy) >= 10) {{
        _ty = y;
        const t = termEl.querySelector(".xterm-viewport") || termEl;
        t.dispatchEvent(new WheelEvent("wheel", {{deltaY: dy * 2.5, bubbles: true, cancelable: true}}));
      }}
      e.preventDefault();
    }}, {{passive:false}});
    termEl.addEventListener("touchend", () => {{ _ty = null; }}, {{passive:true}});

    // mic — browser speech recognition typed straight into the pty;
    // tap to start (red pulse), tap to stop, ⏎ still sends.
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = document.createElement("button");
    mic.className = "wide mic";
    mic.innerHTML = I_MIC;
    mic.title = "dictate (browser speech recognition)";
    let rec = null;
    mic.addEventListener("pointerdown", e => e.preventDefault());
    mic.addEventListener("click", () => {{
      if (!SR) {{ mic.disabled = true; mic.innerHTML = I_MIC + "✕";
        alert("This browser has no speech recognition (Firefox doesn't) — use Chrome."); return; }}
      if (!window.isSecureContext) {{
        alert("Mic needs a secure page — use the https tailnet URL, not plain http."); return; }}
      if (rec) {{ rec.stop(); return; }}
      rec = new SR();
      rec.lang = "en-US";
      rec.continuous = true;
      rec.interimResults = false;
      rec.onresult = ev => {{
        let text = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {{
          if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
        }}
        if (text.trim()) sendKey(text.trim() + " ");
      }};
      rec.onend = () => {{ rec = null; mic.classList.remove("rec"); }};
      rec.onerror = ev => {{
        if (!mic.dataset.warned) {{ mic.dataset.warned = "1";
          alert("Mic error: " + ev.error +
                (ev.error === "not-allowed" ? " — allow microphone for this site." : "")); }}
      }};
      mic.classList.add("rec");
      rec.start();
    }});
    kbar.appendChild(mic);
  </script>
</body></html>"""


# ---------------------------------------------------------------------------
# Page

# inline chat icon (stroke = currentColor) — replaces the 🗨 emoji
CHAT_SVG = ('<svg class="i" viewBox="0 0 24 24" aria-hidden="true">'
            '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7'
            ' 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8'
            ' 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>'
            '</svg>')

# Unified hand-inked line-art icon set — one visual language across the hub.
# Inner SVG markup only; icon() wraps it. They inherit the `svg.i` CSS (24×24
# viewBox, fill:none, stroke=currentColor) so every icon follows the theme.
ICONS = {
    "site":    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>'
               '<path d="M12 3c5 2.6 5 15.4 0 18"/><path d="M12 3c-5 2.6-5 15.4 0 18"/>',
    "app":     '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>'
               '<path d="M6.5 6.5h.01"/>',
    "code":    '<path d="M9 8l-4 4 4 4"/><path d="M15 8l4 4-4 4"/>',
    "notes":   '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4"/>'
               '<path d="M10 13h6"/><path d="M10 17h6"/>',
    "service": '<rect x="4" y="4" width="16" height="6" rx="1"/>'
               '<rect x="4" y="14" width="16" height="6" rx="1"/>'
               '<path d="M8 7h.01"/><path d="M8 17h.01"/>',
    "empty":   '<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>',
    "audio":   '<path d="M9 17V5l11-2v12"/><circle cx="6" cy="17" r="3"/><circle cx="17" cy="15" r="3"/>',
    "open":    '<path d="M8 5v14l11-7z"/>',
    "stop":    '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    "dot":     '<circle cx="12" cy="12" r="5"/>',
    "close":   '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    "min":     '<path d="M5 18h14"/>',
    "expand":  '<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/>',
    "chats":   '<path d="M4 5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-1-2V7a2 2 0 0 1 2-2z"/>',
    "todo":    '<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/>'
               '<path d="M4 6l1.4 1.4L8 5"/><path d="M4 12l1.4 1.4L8 11"/><path d="M4 18l1.4 1.4L8 17"/>',
    "ideas":   '<path d="M9 18h6"/><path d="M10 21h4"/>'
               '<path d="M12 3a6 6 0 0 1 3.7 10.7c-.6.5-.9 1-.9 1.8H9.2c0-.8-.3-1.3-.9-1.8A6 6 0 0 1 12 3z"/>',
    "star":    '<path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.15 1 5.85L12 17l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z"/>',
}


def icon(name: str, cls: str = "i") -> str:
    return f'<svg class="{cls}" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'
TYPE_LABELS = {
    "site": "site",
    "app": "app",
    "code": "code",
    "notes": "notes",
    "empty": "empty",
    "service": "service",
}


def glyph(p: dict) -> str:
    """Hand-inked glyph for a project — .desktop icon hints beat type defaults."""
    icon_hint = ""
    if p.get("desktop"):
        for line in Path(p["desktop"]).read_text(errors="replace").splitlines():
            if line.startswith("Icon="):
                icon_hint = line[5:].lower()
    if "audio" in icon_hint or "music" in icon_hint:
        return icon("audio")
    return icon(p["type"])


def card(p: dict, favs: set = frozenset(), peers: list = ()) -> str:
    name = html.escape(p["name"])
    fav_on = " on" if p["name"] in favs else ""
    # show the declared port on service cards; flag it red if another project
    # declares the same port (idea #10 — port conflicts like the :5000 one)
    if p.get("port"):
        if peers:
            port_html = (f'<span class="svc-port warn" title="⚠ port {p["port"]} also '
                         f'declared by {", ".join(peers)}">:{p["port"]}</span>')
        else:
            port_html = f'<span class="svc-port" title="serves on port {p["port"]}">:{p["port"]}</span>'
    else:
        port_html = ""
    buttons = [
        f"""<div class="menu">
          <button class="b-claude" onclick="openDrawer('{name}')">{CHAT_SVG} claude ▾</button>
          <div class="menu-items">
            <button onclick="openDrawer('{name}')">fresh chat</button>
            <button onclick="openDrawer('{name}', true)">resume chat</button>
            <button onclick="act('{name}','terminal')">in konsole</button>
          </div>
        </div>""",
        f"""<button class="b-files" onclick="act('{name}','folder')" title="Open in Dolphin">files</button>""",
    ]
    if p.get("github"):
        buttons.append(
            f"""<a class="btn" href="{html.escape(p['github'])}" target="_blank"
               title="remote repository">github</a>""")
    if p["type"] == "site":
        buttons.insert(0, f"""<a class="btn b-go" href="{p['site']}" target="_blank">{icon("open")} open site</a>""")
    if p["type"] == "app":
        buttons.insert(0, f"""<button class="b-go" onclick="act('{name}','launch')">{icon("open")} launch</button>""")
    if p.get("serve"):  # service controls — may sit on any type (hub.json type override)
        buttons.insert(0, f"""<button class="b-go" onclick="openService('{name}')">{icon("open")} open</button>""")
        buttons.append(f"""<button class="b-stop" data-stop="{name}"
          onclick="stopService('{name}')" title="stop the service"
          style="display:none">{icon("stop")}</button>""")
    meta = html.escape(p["last_commit"]) if p.get("last_commit") else ""
    if p.get("dirty"):
        meta += " · ✱ wet ink"
    # the port lives on the meta line, not the head — keeps it from squeezing the
    # title onto a second line
    meta_line = " · ".join(x for x in (port_html, meta) if x)
    excerpt = md_inline(p.get("excerpt") or "")
    search_blob = html.escape(f"{p['name']} {p.get('excerpt') or ''}".lower())
    svc_dot = (f"""<span class="svc-dot" data-svc="{name}" title="stopped">{icon("dot")}</span>"""
               if p.get("serve") else "")
    return f"""
    <div class="card" data-type="{p['type']}" data-name="{name}" data-text="{search_blob}">
      <div class="head">
        <span class="glyph">{glyph(p)}</span>
        <h2>{name}</h2>
        {svc_dot}<span class="kind">{TYPE_LABELS[p["type"]]}</span>
        <button class="b-fav{fav_on}" data-fav="{name}" title="favorite — pin to top">{icon("star")}</button>
      </div>
      <p class="excerpt">{f'“{excerpt}”' if excerpt else ''}</p>
      <p class="meta">{meta_line}</p>
      <div class="actions">{''.join(buttons)}</div>
    </div>"""


@app.get("/", response_class=HTMLResponse)
def index():
    favs = set(get_notes().get("favorites", []))
    # favourites first (stable sort keeps each group alphabetical)
    projects = sorted(scan(), key=lambda p: p["name"] not in favs)
    # map declared ports → projects, to flag conflicts (idea #10)
    port_use: dict = {}
    for p in projects:
        if p.get("port"):
            port_use.setdefault(p["port"], []).append(p["name"])
    cards = "".join(
        card(p, favs, [n for n in port_use.get(p.get("port"), []) if n != p["name"]])
        for p in projects)
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>the humble hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/static/favicon.ico" sizes="any">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/static/manifest.webmanifest">
<meta name="theme-color" content="#43331c">
<link rel="stylesheet" href="/static/vendor/xterm.min.css">
<style>
  :root {{ color-scheme: light;
    --font-family:"EB Garamond", "Noto Serif", Georgia, serif;
    --ink:#43331c; --ink-soft:#6e5a39; --ink-faint:#9c875f;
    --parchment:#efe2c0; --paper:#f6edd6;
    --lapis:#2f5277; --sanguine:#9a3b22; --verdigris:#4f6b3a;
    --ochre:#8a6d1f; --plum:#5a3d6e;
    --bg-hi:#f7edd3; --bg-mid:#f2e6c6; --bg-lo:#e2d2a8;
    --card-bg:rgba(255,250,235,.35); --card-hot:rgba(255,250,235,.7);
    --input-bg:rgba(255,250,235,.5); }}
  body {{ color:var(--ink); font:16px/1.55 var(--font-family);
    margin:0; height:100vh; overflow:hidden;
    background:
      radial-gradient(ellipse at 15% 8%, var(--bg-hi) 0%, transparent 55%),
      radial-gradient(ellipse at 85% 95%, var(--bg-lo) 0%, transparent 55%),
      radial-gradient(ellipse at 60% 40%, var(--bg-mid) 0%, transparent 70%),
      var(--parchment); }}
  /* the shelf is the scroll container, so its scrollbar sits at its own right
     edge — left of the drawer when one is open */
  #shelf {{ height:100%; overflow-y:auto; box-sizing:border-box;
    padding:2.2rem 1.2rem; transition:margin-right .22s ease; }}
  #shelf > header, #shelf > .grid, #shelf > #jot {{ max-width:1100px;
    margin-left:auto; margin-right:auto; }}
  /* jottings: to-do + ideas, opened as modals from the controls row */
  .jot-open {{ background:transparent; border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.84rem;
    font-variant:small-caps; letter-spacing:.06em; padding:.3rem .75rem;
    cursor:pointer; }}
  .jot-open:hover {{ background:var(--ink); color:var(--parchment); }}
  /* match the jot buttons: strip the native select chrome, add a themed caret */
  .sel-wrap {{ position:relative; display:inline-flex; align-items:center; }}
  .sel-wrap::after {{ content:"▾"; position:absolute; right:.55rem; pointer-events:none;
    color:var(--ink-soft); font-size:.7rem; }}
  #mode-select {{ -webkit-appearance:none; appearance:none;
    background:transparent; border:1px solid var(--ink-soft); border-radius:2px;
    color:var(--ink); font:inherit; font-size:.84rem; font-variant:small-caps;
    letter-spacing:.06em; padding:.3rem 1.5rem .3rem .75rem; cursor:pointer; }}
  #mode-select:hover {{ background:var(--ink); color:var(--parchment); }}
  #mode-select option {{ background:var(--paper); color:var(--ink); }}
  #overlay {{ position:fixed; inset:0; background:rgba(67,51,28,.4); z-index:60;
    display:flex; align-items:flex-start; justify-content:center;
    padding-top:11vh; }}
  #overlay[hidden] {{ display:none; }}
  #modal {{ width:min(560px, 92vw); background:var(--parchment);
    border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
    outline-offset:4px; border-radius:2px; padding:1rem 1.2rem;
    box-shadow:3px 5px 18px rgba(40,30,15,.45); position:relative;
    display:flex; flex-direction:column; max-height:72vh; }}
  .m-head {{ display:flex; align-items:center; }}
  .m-head h3 {{ margin:0; flex:1; font-size:1rem; font-weight:600;
    font-variant:small-caps; letter-spacing:.08em; color:var(--ink); }}
  #confirm {{ position:absolute; inset:0; background:rgba(239,226,192,.96);
    display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:.6rem; padding:1rem; border-radius:2px; }}
  #confirm[hidden] {{ display:none; }}
  #confirm p {{ margin:0; font-style:italic; text-align:center; }}
  .confirm-row {{ display:flex; gap:.7rem; }}
  /* the list scrolls; the add-input stays pinned below it */
  .jot-col {{ padding:.5rem .1rem 0; flex:1; min-height:0;
    display:flex; flex-direction:column; }}
  .jot-col ul {{ overflow-y:auto; min-height:0; overscroll-behavior:contain;
    padding-right:1.1rem; scrollbar-gutter:stable;
    /* thin, ink-tinted scrollbar — the default overlay one expands on
       hover and floats over the ✕ buttons */
    scrollbar-width:thin; scrollbar-color:var(--ink-faint) transparent; }}
  #shelf {{ scrollbar-width:thin; scrollbar-color:var(--ink-faint) transparent; }}
  .jot-col li .txt {{ white-space:pre-wrap; overflow-wrap:anywhere; cursor:text; }}
  .jot-col li:hover {{ background:var(--card-hot); }}
  .jot-col ul {{ list-style:none; margin:0; padding:0; }}
  .jot-col li {{ display:flex; align-items:baseline; gap:.5rem; padding:.18rem 0;
    font-size:.92rem; border-bottom:1px dotted rgba(156,135,95,.4); }}
  .jot-col li.done .txt {{ text-decoration:line-through; color:var(--ink-faint); }}
  .jot-col li .txt {{ flex:1; }}
  .jot-col li .del {{ border:0; background:transparent; color:var(--ink-faint);
    cursor:pointer; font:inherit; padding:0 .2rem; }}
  .jot-col li .del:hover {{ color:var(--sanguine); background:transparent; }}
  .jot-col input[type="checkbox"] {{ accent-color:var(--verdigris); }}
  .jot-col form input[type="text"], .jot-col form input:not([type]) {{ width:100%;
    box-sizing:border-box; margin-top:.5rem; background:transparent;
    border:0; border-bottom:1px solid var(--ink-faint); color:var(--ink);
    font:inherit; font-size:.9rem; padding:.2rem .1rem; outline:none; }}
  .jot-col form input::placeholder {{ color:var(--ink-faint); font-style:italic; }}
  .edit-input {{ flex:1; background:transparent; border:0;
    border-bottom:1px solid var(--ink-soft); color:var(--ink); font:inherit;
    font-size:.92rem; padding:0 .1rem; outline:none; resize:none;
    line-height:1.45; max-height:9.8rem; overflow-y:auto; }}
  header {{ text-align:center; margin-bottom:2rem; }}
  h1 {{ margin:0; font-size:1.9rem; font-weight:600; letter-spacing:.35em;
        font-variant:small-caps; }}
  .rule {{ width:60%; margin:.9rem auto 0; border:0; border-top:1.5px solid var(--ink-soft);
           position:relative; }}
  .rule::after {{ content:"❧"; position:absolute; top:-0.75em; left:50%;
                  transform:translateX(-50%); background:var(--parchment);
                  padding:0 .6em; color:var(--ink-soft); }}
  .controls {{ margin-top:1.1rem; display:flex; gap:.7rem; justify-content:center;
               align-items:center; flex-wrap:wrap; }}
  #search {{ background:var(--input-bg); border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.9rem;
    padding:.35rem .7rem; width:240px; }}
  #search::placeholder {{ color:var(--ink-faint); font-style:italic; }}
  /* category chips are NEUTRAL — icon + text tell them apart; the pigments are
     reserved for the action buttons (lapis=claude, sanguine=go, verdigris=files)
     so a colour means one thing. Chips only carry an active/inactive state. */
  .chip {{ background:transparent; border:1px solid var(--ink-soft);
    border-radius:999px; color:var(--ink-soft); font:inherit;
    font-size:.78rem; font-variant:small-caps; letter-spacing:.05em;
    padding:.15rem .65rem; cursor:pointer; }}
  .chip:hover {{ border-color:var(--ink); color:var(--ink); }}
  .chip.active {{ background:var(--ink); border-color:var(--ink); color:var(--parchment); }}
  /* service status dot + stop control */
  svg.i {{ width:1em; height:1em; vertical-align:-.12em;
    fill:none; stroke:currentColor; stroke-width:2;
    stroke-linecap:round; stroke-linejoin:round; }}
  .svc-dot {{ font-size:.9rem; color:var(--ink-faint); }}
  .svc-dot.on {{ color:var(--verdigris); }}
  .b-stop {{ color:var(--ink-faint); border-color:var(--ink-faint); padding:.3rem .5rem; }}
  .b-stop:hover {{ background:var(--sanguine); border-color:var(--sanguine); color:var(--parchment); }}
  /* side-drawer terminal — pushes the shelf aside rather than covering it */
  :root {{ --drawer-w: min(680px, 58vw); }}
  body.drawer-open #shelf {{ margin-right:var(--drawer-w); }}
  body.drawer-open #pills {{ right:calc(var(--drawer-w) + 1.1rem); }}
  #drawer {{ position:fixed; top:0; right:0; height:100vh; width:var(--drawer-w);
    background:var(--term-bg, #1a1b26); border-left:2px solid var(--ink-soft);
    box-shadow:-4px 0 18px rgba(67,51,28,.4); transform:translateX(105%);
    transition:transform .22s ease; display:flex; flex-direction:column; z-index:50; }}
  #drawer.open {{ transform:none; }}
  /* keep terminal wheel events from chaining into the page scroll */
  .xterm-viewport {{ overscroll-behavior:contain; }}
  .d-head {{ display:flex; align-items:center; gap:.7rem; padding:.4rem .8rem;
    background:var(--parchment); border-bottom:1.5px solid var(--ink-soft);
    color:var(--ink); }}
  .d-head h2 {{ margin:0; flex:1; font-size:.98rem; font-weight:600;
    font-variant:small-caps; letter-spacing:.07em; }}
  .d-head a, .d-head button {{ border:0; background:transparent; color:var(--lapis);
    font:inherit; font-size:1rem; cursor:pointer; padding:.1rem .35rem;
    text-decoration:none; }}
  .d-head a:hover, .d-head button:hover {{ color:var(--sanguine); background:transparent; }}
  #dterm {{ flex:1; min-height:0; padding:.3rem; position:relative;
    background:var(--term-bg, #1a1b26); }}
  .term-host {{ position:absolute; inset:.3rem; display:none; }}
  .term-host.shown {{ display:block; }}
  /* status pills for live sessions */
  #pills {{ position:fixed; right:1.1rem; bottom:1.1rem; z-index:40;
    display:flex; flex-direction:column; gap:.5rem; align-items:flex-end; }}
  .pill {{ background:var(--lapis); color:var(--parchment); border:0; border-radius:999px;
    padding:.45rem .95rem; font:inherit; font-size:.88rem; font-variant:small-caps;
    letter-spacing:.06em; cursor:pointer; box-shadow:2px 3px 10px rgba(67,51,28,.4);
    display:inline-flex; align-items:center; gap:.45rem; }}
  /* the active session keeps its pill (stable order) — ringed, not hidden */
  .pill.active {{ outline:2.5px solid var(--ink); outline-offset:2px; }}
  .pill .dot {{ width:.55rem; height:.55rem; border-radius:50%; background:#c8b88a; }}
  .pill.s-working .dot {{ background:#e0af68; }}
  .pill.s-ready .dot {{ background:#9ece6a; }}
  .pill.s-attention .dot {{ background:#f7768e; animation:throb 1s infinite; }}
  .pill.s-ended {{ opacity:.65; }}
  @keyframes throb {{ 50% {{ transform:scale(1.5); opacity:.6; }} }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:1.3rem; }}
  .card {{ border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
    outline-offset:4px; border-radius:2px; padding:1rem 1.2rem;
    display:flex; flex-direction:column; gap:.45rem; position:relative;
    background:var(--card-bg); box-shadow:2px 3px 8px rgba(67,51,28,.18); }}
  /* lift the hovered card so its dropdown isn't painted under later cards */
  .card:hover {{ z-index:10; }}
  .head {{ display:flex; align-items:center; gap:.6rem; }}
  .glyph {{ font-size:1.45rem; line-height:1; }}
  .card h2 {{ margin:0; font-size:1.12rem; font-weight:600; flex:1;
              font-variant:small-caps; letter-spacing:.05em; }}
  .kind {{ font-style:italic; color:var(--ink-faint); font-size:.82rem; }}
  /* declared service port; red when another project declares the same one */
  .svc-port {{ font-family:"JetBrains Mono","Noto Sans Mono",monospace; font-size:.72rem;
    color:var(--ink-faint); }}
  .svc-port.warn {{ color:var(--sanguine); font-weight:700; }}
  /* favourite toggle — outline star, fills ochre when pinned to the top */
  .b-fav {{ border:0; background:transparent; color:var(--ink-faint); cursor:pointer;
    padding:.1rem .15rem; line-height:0; }}
  .b-fav:hover {{ color:var(--ochre); background:transparent; }}
  .b-fav.on {{ color:var(--ochre); }}
  .b-fav.on svg.i {{ fill:currentColor; }}
  .excerpt {{ margin:0; font-style:italic; color:var(--ink-soft); font-size:.92rem;
              min-height:2.8em; display:-webkit-box; -webkit-line-clamp:4;
              -webkit-box-orient:vertical; overflow:hidden; }}
  .excerpt a {{ color:var(--lapis); text-decoration:underline; }}
  .excerpt strong {{ font-style:normal; font-weight:700; color:var(--ink); }}
  .excerpt code {{ font-style:normal; font-family:"JetBrains Mono","Noto Sans Mono",monospace;
              font-size:.85em; background:var(--input-bg); padding:0 .25em; border-radius:2px; }}
  .meta {{ margin:0; color:var(--ink-faint); font-size:.78rem; }}
  /* pinned to the card bottom so every panel's buttons align across the row */
  .actions {{ display:flex; gap:.55rem; margin-top:auto; padding-top:.6rem; flex-wrap:wrap;
    align-items:center; }}
  button, .btn {{ background:transparent; color:var(--ink); border:1px solid var(--ink-soft);
    border-radius:2px; padding:.3rem .75rem; font:inherit; font-size:.84rem; line-height:1.3;
    font-variant:small-caps; letter-spacing:.06em; cursor:pointer; text-decoration:none;
    display:inline-flex; align-items:center; gap:.32em; box-sizing:border-box; }}
  /* filled status dot when a service is running (outline when stopped) */
  .svc-dot.on svg.i {{ fill:currentColor; }}
  button:hover, .btn:hover {{ background:var(--ink); color:var(--parchment); }}
  /* manuscript pigments: sanguine, lapis, verdigris */
  .b-go     {{ color:var(--sanguine); border-color:var(--sanguine); }}
  .b-go:hover     {{ background:var(--sanguine); color:var(--parchment); }}
  .b-claude {{ color:var(--lapis); border-color:var(--lapis); }}
  .b-claude:hover {{ background:var(--lapis); color:var(--parchment); }}
  .b-files  {{ color:var(--verdigris); border-color:var(--verdigris); }}
  .b-files:hover  {{ background:var(--verdigris); color:var(--parchment); }}
  /* hover menu on the claude button */
  .menu {{ position:relative; display:inline-flex; }}
  .menu-items {{ display:none; position:absolute; left:0; top:100%; z-index:5;
    min-width:11.5rem; flex-direction:column; background:var(--paper);
    border:1px solid var(--ink-soft); box-shadow:2px 3px 8px rgba(67,51,28,.25); }}
  .menu:hover .menu-items {{ display:flex; }}
  .menu-items.up {{ top:auto; bottom:100%; }}
  .menu-items a, .menu-items button {{ border:0; border-radius:0; text-align:left;
    padding:.42rem .8rem; color:var(--lapis); background:transparent; }}
  .menu-items a:hover, .menu-items button:hover {{ background:var(--lapis);
    color:var(--parchment); }}
</style></head>
<body>
  <div id="shelf">
  <header>
    <h1>the humble hub</h1>
    <hr class="rule">
    <div class="controls">
      <div class="menu">
        <button class="b-claude" onclick="openDrawer('~')">{CHAT_SVG} root claude ▾</button>
        <div class="menu-items">
          <button onclick="openDrawer('~')">fresh chat</button>
          <button onclick="openDrawer('~', true)">resume chat</button>
          <button onclick="act('~','terminal')">in konsole</button>
        </div>
      </div>
      <span class="sel-wrap"><select id="mode-select"
             title="permission mode for newly opened chats"
             onchange="setChatMode(this.value)">
        <option value="default">mode: default</option>
        <option value="accept-edits">mode: accept edits</option>
        <option value="plan">mode: plan</option>
      </select></span>
      <button class="jot-open" onclick="openJot('todos')">{icon("todo")} to-do <span id="todos-count"></span></button>
      <button class="jot-open" onclick="openJot('ideas')">{icon("ideas")} ideas <span id="ideas-count"></span></button>
      <input id="search" type="search" placeholder="search…" autocomplete="off" oninput="refilter()">
      <span id="filters">
        <button class="chip active" data-type="" onclick="pick(this)">all</button>
        <button class="chip" data-type="site" onclick="pick(this)">{icon("site")} site</button>
        <button class="chip" data-type="service" onclick="pick(this)">{icon("service")} service</button>
        <button class="chip" data-type="app" onclick="pick(this)">{icon("app")} app</button>
        <button class="chip" data-type="code" onclick="pick(this)">{icon("code")} code</button>
        <button class="chip" data-type="notes" onclick="pick(this)">{icon("notes")} notes</button>
        <button class="chip" data-type="empty" onclick="pick(this)">{icon("empty")} empty</button>
      </span>
    </div>
  </header>
  <div class="grid">{cards}</div>
  </div>

  <div id="overlay" hidden>
    <div id="modal">
      <div class="m-head">
        <h3 id="m-title">to-do</h3>
        <button class="del" onclick="closeJot()" title="close">{icon("close")}</button>
      </div>
      <div class="jot-col" id="col-todos">
        <ul id="todos"></ul>
        <form onsubmit="return addItem(event,'todos')">
          <input id="todos-input" placeholder="add a task…" autocomplete="off"></form>
      </div>
      <div class="jot-col" id="col-ideas">
        <ul id="ideas"></ul>
        <form onsubmit="return addItem(event,'ideas')">
          <input id="ideas-input" placeholder="jot an idea…" autocomplete="off"></form>
      </div>
      <div id="confirm" hidden>
        <p id="confirm-text"></p>
        <div class="confirm-row">
          <button class="b-go" onclick="doDelete()">remove</button>
          <button onclick="cancelDelete()">keep</button>
        </div>
      </div>
    </div>
  </div>

  <aside id="drawer">
    <div class="d-head">
      <h2 id="d-title"></h2>
      <a id="d-full" href="#" title="open as full page">{icon("expand")}</a>
      <button onclick="minimizeDrawer()" title="minimize — keeps the chat alive">{icon("min")}</button>
      <button onclick="closeActive()" title="end the session">{icon("close")}</button>
    </div>
    <div id="dterm"></div>
  </aside>
  <div id="pills"></div>

  <script src="/static/vendor/xterm.min.js"></script>
  <script src="/static/vendor/addon-fit.min.js"></script>
  <script src="/static/themes.js"></script>
  <script src="/static/hub.js"></script>
</body></html>"""
