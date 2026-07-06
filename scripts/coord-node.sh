#!/usr/bin/env bash
# coord-node.sh — one-command onboarding for a REMOTE machine to join the coord bus.
#
# The networked counterpart to spawn-agent.sh. spawn-agent.sh wires a LOCAL agent
# to a bus on the same box (hooks/tmux-pusher.mjs, reads the filesystem);
# coord-node wires a REMOTE agent to a networked bus over HTTP
# (scripts/coord-pusher.mjs). It:
#   1. starts a tmux session running your agent CLI,
#   2. auto-resolves that pane's tmux target,
#   3. launches the coord-pusher daemon pointed at the bus with this node's token.
#
# MVP daemon: per-node token. The operator mints a per-agent entry in the bus's
# tokens.json and passes that token here (single-use enrollment tokens + mTLS are
# a later step). It reuses spawn-agent.sh's tmux/pid conventions, so
# `scripts/stop-agent.sh --id <id>` also tears a coord-node down.
#
# Usage:
#   scripts/coord-node.sh --server <url> --token <tok> --id <agent-id> \
#                         [--cmd 'claude'] [--allowlist a,b] [--no-room] [--dir <coord-dir>]
#
# Prefer the AGENT_COORD_TOKEN env var over --token so the secret never lands in
# your shell history or this script's argv:
#   AGENT_COORD_TOKEN=tk_abc scripts/coord-node.sh --server https://bus:8765/mcp --id worker-2

set -euo pipefail

SERVER="${AGENT_COORD_SERVER:-}"
TOKEN="${AGENT_COORD_TOKEN:-}"
ID=""
CMD="claude"
ALLOWLIST=""
NO_ROOM=""
COORD_DIR=""

# tolerate an optional leading 'up' verb for symmetry with future subcommands
[[ "${1:-}" == "up" ]] && shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)     SERVER="$2"; shift 2 ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --id|--agent) ID="$2"; shift 2 ;;
    --cmd)        CMD="$2"; shift 2 ;;
    --allowlist)  ALLOWLIST="$2"; shift 2 ;;
    --no-room)    NO_ROOM=1; shift ;;
    --dir)        COORD_DIR="$2"; shift 2 ;;
    -h|--help)    sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$SERVER" ]] && { echo "--server (or AGENT_COORD_SERVER) required" >&2; exit 2; }
[[ -z "$TOKEN"  ]] && { echo "--token (or AGENT_COORD_TOKEN) required"  >&2; exit 2; }
[[ -z "$ID"     ]] && { echo "--id required" >&2; exit 2; }

command -v tmux >/dev/null || { echo "tmux not installed" >&2; exit 1; }
command -v node >/dev/null || { echo "node not installed" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSHER="$REPO_DIR/scripts/coord-pusher.mjs"
[[ -f "$PUSHER" ]] || { echo "missing $PUSHER" >&2; exit 1; }

ROOT="${COORD_DIR:-${AGENT_COORD_DIR:-$HOME/agent-coord}}"
LOGDIR="$ROOT/logs"
PIDDIR="$ROOT/pids"
mkdir -p "$LOGDIR" "$PIDDIR"

SESSION="coord-$ID"
PID_FILE="$PIDDIR/pusher-$ID.pid"

if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "node daemon already running for '$ID' (pid $(cat "$PID_FILE"))" >&2
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attach with: tmux attach -t $SESSION" >&2
else
  tmux new-session -d -s "$SESSION" -n agent "$CMD"
fi

TARGET="$(tmux display-message -p -t "$SESSION:agent" '#{pane_id}')"
[[ -n "$TARGET" ]] || { echo "failed to resolve tmux pane id" >&2; exit 1; }

# Token travels via env, not argv, so it does not appear in `ps` for the daemon.
ARGS=(--server "$SERVER" --agent "$ID" --tmux "$TARGET")
[[ -n "$ALLOWLIST" ]] && ARGS+=(--allowlist "$ALLOWLIST")
[[ -n "$NO_ROOM"   ]] && ARGS+=(--no-room)

AGENT_COORD_TOKEN="$TOKEN" nohup node "$PUSHER" "${ARGS[@]}" \
  >> "$LOGDIR/pusher-$ID.log" 2>&1 &
echo $! > "$PID_FILE"

echo "coord-node '$ID' up:"
echo "  agent:  tmux attach -t $SESSION   (running: $CMD)"
echo "  bus:    $SERVER"
echo "  daemon: pid $(cat "$PID_FILE")  log: $LOGDIR/pusher-$ID.log"
echo "  stop:   scripts/stop-agent.sh --id $ID"
