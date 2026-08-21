#!/usr/bin/env bash
# Installs pi_agent.py as a systemd service (pi-agent.service) that starts on boot.
# Safe to re-run after editing pi_agent.py, .env, or the unit file: it
# re-copies the unit and restarts pi-agent.service so the changes take effect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="pi-agent.service"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    echo "Error: $SCRIPT_DIR/.env not found. Create it before installing." >&2
    exit 1
fi

VENV_DIR="$(cd "$SCRIPT_DIR/../.venv" && pwd)"
sed -e "s#__PI_AGENT_DIR__#$SCRIPT_DIR#g" -e "s#__VENV_DIR__#$VENV_DIR#g" \
    "$SCRIPT_DIR/$UNIT_NAME" | sudo tee "/etc/systemd/system/$UNIT_NAME" > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$UNIT_NAME"
sudo systemctl restart "$UNIT_NAME"
systemctl status "$UNIT_NAME" --no-pager
