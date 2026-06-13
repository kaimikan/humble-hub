#!/bin/bash
# Install/refresh the hub: venv, deps, user service. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$HERE/.venv" ] || uv venv "$HERE/.venv"
uv pip install --python "$HERE/.venv/bin/python" fastapi uvicorn websockets

install -Dm644 "$HERE/hub.service" "$HOME/.config/systemd/user/hub.service"
systemctl --user daemon-reload
systemctl --user enable hub.service
systemctl --user restart hub.service

# Taskbar launcher: opens the hub in the browser, focusing it if already open
# (KWin one-shot script — see tools/open-hub). Icon installed into the hicolor
# theme so it scales and is referenced by name (humble-hub).
install -Dm755 "$HERE/tools/open-hub" "$HOME/.local/bin/open-hub"
install -Dm644 "$HERE/tools/humble-hub.desktop" \
  "$HOME/.local/share/applications/humble-hub.desktop"
install -Dm644 "$HERE/static/icon.svg" \
  "$HOME/.local/share/icons/hicolor/scalable/apps/humble-hub.svg"
install -Dm644 "$HERE/static/icon-512.png" \
  "$HOME/.local/share/icons/hicolor/512x512/apps/humble-hub.png"
gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
kbuildsycoca6 2>/dev/null || true

echo "hub running at http://localhost:7700"
echo "Set it as your browser start/new-tab page to make it the daily entry point."
