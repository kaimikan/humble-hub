// hub.js — shelf actions, search/filter, and the multi-session drawer.

async function act(name, action) {
  await fetch(`/api/projects/${name}/${action}`, { method: "POST" });
}

// --- search + type filter ---------------------------------------------------

let typeFilter = "";

function pick(chip) {
  typeFilter = chip.dataset.type;
  document.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
  refilter();
}

function refilter() {
  const q = document.getElementById("search").value.toLowerCase();
  document.querySelectorAll(".card").forEach(card => {
    const hit = (!typeFilter || card.dataset.type === typeFilter)
             && (!q || card.dataset.text.includes(q));
    card.style.display = hit ? "" : "none";
  });
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

function renderNotes() {
  for (const kind of ["todos", "ideas"]) {
    const ul = document.getElementById(kind);
    ul.innerHTML = "";
    notes[kind].forEach((item, i) => {
      const li = document.createElement("li");
      if (item.done) li.classList.add("done");
      if (kind === "todos") {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !!item.done;
        box.onchange = () => { item.done = box.checked; renderNotes(); saveNotes(); };
        li.appendChild(box);
      }
      const txt = document.createElement("span");
      txt.className = "txt";
      txt.textContent = item.text;
      txt.title = "click to edit";
      txt.onclick = () => beginEdit(item, li, txt);
      const del = document.createElement("button");
      del.className = "del";
      del.textContent = "✕";
      del.title = "remove";
      del.onclick = () => askDelete(kind, i);
      li.append(txt, del);
      ul.appendChild(li);
    });
  }
  document.getElementById("todos-count").textContent =
    `· ${notes.todos.filter(t => !t.done).length}`;
  document.getElementById("ideas-count").textContent = `· ${notes.ideas.length}`;
}

// --- jot modal ---

function openJot(kind) {
  document.getElementById("overlay").hidden = false;
  document.getElementById("m-title").textContent = kind === "todos" ? "to-do" : "ideas";
  document.getElementById("col-todos").style.display = kind === "todos" ? "" : "none";
  document.getElementById("col-ideas").style.display = kind === "ideas" ? "" : "none";
  cancelDelete();
  document.getElementById(`${kind}-input`).focus();
}

function closeJot() {
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

loadNotes();

// --- multi-session drawer ----------------------------------------------------
// One live pty session per project; the drawer shows one at a time, the rest
// stay alive behind status pills. Statuses: working (output flowing),
// ready (quiet after activity), attention (terminal bell).

const sessions = new Map();
let active = null; // project name shown in the drawer, or null when hidden

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
  if (s.name !== active || !drawerEl().classList.contains("open")) {
    if (status === "attention") blip([880, 660]);
    else if (status === "ready") blip([520]);
  }
  renderPills();
}

function openDrawer(name, resume = false) {
  let s = sessions.get(name);
  if (!s || s.ws.readyState > 1) s = createSession(name, resume);
  activate(name);
}

function createSession(name, resume) {
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

  const ws = new WebSocket(
    `ws://${location.host}/ws/terminal/${encodeURIComponent(name)}${resume ? "?resume=1" : ""}`);
  ws.binaryType = "arraybuffer";

  const s = { name, ws, term, fit, host, status: "working", lastOut: Date.now(), sawOutput: false };
  sessions.set(name, s);

  ws.onopen = () => refit(s);
  ws.onmessage = e => {
    const data = new Uint8Array(e.data);
    term.write(data);
    s.lastOut = Date.now();
    s.sawOutput = true;
    if (data.includes(7)) setStatus(s, "attention");
    else if (s.status !== "attention" || s.name === active) setStatus(s, "working");
  };
  ws.onclose = () => {
    term.write("\r\n\x1b[33m[session ended]\x1b[0m\r\n");
    setStatus(s, "ended");
  };
  term.onData(d => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "input", data: d }));
    if (s.status === "attention") setStatus(s, "working"); // user responded
  });
  new ResizeObserver(() => s.name === active && refit(s)).observe(host);
  return s;
}

function refit(s) {
  if (!s || !s.host.offsetParent) return;
  s.fit.fit();
  if (s.ws.readyState === 1) {
    s.ws.send(JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
  }
}

function activate(name) {
  active = name;
  const s = sessions.get(name);
  sessions.forEach(o => o.host.classList.toggle("shown", o.name === name));
  document.getElementById("d-title").textContent = disp(name);
  document.getElementById("d-full").href = `/terminal/${encodeURIComponent(name)}`;
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
    if (s.name === active && drawerEl().classList.contains("open")) return;
    const pill = document.createElement("button");
    pill.className = `pill s-${s.status}`;
    pill.innerHTML = `<span class="dot"></span>🗨 ${disp(s.name)}`;
    pill.title = { working: "working…", ready: "ready for you",
                   attention: "needs your input", ended: "session ended" }[s.status] || "";
    pill.onclick = () => s.status === "ended"
      ? (s.host.remove(), sessions.delete(s.name), renderPills())
      : activate(s.name);
    box.appendChild(pill);
  });
}

// working → ready when output has been quiet for a few seconds
setInterval(() => {
  sessions.forEach(s => {
    if (s.status === "working" && s.sawOutput && Date.now() - s.lastOut > 4000
        && (s.name !== active || !drawerEl().classList.contains("open"))) {
      setStatus(s, "ready");
    }
  });
}, 1000);
