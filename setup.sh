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
# Usage:  ./setup.sh
#   HOST=192.168.150.20 PORT=8000 ./setup.sh     # override bind address/port
#   SKIP_APT=1 ./setup.sh                         # skip system packages
#   NO_START=1 ./setup.sh                         # set up but don't start
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/FastAPI/back-end"
VENV_DIR="$ROOT_DIR/.venv"
ENV_FILE="$BACKEND_DIR/.env"
MOSQUITTO_SRC="$ROOT_DIR/mosquitto.conf"
MOSQUITTO_DST="/etc/mosquitto/conf.d/pi-fleet.conf"

HOST="${HOST:-192.168.150.20}"
PORT="${PORT:-8000}"
MQTT_PORT="${MQTT_PORT:-1883}"
CAPTURE_SOCKET_PORT="${CAPTURE_SOCKET_PORT:-9200}"

step() { echo; echo "==> $*"; }
die()  { echo "Error: $*" >&2; exit 1; }

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
