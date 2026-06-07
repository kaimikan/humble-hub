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

TYPE_GLYPHS = {"site": "☉", "app": "⚙", "code": "✒", "notes": "✎", "empty": "◯"}
TYPE_LABELS = {
    "site": "veduta",       # a view
    "app": "macchina",      # a machine
    "code": "congegno",     # a contrivance
    "notes": "quaderno",    # a notebook
    "empty": "tabula rasa",
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


def card(p: dict, folio: int) -> str:
    name = html.escape(p["name"])
    buttons = [
        f"""<button class="b-claude" onclick="act('{name}','terminal')" title="Open Claude Code here">🗨 claude</button>""",
        f"""<button class="b-files" onclick="act('{name}','folder')" title="Open in Dolphin">files</button>""",
    ]
    if p["type"] == "site":
        buttons.insert(0, f"""<a class="btn b-go" href="{p['site']}" target="_blank">▶ open site</a>""")
    if p["type"] == "app":
        buttons.insert(0, f"""<button class="b-go" onclick="act('{name}','launch')">▶ launch</button>""")
    meta = f"fol. {folio}{'r' if folio % 2 else 'v'}"
    if p.get("last_commit"):
        meta += " · " + html.escape(p["last_commit"])
    if p.get("dirty"):
        meta += " · ✱ wet ink"
    excerpt = html.escape(p.get("excerpt") or "")
    return f"""
    <div class="card">
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
    cards = "".join(card(p, i + 1) for i, p in enumerate(scan()))
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
</style></head>
<body>
  <header>
    <h1>the humble hub</h1>
    <p class="motto">il quaderno delle invenzioni · l'uomo al centro delle sue opere</p>
    <hr class="rule">
  </header>
  <div class="grid">{cards}</div>
  <script>
    async function act(name, action) {{
      await fetch(`/api/projects/${{name}}/${{action}}`, {{method:'POST'}});
    }}
  </script>
</body></html>"""
