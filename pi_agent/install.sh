#!/usr/bin/env bash
# Installs Pi_agent.py as a systemd service (pi-agent.service) that starts on boot,
# plus pi-monitor-setup.service, a oneshot unit that creates a monitor-mode
# interface on every wifi phy except phy0 (leaving phy0 managed-only, and
# every phy's existing managed interface untouched) - see
# setup-monitor-interfaces.sh. That oneshot runs before pi-agent.service on
# every boot, since interfaces created via `iw ... interface add` don't
# survive a reboot and need recreating each time.
# Safe to re-run after editing Pi_agent.py, .env, or either unit file: it
# re-copies both units and restarts pi-agent.service so the changes take effect.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="pi-agent.service"
MON_UNIT_NAME="pi-monitor-setup.service"
MON_SCRIPT_NAME="setup-monitor-interfaces.sh"

if [[ ! -f "$SCRIPT_DIR/.env" ]]; then
    echo "Error: $SCRIPT_DIR/.env not found. Create it before installing." >&2
    exit 1
fi

sudo chmod +x "$SCRIPT_DIR/$MON_SCRIPT_NAME"

# Both unit files carry __PI_AGENT_DIR__/__VENV_DIR__ placeholders instead
# of a hardcoded path - substituted here with this checkout's actual
# location, since that varies by machine/user (e.g. /home/ats vs
# /home/alexle) and a path baked into the repo's copy would silently work
# on some deployments and 203/EXEC-fail on others.
VENV_DIR="$(cd "$SCRIPT_DIR/../.venv" && pwd)"
sed -e "s#__PI_AGENT_DIR__#$SCRIPT_DIR#g" -e "s#__VENV_DIR__#$VENV_DIR#g" \
    "$SCRIPT_DIR/$MON_UNIT_NAME" | sudo tee "/etc/systemd/system/$MON_UNIT_NAME" > /dev/null
sed -e "s#__PI_AGENT_DIR__#$SCRIPT_DIR#g" -e "s#__VENV_DIR__#$VENV_DIR#g" \
    "$SCRIPT_DIR/$UNIT_NAME" | sudo tee "/etc/systemd/system/$UNIT_NAME" > /dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$MON_UNIT_NAME"
sudo systemctl enable "$UNIT_NAME"
sudo systemctl restart "$MON_UNIT_NAME"
sudo systemctl restart "$UNIT_NAME"
systemctl status "$MON_UNIT_NAME" --no-pager
systemctl status "$UNIT_NAME" --no-pager
