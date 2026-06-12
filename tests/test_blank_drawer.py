#!/usr/bin/env python3
"""Repro probe for the blank-drawer bug (fresh-chat and ⟲-reattach paths).

Runs its own uvicorn (:7797) with HUB_PTY_DIR set, so pty units get the
hub-pty-test-* prefix — cleanup CANNOT touch real hub-pty-* sessions.
HUB_CLAUDE_CMD runs tests/mini_tui.py, which mimics Claude's terminal traits
(alt screen, cursor hiding, repaint only on SIGWINCH).

For each path it reports two facts that localize the bug:
  - ws bytes received  → did the program ever repaint for this client?
  - .xterm-rows text   → did xterm paint what arrived?

    ~/.venvs/playwright/bin/python tests/test_blank_drawer.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

HUB = Path(__file__).resolve().parent.parent
PORT = 7797
URL = f"http://127.0.0.1:{PORT}/"

WS_SPY = """
window.__ws = [];
const Orig = window.WebSocket;
window.WebSocket = function (url, ...rest) {
  const sock = new Orig(url, ...rest);
  const rec = { url: String(url), bytes: 0, chunks: [], sent: [] };
  window.__ws.push(rec);
  sock.addEventListener("message", e => {
    const n = e.data instanceof ArrayBuffer ? e.data.byteLength : String(e.data).length;
    rec.bytes += n;
    if (rec.chunks.length < 40) {
      let head = "";
      if (e.data instanceof ArrayBuffer) {
        head = [...new Uint8Array(e.data).slice(0, 24)]
          .map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : "\\\\x" + b.toString(16))
          .join("");
      }
      rec.chunks.push([n, head]);
    }
  });
  const send = sock.send.bind(sock);
  sock.send = d => { if (rec.sent.length < 40) rec.sent.push(String(d)); send(d); };
  return sock;
};
window.WebSocket.prototype = Orig.prototype;
"""


def report(pg, label):
    time.sleep(2.0)
    ws = pg.evaluate("window.__ws")
    rows = pg.eval_on_selector(".term-host.shown", "el => (el.innerText || '').trim()") \
        if pg.query_selector(".term-host.shown") else "<no shown host>"
    print(f"\n=== {label} ===")
    for w in ws:
        if "/ws/terminal/" not in w["url"]:
            continue
        print(f"  ws {w['url'].split('?')[0]}  received {w['bytes']} bytes")
        for n, head in w["chunks"][:8]:
            print(f"    chunk {n:5d}  {head}")
        print(f"    sent → {w['sent']}")
    painted = "MINI-TUI" in rows
    print(f"  painted text: {'YES' if painted else 'NO'}  ({rows[:80]!r})")
    # repaint bytes = anything beyond the ~22-byte mode replay
    got_repaint = any("/ws/terminal/" in w["url"] and w["bytes"] > 30 for w in ws)
    print(f"  verdict: repaint bytes {'arrived' if got_repaint else 'NEVER ARRIVED'},"
          f" paint {'ok' if painted else 'BLANK'}")
    return got_repaint, painted


def main():
    pty_dir = tempfile.mkdtemp(prefix="hub-blank-repro-")
    env = {**os.environ,
           "HUB_PTY_DIR": pty_dir,
           "HUB_CLAUDE_CMD": f"{sys.executable} {HUB}/tests/mini_tui.py"}
    srv = subprocess.Popen(
        [str(HUB / ".venv/bin/python"), "-m", "uvicorn", "app:app",
         "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=HUB, env=env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(2.5)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1300, "height": 900})
            ctx.add_init_script(WS_SPY)
            pg = ctx.new_page()
            pg.goto(URL, wait_until="networkidle")

            # --- path 1: fresh chat on a cold load ---------------------------
            pg.evaluate("openDrawer('~')")
            fresh = report(pg, "fresh chat (cold load)")

            # --- path 2: reload, reattach via the ⟲ pill ---------------------
            pg.goto(URL, wait_until="networkidle")   # detaches; pty lives on
            pg.wait_for_selector(".pill.s-detached", timeout=5000)
            pg.click(".pill.s-detached")
            reattach = report(pg, "⟲ reattach after reload")

            # --- what the user's ⤢ workaround does ---------------------------
            pg.evaluate("window.toggleDrawerFull()")
            expanded = report(pg, "after ⤢ expand (the manual workaround)")
            browser.close()

        print("\n--- summary ---")
        failures = []
        for name, (got, painted) in [("fresh", fresh), ("reattach", reattach),
                                     ("after-expand", expanded)]:
            ok = got and painted
            if not ok:
                failures.append(name)
            print(f"  {'PASS' if ok else 'FAIL'}  {name}: repaint={'y' if got else 'N'}"
                  f" painted={'y' if painted else 'N'}")
        if failures:
            print(f"\n❌ blank drawer in: {', '.join(failures)}")
            sys.exit(1)
        print("\n✅ all paths repaint")
    finally:
        srv.terminate()
        srv.wait(timeout=5)
        # safe by construction: only test-prefixed units can match
        subprocess.run(["systemctl", "--user", "stop", "hub-pty-test-*"],
                       capture_output=True)
        shutil.rmtree(pty_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
