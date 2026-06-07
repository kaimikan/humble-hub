# hub

A local start page for everything in `~/Projects` — the central place projects
are seen, launched, and (eventually) worked on. Born from the observation that
ideas get *built* easily but then don't enter daily life; the fix is a hub that
lives where the day already starts (the browser's start page), with every
project one click from being used.

## v1 (current)

- Scans `~/Projects`, renders a card per project: README excerpt, type badge
  (site / app / code / notes), last commit, uncommitted-changes marker.
- Type-aware actions:
  - **site** → served by the hub itself under `/sites/<name>/`
  - **app** (has a `.desktop`) → launch it
  - any → open a **Claude Code terminal** in the project, open in Dolphin
- Runs as a systemd user service on `http://localhost:7700` (localhost only).

## Install

```bash
./install.sh
```

Then set `http://localhost:7700` as the browser homepage/new-tab page.

## Roadmap

- **v2 — embedded terminal**: xterm.js + a pty bridge running Claude Code in a
  chosen project, inside the hub page. Voice dictation (see
  `../babble-building/jarvis/`) types into it for free.
- **v3 — conversation manager**: list/search/resume Claude Code sessions
  across projects (transcripts already live under `~/.claude/projects/`).
- Later: a "today" panel — goals/mindful-living tie-in.
