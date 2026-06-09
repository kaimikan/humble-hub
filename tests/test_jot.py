#!/usr/bin/env python3
"""Drive the live hub (localhost:7700) with Playwright to verify the jot
(to-do / ideas) UX. Hermetic: /api/notes is intercepted, so a fixture is
served and saves are captured in-memory — the real data/notes.json is never
touched. Run with the project's playwright venv:

    ~/.venvs/playwright/bin/python tests/test_jot.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:7700/"

FIXTURE = {
    "todos": [
        {"text": "alpha", "done": False},
        {"text": "bravo-done", "done": True},
        {"text": "charlie", "done": False},
    ],
    "ideas": [
        {"text": "idea-one"},
        {"text": "idea-two"},
    ],
}

saved = []  # captured PUT bodies, newest last
failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def texts(page, list_id):
    return page.eval_on_selector_all(
        f"#{list_id} li:not(.empty-hint) .txt",
        "els => els.map(e => e.textContent)")


def run(page):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    # /api/ptys 404s until the server restart that deploys it — expected noise
    page.on("console", lambda m: errors.append(m.text)
            if m.type == "error"
            and "api/ptys" not in str(getattr(m, "location", "")) else None)

    def handle(route):
        req = route.request
        if req.method == "PUT":
            saved.append(json.loads(req.post_data))
            route.fulfill(status=200, content_type="application/json", body='{"ok":true}')
        else:
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(FIXTURE))
    page.route("**/api/notes", handle)

    page.goto(URL, wait_until="networkidle")
    check("page loads without JS errors", not errors, "; ".join(errors))

    # --- feature 3: filter pill toggles off on second click -----------------
    cards_total = page.eval_on_selector_all(".card", "els => els.length")
    page.click('#filters .chip[data-type="site"]')
    after_pick = page.eval_on_selector_all(
        ".card", "els => els.filter(c => c.style.display !== 'none').length")
    page.click('#filters .chip[data-type="site"]')  # second click → back to all
    after_toggle = page.eval_on_selector_all(
        ".card", "els => els.filter(c => c.style.display !== 'none').length")
    all_active = page.eval_on_selector(
        '#filters .chip[data-type=""]', "el => el.classList.contains('active')")
    check("filter pill narrows then toggles back to all",
          after_pick < cards_total and after_toggle == cards_total and all_active,
          f"total={cards_total} picked={after_pick} toggled={after_toggle} all_active={all_active}")

    # --- open the to-do modal ----------------------------------------------
    page.click("button.jot-open:has-text('to-do')")
    page.wait_for_selector("#overlay:not([hidden])")

    # default filter = active → done item hidden
    check("opens on the active filter (done hidden)",
          texts(page, "todos") == ["alpha", "charlie"],
          str(texts(page, "todos")))
    active_chip = page.eval_on_selector(
        ".todo-filter .chip.active", "el => el.dataset.val")
    check("the 'active' pill is the one marked active", active_chip == "active", active_chip)

    # color-coded pills (ochre active, verdigris done) via the --chip var
    done_color = page.eval_on_selector(
        ".todo-filter .chip[data-val='done']",
        "el => el.style.getPropertyValue('--chip')")
    check("done pill is color-coded", done_color.strip() == "#4f6b3a", done_color)

    # each row has checkbox + drag handle + ⋯ menu button
    row_ok = page.eval_on_selector(
        "#todos li",
        "li => !!li.querySelector('input[type=checkbox]') "
        "&& !!li.querySelector('.drag-handle') && !!li.querySelector('.row-menu-btn')")
    check("rows have checkbox, drag handle, and ⋯ menu", row_ok)

    # --- header switch button: to-do ⇄ ideas -------------------------------
    check("switch button targets ideas from to-do",
          page.locator("#jot-switch").text_content().strip() == "→ ideas")
    page.click("#jot-switch")
    page.wait_for_timeout(150)
    on_ideas = page.eval_on_selector("#col-ideas", "el => el.style.display !== 'none'") \
        and page.eval_on_selector("#m-title", "el => el.textContent") == "ideas"
    check("switch jumps to the ideas list", on_ideas)
    check("switch button now targets to-do",
          page.locator("#jot-switch").text_content().strip() == "→ to-do")
    page.click("#jot-switch")
    page.wait_for_timeout(150)
    check("switch flips back to to-do",
          page.eval_on_selector("#m-title", "el => el.textContent") == "to-do")

    # --- search box --------------------------------------------------------
    page.click(".todo-filter .chip[data-val='all']")
    page.fill("#jot-search", "charlie")
    check("search filters the to-do list", texts(page, "todos") == ["charlie"],
          str(texts(page, "todos")))
    page.fill("#jot-search", "zzz-nothing")
    hint = page.eval_on_selector("#todos li.empty-hint", "el => el.textContent")
    check("search shows a no-match hint", "nothing matches" in hint, hint)
    page.fill("#jot-search", "")
    check("clearing search restores the list",
          texts(page, "todos") == ["alpha", "bravo-done", "charlie"],
          str(texts(page, "todos")))
    page.fill("#jot-search", "active-only")
    page.click(".todo-filter .chip[data-val='active']")
    page.fill("#jot-search", "bravo")
    check("search composes with the active filter (done item hidden)",
          texts(page, "todos") == [], str(texts(page, "todos")))
    page.fill("#jot-search", "")
    page.click(".todo-filter .chip[data-val='all']")

    # filter switching
    page.click(".todo-filter .chip[data-val='done']")
    check("done filter shows only finished", texts(page, "todos") == ["bravo-done"],
          str(texts(page, "todos")))
    page.click(".todo-filter .chip[data-val='all']")
    check("all filter shows everything",
          texts(page, "todos") == ["alpha", "bravo-done", "charlie"],
          str(texts(page, "todos")))

    # --- reference numbers --------------------------------------------------
    def idxs(list_id):
        return page.eval_on_selector_all(
            f"#{list_id} li:not(.empty-hint) .idx", "els => els.map(e => e.textContent)")
    check("all view numbers active only (done unnumbered)",
          idxs("todos") == ["1", "", "2"], str(idxs("todos")))
    page.click(".todo-filter .chip[data-val='active']")
    check("active view keeps the same numbers", idxs("todos") == ["1", "2"], str(idxs("todos")))
    check("ideas are all numbered", idxs("ideas") == ["1", "2"], str(idxs("ideas")))
    page.click(".todo-filter .chip[data-val='all']")

    # --- action menu: demote a to-do to ideas ------------------------------
    saved.clear()
    page.click("#todos li:has-text('alpha') .row-menu-btn")
    page.wait_for_selector(".row-menu")
    menu_items = page.eval_on_selector_all(".row-menu button", "els => els.map(e => e.textContent)")
    check("todo menu offers mark/convert/remove",
          any("idea" in m for m in menu_items) and any("remove" in m for m in menu_items),
          str(menu_items))
    page.click(".row-menu button:has-text('make idea')")
    page.wait_for_timeout(600)  # let the debounced save flush
    last = saved[-1] if saved else {}
    moved = ([t["text"] for t in last.get("todos", [])] == ["bravo-done", "charlie"]
             and any(i["text"] == "alpha" for i in last.get("ideas", [])))
    check("demote to-do → idea persists", moved, json.dumps(last))

    # --- drag reorder: move charlie above bravo-done -----------------------
    saved.clear()
    page.click(".todo-filter .chip[data-val='all']")
    rows = page.query_selector_all("#todos li:not(.empty-hint)")
    # current order after demote: bravo-done, charlie
    handle = page.query_selector("#todos li:has-text('charlie') .drag-handle")
    hb = handle.bounding_box()
    target = page.query_selector("#todos li:has-text('bravo-done')").bounding_box()
    page.mouse.move(hb["x"] + hb["width"] / 2, hb["y"] + hb["height"] / 2)
    page.mouse.down()
    for k in range(1, 6):
        page.mouse.move(hb["x"] + 5, hb["y"] + (target["y"] - hb["y"]) * k / 5 - 6)
    page.mouse.move(target["x"] + 5, target["y"] - 6)
    page.mouse.up()
    page.wait_for_timeout(600)
    last = saved[-1] if saved else {}
    order = [t["text"] for t in last.get("todos", [])]
    check("drag reorder persists new order", order == ["charlie", "bravo-done"], str(order))


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
