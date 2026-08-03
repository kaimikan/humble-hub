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
import io
import json
import os
import pty
import re
import signal
import struct
import subprocess
import sys
import termios
import time
import uuid
import zlib
from pathlib import Path

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
import pillow_heif

pillow_heif.register_heif_opener()  # so iPhone/Oppo HEIC uploads open like JPEGs

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
    # commits ahead of upstream = unpushed work; "" if there's no upstream set
    ahead_raw = run("rev-list", "--count", "@{u}..HEAD")
    ahead = int(ahead_raw) if ahead_raw.isdigit() else 0
    has_upstream = bool(run("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"))
    return {
        "last_commit": run("log", "-1", "--format=%ad — %s", "--date=format:%Y-%m-%d"),
        "last_commit_at": run("log", "-1", "--format=%ct"),  # epoch, for sorting
        "dirty": bool(run("status", "--porcelain")),
        "ahead": ahead,                 # unpushed commits
        "no_upstream": not has_upstream and bool(remote),  # has a remote but no tracking branch
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
    svc, forced_type, glyph_char = {}, None, ""
    manifest = path / "hub.json"
    if manifest.is_file():
        try:
            m = json.loads(manifest.read_text())
            if m.get("serve") and m.get("port"):
                svc = {"serve": m["serve"], "port": int(m["port"])}
            if m.get("type"):
                forced_type = m["type"]
            if m.get("glyph"):
                glyph_char = str(m["glyph"])[:3]
        except (json.JSONDecodeError, ValueError, TypeError):
            pass  # malformed manifest → heuristics only

    info = _heuristic_type(path)
    if forced_type:
        info["type"] = forced_type
    elif svc:
        info["type"] = "service"
    info.update(svc)
    if glyph_char:
        info["glyph_char"] = glyph_char
    for cand in ("icon.svg", "favicon.svg", "static/icon.svg", "static/favicon.svg"):
        if (path / cand).is_file():
            info["icon_file"] = cand
            break
    return info


def last_session_mtime(path: Path) -> int:
    """Newest Claude-session transcript for the project — chatting counts as
    working on it even when nothing was committed."""
    d = CLAUDE_PROJECTS / _encode_cwd(path)
    try:
        return int(max((f.stat().st_mtime for f in d.glob("*.jsonl")), default=0))
    except OSError:
        return 0


def scan() -> list:
    projects = []
    for path in sorted(PROJECTS_DIR.iterdir()):
        if not path.is_dir() or SKIP.match(path.name) or path == HUB_DIR:
            continue
        p = {
            "name": path.name,
            "path": str(path),
            "excerpt": readme_excerpt(path),
            **detect(path),
            **git_info(path),
        }
        p["last_active"] = max(int(p.get("last_commit_at") or 0),
                               last_session_mtime(path))
        projects.append(p)
    return projects


app.mount("/static", StaticFiles(directory=HUB_DIR / "static"))


@app.middleware("http")
async def static_no_cache(request, call_next):
    """`Cache-Control: no-cache` on static assets = always revalidate (ETag
    makes that a cheap 304). Belt-and-braces on top of sv()'s ?v= busting —
    heuristic caching has served stale hub.js/themes.js before, which shows
    up as 'the JS-injected styling is missing' while the page looks fresh."""
    response = await call_next(request)
    if request.url.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache"
    return response

# Uploaded images live under data/ (git-ignored — never committed) and are
# served read-only at /attachments/<id>.jpg. See the upload endpoint below.
ATTACH_DIR = HUB_DIR / "data" / "attachments"
ATTACH_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/attachments", StaticFiles(directory=ATTACH_DIR))


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


@app.get("/api/projects/{name}/icon")
def project_icon(name: str):
    """A project's own mark (icon.svg/favicon.svg), when it has one — the
    card's glyph chain prefers it over the auto monogram."""
    path = project_path(name)
    rel = detect(path).get("icon_file")
    if not rel:
        raise HTTPException(404, "project has no icon file")
    return FileResponse(path / rel)


@app.get("/api/projects")
def api_projects():
    return scan()


@app.get("/api/activity")
def api_activity():
    """Per-project git status for the activity panel (T42c) — and the data a
    reconcile pass reads: recent commit subjects + unpushed/dirty signals.
    Carries `last_reconcile` (the T42d marker) and per-project
    `new_since_reconcile` = commits since that marker, so the panel can show
    "what changed since I last reconciled". Sorted actionable-first (new since
    reconcile, unpushed, or dirty), then by most recent commit."""
    marker = _read_notes().get("lastReconcile")
    out = []
    for p in scan():
        path = Path(p["path"])
        if not (path / ".git").is_dir():
            continue
        recent = subprocess.run(
            ["git", "-C", str(path), "log", "-8", "--format=%h\t%cr\t%s"],
            capture_output=True, text=True).stdout.strip().splitlines()
        # commits since the last reconcile (git accepts @<epoch> in --since)
        new_since = 0
        if marker:
            n = subprocess.run(
                ["git", "-C", str(path), "rev-list", "--count",
                 f"--since=@{int(marker)}", "HEAD"],
                capture_output=True, text=True).stdout.strip()
            new_since = int(n) if n.isdigit() else 0
        out.append({
            "name": p["name"], "type": p["type"], "github": p.get("github", ""),
            "last_commit": p.get("last_commit", ""),
            "last_commit_at": int(p.get("last_commit_at") or 0),
            "ahead": p.get("ahead", 0), "dirty": bool(p.get("dirty")),
            "no_upstream": p.get("no_upstream", False),
            "new_since_reconcile": new_since,
            "recent": [dict(zip(("h", "when", "subject"), ln.split("\t", 2))) for ln in recent],
        })
    out.sort(key=lambda x: (0 if (x["new_since_reconcile"] or x["ahead"]
                                  or x["dirty"] or x["no_upstream"]) else 1,
                            -x["last_commit_at"]))
    return {"last_reconcile": int(marker) if marker else None, "projects": out}


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
_NOTES_LOCK = __import__("threading").Lock()


def _read_notes() -> dict:
    if NOTES_FILE.is_file():
        return json.loads(NOTES_FILE.read_text())
    return {"todos": [], "ideas": []}


def _write_notes(doc: dict) -> None:
    NOTES_FILE.parent.mkdir(exist_ok=True)
    NOTES_FILE.write_text(json.dumps(doc, ensure_ascii=False, indent=1))


@app.get("/api/notes")
def get_notes():
    return _read_notes()


@app.put("/api/notes")
def put_notes(doc: dict):
    _write_notes(doc)
    return {"ok": True}


@app.post("/api/notes/{kind}")
def append_note(kind: str, item: dict):
    """Append a single to-do/idea WITHOUT sending the whole doc — so any session
    (or a one-line curl) can file a linked item without clobbering concurrent
    edits. `item`: {text, project?}. Locked read-modify-write (T42)."""
    if kind not in ("todos", "ideas"):
        raise HTTPException(404, "kind must be 'todos' or 'ideas'")
    text = (item.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "text is required")
    entry = {"text": text}
    if kind == "todos":
        entry["done"] = False
    if item.get("project"):
        entry["project"] = str(item["project"])
    with _NOTES_LOCK:
        doc = _read_notes()
        doc.setdefault(kind, []).append(entry)
        _write_notes(doc)
    return {"ok": True, "added": entry}


# --- image uploads (attach to a jot, or drop into the inbox) ---

MAX_IMG_DIM = 2000  # downscale the long edge to this; phone shots are far larger


@app.post("/api/upload")
async def upload_images(files: list[UploadFile] = File(...)):
    """Accept one or more image uploads (multipart/form-data, field `files`),
    normalise each to a web-safe, downscaled JPEG — HEIC included, orientation
    honoured, EXIF (incl. GPS) dropped on re-encode — store under
    data/attachments/, and return the new ids. The caller decides what to do
    with them: attach to a to-do/idea, or push into notes.inbox. Reached from
    the phone over `tailscale serve` (HTTPS, tailnet-only); no auth here because
    the whole hub is localhost + tailnet only."""
    out = []
    for f in files:
        raw = await f.read()
        try:
            img = Image.open(io.BytesIO(raw))
            img = ImageOps.exif_transpose(img)  # bake rotation in before stripping
            img = img.convert("RGB")
        except Exception:
            raise HTTPException(400, f"not a readable image: {f.filename}")
        img.thumbnail((MAX_IMG_DIM, MAX_IMG_DIM))  # in place, keeps aspect ratio
        name = uuid.uuid4().hex + ".jpg"
        img.save(ATTACH_DIR / name, "JPEG", quality=85, optimize=True)
        out.append({"id": name, "w": img.width, "h": img.height})
    return {"images": out}


@app.post("/api/reconcile")
def mark_reconciled():
    """Stamp 'now' as the last-reconcile marker (T42d). After a reconcile pass
    closes/adds to-dos, this bumps the timestamp so the activity panel's
    `new_since_reconcile` counts reset — the next pass only sees fresh work."""
    import time
    with _NOTES_LOCK:
        doc = _read_notes()
        doc["lastReconcile"] = int(time.time())
        _write_notes(doc)
    return {"ok": True, "at": doc["lastReconcile"]}


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
<link rel="stylesheet" href="{sv('/static/vendor/xterm.min.css')}">
<script src="{sv('/static/themes.js')}"></script>
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
  #hub-toast {{ position:fixed; left:50%; bottom:1.4rem; transform:translateX(-50%) translateY(1rem);
    background:var(--t-panel,#24283b); color:var(--t-fg,#c0caf5); border:1px solid var(--t-border,#3b4261);
    border-radius:6px; padding:.4rem .85rem; font:.85rem/1.2 "JetBrains Mono","Noto Sans Mono",monospace;
    opacity:0; pointer-events:none; transition:opacity .2s, transform .2s; z-index:50; }}
  #hub-toast.show {{ opacity:1; transform:translateX(-50%) translateY(0); }}
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
  <script src="{sv('/static/vendor/xterm.min.js')}"></script>
  <script src="{sv('/static/vendor/addon-fit.min.js')}"></script>
  <script>
    const term = new Terminal({{
      fontFamily: "'JetBrains Mono', 'Hack', 'Noto Sans Mono', monospace",
      fontSize: 14, cursorBlink: true, customGlyphs: true,
      theme: xtermTheme(resolveTheme(localStorage.getItem("hubTheme") || "codex")),
    }});
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    // Suppress the mouse-reporting Claude Code turns on: swallow the DECSET/
    // DECRST sequences that enable mouse tracking so xterm never enters mouse
    // mode — a plain drag then selects natively (and auto-copies, below).
    const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
    const swallowMouse = p => p.length > 0 && p.every(n => typeof n === "number" && MOUSE_MODES.has(n));
    term.parser.registerCsiHandler({{ prefix: "?", final: "h" }}, p => swallowMouse(p));
    term.parser.registerCsiHandler({{ prefix: "?", final: "l" }}, p => swallowMouse(p));
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

    // --- selection → clipboard --------------------------------------------
    // Claude Code enables mouse reporting, so a plain drag is forwarded to the
    // app (that's what powers click-to-navigate). Hold SHIFT to select instead
    // — xterm's force-selection modifier. The selection is canvas-drawn, NOT a
    // DOM selection, so the browser's own Ctrl+C can't see it; we copy a
    // settled selection ourselves. Ctrl+Shift+C/V like Konsole/GNOME Terminal.
    function hubToast(msg) {{
      let el = document.getElementById("hub-toast");
      if (!el) {{ el = document.createElement("div"); el.id = "hub-toast"; document.body.appendChild(el); }}
      el.textContent = msg; el.classList.add("show");
      clearTimeout(hubToast._t);
      hubToast._t = setTimeout(() => el.classList.remove("show"), 1800);
    }}
    function copyText(text) {{
      const done = ok => hubToast(ok ? "copied selection" : "copy blocked");
      if (navigator.clipboard && navigator.clipboard.writeText) {{
        navigator.clipboard.writeText(text).then(() => done(true)).catch(() => execCopy(text, done));
      }} else {{ execCopy(text, done); }}
    }}
    function execCopy(text, done) {{
      try {{
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand("copy"); ta.remove(); done(ok);
      }} catch (e) {{ done(false); }}
    }}
    // With mouse reporting suppressed (above), a plain drag selects natively.
    // The xterm selection is canvas-drawn (not a DOM selection), so the browser
    // can't copy it — we copy the settled selection ourselves. onSelectionChange
    // fires during the drag, so debounce to its end.
    let copyTimer = null;
    term.onSelectionChange(() => {{
      const sel = term.getSelection();
      clearTimeout(copyTimer);
      if (sel && sel.trim()) copyTimer = setTimeout(() => copyText(sel), 150);
    }});

    // Wheel → PgUp/PgDn. Mouse reporting is suppressed, so xterm would turn the
    // wheel into arrow keys (which Claude treats as navigation, not scroll — it
    // scrolls on PgUp/PgDn). Intercept first (capture + stopPropagation) and
    // send page keys instead. Throttled so a fast spin doesn't jump many pages.
    let lastWheel = 0;
    document.getElementById("term").addEventListener("wheel", e => {{
      e.preventDefault(); e.stopPropagation();
      const now = performance.now();
      if (now - lastWheel < 60) return;
      lastWheel = now;
      if (ws.readyState === 1)
        ws.send(JSON.stringify({{type:"input", data: e.deltaY < 0 ? "\\x1b[5~" : "\\x1b[6~"}}));
    }}, {{ capture: true, passive: false }});

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

    // phone: swipes → SGR mouse-wheel reports straight to the pty. Claude still
    // has mouse mode on (we only stopped xterm from entering it, to free text
    // selection), so it scrolls a few lines per report — smooth, line-by-line.
    // (Desktop keeps the snappier wheel→PgUp/PgDn; only touch uses this path.)
    let _ty = null;
    const termEl = document.getElementById("term");
    termEl.addEventListener("touchstart", e => {{ _ty = e.touches[0].clientY; }}, {{passive:true}});
    termEl.addEventListener("touchmove", e => {{
      if (_ty === null) return;
      const y = e.touches[0].clientY, dy = _ty - y;
      if (Math.abs(dy) >= 10) {{
        _ty = y;
        if (ws.readyState === 1) {{
          const btn = dy > 0 ? 65 : 64;  // swipe up = scroll down (65); down = up (64)
          const col = Math.max(1, Math.floor(term.cols / 2));
          const row = Math.max(1, Math.floor(term.rows / 2));
          ws.send(JSON.stringify({{type:"input", data:`\\x1b[<${{btn}};${{col}};${{row}}M`}}));
        }}
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
    # an open tray with an item dropping in — the image inbox (was 📥)
    "inbox":   '<path d="M12 3v8"/><path d="M9 8l3 3 3-3"/>'
               '<path d="M4 14h3l2 3h6l2-3h3v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>',
    # camera — the "drop an image" button (was 📷)
    "camera":  '<path d="M21 19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-2.2h5L16 7h3a2 2 0 0 1 2 2z"/>'
               '<circle cx="12" cy="13" r="3.6"/>',
    # paperclip — attach image(s) to a jot (was 📎, the "bobby pin")
    "attach":  '<path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.07-7.07l8.49-8.49a3.2 3.2 0 0 1 4.53 4.53'
               'l-8.49 8.49a1.4 1.4 0 0 1-1.98-1.98l7.6-7.6"/>',
}


def icon(name: str, cls: str = "i") -> str:
    return f'<svg class="{cls}" viewBox="0 0 24 24" aria-hidden="true">{ICONS[name]}</svg>'


def sv(path: str) -> str:
    """Cache-busting static URL: append the file's mtime as `?v=`. StaticFiles
    sends only ETag/Last-Modified, and some browsers (notably Android Chrome)
    heuristically reuse the cached copy WITHOUT revalidating — so an edited
    hub.js/themes.js can stay stale for hours. A changing query string forces a
    refetch the moment the file changes, on every browser."""
    f = HUB_DIR / path.lstrip("/")
    try:
        return f"{path}?v={int(f.stat().st_mtime)}"
    except OSError:
        return path
TYPE_LABELS = {
    "site": "site",
    "app": "app",
    "code": "code",
    "notes": "notes",
    "empty": "empty",
    "service": "service",
}


# the five stable accent pigments (see themes.js) — a name-hash picks one per
# project so its monogram keeps the same tint across visits and themes
PIGMENTS = ("lapis", "sanguine", "verdigris", "ochre", "plum")


def monogram(name: str) -> str:
    words = [w for w in name.split("-") if w]
    return (words[0][:2] if len(words) == 1
            else "".join(w[0] for w in words[:3])).upper()


def glyph(p: dict) -> str:
    """The project's mark: its own icon file beats a hub.json "glyph" character
    beats the auto ink monogram (initials on a pigment-tinted plate)."""
    if p.get("icon_file"):
        return (f'<img class="glyph-img" alt=""'
                f' src="/api/projects/{html.escape(p["name"])}/icon">')
    pigment = PIGMENTS[zlib.crc32(p["name"].encode()) % len(PIGMENTS)]
    mark = p.get("glyph_char") or monogram(p["name"])
    wide = " mono3" if len(mark) >= 3 else ""
    return f'<span class="mono{wide} p-{pigment}">{html.escape(mark)}</span>'


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
            <button class="m-arch" data-arch="{name}"
              onclick="toggleArchive('{name}')">archive</button>
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
    if p.get("ahead"):
        meta += f" · ↑{p['ahead']} unpushed"
    elif p.get("no_upstream"):
        meta += " · ↑ never pushed"
    # the port lives on the meta line, not the head — keeps it from squeezing the
    # title onto a second line
    meta_line = " · ".join(x for x in (port_html, meta) if x)
    excerpt = md_inline(p.get("excerpt") or "")
    search_blob = html.escape(f"{p['name']} {p.get('excerpt') or ''}".lower())
    svc_dot = (f"""<span class="svc-dot" data-svc="{name}" title="stopped">{icon("dot")}</span>"""
               if p.get("serve") else "")
    return f"""
    <div class="card" data-type="{p['type']}" data-name="{name}"
         data-act="{p.get('last_active', 0)}" data-text="{search_blob}">
      <div class="head">
        <span class="glyph">{glyph(p)}{icon(p["type"], "i tglyph")}</span>
        <h2>{name}</h2>
        {svc_dot}<span class="kind">{TYPE_LABELS[p["type"]]}</span>
        <button class="b-fav{fav_on}" data-fav="{name}" title="favorite — pin to top">{icon("star")}</button>
      </div>
      <p class="excerpt">{f'“{excerpt}”' if excerpt else ''}</p>
      <p class="meta">{meta_line}</p>
      <div class="actions">{''.join(buttons)}</div>
    </div>"""


ACTIVE_DAYS = 30  # "in motion" horizon — mirrored by ACTIVE_DAYS in hub.js
BAND_HEADS = {  # label + the hint that says what earns a project its band
    "pinned": ("pinned", "your ★ picks"),
    "motion": ("in motion", f"touched in the last {ACTIVE_DAYS} days"),
    "rest": ("the rest", "quiet for a month or more"),
}


@app.get("/", response_class=HTMLResponse)
def index():
    notes = get_notes()
    favs = set(notes.get("favorites", []))
    archived = set(notes.get("archived", []))
    projects = scan()
    # map declared ports → projects, to flag conflicts (idea #10)
    port_use: dict = {}
    for p in projects:
        if p.get("port"):
            port_use.setdefault(p["port"], []).append(p["name"])

    # the shelf self-organizes into bands — pinned (★), in motion (touched
    # within ACTIVE_DAYS, most recent first), the rest (alphabetical) — with
    # archived projects folded away below. hub.js reorderCards() mirrors this
    # so ★/archive toggles re-band without a reload.
    horizon = time.time() - ACTIVE_DAYS * 86400

    def band(p):
        if p["name"] in archived:
            return "archive"
        if p["name"] in favs:
            return "pinned"
        return "motion" if p.get("last_active", 0) >= horizon else "rest"

    bands: dict = {"pinned": [], "motion": [], "rest": [], "archive": []}
    for p in projects:
        bands[band(p)].append(p)
    bands["motion"].sort(key=lambda p: -p.get("last_active", 0))

    def render(p):
        return card(p, favs,
                    [n for n in port_use.get(p.get("port"), []) if n != p["name"]])

    shelved = [k for k in ("pinned", "motion", "rest") if bands[k]]
    cards = "".join(
        (f'<div class="band-head" data-band="{k}">{BAND_HEADS[k][0]}'
         f'<span class="band-hint">{BAND_HEADS[k][1]}</span></div>'
         if len(shelved) > 1 else "") + "".join(render(p) for p in bands[k])
        for k in shelved)
    arch_cards = "".join(render(p) for p in bands["archive"])
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>the humble hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="/static/favicon.ico" sizes="any">
<link rel="icon" href="/static/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/apple-touch-icon.png">
<link rel="manifest" href="/static/manifest.webmanifest">
<meta name="theme-color" content="#43331c">
<link rel="stylesheet" href="{sv('/static/vendor/xterm.min.css')}">
<style>
  :root {{ color-scheme: light;
    --font-family:"EB Garamond", "Noto Serif", Georgia, serif;
    --ink:#43331c; --ink-soft:#6e5a39; --ink-faint:#9c875f;
    --parchment:#efe2c0; --paper:#f6edd6;
    --lapis:#2f5277; --sanguine:#9a3b22; --verdigris:#4f6b3a;
    --ochre:#8a6d1f; --plum:#5a3d6e;
    --bg-hi:#f7edd3; --bg-mid:#f2e6c6; --bg-lo:#e2d2a8;
    --card-bg:rgba(255,250,235,.35); --card-hot:rgba(255,250,235,.7);
    --input-bg:rgba(255,250,235,.5);
    /* modal backdrop dim + the confirm cover — themed (hub.js emits per-theme
       values; these are the codex defaults) */
    --scrim:rgba(67,51,28,.4); --veil:rgba(239,226,192,.96); }}
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
  #shelf > header, #shelf > .grid, #shelf > #jot, #shelf > #archive {{ max-width:1100px;
    margin-left:auto; margin-right:auto; }}
  /* jottings: to-do + ideas, opened as modals from the controls row */
  .jot-open {{ background:transparent; border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.84rem;
    font-variant:small-caps; letter-spacing:.06em; padding:.3rem .75rem;
    cursor:pointer; }}
  .jot-open:hover {{ background:var(--ink); color:var(--parchment); }}
  /* the mode picker is a .menu dropdown like root claude — a native <select>'s
     open list can't be themed (the OS draws it), which read as "unstyled".
     The button keeps the #mode-select id so the theme skins hook onto it. */
  #overlay {{ position:fixed; inset:0; background:var(--scrim); z-index:60;
    display:flex; align-items:flex-start; justify-content:center;
    padding-top:11vh; }}
  #overlay[hidden] {{ display:none; }}
  #modal {{ width:min(760px, 94vw); background:var(--parchment);
    border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
    outline-offset:4px; border-radius:2px; padding:1rem 1.2rem;
    box-shadow:3px 5px 18px rgba(40,30,15,.45); position:relative;
    display:flex; flex-direction:column; max-height:72vh; }}
  .m-head {{ display:flex; align-items:center; }}
  .m-head h3 {{ margin:0; flex:1; font-size:1rem; font-weight:600;
    font-variant:small-caps; letter-spacing:.08em; color:var(--ink); }}
  #confirm {{ position:absolute; inset:0; background:var(--veil);
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
  /* .edit-input moved to hub.js (beside .jot-content) so tweaks deploy on refresh — idea #19 */
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
  /* one height for every control in the row — buttons, the mode select, the
     search field and the chips all sit on the same line, no odd one out.
     min-height (not height): a fixed box overflows under browser zoom or a
     bumped minimum font size, which visibly knocks the icons off-centre */
  .controls button, .controls .btn, .controls select, .controls input {{
    min-height:1.95rem; box-sizing:border-box; line-height:1.3; }}
  /* optical correction: geometric centring reads high next to small-caps
     text (no descenders) — seat the control-row icons a hair lower */
  .controls button svg.i {{ transform:translateY(.05em); }}
  #search {{ background:var(--input-bg); border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.9rem;
    line-height:1.3; padding:.3rem .7rem; width:240px; }}
  #search::placeholder {{ color:var(--ink-faint); font-style:italic; }}
  /* category chips are NEUTRAL — icon + text tell them apart; the pigments are
     reserved for the action buttons (lapis=claude, sanguine=go, verdigris=files)
     so a colour means one thing. Chips only carry an active/inactive state. */
  #filters {{ display:inline-flex; align-items:center; gap:.45rem; }}
  .chip {{ background:transparent; border:1px solid var(--ink-soft);
    border-radius:999px; color:var(--ink-soft); font:inherit;
    font-size:.78rem; font-variant:small-caps; letter-spacing:.05em;
    padding:.15rem .7rem; cursor:pointer;
    display:inline-flex; align-items:center; gap:.3em; }}
  /* hover must set its OWN background, else the global button:hover (dark fill)
     leaks in → dark text on dark fill (invisible). Only non-active chips hover. */
  .chip:hover:not(.active) {{ background:var(--card-hot); border-color:var(--ink); color:var(--ink); }}
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
  .glyph {{ line-height:1; display:flex; }}
  /* the project's mark: tinted monogram plate, or its own icon file */
  .mono {{ width:2.05rem; height:2.05rem; display:flex; align-items:center;
    justify-content:center; font-size:.88rem; font-weight:700;
    letter-spacing:.03em; border:1px solid currentColor; border-radius:2px;
    background:color-mix(in srgb, currentColor 10%, transparent); }}
  .mono3 {{ font-size:.7rem; letter-spacing:0; }}
  .p-lapis {{ color:var(--lapis); }} .p-sanguine {{ color:var(--sanguine); }}
  .p-verdigris {{ color:var(--verdigris); }} .p-ochre {{ color:var(--ochre); }}
  .p-plum {{ color:var(--plum); }}
  .glyph-img {{ width:2.05rem; height:2.05rem; object-fit:contain; }}
  /* per-type glyph alternative — the theme modal's shelf toggle swaps to it */
  .tglyph {{ display:none; width:1.45rem; height:1.45rem; }}
  body.type-glyphs .glyph .mono, body.type-glyphs .glyph .glyph-img {{ display:none; }}
  body.type-glyphs .tglyph {{ display:block; }}
  /* shelf bands: pinned / in motion / the rest */
  .band-head {{ grid-column:1/-1; display:flex; align-items:baseline; gap:.7rem;
    font-variant:small-caps; letter-spacing:.14em; font-size:.85rem;
    color:var(--ink-soft); margin:.5rem 0 -.5rem;
    /* a bg-tinted halo keeps the heads legible over any world's wallpaper
       (text-shadow inherits, so the hint gets it too) */
    text-shadow:0 1px 4px var(--parchment), 0 0 2px var(--parchment); }}
  .band-head::after {{ align-self:center; }}
  .band-hint {{ font-variant:normal; letter-spacing:.02em; font-size:.72rem;
    font-style:italic; color:var(--ink-faint); }}
  .band-head::after {{ content:""; flex:1; border-top:1px solid var(--ink-faint);
    opacity:.55; }}
  #archive {{ margin-top:1.8rem; }}
  #archive summary {{ cursor:pointer; font-variant:small-caps;
    letter-spacing:.14em; font-size:.85rem; color:var(--ink-soft);
    width:max-content; }}
  #archive summary:hover {{ color:var(--ink); }}
  #archive .grid {{ margin-top:1.1rem; }}
  #archive .card {{ opacity:.78; }}
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
        <button class="jot-open" onclick="openDrawer('~')">{CHAT_SVG} root claude ▾</button>
        <div class="menu-items">
          <button onclick="openDrawer('~')">fresh chat</button>
          <button onclick="openDrawer('~', true)">resume chat</button>
          <button onclick="act('~','terminal')">in konsole</button>
        </div>
      </div>
      <div class="menu">
        <button class="jot-open" id="mode-select"
                title="permission mode for newly opened chats">mode:
          <span id="mode-label">default</span> ▾</button>
        <div class="menu-items">
          <button data-mode="default" onclick="setMode('default')">default</button>
          <button data-mode="accept-edits" onclick="setMode('accept-edits')">accept edits</button>
          <button data-mode="plan" onclick="setMode('plan')">plan</button>
        </div>
      </div>
      <button class="jot-open" onclick="openJot('todos')" title="tasks, filterable by project">{icon("todo")} to-do <span id="todos-count"></span></button>
      <button class="jot-open" onclick="openJot('ideas')" title="jotted ideas, filterable by project">{icon("ideas")} ideas <span id="ideas-count"></span></button>
      <button class="jot-open" id="inbox-open" onclick="openInbox()" title="dropped images, waiting to become to-dos or ideas">{icon("inbox")} inbox <span id="inbox-count"></span></button>
      <input id="search" type="search" placeholder="search…" autocomplete="off" oninput="refilter()">
      <span id="filters">
        <button class="chip active" data-type="" onclick="pick(this)" title="every project">all</button>
        <button class="chip" data-type="site" onclick="pick(this)" title="static sites — projects with an index.html">{icon("site")} site</button>
        <button class="chip" data-type="service" onclick="pick(this)" title="projects that run a local service (hub.json serve + port)">{icon("service")} service</button>
        <button class="chip" data-type="app" onclick="pick(this)" title="desktop apps — projects with a .desktop launcher">{icon("app")} app</button>
        <button class="chip" data-type="code" onclick="pick(this)" title="code projects — pyproject, src/ and kin">{icon("code")} code</button>
        <button class="chip" data-type="notes" onclick="pick(this)" title="markdown collections — notes, guides, research">{icon("notes")} notes</button>
        <button class="chip" data-type="empty" onclick="pick(this)" title="empty shells — nothing in them yet">{icon("empty")} empty</button>
      </span>
    </div>
  </header>
  <div class="grid" id="grid">{cards}</div>
  <details id="archive" {'' if arch_cards else 'hidden'}>
    <summary>archive · <span id="arch-count">{len(bands["archive"])}</span></summary>
    <div class="grid">{arch_cards}</div>
  </details>
  </div>

  <div id="overlay" hidden>
    <div id="modal">
      <div class="m-head">
        <h3 id="m-title">to-do</h3>
        <button class="del" onclick="closeJot()" title="close">{icon("close")}</button>
      </div>
      <div class="jot-col" id="col-todos">
        <ul id="todos"></ul>
        <div class="attach-strip" id="todos-attach"></div>
        <form onsubmit="return addItem(event,'todos')" class="jot-add">
          <input id="todos-input" placeholder="add a task…" autocomplete="off">
          <label class="attach-btn" title="attach image(s)">{icon("attach")}<input type="file"
            accept="image/*" multiple onchange="pickAttach(event,'todos')" hidden></label>
        </form>
      </div>
      <div class="jot-col" id="col-ideas">
        <ul id="ideas"></ul>
        <div class="attach-strip" id="ideas-attach"></div>
        <form onsubmit="return addItem(event,'ideas')" class="jot-add">
          <input id="ideas-input" placeholder="jot an idea…" autocomplete="off">
          <label class="attach-btn" title="attach image(s)">{icon("attach")}<input type="file"
            accept="image/*" multiple onchange="pickAttach(event,'ideas')" hidden></label>
        </form>
      </div>
      <div class="jot-col" id="col-inbox" style="display:none">
        <ul id="inbox-list"></ul>
        <label class="inbox-add" title="drop an image into the inbox">{icon("camera")} add image
          <input type="file" accept="image/*" multiple onchange="dropToInbox(event)" hidden></label>
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

  <script src="{sv('/static/vendor/xterm.min.js')}"></script>
  <script src="{sv('/static/vendor/addon-fit.min.js')}"></script>
  <script src="{sv('/static/themes.js')}"></script>
  <script src="{sv('/static/hub.js')}"></script>
</body></html>"""
