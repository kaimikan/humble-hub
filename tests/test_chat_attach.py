#!/usr/bin/env python3
"""Image-into-chat test, fully isolated from the live hub.

Runs its own uvicorn on port 7796 with HUB_CLAUDE_CMD=bash (no real claude) and
drives the drawer with Playwright: picking an image through the header
paperclip must upload it and bracket-paste the SAVED FILE'S PATH into the chat
(an image itself cannot cross a pty), without submitting anything. Also covers
the paste route and the no-live-chat guard.

Uploads land in the real data/attachments (the app's own dir); every id created
here is deleted again on the way out.

    ~/.venvs/playwright/bin/python tests/test_chat_attach.py
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
PORT = 7796
PTY_DIR = Path(f"/tmp/hub-pty-test-{os.getpid()}")
# HUB_PERSIST=1 on purpose: the in-process path execvpe's "claude" by name, so
# HUB_CLAUDE_CMD swaps only the ARGUMENTS there and a real claude starts. The
# stand-in must also PRINT (injectIntoSession waits for a chat's first output)
# and then STAY ALIVE, or the socket closes and the attach is rightly refused.
# it keeps printing on purpose: injectIntoSession holds the paste until a chat's
# FIRST output, and a single echo can land before the client has attached.
ENV = dict(os.environ, HUB_PTY_DIR=str(PTY_DIR), HUB_PERSIST="1",
           HUB_CLAUDE_CMD='bash -c "while :; do echo hub-test-shell; sleep 1; done"')
ATTACH = HUB / "data" / "attachments"

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
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/projects", timeout=1)
            return p
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def main():
    from playwright.sync_api import sync_playwright

    before = set(p.name for p in ATTACH.glob("*")) if ATTACH.is_dir() else set()
    srv = start_server()
    # a real PNG, written by the same Pillow the upload endpoint reads it with
    img = Path(f"/tmp/hub-attach-test-{os.getpid()}.png")
    subprocess.run([str(HUB / ".venv/bin/python"), "-c",
                    "from PIL import Image; import sys;"
                    "Image.new('RGB', (8, 8), (120, 90, 40)).save(sys.argv[1])",
                    str(img)], check=True)

    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch()
            pg = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(f"http://127.0.0.1:{PORT}", wait_until="networkidle")

            # the paperclip exists and sits in the drawer head
            clip = pg.locator("#drawer .d-head button[title*='attach']")
            check("paperclip added to the drawer head", clip.count() == 1)

            # with no live chat, attaching warns instead of throwing
            pg.evaluate("document.querySelector('#drawer .d-head "
                        "button[title*=attach]').click()")
            pg.set_input_files("#chat-attach", str(img))
            pg.wait_for_timeout(600)
            toast = pg.evaluate(
                "(document.getElementById('hub-toast') || {}).textContent || ''")
            check("no-live-chat is refused with a toast",
                  "no live chat" in toast.lower(), toast or "(no toast)")

            # open a chat (bash stands in for claude) and attach for real
            pg.evaluate("openDrawer('humble-hub')")
            pg.wait_for_timeout(2500)          # let the pty boot and emit
            sent = pg.evaluate("""() => {
                const s = sessions.get(active);
                if (!s) return null;
                window.__sent = [];
                const orig = s.ws.send.bind(s.ws);
                s.ws.send = d => { window.__sent.push(d); orig(d); };
                return true;
            }""")
            check("a session is live in the drawer", sent is True)

            pg.set_input_files("#chat-attach", str(img))
            pg.wait_for_timeout(2500)
            payloads = [p for p in pg.evaluate("window.__sent || []")
                        if "attachments" in p]
            check("a path was sent into the chat", len(payloads) == 1,
                  f"{len(payloads)} payloads")

            if payloads:
                data = payloads[0]
                check("bracketed paste, so it lands as one paste",
                      "\\u001b[200~" in data or "\x1b[200~" in data, data[:80])
                check("the path points at the attachments dir",
                      "data/attachments/" in data, data[:120])
                check("nothing is auto-submitted (no carriage return)",
                      "\\r" not in data.replace("\\u001b", ""), data[:120])

            # the desktop route: a pasted image, not a picked file
            import base64
            b64 = base64.b64encode(img.read_bytes()).decode()
            pg.evaluate("""b64 => {
                const bin = atob(b64), buf = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
                const dt = new DataTransfer();
                dt.items.add(new File([buf], "pasted.png", { type: "image/png" }));
                document.getElementById("dterm").dispatchEvent(
                    new ClipboardEvent("paste",
                        { clipboardData: dt, bubbles: true, cancelable: true }));
            }""", b64)
            pg.wait_for_timeout(2500)
            pasted = [p for p in pg.evaluate("window.__sent || []")
                      if "attachments" in p]
            check("a pasted image also lands as a path", len(pasted) == 2,
                  f"{len(pasted)} payloads")

            check("no JS errors", not errs, "; ".join(errs[:2]))
            b.close()
    finally:
        srv.terminate()
        srv.wait(timeout=10)
        img.unlink(missing_ok=True)
        # stop ONLY this suite's pty units: HUB_PTY_DIR namespaces them to the
        # hub-pty-test-* prefix, so a bare hub-pty-* glob can never be used here
        # (it would kill the live drawer sessions, this session among them)
        subprocess.run(["bash", "-c",
                        "systemctl --user stop 'hub-pty-test-*' 2>/dev/null; true"],
                       capture_output=True)
        shutil.rmtree(PTY_DIR, ignore_errors=True)
        # clean up whatever this run uploaded
        if ATTACH.is_dir():
            for p in ATTACH.glob("*"):
                if p.name not in before:
                    p.unlink()

    print("\n" + ("❌ %d check(s) failed" % len(failures) if failures
                  else "✅ all checks passed"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
