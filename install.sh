#!/bin/bash
# Install/refresh the hub: venv, deps, user service. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -d "$HERE/.venv" ] || uv venv "$HERE/.venv"
uv pip install --python "$HERE/.venv/bin/python" fastapi uvicorn

install -Dm644 "$HERE/hub.service" "$HOME/.config/systemd/user/hub.service"
systemctl --user daemon-reload
systemctl --user enable hub.service
systemctl --user restart hub.service

echo "hub running at http://localhost:7700"
echo "Set it as your browser start/new-tab page to make it the daily entry point."
