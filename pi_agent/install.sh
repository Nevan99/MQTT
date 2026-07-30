#!/usr/bin/env bash
# Installs Pi_agent.py as a systemd service (pi-agent.service) that starts on boot.
# Safe to re-run after editing Pi_agent.py, .env, or the unit file itself: it
# re-copies the unit and restarts the service so the changes take effect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="pi-agent.service"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    echo "Error: $SCRIPT_DIR/.env not found. Create it before installing." >&2
    exit 1
fi

sudo cp "$SCRIPT_DIR/$UNIT_NAME" "/etc/systemd/system/$UNIT_NAME"
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME"
sudo systemctl restart "$UNIT_NAME"
systemctl status "$UNIT_NAME" --no-pager
