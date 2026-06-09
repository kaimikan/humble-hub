#!/usr/bin/env bash
# Install the home-server CLI + system-tray indicator (user scope, no sudo).
set -euo pipefail
cd "$(dirname "$0")"

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
