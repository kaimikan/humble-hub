#!/usr/bin/env python3
"""Phone-UX checks against the live hub: key toolbar visibility, mic button,
no-keyboard-popup behaviour (toolbar taps must not focus xterm's textarea),
full-width drawer on small screens, laptop-only actions hidden on touch.

    ~/.venvs/playwright/bin/python tests/test_phone_ux.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:7700/"
failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def stub_notes(page):
    page.route("**/api/notes", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body=json.dumps({"todos": [], "ideas": []}) if r.request.method == "GET" else '{"ok":true}'))


with sync_playwright() as p:
    browser = p.chromium.launch()

    # --- desktop: toolbar hidden, laptop actions visible ---------------------
    ctx = browser.new_context(viewport={"width": 1300, "height": 900})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    stub_notes(pg)
    pg.goto(URL, wait_until="networkidle")
    check("desktop: no JS errors", not errs, "; ".join(errs))
    check("desktop: kbar hidden",
          pg.eval_on_selector(".kbar", "el => getComputedStyle(el).display") == "none")
    check("desktop: files buttons visible",
          pg.eval_on_selector(".b-files", "el => getComputedStyle(el).display") != "none")

    # ⤢ toggles the drawer to full window width in place (no navigation)
    pg.evaluate("""() => {
      document.getElementById('drawer').classList.add('open');
      document.body.classList.add('drawer-open');
      window.toggleDrawerFull();
    }""")
    pg.wait_for_timeout(350)
    check("⤢ expands the drawer to full width in place",
          pg.evaluate("document.body.classList.contains('drawer-full')") and
          pg.eval_on_selector("#drawer", "el => getComputedStyle(el).width") ==
          pg.evaluate("window.innerWidth + 'px'"))
    pg.evaluate("window.toggleDrawerFull()")
    pg.wait_for_timeout(350)
    check("⤢ toggles back to the side-drawer width",
          not pg.evaluate("document.body.classList.contains('drawer-full')"))
    ctx.close()

    # --- mobile: toolbar + mic shown, laptop actions hidden ------------------
    ctx = browser.new_context(viewport={"width": 390, "height": 840},
                              is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    stub_notes(pg)
    pg.goto(URL, wait_until="networkidle")
    check("mobile: no JS errors", not errs, "; ".join(errs))
    check("mobile: kbar shown",
          pg.eval_on_selector(".kbar", "el => getComputedStyle(el).display") == "flex")
    check("mobile: mic button present",
          pg.eval_on_selector(".kbar .mic", "el => el.textContent.includes('🎤')"))
    check("mobile: files buttons hidden",
          pg.eval_on_selector(".b-files", "el => getComputedStyle(el).display") == "none")
    konsole_hidden = pg.eval_on_selector_all(
        ".menu-items button",
        "els => els.filter(b => /konsole/i.test(b.textContent))"
        ".every(b => b.style.display === 'none')")
    check("mobile: 'in konsole' menu items hidden", konsole_hidden)
    check("mobile: drawer is full-width",
          pg.evaluate("getComputedStyle(document.getElementById('drawer')).width") ==
          pg.evaluate("window.innerWidth + 'px'"),
          pg.evaluate("getComputedStyle(document.getElementById('drawer')).width"))

    # --- no-keyboard-popup: tapping a kbar key must not move focus ----------
    pg.evaluate("""() => {
      document.getElementById('drawer').classList.add('open');
      const ta = document.createElement('textarea');
      ta.id = 'fake-xterm-input';
      document.getElementById('dterm').appendChild(ta);
      document.getElementById('search').focus();
    }""")
    before = pg.evaluate("document.activeElement.id || document.activeElement.tagName")
    pg.tap(".kbar button:first-child")
    after = pg.evaluate("document.activeElement.id || document.activeElement.tagName")
    check("toolbar tap does not steal/redirect focus", before == after,
          f"before={before} after={after}")
    not_textarea = pg.evaluate("document.activeElement.tagName !== 'TEXTAREA'")
    check("toolbar tap does not focus a textarea (no soft keyboard)", not_textarea)
    ctx.close()
    browser.close()

print()
if failures:
    print(f"❌ {len(failures)} failed: {', '.join(failures)}")
    sys.exit(1)
print("✅ all checks passed")
