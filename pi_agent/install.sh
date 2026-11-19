#!/usr/bin/env bash
# Installs pi_agent.py as a systemd service (pi-agent.service) that starts on boot.
# Safe to re-run after editing pi_agent.py, .env, or the unit file: it
# re-copies the unit and restarts pi-agent.service so the changes take effect.
#
# First it creates/edits .env interactively (server IP, Pi ID, ...; Enter keeps
# the current value) and checks the server's ports are reachable.
#   ./install.sh               # configure .env, then install
#   ./install.sh --env-only    # only configure .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_NAME="pi-agent.service"

ENV_FILE="$SCRIPT_DIR/.env"
ENV_ONLY=0
case "${1:-}" in
    --env-only) ENV_ONLY=1 ;;   # only create/edit .env, don't install anything
    -h|--help)
        echo "Usage: $0 [--env-only]"
        echo "  Asks for the server IP, this Pi's ID etc. (Enter keeps the current value),"
        echo "  then installs pi-agent.service. --env-only stops after writing .env."
        exit 0 ;;
    "") ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
esac

# --- .env helpers ------------------------------------------------------------
env_get() {
    [[ -f $ENV_FILE ]] || return 0
    local v
    v=$(grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-) || true
    v=${v#\'}; v=${v%\'}; v=${v#\"}; v=${v%\"}
    printf '%s' "$v"
}

# Replace KEY's line, or append it. awk so any characters are written literally.
env_set() {
    local tmp
    tmp=$(mktemp "$ENV_FILE.XXXX")
    K="$1" V="$2" awk -F= '
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
        $1 == k { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
    mv "$tmp" "$ENV_FILE"
}

valid_ip() {
    [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    local o; for o in "${BASH_REMATCH[@]:1}"; do (( 10#$o <= 255 )) || return 1; done
}
valid_port()  { [[ $1 =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
valid_id()    { [[ $1 =~ ^[A-Za-z0-9_-]+$ ]]; }          # used in MQTT topics: no / + #
valid_iface() { [[ $1 == none ]] || ip link show "$1" >/dev/null 2>&1; }
any()         { [[ -n $1 ]]; }

# ask VAR "Question" default validator  ->  Enter keeps the default
ask() {
    local __var=$1 q=$2 def=$3 check=${4:-any} ans
    while true; do
        read -rp "  $q [$def]: " ans
        ans=${ans:-$def}
        if [[ -n $ans ]] && $check "$ans"; then printf -v "$__var" '%s' "$ans"; return; fi
        echo "  '$ans' is not valid, try again." >&2
    done
}

yes_no() { local a; read -rp "  $1 [y/N]: " a; [[ $a == [yY]* ]]; }

# Can this Pi open a TCP connection to HOST:PORT (from SRC, if given)?
tcp_ok() {
    local host=$1 port=$2 src=${3:-}
    if command -v nc >/dev/null; then
        nc -z -w 3 ${src:+-s "$src"} "$host" "$port" 2>/dev/null
    else
        timeout 3 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null
    fi
}

# --- .env --------------------------------------------------------------------
echo "==> Configuring $ENV_FILE"
if [[ ! -f $ENV_FILE ]]; then
    [[ -t 0 ]] || { echo "Error: $ENV_FILE not found; run $0 from a terminal to create it." >&2; exit 1; }
    : > "$ENV_FILE"
    edit_env=1
    echo "No .env yet, creating one."
elif [[ $ENV_ONLY == 1 ]]; then
    edit_env=1
elif [[ -t 0 ]] && yes_no ".env exists. Review/edit its settings?"; then
    edit_env=1
else
    edit_env=0
    echo ".env left unchanged"
fi

if [[ $edit_env == 1 ]]; then
    cp -p "$ENV_FILE" "$ENV_FILE.bak"
    echo "  (press Enter to keep the value in brackets)"

    def_broker=$(env_get BROKER_HOST);          def_broker=${def_broker:-192.168.150.20}
    def_bport=$(env_get BROKER_PORT);           def_bport=${def_bport:-1883}
    def_id=$(env_get PI_ID);                    def_id=${def_id:-$(hostname -s)}
    def_role=$(env_get ROLE);                   def_role=${def_role:-client}
    def_cport=$(env_get CAPTURE_SOCKET_PORT);   def_cport=${def_cport:-9200}
    if grep -q '^WIRED_INTERFACE=' "$ENV_FILE"; then
        def_iface=$(env_get WIRED_INTERFACE);   def_iface=${def_iface:-none}
    else
        def_iface=eth0                           # the agent's own default
    fi

    ask broker_host "Server (MQTT broker) IP"              "$def_broker" valid_ip
    ask broker_port "MQTT broker port"                     "$def_bport"  valid_port
    def_chost=$(env_get CAPTURE_SOCKET_HOST);   def_chost=${def_chost:-$broker_host}
    # Capture socket lives on the same server; follow a changed broker IP.
    [[ $def_chost == "$def_broker" ]] && def_chost=$broker_host
    ask cap_host    "Capture socket IP (the server)"       "$def_chost"  valid_ip
    ask cap_port    "Capture socket port"                  "$def_cport"  valid_port
    ask pi_id       "This Pi's ID (unique per Pi)"         "$def_id"     valid_id
    ask role        "Role"                                 "$def_role"
    echo "  Interfaces here: $(ip -o link show | awk -F': ' '$2 != "lo" {printf "%s ", $2}')"
    ask iface       "Interface to reach the server ('none' = let routing decide)" "$def_iface" valid_iface

    env_set BROKER_HOST         "$broker_host"
    env_set BROKER_PORT         "$broker_port"
    env_set PI_ID               "$pi_id"
    env_set ROLE                "$role"
    env_set CAPTURE_SOCKET_HOST "$cap_host"
    env_set CAPTURE_SOCKET_PORT "$cap_port"
    env_set WIRED_INTERFACE     "$([[ $iface == none ]] || echo "$iface")"

    if cmp -s "$ENV_FILE" "$ENV_FILE.bak"; then
        rm -f "$ENV_FILE.bak"; echo "No changes."
    else
        echo "Saved $ENV_FILE (previous version: $ENV_FILE.bak)"
    fi
fi

# --- Reachability check (warn only; the agent keeps retrying anyway) ---------
iface=$(env_get WIRED_INTERFACE)
grep -q '^WIRED_INTERFACE=' "$ENV_FILE" || iface=eth0
src=""
[[ -n $iface ]] && src=$(ip -4 -o addr show "$iface" 2>/dev/null | awk '{split($4,a,"/"); print a[1]; exit}')
for target in "$(env_get BROKER_HOST):$(env_get BROKER_PORT):MQTT" \
              "$(env_get CAPTURE_SOCKET_HOST):$(env_get CAPTURE_SOCKET_PORT):capture socket"; do
    IFS=: read -r h p name <<< "$target"
    if tcp_ok "$h" "$p" "$src"; then
        echo "OK: reached $name at $h:$p${src:+ from $iface ($src)}"
    else
        echo "Warning: can't reach $name at $h:$p${src:+ from $iface ($src)}." >&2
        echo "         Check the server IP, and open the port on the server (./setup.sh does it for ufw)." >&2
    fi
done

if [[ $ENV_ONLY == 1 ]]; then
    echo "Done. Apply with: sudo systemctl restart pi-agent"
    exit 0
fi

# --- Python venv (../.venv, which pi-agent.service runs from) ----------------
VENV_PATH="$SCRIPT_DIR/../.venv"
if [[ ! -x $VENV_PATH/bin/python ]]; then
    echo "==> Creating $VENV_PATH"
    python3 -m venv "$VENV_PATH" || { sudo apt-get install -y python3-venv && python3 -m venv "$VENV_PATH"; }
fi
"$VENV_PATH/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"

# iw older than 6.17 can't decode the Wi-Fi 7 (EHT capabilities/operation,
# Multi-Link) elements in scan results - 6.9 only prints the local phy's EHT
# capabilities and hides the APs' EHT elements as unknown extension IDs. So
# make sure the iw on PATH is at least IW_MIN_VERSION; otherwise build IW_INSTALL_VERSION
# from the kernel.org release tarball. It goes into /usr/local/sbin, which
# comes before /usr/sbin on PATH (systemd's default PATH included), so the
# distro package's /usr/sbin/iw stays untouched and apt never fights it.
# Done before the service restart below so the agent comes up on the new iw.
IW_MIN_VERSION="6.17"
IW_INSTALL_VERSION="6.17"
iw_version() {
    iw --version 2>/dev/null | awk '{print $3}'
}
CURRENT_IW="$(iw_version || true)"
if [[ -n "$CURRENT_IW" ]] && \
   [[ "$(printf '%s\n%s\n' "$IW_MIN_VERSION" "$CURRENT_IW" | sort -V | head -n1)" == "$IW_MIN_VERSION" ]]; then
    echo "iw $CURRENT_IW is >= $IW_MIN_VERSION - not upgrading"
else
    echo "iw ${CURRENT_IW:-not found} is older than $IW_MIN_VERSION - building iw $IW_INSTALL_VERSION"
    sudo apt-get install -y build-essential pkg-config libnl-3-dev libnl-genl-3-dev curl xz-utils
    IW_BUILD_DIR="$(mktemp -d)"
    trap 'rm -rf "$IW_BUILD_DIR"' EXIT
    curl -fsSL "https://mirrors.edge.kernel.org/pub/software/network/iw/iw-$IW_INSTALL_VERSION.tar.xz" \
        | tar -xJ -C "$IW_BUILD_DIR"
    make -C "$IW_BUILD_DIR/iw-$IW_INSTALL_VERSION" -j"$(nproc)"
    sudo make -C "$IW_BUILD_DIR/iw-$IW_INSTALL_VERSION" install \
        PREFIX=/usr/local SBINDIR=/usr/local/sbin MANDIR=/usr/local/share/man
    hash -r
    echo "iw is now $(iw_version)"
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
