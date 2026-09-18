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
#
# Only touched when the conf actually changed, and then via a config
# reload rather than a full NetworkManager restart. This used to restart
# NM unconditionally on every run, landing about a second after the
# pi-agent restart above - i.e. right while every agent-started
# wpa_supplicant was being SIGTERM'd (they live in pi-agent's cgroup) and
# the rtw89 dongles were dropping into power-save after the resulting
# deauths. A USB register read that races that power transition times out
# (`rtw89_8852bu ... usb read32 ... fail ret=-110 value=0x0` in dmesg), and
# when the read that fails is the driver's rfkill GPIO poll the returned 0
# reads as "RF switch off" - a hard rfkill block that only a USB replug
# clears. NM's restart-time wiphy enumeration was extra traffic into that
# window for no benefit: an unmanaged-devices rule is re-evaluated on a
# plain config reload, and re-copying an identical file changes nothing.
NM_CONF_SRC="$SCRIPT_DIR/99-pi-agent-unmanaged-wifi.conf"
NM_CONF_DST="/etc/NetworkManager/conf.d/99-pi-agent-unmanaged-wifi.conf"
if [[ -d /etc/NetworkManager/conf.d ]]; then
    if sudo cmp -s "$NM_CONF_SRC" "$NM_CONF_DST"; then
        echo "NetworkManager unmanaged-wifi config unchanged - not reloading NetworkManager"
    else
        sudo cp "$NM_CONF_SRC" "$NM_CONF_DST"
        # `nmcli general reload conf` is the documented config reload
        # (NM >= 1.22); `systemctl reload` sends the SIGHUP that does the
        # same on older builds. Neither tears devices down.
        if command -v nmcli >/dev/null 2>&1; then
            sudo nmcli general reload conf
        else
            sudo systemctl reload NetworkManager
        fi
        echo "NetworkManager unmanaged-wifi config updated and reloaded"
    fi
else
    echo "Note: /etc/NetworkManager/conf.d not found - skipping the unmanaged-wifi config (NetworkManager not installed?)" >&2
fi

systemctl status "$UNIT_NAME" --no-pager
