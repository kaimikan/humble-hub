"""hub — local start-page for everything in ~/Projects.

Scans the projects directory, renders a card per project with type-aware
actions (launch app, open site, open a Claude Code terminal in the project),
and serves static-site projects directly. Localhost only.
"""
import html
import re
import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
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
# Page

TYPE_BADGES = {
    "site": ("site", "#7aa2f7"),
    "app": ("app", "#9ece6a"),
    "code": ("code", "#e0af68"),
    "notes": ("notes", "#bb9af7"),
    "empty": ("empty", "#565f89"),
}


def card(p: dict) -> str:
    name = html.escape(p["name"])
    label, color = TYPE_BADGES[p["type"]]
    buttons = [
        f"""<button onclick="act('{name}','terminal')" title="Open Claude Code here">🗨 claude</button>""",
        f"""<button onclick="act('{name}','folder')" title="Open in Dolphin">📁</button>""",
    ]
    if p["type"] == "site":
        buttons.insert(0, f"""<a class="btn" href="{p['site']}" target="_blank">▶ open site</a>""")
    if p["type"] == "app":
        buttons.insert(0, f"""<button onclick="act('{name}','launch')">▶ launch</button>""")
    meta = []
    if p.get("last_commit"):
        dirty = " · ✱ uncommitted changes" if p.get("dirty") else ""
        meta.append(html.escape(p["last_commit"]) + dirty)
    return f"""
    <div class="card">
      <div class="head">
        <h2>{name}</h2>
        <span class="badge" style="background:{color}">{label}</span>
      </div>
      <p class="excerpt">{html.escape(p.get("excerpt") or "")}</p>
      <p class="meta">{" ".join(meta)}</p>
      <div class="actions">{''.join(buttons)}</div>
    </div>"""


@app.get("/", response_class=HTMLResponse)
def index():
    cards = "".join(card(p) for p in scan())
    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>hub</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root {{ color-scheme: dark; }}
  body {{ background:#1a1b26; color:#c0caf5; font:16px/1.5 system-ui, sans-serif;
         max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }}
  h1 {{ font-weight: 600; letter-spacing: .03em; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(320px,1fr)); gap:1rem; }}
  .card {{ background:#24283b; border-radius:12px; padding:1rem 1.2rem;
           display:flex; flex-direction:column; gap:.4rem; }}
  .head {{ display:flex; align-items:center; justify-content:space-between; }}
  .card h2 {{ margin:0; font-size:1.1rem; font-weight:600; }}
  .badge {{ color:#1a1b26; font-size:.72rem; font-weight:700; padding:.15rem .5rem;
            border-radius:999px; }}
  .excerpt {{ margin:0; color:#a9b1d6; font-size:.9rem; min-height:2.7em; }}
  .meta {{ margin:0; color:#565f89; font-size:.78rem; }}
  .actions {{ display:flex; gap:.5rem; margin-top:.4rem; flex-wrap:wrap; }}
  button, .btn {{ background:#414868; color:#c0caf5; border:0; border-radius:8px;
           padding:.35rem .7rem; font-size:.85rem; cursor:pointer; text-decoration:none; }}
  button:hover, .btn:hover {{ background:#565f89; }}
</style></head>
<body>
  <h1>hub</h1>
  <div class="grid">{cards}</div>
  <script>
    async function act(name, action) {{
      await fetch(`/api/projects/${{name}}/${{action}}`, {{method:'POST'}});
    }}
  </script>
</body></html>"""
