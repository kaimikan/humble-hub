#!/usr/bin/env python3
"""Verify the v3 conversation manager UI against the live hub. Hermetic:
/api/sessions and /api/notes are intercepted with fixtures, and openDrawer is
stubbed so clicking a row records the resume call instead of spawning claude.

    ~/.venvs/playwright/bin/python tests/test_sessions.py
"""
import json
import sys
import time

from playwright.sync_api import sync_playwright

URL = "http://localhost:7700/"
now = time.time()
SESSIONS = [
    {"id": "aaaa-1111", "project": "~", "title": "Resume Humble Hub setup",
     "preview": "resuming after history loss", "count": 286, "mtime": now - 3600},
    {"id": "bbbb-2222", "project": "babble-building", "title": "Discuss project structure",
     "preview": "jarvis design", "count": 149, "mtime": now - 7200},
    {"id": "cccc-3333", "project": "wow-world-wiki", "title": "Add favicon logo styling",
     "preview": "favicon work", "count": 6, "mtime": now - 86400},
]

failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def run(page):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # /api/ptys 404s until the server restart that deploys it — expected noise
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error"
            and "api/ptys" not in str(getattr(m, "location", "")) else None)

    def route(r):
        u = r.request.url
        if u.endswith("/api/sessions"):
            r.fulfill(status=200, content_type="application/json", body=json.dumps(SESSIONS))
        elif u.endswith("/api/notes"):
            body = json.dumps({"todos": [], "ideas": []}) if r.request.method == "GET" else '{"ok":true}'
            r.fulfill(status=200, content_type="application/json", body=body)
        else:
            r.continue_()
    page.route("**/api/*", route)

    page.goto(URL, wait_until="networkidle")
    check("page loads without JS errors", not errors, "; ".join(errors))

    # trigger sits in the controls row, right after the root-claude menu
    placed = page.eval_on_selector(
        "#sess-open", "el => el.previousElementSibling && el.previousElementSibling.classList.contains('menu')")
    check("'chats' trigger sits next to the root-claude button", placed)

    page.click("#sess-open")
    page.wait_for_selector(".sess-overlay:not([hidden])")
    rows = page.eval_on_selector_all(".sess-row .s-title", "els => els.map(e => e.textContent)")
    check("lists all sessions newest-first",
          rows == ["Resume Humble Hub setup", "Discuss project structure", "Add favicon logo styling"],
          str(rows))
    projs = page.eval_on_selector_all(".sess-row .s-proj", "els => els.map(e => e.textContent)")
    check("shows project tags", projs == ["~", "babble-building", "wow-world-wiki"], str(projs))
    meta0 = page.eval_on_selector(".sess-row .s-meta", "el => el.textContent")
    check("meta shows relative time + count", "1h ago" in meta0 and "286 msgs" in meta0, meta0)

    # search filters
    page.fill("#sess-search", "favicon")
    rows = page.eval_on_selector_all(".sess-row .s-title", "els => els.map(e => e.textContent)")
    check("search filters by title/preview", rows == ["Add favicon logo styling"], str(rows))
    page.fill("#sess-search", "")

    # clicking a row resumes that session (stub openDrawer to capture the call)
    page.evaluate("window.openDrawer = (p, o) => { window.__resume = { p, o }; }")
    page.click(".sess-row:has-text('Resume Humble Hub setup')")
    resume = page.evaluate("window.__resume")
    overlay_hidden = page.eval_on_selector(".sess-overlay", "el => el.hidden")
    check("row click resumes the right session and closes the modal",
          resume and resume["p"] == "~" and resume["o"]["session"] == "aaaa-1111"
          and resume["o"]["label"] == "Resume Humble Hub setup" and overlay_hidden,
          json.dumps(resume))


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 1000})
    try:
        run(page)
    finally:
        browser.close()

print()
if failures:
    print(f"❌ {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("✅ all checks passed")
