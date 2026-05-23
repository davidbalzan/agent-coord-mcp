#!/usr/bin/env bash
# stop-agent.sh — tear down an agent spawned by spawn-agent.sh.
# Kills the tmux session and the tmux-pusher daemon.
#
# Usage:
#   scripts/stop-agent.sh --id frontend
#   scripts/stop-agent.sh --id frontend --dir /custom/coord/dir

set -euo pipefail

ID=""
COORD_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --dir) COORD_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$ID" ]] && { echo "--id required" >&2; exit 2; }

ROOT="${COORD_DIR:-${AGENT_COORD_DIR:-$HOME/agent-coord}}"
PID_FILE="$ROOT/pids/pusher-$ID.pid"
SESSION="coord-$ID"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "stopped pusher pid $PID"
  fi
  rm -f "$PID_FILE"
else
  echo "no pusher pid file for '$ID'"
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION" && echo "killed tmux session $SESSION"
else
  echo "no tmux session '$SESSION'"
fi
