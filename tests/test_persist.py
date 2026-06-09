#!/usr/bin/env python3
"""Persistent-pty lifecycle test, fully isolated from the live hub.

Runs its own uvicorn on port 7799 with HUB_CLAUDE_CMD=bash (no real claude),
proves that a session survives a hard server kill (SIGKILL — harsher than a
systemctl restart), that the same shell is reattached by token, that
/api/ptys lists it, and that the kill frame really ends it.

    ~/.venvs/playwright/bin/python tests/test_persist.py   # any py3 with websockets
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HUB / ".venv/lib"))
PORT = 7799
TOKEN = "testtok1"
PTY_DIR = Path(f"/tmp/hub-pty-test-{os.getpid()}")
ENV = dict(os.environ, HUB_PTY_DIR=str(PTY_DIR), HUB_PERSIST="1",
           HUB_CLAUDE_CMD="bash --norc -i")

sys.path.insert(0, str(next((HUB / ".venv/lib").glob("python*/site-packages"), "")))
from websockets.sync.client import connect  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def start_server():
    p = subprocess.Popen(
        [str(HUB / ".venv/bin/python"), "-m", "uvicorn", "app:app",
         "--host", "127.0.0.1", "--port", str(PORT), "--log-level", "warning"],
        cwd=HUB, env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            import urllib.request
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/projects", timeout=1)
            return p
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def ws_url():
    return f"ws://127.0.0.1:{PORT}/ws/terminal/~?attach={TOKEN}"


def send(ws, **msg):
    ws.send(json.dumps(msg))


def wait_for(ws, needle, timeout=15):
    out, deadline = b"", time.time() + timeout
    while time.time() < deadline:
        try:
            m = ws.recv(timeout=max(0.1, deadline - time.time()))
        except TimeoutError:
            break
        if isinstance(m, bytes):
            out += m
            if needle.encode() in out:
                return True, out
    return False, out


server = start_server()
try:
    # --- create + mark the session -------------------------------------------
    with connect(ws_url()) as ws:
        send(ws, type="resize", rows=24, cols=80)
        send(ws, type="input", data="MARKER=zebra42\n")
        time.sleep(0.5)
        send(ws, type="input", data="echo got:$MARKER\n")
        ok, _ = wait_for(ws, "got:zebra42")
        check("session runs and echoes the marker", ok)

    # --- terminal-mode replay for late attachers -------------------------------
    with connect(ws_url()) as ws:
        send(ws, type="resize", rows=24, cols=80)
        send(ws, type="input", data="printf '\\033[?1000h'\n")
        wait_for(ws, "?1000h")  # let it flow through the daemon
    with connect(ws_url()) as ws2:
        ok, out = wait_for(ws2, "\x1b[?1000h", timeout=5)
        check("DEC private modes are replayed to a late attacher", ok,
              repr(out[:120]))

    # --- daemon independence --------------------------------------------------
    socks = list(PTY_DIR.glob("*.sock"))
    check("daemon socket exists", len(socks) == 1, str(socks))
    cg = ""
    pid_out = subprocess.run(["pgrep", "-f", f"hub_ptyd.py {socks[0]}"],
                             capture_output=True, text=True).stdout.split()
    if pid_out:
        cg = Path(f"/proc/{pid_out[0]}/cgroup").read_text()
    check("daemon lives in its own systemd unit cgroup", "hub-pty-" in cg, cg)

    # --- hard-kill the server, session must survive ---------------------------
    server.send_signal(signal.SIGKILL)
    server.wait()
    time.sleep(1)
    check("socket still alive after server SIGKILL", socks[0].exists())

    server = start_server()
    with connect(ws_url()) as ws:
        send(ws, type="resize", rows=24, cols=80)
        send(ws, type="input", data="echo again:$MARKER\n")
        ok, out = wait_for(ws, "again:zebra42")
        check("SAME shell reattached after server restart (marker intact)", ok,
              out[-200:].decode(errors="replace"))

    # --- listing ---------------------------------------------------------------
    import urllib.request
    ptys = json.loads(urllib.request.urlopen(
        f"http://127.0.0.1:{PORT}/api/ptys", timeout=3).read())
    check("/api/ptys lists the live session",
          any(p["token"] == TOKEN and p["project"] == "~" for p in ptys), str(ptys))

    # --- explicit kill ----------------------------------------------------------
    with connect(ws_url()) as ws:
        send(ws, type="kill")
        time.sleep(1.5)
    gone = not socks[0].exists()
    if not gone:
        time.sleep(2)
        gone = not socks[0].exists()
    check("kill frame ends the session (socket removed)", gone)
    ptys = json.loads(urllib.request.urlopen(
        f"http://127.0.0.1:{PORT}/api/ptys", timeout=3).read())
    check("/api/ptys empty after kill", ptys == [], str(ptys))
finally:
    if server.poll() is None:
        server.terminate()
        server.wait()
    # Stop ONLY this test's units. A bare 'hub-pty-*' here once killed the
    # REAL drawer sessions — including the Claude that was running the test
    # (twice!). The token namespaces the glob to test sessions alone.
    subprocess.run(["bash", "-c",
                    f"systemctl --user stop 'hub-pty-*{TOKEN}*' 2>/dev/null; true"],
                   capture_output=True)
    shutil.rmtree(PTY_DIR, ignore_errors=True)

print()
if failures:
    print(f"❌ {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("✅ all checks passed")
