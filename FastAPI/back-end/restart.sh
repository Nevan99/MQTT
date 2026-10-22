#!/usr/bin/env bash
# Start (or restart) the Pi Fleet Controller backend as a background daemon.
# Kills whatever is currently listening on PORT first, so re-running this
# after an unclean exit (stale reload worker, crashed process, etc.) just works.
# Output goes to LOG_FILE; set FOREGROUND=1 to run attached instead.
set -euo pipefail

HOST="${HOST:-192.168.150.20}"
PORT="${PORT:-8000}"
BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
