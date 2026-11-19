#!/usr/bin/env bash
# One-shot setup for the Pi Fleet Controller server (the machine that hosts
# the web page, the FastAPI back-end and the Mosquitto broker).
#
# What it does (safe to re-run; each step skips work that's already done):
#   1. Installs system packages: python3-venv, mosquitto, lsof
#   2. Configures Mosquitto from ./mosquitto.conf and enables it on boot
#   3. Creates ./.venv and installs FastAPI/back-end/requirements.txt
#   4. Creates FastAPI/back-end/.env (asks for a login, generates a JWT key)
#      - an existing .env is never overwritten
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
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/FastAPI/back-end"
VENV_DIR="$ROOT_DIR/.venv"
ENV_FILE="$BACKEND_DIR/.env"
MOSQUITTO_SRC="$ROOT_DIR/mosquitto.conf"
MOSQUITTO_DST="/etc/mosquitto/conf.d/pi-fleet.conf"

DEFAULT_HOST="192.168.150.20"
DEFAULT_PORT="8000"
HOST="${HOST:-}"
PORT="${PORT:-}"
MQTT_PORT="${MQTT_PORT:-1883}"
CAPTURE_SOCKET_PORT="${CAPTURE_SOCKET_PORT:-9200}"

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
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
done

# --- Ask for host/port if not given (only when run from a terminal) ----------
if [[ -z $HOST ]]; then
    if [[ -t 0 ]]; then
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
    if [[ -t 0 ]]; then
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
if [[ "${NO_START:-0}" != "1" ]] && in_use=$(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null) && [[ -n $in_use ]]; then
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
if [[ "${SKIP_APT:-0}" != "1" ]]; then
    step "Installing system packages"
    sudo apt-get update
    sudo apt-get install -y python3 python3-venv python3-pip mosquitto mosquitto-clients lsof
else
    step "Skipping system packages (SKIP_APT=1)"
fi

# --- 2. Mosquitto ------------------------------------------------------------
step "Configuring Mosquitto"
if [[ -f "$MOSQUITTO_SRC" ]]; then
    # The stock /etc/mosquitto/mosquitto.conf already sets persistence and
    # logging; only copy our listener/auth lines so the two don't conflict.
    tmp_conf="$(mktemp)"
    grep -E '^[[:space:]]*(listener|protocol|allow_anonymous|password_file)\b' \
        "$MOSQUITTO_SRC" > "$tmp_conf"
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

# --- 3. Python virtualenv ----------------------------------------------------
step "Setting up Python virtualenv at $VENV_DIR"
if [[ ! -x "$VENV_DIR/bin/python" ]]; then
    python3 -m venv "$VENV_DIR"
fi
"$VENV_DIR/bin/pip" install --upgrade pip >/dev/null
"$VENV_DIR/bin/pip" install -r "$BACKEND_DIR/requirements.txt"

# --- 4. .env -----------------------------------------------------------------
step "Configuring $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
    echo ".env already exists, leaving it unchanged"
else
    read -rp "Web login username [admin]: " auth_user
    auth_user="${auth_user:-admin}"
    while true; do
        read -rsp "Web login password: " pw1; echo
        read -rsp "Confirm password: " pw2; echo
        [[ -n "$pw1" && "$pw1" == "$pw2" ]] && break
        echo "Passwords empty or don't match, try again." >&2
    done

    # Password goes in on stdin so it never shows up in `ps` output.
    pw_hash="$(printf '%s' "$pw1" | "$VENV_DIR/bin/python" -c \
        'import sys, bcrypt; print(bcrypt.hashpw(sys.stdin.buffer.read(), bcrypt.gensalt()).decode())')"
    unset pw1 pw2
    jwt_key="$("$VENV_DIR/bin/python" -c 'import secrets; print(secrets.token_urlsafe(48))')"

    # Single quotes stop python-dotenv expanding the "$2b$..." in the hash.
    umask 077
    cat > "$ENV_FILE" <<EOF
DATABASE_URL=sqlite:///./pi_fleet.db
MQTT_BROKER_HOST=$([[ "$HOST" == "0.0.0.0" ]] && echo 127.0.0.1 || echo "$HOST")
MQTT_BROKER_PORT=$MQTT_PORT
CAPTURE_SOCKET_PORT=$CAPTURE_SOCKET_PORT
AUTH_USERNAME=$auth_user
AUTH_PASSWORD_HASH='$pw_hash'
JWT_SECRET_KEY=$jwt_key
JWT_EXPIRE_MINUTES=720
EOF
    umask 022
    echo "Created $ENV_FILE (mode 600)"
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
