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

- **Embedded terminal**: each card's claude button opens `/terminal/<name>` —
  xterm.js (vendored under `static/vendor/`, offline-capable) bridged over a
  WebSocket to a pty running Claude Code in that project's directory. Voice
  dictation (see `../babble-building/jarvis/`) types into it for free; a ⧉
  button still opens a real Konsole instead.

## Install

```bash
./install.sh
```

Then set `http://localhost:7700` as the browser homepage/new-tab page.

## Roadmap

- **v3 — conversation manager**: list/search/resume Claude Code sessions
  across projects (transcripts already live under `~/.claude/projects/`).
- Later: a "today" panel — goals/mindful-living tie-in (possible radial
  Vitruvian centerpiece).
