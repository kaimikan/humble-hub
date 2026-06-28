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
      m.getBoundingClientRect().bottom + 140 > window.innerHeight);
  });
});

// --- notes & to-dos -----------------------------------------------------------

let notes = { todos: [], ideas: [] };

async function loadNotes() {
  notes = await (await fetch("/api/notes")).json();
  renderNotes();
}

let saveTimer = null;
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fetch("/api/notes", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(notes),
  }), 400);
}

// --- favourites (idea #6): ★ pins a project to the top of the shelf; stored
// in notes.json (same doc as the jots) so it's shared across phone + laptop.
function reorderCards() {
  const grid = document.querySelector(".grid");
  if (!grid) return;
  const favs = new Set(notes.favorites || []);
  [...grid.querySelectorAll(".card")].sort((a, b) => {
    const fa = favs.has(a.dataset.name), fb = favs.has(b.dataset.name);
    if (fa !== fb) return fa ? -1 : 1;            // favourites first…
    return a.dataset.name.localeCompare(b.dataset.name); // …then alphabetical
  }).forEach(c => grid.appendChild(c));
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

// done/not-done filter for the to-do list (ideas have no done state).
// Defaults to "active" — finished items are the least interesting at a glance.
let todoFilter = "active";
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

// project filter (T42): jots can be tagged with a project; filter to one
let jotProject = "";
function matchesJotProject(item) { return !jotProject || item.project === jotProject; }
function setJotProject(p) { jotProject = (jotProject === p ? "" : p); renderNotes(); }
// projects with items in the CURRENT view (kind + the to-do status filter) —
// the filter only offers what's actually there to filter to
function filterProjects() {
  return [...new Set(notes[jotKind]
    .filter(it => matchesTodoFilter(jotKind, it))
    .map(i => i.project).filter(Boolean))].sort();
}

function refreshProjectFilter() {
  const btn = document.getElementById("jot-project-btn");
  if (!btn) return;
  const scoped = filterProjects();
  // drop a stale selection only when the current list has no such project at all
  if (jotProject && !notes[jotKind].some(i => i.project === jotProject)) jotProject = "";
  btn.style.display = (scoped.length || jotProject) ? "" : "none";
  btn.querySelector(".lbl").textContent = jotProject || "all projects";
}

// surface the inherited project in the add-input placeholder, so adding an item
// while a project filter is active visibly tags it
function updateAddHints() {
  const sfx = jotProject ? ` → ${jotProject}` : "";
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
        box.onchange = () => { item.done = box.checked; renderNotes(); saveNotes(); };
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
  else delete item.done; // ideas carry no done state
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
        () => { item.done = !item.done; renderNotes(); saveNotes(); });
    add("→ make idea", () => convertItem("todos", idx()));
  } else {
    add("→ make to-do", () => convertItem("ideas", idx()));
  }
  add(item.project ? `project: ${item.project} ▸` : "set project ▸",
      () => openProjectPicker(item, r));
  add(item.images && item.images.length ? "attach more images" : "attach image",
      () => attachToItem(item));
  add("remove", () => askDelete(kind, idx()), true);
  document.body.appendChild(menu);
  rowMenuEl = menu;
  placeMenu(menu, r);
}
document.addEventListener("click", closeRowMenu);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeRowMenu(); });

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
    if (jotProject) item.project = jotProject; // adding while filtered tags it
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

function imgsToInbox(ids) {
  notes.inbox = notes.inbox || [];
  ids.forEach(id => notes.inbox.push({ img: id }));
  renderNotes();
  if (document.getElementById("col-inbox").style.display !== "none") renderInbox();
  saveNotesNow();
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
    const img = document.createElement("img");
    img.src = `/attachments/${item.img}`; img.loading = "lazy";
    img.onclick = () => openLightbox(item.img);
    a.appendChild(img);

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
               mkInboxBtn("→ idea", () => promoteInbox(i, "ideas")), del);
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

// triage: turn an inbox image into a filed to-do/idea (caption becomes the text)
function promoteInbox(i, kind) {
  const item = (notes.inbox || [])[i];
  if (!item) return;
  const text = (item.caption || "").trim() || "image note";
  const note = kind === "todos" ? { text, done: false } : { text };
  note.images = [item.img];
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
    #inbox-open.has-items { color:var(--ink); font-weight:600; }
    #inbox-open .has-items, #inbox-count { font-variant-numeric:tabular-nums; }
    .inbox-add { display:inline-flex; align-items:center; gap:.4rem; cursor:pointer;
      margin-top:.6rem; align-self:flex-start; border:1px solid var(--ink-soft);
      border-radius:2px; color:var(--ink); font-size:.85rem; font-variant:small-caps;
      letter-spacing:.05em; padding:.4rem .85rem; }
    .inbox-add:hover { background:var(--ink); color:var(--parchment); }
    #col-inbox ul { list-style:none; margin:0; padding:0; }
    .inbox-row { display:flex; gap:.7rem; align-items:flex-start; padding:.6rem 0;
      border-bottom:1px solid var(--ink-faint); }
    .inbox-thumb { line-height:0; flex:none; }
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
    const opts = [{ label: "all projects", value: "", pinned: true },
                  ...filterProjects().map(p => ({ label: p, value: p }))];
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
const modeSelect = document.getElementById("mode-select");
if (modeSelect) modeSelect.value = chatMode;

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
function openDrawer(project, opt = false) {
  const o = (typeof opt === "boolean") ? { resume: opt } : (opt || {});
  // resumed/reattached sessions are keyed by their token so several from one
  // project can coexist; fresh chats keep keying by project (focus, don't dupe)
  const key = o.session ? `${project}#${o.session}`
            : o.attach ? `${project}#${o.attach}` : project;
  let s = sessions.get(key);
  if (!s || s.ws.readyState > 1) s = createSession(key, project, o);
  activate(key);
}

// The theme registry (THEME / THEME_ORDER / xtermTheme / _shade / _rgba /
// resolveTheme) lives in static/themes.js, loaded before this file and shared
// with the full-page terminal so both stay in lockstep. activeTheme is this
// page's current selection.
let activeTheme = "codex";

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
  // term.open() is deferred to activate(): opening into a hidden host breaks
  // the renderer on cold loads (the Ctrl+Shift+R blank-drawer bug). xterm
  // buffers writes before open, so early ws output is safe.

  const params = new URLSearchParams({ mode: chatMode });
  if (o.resume) params.set("resume", "1");
  if (o.session) params.set("session", o.session);
  // every chat runs in a persistent pty (hub_ptyd) keyed by this token —
  // disconnects detach instead of killing, and the full-page view can
  // attach to the very same session
  const token = o.attach || o.session || Math.random().toString(36).slice(2, 10);
  params.set("attach", token);
  // wss when served over https (e.g. via Tailscale Serve)
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${wsProto}://${location.host}/ws/terminal/${encodeURIComponent(project)}?${params}`);
  ws.binaryType = "arraybuffer";

  const s = { key, name: project, token, label: o.label || disp(project),
    ws, term, fit, host, status: "working", lastOut: Date.now(), sawOutput: false };
  sessions.set(key, s);

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
    attachTouchScroll(s.host); // phone: swipes become wheel events claude understands
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
// nothing on a phone. Translate vertical swipes into wheel events — xterm.js
// forwards those to the app as scroll (mouse-reporting) sequences.
function attachTouchScroll(host) {
  let lastY = null;
  host.addEventListener("touchstart", e => { lastY = e.touches[0].clientY; }, { passive: true });
  host.addEventListener("touchmove", e => {
    if (lastY === null) return;
    const y = e.touches[0].clientY, dy = lastY - y;
    if (Math.abs(dy) >= 10) {
      lastY = y;
      const target = host.querySelector(".xterm-viewport") || host;
      target.dispatchEvent(new WheelEvent("wheel",
        { deltaY: dy * 2.5, bubbles: true, cancelable: true }));
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
    const short = s.label.length > 26 ? s.label.slice(0, 25) + "…" : s.label;
    pill.innerHTML = `<span class="dot"></span>${CHAT_ICON} `;
    pill.appendChild(document.createTextNode(short)); // label may be arbitrary text
    pill.title = ({ working: "working…", ready: "ready for you",
                   attention: "needs your input", ended: "session ended" }[s.status] || "")
                 + (short !== s.label ? ` — ${s.label}` : "");
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
    .sess-overlay { position:fixed; inset:0; background:rgba(67,51,28,.4); z-index:70;
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
    .sess-empty { color:var(--ink-faint); font-style:italic; text-align:center; padding:1.4rem; }`;
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

  function renderSessions(q) {
    q = q.toLowerCase();
    const rows = allSessions.filter(s =>
      !q || `${s.title} ${s.project} ${s.preview}`.toLowerCase().includes(q));
    listEl.innerHTML = "";
    if (!rows.length) {
      listEl.innerHTML = `<div class="sess-empty">no sessions${q ? " match" : " yet"}.</div>`;
      return;
    }
    rows.forEach(s => {
      const row = document.createElement("div");
      row.className = "sess-row";
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
      row.append(proj, main);
      row.title = "resume this session";
      row.onclick = () => { closeSessions(); openDrawer(s.project, { session: s.id, label: s.title }); };
      listEl.appendChild(row);
    });
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
      --input-bg:${_rgba(t.paper, .5)}; color-scheme:${t.mode}; }`;
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
        body[data-theme="aqua"] .chip {
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
    .theme-overlay { position:fixed; inset:0; background:rgba(40,30,15,.45);
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
      border-top:1px solid var(--ink-faint); }`;
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
    .act-overlay { position:fixed; inset:0; background:rgba(40,30,15,.4); z-index:72;
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
