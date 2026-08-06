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
        elif "/api/notes/wip/" in u:
            # the merge-safe mark endpoint — mimic the server's one-id merge
            sid = u.rsplit("/", 1)[1]
            on = json.loads(r.request.post_data).get("on")
            wip = [i for i in store.get("wip", []) if i != sid] + ([sid] if on else [])
            store["wip"] = wip
            r.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"ok": True, "wip": wip}))
        elif u.endswith("/api/notes"):
            if r.request.method == "GET":
                body = json.dumps(store)
            else:
                saved.append(r.request.post_data)
                # the whole-doc PUT must NOT be how marks travel — preserve the
                # store's wip like the real server does for other writers' PUTs
                wip = store.get("wip", [])
                store.clear()
                store.update(json.loads(r.request.post_data))
                store["wip"] = wip
                body = '{"ok":true}'
            r.fulfill(status=200, content_type="application/json", body=body)
        else:
            r.continue_()
    # ** (not *) after /api: the wip endpoint has a deeper path, and an
    # unmatched route would fall through to the LIVE hub's notes.json
    page.route("**/api/**", route)

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
    page.wait_for_timeout(300)          # the wip POST is immediate, not debounced
    check("the mark reaches the store through its own endpoint",
          store.get("wip") == ["cccc-3333"], str(store.get("wip")))

    # a mark you can't see how to undo is a trap — the toggle stays visible
    check("a marked row keeps its toggle on screen",
          page.eval_on_selector(".sess-row.wip .s-wip",
                                "el => getComputedStyle(el).opacity") == "1")

    page.click(".sess-row.wip .s-wip")
    page.wait_for_timeout(300)
    check("clicking again clears the mark",
          page.eval_on_selector_all(".sess-row.wip", "els => els.length") == 0
          and store.get("wip") == [], str(store.get("wip")))
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
    page.wait_for_timeout(300)
    check("the head button marks the open chat",
          page.eval_on_selector(wip_btn, "el => el.classList.contains('on')")
          and store.get("wip") == ["aaaa-1111"], str(store.get("wip")))

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
    page.wait_for_timeout(300)
    check("marking another chat leaves the open chat's button alone",
          page.eval_on_selector(wip_btn, "el => !el.classList.contains('on')")
          and store.get("wip") == ["bbbb-2222"], str(store.get("wip")))
    page.evaluate("sessions.get('fake').sid = 'bbbb-2222'; syncDrawerWip(); null")
    check("…and switching the drawer to that chat lights it up",
          page.eval_on_selector(wip_btn, "el => el.classList.contains('on')"))
    page.evaluate("sessions.get('fake').sid = 'aaaa-1111'; null")
    page.click(".sess-row.wip .s-wip")
    page.wait_for_timeout(600)

    page.evaluate("closeSessions(); null")   # left open by the head-button block

    # --- review regression: a re-read must not eat a pending edit ---
    # an edit is queued (debounced 400ms), then the jot modal re-reads the doc;
    # the flush now lives inside loadNotes, so no call site can skip it again
    page.evaluate("notes.todos.push({text: 'flush probe', done: false}); "
                  "saveNotes(); openJot('todos'); null")
    page.wait_for_timeout(800)
    check("a pending edit survives the jot modal's re-read",
          any("flush probe" in (s or "") for s in saved),
          f"{len(saved)} PUTs, none carried the edit")
    check("…and is still in the page's doc afterwards",
          page.evaluate("notes.todos.some(t => t.text === 'flush probe')"))
    page.evaluate("closeJot(); null")

    # --- review regression: an orphaned mark is visible and clearable ---
    page.evaluate("toggleWip('9999-dead'); null")     # id no transcript will ever list
    page.wait_for_timeout(300)
    page.click("#sess-open")
    page.wait_for_selector(".sess-overlay:not([hidden])")
    check("a mark with no listable conversation gets its own row",
          page.eval_on_selector_all(".sess-row.orphan", "els => els.length") == 1
          and "not listable" in " ".join(page.eval_on_selector_all(
              ".sess-band", "els => els.map(e => e.textContent)")))
    page.click(".sess-row.orphan .s-wip")
    page.wait_for_timeout(300)
    check("clearing the orphan removes it and the mark",
          page.eval_on_selector_all(".sess-row.orphan", "els => els.length") == 0
          and "9999-dead" not in store.get("wip", []), str(store.get("wip")))
    # the overlay stays open: the resume-row block at the end relies on it

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
