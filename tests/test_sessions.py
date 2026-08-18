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
        detachedPtys.length = 0;   // the LIVE hub's real ptys must not count here
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

    # --- rename a chat from the drawer head ---
    # 'b' is active-able: activate() needs its host/token; rename must update
    # the title, the pill, and the per-token store that survives reloads
    page.evaluate("closeSessions(); null")   # the modal sits over the drawer
    page.evaluate("active = 'b'; document.getElementById('d-title').textContent = "
                  "sessions.get('b').label; null")
    page.click("#d-title")
    page.fill("#d-title input", "bed levelling deep-dive")
    page.press("#d-title input", "Enter")
    page.wait_for_timeout(200)
    check("renaming updates the drawer title",
          page.eval_on_selector("#d-title", "el => el.textContent")
          == "bed levelling deep-dive")
    check("…and the pill (project still leads)",
          any("print-picker · bed levelling" in t for t in page.eval_on_selector_all(
              "#pills .pill", "els => els.map(e => e.textContent)")),
          str(page.eval_on_selector_all("#pills .pill", "els => els.map(e => e.textContent)")))
    check("…and sticks to the pty token for reloads",
          page.evaluate("JSON.parse(localStorage.getItem('ptyLabel'))['b']")
          == "bed levelling deep-dive")
    # empty name = back to the default
    page.click("#d-title")
    page.fill("#d-title input", "")
    page.press("#d-title input", "Enter")
    page.wait_for_timeout(200)
    check("an empty rename resets to the project default",
          page.eval_on_selector("#d-title", "el => el.textContent") == "print-picker"
          and page.evaluate("!JSON.parse(localStorage.getItem('ptyLabel'))['b']"))
    page.click("#sess-open")                 # the resume-row block needs it back
    page.wait_for_selector(".sess-overlay:not([hidden])")

    # --- two tiles: a chat per pane, each owning its head ---
    page.evaluate("closeSessions(); null")
    page.evaluate("""() => {
        const mk = (k, label) => {
            const host = document.createElement("div");
            document.getElementById("dterm").appendChild(host);
            sessions.set(k, { key: k, name: k, label, token: k, sid: "", host,
                opened: true, fit: { fit() {} },
                term: { focus() {}, refresh() {}, scrollToBottom() {}, cols: 80, rows: 24 },
                ws: { readyState: 1, send: () => {} }, status: "ready" });
        };
        sessions.clear(); detachedPtys.length = 0;
        window.mkTile = mk;
        mk("t1", "left work");
        document.getElementById("drawer").classList.add("open");
        document.body.classList.add("drawer-open");
        activate("t1");
        renderPills();
    }""")
    check("one chat keeps today's header: no tile heads, no ⋯",
          page.eval_on_selector_all(".tile-head:not([hidden])", "els => els.length") == 0
          and page.eval_on_selector("#d-title", "el => getComputedStyle(el).display") != "none")

    # ⫿ never guesses the second chat: it asks. With a single chat there is no
    # live chat to offer, so it offers a fresh one (this project first) or a past one
    page.click("#d-split")
    opts = page.eval_on_selector_all(".row-menu button", "els => els.map(e => e.textContent)")
    check("⫿ opens a chooser instead of splitting blind",
          not page.evaluate("document.body.classList.contains('drawer-split')") and len(opts) > 0)
    check("with one chat it offers no live chat, only a fresh or a past one",
          not any(o.startswith("→ ") for o in opts)
          and opts[0] == "new chat → t1" and opts[1] == "a past chat…", str(opts))
    check("…and a fresh chat for any other project, filterable",
          any(o.startswith("new chat → ") and o != "new chat → t1" for o in opts)
          and page.eval_on_selector(".row-menu-search", "el => !!el"))
    page.keyboard.press("Escape")
    check("escape cancels: nothing split", page.evaluate("!document.querySelector('.row-menu')")
          and not page.evaluate("document.body.classList.contains('drawer-split')"))
    page.click("#d-split")
    page.click("#d-split")           # ⫿ again = close the chooser (a toggle)
    check("a second press on ⫿ closes its chooser, splitting nothing",
          page.evaluate("!document.querySelector('.row-menu')")
          and not page.evaluate("document.body.classList.contains('drawer-split')"))

    # with a second live chat, that chat is the first offer; picking it splits
    page.evaluate("mkTile('t2', 'right work'); renderPills(); null")
    page.click("#d-split")
    opts = page.eval_on_selector_all(".row-menu button", "els => els.map(e => e.textContent)")
    check("live chats lead the chooser (the one you're in is not offered)",
          opts[0] == "→ right work" and "→ left work" not in opts, str(opts))
    page.click(".row-menu button:has-text('→ right work')")
    page.wait_for_timeout(150)
    check("splitting gives each pane its own head",
          page.eval_on_selector_all(".tile-head:not([hidden])", "els => els.length") == 2)
    names = page.eval_on_selector_all(".tile-head:not([hidden]) .th-name",
                                      "els => els.map(e => e.textContent)")
    check("each head names ITS OWN chat", names == ["left work", "right work"], str(names))
    check("the drawer's per-chat buttons step aside for the per-pane ones",
          page.eval_on_selector("#d-title", "el => getComputedStyle(el).display") == "none"
          and page.eval_on_selector("#d-wip", "el => getComputedStyle(el).display") == "none")
    check("the focused pane is marked, and it is the one pills load into",
          page.eval_on_selector("#tile-head-1", "el => el.classList.contains('focused')")
          and page.evaluate("active") == "t2")

    # a pill has ONE meaning again: load that chat into the focused pane
    page.evaluate("focusTile(0); null")
    page.wait_for_timeout(100)
    check("clicking a pill loads the chat into the focused pane",
          page.evaluate("focusedTile") == 0 and page.evaluate("active") == "t1")
    page.evaluate("""() => {
        const mk = (k, label) => {
            const host = document.createElement("div");
            document.getElementById("dterm").appendChild(host);
            sessions.set(k, { key: k, name: k, label, token: k, sid: "", host,
                opened: true, fit: { fit() {} },
                term: { focus() {}, refresh() {}, scrollToBottom() {}, cols: 80, rows: 24 },
                ws: { readyState: 1, send: () => {} }, status: "ready" });
        };
        mk("t3", "third chat");
        renderPills();
    }""")
    page.evaluate("activate('t3'); null")
    page.wait_for_timeout(100)
    check("…without disturbing the other pane",
          page.eval_on_selector("#tile-head-0 .th-name", "el => el.textContent") == "third chat"
          and page.eval_on_selector("#tile-head-1 .th-name", "el => el.textContent") == "right work")

    # the ⋯ carries that pane's own actions
    page.click("#tile-head-1 .th-dots")
    check("the ⋯ opens that pane's actions",
          page.eval_on_selector("#tile-head-1 .th-menu", "el => el.classList.contains('open')")
          and page.evaluate("focusedTile") == 1)
    labels = page.eval_on_selector_all("#tile-head-1 .th-menu button",
                                       "els => els.map(e => e.textContent)")
    check("…including rename, mark, attach, jump, close-pane and end-chat",
          labels == ["rename this chat", "mark unfinished", "attach an image",
                     "jump to the bottom", "close this pane (chat keeps running)",
                     "end this chat"], str(labels))

    # names must never go missing from a head: through a rename in the head
    # itself (a re-render mid-edit used to be able to swallow the input), on
    # the pill, and on the untouched neighbour
    page.click("#tile-head-1 .th-menu button:has-text('rename this chat')")
    page.wait_for_selector("#tile-head-1 .th-name input")
    page.evaluate("renderTileHeads(); null")          # a re-render mid-edit
    check("a re-render while renaming keeps the input (and the name) alive",
          page.eval_on_selector("#tile-head-1 .th-name", "el => !!el.querySelector('input')"))
    page.fill("#tile-head-1 .th-name input", "compare pane")
    page.press("#tile-head-1 .th-name input", "Enter")
    page.wait_for_timeout(150)
    check("renaming from a head renames THAT pane's chat…",
          page.eval_on_selector("#tile-head-1 .th-name", "el => el.textContent") == "compare pane"
          and page.eval_on_selector("#tile-head-0 .th-name", "el => el.textContent") == "third chat")
    check("…and its pill; no head is ever blank",
          page.evaluate("[...document.querySelectorAll('#pills .pill')].some(p => p.textContent.includes('compare pane'))")
          and page.evaluate("[...document.querySelectorAll('.tile-head:not([hidden]) .th-name')].every(e => e.textContent.trim())"))
    page.click("#tile-head-1 .th-dots")
    page.click("#tile-head-1 .th-menu button:has-text('rename this chat')")
    page.fill("#tile-head-1 .th-name input", "right work")
    page.press("#tile-head-1 .th-name input", "Enter")
    page.wait_for_timeout(150)
    check("a second rename lands too (heads re-render from the label)",
          page.eval_on_selector("#tile-head-1 .th-name", "el => el.textContent") == "right work")
    page.click("#tile-head-1 .th-dots")                # re-open for the checks below

    # the heads sit ON the terminal: ink-coloured text there is invisible, which
    # is what focusing a head used to do (dark on #1a1b26)
    focused_col = page.eval_on_selector("#tile-head-1.focused", "el => getComputedStyle(el).color")
    check("a focused head stays legible over the dark terminal",
          focused_col == "rgb(255, 255, 255)", focused_col)
    dots_col = page.eval_on_selector("#tile-head-1 .th-dots", "el => getComputedStyle(el).color")
    check("…and so does its ⋯", dots_col == "rgb(255, 255, 255)", dots_col)

    # controls whose target is ambiguous in a split step aside
    check("⤢ hides while split (splitting already implies full width)",
          page.eval_on_selector("#d-full", "el => getComputedStyle(el).display") == "none")
    check("the drawer's ✕ hides too — 'which chat?' has no answer there",
          page.eval_on_selector("#d-close", "el => getComputedStyle(el).display") == "none")

    page.click("#tile-head-1 .th-menu button:nth-child(5)")
    page.wait_for_timeout(150)
    check("closing a pane returns to one chat, keeping the other",
          not page.evaluate("document.body.classList.contains('drawer-split')")
          and page.evaluate("active") == "t3"
          and page.eval_on_selector_all(".tile-head:not([hidden])", "els => els.length") == 0)
    check("…and the drawer title names the chat that stayed",
          page.eval_on_selector("#d-title", "el => el.textContent") == "third chat")
    check("the closed pane's chat is still alive in the pills",
          page.evaluate("sessions.has('t2')"))
    check("…and the drawer's own controls come back with one chat",
          page.eval_on_selector("#d-full", "el => getComputedStyle(el).display") != "none"
          and page.eval_on_selector("#d-close", "el => getComputedStyle(el).display") != "none")
    # the split began from the side panel, so un-splitting returns there —
    # not to a full-screen single chat (which read as "⫿ maximises")
    check("un-splitting from a side-panel split returns to the side panel",
          not page.evaluate("document.body.classList.contains('drawer-full')"))
    # …but a split that began from full width stays full when it ends
    page.evaluate("toggleDrawerFull(); null")
    page.click("#d-split")
    page.click(".row-menu button:has-text('→ right work')")
    page.wait_for_timeout(150)
    page.click("#d-split")           # ⫿ while split = back to one chat
    page.wait_for_timeout(150)
    check("un-splitting from a full-width split stays full",
          not page.evaluate("document.body.classList.contains('drawer-split')")
          and page.evaluate("document.body.classList.contains('drawer-full')"))
    page.evaluate("toggleDrawerFull(); null")

    # the fresh-chat pick opens a NEW chat for that project into the right pane
    # (openDrawer is stubbed above, so we see the call rather than a pty)
    page.evaluate("window.__resume = null; null")
    page.click("#d-split")
    page.click(".row-menu button:has-text('new chat → t3')")
    page.wait_for_timeout(150)
    fresh = page.evaluate("window.__resume")
    check("'new chat → project' splits and asks for a FRESH chat there",
          page.evaluate("document.body.classList.contains('drawer-split')")
          and fresh and fresh["p"] == "t3" and fresh["o"].get("fresh") is True, json.dumps(fresh))
    check("…into the right pane: it is focused and, until the chat lands, says so",
          page.evaluate("focusedTile") == 1
          and page.eval_on_selector("#tile-head-1", "el => el.classList.contains('empty')")
          and "empty pane" in page.eval_on_selector("#tile-head-1 .th-name", "el => el.textContent")
          and page.eval_on_selector("#tile-head-1 .th-dots", "el => getComputedStyle(el).display") == "none")
    # a pane fills from the pills, so while split they must sit ABOVE the
    # full-width drawer (at their usual z-index they were hidden beneath it)
    check("the pills are reachable over the split drawer",
          page.evaluate("""() => {
              const p = document.querySelector('#pills .pill'); if (!p) return false;
              const r = p.getBoundingClientRect();
              return document.elementFromPoint(r.left + r.width/2, r.top + r.height/2)?.closest('.pill') === p;
          }"""))
    page.click("#d-split")           # back to one chat
    page.wait_for_timeout(150)

    # the past-chat pick opens the conversations list; the row you choose
    # lands in the waiting right pane
    page.evaluate("window.__resume = null; null")
    page.click("#d-split")
    page.click(".row-menu button:has-text('a past chat…')")
    page.wait_for_selector(".sess-overlay:not([hidden])")
    check("'a past chat…' splits with an empty, focused right pane and opens the list",
          page.evaluate("document.body.classList.contains('drawer-split')")
          and page.evaluate("focusedTile") == 1
          and page.eval_on_selector("#tile-head-1", "el => el.classList.contains('empty')"))
    page.click(".sess-row:has-text('Resume Humble Hub setup')")
    past = page.evaluate("window.__resume")
    check("…and the chosen conversation is resumed (into that pane)",
          past and past["o"]["session"] == "aaaa-1111", json.dumps(past))
    page.click("#d-split")           # back to one chat
    page.wait_for_timeout(150)
    page.click("#sess-open")
    page.wait_for_selector(".sess-overlay:not([hidden])")

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
