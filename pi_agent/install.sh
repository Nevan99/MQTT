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

# Every wifi interface here is driven end-to-end by pi_agent itself (see
# 99-pi-agent-unmanaged-wifi.conf) - NetworkManager fighting the agent for
# the same interface during its own boot-time reconnect was the source of
# the "Device or resource busy" scan failures and slow connects/disconnects.
# Safe to re-run: NetworkManager just reloads the same config each time.
if [[ -d /etc/NetworkManager/conf.d ]]; then
    sudo cp "$SCRIPT_DIR/99-pi-agent-unmanaged-wifi.conf" /etc/NetworkManager/conf.d/
    sudo systemctl restart NetworkManager
else
    echo "Note: /etc/NetworkManager/conf.d not found - skipping the unmanaged-wifi config (NetworkManager not installed?)" >&2
fi

systemctl status "$UNIT_NAME" --no-pager
