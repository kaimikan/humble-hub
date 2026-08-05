#!/usr/bin/env python3
"""The "new chat" picker: permission mode + model, in one dropdown.

Two halves, tested separately because they fail differently:
  - build_argv() puts the right flags on the claude command line
  - the page stores the choice and sends it on the terminal WebSocket

The UI half stubs window.WebSocket before opening a drawer, so it reads the URL
the page WOULD dial without ever spawning a chat. Its own uvicorn on :7793.

    ~/.venvs/playwright/bin/python tests/test_chat_defaults.py
"""
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HUB = Path(__file__).resolve().parent.parent
PORT = 7793
ENV = dict(os.environ, HUB_PERSIST="0", HUB_CLAUDE_CMD="true")

failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def test_argv():
    """Runs under the HUB venv (it imports app, which needs fastapi) — the
    parent re-invokes this file with `--argv` there and echoes the result."""
    sys.path.insert(0, str(HUB))
    import app

    argv = app.build_argv()
    check("default sends no --model (chat inherits settings.json)",
          "--model" not in argv, " ".join(argv))

    argv = app.build_argv(model="sonnet")
    check("a model choice becomes --model <alias>",
          argv[-2:] == ["--model", "sonnet"], " ".join(argv))

    argv = app.build_argv(mode="plan", model="opus")
    check("mode and model compose on one command line",
          "--permission-mode" in argv and "plan" in argv
          and "--model" in argv and "opus" in argv, " ".join(argv))

    argv = app.build_argv(resume=True, mode="plan", model="haiku")
    check("resume still lands last, after both flags",
          argv[-1] == "--resume", " ".join(argv))

    argv = app.build_argv(model="nonsense")
    check("an unknown model falls back to settings, not a bad flag",
          "--model" not in argv, " ".join(argv))

    # a fresh chat is told its own session id, so the drawer can name the
    # conversation it is showing without waiting for a transcript to appear
    argv = app.build_argv(sid="1234-abcd")
    check("a fresh chat is given its session id up front",
          argv[-2:] == ["--session-id", "1234-abcd"], " ".join(argv))
    argv = app.build_argv(session="old-id", sid="1234-abcd")
    check("resuming never also passes --session-id (that id exists already)",
          "--session-id" not in argv and argv[-2:] == ["--resume", "old-id"],
          " ".join(argv))

    check("every offered model has a preset",
          set(app.MODEL_ARGS) == {"default", "fable", "opus", "sonnet", "haiku"},
          str(sorted(app.MODEL_ARGS)))


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


def test_ui():
    from playwright.sync_api import sync_playwright

    srv = start_server()
    try:
        with sync_playwright() as pw:
            b = pw.chromium.launch()
            pg = b.new_context(viewport={"width": 1280, "height": 900}).new_page()
            errs = []
            pg.on("pageerror", lambda e: errs.append(str(e)))
            pg.goto(f"http://127.0.0.1:{PORT}", wait_until="networkidle")

            head = pg.locator("#mode-select")
            # the button shows the two choices and nothing else — it sits in a
            # crowded row, so the explanation lives in the tooltip and the
            # menu's own section labels
            check("one picker carries both settings",
                  "mode and model" in (head.get_attribute("title") or ""),
                  head.get_attribute("title") or "")
            check("the button is just the choices, no prefix",
                  (head.text_content() or "").strip().startswith("default"),
                  head.text_content() or "")
            check("the menu is split into labelled sections",
                  pg.locator(".menu-items .menu-head").count() == 2)

            pg.evaluate("setModel('sonnet'); setMode('plan')")
            check("the button label mirrors both choices",
                  "plan" in head.text_content() and "sonnet" in head.text_content(),
                  head.text_content() or "")
            check("the choice survives a reload (localStorage)",
                  pg.evaluate("localStorage.getItem('chatModel')") == "sonnet")

            # stub the socket: read the URL the page dials, spawn nothing
            pg.evaluate("""() => {
                window.__url = null;
                window.WebSocket = function (url) {
                    window.__url = url;
                    this.readyState = 0;
                    this.send = () => {}; this.close = () => {};
                };
                window.WebSocket.OPEN = 1;
            }""")
            pg.evaluate("openDrawer('humble-hub')")
            pg.wait_for_timeout(400)
            url = pg.evaluate("window.__url") or ""
            check("the new chat's socket carries the model", "model=sonnet" in url, url)
            check("…and the permission mode alongside it", "mode=plan" in url, url)

            check("no JS errors", not errs, "; ".join(errs[:2]))
            b.close()
    finally:
        srv.terminate()
        srv.wait(timeout=10)


def main():
    if "--argv" in sys.argv:          # child run, under the hub venv
        test_argv()
        return 1 if failures else 0
    argv = subprocess.run([str(HUB / ".venv/bin/python"), __file__, "--argv"],
                          capture_output=True, text=True)
    print(argv.stdout, end="")
    if argv.returncode:
        failures.append("build_argv checks")
    test_ui()
    print("\n" + ("❌ %d check(s) failed" % len(failures) if failures
                  else "✅ all checks passed"))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
