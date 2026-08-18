#!/usr/bin/env bash
# Install the home-server CLI + system-tray indicator (user scope, no sudo).
set -euo pipefail
cd "$(dirname "$0")"

# The tray needs PyQt6 (system package). It is NOT tracked by pacman as a
# dependency of anything, so an orphan sweep (`pacman -Rns $(pacman -Qdtq)`)
# will remove it and the tray silently dies at every login (happened 2026-08-04).
# Install it explicitly so it never counts as an orphan.
if ! python3 -c 'import PyQt6' 2>/dev/null; then
  echo "python-pyqt6 is missing — the tray icon needs it. Install (and mark explicit):"
  echo "  sudo pacman -S --asexplicit python-pyqt6"
  echo "Continuing with the file install; the tray will fail until PyQt6 is present."
  echo
fi

mkdir -p "$HOME/.local/bin" "$HOME/.config/autostart"
install -m755 home-server          "$HOME/.local/bin/home-server"
install -m755 home-server-tray     "$HOME/.local/bin/home-server-tray"
install -m644 home-server-tray.desktop "$HOME/.config/autostart/home-server-tray.desktop"

echo "Installed:"
echo "  ~/.local/bin/home-server          (CLI: on|off|toggle|status)"
echo "  ~/.local/bin/home-server-tray     (system-tray toggle)"
echo "  ~/.config/autostart/home-server-tray.desktop  (starts the tray at login)"
echo
echo "Start the tray now:  ~/.local/bin/home-server-tray &"
