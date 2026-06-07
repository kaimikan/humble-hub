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
import termios
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

PROJECTS_DIR = Path.home() / "Projects"
HUB_DIR = Path(__file__).resolve().parent
SKIP = re.compile(r"^(\.|watch_)")

app = FastAPI(title="hub")


# ---------------------------------------------------------------------------
# Project discovery


def readme_excerpt(path: Path) -> str:
    readme = path / "README.md"
    if not readme.is_file():
        return ""
    for line in readme.read_text(errors="replace").splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "<", "!", "-", "|")):
            return line
    return ""


def git_info(path: Path) -> dict:
    if not (path / ".git").is_dir():
        return {}
    run = lambda *args: subprocess.run(  # noqa: E731
        ["git", "-C", str(path), *args], capture_output=True, text=True
    ).stdout.strip()
    return {
        "last_commit": run("log", "-1", "--format=%ad — %s", "--date=format:%Y-%m-%d"),
        "dirty": bool(run("status", "--porcelain")),
        "remote": run("remote", "get-url", "origin"),
    }


def detect(path: Path) -> dict:
    """Classify a project and derive its available actions."""
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


# Serve static-site projects (e.g. wow-world-wiki) straight from the hub.
for _p in scan():
    if _p["type"] == "site":
        app.mount(f"/sites/{_p['name']}", StaticFiles(directory=_p["path"], html=True))

app.mount("/static", StaticFiles(directory=HUB_DIR / "static"))


# ---------------------------------------------------------------------------
# Actions


def project_path(name: str) -> Path:
    path = PROJECTS_DIR / name
    if not path.is_dir() or SKIP.match(name) or "/" in name:
        raise HTTPException(404, f"no such project: {name}")
    return path


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


# ---------------------------------------------------------------------------
# Embedded terminal — WebSocket pty bridge running Claude Code per project


def spawn_claude(path: Path, resume: bool = False):
    """Start `claude` on a pty in the project dir. Returns (pid, master fd)."""
    env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor")
    env["PATH"] = f"{Path.home()}/.local/bin:{env.get('PATH', '/usr/bin')}"
    argv = ["claude", "--resume"] if resume else ["claude"]
    pid, fd = pty.fork()
    if pid == 0:  # child
        os.chdir(path)
        os.execvpe("claude", argv, env)
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
    return pid, fd


@app.websocket("/ws/terminal/{name}")
async def terminal_ws(ws: WebSocket, name: str, resume: bool = False):
    path = project_path(name)
    await ws.accept()
    pid, fd = spawn_claude(path, resume)
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
def terminal_page(name: str, resume: bool = False):
    project_path(name)  # 404 unknown names
    safe = html.escape(name)
    ws_query = "?resume=1" if resume else ""
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>{safe} — claude</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/static/vendor/xterm.min.css">
<style>
  body {{ margin:0; height:100vh; display:flex; flex-direction:column;
    background:#efe2c0; font:15px "EB Garamond", "Noto Serif", Georgia, serif; }}
  header {{ display:flex; align-items:center; gap:.8rem; padding:.45rem .9rem;
    color:#43331c; border-bottom:1.5px solid #6e5a39; }}
  header a {{ color:#2f5277; text-decoration:none; }}
  header h1 {{ margin:0; font-size:1rem; font-weight:600; font-variant:small-caps;
    letter-spacing:.08em; flex:1; }}
  #term {{ flex:1; padding:.4rem; background:#1a1b26; }}
</style></head>
<body>
  <header>
    <a href="/" title="back to the shelf">⌂ hub</a>
    <h1>{safe}</h1>
    <span style="font-style:italic; font-size:.85rem; color:#6e5a39">claude code</span>
  </header>
  <div id="term"></div>
  <script src="/static/vendor/xterm.min.js"></script>
  <script src="/static/vendor/addon-fit.min.js"></script>
  <script>
    const term = new Terminal({{
      fontFamily: "monospace", fontSize: 14, cursorBlink: true,
      theme: {{ background: "#1a1b26", foreground: "#c0caf5" }},
    }});
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(document.getElementById("term"));
    fit.fit();
    term.focus();

    const ws = new WebSocket(`ws://${{location.host}}/ws/terminal/{safe}{ws_query}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => ws.send(JSON.stringify({{type:"resize", cols:term.cols, rows:term.rows}}));
    ws.onmessage = e => term.write(new Uint8Array(e.data));
    ws.onclose = () => term.write("\\r\\n\\x1b[33m[session ended — refresh to start a new one]\\x1b[0m\\r\\n");
    term.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({{type:"input", data:d}})));
    new ResizeObserver(() => {{
      fit.fit();
      ws.readyState === 1 && ws.send(JSON.stringify({{type:"resize", cols:term.cols, rows:term.rows}}));
    }}).observe(document.getElementById("term"));
  </script>
</body></html>"""


# ---------------------------------------------------------------------------
# Page

TYPE_GLYPHS = {"site": "☉", "app": "⚙", "code": "✒", "notes": "✎", "empty": "◯"}
TYPE_LABELS = {
    "site": "site",
    "app": "app",
    "code": "code",
    "notes": "notes",
    "empty": "empty",
}


def glyph(p: dict) -> str:
    """Hand-inked glyph for a project — .desktop icon hints beat type defaults."""
    icon_hint = ""
    if p.get("desktop"):
        for line in Path(p["desktop"]).read_text(errors="replace").splitlines():
            if line.startswith("Icon="):
                icon_hint = line[5:].lower()
    if "audio" in icon_hint or "music" in icon_hint:
        return "♪"
    return TYPE_GLYPHS[p["type"]]


def card(p: dict) -> str:
    name = html.escape(p["name"])
    buttons = [
        f"""<div class="menu">
          <a class="btn b-claude" href="/terminal/{name}">🗨 claude ▾</a>
          <div class="menu-items">
            <a href="/terminal/{name}">fresh chat · in hub</a>
            <a href="/terminal/{name}?resume=1">resume chat · in hub</a>
            <button onclick="act('{name}','terminal')">in konsole</button>
          </div>
        </div>""",
        f"""<button class="b-files" onclick="act('{name}','folder')" title="Open in Dolphin">files</button>""",
    ]
    if p["type"] == "site":
        buttons.insert(0, f"""<a class="btn b-go" href="{p['site']}" target="_blank">▶ open site</a>""")
    if p["type"] == "app":
        buttons.insert(0, f"""<button class="b-go" onclick="act('{name}','launch')">▶ launch</button>""")
    meta = html.escape(p["last_commit"]) if p.get("last_commit") else ""
    if p.get("dirty"):
        meta += " · ✱ wet ink"
    excerpt = html.escape(p.get("excerpt") or "")
    search_blob = html.escape(f"{p['name']} {p.get('excerpt') or ''}".lower())
    return f"""
    <div class="card" data-type="{p['type']}" data-text="{search_blob}">
      <div class="head">
        <span class="glyph">{glyph(p)}</span>
        <h2>{name}</h2>
        <span class="kind">{TYPE_LABELS[p["type"]]}</span>
      </div>
      <p class="excerpt">{f'“{excerpt}”' if excerpt else ''}</p>
      <p class="meta">{meta}</p>
      <div class="actions">{''.join(buttons)}</div>
    </div>"""


@app.get("/", response_class=HTMLResponse)
def index():
    cards = "".join(card(p) for p in scan())
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>the humble hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{ color-scheme: light;
    --ink:#43331c; --ink-soft:#6e5a39; --ink-faint:#9c875f;
    --parchment:#efe2c0; }}
  body {{ color:var(--ink); font:16px/1.55 "EB Garamond", "Noto Serif", Georgia, serif;
    max-width:1100px; margin:2.2rem auto; padding:0 1.2rem;
    background:
      radial-gradient(ellipse at 15% 8%, #f7edd3 0%, transparent 55%),
      radial-gradient(ellipse at 85% 95%, #e2d2a8 0%, transparent 55%),
      radial-gradient(ellipse at 60% 40%, #f2e6c6 0%, transparent 70%),
      var(--parchment); }}
  header {{ text-align:center; margin-bottom:2rem; }}
  h1 {{ margin:0; font-size:1.9rem; font-weight:600; letter-spacing:.35em;
        font-variant:small-caps; }}
  .motto {{ margin:.2rem 0 0; font-style:italic; color:var(--ink-soft); font-size:.95rem; }}
  .rule {{ width:60%; margin:.9rem auto 0; border:0; border-top:1.5px solid var(--ink-soft);
           position:relative; }}
  .rule::after {{ content:"❧"; position:absolute; top:-0.75em; left:50%;
                  transform:translateX(-50%); background:var(--parchment);
                  padding:0 .6em; color:var(--ink-soft); }}
  .controls {{ margin-top:1.1rem; display:flex; gap:.7rem; justify-content:center;
               align-items:center; flex-wrap:wrap; }}
  #search {{ background:rgba(255,250,235,.5); border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.9rem;
    padding:.35rem .7rem; width:240px; }}
  #search::placeholder {{ color:var(--ink-faint); font-style:italic; }}
  .chip {{ background:transparent; border:1px solid var(--ink-faint); border-radius:999px;
    color:var(--ink-soft); font:inherit; font-size:.78rem; font-variant:small-caps;
    letter-spacing:.05em; padding:.15rem .65rem; cursor:pointer; }}
  .chip:hover {{ border-color:var(--ink); color:var(--ink); }}
  .chip.active {{ background:var(--ink); border-color:var(--ink); color:var(--parchment); }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:1.3rem; }}
  .card {{ border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
    outline-offset:4px; border-radius:2px; padding:1rem 1.2rem;
    display:flex; flex-direction:column; gap:.45rem;
    background:rgba(255,250,235,.35); box-shadow:2px 3px 8px rgba(67,51,28,.18); }}
  .card:nth-child(odd) {{ transform:rotate(-.35deg); }}
  .card:nth-child(even) {{ transform:rotate(.3deg); }}
  .head {{ display:flex; align-items:baseline; gap:.6rem; }}
  .glyph {{ font-size:1.45rem; line-height:1; }}
  .card h2 {{ margin:0; font-size:1.12rem; font-weight:600; flex:1;
              font-variant:small-caps; letter-spacing:.05em; }}
  .kind {{ font-style:italic; color:var(--ink-faint); font-size:.82rem; }}
  .excerpt {{ margin:0; font-style:italic; color:var(--ink-soft); font-size:.92rem;
              min-height:2.8em; }}
  .meta {{ margin:0; color:var(--ink-faint); font-size:.78rem; }}
  /* pinned to the card bottom so every panel's buttons align across the row */
  .actions {{ display:flex; gap:.55rem; margin-top:auto; padding-top:.6rem; flex-wrap:wrap; }}
  button, .btn {{ background:transparent; color:var(--ink); border:1px solid var(--ink-soft);
    border-radius:2px; padding:.3rem .75rem; font:inherit; font-size:.84rem;
    font-variant:small-caps; letter-spacing:.06em; cursor:pointer; text-decoration:none; }}
  button:hover, .btn:hover {{ background:var(--ink); color:var(--parchment); }}
  /* manuscript pigments: sanguine, lapis, verdigris */
  .b-go     {{ color:#9a3b22; border-color:#9a3b22; }}
  .b-go:hover     {{ background:#9a3b22; color:var(--parchment); }}
  .b-claude {{ color:#2f5277; border-color:#2f5277; }}
  .b-claude:hover {{ background:#2f5277; color:var(--parchment); }}
  .b-files  {{ color:#4f6b3a; border-color:#4f6b3a; }}
  .b-files:hover  {{ background:#4f6b3a; color:var(--parchment); }}
  /* hover menu on the claude button */
  .menu {{ position:relative; display:inline-block; }}
  .menu-items {{ display:none; position:absolute; left:0; top:100%; z-index:5;
    min-width:11.5rem; flex-direction:column; background:#f6edd6;
    border:1px solid var(--ink-soft); box-shadow:2px 3px 8px rgba(67,51,28,.25); }}
  .menu:hover .menu-items {{ display:flex; }}
  .menu-items a, .menu-items button {{ border:0; border-radius:0; text-align:left;
    padding:.42rem .8rem; color:#2f5277; background:transparent; }}
  .menu-items a:hover, .menu-items button:hover {{ background:#2f5277;
    color:var(--parchment); }}
</style></head>
<body>
  <header>
    <h1>the humble hub</h1>
    <p class="motto">a small shelf for homemade things</p>
    <hr class="rule">
    <div class="controls">
      <input id="search" type="search" placeholder="search the shelf…" oninput="refilter()">
      <span id="filters">
        <button class="chip active" data-type="" onclick="pick(this)">all</button>
        <button class="chip" data-type="site" onclick="pick(this)">site</button>
        <button class="chip" data-type="app" onclick="pick(this)">app</button>
        <button class="chip" data-type="code" onclick="pick(this)">code</button>
        <button class="chip" data-type="notes" onclick="pick(this)">notes</button>
        <button class="chip" data-type="empty" onclick="pick(this)">empty</button>
      </span>
    </div>
  </header>
  <div class="grid">{cards}</div>
  <script>
    async function act(name, action) {{
      await fetch(`/api/projects/${{name}}/${{action}}`, {{method:'POST'}});
    }}
    let typeFilter = "";
    function pick(chip) {{
      typeFilter = chip.dataset.type;
      document.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
      refilter();
    }}
    function refilter() {{
      const q = document.getElementById('search').value.toLowerCase();
      document.querySelectorAll('.card').forEach(card => {{
        const hit = (!typeFilter || card.dataset.type === typeFilter)
                 && (!q || card.dataset.text.includes(q));
        card.style.display = hit ? '' : 'none';
      }});
    }}
  </script>
</body></html>"""
