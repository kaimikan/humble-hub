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
    if name == "~":  # the root claude — a session over all of ~/Projects
        return PROJECTS_DIR
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
    <a href="/" title="back to the humble hub">⌂ hub</a>
    <h1>{safe}</h1>
    <span style="font-style:italic; font-size:.85rem; color:#6e5a39">claude code</span>
  </header>
  <div id="term"></div>
  <script src="/static/vendor/xterm.min.js"></script>
  <script src="/static/vendor/addon-fit.min.js"></script>
  <script>
    const term = new Terminal({{
      fontFamily: "'JetBrains Mono', 'Hack', 'Noto Sans Mono', monospace",
      fontSize: 14, cursorBlink: true, customGlyphs: true,
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
          <button class="b-claude" onclick="openDrawer('{name}')">🗨 claude ▾</button>
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
<link rel="stylesheet" href="/static/vendor/xterm.min.css">
<style>
  :root {{ color-scheme: light;
    --ink:#43331c; --ink-soft:#6e5a39; --ink-faint:#9c875f;
    --parchment:#efe2c0; }}
  body {{ color:var(--ink); font:16px/1.55 "EB Garamond", "Noto Serif", Georgia, serif;
    margin:0; height:100vh; overflow:hidden;
    background:
      radial-gradient(ellipse at 15% 8%, #f7edd3 0%, transparent 55%),
      radial-gradient(ellipse at 85% 95%, #e2d2a8 0%, transparent 55%),
      radial-gradient(ellipse at 60% 40%, #f2e6c6 0%, transparent 70%),
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
    padding-right:.55rem; scrollbar-gutter:stable; }}
  .jot-col li .txt {{ white-space:pre-wrap; overflow-wrap:anywhere; cursor:text; }}
  .jot-col li:hover {{ background:rgba(255,250,235,.65); }}
  .jot-col ul {{ list-style:none; margin:0; padding:0; }}
  .jot-col li {{ display:flex; align-items:baseline; gap:.5rem; padding:.18rem 0;
    font-size:.92rem; border-bottom:1px dotted rgba(156,135,95,.4); }}
  .jot-col li.done .txt {{ text-decoration:line-through; color:var(--ink-faint); }}
  .jot-col li .txt {{ flex:1; }}
  .jot-col li .del {{ border:0; background:transparent; color:var(--ink-faint);
    cursor:pointer; font:inherit; padding:0 .2rem; }}
  .jot-col li .del:hover {{ color:#9a3b22; background:transparent; }}
  .jot-col input[type="checkbox"] {{ accent-color:#4f6b3a; }}
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
  #search {{ background:rgba(255,250,235,.5); border:1px solid var(--ink-soft);
    border-radius:2px; color:var(--ink); font:inherit; font-size:.9rem;
    padding:.35rem .7rem; width:240px; }}
  #search::placeholder {{ color:var(--ink-faint); font-style:italic; }}
  .chip {{ background:transparent; border:1px solid var(--chip, var(--ink-soft));
    border-radius:999px; color:var(--chip, var(--ink-soft)); font:inherit;
    font-size:.78rem; font-variant:small-caps; letter-spacing:.05em;
    padding:.15rem .65rem; cursor:pointer; }}
  /* hover and active both fill with the chip's pigment, text stays parchment */
  .chip:hover, .chip.active {{ background:var(--chip, var(--ink));
    border-color:var(--chip, var(--ink)); color:var(--parchment); }}
  .chip[data-type="site"]  {{ --chip:#2f5277; }}
  .chip[data-type="app"]   {{ --chip:#9a3b22; }}
  .chip[data-type="code"]  {{ --chip:#8a6d1f; }}
  .chip[data-type="notes"] {{ --chip:#4f6b3a; }}
  .chip[data-type="empty"] {{ --chip:#9c875f; }}
  /* side-drawer terminal — pushes the shelf aside rather than covering it */
  :root {{ --drawer-w: min(680px, 58vw); }}
  body.drawer-open #shelf {{ margin-right:var(--drawer-w); }}
  body.drawer-open #pills {{ right:calc(var(--drawer-w) + 1.1rem); }}
  #drawer {{ position:fixed; top:0; right:0; height:100vh; width:var(--drawer-w);
    background:#1a1b26; border-left:2px solid var(--ink-soft);
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
  .d-head a, .d-head button {{ border:0; background:transparent; color:#2f5277;
    font:inherit; font-size:1rem; cursor:pointer; padding:.1rem .35rem;
    text-decoration:none; }}
  .d-head a:hover, .d-head button:hover {{ color:#9a3b22; background:transparent; }}
  #dterm {{ flex:1; min-height:0; padding:.3rem; position:relative; }}
  .term-host {{ position:absolute; inset:.3rem; display:none; }}
  .term-host.shown {{ display:block; }}
  /* status pills for live sessions */
  #pills {{ position:fixed; right:1.1rem; bottom:1.1rem; z-index:40;
    display:flex; flex-direction:column; gap:.5rem; align-items:flex-end; }}
  .pill {{ background:#2f5277; color:var(--parchment); border:0; border-radius:999px;
    padding:.45rem .95rem; font:inherit; font-size:.88rem; font-variant:small-caps;
    letter-spacing:.06em; cursor:pointer; box-shadow:2px 3px 10px rgba(67,51,28,.4);
    display:inline-flex; align-items:center; gap:.45rem; }}
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
    background:rgba(255,250,235,.35); box-shadow:2px 3px 8px rgba(67,51,28,.18); }}
  /* rotated cards form stacking contexts — lift the hovered one so its
     dropdown isn't painted under later cards */
  .card:hover {{ z-index:10; }}
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
  .actions {{ display:flex; gap:.55rem; margin-top:auto; padding-top:.6rem; flex-wrap:wrap;
    align-items:center; }}
  button, .btn {{ background:transparent; color:var(--ink); border:1px solid var(--ink-soft);
    border-radius:2px; padding:.3rem .75rem; font:inherit; font-size:.84rem; line-height:1.3;
    font-variant:small-caps; letter-spacing:.06em; cursor:pointer; text-decoration:none;
    display:inline-flex; align-items:center; box-sizing:border-box; }}
  button:hover, .btn:hover {{ background:var(--ink); color:var(--parchment); }}
  /* manuscript pigments: sanguine, lapis, verdigris */
  .b-go     {{ color:#9a3b22; border-color:#9a3b22; }}
  .b-go:hover     {{ background:#9a3b22; color:var(--parchment); }}
  .b-claude {{ color:#2f5277; border-color:#2f5277; }}
  .b-claude:hover {{ background:#2f5277; color:var(--parchment); }}
  .b-files  {{ color:#4f6b3a; border-color:#4f6b3a; }}
  .b-files:hover  {{ background:#4f6b3a; color:var(--parchment); }}
  /* hover menu on the claude button */
  .menu {{ position:relative; display:inline-flex; }}
  .menu-items {{ display:none; position:absolute; left:0; top:100%; z-index:5;
    min-width:11.5rem; flex-direction:column; background:#f6edd6;
    border:1px solid var(--ink-soft); box-shadow:2px 3px 8px rgba(67,51,28,.25); }}
  .menu:hover .menu-items {{ display:flex; }}
  .menu-items.up {{ top:auto; bottom:100%; }}
  .menu-items a, .menu-items button {{ border:0; border-radius:0; text-align:left;
    padding:.42rem .8rem; color:#2f5277; background:transparent; }}
  .menu-items a:hover, .menu-items button:hover {{ background:#2f5277;
    color:var(--parchment); }}
</style></head>
<body>
  <div id="shelf">
  <header>
    <h1>the humble hub</h1>
    <hr class="rule">
    <div class="controls">
      <div class="menu">
        <button class="b-claude" onclick="openDrawer('~')">🗨 root claude ▾</button>
        <div class="menu-items">
          <button onclick="openDrawer('~')">fresh chat</button>
          <button onclick="openDrawer('~', true)">resume chat</button>
          <button onclick="act('~','terminal')">in konsole</button>
        </div>
      </div>
      <button class="jot-open" onclick="openJot('todos')">✎ to-do <span id="todos-count"></span></button>
      <button class="jot-open" onclick="openJot('ideas')">✎ ideas <span id="ideas-count"></span></button>
      <input id="search" type="search" placeholder="search…" oninput="refilter()">
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
  </div>

  <div id="overlay" hidden>
    <div id="modal">
      <div class="m-head">
        <h3 id="m-title">to-do</h3>
        <button class="del" onclick="closeJot()" title="close">✕</button>
      </div>
      <div class="jot-col" id="col-todos">
        <ul id="todos"></ul>
        <form onsubmit="return addItem(event,'todos')">
          <input id="todos-input" placeholder="add a task…"></form>
      </div>
      <div class="jot-col" id="col-ideas">
        <ul id="ideas"></ul>
        <form onsubmit="return addItem(event,'ideas')">
          <input id="ideas-input" placeholder="jot an idea…"></form>
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
      <a id="d-full" href="#" title="open as full page">⤢</a>
      <button onclick="minimizeDrawer()" title="minimize — keeps the chat alive">▁</button>
      <button onclick="closeActive()" title="end the session">✕</button>
    </div>
    <div id="dterm"></div>
  </aside>
  <div id="pills"></div>

  <script src="/static/vendor/xterm.min.js"></script>
  <script src="/static/vendor/addon-fit.min.js"></script>
  <script src="/static/hub.js"></script>
</body></html>"""
