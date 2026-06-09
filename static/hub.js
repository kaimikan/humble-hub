// hub.js — shelf actions, search/filter, and the multi-session drawer.

async function act(name, action) {
  await fetch(`/api/projects/${name}/${action}`, { method: "POST" });
}

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
    #empty-state { text-align:center; font-style:italic; color:#6e5a39;
      margin:2.6rem auto; }
    #empty-state p { margin:0 0 .8rem; }
    #empty-state button { background:transparent; border:1px solid #6e5a39;
      border-radius:2px; color:#43331c; font:inherit; font-size:.85rem;
      font-variant:small-caps; letter-spacing:.06em; padding:.32rem .8rem;
      cursor:pointer; font-style:normal; }
    #empty-state button:hover { background:#43331c; color:#efe2c0; }`;
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

      li.append(left, idx, txt, menuBtn);
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
function openRowMenu(e, kind, item) {
  e.stopPropagation();
  closeRowMenu();
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
  add("remove", () => askDelete(kind, idx()), true);
  document.body.appendChild(menu);
  rowMenuEl = menu;
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.top = `${Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8)}px`;
  menu.style.left = `${Math.max(8, r.right - menu.offsetWidth)}px`;
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
  jotKind = kind;
  const sw = document.getElementById("jot-switch");
  if (sw) sw.textContent = kind === "todos" ? "→ ideas" : "→ to-do";
  cancelDelete();
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
  li.replaceChild(input, txt);
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
  if (text) {
    notes[kind].push(kind === "todos" ? { text, done: false } : { text });
    input.value = "";
    renderNotes();
    saveNotes();
  }
  return false;
}

// to-do filter bar (all/active/done) + per-row tool styling — injected from JS
// (not the page template) so it ships without a hub.service restart, which would
// kill live drawer sessions. Same rationale as the empty-state block above.
(() => {
  const style = document.createElement("style");
  style.textContent = `
    .todo-filter { display:flex; gap:.4rem; justify-content:flex-end;
      padding:0 .1rem .4rem; }
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
    .jot-col li.dragging { opacity:.65; background:rgba(255,250,235,.95);
      box-shadow:1px 2px 9px rgba(67,51,28,.3); }
    .jot-col li .row-menu-btn { border:0; background:transparent; color:var(--ink-faint);
      cursor:pointer; font:inherit; font-size:1.05rem; line-height:1; padding:0 .25rem;
      align-self:center; }
    .jot-col li .row-menu-btn:hover { color:var(--ink); background:transparent; }
    .row-menu { position:fixed; z-index:100; background:#f6edd6;
      border:1px solid var(--ink-soft); box-shadow:2px 3px 11px rgba(67,51,28,.35);
      border-radius:2px; display:flex; flex-direction:column; min-width:9.5rem; }
    .row-menu button { border:0; border-radius:0; background:transparent; text-align:left;
      color:var(--ink); font:inherit; font-size:.82rem; font-variant:small-caps;
      letter-spacing:.04em; padding:.42rem .75rem; cursor:pointer; }
    .row-menu button:hover { background:var(--ink); color:var(--parchment); }
    .row-menu button.danger { color:#9a3b22; }
    .row-menu button.danger:hover { background:#9a3b22; color:var(--parchment); }
    .jot-col li.empty-hint { justify-content:center; font-style:italic;
      color:var(--ink-faint); border-bottom:0; }`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "todo-filter";
  // color-coded: all = neutral, active = ochre (pending), done = verdigris (complete)
  [["all", "all", null], ["active", "active", "#8a6d1f"], ["done", "done", "#4f6b3a"]]
    .forEach(([val, label, color]) => {
      const b = document.createElement("button");
      b.className = "chip" + (val === todoFilter ? " active" : "");
      b.dataset.val = val;
      b.textContent = label;
      if (color) b.style.setProperty("--chip", color);
      b.onclick = () => applyTodoFilter(val);
      bar.appendChild(b);
    });
  const col = document.getElementById("col-todos");
  col.insertBefore(bar, document.getElementById("todos"));

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
  search.placeholder = "search…";
  search.oninput = () => setJotSearch(search.value);
  const sStyle = document.createElement("style");
  sStyle.textContent = `
    #jot-search { width:100%; box-sizing:border-box; margin:.45rem 0 .15rem;
      background:rgba(255,250,235,.5); border:1px solid var(--ink-faint);
      border-radius:2px; color:var(--ink); font:inherit; font-size:.88rem;
      padding:.3rem .6rem; outline:none; }
    #jot-search:focus { border-color:var(--ink-soft); }
    #jot-search::placeholder { color:var(--ink-faint); font-style:italic; }`;
  document.head.appendChild(sStyle);
  mhead.after(search);
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
//   { resume: bool, session: "<id>" (resume a specific session), label: "<text>" }
function openDrawer(project, opt = false) {
  const o = (typeof opt === "boolean") ? { resume: opt } : (opt || {});
  // resumed historical sessions are keyed by id so several from one project
  // can coexist; fresh/picker chats keep keying by project (focus, don't dupe)
  const key = o.session ? `${project}#${o.session}` : project;
  let s = sessions.get(key);
  if (!s || s.ws.readyState > 1) s = createSession(key, project, o);
  activate(key);
}

function createSession(key, project, o) {
  const host = document.createElement("div");
  host.className = "term-host";
  document.getElementById("dterm").appendChild(host);

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Hack', 'Noto Sans Mono', monospace",
    fontSize: 14, cursorBlink: true, customGlyphs: true,
    theme: { background: "#1a1b26", foreground: "#c0caf5" },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);

  const params = new URLSearchParams({ mode: chatMode });
  if (o.resume) params.set("resume", "1");
  if (o.session) params.set("session", o.session);
  // wss when served over https (e.g. via Tailscale Serve)
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(
    `${wsProto}://${location.host}/ws/terminal/${encodeURIComponent(project)}?${params}`);
  ws.binaryType = "arraybuffer";

  const s = { key, name: project, label: o.label || disp(project),
    ws, term, fit, host, status: "working", lastOut: Date.now(), sawOutput: false };
  sessions.set(key, s);

  ws.onopen = () => refit(s);
  ws.onmessage = e => {
    const data = new Uint8Array(e.data);
    term.write(data);
    s.lastOut = Date.now();
    s.sawOutput = true;
    if (data.includes(7)) setStatus(s, "attention");
    else if (s.status !== "attention" || s.key === active) setStatus(s, "working");
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

function refit(s) {
  if (!s || !s.host.offsetParent) return;
  s.fit.fit();
  if (s.ws.readyState === 1) {
    s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
  }
}

function activate(key) {
  active = key;
  const s = sessions.get(key);
  sessions.forEach(o => o.host.classList.toggle("shown", o.key === key));
  document.getElementById("d-title").textContent = s.label;
  document.getElementById("d-full").href = `/terminal/${encodeURIComponent(s.name)}`;
  drawerEl().classList.add("open");
  document.body.classList.add("drawer-open");
  if (s.status === "attention" || s.status === "ready") s.status = "working";
  renderPills();
  setTimeout(() => { refit(s); s.term.focus(); }, 240);
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
  s.ws.close();
  s.term.dispose();
  s.host.remove();
  sessions.delete(active);
  const next = sessions.keys().next();
  if (next.done) minimizeDrawer();
  else activate(next.value);
}

function renderPills() {
  const box = document.getElementById("pills");
  box.innerHTML = "";
  sessions.forEach(s => {
    if (s.key === active && drawerEl().classList.contains("open")) return;
    const pill = document.createElement("button");
    pill.className = `pill s-${s.status}`;
    const short = s.label.length > 26 ? s.label.slice(0, 25) + "…" : s.label;
    pill.innerHTML = `<span class="dot"></span>🗨 `;
    pill.appendChild(document.createTextNode(short)); // label may be arbitrary text
    pill.title = ({ working: "working…", ready: "ready for you",
                   attention: "needs your input", ended: "session ended" }[s.status] || "")
                 + (short !== s.label ? ` — ${s.label}` : "");
    pill.onclick = () => s.status === "ended"
      ? (s.host.remove(), sessions.delete(s.key), renderPills())
      : activate(s.key);
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
    #sess-search { width:100%; box-sizing:border-box; background:rgba(255,250,235,.5);
      border:1px solid var(--ink-soft); border-radius:2px; color:var(--ink); font:inherit;
      font-size:.9rem; padding:.35rem .6rem; margin-bottom:.5rem; }
    #sess-search::placeholder { color:var(--ink-faint); font-style:italic; }
    #sess-list { overflow-y:auto; min-height:0; scrollbar-width:thin;
      scrollbar-color:var(--ink-faint) transparent; }
    /* badge on its own line on top, title + meta beneath — keeps every row's
       text left-aligned regardless of project-name length */
    .sess-row { display:flex; flex-direction:column; align-items:flex-start; gap:.28rem;
      padding:.5rem .35rem; border-bottom:1px dotted rgba(156,135,95,.4); cursor:pointer; }
    .sess-row:hover { background:rgba(255,250,235,.7); }
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
  trigger.textContent = "❧ chats";
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
      <div class="m-head"><h3>conversations</h3><button class="del" title="close">✕</button></div>
      <input id="sess-search" type="search" placeholder="search sessions…">
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
    /* phone ergonomics: full-width drawer, bigger touch targets, hide
       laptop-only actions (files/launch act on the laptop, not the phone) */
    @media (max-width: 700px) { :root { --drawer-w: 100vw; } }
    @media (pointer: coarse) {
      .b-files, button.b-go { display: none; }
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

  // label, sequence, extra class
  const KEYS = [
    ["↑", "\x1b[A"], ["↓", "\x1b[B"], ["←", "\x1b[D"], ["→", "\x1b[C"],
    ["⏎", "\r", "wide"], ["space", " ", "wide"], ["esc", "\x1b", "wide"],
    ["tab", "\t", "wide"], ["⌃C", "\x03", "wide"],
  ];
  const bar = document.createElement("div");
  bar.className = "kbar";
  for (const [label, seq, cls] of KEYS) {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    b.title = label === "space" ? "Space (toggle option)" : label;
    b.addEventListener("pointerdown", e => e.preventDefault()); // don't steal focus
    b.addEventListener("click", () => sendActiveKey(seq));
    bar.appendChild(b);
  }

  // mic — dictate straight into the chat via the browser's speech recognition,
  // without opening the soft keyboard. Tap to start (red pulse), tap to stop.
  // Final transcripts are typed into the pty; you still press ⏎ to send.
  const MIC_LANG = "en-US";
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const mic = document.createElement("button");
  mic.className = "wide mic";
  mic.textContent = "🎤";
  mic.title = "dictate (browser speech recognition)";
  let rec = null;
  mic.addEventListener("pointerdown", e => e.preventDefault());
  mic.addEventListener("click", () => {
    if (!SR) { mic.disabled = true; mic.textContent = "🎤✕"; mic.title = "speech recognition not supported in this browser"; return; }
    if (rec) { rec.stop(); return; }
    rec = new SR();
    rec.lang = MIC_LANG;
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = ev => {
      let text = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
      }
      if (text.trim()) sendActiveKey(text.trim() + " ");
    };
    rec.onend = () => { rec = null; mic.classList.remove("rec"); };
    rec.onerror = () => {};
    mic.classList.add("rec");
    rec.start();
  });
  bar.appendChild(mic);

  document.getElementById("drawer").appendChild(bar);
})();
