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
            and not any(ep in str(getattr(m, "location", "")) for ep in ("api/ptys", "api/services")) else None)

    saved = []          # every notes doc the page tried to persist
    # a GET serves back the last PUT, so re-reads behave like the real store
    # (a static empty fixture would hide marks the page had just saved)
    store = {"todos": [], "ideas": []}

    def route(r):
        u = r.request.url
        if u.endswith("/api/sessions"):
            r.fulfill(status=200, content_type="application/json", body=json.dumps(SESSIONS))
        elif u.endswith("/api/notes"):
            if r.request.method == "GET":
                body = json.dumps(store)
            else:
                saved.append(r.request.post_data)
                store.clear()
                store.update(json.loads(r.request.post_data))
                body = '{"ok":true}'
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

    # --- the unfinished mark (opt-in, one flag, keyed to the session id) ---
    # Stub first: if a flag click leaks through to its row, this records it.
    # The trailing `null` matters — page.evaluate INVOKES an expression that
    # evaluates to a function, so a bare assignment would call the stub itself.
    page.evaluate("window.openDrawer = (p, o) => { window.__resume = { p, o }; }; "
                  "window.__resume = null; null")
    check("nothing is marked by default",
          page.eval_on_selector_all(".sess-row.wip", "els => els.length") == 0
          and page.eval_on_selector_all(".sess-band", "els => els.length") == 0)

    page.click(".sess-row:has-text('Add favicon logo styling') .s-wip")
    check("marking does not resume the chat", page.evaluate("window.__resume") is None)
    check("the marked row floats to the top",
          page.eval_on_selector_all(".sess-row .s-title", "els => els.map(e => e.textContent)")[0]
          == "Add favicon logo styling")
    bands = page.eval_on_selector_all(".sess-band", "els => els.map(e => e.textContent)")
    check("marked and unmarked are banded apart", bands == ["still going", "the rest"], str(bands))
    page.wait_for_timeout(600)          # saveNotes debounces the PUT by 400ms
    check("the mark is stored against the session id, in the notes doc",
          saved and json.loads(saved[-1]).get("wip") == ["cccc-3333"],
          saved[-1] if saved else "(no save)")

    # a mark you can't see how to undo is a trap — the toggle stays visible
    check("a marked row keeps its toggle on screen",
          page.eval_on_selector(".sess-row.wip .s-wip",
                                "el => getComputedStyle(el).opacity") == "1")

    page.click(".sess-row.wip .s-wip")
    page.wait_for_timeout(600)
    check("clicking again clears the mark",
          page.eval_on_selector_all(".sess-row.wip", "els => els.length") == 0
          and json.loads(saved[-1]).get("wip") == [], saved[-1])
    check("clearing removes the bands too",
          page.eval_on_selector_all(".sess-band", "els => els.length") == 0)
    check("order returns to newest-first once nothing is marked",
          page.eval_on_selector_all(".sess-row .s-title", "els => els.map(e => e.textContent)")
          == ["Resume Humble Hub setup", "Discuss project structure", "Add favicon logo styling"])

    # --- the same flag, from the drawer head ---
    # a live chat is faked: no pty, no claude — only the bookkeeping the
    # header button reads (which session is shown, and its id)
    page.evaluate("closeSessions(); null")     # the modal would sit over the drawer
    page.evaluate("""() => {
        const host = document.createElement("div");
        document.getElementById("dterm").appendChild(host);
        sessions.set("fake", { key: "fake", name: "~", token: "tok", sid: "aaaa-1111",
                               label: "A", host, ws: { readyState: 1 }, status: "ready" });
        active = "fake";
        // slide the drawer in: its head is off-screen while closed
        document.getElementById("drawer").classList.add("open");
        document.body.classList.add("drawer-open");
        syncDrawerWip();
    }""")
    page.wait_for_timeout(300)          # the drawer transitions in
    wip_btn = "#drawer .d-head #d-wip"
    check("the drawer head carries the mark toggle",
          page.eval_on_selector(wip_btn, "el => !el.disabled"))

    # a chat whose real id we don't know must NOT invent one: a mark filed
    # against an id claude never saw is a mark against nothing, and it shows up
    # as "I marked it but the list never highlights it"
    page.evaluate("sessions.get('fake').sid = ''; syncDrawerWip(); null")
    check("an unknown-id chat disables the toggle instead of inventing an id",
          page.eval_on_selector(wip_btn, "el => el.disabled"))
    check("…and says why", "can't tell which conversation" in
          page.eval_on_selector(wip_btn, "el => el.title"))
    check("…and the cursor shows it is inert",
          page.eval_on_selector(wip_btn, "el => getComputedStyle(el).cursor")
          == "not-allowed")
    page.evaluate("sessions.get('fake').sid = 'aaaa-1111'; syncDrawerWip(); null")
    check("…showing unset for an unmarked chat",
          page.eval_on_selector(wip_btn, "el => !el.classList.contains('on')"))

    page.click(wip_btn)
    page.wait_for_timeout(600)
    check("the head button marks the open chat",
          page.eval_on_selector(wip_btn, "el => el.classList.contains('on')")
          and json.loads(saved[-1]).get("wip") == ["aaaa-1111"], saved[-1])

    page.click("#sess-open")
    page.wait_for_selector(".sess-overlay:not([hidden])")
    check("a chat marked from the drawer shows up marked in the list",
          page.eval_on_selector_all(".sess-row.wip .s-title",
                                    "els => els.map(e => e.textContent)")
          == ["Resume Humble Hub setup"])

    page.click(".sess-row.wip .s-wip")
    page.wait_for_timeout(600)
    check("clearing from the list clears the head button too (one flag)",
          page.eval_on_selector(wip_btn, "el => !el.classList.contains('on')"))

    # the head shows the ACTIVE chat only. Marking a different conversation in
    # the list must leave it alone — otherwise the button would lie about which
    # chat is flagged (this is what "it didn't update, then it did" looks like
    # when two chats are open and the marked one isn't the one on screen)
    page.click(".sess-row:has-text('Discuss project structure') .s-wip")
    page.wait_for_timeout(600)
    check("marking another chat leaves the open chat's button alone",
          page.eval_on_selector(wip_btn, "el => !el.classList.contains('on')")
          and json.loads(saved[-1]).get("wip") == ["bbbb-2222"], saved[-1])
    page.evaluate("sessions.get('fake').sid = 'bbbb-2222'; syncDrawerWip(); null")
    check("…and switching the drawer to that chat lights it up",
          page.eval_on_selector(wip_btn, "el => el.classList.contains('on')"))
    page.evaluate("sessions.get('fake').sid = 'aaaa-1111'; null")
    page.click(".sess-row.wip .s-wip")
    page.wait_for_timeout(600)

    # --- pills lead with the project, not the chat title ---
    page.evaluate("""() => {
        const mk = (key, name, label) => {
            const host = document.createElement("div");
            document.getElementById("dterm").appendChild(host);
            sessions.set(key, { key, name, label, token: key, sid: "",
                                host, ws: { readyState: 1 }, status: "ready" });
        };
        sessions.clear();
        mk("a", "print-picker", "print-picker");                      // fresh chat
        mk("b", "print-picker", "Add a bed-levelling checklist");     // resumed
        renderPills();
    }""")
    texts = page.eval_on_selector_all("#pills .pill", "els => els.map(e => e.textContent.trim())")
    check("a fresh chat's pill is just the project", texts[0] == "print-picker", str(texts))
    check("a resumed chat leads with the project, then its title",
          texts[1].startswith("print-picker · Add a bed"), str(texts))
    check("the full title stays in the tooltip",
          "Add a bed-levelling checklist" in
          page.eval_on_selector_all("#pills .pill", "els => els[1].title"))

    # clicking a row resumes that session (stub openDrawer to capture the call)
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
