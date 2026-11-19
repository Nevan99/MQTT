#!/usr/bin/env bash
# Start (or restart) the Pi Fleet Controller backend as a background daemon.
# Kills whatever is currently listening on PORT first, so re-running this
# after an unclean exit (stale reload worker, crashed process, etc.) just works.
# Output goes to LOG_FILE; set FOREGROUND=1 to run attached instead.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Host/port: HOST=/PORT= env vars win, then SERVER_HOST/SERVER_PORT in .env
# (written by ../../setup.sh), then the defaults.
env_val() { grep -m1 "^$1=" "$BACKEND_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d "'\"" || true; }
HOST="${HOST:-$(env_val SERVER_HOST)}"; HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-$(env_val SERVER_PORT)}"; PORT="${PORT:-8000}"

if [ "$HOST" != "0.0.0.0" ] && ! ip -4 -o addr show | grep -qw "inet $HOST"; then
  echo "Error: this machine has no IP $HOST (Errno 99 if uvicorn tried to bind it)." >&2
  echo "Its IPs: $(ip -4 -o addr show scope global | awk '{split($4,a,"/"); printf "%s ", a[1]}')" >&2
  echo "Fix: ../../setup.sh --env-only  (set the web page IP), or HOST=<ip> $0" >&2
  exit 1
fi
VENV_ACTIVATE="$BACKEND_DIR/../../.venv/bin/activate"
LOG_FILE="${LOG_FILE:-$BACKEND_DIR/fleet.log}"

existing_pids="$(lsof -ti "tcp:$PORT" || true)"
if [ -n "$existing_pids" ]; then
  echo "Stopping existing process(es) on port $PORT: $existing_pids"
  kill $existing_pids
  sleep 1
  still_running="$(lsof -ti "tcp:$PORT" || true)"
  if [ -n "$still_running" ]; then
    echo "Still running, force killing: $still_running"
    kill -9 $still_running
    sleep 1
  fi
fi

# shellcheck disable=SC1090
source "$VENV_ACTIVATE"
cd "$BACKEND_DIR"
if [ "${FOREGROUND:-0}" = "1" ]; then
  exec uvicorn src.main:app --host "$HOST" --port "$PORT" --reload
fi

setsid nohup uvicorn src.main:app --host "$HOST" --port "$PORT" --reload \
  >>"$LOG_FILE" 2>&1 </dev/null &
pid=$!

sleep 2
if kill -0 "$pid" 2>/dev/null; then
  echo "Pi Fleet started (pid $pid) on http://$HOST:$PORT"
  echo "Logs: tail -f $LOG_FILE"
  echo "Stop: kill \$(lsof -ti tcp:$PORT)"
else
  echo "Pi Fleet failed to start; last log lines:" >&2
  tail -n 20 "$LOG_FILE" >&2
  exit 1
fi
