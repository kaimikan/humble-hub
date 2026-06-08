# hub

A local start page for everything in `~/Projects` — the central place projects
are seen, launched, and (eventually) worked on. Born from the observation that
ideas get *built* easily but then don't enter daily life; the fix is a hub that
lives where the day already starts (the browser's start page), with every
project one click from being used.

## v1

- Scans `~/Projects`, renders a card per project: README excerpt, type badge
  (site / app / code / notes), last commit, uncommitted-changes marker.
- Type-aware actions:
  - **site** → served by the hub itself under `/sites/<name>/`
  - **app** (has a `.desktop`) → launch it
  - any → open a **Claude Code terminal** in the project, open in Dolphin
- Search box + type filter chips.
- Runs as a systemd user service on `http://localhost:7700` (localhost only).
- Da Vinci notebook look: parchment, sepia ink, pigment-colored actions.

## v2 (current)

- **Embedded terminal**: xterm.js (vendored under `static/vendor/`,
  offline-capable) bridged over a WebSocket to a pty running Claude Code in
  that project's directory. Voice dictation (see `../babble-building/jarvis/`)
  types into it for free.
- **Side drawer**: the claude button opens the terminal in a slide-in panel
  over the shelf — minimize keeps the session alive (restore via the pill),
  close ends it. The hover menu also offers resume (`claude --resume`),
  a full-page terminal at `/terminal/<name>`, and external Konsole.
- **Jottings**: file-backed to-do and ideas lists (`data/notes.json`). To-dos
  filter by done/active/all (opens on active), rows drag to reorder, carry
  filter-stable reference numbers (active to-dos only) for terse mentions, and
  a per-row ⋯ menu promotes/demotes items between the two lists or removes them.

## v3

- **Conversation manager**: the **❧ chats** trigger (next to root claude) opens
  a searchable list of every past Claude Code session across projects, read
  from the transcripts under `~/.claude/projects/`. Each row shows its title,
  project, relative time, and message count; clicking resumes it
  (`claude --resume <id>`) straight into the drawer, where it joins the live
  status pills like any other chat.

## Install

```bash
./install.sh
```

Then set `http://localhost:7700` as the browser homepage/new-tab page.

## Roadmap

- **Shared pty sessions (tmux-style)**: one persistent `claude` pty per
  project owned by the hub server; every client (laptop browser, phone,
  multiple tabs) *attaches* to the same pty instead of spawning a new
  process. Laptop and phone become live mirrors of one conversation, the
  chat survives browser closes, and a forgotten open client can no longer
  fork the session — avoids the two-Claudes-diverging problem hit on
  2026-06-08. Replaces the current spawn-per-WebSocket model in `app.py`
  (`spawn_claude`/`terminal_ws`).
- Later: a "today" panel — goals/mindful-living tie-in (possible radial
  Vitruvian centerpiece).
