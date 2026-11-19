#!/usr/bin/env bash
# One-shot setup for the Pi Fleet Controller server (the machine that hosts
# the web page, the FastAPI back-end and the Mosquitto broker).
#
# What it does (safe to re-run; each step skips work that's already done):
#   1. Installs system packages: python3-venv, mosquitto, lsof
#   2. Creates ./.venv and installs FastAPI/back-end/requirements.txt
#   3. Creates or edits FastAPI/back-end/.env interactively (broker IP/port,
#      capture port, login, session length); Enter keeps each current value,
#      and the old file is saved as .env.bak
#   4. Configures Mosquitto (listener on the MQTT port from .env), enables it on boot,
#      and opens the MQTT, capture and web ports if ufw/firewalld is active
#   5. Creates the SQLite database tables
#   6. Starts the back-end with FastAPI/back-end/restart.sh
#
# The Pis themselves are set up separately with pi_agent/install.sh.
#
# Usage:  ./setup.sh [-H|--host IP] [-p|--port PORT]
#   ./setup.sh                          # asks for host IP and port (lists this machine's IPs)
#   ./setup.sh -H 192.168.150.20 -p 8000
#   ./setup.sh --host 0.0.0.0           # listen on all interfaces
#   HOST=... PORT=... ./setup.sh        # env vars work too (flags win)
#   SKIP_APT=1 ./setup.sh               # skip system packages
#   NO_START=1 ./setup.sh               # set up but don't start
#   ./setup.sh --env-only               # only edit .env, nothing else
#   FW_SOURCE=192.168.150.0/24 ./setup.sh   # firewall: allow only this subnet (FW_SOURCE=any: anywhere)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/FastAPI/back-end"
VENV_DIR="$ROOT_DIR/.venv"
ENV_FILE="$BACKEND_DIR/.env"
MOSQUITTO_SRC="$ROOT_DIR/mosquitto.conf"
MOSQUITTO_DST="/etc/mosquitto/conf.d/pi-fleet.conf"

# Defaults: what a previous run saved in .env, else these.
_saved() { grep -m1 "^$1=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d "'\"" || true; }
DEFAULT_HOST="$(_saved SERVER_HOST)"; DEFAULT_HOST="${DEFAULT_HOST:-192.168.150.20}"
DEFAULT_PORT="$(_saved SERVER_PORT)"; DEFAULT_PORT="${DEFAULT_PORT:-8000}"
HOST="${HOST:-}"
PORT="${PORT:-}"
MQTT_PORT="${MQTT_PORT:-1883}"
CAPTURE_SOCKET_PORT="${CAPTURE_SOCKET_PORT:-9200}"
ENV_ONLY=0

step() { echo; echo "==> $*"; }
die()  { echo "Error: $*" >&2; exit 1; }

usage() {
    sed -n '/^# Usage:/,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
}

valid_ip() {
    local ip=$1 o
    [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
    for o in "${BASH_REMATCH[@]:1}"; do (( 10#$o <= 255 )) || return 1; done
}

valid_port() {
    [[ $1 =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 ))
}

# --- Command-line options ----------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        -H|--host) [[ $# -ge 2 ]] || die "$1 needs a value"; HOST=$2; shift 2 ;;
        --host=*)  HOST=${1#*=}; shift ;;
        -p|--port) [[ $# -ge 2 ]] || die "$1 needs a value"; PORT=$2; shift 2 ;;
        --port=*)  PORT=${1#*=}; shift ;;
        --env-only) ENV_ONLY=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
done

# --- Ask for host/port if not given (only when run from a terminal) ----------
if [[ -z $HOST ]]; then
    if [[ -t 0 && $ENV_ONLY != 1 ]]; then
        mapfile -t ips < <(ip -4 -o addr show scope global | awk '{split($4,a,"/"); print a[1]}')
        labels=()
        for ip in "${ips[@]}"; do
            iface=$(ip -4 -o addr show | awk -v ip="$ip" '{split($4,a,"/")} a[1]==ip {print $2; exit}')
            labels+=("$ip  ($iface)")
        done
        ips+=("0.0.0.0" "");  labels+=("0.0.0.0  (all interfaces)" "Type another IP...")

        # Start the cursor on the default IP if this machine has it.
        sel=0
        for i in "${!ips[@]}"; do [[ ${ips[$i]} == "$DEFAULT_HOST" ]] && sel=$i; done

        echo "Which IP should the Pi Fleet page listen on?  (Up/Down, Enter)"
        n=${#labels[@]}
        tput civis 2>/dev/null || true            # hide cursor while in the menu
        trap 'tput cnorm 2>/dev/null || true' EXIT
        while true; do
            for i in "${!labels[@]}"; do
                if (( i == sel )); then
                    printf '\e[2K  \e[7m> %s\e[0m\n' "${labels[$i]}"
                else
                    printf '\e[2K    %s\n' "${labels[$i]}"
                fi
            done
            IFS= read -rsn1 key
            if [[ $key == $'\e' ]]; then
                read -rsn2 -t 0.1 key || true
                case $key in
                    '[A') (( sel = (sel - 1 + n) % n )) ;;   # Up
                    '[B') (( sel = (sel + 1) % n )) ;;       # Down
                esac
            elif [[ -z $key ]]; then                         # Enter
                break
            fi
            printf '\e[%dA' "$n"                              # redraw in place
        done
        tput cnorm 2>/dev/null || true

        HOST=${ips[$sel]}
        while ! valid_ip "$HOST"; do
            [[ -n $HOST ]] && echo "'$HOST' is not a valid IPv4 address." >&2
            read -rp "Enter IP: " HOST
        done
    else
        HOST=$DEFAULT_HOST
    fi
fi

if [[ -z $PORT ]]; then
    if [[ -t 0 && $ENV_ONLY != 1 ]]; then
        while true; do
            read -rp "Port for the web page [$DEFAULT_PORT]: " PORT
            PORT=${PORT:-$DEFAULT_PORT}
            valid_port "$PORT" && break
            echo "'$PORT' is not a valid port (1-65535)." >&2
        done
    else
        PORT=$DEFAULT_PORT
    fi
fi

valid_ip "$HOST"   || die "invalid host IP: $HOST"
valid_port "$PORT" || die "invalid port: $PORT"
for p in "$MQTT_PORT" "$CAPTURE_SOCKET_PORT"; do
    [[ $PORT != "$p" ]] || die "port $PORT is already used by MQTT/capture socket"
done
echo "Using http://$HOST:$PORT"

# restart.sh kills whatever listens on PORT, so warn if it's something else.
if [[ "${NO_START:-0}" != "1" && $ENV_ONLY != 1 ]] && in_use=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null) && [[ -n $in_use ]]; then
    procs=$(ps -o comm= -p "${in_use//$'\n'/,}" | sort -u | tr '\n' ' ')
    if [[ $procs != *uvicorn* && $procs != *python* ]]; then
        echo "Warning: port $PORT is in use by: $procs" >&2
        echo "         Starting Pi Fleet will KILL that process." >&2
        if [[ -t 0 ]]; then
            read -rp "Continue anyway? [y/N] " ok
            [[ $ok == [yY]* ]] || die "aborted; pick another port with -p"
        else
            die "port $PORT is busy; pick another with -p"
        fi
    fi
fi

[[ $EUID -ne 0 ]] || die "run as your normal user, not root (sudo is used where needed)"
[[ -f "$BACKEND_DIR/requirements.txt" ]] || die "$BACKEND_DIR/requirements.txt not found"

# --- 1. System packages ------------------------------------------------------
if [[ $ENV_ONLY == 1 ]]; then
    step "Skipping packages and Mosquitto (--env-only)"
elif [[ "${SKIP_APT:-0}" != "1" ]]; then
    step "Installing system packages"
    sudo apt-get update
    sudo apt-get install -y python3 python3-venv python3-pip mosquitto mosquitto-clients lsof
else
    step "Skipping system packages (SKIP_APT=1)"
fi

# --- 2. Python virtualenv ----------------------------------------------------
# Needed before .env: bcrypt (for the password hash) comes from here.
step "Setting up Python virtualenv at $VENV_DIR"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    python3 -m venv "$VENV_DIR"
fi
if [[ $ENV_ONLY != 1 ]] || ! "$VENV_DIR/bin/python" -c 'import bcrypt' 2>/dev/null; then
    "$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
    "$VENV_DIR/bin/pip" install -r "$BACKEND_DIR/requirements.txt"
fi

# --- 3. .env -----------------------------------------------------------------
# Read a key's value from .env (surrounding quotes removed).
env_get() {
    [[ -f $ENV_FILE ]] || return 0
    local v
    v=$(grep -m1 "^$1=" "$ENV_FILE" | cut -d= -f2-) || true
    v=${v#\'}; v=${v%\'}; v=${v#\"}; v=${v%\"}
    printf '%s' "$v"
}

# Set KEY=VALUE in .env: replace the line if present, otherwise append.
# awk (not sed) so values with / & $ are written literally.
env_set() {
    local tmp
    tmp=$(mktemp "$ENV_FILE.XXXX")
    K="$1" V="$2" awk -F= '
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"] }
        $1 == k { print k "=" v; done = 1; next }
        { print }
        END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
}

# ask VAR "Question" default validator  ->  sets VAR (Enter keeps default)
ask() {
    local __var=$1 q=$2 def=$3 check=${4:-true} ans
    while true; do
        read -rp "  $q [$def]: " ans
        ans=${ans:-$def}
        if [[ -n $ans ]] && $check "$ans"; then printf -v "$__var" '%s' "$ans"; return; fi
        echo "  '$ans' is not valid, try again." >&2
    done
}

valid_name() { [[ $1 =~ ^[A-Za-z0-9_.@-]+$ ]]; }
valid_num()  { [[ $1 =~ ^[0-9]+$ ]] && (( 10#$1 > 0 )); }

ask_password() {
    local pw1 pw2
    while true; do
        read -rsp "  New web login password: " pw1; echo >&2
        read -rsp "  Confirm password: " pw2; echo >&2
        [[ -n $pw1 && $pw1 == "$pw2" ]] && break
        echo "  Passwords empty or don't match, try again." >&2
    done
    # Password goes in on stdin so it never shows up in `ps` output.
    printf '%s' "$pw1" | "$VENV_DIR/bin/python" -c \
        'import sys, bcrypt; print(bcrypt.hashpw(sys.stdin.buffer.read(), bcrypt.gensalt()).decode())'
}

new_jwt_key() { "$VENV_DIR/bin/python" -c 'import secrets; print(secrets.token_urlsafe(48))'; }

yes_no() { local a; read -rp "  $1 [y/N]: " a; [[ $a == [yY]* ]]; }

step "Configuring $ENV_FILE"
if [[ ! -f $ENV_FILE ]]; then
    edit_env=1
    (umask 077; : > "$ENV_FILE")
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

    if [[ $ENV_ONLY == 1 ]]; then
        ask HOST    "Web page IP (0.0.0.0 = all)"    "$DEFAULT_HOST"  valid_ip
        ask PORT    "Web page port"                  "$DEFAULT_PORT"  valid_port
    fi

    # Broker runs on this machine; 0.0.0.0 isn't connectable, so use loopback.
    def_broker=$(env_get MQTT_BROKER_HOST)
    [[ -n $def_broker ]] || def_broker=$([[ $HOST == 0.0.0.0 ]] && echo 127.0.0.1 || echo "$HOST")
    def_mqtt_port=$(env_get MQTT_BROKER_PORT);    def_mqtt_port=${def_mqtt_port:-$MQTT_PORT}
    def_cap_port=$(env_get CAPTURE_SOCKET_PORT);  def_cap_port=${def_cap_port:-$CAPTURE_SOCKET_PORT}
    def_user=$(env_get AUTH_USERNAME);            def_user=${def_user:-admin}
    def_expire=$(env_get JWT_EXPIRE_MINUTES);     def_expire=${def_expire:-720}
    def_db=$(env_get DATABASE_URL);               def_db=${def_db:-sqlite:///./pi_fleet.db}

    ask broker_host "MQTT broker IP"                 "$def_broker"    valid_ip
    ask MQTT_PORT   "MQTT broker port"               "$def_mqtt_port" valid_port
    ask CAPTURE_SOCKET_PORT "Capture socket port"    "$def_cap_port"  valid_port
    ask auth_user   "Web login username"             "$def_user"      valid_name
    ask expire      "Login session length (minutes)" "$def_expire"    valid_num
    ask db_url      "Database URL"                   "$def_db"

    if [[ $broker_host != 127.0.0.1 ]] && ! ip -4 -o addr show | grep -qw "inet $broker_host"; then
        echo "  Warning: $broker_host is not an IP of this machine; the back-end won't reach the broker." >&2
    fi
    for p in "$MQTT_PORT" "$CAPTURE_SOCKET_PORT"; do
        [[ $p != "$PORT" ]] || die "port $p clashes with the web page port"
    done
    [[ $MQTT_PORT != "$CAPTURE_SOCKET_PORT" ]] || die "MQTT and capture socket can't share port $MQTT_PORT"

    env_set DATABASE_URL        "$db_url"
    env_set MQTT_BROKER_HOST    "$broker_host"
    env_set MQTT_BROKER_PORT    "$MQTT_PORT"
    env_set CAPTURE_SOCKET_PORT "$CAPTURE_SOCKET_PORT"
    env_set AUTH_USERNAME       "$auth_user"
    env_set JWT_EXPIRE_MINUTES  "$expire"
    env_set SERVER_HOST         "$HOST"
    env_set SERVER_PORT         "$PORT"

    # Single quotes stop python-dotenv expanding the "$2b$..." in the hash.
    if [[ -z $(env_get AUTH_PASSWORD_HASH) ]] || yes_no "Change the web login password?"; then
        env_set AUTH_PASSWORD_HASH "'$(ask_password)'"
    fi
    if [[ -z $(env_get JWT_SECRET_KEY) ]]; then
        env_set JWT_SECRET_KEY "$(new_jwt_key)"
    elif yes_no "Generate a new JWT secret? (logs everyone out)"; then
        env_set JWT_SECRET_KEY "$(new_jwt_key)"
    fi

    if cmp -s "$ENV_FILE" "$ENV_FILE.bak"; then
        rm -f "$ENV_FILE.bak"
        echo "No changes."
    else
        echo "Saved $ENV_FILE (previous version: $ENV_FILE.bak)"
    fi
else
    # Keep Mosquitto's listener in step with what the back-end connects to.
    MQTT_PORT=$(env_get MQTT_BROKER_PORT); MQTT_PORT=${MQTT_PORT:-1883}
    # Save the IP/port chosen above so a later restart.sh uses them too.
    if [[ $(env_get SERVER_HOST) != "$HOST" || $(env_get SERVER_PORT) != "$PORT" ]]; then
        env_set SERVER_HOST "$HOST"
        env_set SERVER_PORT "$PORT"
        echo "Saved web page address $HOST:$PORT to .env"
    fi
fi

if [[ $ENV_ONLY == 1 ]]; then
    step "Done. Apply the changes with: $BACKEND_DIR/restart.sh"
    echo "If you changed the MQTT port, re-run ./setup.sh so Mosquitto listens on it."
    exit 0
fi

# --- 4. Mosquitto ------------------------------------------------------------
step "Configuring Mosquitto"
if [[ -f "$MOSQUITTO_SRC" ]]; then
    # The stock /etc/mosquitto/mosquitto.conf already sets persistence and
    # logging; only copy our listener/auth lines so the two don't conflict.
    # The MQTT listener uses the port from .env.
    tmp_conf="$(mktemp)"
    grep -E '^[[:space:]]*(listener|protocol|allow_anonymous|password_file)\b' "$MOSQUITTO_SRC" \
        | sed -E "s/^([[:space:]]*listener[[:space:]]+)1883\b/\1$MQTT_PORT/" > "$tmp_conf"
    if ! sudo cmp -s "$tmp_conf" "$MOSQUITTO_DST" 2>/dev/null; then
        sudo install -m 644 "$tmp_conf" "$MOSQUITTO_DST"
        echo "Wrote $MOSQUITTO_DST"
    else
        echo "$MOSQUITTO_DST already up to date"
    fi
    rm -f "$tmp_conf"
fi
sudo systemctl enable mosquitto >/dev/null
sudo systemctl restart mosquitto
systemctl is-active --quiet mosquitto || die "mosquitto failed to start: sudo journalctl -u mosquitto -n 30"
echo "Mosquitto running on port $MQTT_PORT"

# --- 4b. Firewall ------------------------------------------------------------
# The Pis connect in on MQTT and the capture socket; the web page port is for
# browsers on other machines. Opened only when a firewall is actually on.
FW_PORTS=("$MQTT_PORT" "$CAPTURE_SOCKET_PORT" "$PORT")
step "Firewall: allowing TCP ports ${FW_PORTS[*]}"

# Optionally restrict to one subnet (the Pi network) instead of anywhere.
fw_from=""
if [[ "${FW_SOURCE:-}" == any ]]; then
    fw_from=""
elif [[ -n "${FW_SOURCE:-}" ]]; then
    fw_from=$FW_SOURCE
elif [[ -t 0 && $HOST != 0.0.0.0 ]]; then
    subnet=$(ip -4 -o addr show | awk -v ip="$HOST" '{split($4,a,"/")} a[1]==ip {print $4; exit}')
    if [[ -n $subnet ]]; then
        net=$("$VENV_DIR/bin/python" -c "import ipaddress,sys; print(ipaddress.ip_interface(sys.argv[1]).network)" "$subnet")
        yes_no "Allow only from $net (the Pi network)? No = from anywhere" && fw_from=$net
    fi
fi

if command -v ufw >/dev/null && sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    for p in "${FW_PORTS[@]}"; do
        if [[ -n $fw_from ]]; then
            sudo ufw allow from "$fw_from" to any port "$p" proto tcp comment pi-fleet >/dev/null
        else
            sudo ufw allow "$p/tcp" comment pi-fleet >/dev/null
        fi
    done
    echo "ufw: allowed ${FW_PORTS[*]}/tcp from ${fw_from:-anywhere}"
elif command -v firewall-cmd >/dev/null && sudo firewall-cmd --state >/dev/null 2>&1; then
    for p in "${FW_PORTS[@]}"; do
        if [[ -n $fw_from ]]; then
            sudo firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$fw_from port port=$p protocol=tcp accept" >/dev/null
        else
            sudo firewall-cmd --permanent --add-port="$p/tcp" >/dev/null
        fi
    done
    sudo firewall-cmd --reload >/dev/null
    echo "firewalld: allowed ${FW_PORTS[*]}/tcp from ${fw_from:-anywhere}"
else
    echo "No active ufw/firewalld found; nothing to open."
    echo "(If you use plain iptables: sudo iptables -I INPUT -p tcp -m multiport --dports $(IFS=,; echo "${FW_PORTS[*]}") -j ACCEPT)"
fi

# --- 5. Database -------------------------------------------------------------
step "Creating database tables"
# DATABASE_URL is relative (./pi_fleet.db), so run from the back-end dir.
(cd "$BACKEND_DIR" && "$VENV_DIR/bin/python" -c 'import database.models; from database.database import init_db; init_db()')
echo "Database ready"

# --- 6. Start ----------------------------------------------------------------
if [[ "${NO_START:-0}" == "1" ]]; then
    step "Setup done (NO_START=1). Start later with: $BACKEND_DIR/restart.sh"
    exit 0
fi

if [[ "$HOST" != "0.0.0.0" ]] && ! ip -o addr show | grep -qw "inet ${HOST}"; then
    echo "Warning: this machine has no address $HOST; uvicorn will fail to bind." >&2
    echo "         Re-run with HOST=<this machine's IP> or HOST=0.0.0.0" >&2
fi

step "Starting the back-end"
chmod +x "$BACKEND_DIR/restart.sh"
HOST="$HOST" PORT="$PORT" "$BACKEND_DIR/restart.sh"

echo
echo "Pi Fleet page: http://$HOST:$PORT"
echo "Next: on each Pi, run pi_agent/install.sh (its .env must point MQTT at $HOST)."
