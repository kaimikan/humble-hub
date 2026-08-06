// hub.js — shelf actions, search/filter, and the multi-session drawer.

async function act(name, action) {
  await fetch(`/api/projects/${name}/${action}`, { method: "POST" });
}

// --- service projects (hub.json) ---------------------------------------------
// ▶ open: pre-open the tab synchronously (popup rules), start the service if
// needed, then point the tab at it.

async function openService(name) {
  const tab = window.open("about:blank", "_blank");
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/service/open`,
                          { method: "POST" });
    const data = await r.json().catch(() => ({})); // body may be a plain error page
    if (!r.ok) throw new Error(data.detail || r.statusText || "service failed to start");
    if (tab) tab.location = data.url;
    refreshServiceDots();
  } catch (e) {
    if (tab) tab.close();
    alert(`couldn't start ${name}: ${e.message}`);
  }
}

async function stopService(name) {
  const dot = document.querySelector(`.svc-dot[data-svc="${name}"]`);
  if (dot) { dot.classList.remove("on"); dot.title = "stopping…"; } // instant feedback (keep the SVG)
  const r = await fetch(`/api/projects/${encodeURIComponent(name)}/service/stop`,
                        { method: "POST" });
  const data = await r.json().catch(() => ({}));
  refreshServiceDots();
  if (data.stopped === false) alert(`${name}: still listening — check journalctl --user -u hub-svc-${name}`);
}

async function refreshServiceDots() {
  try {
    const r = await fetch("/api/services");
    if (!r.ok) return; // older server — dots stay static
    const states = await r.json();
    document.querySelectorAll(".svc-dot").forEach(dot => {
      const on = !!states[dot.dataset.svc];
      dot.classList.toggle("on", on);   // keep the SVG; .svc-dot.on fills it via CSS
      dot.title = on ? "running" : "stopped";
    });
    document.querySelectorAll(".b-stop").forEach(b => {
      b.style.display = states[b.dataset.stop] ? "" : "none";
    });
  } catch (e) { /* hub offline mid-refresh — ignore */ }
}
refreshServiceDots();
setInterval(refreshServiceDots, 20000);

// --- search + type filter ---------------------------------------------------

let typeFilter = "";

function pick(chip) {
  // clicking the already-active chip toggles it off → falls back to "all"
  if (chip.classList.contains("active") && chip.dataset.type !== "") {
    chip = document.querySelector('#filters .chip[data-type=""]');
  }
  typeFilter = chip.dataset.type;
  document.querySelectorAll("#filters .chip").forEach(c => c.classList.toggle("active", c === chip));
  refilter();
}

function refilter() {
  const q = document.getElementById("search").value.toLowerCase();
  let visible = 0;
  document.querySelectorAll(".card").forEach(card => {
    const hit = (!typeFilter || card.dataset.type === typeFilter)
             && (!q || card.dataset.text.includes(q));
    card.style.display = hit ? "" : "none";
    if (hit) visible++;
  });
  // a band head shows only while its band has visible cards
  document.querySelectorAll("#grid .band-head").forEach(h => {
    const any = [...document.querySelectorAll(
      `#grid .card[data-band="${h.dataset.band}"]`)]
      .some(c => c.style.display !== "none");
    h.style.display = any ? "" : "none";
  });
  // searching reaches into the archive: unfold on a hit, refold what we unfolded
  const archBox = document.getElementById("archive");
  if (archBox && !archBox.hidden) {
    const hits = [...archBox.querySelectorAll(".card")]
      .some(c => c.style.display !== "none");
    if (q && hits && !archBox.open) { archBox.open = true; archBox.dataset.auto = "1"; }
    if (!q && archBox.dataset.auto) { archBox.open = false; delete archBox.dataset.auto; }
  }
  updateEmptyState(visible, q);
}

function clearFilters() {
  document.getElementById("search").value = "";
  typeFilter = "";
  document.querySelectorAll("#filters .chip").forEach(c =>
    c.classList.toggle("active", c.dataset.type === ""));
  refilter();
}

// empty state for fruitless filtering — built here rather than in the page
// template so it deploys without a hub.service restart (which kills drawers)
const emptyState = (() => {
  const style = document.createElement("style");
  style.textContent = `
    #empty-state { text-align:center; font-style:italic; color:var(--ink-soft);
      margin:2.6rem auto; }
    #empty-state p { margin:0 0 .8rem; }
    #empty-state button { background:transparent; border:1px solid var(--ink-soft);
      border-radius:2px; color:var(--ink); font:inherit; font-size:.85rem;
      font-variant:small-caps; letter-spacing:.06em; padding:.32rem .8rem;
      cursor:pointer; font-style:normal; }
    #empty-state button:hover { background:var(--ink); color:var(--parchment); }`;
  document.head.appendChild(style);
  const el = document.createElement("div");
  el.id = "empty-state";
  el.hidden = true;
  document.querySelector(".grid").after(el);
  return el;
})();

function updateEmptyState(visible, q) {
  emptyState.hidden = visible > 0;
  if (visible === 0) {
    const what = [q && `“${q}”`, typeFilter && `type ${typeFilter}`]
      .filter(Boolean).join(" and ");
    emptyState.innerHTML = `<p>nothing on the shelf matches ${what || "this"}.</p>`;
    const btn = document.createElement("button");
    btn.textContent = "clear search & filters";
    btn.onclick = clearFilters;
    emptyState.appendChild(btn);
  }
}

// open card dropdowns upward when there's no room below
document.querySelectorAll(".menu").forEach(m => {
  m.addEventListener("mouseenter", () => {
    const items = m.querySelector(".menu-items");
    items.classList.toggle("up",
      m.getBoundingClientRect().bottom + 175 > window.innerHeight);
  });
});

// --- notes & to-dos -----------------------------------------------------------

let notes = { todos: [], ideas: [] };

async function loadNotes() {
  // flush any pending save FIRST — this function replaces `notes` wholesale,
  // so a re-read landing inside the debounce window would drop the just-made
  // edit and then the queued timer would write the stale doc back over it.
  // Inside loadNotes on purpose: a flush left to each call site was missed at
  // two of three within one commit of being introduced (found in review).
  await flushNotes();
  notes = await (await fetch("/api/notes")).json();
  renderNotes();
  reorderCards();   // bands depend on favorites + archived from the notes doc
}

let saveTimer = null;
function putNotes() {
  saveTimer = null;
  return fetch("/api/notes", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes),
    keepalive: true,   // lets the pagehide flush below survive the tab closing
  });
}
// closing/backgrounding the tab inside the debounce window silently lost the
// pending edit; pagehide is the last reliable moment to send it (keepalive
// lets the request outlive the page). pagehide, not beforeunload: the latter
// doesn't fire on mobile and breaks bfcache.
window.addEventListener("pagehide", () => {
  if (saveTimer) { clearTimeout(saveTimer); putNotes(); }
});
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(putNotes, 400);
}
// Send a pending save NOW. Anything that re-reads the doc must call this first:
// loadNotes() replaces `notes` wholesale, so a re-read landing inside the
// debounce window would drop the just-made edit AND leave the queued PUT to
// write the re-read (edit-free) doc back over it.
async function flushNotes() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  await putNotes();
}

// --- shelf bands: ★ pinned / in motion / the rest, with an archive fold.
// Mirrors the server-side banding in app.py index() so ★ and archive toggles
// re-band without a reload; favorites + archived live in notes.json (same doc
// as the jots) so they're shared across phone + laptop.
const ACTIVE_DAYS = 30;                    // mirrored by ACTIVE_DAYS in app.py
const BAND_HEADS = {   // label + the hint that says what earns a project its band
  pinned: ["pinned", "your ★ picks"],
  motion: ["in motion", `touched in the last ${ACTIVE_DAYS} days`],
  rest: ["the rest", "quiet for a month or more"],
};

function reorderCards() {
  const grid = document.getElementById("grid");
  const archBox = document.getElementById("archive");
  if (!grid || !archBox) return;
  const favs = new Set(notes.favorites || []);
  const archived = new Set(notes.archived || []);
  const horizon = Date.now() / 1000 - ACTIVE_DAYS * 86400;
  const cards = [...document.querySelectorAll(".card")];
  cards.forEach(c => {
    c.dataset.band = archived.has(c.dataset.name) ? "archive"
      : favs.has(c.dataset.name) ? "pinned"
      : (+c.dataset.act || 0) >= horizon ? "motion" : "rest";
  });
  const rank = { pinned: 0, motion: 1, rest: 2 };
  const shelved = cards.filter(c => c.dataset.band !== "archive").sort((a, b) => {
    if (rank[a.dataset.band] !== rank[b.dataset.band])
      return rank[a.dataset.band] - rank[b.dataset.band];
    if (a.dataset.band === "motion") return (+b.dataset.act) - (+a.dataset.act);
    return a.dataset.name.localeCompare(b.dataset.name);
  });
  // rebuild the main grid: a head above each band (unless it's the only one)
  grid.querySelectorAll(".band-head").forEach(h => h.remove());
  const many = new Set(shelved.map(c => c.dataset.band)).size > 1;
  let prev = null;
  shelved.forEach(c => {
    if (many && c.dataset.band !== prev) {
      prev = c.dataset.band;
      const h = document.createElement("div");
      h.className = "band-head";
      h.dataset.band = prev;
      h.textContent = BAND_HEADS[prev][0];
      const hint = document.createElement("span");
      hint.className = "band-hint";
      hint.textContent = BAND_HEADS[prev][1];
      h.appendChild(hint);
      grid.appendChild(h);
    }
    grid.appendChild(c);
  });
  const arch = cards.filter(c => c.dataset.band === "archive")
    .sort((a, b) => a.dataset.name.localeCompare(b.dataset.name));
  arch.forEach(c => archBox.querySelector(".grid").appendChild(c));
  archBox.hidden = arch.length === 0;
  const n = document.getElementById("arch-count");
  if (n) n.textContent = arch.length;
  document.querySelectorAll(".m-arch").forEach(b =>
    b.textContent = archived.has(b.dataset.arch) ? "unarchive" : "archive");
  refilter();   // keep band heads consistent with any active search/filter
}

document.addEventListener("click", e => {
  const btn = e.target.closest(".b-fav");
  if (!btn) return;
  notes.favorites = notes.favorites || [];
  const name = btn.dataset.fav, i = notes.favorites.indexOf(name);
  if (i >= 0) { notes.favorites.splice(i, 1); btn.classList.remove("on"); }
  else { notes.favorites.push(name); btn.classList.add("on"); }
  saveNotes();
  reorderCards();
});

function toggleArchive(name) {
  notes.archived = notes.archived || [];
  const i = notes.archived.indexOf(name);
  if (i >= 0) notes.archived.splice(i, 1);
  else notes.archived.push(name);
  saveNotes();
  reorderCards();
}

// done/not-done filter for the to-do list (ideas have no done state).
// Defaults to "active" — finished items are the least interesting at a glance.
let todoFilter = "active";
// every done-flip goes through here so the completion date stays truthful:
// stamped when a to-do is finished, gone the moment it's active again
function setDone(item, done) {
  item.done = done;
  if (done) item.doneAt = Math.floor(Date.now() / 1000);
  else delete item.doneAt;
}

function matchesTodoFilter(kind, item) {
  if (kind !== "todos" || todoFilter === "all") return true;
  return todoFilter === "done" ? !!item.done : !item.done;
}
function applyTodoFilter(value) {
  todoFilter = value;
  document.querySelectorAll(".todo-filter .chip").forEach(c =>
    c.classList.toggle("active", c.dataset.val === value));
  renderNotes();
}

// free-text search across both jot lists (composes with the to-do filter)
let jotSearch = "";
function matchesJotSearch(item) {
  return !jotSearch || item.text.toLowerCase().includes(jotSearch);
}
function setJotSearch(value) {
  jotSearch = value.trim().toLowerCase();
  renderNotes();
}

// project filter (T42): jots can be tagged with a project; filter to one —
// or to the untagged ones (a sentinel no real project name can collide with)
const UNTAGGED = "\u0000untagged";
let jotProject = "";
function matchesJotProject(item) {
  if (jotProject === UNTAGGED) return !item.project;
  return !jotProject || item.project === jotProject;
}
function setJotProject(p) { jotProject = (jotProject === p ? "" : p); renderNotes(); }
// projects with items in the CURRENT view (kind + the to-do status filter) —
// the filter only offers what's actually there to filter to. Returns
// [name, count] pairs, busiest project first (count breaks ties by name).
function filterProjects() {
  const counts = {};
  notes[jotKind].filter(it => matchesTodoFilter(jotKind, it))
    .forEach(i => { if (i.project) counts[i.project] = (counts[i.project] || 0) + 1; });
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function refreshProjectFilter() {
  const btn = document.getElementById("jot-project-btn");
  if (!btn) return;
  const scoped = filterProjects();
  // drop a stale selection only when the current list has no such project at all
  if (jotProject && jotProject !== UNTAGGED
      && !notes[jotKind].some(i => i.project === jotProject)) jotProject = "";
  btn.style.display = (scoped.length || jotProject) ? "" : "none";
  btn.querySelector(".lbl").textContent =
    jotProject === UNTAGGED ? "untagged" : jotProject || "all projects";
}

// surface the inherited project in the add-input placeholder, so adding an item
// while a project filter is active visibly tags it
function updateAddHints() {
  const sfx = jotProject && jotProject !== UNTAGGED ? ` → ${jotProject}` : "";
  const ti = document.getElementById("todos-input");
  const ii = document.getElementById("ideas-input");
  if (ti) ti.placeholder = "add a task…" + sfx;
  if (ii) ii.placeholder = "jot an idea…" + sfx;
}

function renderNotes() {
  for (const kind of ["todos", "ideas"]) {
    const ul = document.getElementById(kind);
    ul.innerHTML = "";
    let shown = 0;
    // sequential reference numbers for terse communication ("do to-do 3").
    // For to-dos only active items are numbered — done ones are noise we
    // rarely point at — and the rank is over the full list, so an item keeps
    // the same number in every filter view (active and all agree).
    const refNum = new Map();
    let n = 0;
    notes[kind].forEach(it => { if (kind === "ideas" || !it.done) refNum.set(it, ++n); });
    notes[kind].forEach(item => {
      if (!matchesTodoFilter(kind, item)) return; // hidden by the to-do filter
      if (!matchesJotSearch(item)) return;        // hidden by the search box
      if (!matchesJotProject(item)) return;       // hidden by the project filter
      shown++;
      const li = document.createElement("li");
      li.__item = item; // ref used by drag-commit + the row menu (indices shift)
      if (item.done) li.classList.add("done");

      // left rail: checkbox (todos) on top, drag handle beneath — the two
      // most-used controls, always visible and easy to hit on touch
      const left = document.createElement("div");
      left.className = "row-left";
      if (kind === "todos") {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!item.done;
        box.onchange = () => {
          setDone(item, box.checked);
          renderNotes(); saveNotes();
          // stray taps while scrolling/clicking through rows kept marking
          // things done — recovery beats confirmation: one tap takes it back
          if (item.done) undoToast("marked done",
            () => { setDone(item, false); renderNotes(); saveNotes(); });
        };
        left.appendChild(box);
      }
      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.textContent = "⠿";
      handle.title = "drag to reorder";
      handle.addEventListener("pointerdown", e => startDrag(e, kind, li, item));
      left.appendChild(handle);

      const idx = document.createElement("span");
      idx.className = "idx";
      idx.textContent = refNum.has(item) ? refNum.get(item) : "";
      idx.setAttribute("aria-hidden", "true");

      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = item.text;
      txt.title = "click to edit";
      txt.onclick = () => beginEdit(item, li, txt);

      const menuBtn = document.createElement("button");
      menuBtn.className = "row-menu-btn";
      menuBtn.textContent = "⋯";
      menuBtn.title = "actions";
      menuBtn.onclick = e => openRowMenu(e, kind, item);

      // content column: project tag ON TOP (a small pill), text full-width below
      const content = document.createElement("div");
      content.className = "jot-content";
      if (item.project) {
        const tag = document.createElement("span");
        tag.className = "jot-tag";
        tag.textContent = item.project;
        tag.title = `project: ${item.project} — click to filter`;
        tag.onclick = e => { e.stopPropagation(); setJotProject(item.project); };
        content.append(tag);
      }
      content.append(txt);
      // done rows carry their completion date (older items predate the stamp)
      if (item.done && item.doneAt) {
        const d = new Date(item.doneAt * 1000);
        const when = document.createElement("span");
        when.className = "done-at";
        when.textContent = `✓ ${d.getFullYear()}-`
          + `${String(d.getMonth() + 1).padStart(2, "0")}-`
          + `${String(d.getDate()).padStart(2, "0")}`;
        content.append(when);
      }
      if (item.images && item.images.length) content.append(thumbStrip(item.images, item));
      li.append(left, idx, content, menuBtn);
      ul.appendChild(li);
    });
    if (shown === 0 && notes[kind].length) {
      const li = document.createElement("li");
      li.className = "empty-hint";
      li.textContent = jotSearch ? `nothing matches “${jotSearch}”.`
        : kind === "todos" && todoFilter === "done" ? "nothing finished yet."
        : kind === "todos" ? "all done — nothing pending." : "no ideas yet.";
      ul.appendChild(li);
    }
  }
  document.getElementById("todos-count").textContent =
    `· ${notes.todos.filter(t => !t.done).length}`;
  document.getElementById("ideas-count").textContent = `· ${notes.ideas.length}`;
  const inboxN = (notes.inbox || []).length;
  const ic = document.getElementById("inbox-count");
  if (ic) ic.textContent = inboxN ? `· ${inboxN}` : "";
  const io = document.getElementById("inbox-open");
  if (io) io.classList.toggle("has-items", inboxN > 0);
  refreshProjectFilter();
  updateAddHints();
}

// promote idea → to-do / demote to-do → idea
function convertItem(from, i) {
  const to = from === "todos" ? "ideas" : "todos";
  const [item] = notes[from].splice(i, 1);
  if (to === "todos") item.done = item.done || false;
  else { delete item.done; delete item.doneAt; } // ideas carry no done state
  notes[to].push(item);
  renderNotes();
  saveNotes();
}

// --- drag-to-reorder (pointer events → works with mouse and touch) ----------
// Only the dragged item moves; rows hidden by the filter keep their slots, so
// reordering stays correct under any to-do filter.
let drag = null;
function startDrag(e, kind, li, item) {
  e.preventDefault();
  const ul = li.parentElement;
  li.classList.add("dragging");
  const onMove = ev => dragMove(ev, ul, li);
  const onUp = () => {
    li.classList.remove("dragging");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    commitDrag(kind, item, ul);
    drag = null;
  };
  drag = { kind, li, item, ul };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
function dragMove(e, ul, li) {
  const after = [...ul.querySelectorAll("li:not(.dragging):not(.empty-hint)")]
    .find(s => { const r = s.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
  if (after) ul.insertBefore(li, after);
  else ul.appendChild(li);
  const r = ul.getBoundingClientRect(); // autoscroll near the edges
  if (e.clientY < r.top + 24) ul.scrollTop -= 8;
  else if (e.clientY > r.bottom - 24) ul.scrollTop += 8;
}
function commitDrag(kind, item, ul) {
  const arr = notes[kind];
  const vis = [...ul.querySelectorAll("li:not(.empty-hint)")].map(x => x.__item);
  const pos = vis.indexOf(item);
  arr.splice(arr.indexOf(item), 1); // pull it out, then reinsert by neighbour
  const afterObj = vis[pos + 1];
  if (afterObj) arr.splice(arr.indexOf(afterObj), 0, item);
  else {
    const prevObj = vis[pos - 1];
    if (prevObj) arr.splice(arr.indexOf(prevObj) + 1, 0, item);
    else arr.push(item);
  }
  renderNotes();
  saveNotes();
}

// --- per-row action menu (⋯) -------------------------------------------------
// Floating, body-anchored so the scrolling list's overflow can't clip it.
let rowMenuEl = null;
function closeRowMenu() { if (rowMenuEl) { rowMenuEl.remove(); rowMenuEl = null; } }
// every project the hub knows (from the rendered cards) plus any already used
// as a tag — the choices for the "set project" picker
function projectList() {
  const fromCards = [...document.querySelectorAll(".card[data-name]")].map(c => c.dataset.name);
  const fromTags = [...notes.todos, ...notes.ideas].map(i => i.project).filter(Boolean);
  return [...new Set([...fromCards, ...fromTags])].sort();
}

function placeMenu(menu, r) {
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
}

// a searchable dropdown reusing the row-menu look — used by both the
// set-project picker and the project filter. options: [{label, value, pinned?}]
function openSearchablePicker(anchorRect, options, current, onPick) {
  closeRowMenu();
  const menu = document.createElement("div");
  menu.className = "row-menu";
  menu.addEventListener("mousedown", e => e.stopPropagation()); // don't self-close
  const sb = document.createElement("input");
  sb.className = "row-menu-search";
  sb.placeholder = "filter…";
  sb.autocomplete = "off";
  menu.appendChild(sb);
  options.forEach(o => {
    const b = document.createElement("button");
    b.textContent = o.label;
    if (o.pinned) b.dataset.pinned = "1";
    if (o.value === current) b.style.fontWeight = "700";
    b.onclick = ev => { ev.stopPropagation(); closeRowMenu(); onPick(o.value); };
    menu.appendChild(b);
  });
  sb.oninput = () => {
    const q = sb.value.toLowerCase();
    menu.querySelectorAll("button").forEach(b => {
      b.style.display = (b.dataset.pinned || b.textContent.toLowerCase().includes(q)) ? "" : "none";
    });
  };
  document.body.appendChild(menu);
  rowMenuEl = menu;
  placeMenu(menu, anchorRect);
  if (!matchMedia("(pointer: coarse)").matches) sb.focus(); // desktop: ready to type
}

// set/clear the project on a single jot item (offers every hub project)
function openProjectPicker(item, r) {
  const opts = [{ label: "— none —", value: null, pinned: true },
                ...projectList().map(p => ({ label: p, value: p }))];
  openSearchablePicker(r, opts, item.project || null, val => {
    if (val === null) delete item.project; else item.project = val;
    renderNotes(); saveNotes();
  });
}

function openRowMenu(e, kind, item) {
  e.stopPropagation();
  closeRowMenu();
  const r = e.currentTarget.getBoundingClientRect();
  const menu = document.createElement("div");
  menu.className = "row-menu";
  const idx = () => notes[kind].indexOf(item); // recompute — indices shift
  const add = (label, fn, danger) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (danger) b.className = "danger";
    b.onclick = ev => { ev.stopPropagation(); closeRowMenu(); fn(); };
    menu.appendChild(b);
  };
  if (kind === "todos") {
    add(item.done ? "mark active" : "mark done",
        () => { setDone(item, !item.done); renderNotes(); saveNotes(); });
    add("→ make idea", () => convertItem("todos", idx()));
  } else {
    add("→ make to-do", () => convertItem("ideas", idx()));
  }
  add(item.project ? `project: ${item.project} ▸` : "set project ▸",
      () => openProjectPicker(item, r));
  add("→ claude ▸", () => openChatSendPicker(kind, item, r));
  add(item.images && item.images.length ? "attach more images" : "attach image",
      () => attachToItem(item));
  add("remove", () => askDelete(kind, idx()), true);
  document.body.appendChild(menu);
  rowMenuEl = menu;
  placeMenu(menu, r);
}
document.addEventListener("click", closeRowMenu);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeRowMenu(); });

// --- send a jot into a claude chat (idea: notes as conversation starters) ---
// The note is PASTED into the chat's input — never auto-submitted — so it can
// be edited or prefaced before sending. Targets: a fresh chat for the note's
// project (untagged notes go to the root "~" session over all of ~/Projects),
// or any chat already alive in the drawer.
function jotChatText(kind, item) {
  const what = kind === "todos" ? "to-do" : "idea";
  let msg = `From my hub ${what} list`
    + (item.project ? ` (project: ${item.project})` : "") + `: ${item.text}`;
  if (item.images && item.images.length) {
    // attachments live on disk under the hub — hand claude real paths
    const paths = item.images.map(id => `~/Projects/humble-hub/data/attachments/${id}`);
    msg += `\nAttached image${paths.length > 1 ? "s" : ""}: ${paths.join(" ")}`;
  }
  return msg;
}

function injectIntoSession(s, text) {
  // bracketed paste: claude code treats the block as one paste, and a
  // multi-line note can't submit itself line by line
  const payload = `\x1b[200~${text}\x1b[201~`;
  const send = () => {
    if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "input", data: payload }));
  };
  if (s.sawOutput) { send(); return; }
  // a fresh chat: wait for claude to boot (first pty output), then a settle
  // beat so the paste lands in its input box, not the void before it
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (s.ws.readyState > 1 || Date.now() - t0 > 20000) { clearInterval(timer); return; }
    if (s.sawOutput) { clearInterval(timer); setTimeout(send, 900); }
  }, 250);
}

function openChatSendPicker(kind, item, r) {
  const live = [...sessions.values()].filter(s => s.ws.readyState <= 1);
  const opts = [
    { label: `new chat → ${item.project || "~"}`, value: "", pinned: true },
    ...live.map(s => ({ label: `→ ${s.label}`, value: s.key })),
  ];
  openSearchablePicker(r, opts, null, val => {
    const text = jotChatText(kind, item);
    let s;
    if (val) { s = sessions.get(val); if (s) activate(val); }
    else { const project = item.project || "~"; openDrawer(project); s = sessions.get(project); }
    if (!s) return;
    injectIntoSession(s, text);
    closeJot();   // the drawer needs the room; the note is already on its way
    hubToast("note pasted into the chat — press enter there to send");
  });
}

// --- jot modal ---

async function openJot(kind) {
  // re-fetch before showing — another writer (e.g. a Claude session editing
  // via the API) may have changed the file; a stale tab's save would clobber it
  await loadNotes();
  jotSearch = "";
  const js = document.getElementById("jot-search");
  if (js) js.value = "";
  applyTodoFilter("active"); // always open the to-do list on the active view
  document.getElementById("overlay").hidden = false;
  document.getElementById("m-title").textContent = kind === "todos" ? "to-do" : "ideas";
  document.getElementById("col-todos").style.display = kind === "todos" ? "" : "none";
  document.getElementById("col-ideas").style.display = kind === "ideas" ? "" : "none";
  document.getElementById("col-inbox").style.display = "none";
  const tf = document.getElementById("todo-filter"); // all/active/done is to-do-only
  if (tf) tf.style.display = kind === "todos" ? "flex" : "none";
  jotKind = kind;
  const sw = document.getElementById("jot-switch");
  if (sw) { sw.style.display = ""; sw.textContent = kind === "todos" ? "→ ideas" : "→ to-do"; }
  cancelDelete();
  // on phones, auto-focusing the add-input pops the soft keyboard and shoves
  // the list off-screen before you can read it — only autofocus on desktop
  if (!matchMedia("(pointer: coarse)").matches)
    document.getElementById(`${kind}-input`).focus();
}

// one-click jump to the other list (to-do ⇄ ideas) from the modal header
let jotKind = "todos";
function switchJot() { openJot(jotKind === "todos" ? "ideas" : "todos"); }

function closeJot() {
  closeRowMenu();
  document.getElementById("overlay").hidden = true;
}

function beginEdit(item, li, txt) {
  const input = document.createElement("textarea");
  input.className = "edit-input";
  input.autocomplete = "off";
  input.value = item.text;
  input.rows = 1;
  // grow with content up to the CSS max-height, then scroll internally
  const grow = () => {
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight + 2}px`;
  };
  input.oninput = grow;
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    const text = input.value.trim();
    if (text) item.text = text;
    renderNotes();
    saveNotes();
  };
  input.onkeydown = e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { done = true; renderNotes(); }
  };
  input.onblur = commit;
  // T42 wraps .txt inside a .jot-content div, so swap within txt's real parent,
  // not li (li.replaceChild threw NotFoundError → clicking a row did nothing).
  txt.parentNode.replaceChild(input, txt);
  grow();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// close only when both press AND release happen on the backdrop — a drag
// that starts inside the modal and ends outside must not close it
let overlayPress = false;
const overlayEl = document.getElementById("overlay");
overlayEl.addEventListener("mousedown", e => { overlayPress = e.target === overlayEl; });
overlayEl.addEventListener("mouseup", e => {
  if (overlayPress && e.target === overlayEl) closeJot();
  overlayPress = false;
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !document.getElementById("overlay").hidden) closeJot();
});

// --- delete confirmation ---

let pendingDelete = null;

function askDelete(kind, i) {
  pendingDelete = { kind, i };
  const text = notes[kind][i].text;
  document.getElementById("confirm-text").textContent =
    `remove “${text.length > 90 ? text.slice(0, 90) + "…" : text}”?`;
  document.getElementById("confirm").hidden = false;
}

function doDelete() {
  if (pendingDelete) {
    notes[pendingDelete.kind].splice(pendingDelete.i, 1);
    renderNotes();
    saveNotes();
  }
  cancelDelete();
}

function cancelDelete() {
  pendingDelete = null;
  document.getElementById("confirm").hidden = true;
}

function addItem(ev, kind) {
  ev.preventDefault();
  const input = document.getElementById(`${kind}-input`);
  const text = input.value.trim();
  const imgs = pendingAttach[kind];
  // unified attach: text + image(s) → a filed note; image(s) alone → the inbox
  // (capture now, write the note later). Bare submit with nothing does nothing.
  if (!text && imgs.length) { imgsToInbox(imgs); clearAttach(kind); return false; }
  if (text) {
    const item = kind === "todos" ? { text, done: false } : { text };
    // adding while filtered tags it (the untagged view files, well, untagged)
    if (jotProject && jotProject !== UNTAGGED) item.project = jotProject;
    if (imgs.length) { item.images = imgs.slice(); clearAttach(kind); }
    notes[kind].push(item);
    input.value = "";
    renderNotes();
    saveNotes();
    // bring the new row into view with a brief highlight so it's clear it landed
    const li = [...document.getElementById(kind).children].find(el => el.__item === item);
    if (li) {
      li.scrollIntoView({ block: "nearest", behavior: "smooth" });
      li.classList.add("just-added");
      setTimeout(() => li.classList.remove("just-added"), 1200);
    }
  }
  return false;
}

// --- image attachments & the drop-inbox -------------------------------------
// One uploader feeds two flows (the unified attach button, see addItem): pick
// image(s) on a jot → they ride along when you file the note; pick with no text
// → they fall into the inbox to triage later. /api/upload normalises each image
// server-side (downscaled JPEG, EXIF/GPS stripped) and returns its id.
let pendingAttach = { todos: [], ideas: [] };

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return [];
  const fd = new FormData();
  for (const f of files) fd.append("files", f);
  let res;
  try { res = await fetch("/api/upload", { method: "POST", body: fd }); }
  catch { alert("upload failed — no connection?"); return []; }
  if (!res.ok) { alert("upload failed — image not readable?"); return []; }
  return (await res.json()).images.map(im => im.id);
}

async function pickAttach(ev, kind) {
  const inp = ev.target;
  const ids = await uploadFiles(inp.files);
  inp.value = "";                       // let the same file be re-picked later
  pendingAttach[kind].push(...ids);
  renderAttachStrip(kind);
}

function clearAttach(kind) { pendingAttach[kind] = []; renderAttachStrip(kind); }

function renderAttachStrip(kind) {
  const strip = document.getElementById(`${kind}-attach`);
  if (!strip) return;
  strip.innerHTML = "";
  pendingAttach[kind].forEach((id, i) => {
    const wrap = document.createElement("span");
    wrap.className = "attach-thumb";
    const img = document.createElement("img");
    img.src = `/attachments/${id}`;
    const x = document.createElement("button");
    x.type = "button"; x.className = "attach-x"; x.textContent = "✕"; x.title = "remove";
    x.onclick = () => { pendingAttach[kind].splice(i, 1); renderAttachStrip(kind); };
    wrap.append(img, x);
    strip.appendChild(wrap);
  });
  strip.classList.toggle("has", pendingAttach[kind].length > 0);
}

// thumbnails on a filed note; click a thumb → lightbox, corner ✕ → detach.
// `owner` (the jot item) is passed when the strip is editable; omit for read-only.
function thumbStrip(ids, owner) {
  const strip = document.createElement("div");
  strip.className = "jot-thumbs";
  ids.forEach(id => {
    const wrap = document.createElement("span");
    wrap.className = "jot-thumb";
    const img = document.createElement("img");
    img.src = `/attachments/${id}`; img.loading = "lazy";
    img.onclick = () => openLightbox(id);
    wrap.appendChild(img);
    if (owner) {
      const x = document.createElement("button");
      x.type = "button"; x.className = "thumb-x"; x.textContent = "✕"; x.title = "remove image";
      x.onclick = e => { e.stopPropagation(); detachImage(owner, id); };
      wrap.appendChild(x);
    }
    strip.appendChild(wrap);
  });
  return strip;
}

// detach an image from a jot (the file itself stays on disk — harmless)
function detachImage(item, id) {
  if (!item.images) return;
  const i = item.images.indexOf(id);
  if (i >= 0) item.images.splice(i, 1);
  if (!item.images.length) delete item.images;
  renderNotes();
  saveNotes();
}

// add image(s) to an EXISTING jot (from the row ⋯ menu). A throwaway file input
// is briefly mounted — some mobile browsers ignore .click() on a detached input.
async function attachToItem(item) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.hidden = true;
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const ids = await uploadFiles(inp.files);
    inp.remove();
    if (ids.length) {
      item.images = (item.images || []).concat(ids);
      renderNotes();
      saveNotes();
    }
  };
  inp.click();
}

// full-image lightbox — replaces opening attachments in a new tab. One overlay,
// built lazily, reused for every image (note thumbs + inbox cards). On phones
// this is better than a new tab: full-screen, pinch-zoom, dismiss without
// leaving the hub. Backdrop tap / ✕ / Esc all close it.
function openLightbox(id) {
  let lb = document.getElementById("lightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "lightbox"; lb.hidden = true;
    const x = document.createElement("button");
    x.className = "lb-x"; x.type = "button"; x.textContent = "✕"; x.title = "close";
    const img = document.createElement("img"); img.alt = "";
    lb.append(x, img);
    lb.addEventListener("click", e => { if (e.target === lb || e.target === x) closeLightbox(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeLightbox(); });
    document.body.appendChild(lb);
  }
  lb.querySelector("img").src = `/attachments/${id}`;
  lb.hidden = false;
}

function closeLightbox() {
  const lb = document.getElementById("lightbox");
  if (lb) { lb.hidden = true; lb.querySelector("img").src = ""; }
}

// images picked/dropped TOGETHER form ONE inbox item — they usually belong to
// the same thing (several photos of one object); drop separately to split them
function imgsToInbox(ids) {
  notes.inbox = notes.inbox || [];
  if (ids.length) notes.inbox.push({ imgs: ids.slice() });
  renderNotes();
  if (document.getElementById("col-inbox").style.display !== "none") renderInbox();
  saveNotesNow();
}

// older inbox items carry a single `img`; everything reads through this
function inboxImgs(item) {
  return item.imgs || (item.img ? [item.img] : []);
}

async function dropToInbox(ev) {
  const inp = ev.target;
  const ids = await uploadFiles(inp.files);
  inp.value = "";
  if (ids.length) imgsToInbox(ids);
}

function openInbox() {
  loadNotes().then(() => {
    document.getElementById("overlay").hidden = false;
    document.getElementById("m-title").textContent = "inbox";
    document.getElementById("col-todos").style.display = "none";
    document.getElementById("col-ideas").style.display = "none";
    document.getElementById("col-inbox").style.display = "";
    const tf = document.getElementById("todo-filter");
    if (tf) tf.style.display = "none";
    const sw = document.getElementById("jot-switch");
    if (sw) sw.style.display = "none";   // no to-do⇄ideas toggle from the inbox
    cancelDelete();
    renderInbox();
  });
}

function renderInbox() {
  const ul = document.getElementById("inbox-list");
  ul.innerHTML = "";
  const items = notes.inbox || [];
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty-hint";
    li.textContent = "inbox empty — drop an image to capture it.";
    ul.appendChild(li);
    return;
  }
  items.forEach((item, i) => {
    const li = document.createElement("li");
    li.className = "inbox-row";
    const a = document.createElement("span");
    a.className = "inbox-thumb";
    inboxImgs(item).forEach(id => {
      const wrap = document.createElement("span");
      wrap.className = "jot-thumb";
      const img = document.createElement("img");
      img.src = `/attachments/${id}`; img.loading = "lazy";
      img.onclick = () => openLightbox(id);
      wrap.appendChild(img);
      if (inboxImgs(item).length > 1) {   // lone image: the row ✕ covers it
        const x = document.createElement("button");
        x.type = "button"; x.className = "thumb-x"; x.textContent = "✕";
        x.title = "remove this image";
        x.onclick = e => {
          e.stopPropagation();
          item.imgs = inboxImgs(item).filter(v => v !== id);
          delete item.img;
          renderInbox(); saveNotesNow();
        };
        wrap.appendChild(x);
      }
      a.appendChild(wrap);
    });

    const body = document.createElement("div");
    body.className = "inbox-body";
    const cap = document.createElement("input");
    cap.className = "inbox-cap";
    cap.placeholder = "describe it (optional)…";
    cap.value = item.caption || "";
    cap.oninput = () => { item.caption = cap.value; saveNotes(); };

    const row = document.createElement("div");
    row.className = "inbox-actions";
    const del = mkInboxBtn("✕", () => removeInbox(i)); del.classList.add("danger");
    row.append(mkInboxBtn("→ to-do", () => promoteInbox(i, "todos")),
               mkInboxBtn("→ idea", () => promoteInbox(i, "ideas")),
               mkInboxBtn("+ image", () => addToInboxItem(item)), del);
    body.append(cap, row);
    li.append(a, body);
    ul.appendChild(li);
  });
}

function mkInboxBtn(label, fn) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; b.onclick = fn;
  return b;
}

// grow an inbox item: more shots of the same thing join the existing card
function addToInboxItem(item) {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "image/*"; inp.multiple = true; inp.hidden = true;
  document.body.appendChild(inp);
  inp.onchange = async () => {
    const ids = await uploadFiles(inp.files);
    inp.remove();
    if (ids.length) {
      item.imgs = inboxImgs(item).concat(ids);
      delete item.img;
      renderInbox(); renderNotes(); saveNotesNow();
    }
  };
  inp.click();
}

// triage: turn an inbox item into a filed to-do/idea (caption becomes the
// text, every image rides along)
function promoteInbox(i, kind) {
  const item = (notes.inbox || [])[i];
  if (!item) return;
  const text = (item.caption || "").trim() || "image note";
  const note = kind === "todos" ? { text, done: false } : { text };
  note.images = inboxImgs(item);
  notes[kind].push(note);
  notes.inbox.splice(i, 1);
  renderInbox();
  renderNotes();
  saveNotesNow();
}

function removeInbox(i) {
  if (!notes.inbox) return;
  notes.inbox.splice(i, 1);   // the image file itself stays on disk (harmless)
  renderInbox();
  renderNotes();
  saveNotesNow();
}

// a toast with a way back — shown after actions worth a second thought
// (marking a to-do done). One at a time; the newest replaces the last.
function undoToast(msg, fn) {
  document.getElementById("undo-toast")?.remove();
  const el = document.createElement("div");
  el.id = "undo-toast";
  const txt = document.createElement("span");
  txt.textContent = msg;
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = "undo";
  b.onclick = () => { el.remove(); fn(); };
  el.append(txt, b);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

// immediate (non-debounced) save — inbox writes use this so a phone capture
// survives the tab being closed right after the drop
function saveNotesNow() {
  clearTimeout(saveTimer);
  fetch("/api/notes", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes),
  });
}

// styles for attachments + the inbox — injected here (not the page template) so
// they ship on a browser refresh, matching the rest of the jot UI
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .jot-add { display:flex; align-items:center; gap:.45rem; }
    .jot-add input { flex:1; min-width:0; }
    /* hand-inked checkbox — a deliberate little box, not the browser widget */
    .jot-col li input[type="checkbox"] { appearance:none; -webkit-appearance:none;
      width:1.15rem; height:1.15rem; margin:0; flex:none; cursor:pointer;
      position:relative; border:1.5px solid var(--ink-soft); border-radius:2px;
      background:var(--input-bg); }
    .jot-col li input[type="checkbox"]:hover { border-color:var(--ink); }
    .jot-col li input[type="checkbox"]:checked { border-color:var(--verdigris, #4f6b3a); }
    .jot-col li input[type="checkbox"]:checked::after { content:"✓"; position:absolute;
      inset:0; display:flex; align-items:center; justify-content:center;
      color:var(--verdigris, #4f6b3a); font-size:.95rem; font-weight:700; line-height:1; }
    .jot-col li .row-left { gap:.35rem; }
    #undo-toast { position:fixed; bottom:1.4rem; left:50%; transform:translateX(-50%);
      z-index:300; display:flex; align-items:center; gap:.7rem;
      background:var(--paper, #f6edd6); color:var(--ink); border:1.5px solid var(--ink-soft);
      outline:1px solid var(--ink-faint); outline-offset:3px; border-radius:2px;
      padding:.45rem .85rem; font-size:.88rem; box-shadow:2px 3px 12px rgba(40,30,15,.4); }
    #undo-toast button { border:1px solid var(--ink-soft); border-radius:2px;
      background:transparent; color:var(--ink); font:inherit; font-size:.8rem;
      font-variant:small-caps; letter-spacing:.05em; padding:.18rem .6rem; cursor:pointer; }
    #undo-toast button:hover { background:var(--ink); color:var(--parchment); }
    .attach-btn { cursor:pointer; font-size:1.25rem; line-height:1; padding:.15rem .3rem;
      opacity:.55; user-select:none; flex:none; display:inline-flex; align-items:center; }
    .attach-btn:hover { opacity:1; }
    .inbox-add svg.i { width:1.2em; height:1.2em; }
    .attach-strip { display:none; flex-wrap:wrap; gap:.4rem; margin:.4rem 0 .1rem; }
    .attach-strip.has { display:flex; }
    .attach-thumb { position:relative; line-height:0; }
    .attach-thumb img { width:46px; height:46px; object-fit:cover; border-radius:3px;
      border:1px solid var(--ink-faint); }
    .attach-x { position:absolute; top:-7px; right:-7px; width:17px; height:17px;
      border-radius:50%; border:0; background:var(--ink); color:var(--parchment);
      font-size:.62rem; line-height:1; cursor:pointer; padding:0;
      display:flex; align-items:center; justify-content:center; }
    .jot-thumbs { display:flex; flex-wrap:wrap; gap:.4rem; margin-top:.35rem; }
    .jot-thumb { position:relative; display:inline-block; line-height:0; }
    .jot-thumbs img { width:54px; height:54px; object-fit:cover; border-radius:3px;
      border:1px solid var(--ink-faint); cursor:zoom-in; }
    .thumb-x { position:absolute; top:-7px; right:-7px; width:17px; height:17px;
      border-radius:50%; border:0; background:var(--ink); color:var(--parchment);
      font-size:.62rem; line-height:1; cursor:pointer; padding:0; opacity:0;
      transition:opacity .12s; display:flex; align-items:center; justify-content:center; }
    .jot-thumb:hover .thumb-x { opacity:1; }
    @media (pointer:coarse) { .thumb-x { opacity:1; } }  /* no hover on touch */
    .inbox-thumb img { cursor:zoom-in; }
    #lightbox { position:fixed; inset:0; z-index:200; background:rgba(20,14,4,.86);
      display:flex; align-items:center; justify-content:center; padding:2.5vmin; }
    #lightbox[hidden] { display:none; }
    #lightbox img { max-width:96vw; max-height:92vh; object-fit:contain; border-radius:4px;
      box-shadow:0 6px 30px rgba(0,0,0,.5); }
    .lb-x { position:fixed; top:1rem; right:1.1rem; width:2.3rem; height:2.3rem;
      border-radius:50%; border:0; background:rgba(0,0,0,.55); color:#fff;
      font-size:1.05rem; line-height:1; cursor:pointer; }
    /* :not(:hover) keeps this ID rule from outweighing every theme's
       .jot-open:hover text colour (ink-on-ink hover was the symptom) */
    #inbox-open.has-items:not(:hover) { color:var(--ink); }
    #inbox-open.has-items { font-weight:600; }
    #inbox-open .has-items, #inbox-count { font-variant-numeric:tabular-nums; }
    .inbox-add { display:inline-flex; align-items:center; gap:.4rem; cursor:pointer;
      margin-top:.6rem; align-self:flex-start; border:1px solid var(--ink-soft);
      border-radius:2px; color:var(--ink); font-size:.85rem; font-variant:small-caps;
      letter-spacing:.05em; padding:.4rem .85rem; }
    .inbox-add:hover { background:var(--ink); color:var(--parchment); }
    #col-inbox ul { list-style:none; margin:0; padding:0; }
    .inbox-row { display:flex; gap:.7rem; align-items:flex-start; padding:.6rem 0;
      border-bottom:1px solid var(--ink-faint); }
    /* an inbox item may hold several images — a wrapping column of thumbs */
    .inbox-thumb { line-height:0; flex:none; display:flex; flex-direction:column;
      gap:.4rem; max-width:84px; }
    .inbox-thumb img { width:84px; height:84px; object-fit:cover; border-radius:4px;
      border:1px solid var(--ink-faint); cursor:zoom-in; }
    .inbox-body { flex:1; min-width:0; display:flex; flex-direction:column; gap:.45rem; }
    .inbox-cap { width:100%; box-sizing:border-box; background:transparent;
      border:0; border-bottom:1px solid var(--ink-soft); color:var(--ink);
      font:inherit; font-size:.9rem; padding:.1rem; outline:none; }
    .inbox-actions { display:flex; gap:.4rem; flex-wrap:wrap; }
    .inbox-actions button { border:1px solid var(--ink-soft); border-radius:2px;
      background:transparent; color:var(--ink); font:inherit; font-size:.78rem;
      font-variant:small-caps; letter-spacing:.04em; padding:.22rem .6rem; cursor:pointer; }
    .inbox-actions button:hover { background:var(--ink); color:var(--parchment); }
    .inbox-actions button.danger { border-color:var(--sanguine, #9a3b22);
      color:var(--sanguine, #9a3b22); margin-left:auto; }
    .inbox-actions button.danger:hover { background:var(--sanguine, #9a3b22);
      color:var(--parchment); }`;
  document.head.appendChild(style);
})();

// to-do filter bar (all/active/done) + per-row tool styling — injected from JS
// (not the page template) so it ships without a hub.service restart, which would
// kill live drawer sessions. Same rationale as the empty-state block above.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    /* search + status toggles share one row to save vertical space */
    .jot-controls { display:flex; align-items:center; gap:.55rem; margin:.45rem 0 .15rem; }
    .todo-filter { display:flex; gap:.4rem; flex:none; }
    /* row layout: left rail (checkbox + drag handle) | text | ⋯ menu */
    #col-todos li, #col-ideas li { align-items:flex-start; gap:.5rem; }
    .jot-col li .row-left { display:flex; flex-direction:column; align-items:center;
      gap:.2rem; padding-top:.05rem; }
    .jot-col li .idx { flex:none; min-width:1.5rem; text-align:right;
      color:var(--ink-faint); font-size:.8rem; font-variant-numeric:tabular-nums;
      user-select:none; padding-top:.06rem; }
    .jot-col li .drag-handle { cursor:grab; color:var(--ink-faint); font-size:.9rem;
      line-height:1; touch-action:none; user-select:none; }
    .jot-col li .drag-handle:hover { color:var(--ink-soft); }
    .jot-col li.dragging { opacity:.65; background:var(--card-hot);
      box-shadow:1px 2px 9px rgba(67,51,28,.3); }
    @keyframes jot-flash { from { background:var(--card-hot); } to { background:transparent; } }
    .jot-col li.just-added { animation: jot-flash 1.2s ease; }
    .jot-col li .row-menu-btn { border:0; background:transparent; color:var(--ink-faint);
      cursor:pointer; font:inherit; font-size:1.05rem; line-height:1; padding:0 .25rem;
      align-self:center; }
    .jot-col li .row-menu-btn:hover { color:var(--ink); background:transparent; }
    .row-menu { position:fixed; z-index:100; background:var(--paper, #f6edd6);
      border:1px solid var(--ink-soft); box-shadow:2px 3px 11px rgba(67,51,28,.35);
      border-radius:2px; display:flex; flex-direction:column; min-width:9.5rem;
      max-height:60vh; overflow:auto; }
    .row-menu button { border:0; border-radius:0; background:transparent; text-align:left;
      color:var(--ink); font:inherit; font-size:.82rem; font-variant:small-caps;
      letter-spacing:.04em; padding:.42rem .75rem; cursor:pointer; }
    .row-menu button:hover { background:var(--ink); color:var(--parchment); }
    .row-menu button.danger { color:var(--sanguine, #9a3b22); }
    .row-menu button.danger:hover { background:var(--sanguine, #9a3b22); color:var(--parchment); }
    .jot-col li.empty-hint { justify-content:center; font-style:italic;
      color:var(--ink-faint); border-bottom:0; }
    /* T42: project tag sits ON TOP of the row; the text spans full width below */
    .jot-col li .jot-content { flex:1; min-width:0; display:flex; flex-direction:column; gap:.12rem; }
    .jot-col li .jot-content .txt { flex:none; }
    /* idea #19: editing keeps the row's full multi-line height. flex:1 here made
       flex-basis:0 win over the JS-set height in this column flex → one line. */
    .jot-col li .jot-content .edit-input { flex:none; width:100%; box-sizing:border-box;
      background:transparent; border:0; border-bottom:1px solid var(--ink-soft);
      color:var(--ink); font:inherit; font-size:.92rem; padding:0 .1rem; outline:none;
      resize:none; line-height:1.45; max-height:9.8rem; overflow-y:auto; }
    .jot-col li .jot-tag { align-self:flex-start; white-space:nowrap; cursor:pointer;
      font-size:.62rem; font-variant:small-caps; letter-spacing:.04em; color:var(--ink-soft);
      border:1px solid var(--ink-faint); border-radius:999px; padding:.02rem .45rem; }
    .jot-col li .jot-tag:hover { border-color:var(--ink-soft); color:var(--ink); }
    .jot-col li .done-at { font-size:.68rem; font-style:italic; color:var(--ink-faint);
      font-variant-numeric:tabular-nums; }
    /* searchable set-project picker */
    .row-menu-search { position:sticky; top:0; margin:.25rem; padding:.3rem .5rem; font:inherit;
      font-size:.8rem; border:1px solid var(--ink-faint); border-radius:2px;
      background:var(--input-bg); color:var(--ink); outline:none; }`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "todo-filter";
  bar.id = "todo-filter"; // toggled per list (to-do only) by openJot
  ["all", "active", "done"].forEach(val => {
    const b = document.createElement("button");
    b.className = "chip" + (val === todoFilter ? " active" : "");
    b.dataset.val = val;
    b.textContent = val;
    b.onclick = () => applyTodoFilter(val);
    bar.appendChild(b);
  });

  // header switch button — flips the jot modal to the other list in one click
  const switchBtn = document.createElement("button");
  switchBtn.className = "jot-open";
  switchBtn.id = "jot-switch";
  switchBtn.style.marginRight = ".5rem";
  switchBtn.onclick = () => switchJot();
  const mhead = document.querySelector("#modal .m-head");
  mhead.insertBefore(switchBtn, mhead.querySelector(".del"));

  // search box — filters whichever list is shown, composes with the to-do filter
  const search = document.createElement("input");
  search.type = "search";
  search.id = "jot-search";
  search.autocomplete = "off";
  search.placeholder = "search…";
  search.oninput = () => setJotSearch(search.value);
  const sStyle = document.createElement("style");
  sStyle.textContent = `
    #jot-search { flex:1; min-width:0; box-sizing:border-box; margin:0;
      background:var(--input-bg); border:1px solid var(--ink-faint);
      border-radius:2px; color:var(--ink); font:inherit; font-size:.88rem;
      padding:.3rem .6rem; outline:none; }
    #jot-search:focus { border-color:var(--ink-soft); }
    #jot-search::placeholder { color:var(--ink-faint); font-style:italic; }
    #jot-project-btn { display:inline-flex; align-items:center; gap:.3rem; flex:none;
      background:var(--input-bg); border:1px solid var(--ink-faint); border-radius:2px;
      color:var(--ink); font:inherit; font-size:.82rem; font-variant:normal; letter-spacing:normal;
      padding:.3rem .55rem; cursor:pointer; }
    #jot-project-btn::after { content:"▾"; color:var(--ink-soft); font-size:.7rem; }
    #jot-project-btn:hover { background:var(--card-hot); color:var(--ink); border-color:var(--ink-soft); }
    #jot-project-btn .lbl { max-width:8rem; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }`;
  document.head.appendChild(sStyle);
  // project-filter button — a custom searchable dropdown (same look as the
  // set-project picker), shown by refreshProjectFilter when jots are tagged
  const projBtn = document.createElement("button");
  projBtn.id = "jot-project-btn";
  projBtn.title = "filter by project";
  projBtn.style.display = "none";
  projBtn.innerHTML = '<span class="lbl">all projects</span>';
  projBtn.onclick = e => {
    e.stopPropagation();
    const untagged = notes[jotKind]
      .filter(it => matchesTodoFilter(jotKind, it) && !it.project).length;
    const opts = [{ label: "all projects", value: "", pinned: true },
                  ...(untagged ? [{ label: `untagged · ${untagged}`, value: UNTAGGED,
                                    pinned: true }] : []),
                  ...filterProjects().map(([p, n]) => ({ label: `${p} · ${n}`, value: p }))];
    openSearchablePicker(projBtn.getBoundingClientRect(), opts, jotProject,
      val => { jotProject = val; renderNotes(); });
  };
  // one controls row: search (flex) + project filter + to-do status toggles
  const controls = document.createElement("div");
  controls.className = "jot-controls";
  controls.append(search, projBtn, bar);
  mhead.after(controls);
})();

loadNotes();

// --- multi-session drawer ----------------------------------------------------
// One live pty session per project; the drawer shows one at a time, the rest
// stay alive behind status pills. Statuses: working (output flowing),
// ready (quiet after activity), attention (terminal bell).

// permission-mode preset for new chats (server whitelists; unknown → default)
let chatMode = localStorage.getItem("chatMode") || "default";
function setChatMode(mode) {
  chatMode = mode;
  localStorage.setItem("chatMode", mode);
}
// model for new chats — "default" sends no --model, so the chat inherits
// ~/.claude/settings.json rather than the hub second-guessing it
let chatModel = localStorage.getItem("chatModel") || "default";
function setChatModel(model) {
  chatModel = model;
  localStorage.setItem("chatModel", model);
}
// one "new chat" picker holds both settings — they answer the same question
// (how does the next chat start) and the control row has no space for two.
// It's a styled .menu dropdown because a native <select>'s open list can't be
// themed; the label mirrors the stored pair, the current entries bold.
function syncModeMenu() {
  const l = document.getElementById("mode-label");
  if (l) l.textContent = chatMode.replace("-", " ");
  const m = document.getElementById("model-label");
  if (m) m.textContent = chatModel;
  document.querySelectorAll(".menu-items [data-mode]")
    .forEach(b => b.style.fontWeight = b.dataset.mode === chatMode ? "700" : "");
  document.querySelectorAll(".menu-items [data-model]")
    .forEach(b => b.style.fontWeight = b.dataset.model === chatModel ? "700" : "");
}
function setMode(mode) { setChatMode(mode); syncModeMenu(); }
function setModel(model) { setChatModel(model); syncModeMenu(); }
syncModeMenu();

const CHAT_ICON = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9'
  + 'L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5'
  + 'a8.48 8.48 0 0 1 8 8v.5z"/></svg>';

// line-art icons for JS-rendered controls (mirror the app.py ICONS set)
const svgIcon = inner => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICON_EXPAND = svgIcon('<path d="M14 4h6v6"/><path d="M20 4l-7 7"/><path d="M10 20H4v-6"/><path d="M4 20l7-7"/>');
const ICON_COLLAPSE = svgIcon('<path d="M20 9h-5V4"/><path d="M20 4l-6 6"/><path d="M4 15h5v5"/><path d="M4 20l6-6"/>');
const ICON_REATTACH = svgIcon('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 4v4h-4"/>');
const ICON_CHATS = svgIcon('<path d="M4 5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-4 3v-3a2 2 0 0 1-1-2V7a2 2 0 0 1 2-2z"/>');
const ICON_CLOSE = svgIcon('<path d="M6 6l12 12"/><path d="M18 6L6 18"/>');
// phone toolbar (kbar) + mic icons
const ICON_UP = svgIcon('<path d="M12 19V6"/><path d="M6 12l6-6 6 6"/>');
const ICON_DOWN = svgIcon('<path d="M12 5v13"/><path d="M6 12l6 6 6-6"/>');
const ICON_LEFT = svgIcon('<path d="M19 12H6"/><path d="M12 6l-6 6 6 6"/>');
const ICON_RIGHT = svgIcon('<path d="M5 12h13"/><path d="M12 6l6 6-6 6"/>');
const ICON_ENTER = svgIcon('<path d="M20 6v5a3 3 0 0 1-3 3H5"/><path d="M9 10l-4 4 4 4"/>');
const ICON_MIC = svgIcon('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>');

const sessions = new Map();
let active = null; // key of the session shown in the drawer, or null when hidden

const drawerEl = () => document.getElementById("drawer");
const disp = name => name === "~" ? "~/Projects" : name; // display name

let audioCtx = null;
function blip(freqs) {
  // gentle sine blips; created on user-gesture-driven flows so autoplay rules allow it
  try {
    audioCtx = audioCtx || new AudioContext();
    freqs.forEach((f, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.06, audioCtx.currentTime + i * 0.14);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.14 + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(audioCtx.currentTime + i * 0.14);
      osc.stop(audioCtx.currentTime + i * 0.14 + 0.13);
    });
  } catch (e) { /* audio unavailable — stay silent */ }
}

function setStatus(s, status) {
  if (s.status === status) return;
  s.status = status;
  if (s.key !== active || !drawerEl().classList.contains("open")) {
    if (status === "attention") blip([880, 660]);
    else if (status === "ready") blip([520]);
  }
  renderPills();
}

// opt is a legacy boolean (resume picker) OR an options object:
//   { resume: bool, session: "<id>" (resume a specific session),
//     attach: "<token>" (reattach a live detached pty), label: "<text>" }
// token → session id, so a chat reattached after a page reload (or from the
// reattach pills) still knows which conversation it is. Kept small: entries
// only matter while their pty lives, and a stale one is simply overwritten.
// v2: the v1 store was poisoned. Reattaches used to cache an INVENTED id, and
// reading one back made the drawer confident about a conversation that never
// existed — the mark then went nowhere, visibly. Renaming the key retires every
// v1 entry at once; a chat whose id is genuinely unknown now greys the toggle.
const SID_KEY = "ptySid2";
try { localStorage.removeItem("ptySid"); } catch (e) { /* private mode */ }

function sidFor(token) {
  try { return JSON.parse(localStorage.getItem(SID_KEY) || "{}")[token] || ""; }
  catch (e) { return ""; }
}
function rememberSid(token, sid) {
  let m = {};
  try { m = JSON.parse(localStorage.getItem(SID_KEY) || "{}"); } catch (e) { m = {}; }
  m[token] = sid;
  const keys = Object.keys(m);
  if (keys.length > 60) delete m[keys[0]];      // oldest out; this is a cache
  localStorage.setItem(SID_KEY, JSON.stringify(m));
}

function openDrawer(project, opt = false) {
  const o = (typeof opt === "boolean") ? { resume: opt } : (opt || {});
  // Resumed/reattached sessions are keyed by their token so several from one
  // project can coexist; clicking a card's claude button keys by project, so a
  // second click focuses the chat you already have rather than duplicating it.
  // The menu's "fresh chat" says what it means, though — it keys uniquely, so
  // you can hold two conversations in one project (two root chats: the hub in
  // one, a new project being scaffolded in the other).
  const key = o.session ? `${project}#${o.session}`
            : o.attach ? `${project}#${o.attach}`
            : o.fresh ? `${project}#${crypto.randomUUID().slice(0, 8)}`
            : project;
  let s = sessions.get(key);
  if (!s || s.ws.readyState > 1) s = createSession(key, project, o);
  activate(key);
}

// The theme registry (THEME / THEME_ORDER / xtermTheme / _shade / _rgba /
// resolveTheme) lives in static/themes.js, loaded before this file and shared
// with the full-page terminal so both stay in lockstep. activeTheme is this
// page's current selection.
let activeTheme = "codex";

// Copy to the clipboard with a fallback for non-secure contexts (plain-http
// over the LAN, where navigator.clipboard is unavailable); brief toast either
// way. Reuses the same #hub-toast element the dictation feature uses.
function copyText(text) {
  const done = ok => hubToast(ok ? "copied selection" : "copy blocked");
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true)).catch(() => execCopy(text, done));
  } else {
    execCopy(text, done);
  }
}
function execCopy(text, done) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy");
    ta.remove(); done(ok);
  } catch (e) { done(false); }
}
function hubToast(msg) {
  let el = document.getElementById("hub-toast");
  if (!el) { el = document.createElement("div"); el.id = "hub-toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(hubToast._t);
  hubToast._t = setTimeout(() => el.classList.remove("show"), 1800);
}

function createSession(key, project, o) {
  const host = document.createElement("div");
  host.className = "term-host";
  document.getElementById("dterm").appendChild(host);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Hack', 'Noto Sans Mono', monospace",
    fontSize: 14, cursorBlink: true, customGlyphs: true,
    theme: xtermTheme(activeTheme),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // Suppress the mouse-reporting Claude Code turns on: swallow the DECSET/DECRST
  // sequences that enable mouse tracking so xterm never enters mouse mode. That
  // restores the pre-update feel — a plain drag selects text natively (and the
  // onSelectionChange handler below auto-copies it) instead of being eaten as a
  // click-to-navigate event. Covers live AND replayed-on-attach sequences, since
  // both pass through the parser.
  const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);
  const swallowMouse = p =>
    p.length > 0 && p.every(n => typeof n === "number" && MOUSE_MODES.has(n));
  term.parser.registerCsiHandler({ prefix: "?", final: "h" }, p => swallowMouse(p));
  term.parser.registerCsiHandler({ prefix: "?", final: "l" }, p => swallowMouse(p));
  // term.open() is deferred to activate(): opening into a hidden host breaks
  // the renderer on cold loads (the Ctrl+Shift+R blank-drawer bug). xterm
  // buffers writes before open, so early ws output is safe.

  const params = new URLSearchParams({ mode: chatMode, model: chatModel });
  if (o.resume) params.set("resume", "1");
  if (o.session) params.set("session", o.session);
  // every chat runs in a persistent pty (hub_ptyd) keyed by this token —
  // disconnects detach instead of killing, and the full-page view can
  // attach to the very same session
  const token = o.attach || o.session || Math.random().toString(36).slice(2, 10);
  params.set("attach", token);
  // Name a fresh chat's session id ourselves (--session-id) instead of letting
  // claude pick one it only reveals in a transcript later: the drawer needs to
  // know WHICH conversation it is showing to mark it unfinished. A resumed chat
  // already has one; a reattach re-reads the id we stored against its token.
  // Only ever a REAL id: the resumed one, the one we told claude to use, or the
  // one we stored against this pty. Never invent a fallback — an id claude
  // never saw files the mark under a conversation that does not exist, which
  // looks like the mark silently not working (it did; against nothing).
  // `resume` without an id opens claude's own picker — CLAUDE chooses the
  // conversation, so we cannot name it up front. That path is not fresh: minting
  // an id there is how the same chat ended up with two identities, one of them
  // fictional (opened from the list = marked, opened via the picker = not).
  const fresh = !o.session && !o.attach && !o.resume;
  const sid = o.session || (fresh ? crypto.randomUUID() : sidFor(token));
  if (fresh) params.set("sid", sid);
  if (sid) rememberSid(token, sid);
  // wss when served over https (e.g. via Tailscale Serve)
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${wsProto}://${location.host}/ws/terminal/${encodeURIComponent(project)}?${params}`);
  ws.binaryType = "arraybuffer";

  const s = { key, name: project, token, sid, label: o.label || disp(project),
    ws, term, fit, host, status: "working", lastOut: Date.now(), sawOutput: false };
  sessions.set(key, s);

  // --- selection → clipboard --------------------------------------------
  // With mouse reporting suppressed (above), a plain drag selects natively. The
  // xterm selection is canvas-drawn, NOT a DOM selection, so the browser's own
  // Ctrl+C / right-click "Copy" can't see it — we copy the settled selection
  // ourselves. onSelectionChange fires during the drag, so debounce to its end.
  let copyTimer = null;
  term.onSelectionChange(() => {
    const sel = term.getSelection();
    clearTimeout(copyTimer);
    if (sel && sel.trim()) copyTimer = setTimeout(() => copyText(sel), 150);
  });
  // Wheel → PgUp/PgDn. With mouse reporting suppressed, xterm's alt-screen
  // fallback turns the wheel into arrow keys, which Claude treats as navigation,
  // not scroll (it scrolls on PgUp/PgDn). So intercept the wheel first (capture
  // + stopPropagation, before xterm's own handler) and send page keys instead —
  // restores wheel-scroll without needing physical PgUp/PgDn keys. Throttled so
  // a fast spin (or a phone swipe's synthesized wheels) doesn't jump many pages.
  let lastWheel = 0;
  host.addEventListener("wheel", e => {
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    if (now - lastWheel < 60) return;
    lastWheel = now;
    if (ws.readyState === 1)
      ws.send(JSON.stringify({ type: "input", data: e.deltaY < 0 ? "\x1b[5~" : "\x1b[6~" }));
  }, { capture: true, passive: false });
  // one-time discoverability nudge
  if (!localStorage.getItem("hubSelTip")) {
    localStorage.setItem("hubSelTip", "1");
    setTimeout(() => hubToast("tip: drag to select — it copies automatically"), 900);
  }

  ws.onopen = () => refit(s);
  ws.onmessage = e => {
    const data = new Uint8Array(e.data);
    term.write(data);
    // first-output render kick: a freshly opened terminal sometimes paints
    // nothing until a resize forces renderer re-layout (the 'blank until ⤢'
    // bug). One invisible cols-jiggle replicates what expanding did.
    if (!s.kicked) {
      s.kicked = true;
      setTimeout(() => {
        try {
          const c = s.term.cols, r = s.term.rows;
          if (c > 2) { s.term.resize(c - 1, r); s.term.resize(c, r); }
          s.term.refresh(0, s.term.rows - 1);
        } catch (err) {}
      }, 200);
    }
    s.lastOut = Date.now();
    s.sawOutput = true;
    // the bell → "attention" (red) is meant to flag a BACKGROUND chat; don't
    // raise it on the chat you're already viewing (its pill is now visible, so
    // it would just flicker amber↔red as bells arrive — idea-#11 follow-up)
    const viewing = s.key === active && drawerEl().classList.contains("open");
    if (data.includes(7) && !viewing) setStatus(s, "attention");
    else if (s.status !== "attention" || viewing) setStatus(s, "working");
  };
  ws.onclose = () => {
    term.write("\r\n\x1b[33m[session ended]\x1b[0m\r\n");
    setStatus(s, "ended");
  };
  term.onData(d => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data: d }));
    if (s.status === "attention") setStatus(s, "working"); // user responded
  });
  new ResizeObserver(() => s.key === active && refit(s)).observe(host);
  return s;
}

function refit(s, force = false) {
  if (!s) return;
  if (!s.host.offsetParent) { s.pendingFit = true; return; } // hidden — retry on activate
  s.fit.fit();
  // only send real changes (the daemon treats a first same-size resize as
  // "repaint for me"; repeating it would spam duplicate frames into
  // scrollback). force=true re-syncs after another client resized the pty.
  const changed = s.sentCols !== s.term.cols || s.sentRows !== s.term.rows;
  if (s.ws.readyState === 1 && (changed || force || !s.everSized)) {
    s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
    s.sentCols = s.term.cols;
    s.sentRows = s.term.rows;
    s.everSized = true;
  }
}

// returning to this tab/window: another client (full page, phone) may have
// resized the shared pty meanwhile — re-assert our size so the layout snaps
// back instead of staying squished
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && active) refit(sessions.get(active), true);
});
window.addEventListener("focus", () => { if (active) refit(sessions.get(active), true); });

function activate(key) {
  active = key;
  const s = sessions.get(key);
  sessions.forEach(o => o.host.classList.toggle("shown", o.key === key));
  document.getElementById("d-title").textContent = s.label;
  if (window.syncDrawerWip) syncDrawerWip();   // the mark follows the shown chat
  // ⤢ expands the drawer to the full window width in place. The href still
  // points at the same live session (same attach token), so middle-click /
  // ctrl-click can mirror the chat in another tab when wanted.
  const full = document.getElementById("d-full");
  full.href = `/terminal/${encodeURIComponent(s.name)}?attach=${encodeURIComponent(s.token)}`;
  full.target = "_blank";
  full.title = "expand to full width (middle-click: mirror in a new tab)";
  full.onclick = e => { e.preventDefault(); toggleDrawerFull(); };
  drawerEl().classList.add("open");
  document.body.classList.add("drawer-open");
  if (s.status === "attention" || s.status === "ready") s.status = "working";
  renderPills();
  if (!s.opened) {
    s.term.open(s.host);
    s.opened = true;
    attachTouchScroll(s.host, s); // phone: swipes → SGR mouse-wheel reports claude scrolls smoothly
  }
  // fit when layout has actually settled (two consecutive frames with the
  // same non-zero width) instead of a fixed timer — cold loads lay out late
  const settle = (tries = 0, lastW = -1) => {
    const w = s.host.clientWidth;
    if ((w === 0 || w !== lastW) && tries < 60) {
      return requestAnimationFrame(() => settle(tries + 1, w));
    }
    refit(s, true);
    s.pendingFit = false;
    // a second fit next frame catches a row-short first fit when switching
    // between two active terminals, then pin the view to the latest output
    // (otherwise the last lines can sit just below the fold — 2026-06-13 bug)
    requestAnimationFrame(() => {
      refit(s, true);
      try { s.term.refresh(0, s.term.rows - 1); s.term.scrollToBottom(); } catch (e) {}
    });
    s.term.focus();
  };
  requestAnimationFrame(() => settle());
}

function toggleDrawerFull() {
  const fullNow = document.body.classList.toggle("drawer-full");
  const f = document.getElementById("d-full");
  f.innerHTML = fullNow ? ICON_COLLAPSE : ICON_EXPAND;
  f.blur(); // don't leave focus on ⤢ — else the next Enter re-toggles the drawer (idea #9)
  // reflow the terminal once the width transition settles, then hand focus back
  setTimeout(() => {
    const s = sessions.get(active);
    if (s) { refit(s); s.term.focus(); }
  }, 260);
}

// TUIs (claude code) have no native scrollback to pan, so finger swipes do
// nothing on a phone. We send Claude SGR mouse-wheel reports directly: it still
// has mouse mode on (we only stopped xterm from entering it, to free up text
// selection), so it understands wheel reports and scrolls a few lines per one —
// smooth, line-by-line, the way it felt before. (Desktop keeps the snappier
// wheel→PgUp/PgDn; only touch uses this finer path.)
function attachTouchScroll(host, s) {
  let lastY = null;
  host.addEventListener("touchstart", e => { lastY = e.touches[0].clientY; }, { passive: true });
  host.addEventListener("touchmove", e => {
    if (lastY === null) return;
    const y = e.touches[0].clientY, dy = lastY - y;
    if (Math.abs(dy) >= 10) {
      lastY = y;
      if (s.ws.readyState === 1) {
        const btn = dy > 0 ? 65 : 64;  // swipe up = scroll down (65); down = up (64)
        const col = Math.max(1, Math.floor(s.term.cols / 2));
        const row = Math.max(1, Math.floor(s.term.rows / 2));
        s.ws.send(JSON.stringify({ type: "input", data: `\x1b[<${btn};${col};${row}M` }));
      }
    }
    e.preventDefault(); // we own touch here — no native pan fighting
  }, { passive: false });
  host.addEventListener("touchend", () => { lastY = null; }, { passive: true });
}

function minimizeDrawer() {
  drawerEl().classList.remove("open");
  document.body.classList.remove("drawer-open");
  active = null;
  renderPills();
}

function closeActive() {
  const s = sessions.get(active);
  if (!s) return;
  // ✕ means END the session — tell the pty daemon to kill it; a plain
  // disconnect (refresh, navigation) detaches and the session lives on
  if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ type: "kill" }));
  s.ws.close();
  s.term.dispose();
  s.host.remove();
  sessions.delete(active);
  // the pty is now killed — drop it from the detached list too, or renderPills
  // would resurrect it as a ⟲ reattach pill (idea #8 bug)
  detachedPtys = detachedPtys.filter(p => p.token !== s.token);
  const next = sessions.keys().next();
  if (next.done) minimizeDrawer();
  else activate(next.value);
}

// --- detached persistent sessions → reattach pills ---------------------------
// After a page reload (or coming back on the phone) the client state is gone
// but hub_ptyd sessions live on; offer them as pills.
let detachedPtys = [];
async function loadDetached() {
  try {
    const r = await fetch("/api/ptys");
    const data = r.ok ? await r.json() : [];
    detachedPtys = Array.isArray(data) ? data : [];
  } catch (e) {
    detachedPtys = []; // older server without /api/ptys — feature dormant
  }
  renderPills();
}
loadDetached();

function renderPills() {
  const box = document.getElementById("pills");
  box.innerHTML = "";
  sessions.forEach(s => {
    const pill = document.createElement("button");
    pill.className = `pill s-${s.status}`;
    // keep the active session's pill in place (stable order) with a highlight,
    // instead of removing it and shuffling the rest (idea #11)
    if (s.key === active && drawerEl().classList.contains("open")) pill.classList.add("active");
    // Project name FIRST, always in full: with several pills up, "which project
    // is this?" is the question you actually ask, and a resumed chat's title
    // (which the conversation list supplies) buried that. The title still earns
    // its place after it — trimmed, since it only has to tell two chats in the
    // same project apart — and in full in the tooltip.
    const proj = disp(s.name);
    const rest = s.label === proj ? "" : s.label;
    const trimmed = rest.length > 18 ? rest.slice(0, 17) + "…" : rest;
    pill.innerHTML = `<span class="dot"></span>${CHAT_ICON} `;
    pill.appendChild(document.createTextNode(proj + (trimmed ? ` · ${trimmed}` : "")));
    pill.title = ({ working: "working…", ready: "ready for you",
                   attention: "needs your input", ended: "session ended" }[s.status] || "")
                 + (rest ? ` — ${rest}` : "");
    pill.onclick = () => s.status === "ended"
      ? (s.host.remove(), sessions.delete(s.key), renderPills())
      : activate(s.key);
    box.appendChild(pill);
  });
  // live-but-detached ptys (e.g. after a page reload) — click to reattach
  const attached = new Set([...sessions.values()].map(s => s.token));
  detachedPtys.forEach(p => {
    if (attached.has(p.token)) return;
    const pill = document.createElement("button");
    pill.className = "pill s-detached";
    pill.innerHTML = `<span class="dot"></span>${ICON_REATTACH} `;
    pill.appendChild(document.createTextNode(disp(p.project)));
    pill.title = "live detached session — click to reattach";
    pill.onclick = () => openDrawer(p.project, { attach: p.token });
    box.appendChild(pill);
  });
}

// working → ready when output has been quiet for a few seconds
setInterval(() => {
  sessions.forEach(s => {
    if (s.status === "working" && s.sawOutput && Date.now() - s.lastOut > 4000
        && (s.key !== active || !drawerEl().classList.contains("open"))) {
      setStatus(s, "ready");
    }
  });
}, 1000);

// --- conversation manager (v3) ----------------------------------------------
// Browse past Claude sessions across projects (GET /api/sessions) and resume
// one into the drawer — it then joins the live-session pills like any chat.
// Injected from JS (no app.py template change → no service restart).
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .sess-overlay { position:fixed; inset:0; background:var(--scrim); z-index:70;
      display:flex; align-items:flex-start; justify-content:center; padding-top:9vh; }
    .sess-overlay[hidden] { display:none; }
    .sess-modal { width:min(640px,94vw); max-height:78vh; background:var(--parchment);
      border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
      outline-offset:4px; border-radius:2px; padding:1rem 1.2rem; position:relative;
      display:flex; flex-direction:column; box-shadow:3px 5px 18px rgba(40,30,15,.45); }
    .sess-modal .m-head { display:flex; align-items:center; margin-bottom:.5rem; }
    .sess-modal .m-head h3 { margin:0; flex:1; font-size:1rem; font-weight:600;
      font-variant:small-caps; letter-spacing:.08em; color:var(--ink); }
    #sess-search { width:100%; box-sizing:border-box; background:var(--input-bg);
      border:1px solid var(--ink-soft); border-radius:2px; color:var(--ink); font:inherit;
      font-size:.9rem; padding:.35rem .6rem; margin-bottom:.5rem; }
    #sess-search::placeholder { color:var(--ink-faint); font-style:italic; }
    #sess-list { overflow-y:auto; min-height:0; scrollbar-width:thin;
      scrollbar-color:var(--ink-faint) transparent; }
    /* badge on its own line on top, title + meta beneath — keeps every row's
       text left-aligned regardless of project-name length */
    .sess-row { display:flex; flex-direction:column; align-items:flex-start; gap:.28rem;
      padding:.5rem .35rem; border-bottom:1px dotted rgba(156,135,95,.4); cursor:pointer; }
    .sess-row:hover { background:var(--card-hot); }
    .sess-row .s-main { width:100%; min-width:0; }
    .sess-row .s-title { display:block; color:var(--ink); font-size:.92rem;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sess-row .s-meta { display:block; color:var(--ink-faint); font-size:.76rem;
      font-variant:small-caps; letter-spacing:.04em; }
    .sess-row .s-proj { color:var(--parchment); background:var(--ink-soft);
      border-radius:999px; font-size:.7rem; font-variant:small-caps; letter-spacing:.05em;
      padding:.05rem .55rem; }
    .sess-empty { color:var(--ink-faint); font-style:italic; text-align:center; padding:1.4rem; }
    /* the unfinished mark: opt-in, one flag, set by you and nothing else.
       Ochre = the same pigment the ★ uses for "your pick", since this is the
       other thing you say about a chat rather than something derived from it */
    .sess-row.wip { border-left:3px solid var(--ochre); padding-left:.5rem; }
    .s-wip { position:absolute; top:.5rem; right:.35rem; border:0; background:none;
      color:var(--ink-faint); cursor:pointer; padding:.1rem .3rem; font:inherit;
      font-size:.72rem; font-variant:small-caps; letter-spacing:.06em; opacity:0; }
    .sess-row { position:relative; }
    /* the toggle stays hidden until you reach for it — a marked row keeps it
       visible, so the mark is never a state you can't see how to undo */
    .sess-row:hover .s-wip, .sess-row.wip .s-wip { opacity:1; }
    .s-wip:hover { color:var(--ink); background:none; }
    .sess-row.wip .s-wip { color:var(--ochre); }
    .sess-band { color:var(--ink-faint); font-size:.7rem; font-variant:small-caps;
      letter-spacing:.1em; padding:.5rem .35rem .2rem; }
    /* an orphaned mark: kept visible so it can be cleared, but visibly inert */
    .sess-row.orphan { cursor:default; opacity:.7; }
    .sess-row.orphan:hover { background:none; }
    .sess-row.orphan .s-title { font-style:italic; color:var(--ink-faint); }`;
  document.head.appendChild(style);

  const trigger = document.createElement("button");
  trigger.className = "jot-open";
  trigger.id = "sess-open";
  trigger.innerHTML = `${ICON_CHATS} chats`;
  trigger.title = "browse & resume past Claude sessions";
  trigger.onclick = () => openSessions();
  const rootMenu = document.querySelector(".controls > .menu");
  if (rootMenu) rootMenu.after(trigger);
  else document.querySelector(".controls").prepend(trigger);

  const overlay = document.createElement("div");
  overlay.className = "sess-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="sess-modal">
      <div class="m-head"><h3>conversations</h3><button class="del" title="close">${ICON_CLOSE}</button></div>
      <input id="sess-search" type="search" placeholder="search sessions…" autocomplete="off">
      <div id="sess-list"></div>
    </div>`;
  document.body.appendChild(overlay);
  const listEl = overlay.querySelector("#sess-list");
  const searchEl = overlay.querySelector("#sess-search");
  overlay.querySelector(".del").onclick = () => closeSessions();

  let allSessions = [];

  window.openSessions = async function () {
    overlay.hidden = false;
    searchEl.value = "";
    listEl.innerHTML = `<div class="sess-empty">loading…</div>`;
    // re-read the notes doc first: the marks live in it, and another writer
    // (a Claude session editing via the API) may have moved on since page load
    // (loadNotes itself flushes any pending save before reading)
    try { await loadNotes(); } catch (e) { /* keep what we have */ }
    try { allSessions = await (await fetch("/api/sessions")).json(); }
    catch (e) { allSessions = []; }
    renderSessions("");
    searchEl.focus();
  };
  window.closeSessions = function () { overlay.hidden = true; };

  function rel(mtime) {
    const s = Math.max(0, Date.now() / 1000 - mtime);
    if (s < 45) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  // work spanning several days is the case this exists for: the flag is keyed
  // to the Claude session id (durable — the pty token and the pills are not),
  // and lives in notes.json beside `favorites`.
  const wipSet = () => new Set(notes.wip || []);
  // Shared with the drawer header — the mark is one flag, set from either place.
  // Saved through its own endpoint, NOT the whole-document PUT: marks are
  // toggled casually and concurrently (drawer, list, phone, second tab), and a
  // whole-doc save from any stale writer would silently erase them. The server
  // merges one mark at a time under a lock; the response is the merged truth.
  window.toggleWip = function (id) {
    notes.wip = notes.wip || [];
    const i = notes.wip.indexOf(id);
    const on = i < 0;
    if (on) notes.wip.push(id); else notes.wip.splice(i, 1);   // optimistic
    fetch(`/api/notes/wip/${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
      keepalive: true,
    }).then(r => r.json())
      .then(d => { if (d && d.wip) { notes.wip = d.wip; refresh(); } })
      .catch(() => hubToast("couldn't save the mark — is the hub reachable?"));
    refresh();
    function refresh() {
      if (!overlay.hidden) renderSessions(searchEl.value);
      if (window.syncDrawerWip) syncDrawerWip();
    }
  };
  const toggleWip = window.toggleWip;

  function renderSessions(q) {
    q = q.toLowerCase();
    const wip = wipSet();
    let rows = allSessions.filter(s =>
      !q || `${s.title} ${s.project} ${s.preview}`.toLowerCase().includes(q));
    // marked chats float to the top: recency order buries a week-old thread you
    // are still on, which is the whole problem the mark exists to solve
    const marked = rows.filter(s => wip.has(s.id));
    const rest = rows.filter(s => !wip.has(s.id));
    // a mark whose conversation the list can't show (chat never got its first
    // message, or the transcript aged out) must not just vanish — invisible
    // orphans accumulate forever and the mark looks like it "didn't work"
    const listed = new Set(allSessions.map(s => s.id));
    const orphans = q ? [] : [...wip].filter(id => !listed.has(id));
    listEl.innerHTML = "";
    if (!rows.length && !orphans.length) {
      listEl.innerHTML = `<div class="sess-empty">no sessions${q ? " match" : " yet"}.</div>`;
      return;
    }
    const band = text => {
      const h = document.createElement("div");
      h.className = "sess-band";
      h.textContent = text;
      listEl.appendChild(h);
    };
    if (marked.length) band("still going");
    [...marked, ...rest].forEach((s, i) => {
      if (marked.length && i === marked.length) band("the rest");
      const row = document.createElement("div");
      row.className = "sess-row" + (wip.has(s.id) ? " wip" : "");
      const proj = document.createElement("span");
      proj.className = "s-proj";
      proj.textContent = s.project;
      const main = document.createElement("div");
      main.className = "s-main";
      const title = document.createElement("span");
      title.className = "s-title";
      title.textContent = s.title;
      const meta = document.createElement("span");
      meta.className = "s-meta";
      meta.textContent = `${rel(s.mtime)} · ${s.count} msgs`;
      main.append(title, meta);
      const flag = document.createElement("button");
      flag.className = "s-wip";
      flag.textContent = wip.has(s.id) ? "● unfinished" : "○ mark unfinished";
      flag.title = wip.has(s.id)
        ? "done with this one? click to clear the mark"
        : "mark as still in progress — it stays at the top until you clear it";
      flag.onclick = e => { e.stopPropagation(); toggleWip(s.id); };  // not a resume
      row.append(proj, main, flag);
      row.title = "resume this session";
      row.onclick = () => { closeSessions(); openDrawer(s.project, { session: s.id, label: s.title }); };
      listEl.appendChild(row);
    });
    if (orphans.length) {
      band("marked, but not listable");
      orphans.forEach(id => {
        const row = document.createElement("div");
        row.className = "sess-row wip orphan";
        const main = document.createElement("div");
        main.className = "s-main";
        const title = document.createElement("span");
        title.className = "s-title";
        title.textContent = `(no conversation found: ${id.slice(0, 8)}…)`;
        const meta = document.createElement("span");
        meta.className = "s-meta";
        meta.textContent = "the chat never got a first message, or its transcript aged out";
        main.append(title, meta);
        const flag = document.createElement("button");
        flag.className = "s-wip";
        flag.textContent = "● clear mark";
        flag.title = "remove this mark — nothing resumable is behind it";
        flag.onclick = e => { e.stopPropagation(); toggleWip(id); };
        row.append(main, flag);
        listEl.appendChild(row);
      });
    }
  }

  searchEl.addEventListener("input", () => renderSessions(searchEl.value));
  let pressInside = false;
  overlay.addEventListener("mousedown", e => { pressInside = e.target === overlay; });
  overlay.addEventListener("mouseup", e => {
    if (pressInside && e.target === overlay) closeSessions();
    pressInside = false;
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && !overlay.hidden) closeSessions();
  });
})();

// --- on-screen key toolbar for the drawer terminal (touch devices) ----------
// Phone soft-keyboards have no arrow/Esc/Tab keys, so Claude Code's selection
// prompts (↑/↓ + Enter) and multi-select forms (↑/↓ + Space + Enter) are
// unusable from the phone. These buttons send the raw sequences to the active
// session's pty. Shown only on coarse-pointer (touch) devices so the laptop
// drawer stays clean.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .kbar { display:none; flex-wrap:wrap; gap:.3rem; padding:.4rem;
      background:#1a1b26; border-top:1px solid #2a2b3c; }
    @media (pointer: coarse) { .kbar { display:flex; } }
    .kbar button { flex:0 0 auto; min-width:2.6rem; padding:.55rem .6rem;
      font:1rem/1 "JetBrains Mono","Noto Sans Mono",monospace; background:#24283b;
      color:#c0caf5; border:1px solid #3b4261; border-radius:4px; cursor:pointer;
      user-select:none; touch-action:manipulation; }
    .kbar button:active { background:#3b4261; }
    .kbar .wide { min-width:3.6rem; font-variant:small-caps; letter-spacing:.04em; }
    .kbar .mic.rec { background:#7a2733; border-color:#f7768e; animation:micpulse 1.2s infinite; }
    @keyframes micpulse { 50% { opacity:.55; } }
    /* T38: global dictation mics — phone only, float bottom-left */
    /* floating mics: above the jot(60)/session(70) modals, below the theme
       picker(80). Hidden while the drawer is open — the kbar mics serve there. */
    #micbar { display:none; position:fixed; left:1.05rem; bottom:1.05rem; z-index:75;
      flex-direction:column; gap:.4rem; }
    @media (pointer: coarse) { #micbar { display:flex; } }
    body.drawer-open #micbar { display:none; }
    #micbar .mic { font:1rem/1 "JetBrains Mono","Noto Sans Mono",monospace;
      background:var(--paper, #24283b); color:var(--ink, #c0caf5);
      border:1px solid var(--ink-soft, #3b4261); border-radius:999px;
      padding:.5rem .7rem; cursor:pointer; box-shadow:1px 2px 7px rgba(0,0,0,.3);
      user-select:none; touch-action:manipulation; }
    #micbar .mic.rec { background:#7a2733; color:#fff; border-color:#f7768e;
      animation:micpulse 1.2s infinite; }
    #hub-toast { position:fixed; left:50%; bottom:4.6rem; transform:translateX(-50%) translateY(.8rem);
      background:var(--ink, #1a1b26); color:var(--parchment, #efe2c0); font-size:.85rem;
      padding:.5rem .9rem; border-radius:6px; box-shadow:1px 2px 10px rgba(0,0,0,.4);
      opacity:0; pointer-events:none; transition:opacity .2s ease, transform .2s ease; z-index:90; }
    #hub-toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
    .pill.s-detached .dot { background:#7aa2f7; }
    /* ⤢ in-place full-width drawer */
    #drawer { transition: transform .22s ease, width .22s ease; }
    body.drawer-full #drawer { width: 100vw; }
    body.drawer-full.drawer-open #pills { right: 1.1rem; }
    /* phone ergonomics: full-width drawer, bigger touch targets, hide
       laptop-only actions (files/launch act on the laptop, not the phone) */
    @media (max-width: 700px) { :root { --drawer-w: 100vw; } }
    /* Android: 100vh hides behind the browser chrome — dvh tracks it */
    #drawer { height: 100dvh; }
    .kbar { padding-bottom: max(.4rem, env(safe-area-inset-bottom)); }
    /* we translate touch swipes to wheel events ourselves (TUIs have no
       native scrollbar) — so take full ownership of touch on the terminal */
    .xterm, .xterm-viewport { touch-action: none; }
    @media (max-width: 700px) {
      /* the drawer is already full-width on phones — ⤢ expand is meaningless */
      #d-full { display: none; }
      header h1 { font-size: clamp(.95rem, 4.2vw, 1.25rem);
        letter-spacing: .1em; white-space: normal; padding: 0 2.4rem; }
      #shelf { padding: 1.2rem .8rem; }
      .rule { width: 85%; }
    }
    @media (pointer: coarse) {
      /* hide LAPTOP-side card actions only — scoped to .card, because the
         jot delete-confirm 'remove' button also carries b-go (phone bug:
         only 'keep' was visible) */
      .card .b-files, .card button.b-go { display: none; }
      .d-head button, .d-head a { font-size: 1.3rem; padding: .25rem .55rem; }
      .jot-open, .chip { padding: .42rem .85rem; }
    }`;
  document.head.appendChild(style);

  // hide "in konsole" menu entries on touch devices — konsole opens on the
  // laptop, which is not where the phone user is
  if (matchMedia("(pointer: coarse)").matches) {
    document.querySelectorAll(".menu-items button").forEach(b => {
      if (/konsole/i.test(b.textContent)) b.style.display = "none";
    });
  }

  // NOTE: deliberately no term.focus() here — focusing xterm's hidden textarea
  // pops the phone's soft keyboard open on every toolbar tap. The buttons'
  // pointerdown preventDefault keeps existing focus (and keyboard state) as-is.
  function sendActiveKey(seq) {
    const s = sessions.get(active);
    if (s && s.ws.readyState === 1) {
      s.ws.send(JSON.stringify({ type: "input", data: seq }));
    }
  }

  // label, sequence, extra class, icon (arrows/enter as line-art SVG; the word
  // keys — space/esc/tab/⌃C — stay as text labels, which read clearer than an
  // invented glyph would)
  const KEYS = [
    ["up", "\x1b[A", "", ICON_UP], ["down", "\x1b[B", "", ICON_DOWN],
    ["left", "\x1b[D", "", ICON_LEFT], ["right", "\x1b[C", "", ICON_RIGHT],
    ["enter", "\r", "wide", ICON_ENTER], ["space", " ", "wide"],
    ["esc", "\x1b", "wide"], ["tab", "\t", "wide"], ["⌃C", "\x03", "wide"],
  ];
  const bar = document.createElement("div");
  bar.className = "kbar";
  for (const [label, seq, cls, ic] of KEYS) {
    const b = document.createElement("button");
    if (ic) { b.innerHTML = ic; } else { b.textContent = label; }
    if (cls) b.className = cls;
    b.title = label === "space" ? "Space (toggle option)" : label;
    b.addEventListener("pointerdown", e => e.preventDefault()); // don't steal focus
    b.addEventListener("click", () => sendActiveKey(seq));
    bar.appendChild(b);
  }

  document.getElementById("drawer").appendChild(bar);

  // --- T38: global dictation mics (phone) --------------------------------
  // The two language mics now live OUTSIDE the terminal so you can dictate into
  // ANY field on the phone, not just the chat. Pipeline is unchanged
  // (MediaRecorder → /api/dictate → local Whisper; Firefox-friendly, nothing
  // leaves the laptop). The transcript is routed by the MOST-RECENT focus:
  //   a text field → inserted at the cursor (fires `input` so search/jot react)
  //   the active terminal → sent with the [voice]/[глас] prefix (as before)
  //   nothing focused → copied to the clipboard with a toast.
  const MIC_PREFIX = { en: "[voice] ", bg: "[глас] " };

  // remember the last dictation target — a text field, or the terminal
  let lastTarget = null;
  document.addEventListener("focusin", e => {
    const t = e.target;
    if (t.closest && t.closest(".term-host")) lastTarget = { kind: "term" };
    else if (t.matches && !t.closest(".kbar") &&
             t.matches("textarea, input:not([type]), input[type=text], input[type=search]"))
      lastTarget = { kind: "field", el: t };
  });

  function toast(msg) {
    let el = document.getElementById("hub-toast");
    if (!el) { el = document.createElement("div"); el.id = "hub-toast"; document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function insertAtCursor(el, text) {
    const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true })); // search refilter / jot grow
    el.focus();
  }

  function deliverDictation(lang, text) {
    const f = lastTarget?.kind === "field" ? lastTarget.el : null;
    if (f && f.isConnected && f.offsetParent !== null) {
      insertAtCursor(f, text);
      return;
    }
    if ((lastTarget?.kind === "term" || !lastTarget) && active &&
        drawerEl().classList.contains("open")) {
      sendActiveKey(MIC_PREFIX[lang] + text + " ");
      return;
    }
    (navigator.clipboard?.writeText(text) ?? Promise.reject())
      .then(() => toast("copied — paste anywhere"))
      .catch(() => toast("nothing focused — and clipboard blocked"));
  }

  let rec = null, busy = false;
  function makeMic(lang, extraCls) {
    const tag = lang === "bg" ? "бг" : "en";
    const rest = ICON_MIC + tag;       // resting label: mic glyph + language
    const btn = document.createElement("button");
    btn.className = extraCls ? "mic " + extraCls : "mic";
    btn.innerHTML = rest;
    btn.title = `dictate in ${lang === "bg" ? "Bulgarian" : "English"} via local Whisper`;
    btn.addEventListener("pointerdown", e => e.preventDefault()); // keep focus/keyboard as-is
    btn.addEventListener("click", async () => {
      if (busy) return;
      if (rec) { if (rec.state === "recording") rec.stop(); return; }
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        toast("mic needs the https tailnet URL (not plain http)"); return;
      }
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch (err) {
        toast("mic: " + err.name + (err.name === "NotAllowedError" ? " — allow the microphone" : ""));
        return;
      }
      rec = new MediaRecorder(stream);
      const chunks = [];
      rec.ondataavailable = ev => { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        rec = null; busy = true;
        btn.classList.remove("rec"); btn.textContent = "⋯";  // transcribing
        try {
          const res = await fetch("/api/dictate?lang=" + lang, { method: "POST", body: blob });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.detail || ("HTTP " + res.status));
          const text = (data.text || "").trim();
          if (text) deliverDictation(lang, text);
          else toast("heard nothing — try again");
        } catch (err) { toast("dictation failed: " + err.message); }
        finally { busy = false; btn.innerHTML = rest; }
      };
      btn.classList.add("rec"); rec.start();
    });
    return btn;
  }

  // Two placements, one logic (per-screen, so nothing overlaps):
  //  • the full-screen terminal gets mics in its kbar footer
  //  • the shelf / modals get the floating micbar (hidden while the drawer is
  //    open so it never doubles with the kbar mics)
  bar.append(makeMic("en", "wide"), makeMic("bg", "wide"));

  const micbar = document.createElement("div");
  micbar.id = "micbar";
  micbar.append(makeMic("en"), makeMic("bg"));
  document.body.appendChild(micbar);
})();


// --- clearable inputs: a ✕ wipes the field (idea from the search filters) ----
// Wraps each wired input in a positioned span; the ✕ shows only while there is
// text — via :placeholder-shown, so programmatic clears (add-note, modal open)
// hide it with no JS state. Clicking dispatches `input` so filters re-run.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .clear-wrap { position:relative; display:flex; align-items:center; min-width:0; }
    /* !important: each wired input's own id/form rule outranks this one, and
       every one must cede the right edge to the ✕ */
    .clear-wrap > input { width:100%; padding-right:1.7rem !important; box-sizing:border-box; }
    .jot-controls .clear-wrap, .jot-add .clear-wrap { flex:1; }
    .clear-x { position:absolute; right:.1rem; top:50%; transform:translateY(-50%);
      border:0; background:transparent; color:var(--ink-faint); cursor:pointer;
      font:inherit; font-size:.9rem; line-height:1; padding:.3rem .45rem; }
    /* own hover colours — the global button:hover dark fill leaks in otherwise */
    .clear-x:hover { color:var(--ink); background:transparent; }
    .clear-wrap > input:placeholder-shown + .clear-x { display:none; }
    /* one ✕, ours — hide the native webkit one on type=search (Android Chrome) */
    input[type="search"]::-webkit-search-cancel-button { -webkit-appearance:none; display:none; }`;
  document.head.appendChild(style);
  const wire = (input) => {
    if (!input) return;
    const wrap = document.createElement("span");
    wrap.className = "clear-wrap";
    input.replaceWith(wrap);
    wrap.appendChild(input);
    const x = document.createElement("button");
    x.type = "button";  // never submit the jot-add form
    x.className = "clear-x";
    x.title = "clear";
    x.setAttribute("aria-label", "clear");
    x.textContent = "✕";
    x.onclick = () => {
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
    };
    wrap.appendChild(x);
  };
  ["search", "jot-search", "sess-search", "todos-input", "ideas-input"]
    .forEach(id => wire(document.getElementById(id)));
})();

// --- themes (T19): switchable skins over the CSS variable palette -----------
// codex = the default parchment look; overrides live on body[data-theme].
(() => {
  // generate the body[data-theme=…] CSS overrides from the registry (codex is
  // the default :root, so it's skipped); bg gradient + panel overlays derived
  const style = document.createElement("style");
  style.textContent = THEME_ORDER.filter(k => k !== "codex").map(k => {
    const t = THEME[k], dark = t.mode === "dark";
    return `body[data-theme="${k}"]{
      --font-family:${t.font};
      --parchment:${t.bg}; --paper:${t.paper}; --ink:${t.ink};
      --ink-soft:${t.inkSoft}; --ink-faint:${t.inkFaint};
      --lapis:${t.lapis}; --sanguine:${t.sanguine}; --verdigris:${t.verdigris};
      --ochre:${t.ochre}; --plum:${t.plum};
      --bg-hi:${_shade(t.bg, dark ? 7 : 5)}; --bg-mid:${t.bg}; --bg-lo:${_shade(t.bg, dark ? -6 : -7)};
      --card-bg:${_rgba(t.paper, dark ? .42 : .4)}; --card-hot:${_rgba(t.paper, dark ? .8 : .72)};
      --input-bg:${_rgba(t.paper, .5)};
      --scrim:${dark ? _rgba(_shade(t.bg, -60), .55) : _rgba(t.ink, .4)};
      --veil:${_rgba(t.bg, .96)}; color-scheme:${t.mode}; }`;
  }).join("\n");
  document.head.appendChild(style);

  // --- skin layer (theme-worlds): a theme may carry an optional `skin` that
  // goes beyond the palette — extra CSS + mounted overlay DOM (scanlines, a
  // live canvas, etc). Each skin: { css } static rules injected once, scoped to
  // its own body[data-theme]; mount() returns a teardown fn run on theme change.
  // This is the hook a future p5.js "world" mounts its sketch canvas into.

  // lazy-load the vendored p5.js once, only when a generative world mounts
  let _p5load = null;
  const loadP5 = () => window.p5 ? Promise.resolve()
    : (_p5load = _p5load || new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "/static/vendor/p5.min.js"; s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      }));

  // flow-field sketch (adapted from p5-playground/flow-field to instance mode):
  // a Perlin-noise vector field driving particles, tinted from the theme's own
  // pigments and fading as slow trails so it reads as one cohesive world.
  const makeFlowSketch = (theme, container) => {
    const [bgR, bgG, bgB] = _hx(theme.bg);
    // a designed 2-colour scheme if the theme defines `flow`, else its pigments
    const palette = (theme.flow || [theme.lapis, theme.verdigris, theme.plum, theme.ochre, theme.sanguine]).map(_hx);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scl = 14, inc = 0.16;  // higher = more turbulent field, shorter streamlines
    return (p) => {
      let parts = [], field, ncols, nrows, zoff = 0;
      const reseed = () => { ncols = p.floor(p.width / scl); nrows = p.floor(p.height / scl);
        field = new Array(ncols * nrows); };
      class Particle {
        constructor() { this.pos = p.createVector(p.random(p.width), p.random(p.height));
          this.vel = p.createVector(0, 0); this.acc = p.createVector(0, 0);
          this.max = p.random(1.0, 2.2);  // per-particle speed → they desync, don't ride as one
          this.col = palette[(p.random(palette.length)) | 0]; }
        follow(f) { const v = f[p.floor(this.pos.x / scl) + p.floor(this.pos.y / scl) * ncols];
          if (v) this.acc.add(v);
          this.acc.add(p5.Vector.random2D().mult(0.06)); }  // jitter breaks the "snake" clumping
        update() { this.vel.add(this.acc); this.vel.limit(this.max); this.pos.add(this.vel); this.acc.mult(0); }
        edges() { if (this.pos.x > p.width) this.pos.x = 0; if (this.pos.x < 0) this.pos.x = p.width;
          if (this.pos.y > p.height) this.pos.y = 0; if (this.pos.y < 0) this.pos.y = p.height; }
        show() { p.stroke(this.col[0], this.col[1], this.col[2], 72); p.strokeWeight(1.6);
          p.point(this.pos.x, this.pos.y); }
      }
      p.setup = () => {
        p.createCanvas(p.windowWidth, p.windowHeight).parent(container);
        p.pixelDensity(1); p.frameRate(30); reseed();
        const N = Math.min(1000, Math.floor(p.width * p.height / 2100));
        for (let i = 0; i < N; i++) parts.push(new Particle());
        p.background(bgR, bgG, bgB);
      };
      p.draw = () => {
        p.background(bgR, bgG, bgB, 16);  // translucent wash → slow fading trails
        let yoff = 0;
        for (let y = 0; y < nrows; y++) { let xoff = 0;
          for (let x = 0; x < ncols; x++) {
            const v = p5.Vector.fromAngle(p.noise(xoff, yoff, zoff) * p.TWO_PI * 2);
            v.setMag(0.2); field[x + y * ncols] = v; xoff += inc; }
          yoff += inc; }
        zoff += 0.0006;
        for (const pt of parts) { pt.follow(field); pt.update(); pt.edges(); pt.show(); }
        if (reduced && p.frameCount > 140) p.noLoop();  // settle to a still field
      };
      p.windowResized = () => { p.resizeCanvas(p.windowWidth, p.windowHeight); reseed();
        p.background(bgR, bgG, bgB); };
    };
  };

  // old-growth sketch: ONE warm light source raking from the upper-left — a soft
  // amber pool + a few faint god-ray shafts (essentially static), with ~a dozen
  // slow dust motes drifting through, brighter where they near the light. All on
  // additive blend so the warm light glows over the cool pine-shadow base.
  // Atmospheric by design: low alpha, low frame rate, motion off when reduced.
  const makeGroveSketch = (theme, container) => {
    const [bgR, bgG, bgB] = _hx(theme.bg);
    const [amR, amG, amB] = _hx(theme.ochre);          // the warm light
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    return (p) => {
      let motes = [], sprite, src;
      const count = () => Math.max(8, Math.min(18, Math.floor(p.width * p.height / 90000)));
      const makeSprite = () => {                         // soft round glow, drawn once
        const s = 64, g = p.createGraphics(s, s), ctx = g.drawingContext;
        const r = ctx.createRadialGradient(s/2, s/2, 0, s/2, s/2, s/2);
        r.addColorStop(0, "rgba(255,255,255,1)");
        r.addColorStop(0.3, "rgba(255,246,220,0.85)");
        r.addColorStop(1, "rgba(255,246,220,0)");
        ctx.fillStyle = r; ctx.fillRect(0, 0, s, s);
        return g;
      };
      class Mote {
        constructor() { this.reset(true); }
        reset(init) {
          this.x = p.random(p.width);
          this.y = init ? p.random(p.height) : p.random(-30, p.height * 0.4);
          this.r = p.random(1.1, 3.2);
          this.vx = p.random(0.05, 0.22); this.vy = p.random(0.04, 0.15); // drift with the light
          this.ph = p.random(p.TWO_PI); this.tw = p.random(0.004, 0.011); // slow twinkle
          this.base = p.random(0.16, 0.46);
        }
        step() {
          this.x += this.vx + Math.sin(this.ph) * 0.05; this.y += this.vy; this.ph += this.tw;
          if (this.x > p.width + 12 || this.y > p.height + 12) this.reset(false);
        }
        draw() {
          const d = 1 - p.constrain(p.dist(this.x, this.y, src.x, src.y) / (p.width * 0.95), 0, 1);
          const a = this.base * (0.35 + 0.65 * d) * (0.72 + 0.28 * Math.sin(this.ph));
          const s = this.r * 6;
          p.tint(255, 255, 255, a * 255);
          p.image(sprite, this.x - s/2, this.y - s/2, s, s);
        }
      }
      const drawLight = () => {                          // pool + shafts, additive
        const ctx = p.drawingContext;
        let g = ctx.createRadialGradient(src.x, src.y, 0, src.x, src.y, p.width * 0.85);
        g.addColorStop(0, `rgba(${amR},${amG},${amB},0.11)`);
        g.addColorStop(1, `rgba(${amR},${amG},${amB},0)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, p.width, p.height);
        ctx.save(); ctx.translate(src.x, src.y); ctx.rotate(0.6);  // ~34° off vertical
        for (const [ang, w] of [[0, 150], [0.17, 95], [-0.15, 115], [0.32, 70]]) {
          ctx.save(); ctx.rotate(ang);
          const len = p.width * 1.4, sg = ctx.createLinearGradient(0, 0, 0, len);
          sg.addColorStop(0, `rgba(${amR},${amG},${amB},0.05)`);
          sg.addColorStop(1, `rgba(${amR},${amG},${amB},0)`);
          ctx.fillStyle = sg; ctx.fillRect(-w/2, 0, w, len);
          ctx.restore();
        }
        ctx.restore();
      };
      const scene = (stepMotes) => {
        p.background(bgR, bgG, bgB);
        p.push(); p.blendMode(p.ADD);
        drawLight();
        for (const m of motes) { if (stepMotes) m.step(); m.draw(); }
        p.pop();
      };
      p.setup = () => {
        p.createCanvas(p.windowWidth, p.windowHeight).parent(container);
        p.pixelDensity(1); p.frameRate(30);
        sprite = makeSprite();
        src = p.createVector(p.width * 0.08, -p.height * 0.06);
        for (let i = 0; i < count(); i++) motes.push(new Mote());
        if (reduced) { scene(false); p.noLoop(); }       // one still frame, then rest
      };
      p.draw = () => scene(true);
      p.windowResized = () => { p.resizeCanvas(p.windowWidth, p.windowHeight);
        src = p.createVector(p.width * 0.08, -p.height * 0.06); };
    };
  };

  const SKIN = {
    crt: {
      css: `
        body[data-theme="phosphor"] { text-shadow:0 0 1px var(--lapis), 0 0 8px rgba(54,227,160,.38); }
        body[data-theme="phosphor"] .card-title, body[data-theme="phosphor"] h1,
        body[data-theme="phosphor"] h2, body[data-theme="phosphor"] h3 {
          text-shadow:0 0 2px var(--lapis), 0 0 13px rgba(54,227,160,.5); }
        /* z-index 65: above the drawer (50) + its backdrop (60) so the FX land
           on the terminal too, but below menus/modals/toasts (70-100). */
        .crt-fx { position:fixed; inset:0; pointer-events:none; z-index:65; }
        .crt-fx > div { position:absolute; inset:0; }
        .crt-fx .scan { mix-blend-mode:multiply;
          background:repeating-linear-gradient(to bottom,
            rgba(0,0,0,0) 0, rgba(0,0,0,0) 2px, rgba(0,0,0,.18) 3px, rgba(0,0,0,0) 4px); }
        /* curvature via a smooth vignette falloff only — no hard dome edge */
        .crt-fx .vig {
          background:radial-gradient(ellipse 115% 115% at center, transparent 55%, rgba(0,0,0,.62) 100%); }`,
      mount() {
        const fx = document.createElement("div");
        fx.className = "crt-fx";
        fx.innerHTML = '<div class="scan"></div><div class="vig"></div>';
        document.body.appendChild(fx);
        return () => fx.remove();
      },
    },
    flowfield: {
      // canvas sits BEHIND content (z-index:-1); body bg goes transparent for
      // this world so the field shows, with a dark base on the container to
      // avoid a flash before p5 loads. Cards/inputs are made opaque so the field
      // stays strictly behind them. A faint top wash keeps header text legible.
      css: `
        body[data-theme="flow"] { background:transparent;
          /* cards/inputs go barely translucent so the field whispers through */
          --card-bg:rgba(255,255,255,.9); --card-hot:rgba(255,240,244,.92); --input-bg:rgba(255,255,255,.9); }
        body[data-theme="flow"] #modal,
        body[data-theme="flow"] .sess-modal,
        body[data-theme="flow"] .theme-modal,
        body[data-theme="flow"] .act-modal { background:rgba(252,243,246,.93); }
        /* softened, pastel p5 pink for the session/terminal pills */
        body[data-theme="flow"] .pill { background:#ea6e96; color:#fff; }
        body[data-theme="flow"] .pill.active { outline-color:#ea6e96; }
        .flow-fx { position:fixed; inset:0; z-index:-1; pointer-events:none; background:#fcf3f6; }
        .flow-fx canvas { display:block; }
        .flow-fx::after { content:""; position:absolute; inset:0;
          background:linear-gradient(to bottom, rgba(252,243,246,.72), transparent 20%); }`,
      mount(theme) {
        const container = document.createElement("div");
        container.className = "flow-fx";
        document.body.appendChild(container);
        let inst = null, alive = true;
        loadP5().then(() => { if (alive) inst = new p5(makeFlowSketch(theme, container), container); })
          .catch(() => {});
        return () => { alive = false; if (inst) inst.remove(); container.remove(); };
      },
    },
    // generative world: Old Growth. Same behind-content canvas pattern as
    // flowfield — body bg transparent, a dark base on the container to avoid a
    // pre-p5 flash, panels made near-opaque so the motes stay strictly behind
    // text. A faint top wash protects header legibility over the brightest area.
    grove: {
      css: `
        body[data-theme="grove"] { background:transparent;
          --card-bg:rgba(27,34,24,.82); --card-hot:rgba(27,34,24,.92); --input-bg:rgba(27,34,24,.62); }
        body[data-theme="grove"] #modal,
        body[data-theme="grove"] .sess-modal,
        body[data-theme="grove"] .theme-modal,
        body[data-theme="grove"] .act-modal { background:rgba(16,21,14,.95); }
        .grove-fx { position:fixed; inset:0; z-index:-1; pointer-events:none; background:#10150e; }
        .grove-fx canvas { display:block; }
        .grove-fx::after { content:""; position:absolute; inset:0;
          background:linear-gradient(to bottom, rgba(16,21,14,.5), transparent 22%); }`,
      mount(theme) {
        const container = document.createElement("div");
        container.className = "grove-fx";
        document.body.appendChild(container);
        let inst = null, alive = true;
        loadP5().then(() => { if (alive) inst = new p5(makeGroveSketch(theme, container), container); })
          .catch(() => {});
        return () => { alive = false; if (inst) inst.remove(); container.remove(); };
      },
    },
    // material skin (CSS only, no mount): Mac OS X Aqua — gel buttons, glossy
    // panels, pinstripe desktop. Gel recipe adapted from btxx.org / GirlieMac.
    aqua: {
      css: `
        /* pinstripe desktop over a cool blue-grey wash */
        body[data-theme="aqua"] {
          background:
            repeating-linear-gradient(to bottom, rgba(60,90,140,0) 0 1px, rgba(60,90,140,.05) 1px 2px),
            linear-gradient(to bottom, #e8eef7, #d6e0ee);
          background-attachment:fixed;
          --card-bg:#ffffff; --card-hot:#f2f6fc; --input-bg:#ffffff; }
        /* glossy white panels */
        body[data-theme="aqua"] .card {
          border-radius:11px; border:1px solid rgba(120,140,170,.45);
          background:linear-gradient(to bottom, #ffffff 0%, #eef3f9 100%);
          box-shadow:0 6px 16px rgba(40,70,120,.16), inset 0 1px 0 rgba(255,255,255,.95); }
        /* gel base shared by buttons / chips / pills */
        body[data-theme="aqua"] .card button,
        body[data-theme="aqua"] .card .btn,
        body[data-theme="aqua"] .chip,
        body[data-theme="aqua"] #mode-select,
        body[data-theme="aqua"] .pill {
          position:relative; border-radius:999px; overflow:visible;
          box-shadow:inset 0 1px 0 rgba(255,255,255,.9), 0 1px 2px rgba(0,0,0,.14); }
        /* the signature top-half shine */
        body[data-theme="aqua"] .card button::before,
        body[data-theme="aqua"] .card .btn::before,
        body[data-theme="aqua"] .chip::before,
        body[data-theme="aqua"] .pill::before {
          content:""; position:absolute; left:6%; top:1px; width:88%; height:42%;
          border-radius:999px; pointer-events:none;
          background:linear-gradient(to bottom, rgba(255,255,255,.85), rgba(255,255,255,0)); }
        /* graphite (default) gel face */
        body[data-theme="aqua"] .card button,
        body[data-theme="aqua"] .card .btn,
        body[data-theme="aqua"] .chip,
        body[data-theme="aqua"] #mode-select {
          border:1px solid #b6c0cd; color:#2a3543; text-shadow:0 1px 0 rgba(255,255,255,.7);
          background:linear-gradient(to bottom, #ffffff 0, #f1f4f8 48%, #e7ecf2 52%, #dfe6ee 100%); }
        body[data-theme="aqua"] .card button:hover,
        body[data-theme="aqua"] .card .btn:hover,
        body[data-theme="aqua"] .chip:hover {
          color:#1a2330;
          background:linear-gradient(to bottom, #ffffff 0, #f7fafd 48%, #eef3f8 52%, #e6ecf3 100%); }
        /* blue gel: primary actions, active filter chip, session pills */
        body[data-theme="aqua"] .card .b-go,
        body[data-theme="aqua"] .chip.active,
        body[data-theme="aqua"] .pill {
          border:1px solid #2c6098; color:#fff; text-shadow:0 -1px 0 rgba(0,0,0,.3);
          background:linear-gradient(to bottom, #7cc3ff 0, #3f8bd4 48%, #2f78c4 52%, #2d6fb8 100%); }
        /* keep icon-only buttons (favourite star) flat, not blue gels */
        body[data-theme="aqua"] .card .b-fav {
          background:none; border:0; box-shadow:none; }
        body[data-theme="aqua"] .card .b-fav::before { display:none; }
        /* inset Aqua search field */
        body[data-theme="aqua"] input[type=text],
        body[data-theme="aqua"] input[type=search] {
          border-radius:999px; border:1px solid #b6c0cd; background:#fff;
          box-shadow:inset 0 1px 3px rgba(0,0,0,.14); }`,
    },
    // joke world: GeoCities. CSS chrome + mounted decorations (construction
    // banner, marquee, visitor counter) + a glitter cursor trail.
    geocities: {
      css: `
        /* vendored Comic Sans stand-in (Comic Neue, OFL) — the stack must never
           fall through to generic cursive: fontconfig maps that to Noto Nastaliq
           Urdu, whose huge vertical metrics inflated the inputs and knocked
           button text off-centre (Firefox honours the mapping; the phone's
           cursive is Dancing Script — also wrong) */
        @font-face { font-family:"Comic Neue"; font-style:normal; font-weight:400;
          src:url("/static/vendor/comic-neue-latin-400.woff2") format("woff2"); }
        @font-face { font-family:"Comic Neue"; font-style:normal; font-weight:700;
          src:url("/static/vendor/comic-neue-latin-700.woff2") format("woff2"); }
        /* tiled starfield desktop */
        body[data-theme="geocities"] {
          background:
            radial-gradient(1px 1px at 20% 30%, #fff, transparent),
            radial-gradient(1px 1px at 75% 60%, #cfe, transparent),
            radial-gradient(2px 2px at 40% 80%, #fff, transparent),
            radial-gradient(1px 1px at 85% 18%, #ffd, transparent),
            radial-gradient(1px 1px at 55% 45%, #fff, transparent),
            #05010f;
          background-size:170px 170px,210px 210px,250px 250px,190px 190px,230px 230px,auto;
          --card-bg:#160a33; --card-hot:#23114d; --input-bg:#0c0622; }
        /* rainbow WordArt title */
        body[data-theme="geocities"] header h1 {
          background:linear-gradient(90deg,#ff2d95,#ffe600,#39ff14,#00e0ff,#b14bff,#ff2d95);
          -webkit-background-clip:text; background-clip:text; color:transparent;
          -webkit-text-stroke:1px #fff; filter:drop-shadow(2px 2px 0 #000);
          font-weight:bold; }
        /* beveled neon cards */
        body[data-theme="geocities"] .card {
          border:4px ridge #00e0ff; border-radius:0; background:#160a33;
          box-shadow:0 0 12px #ff2d95, inset 0 0 18px rgba(0,224,255,.15); }
        /* loud chunky buttons */
        body[data-theme="geocities"] .card button,
        body[data-theme="geocities"] .card .btn,
        body[data-theme="geocities"] .chip,
        body[data-theme="geocities"] #mode-select,
        body[data-theme="geocities"] .pill {
          border:3px outset #ff2d95; border-radius:0; color:#ffe600;
          background:#3a0d5c; text-shadow:1px 1px 0 #000; font-weight:bold; }
        body[data-theme="geocities"] .card button:hover,
        body[data-theme="geocities"] .card .btn:hover,
        body[data-theme="geocities"] .chip:hover {
          background:#5a149c; color:#39ff14; }
        body[data-theme="geocities"] .chip.active,
        body[data-theme="geocities"] .pill {
          background:#0d3a5c; border-color:#00e0ff; color:#39ff14; }
        /* fixed chrome layer */
        .geo-spark { position:fixed; pointer-events:none; z-index:9999; font-size:1rem;
          animation:geo-fade .7s linear forwards; }
        @keyframes geo-fade { from{opacity:1;transform:scale(1)} to{opacity:0;transform:scale(.3) translateY(7px)} }`,
      mount() {
        // glitter cursor trail (paused over the terminal drawer)
        const sparks = ["✨", "⭐", "🌟", "💫"];
        let last = 0;
        const onMove = (e) => {
          if (e.pointerType && e.pointerType !== "mouse") return;  // no trail on touch scroll
          const now = performance.now();
          if (now - last < 45 || document.body.classList.contains("drawer-open")) return;
          last = now;
          const s = document.createElement("span");
          s.className = "geo-spark";
          s.textContent = sparks[(Math.random() * sparks.length) | 0];
          s.style.left = e.clientX + "px"; s.style.top = e.clientY + "px";
          document.body.appendChild(s);
          setTimeout(() => s.remove(), 700);
        };
        window.addEventListener("pointermove", onMove);
        return () => { window.removeEventListener("pointermove", onMove);
          document.querySelectorAll(".geo-spark").forEach(n => n.remove()); };
      },
    },
    // chrome world: Bliss (Windows XP). Luna widgetry — card heads become blue
    // gradient titlebars, glossy dialog buttons, ONE Start-green primary — over
    // the hill as living wallpaper (raw-canvas: sky, drifting cumulus, field).
    winxp: {
      css: `
        body[data-theme="winxp"] { background:transparent;
          --card-bg:#ece9d8; --card-hot:#f6f4ea; --input-bg:#ffffff; }
        .xp-fx { position:fixed; inset:0; z-index:-1; pointer-events:none;
          background:linear-gradient(180deg,#3d7edb,#7fb2ec 60%,#cfe3f8); }
        .xp-fx canvas { display:block; }
        /* no overflow:hidden — it would clip the claude ▾ dropdown inside the
           card; the titlebar rounds its own top corners to fit instead */
        body[data-theme="winxp"] .card { border-radius:8px 8px 3px 3px;
          border:1px solid #0842a0; outline:0; background:#ece9d8;
          box-shadow:2px 3px 9px rgba(10,30,80,.35); }
        body[data-theme="winxp"] .card .head { margin:-1rem -1.2rem .2rem;
          padding:.42rem .8rem; border-radius:7px 7px 0 0;
          background:linear-gradient(180deg,#5da2f2 0%,#1a63d8 12%,#2a80ec 45%,#0e50b8 100%); }
        body[data-theme="winxp"] .card .head h2 { color:#fff; font-variant:normal;
          text-shadow:1px 1px 1px rgba(0,20,60,.6); }
        body[data-theme="winxp"] .card .head .kind { color:#cfe0ff; }
        body[data-theme="winxp"] .card .head .mono { color:#fff;
          border-color:rgba(255,255,255,.75); background:rgba(255,255,255,.16); }
        body[data-theme="winxp"] .card .head .tglyph { color:#fff; }
        body[data-theme="winxp"] .card .head .b-fav { color:#ffe89a; }
        body[data-theme="winxp"] .card button,
        body[data-theme="winxp"] .card .btn,
        body[data-theme="winxp"] .chip,
        body[data-theme="winxp"] #mode-select,
        body[data-theme="winxp"] .jot-open {
          border-radius:3px; border:1px solid #003c74; color:#1d2b45;
          background:linear-gradient(180deg,#ffffff,#ece9d8 45%,#d8d0bf);
          box-shadow:inset 0 -2px 3px rgba(160,140,100,.35), inset 0 1px 0 #fff; }
        body[data-theme="winxp"] .card button:hover,
        body[data-theme="winxp"] .card .btn:hover,
        body[data-theme="winxp"] .chip:hover,
        body[data-theme="winxp"] .jot-open:hover {
          color:#0a1a35;
          background:linear-gradient(180deg,#ffffff,#f6f2e4 45%,#e6dfcc 100%); }
        body[data-theme="winxp"] .card .b-go { color:#fff; border-color:#2a6e2c;
          background:linear-gradient(180deg,#8adf78,#3a9e3c 55%,#2a7e2c);
          box-shadow:inset 0 -2px 3px rgba(0,60,0,.4), inset 0 1px 0 #b8f0a8; }
        body[data-theme="winxp"] .chip.active,
        body[data-theme="winxp"] .pill { color:#fff; border:1px solid #0842a0;
          background:linear-gradient(180deg,#5da2f2,#1a63d8 50%,#0e50b8); }
        body[data-theme="winxp"] .card .b-fav { background:none; border:0; box-shadow:none; }
        body[data-theme="winxp"] input[type=text],
        body[data-theme="winxp"] input[type=search] {
          border-radius:0; border:1px solid #7f9db9; background:#fff;
          font-style:normal; }
        body[data-theme="winxp"] #modal,
        body[data-theme="winxp"] .sess-modal,
        body[data-theme="winxp"] .theme-modal,
        body[data-theme="winxp"] .act-modal { background:#ece9d8;
          border:1px solid #0842a0; border-radius:8px 8px 3px 3px; }
        /* band heads sit on the bright sky — white ink with a soft shadow */
        body[data-theme="winxp"] .band-head { color:#fff;
          text-shadow:0 1px 2px rgba(10,40,100,.55); }
        body[data-theme="winxp"] .band-hint { color:#e4eefc; }
        body[data-theme="winxp"] .band-head::after { border-color:rgba(255,255,255,.6); }`,
      mount() {
        const box = document.createElement("div");
        box.className = "xp-fx";
        const cv = document.createElement("canvas");
        box.appendChild(cv);
        document.body.appendChild(box);
        const ctx = cv.getContext("2d");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        let clouds = [], raf = 0, last = 0, alive = true;
        const size = () => { cv.width = innerWidth; cv.height = innerHeight; };
        const mkCloud = (init) => { const puffs = [], n = 3 + ((Math.random() * 3) | 0);
          for (let i = 0; i < n; i++) puffs.push({ dx: Math.random() * 2.2 - 1.1,
            dy: Math.random() * .65 - .35, r: .5 + Math.random() * .5 });
          return { x: init ? Math.random() * cv.width : -90,
            y: cv.height * (.05 + Math.random() * .34),
            s: 28 + Math.random() * 34, v: .12 + Math.random() * .2, puffs }; };
        const paint = () => { const w = cv.width, h = cv.height;
          let g = ctx.createLinearGradient(0, 0, 0, h * .8);
          g.addColorStop(0, "#3d7edb"); g.addColorStop(.6, "#7fb2ec"); g.addColorStop(1, "#cfe3f8");
          ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
          for (const c of clouds) for (const pf of c.puffs) {
            const r = c.s * pf.r * 1.5, x = c.x + pf.dx * c.s, y = c.y + pf.dy * c.s;
            const cg = ctx.createRadialGradient(x, y, 0, x, y, r);
            cg.addColorStop(0, "rgba(255,255,255,.95)");
            cg.addColorStop(.55, "rgba(255,255,255,.5)");
            cg.addColorStop(1, "rgba(255,255,255,0)");
            ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); }
          const hy = h * .8;
          g = ctx.createLinearGradient(0, hy - 46, 0, h);
          g.addColorStop(0, "#8ed04e"); g.addColorStop(.45, "#57ab30"); g.addColorStop(1, "#2f7a1e");
          ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(0, hy + 22);
          ctx.bezierCurveTo(w * .3, hy - 40, w * .62, hy - 12, w, hy + 30);
          ctx.lineTo(w, h); ctx.closePath(); ctx.fill();
          const sh = ctx.createRadialGradient(w * .34, hy - 18, 0, w * .34, hy - 18, w * .5);
          sh.addColorStop(0, "rgba(255,255,230,.22)"); sh.addColorStop(1, "rgba(255,255,230,0)");
          ctx.fillStyle = sh; ctx.fillRect(0, hy - 70, w, h - hy + 70); };
        const tick = (t) => { if (!alive) return;
          raf = requestAnimationFrame(tick);
          if (t - last < 33) return;                     // ~30 fps is plenty for clouds
          last = t;
          for (const c of clouds) { c.x += c.v;
            if (c.x - c.s * 2.6 > cv.width) Object.assign(c, mkCloud(false)); }
          paint(); };
        const onResize = () => { size(); paint(); };
        size();
        const n = Math.max(4, Math.min(8, (innerWidth / 240) | 0));
        for (let i = 0; i < n; i++) clouds.push(mkCloud(true));
        paint();
        if (!reduced) raf = requestAnimationFrame(tick);
        addEventListener("resize", onResize);
        return () => { alive = false; cancelAnimationFrame(raf);
          removeEventListener("resize", onResize); box.remove(); };
      },
    },
    // chrome world: Windows 95. Gray #c0c0c0 bevels everywhere — navy gradient
    // titlebars, outset buttons that press inset, sunken inputs — on the flat
    // teal desktop. The dither grain is a one-off generated tile set as the
    // body background image; no live canvas, nothing animates.
    win95: {
      css: `
        body[data-theme="win95"] { background:#008080;
          --card-bg:#c0c0c0; --card-hot:#cbcbc4; --input-bg:#ffffff; }
        body[data-theme="win95"] .card { border-radius:0; background:#c0c0c0;
          border:2px solid; border-color:#fff #404040 #404040 #fff;
          outline:1px solid #000; outline-offset:0;
          box-shadow:3px 3px 0 rgba(0,0,0,.35); }
        body[data-theme="win95"] .card .head { margin:-1rem -1.2rem .2rem;
          padding:.3rem .6rem; background:linear-gradient(90deg,#000080,#1084d0); }
        body[data-theme="win95"] .card .head h2 { color:#fff; font-variant:normal;
          font-size:1rem; }
        body[data-theme="win95"] .card .head .kind { color:#bcd0ee; }
        body[data-theme="win95"] .card .head .mono { color:#fff;
          border-color:rgba(255,255,255,.75); background:rgba(255,255,255,.14); }
        body[data-theme="win95"] .card .head .tglyph { color:#fff; }
        body[data-theme="win95"] .card .head .b-fav { color:#ffe89a; background:none;
          border:0; box-shadow:none; }
        body[data-theme="win95"] .card button,
        body[data-theme="win95"] .card .btn,
        body[data-theme="win95"] .chip,
        body[data-theme="win95"] #mode-select,
        body[data-theme="win95"] .jot-open {
          border-radius:0; background:#c0c0c0;
          border:2px solid; border-color:#fff #404040 #404040 #fff;
          box-shadow:1px 1px 0 #000; }
        body[data-theme="win95"] .card button:hover,
        body[data-theme="win95"] .card .btn:hover,
        body[data-theme="win95"] .chip:hover,
        body[data-theme="win95"] .jot-open:hover { background:#cbcbc4; color:#111; }
        body[data-theme="win95"] .card button:active,
        body[data-theme="win95"] .chip:active {
          border-color:#404040 #fff #fff #404040; box-shadow:none; }
        body[data-theme="win95"] .chip.active {
          border-color:#404040 #fff #fff #404040; background:#d4d0c8; box-shadow:none; }
        body[data-theme="win95"] .pill { border-radius:0; background:#000080; color:#fff;
          border:2px solid; border-color:#fff #404040 #404040 #fff; }
        body[data-theme="win95"] input[type=text],
        body[data-theme="win95"] input[type=search] {
          border-radius:0; background:#fff; font-style:normal;
          border:2px solid; border-color:#404040 #fff #fff #404040; }
        body[data-theme="win95"] #modal,
        body[data-theme="win95"] .sess-modal,
        body[data-theme="win95"] .theme-modal,
        body[data-theme="win95"] .act-modal { border-radius:0; background:#c0c0c0;
          border:2px solid; border-color:#fff #404040 #404040 #fff;
          outline:1px solid #000; outline-offset:0; }
        /* band heads sit on the teal desktop — pale ink reads best there */
        body[data-theme="win95"] .band-head { color:#eef8f8; }
        body[data-theme="win95"] .band-hint { color:#bfe0e0; }
        body[data-theme="win95"] .band-head::after { border-color:rgba(238,248,248,.5); }`,
      mount() {
        const c = document.createElement("canvas");
        c.width = c.height = 96;
        const x = c.getContext("2d");
        x.fillStyle = "#008080"; x.fillRect(0, 0, 96, 96);
        for (let i = 0; i < 180; i++) {
          x.fillStyle = Math.random() < .5 ? "rgba(0,90,90,.4)" : "rgba(46,160,160,.4)";
          x.fillRect((Math.random() * 96) | 0, (Math.random() * 96) | 0, 2, 2);
        }
        const prev = document.body.style.backgroundImage;
        document.body.style.backgroundImage = `url(${c.toDataURL()})`;
        return () => { document.body.style.backgroundImage = prev; };
      },
    },
    // chrome world: Winamp. Brushed near-black steel, gold rails on the card
    // heads, beveled micro-buttons, LCD-green inputs — and the spectrum
    // analyzer breathing along the bottom edge (raw canvas, pseudo-audio).
    winamp: {
      css: `
        body[data-theme="winamp"] { background:#14141e;
          --card-bg:#232330; --card-hot:#2b2b3c; --input-bg:#0a0a12; }
        .amp-fx { position:fixed; left:0; right:0; bottom:0; height:140px;
          z-index:-1; pointer-events:none; }
        .amp-fx canvas { display:block; width:100%; height:100%; }
        body[data-theme="winamp"] .card { border-radius:0; background:#232330;
          border:2px solid; border-color:#3d3d52 #0c0c14 #0c0c14 #3d3d52; outline:0; }
        body[data-theme="winamp"] .card .head { margin:-1rem -1.2rem .2rem;
          padding:.32rem .6rem;
          background:repeating-linear-gradient(0deg,#2e2e40 0 1px,#1c1c28 1px 3px); }
        body[data-theme="winamp"] .card .head h2 { color:#d8a830; font-variant:normal;
          font-size:.85rem; letter-spacing:.18em; text-transform:uppercase; }
        body[data-theme="winamp"] .card .head .kind { color:#8a8aa4; }
        body[data-theme="winamp"] .card button,
        body[data-theme="winamp"] .card .btn,
        body[data-theme="winamp"] .chip,
        body[data-theme="winamp"] #mode-select,
        body[data-theme="winamp"] .jot-open {
          border-radius:0; background:#2a2a3a;
          border:1px solid; border-color:#44445c #101018 #101018 #44445c; }
        body[data-theme="winamp"] .card button:hover,
        body[data-theme="winamp"] .card .btn:hover,
        body[data-theme="winamp"] .chip:hover,
        body[data-theme="winamp"] .jot-open:hover { background:#333346; color:#d8d8e8; }
        body[data-theme="winamp"] .chip.active,
        body[data-theme="winamp"] .pill { background:#d8a830; color:#14141e;
          border:1px solid; border-color:#f0cf70 #8a6a10 #8a6a10 #f0cf70; border-radius:0; }
        body[data-theme="winamp"] input[type=text],
        body[data-theme="winamp"] input[type=search] {
          border-radius:0; background:#0a0a12; color:#3fd858; font-style:normal;
          border:1px solid; border-color:#101018 #44445c #44445c #101018; }
        body[data-theme="winamp"] input[type=search]::placeholder { color:#2a8a3c; }
        body[data-theme="winamp"] #modal,
        body[data-theme="winamp"] .sess-modal,
        body[data-theme="winamp"] .theme-modal,
        body[data-theme="winamp"] .act-modal { border-radius:0; background:#232330;
          border:2px solid; border-color:#3d3d52 #0c0c14 #0c0c14 #3d3d52; }`,
      mount() {
        const box = document.createElement("div");
        box.className = "amp-fx";
        const cv = document.createElement("canvas");
        box.appendChild(cv);
        document.body.appendChild(box);
        const ctx = cv.getContext("2d");
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        let bars = [], peaks = [], t = 6, raf = 0, last = 0, alive = true;
        const size = () => { cv.width = box.clientWidth || innerWidth;
          cv.height = box.clientHeight || 140;
          const n = Math.max(24, Math.min(64, (cv.width / 26) | 0));
          bars = new Array(n).fill(.05); peaks = new Array(n).fill(.1); };
        const level = (i, n) => { const x = i / n;
          const v = .5 + .5 * Math.sin(t * 2.1 + x * 9) * Math.sin(t * 1.3 + x * 4.2)
            + .35 * Math.sin(t * 3.7 + x * 17) + .18 * Math.sin(t * .9 + x * 29);
          return Math.min(1, Math.max(.03, v * .6 * (1 - x * .3))); };
        const colorOf = f => f < .5 ? "#3fd858" : f < .8 ? "#d8a830" : "#e05038";
        const paint = (mv) => { const w = cv.width, h = cv.height, n = bars.length, bw = w / n;
          ctx.clearRect(0, 0, w, h);
          for (let i = 0; i < n; i++) { if (mv) {
              const tv = level(i, n); bars[i] += (tv - bars[i]) * .3;
              if (bars[i] > peaks[i]) peaks[i] = bars[i]; else peaks[i] -= .006; }
            const bh = bars[i] * (h - 8), segs = Math.max(1, (bh / 7) | 0);
            ctx.globalAlpha = .75;
            for (let s = 0; s < segs; s++) { ctx.fillStyle = colorOf(s / ((h - 8) / 7));
              ctx.fillRect(i * bw + 1.5, h - (s + 1) * 7 + 1, bw - 3, 5); }
            ctx.globalAlpha = 1; ctx.fillStyle = colorOf(peaks[i]);
            ctx.fillRect(i * bw + 1.5, h - peaks[i] * (h - 8) - 3, bw - 3, 2.5); } };
        const tick = (ts) => { if (!alive) return;
          raf = requestAnimationFrame(tick);
          if (ts - last < 33) return;
          last = ts; t += .03; paint(true); };
        const onResize = () => { size(); paint(false); };
        size();
        if (reduced) { for (let k = 0; k < 40; k++) { t += .03; paint(true); } }
        else raf = requestAnimationFrame(tick);
        addEventListener("resize", onResize);
        return () => { alive = false; cancelAnimationFrame(raf);
          removeEventListener("resize", onResize); box.remove(); };
      },
    },
  };
  const skinStyle = document.createElement("style");
  skinStyle.textContent = Object.values(SKIN).map(s => s.css || "").join("\n");
  document.head.appendChild(skinStyle);
  let skinTeardown = null;

  const apply = t => {
    if (!THEME[t]) t = "codex";
    activeTheme = t;
    if (t === "codex") delete document.body.dataset.theme;
    else document.body.dataset.theme = t;
    // swap the skin overlay: tear down the previous, mount the new world's
    if (skinTeardown) { skinTeardown(); skinTeardown = null; }
    const sk = THEME[t].skin;
    if (sk && SKIN[sk] && SKIN[sk].mount) skinTeardown = SKIN[sk].mount(THEME[t]);
    // the drawer + #dterm padding frame the terminal — match its bg so there's
    // no off-theme dark border around the canvas
    document.documentElement.style.setProperty("--term-bg", THEME[t].term.bg);
    localStorage.setItem("hubTheme", t);
    document.querySelectorAll(".theme-card").forEach(c =>
      c.classList.toggle("current", c.dataset.theme === t));
    // re-skin every live terminal to match (xterm v5: options.theme setter)
    const xt = xtermTheme(t);
    sessions.forEach(s => {
      try { s.term.options.theme = xt; s.term.refresh(0, s.term.rows - 1); } catch (e) {}
    });
  };
  const pStyle = document.createElement("style");
  pStyle.textContent = `
    #theme-btn { position:fixed; top:.9rem; right:1.1rem; z-index:45;
      background:var(--paper, #f6edd6); border:1px solid var(--ink-soft);
      border-radius:50%; width:2.4rem; height:2.4rem; cursor:pointer;
      box-shadow:1px 2px 7px rgba(67,51,28,.3); padding:0;
      transition:right .22s ease;
      display:flex; align-items:center; justify-content:center; }
    #theme-btn:hover { background:var(--ink); color:var(--parchment); border-color:var(--ink); }
    /* slide the palette button left of the side drawer so it stays reachable;
       when the drawer is full-window the terminal owns the screen — hide it */
    body.drawer-open #theme-btn { right:calc(var(--drawer-w) + 1.1rem); }
    body.drawer-full #theme-btn { display:none; }
    .theme-overlay { position:fixed; inset:0; background:var(--scrim);
      z-index:80; display:flex; align-items:flex-start; justify-content:center;
      padding-top:14vh; }
    .theme-overlay[hidden] { display:none; }
    .theme-modal { background:var(--parchment); border:1.5px solid var(--ink-soft);
      outline:1px solid var(--ink-faint); outline-offset:4px; border-radius:2px;
      padding:1rem 1.2rem; box-shadow:3px 5px 18px rgba(40,30,15,.45);
      display:flex; flex-direction:column; gap:.7rem; }
    .theme-modal h3 { margin:0; font-size:1rem; font-weight:600;
      font-variant:small-caps; letter-spacing:.08em; color:var(--ink); }
    .theme-modal .m-head { display:flex; align-items:center; gap:.5rem; }
    .theme-modal .m-head h3 { flex:1; }
    .theme-modal .t-close { border:0; background:transparent; color:var(--ink-soft);
      cursor:pointer; padding:.2rem .3rem; font:inherit; }
    .theme-modal .t-close:hover { color:var(--sanguine); background:transparent; }
    /* fixed 5 columns so 10 themes lay out as an even 5×2 grid */
    .theme-row { display:grid; grid-template-columns:repeat(5, 1fr); gap:.9rem; }
    @media (max-width:600px) { .theme-row { grid-template-columns:repeat(3, 1fr); } }
    .theme-overlay { padding-left:.6rem; padding-right:.6rem; }
    .theme-modal { width:min(52rem, 94vw); box-sizing:border-box; max-height:82vh; overflow:auto; }
    /* cards must be theme-idempotent: neutral chrome, and explicit overrides
       for every global button style (hover bg, padding, small-caps, border) */
    /* override the global button rule (inline-flex/row + align:center), which
       otherwise lays the swatch and name side by side and leaves the name strip
       floating in the modal's background. Stack them so the whole card is its
       own theme, top to bottom. */
    .theme-card { width:auto; border:1.5px solid rgba(128,128,128,.45); border-radius:3px;
      overflow:hidden; cursor:pointer; padding:0;
      display:flex; flex-direction:column; align-items:stretch;
      font:inherit; font-variant:normal; letter-spacing:normal;
      text-align:center; box-sizing:border-box; line-height:1.4; }
    .theme-card:hover { color:inherit;
      box-shadow:0 3px 10px rgba(0,0,0,.45); transform:translateY(-1px);
      border-color:rgba(128,128,128,.8); }
    .theme-card.current { border-color:transparent; outline:2.5px solid rgba(128,128,128,.85); }
    .theme-card.current .t-name::before { content:"✓ "; }
    .theme-card .swatch { height:5.2rem; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:.45rem; }
    .theme-card .aa { font-size:1.5rem; font-weight:600; }
    .theme-card .dots { display:flex; gap:.35rem; }
    .theme-card .dots span { width:.7rem; height:.7rem; border-radius:50%; display:inline-block; }
    .theme-card .t-name { display:block; padding:.3rem 0; font-variant:small-caps;
      letter-spacing:.06em; font-size:.85rem; color:var(--ink); }
    .theme-section { margin:1rem 0 .2rem; padding-top:.75rem; font-variant:small-caps;
      letter-spacing:.12em; font-size:.78rem; color:var(--ink-soft);
      border-top:1px solid var(--ink-faint); }
    /* shelf glyph style: two option cards previewing REAL marks off the shelf */
    .glyph-row { display:flex; gap:.9rem; flex-wrap:wrap; }
    .glyph-card { display:flex; flex-direction:column; align-items:center; gap:.55rem;
      border:1.5px solid rgba(128,128,128,.45); border-radius:3px; cursor:pointer;
      background:var(--card-bg); color:var(--ink); font:inherit; font-variant:normal;
      letter-spacing:normal; padding:.8rem 1.1rem .55rem; min-width:11rem; }
    .glyph-card:hover { border-color:rgba(128,128,128,.8); color:var(--ink);
      background:var(--card-hot); box-shadow:0 3px 10px rgba(0,0,0,.3);
      transform:translateY(-1px); }
    .glyph-card.current { border-color:transparent; outline:2.5px solid rgba(128,128,128,.85); }
    .glyph-card.current .g-name::before { content:"✓ "; }
    .glyph-card .g-strip { display:flex; align-items:center; gap:.5rem; }
    .glyph-card .g-strip .tglyph { display:block; width:1.6rem; height:1.6rem; }
    .glyph-card .g-strip .mono { display:flex; }
    .glyph-card .g-strip .glyph-img { display:block; }
    .glyph-card .g-name { font-variant:small-caps; letter-spacing:.06em;
      font-size:.82rem; }
    .glyph-card .g-sub { font-style:italic; font-size:.72rem; color:var(--ink-soft);
      margin-top:-.35rem; }
    .theme-lab-link { align-self:flex-start; margin-top:.5rem; font-variant:small-caps;
      letter-spacing:.1em; font-size:.74rem; color:var(--ink-soft); text-decoration:none;
      border-bottom:1px dotted var(--ink-faint); padding-bottom:1px; }
    .theme-lab-link:hover { color:var(--ink); border-color:var(--ink-soft); }`;
  document.head.appendChild(pStyle);

  const overlay = document.createElement("div");
  overlay.className = "theme-overlay";
  overlay.hidden = true;
  const modal = document.createElement("div");
  modal.className = "theme-modal";
  modal.innerHTML = '<div class="m-head"><h3>themes</h3>'
    + '<button class="t-close" title="close">' + ICON_CLOSE + "</button></div>";
  // every part of a card renders in ITS theme (bg, ink, font) — not the active
  // one; the card's own bg fills behind the stack
  const makeCard = (k) => {
    const t = THEME[k];
    const dots = [t.lapis, t.sanguine, t.verdigris, t.ochre];
    const card = document.createElement("button");
    card.className = "theme-card";
    card.dataset.theme = k;
    card.style.background = t.bg;
    card.innerHTML = `
      <span class="swatch" style="background:${t.bg}; font-family:${t.font}">
        <span class="aa" style="color:${t.ink}">Aa</span>
        <span class="dots">${dots.map(c => `<span style="background:${c}"></span>`).join("")}</span>
      </span>
      <span class="t-name" style="background:${t.bg}; color:${t.ink};
        font-family:${t.font}; border-top:1px solid rgba(128,128,128,.35)">${t.name}</span>`;
    card.onclick = () => apply(k);
    return card;
  };
  // plain palettes up top; generative "worlds" (themes carrying a skin) get
  // their own section at the bottom
  const plain = THEME_ORDER.filter(k => !THEME[k].skin);
  const worlds = THEME_ORDER.filter(k => THEME[k].skin);
  const row = document.createElement("div");
  row.className = "theme-row";
  plain.forEach(k => row.appendChild(makeCard(k)));
  modal.appendChild(row);
  if (worlds.length) {
    const sec = document.createElement("div");
    sec.className = "theme-section";
    sec.textContent = "special · worlds";
    modal.appendChild(sec);
    const wrow = document.createElement("div");
    wrow.className = "theme-row";
    worlds.forEach(k => wrow.appendChild(makeCard(k)));
    modal.appendChild(wrow);
  }
  // shelf preferences ride along in the theme modal: per-project marks
  // (monogram/icon, the default) vs the hand-inked per-type glyphs, shown as
  // two option cards previewing marks cloned from the LIVE shelf — the sample
  // is by construction what the grid will look like. Persists per device in
  // localStorage; the CSS swap (body.type-glyphs) lives in the app.py template.
  const gsec = document.createElement("div");
  gsec.className = "theme-section";
  gsec.textContent = "shelf · project marks";
  modal.appendChild(gsec);
  const applyGlyphs = () => {
    const mode = localStorage.getItem("hubGlyphs") === "type" ? "type" : "project";
    document.body.classList.toggle("type-glyphs", mode === "type");
    document.querySelectorAll(".glyph-card").forEach(c =>
      c.classList.toggle("current", c.dataset.mode === mode));
  };
  const sampleMarks = mode => {
    const out = [], seen = new Set();
    for (const card of document.querySelectorAll("#grid .card")) {
      const el = card.querySelector(mode === "type" ? ".glyph .tglyph"
                                                    : ".glyph :not(.tglyph)");
      // one of each: distinct types for the inked icons, distinct pigments
      // (or an icon file) for the project marks — a fair spread of each style
      const key = mode === "type" ? card.dataset.type
                : el?.className + (el?.tagName === "IMG" ? el.src : "");
      if (!el || seen.has(key)) continue;
      seen.add(key);
      out.push(el.cloneNode(true));
      if (out.length === 3) break;
    }
    return out;
  };
  const mkGlyphCard = (mode, label, sub) => {
    const c = document.createElement("button");
    c.className = "glyph-card";
    c.dataset.mode = mode;
    const strip = document.createElement("span");
    strip.className = "g-strip";
    strip.append(...sampleMarks(mode));
    const name = document.createElement("span");
    name.className = "g-name";
    name.textContent = label;
    const s = document.createElement("span");
    s.className = "g-sub";
    s.textContent = sub;
    c.append(strip, name, s);
    c.onclick = () => { localStorage.setItem("hubGlyphs", mode); applyGlyphs(); };
    return c;
  };
  const grow = document.createElement("div");
  grow.className = "glyph-row";
  grow.append(
    mkGlyphCard("project", "per project", "its icon, or an inked monogram"),
    mkGlyphCard("type", "per category", "one mark for each kind — site, app, code…"));
  modal.appendChild(grow);
  applyGlyphs();

  // link to the draft sandbox — where worlds are prototyped before they ship here
  const labLink = document.createElement("a");
  labLink.className = "theme-lab-link";
  labLink.href = "/static/theme-worlds.html";
  labLink.target = "_blank"; labLink.rel = "noopener";
  labLink.textContent = "theme lab ↗";
  labLink.title = "experiment with draft worlds before they ship here";
  modal.appendChild(labLink);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const btn = document.createElement("button");
  btn.id = "theme-btn";
  btn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true" style="width:1.25em;height:1.25em">'
    + '<path d="M12 22a10 10 0 1 1 10-10c0 1.7-1.3 3-3 3h-2.6a2 2 0 0 0-1.5 3.3'
    + 'c.3.4.5.8.5 1.2a2.3 2.3 0 0 1-2.4 2.5Z"/>'
    + '<circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/>'
    + '<circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>'
    + '<circle cx="15" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>'
    + '<circle cx="17.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/></svg>';
  btn.title = "themes";
  btn.onclick = () => { overlay.hidden = !overlay.hidden; };
  document.body.appendChild(btn);

  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.hidden = true; });
  modal.querySelector(".t-close").onclick = () => { overlay.hidden = true; };
  document.addEventListener("keydown", e => { if (e.key === "Escape") overlay.hidden = true; });

  // resolveTheme (themes.js) maps renamed/unknown keys to a current one
  apply(resolveTheme(localStorage.getItem("hubTheme") || "codex"));
})();


// --- activity panel (T42c): per-project git status dashboard ----------------
// "what needs committing / pushing", + recent commits (the data a reconcile
// pass reads). Injected from JS so it ships on refresh, no service restart.
(() => {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const style = document.createElement("style");
  style.textContent = `
    .act-overlay { position:fixed; inset:0; background:var(--scrim); z-index:72;
      display:flex; align-items:flex-start; justify-content:center; padding:9vh .6rem 0; }
    .act-overlay[hidden] { display:none; }
    .act-modal { width:min(640px,94vw); max-height:80vh; overflow:auto; box-sizing:border-box;
      background:var(--parchment); border:1.5px solid var(--ink-soft); outline:1px solid var(--ink-faint);
      outline-offset:4px; border-radius:2px; padding:1rem 1.2rem; box-shadow:3px 5px 18px rgba(40,30,15,.45); }
    .act-modal .m-head { display:flex; align-items:center; gap:.5rem; margin-bottom:.6rem; }
    .act-modal h3 { margin:0; flex:1; font-size:1rem; font-weight:600; font-variant:small-caps;
      letter-spacing:.08em; color:var(--ink); }
    .act-row { padding:.5rem .15rem; border-bottom:1px dotted rgba(156,135,95,.4); }
    .act-row.clean { opacity:.5; }
    .act-row .top { display:flex; align-items:center; gap:.5rem; }
    .act-row .pname { font-variant:small-caps; letter-spacing:.04em; font-weight:600; color:var(--ink); }
    .act-row .when { color:var(--ink-faint); font-size:.76rem; margin-left:auto; white-space:nowrap; }
    .act-badge { font-size:.64rem; font-variant:small-caps; letter-spacing:.04em; border-radius:999px;
      padding:.05rem .45rem; color:var(--parchment); }
    .act-badge.push { background:var(--sanguine); }
    .act-badge.dirty { background:var(--ochre); }
    .act-badge.new { background:var(--lapis); }
    .act-since { color:var(--ink-faint); font-size:.78rem; font-style:italic;
      margin:-.2rem 0 .7rem; display:flex; align-items:center; gap:.6rem; }
    .act-reconcile { font:inherit; font-size:.76rem; font-variant:small-caps; letter-spacing:.05em;
      padding:.22rem .6rem; border:1px solid var(--lapis); color:var(--lapis); background:transparent;
      border-radius:2px; cursor:pointer; margin-left:auto; }
    .act-reconcile:hover { background:var(--lapis); color:var(--parchment); }
    .act-row .commits { margin:.3rem 0 0 .25rem; font-size:.76rem; color:var(--ink-soft);
      font-family:"JetBrains Mono","Noto Sans Mono",monospace; }
    .act-row .commits div { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .act-foot { margin-top:.7rem; font-size:.8rem; font-style:italic; color:var(--ink-soft); }`;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.className = "act-overlay";
  overlay.hidden = true;
  const modal = document.createElement("div");
  modal.className = "act-modal";
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") overlay.hidden = true; });

  async function open() {
    overlay.hidden = false;
    modal.innerHTML = `<div class="m-head"><h3>⟳ git activity</h3>`
      + `<button class="del" title="close">${ICON_CLOSE}</button></div>`
      + `<div class="act-list">loading…</div>`;
    modal.querySelector(".del").onclick = () => { overlay.hidden = true; };
    let payload = {};
    try { payload = await (await fetch("/api/activity")).json(); } catch (e) {}
    // shape (T42d): {last_reconcile, projects:[...]} — tolerate the old bare array
    const data = Array.isArray(payload) ? payload : (payload.projects || []);
    const marker = Array.isArray(payload) ? null : payload.last_reconcile;
    const markerMs = marker ? marker * 1000 : 0;

    // "since last reconcile" line + the bump button
    const since = document.createElement("div");
    since.className = "act-since";
    const when = markerMs
      ? new Date(markerMs).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
      : null;
    since.innerHTML = `<span>${when ? "since last reconcile · " + esc(when) : "never reconciled yet"}</span>`
      + `<button class="act-reconcile" title="stamp now as reconciled — resets the “new” counts">mark reconciled</button>`;
    since.querySelector(".act-reconcile").onclick = async () => {
      try { await fetch("/api/reconcile", { method: "POST" }); } catch (e) {}
      open();  // re-fetch so the counts reset
    };
    modal.insertBefore(since, modal.querySelector(".act-list"));

    const list = modal.querySelector(".act-list");
    list.innerHTML = "";
    if (!data.length) { list.textContent = "no git projects found."; return; }
    data.forEach(p => {
      const fresh = p.new_since_reconcile || 0;
      const clean = !fresh && !p.ahead && !p.dirty && !p.no_upstream;
      const row = document.createElement("div");
      row.className = "act-row" + (clean ? " clean" : "");
      const badges = [];
      if (fresh) badges.push(`<span class="act-badge new">${fresh} new</span>`);
      if (p.ahead) badges.push(`<span class="act-badge push">↑${p.ahead} unpushed</span>`);
      if (p.no_upstream) badges.push(`<span class="act-badge push">↑ never pushed</span>`);
      if (p.dirty) badges.push(`<span class="act-badge dirty">✱ uncommitted</span>`);
      const last = p.recent && p.recent[0] ? esc(p.recent[0].when) : "";
      const commits = (p.recent || []).slice(0, 4).map(c => `<div>${esc(c.subject)}</div>`).join("");
      row.innerHTML = `<div class="top"><span class="pname">${esc(disp(p.name))}</span>`
        + badges.join(" ") + `<span class="when">${last}</span></div>`
        + `<div class="commits">${commits}</div>`;
      list.appendChild(row);
    });
    const foot = document.createElement("p");
    foot.className = "act-foot";
    foot.textContent = "● new since reconcile · ↑ unpushed · ✱ uncommitted. Ask Claude to “reconcile” — it reads these commits to propose to-do/idea updates, then bumps the marker.";
    modal.appendChild(foot);
  }
  window.openActivity = open;

  // trigger in the controls row, next to ❧ chats
  const btn = document.createElement("button");
  btn.className = "jot-open";
  btn.id = "act-open";
  btn.innerHTML = `${ICON_REATTACH} activity`;
  btn.title = "git activity — unpushed / uncommitted across projects";
  btn.onclick = open;
  const chats = document.getElementById("sess-open");
  if (chats) chats.after(btn); else document.querySelector(".controls") && document.querySelector(".controls").appendChild(btn);
})();

// --- mobile back button: close the topmost overlay before leaving (idea 24) ---
// Fully centralized — keeps ONE history entry armed while anything is open; the
// Android/browser back button fires popstate, which closes the topmost layer
// instead of exiting. No rewiring of the individual open/close paths (so they
// can't desync): a MutationObserver re-arms/disarms the guard whenever an
// overlay's `hidden` attribute or the drawer's body class changes.
(() => {
  // open dismissible layers, TOPMOST FIRST (by z-index), each with how to close
  // it: lightbox(200) > theme(80) > act(72) > sessions(70) > jot/inbox(60) >
  // terminal drawer(50; minimise = non-destructive, the pty session lives on).
  const topClosers = () => {
    const out = [], vis = el => el && !el.hidden;
    const lb = document.getElementById("lightbox");      if (vis(lb)) out.push(closeLightbox);
    const th = document.querySelector(".theme-overlay");  if (vis(th)) out.push(() => { th.hidden = true; });
    const ac = document.querySelector(".act-overlay");    if (vis(ac)) out.push(() => { ac.hidden = true; });
    const ss = document.querySelector(".sess-overlay");
    if (vis(ss)) out.push(() => (window.closeSessions ? window.closeSessions() : (ss.hidden = true)));
    const jot = document.getElementById("overlay");      if (vis(jot)) out.push(closeJot);
    if (document.body.classList.contains("drawer-open"))
      out.push(() => { minimizeDrawer(); document.body.classList.remove("drawer-full"); });
    return out;
  };

  let armed = false, handling = false, suppress = false;
  const sync = () => {
    const open = topClosers().length > 0;
    if (open && !armed) { armed = true; history.pushState({ hubOverlay: 1 }, ""); }
    else if (!open && armed && !handling) {
      // everything was closed via the UI — silently discard our guard entry so
      // the next back press leaves the app (no dead/no-op back press).
      armed = false; suppress = true; history.back();
    }
  };

  window.addEventListener("popstate", () => {
    if (suppress) { suppress = false; return; }   // our own guard-unwind — ignore
    const closers = topClosers();
    if (closers.length) {
      handling = true;
      closers[0]();          // close the topmost layer…
      handling = false;
      armed = false;         // …the guard entry was consumed by this back…
      sync();                // …re-arm if layers remain underneath.
    } else {
      armed = false;         // nothing to close → let the navigation stand
    }
  });

  // re-sync on any overlay show/hide (`hidden`) or drawer open/close (body class)
  new MutationObserver(sync).observe(document.body,
    { attributes: true, attributeFilter: ["hidden"], subtree: true });
  new MutationObserver(sync).observe(document.body,
    { attributes: true, attributeFilter: ["class"] });
})();

// --- tap-driven .menu dropdowns on hover-less devices ------------------------
// The dropdowns reveal on :hover, which a phone cannot do: a tap instead fires
// the trigger's OWN onclick (openDrawer) and the ▾ menu stays unreachable. The
// mode picker only seemed to work because its trigger has no click action, so
// the tap did nothing but raise sticky hover. Here a tap opens the menu the
// caret promises; the direct action lives on as that menu's first item.
// Transient like the row ⋯ menu — any outside tap or Esc dismisses it — so it
// deliberately stays out of the back-button's topClosers list.
(() => {
  if (matchMedia("(hover: hover)").matches) return;   // desktop keeps hover

  const style = document.createElement("style");
  // outrank app.py's `.menu:hover .menu-items` (same specificity otherwise):
  // sticky hover must not leave a menu hanging open after the tap.
  style.textContent = `
    body .menu:hover > .menu-items { display:none; }
    body .menu.open > .menu-items { display:flex; }`;
  document.head.appendChild(style);

  const closeMenus = except =>
    document.querySelectorAll(".menu.open")
      .forEach(m => { if (m !== except) m.classList.remove("open"); });

  document.addEventListener("click", e => {
    const trigger = e.target.closest(".menu > button");
    if (!trigger) { closeMenus(null); return; }       // tap outside → dismiss
    const menu = trigger.parentElement;
    closeMenus(menu);
    if (!menu.classList.contains("open")) {
      menu.classList.add("open");
      menu.querySelector(".menu-items").classList.toggle("up",   // same flip the
        menu.getBoundingClientRect().bottom + 175 > window.innerHeight);
    } else {
      menu.classList.remove("open");                 // second tap folds it away
    }
    e.preventDefault();
    e.stopPropagation();       // …so the trigger's own onclick never fires here
  }, true);                    // capture: beat the inline onclick to the event

  // an item's own onclick runs (bubble phase), then the menu folds away
  document.addEventListener("click", e => {
    if (e.target.closest(".menu-items")) closeMenus(null);
  });
  document.addEventListener("keydown",
    e => { if (e.key === "Escape") closeMenus(null); });
})();

// --- images into a chat ------------------------------------------------------
// An image cannot travel down a pty: the terminal carries bytes, so pasting one
// into the drawer had nothing to become (only a *path* on the clipboard ever
// worked). Same trick the jot sender uses: upload the image, then paste the
// saved file's path into the chat and let claude read it off disk. Nothing is
// submitted — you still type the question around the path and press enter.
// Reaches the phone too, where there was no route at all: the ⨍ header button
// opens the gallery/camera picker.
(() => {
  const ATTACH_DIR = "~/Projects/humble-hub/data/attachments";
  const CLIP = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d='
    + '"M20 11.5l-8.2 8.2a5 5 0 0 1-7.07-7.07l8.49-8.49a3.2 3.2 0 0 1 4.53 4.53'
    + 'l-8.49 8.49a1.4 1.4 0 0 1-1.98-1.98l7.6-7.6"/></svg>';

  // → true when we took the images (so the caller can swallow the event)
  async function attachToChat(files) {
    const imgs = [...files].filter(f => f.type.startsWith("image/"));
    if (!imgs.length) return false;
    const s = sessions.get(active);
    if (!s || s.ws.readyState > 1) {
      hubToast("no live chat to attach to — open one first");
      return true;
    }
    hubToast(imgs.length > 1 ? `uploading ${imgs.length} images…` : "uploading image…");
    const ids = await uploadFiles(imgs);          // normalises HEIC, strips EXIF
    if (!ids.length) return true;                 // uploadFiles already alerted
    // paths only: the wording around them is yours to type
    injectIntoSession(s, ids.map(id => `${ATTACH_DIR}/${id}`).join(" ") + " ");
    hubToast(ids.length > 1 ? "image paths pasted — add your question, then enter"
                            : "image path pasted — add your question, then enter");
    return true;
  }

  // a hidden picker, reused: on the phone this is the gallery/camera sheet
  const picker = document.createElement("input");
  picker.type = "file"; picker.accept = "image/*"; picker.multiple = true;
  picker.id = "chat-attach";        // distinct from the jots' own file inputs
  picker.hidden = true;
  picker.onchange = async () => {
    await attachToChat(picker.files);
    picker.value = "";                  // let the same image be picked again
  };
  document.body.appendChild(picker);

  const head = document.querySelector("#drawer .d-head");
  if (head) {
    const btn = document.createElement("button");
    btn.innerHTML = CLIP;
    btn.title = "attach an image to this chat";
    btn.onclick = () => picker.click();
    head.insertBefore(btn, head.querySelector("button"));   // before minimise
  }

  const drawer = document.getElementById("drawer");
  if (drawer) {
    drawer.addEventListener("dragover", e => {
      if (![...e.dataTransfer.types].includes("Files")) return;
      e.preventDefault();
      drawer.classList.add("drop-hot");
    });
    drawer.addEventListener("dragleave", e => {
      if (e.target === drawer) drawer.classList.remove("drop-hot");
    });
    drawer.addEventListener("drop", async e => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      drawer.classList.remove("drop-hot");
      await attachToChat(e.dataTransfer.files);
    });
  }

  // paste: only images are ours — a text paste stays xterm's business
  document.addEventListener("paste", async e => {
    if (!e.clipboardData || !e.clipboardData.files.length) return;
    const overlay = document.getElementById("overlay");
    const inDrawer = e.target.closest && e.target.closest("#drawer");
    const loose = document.body.classList.contains("drawer-open")
      && (!overlay || overlay.hidden);          // a jot modal keeps its own paste
    if (!inDrawer && !loose) return;
    if (await attachToChat(e.clipboardData.files)) e.preventDefault();
  }, true);

  const style = document.createElement("style");
  style.textContent = `
    /* a drop target you cannot see is a drop target you will not use */
    #drawer.drop-hot { outline:2px dashed var(--verdigris); outline-offset:-6px; }`;
  document.head.appendChild(style);
})();

// --- mark the open chat as unfinished, from the drawer head -----------------
// The moment you know a session won't wrap up today, the chat is already open —
// so the flag belongs beside ⤢ / minimise / close, not only in the conversation
// list. Same single flag (notes.wip, keyed by session id); the list stays the
// place you FIND marked chats days later, this is the place you SET one.
(() => {
  const head = document.querySelector("#drawer .d-head");
  if (!head) return;

  const style = document.createElement("style");
  style.textContent = `
    /* ochre when set — the same "you said so" pigment as the ★ and the
       conversation-list flag, so one colour keeps one meaning */
    #d-wip.on { color:var(--ochre); }
    /* not-allowed, not default: the button is visibly present but inert here,
       and a plain arrow reads as "nothing happened" when you click it */
    #d-wip[disabled] { opacity:.35; cursor:not-allowed; }
    #d-wip[disabled]:hover { background:none; color:inherit; }`;
  document.head.appendChild(style);

  const btn = document.createElement("button");
  btn.id = "d-wip";
  // a hollow / filled circle rather than a glyph with its own opinion
  btn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="7"/></svg>';
  head.insertBefore(btn, head.querySelector("a, button"));   // before ⤢

  window.syncDrawerWip = function () {
    const s = sessions.get(active);
    const sid = s && s.sid;
    const on = sid && (notes.wip || []).includes(sid);
    btn.classList.toggle("on", !!on);
    btn.querySelector("svg").style.fill = on ? "currentColor" : "none";
    btn.disabled = !sid;
    // one message for every unknown-id case: already running before the hub
    // named ids, reattached elsewhere, or opened through claude's own resume
    // picker (where claude, not the hub, chose the conversation)
    btn.title = !sid
      ? "the hub can't tell which conversation this is — mark it from the "
        + "conversation list (chats opened from there, or started fresh, work here)"
      : on ? "marked unfinished — click to clear"
           : "mark unfinished: keeps this chat at the top of the conversation list";
  };

  btn.onclick = () => {
    const s = sessions.get(active);
    if (!s || !s.sid) return;
    toggleWip(s.sid);
    hubToast((notes.wip || []).includes(s.sid)
      ? "marked unfinished — it stays on top of the conversation list"
      : "mark cleared");
  };

  syncDrawerWip();
})();
