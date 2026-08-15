#!/usr/bin/env python3
"""Drive the live hub (localhost:7700) with Playwright to verify the banded
shelf: pinned / in motion / the rest ordering, the archive fold, and search
reaching into it. Hermetic: /api/notes is intercepted (empty fixture served,
saves captured in-memory) and card recency is stubbed via data-act — the real
data/notes.json is never touched. Run with the playwright venv:

    ~/.venvs/playwright/bin/python tests/test_shelf.py
"""
import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://localhost:7700/"

FIXTURE = {"todos": [], "ideas": [], "favorites": [], "archived": []}

saved = []  # captured PUT bodies, newest last
failures = []


def check(name, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {name}{'' if cond else '  — ' + detail}")
    if not cond:
        failures.append(name)


def grid_names(page):
    return page.eval_on_selector_all(
        "#grid .card", "els => els.map(e => e.dataset.name)")


def arch_names(page):
    return page.eval_on_selector_all(
        "#archive .card", "els => els.map(e => e.dataset.name)")


def heads(page):
    return page.eval_on_selector_all(
        "#grid .band-head",
        "els => els.filter(e => e.style.display !== 'none')"
        ".map(e => e.dataset.band)")


def run(page):
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    def handle(route):
        req = route.request
        if req.method == "PUT":
            saved.append(json.loads(req.post_data))
            route.fulfill(status=200, content_type="application/json",
                          body='{"ok":true}')
        else:
            route.fulfill(status=200, content_type="application/json",
                          body=json.dumps(FIXTURE))

    page.route("**/api/notes", handle)
    page.goto(URL)
    page.wait_for_selector(".card")

    names = grid_names(page) + arch_names(page)
    if len(names) < 4:
        print("need at least 4 projects on the shelf to test banding")
        sys.exit(1)
    fav, hot, cold, boxed = names[0], names[1], names[2], names[3]

    # stub recency + notes, then re-band: fav pinned, hot recent, cold stale,
    # boxed archived; every other card pushed to "the rest"
    page.evaluate(
        """([fav, hot, cold, boxed]) => {
          const now = Math.floor(Date.now() / 1000);
          document.querySelectorAll('.card').forEach(c => c.dataset.act = 0);
          const act = n => document.querySelector(`.card[data-name="${n}"]`);
          act(hot).dataset.act = now;
          act(fav).dataset.act = now;      // pinned must beat "in motion"
          notes.favorites = [fav];
          notes.archived = [boxed];
          reorderCards();
        }""", [fav, hot, cold, boxed])

    order = grid_names(page)
    check("pinned card leads the grid", order[0] == fav,
          f"grid starts with {order[:3]}")
    check("recent card precedes stale card",
          order.index(hot) < order.index(cold), f"{order[:6]}")
    check("band heads read pinned / in motion / the rest",
          heads(page) == ["pinned", "motion", "rest"], str(heads(page)))
    check("archived card sits in the archive fold",
          arch_names(page) == [boxed], str(arch_names(page)))
    check("archive fold is visible with count 1",
          page.eval_on_selector("#archive", "e => !e.hidden")
          and page.eval_on_selector("#arch-count", "e => e.textContent") == "1")
    check("archived card's box toggle lights up as unarchive",
          page.eval_on_selector(
              f'.m-arch[data-arch="{boxed}"]',
              "e => e.classList.contains('on') && e.title.startsWith('unarchive')"))
    check("unarchived cards' box toggle stays off",
          page.eval_on_selector(
              f'.m-arch[data-arch="{cold}"]',
              "e => !e.classList.contains('on') && e.title.startsWith('archive')"))

    # unarchive via the head toggle (beside ★), then archive a different card
    page.evaluate(
        f"""document.querySelector('.m-arch[data-arch="{boxed}"]').click()""")
    check("unarchive returns the card to the grid",
          boxed in grid_names(page) and arch_names(page) == [])
    check("empty archive fold hides itself",
          page.eval_on_selector("#archive", "e => e.hidden"))
    page.evaluate(
        f"""document.querySelector('.m-arch[data-arch="{cold}"]').click()""")
    check("archiving moves the card into the fold",
          arch_names(page) == [cold] and cold not in grid_names(page))
    page.wait_for_timeout(600)  # saveNotes debounce
    check("archive toggles were persisted",
          saved and saved[-1].get("archived") == [cold],
          f"last save: {saved[-1].get('archived') if saved else None}")

    # search reaches into the archive and refolds on clear
    page.fill("#search", cold)
    page.wait_for_timeout(100)
    check("search unfolds the archive on a hit",
          page.eval_on_selector("#archive", "e => e.open"))
    page.fill("#search", "")
    page.wait_for_timeout(100)
    check("clearing the search refolds the archive",
          page.eval_on_selector("#archive", "e => !e.open"))

    # a filter that empties a band hides that band's head
    page.fill("#search", hot)
    page.wait_for_timeout(100)
    check("filtered-out bands drop their heads", heads(page) == ["motion"],
          str(heads(page)))
    page.fill("#search", "")

    check("no JS errors", not errors, "; ".join(errors))


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page()
        try:
            run(page)
        finally:
            browser.close()
    if failures:
        print(f"\n❌ {len(failures)} check(s) failed")
        sys.exit(1)
    print("\n✅ all checks passed")


if __name__ == "__main__":
    main()
