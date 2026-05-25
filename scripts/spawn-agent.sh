#!/usr/bin/env bash
# spawn-agent.sh — start a CLI agent in a dedicated tmux session and wire
# coord-inbox auto-delivery to its pane via hooks/tmux-pusher.mjs.
#
# Works with any line-driven CLI agent (Claude Code, Aider, codex, gemini-cli,
# opencode, ...). The pusher just types into the pane; it doesn't care what's
# on the receiving end.
#
# Usage:
#   scripts/spawn-agent.sh --id frontend --cmd "claude"
#   scripts/spawn-agent.sh --id backend  --cmd "aider --model sonnet" --include-room
#   scripts/spawn-agent.sh --id worker   --cmd "codex" --allowlist frontend,backend
#
# Flags:
#   --id <agentId>          coord agentId, also names the tmux session (coord-<id>)
#   --cmd "<command>"       agent CLI to run in pane 0 (quote it)
#   --no-include-room       skip shared-room delivery (DMs only). Room is on by default.
#   --include-room          deprecated no-op, kept for back-compat (room is on by default)
#   --allowlist a,b,c       only deliver DMs from these peer agentIds
#   --dir <path>            override AGENT_COORD_DIR
#
# After spawn, attach with: tmux attach -t coord-<id>
# Stop with:                scripts/stop-agent.sh --id <id>

set -euo pipefail

ID=""
CMD=""
# Room delivery is on by default; pass --no-include-room to opt out.
INCLUDE_ROOM="1"
ALLOWLIST=""
COORD_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --id) ID="$2"; shift 2 ;;
    --cmd) CMD="$2"; shift 2 ;;
    --include-room) INCLUDE_ROOM="1"; shift ;;         # kept for back-compat
    --no-include-room) INCLUDE_ROOM=""; shift ;;
    --allowlist) ALLOWLIST="$2"; shift 2 ;;
    --dir) COORD_DIR="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[[ -z "$ID"  ]] && { echo "--id required"  >&2; exit 2; }
[[ -z "$CMD" ]] && { echo "--cmd required (e.g. 'claude')" >&2; exit 2; }

command -v tmux >/dev/null || { echo "tmux not installed" >&2; exit 1; }
command -v node >/dev/null || { echo "node not installed" >&2; exit 1; }

SESSION="coord-$ID"
ROOT="${COORD_DIR:-${AGENT_COORD_DIR:-$HOME/agent-coord}}"
LOGDIR="$ROOT/logs"
PIDDIR="$ROOT/pids"
mkdir -p "$LOGDIR" "$PIDDIR"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PUSHER="$REPO_DIR/hooks/tmux-pusher.mjs"
[[ -f "$PUSHER" ]] || { echo "missing $PUSHER" >&2; exit 1; }

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists — attach with: tmux attach -t $SESSION" >&2
  exit 1
fi

PID_FILE="$PIDDIR/pusher-$ID.pid"
if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "pusher already running for '$ID' (pid $(cat "$PID_FILE"))" >&2
  exit 1
fi

tmux new-session -d -s "$SESSION" -n agent "$CMD"

# Resolve the actual pane id — globally unique, immune to base-index settings.
TARGET="$(tmux display-message -p -t "$SESSION:agent" '#{pane_id}')"
[[ -n "$TARGET" ]] || { echo "failed to resolve tmux pane id" >&2; exit 1; }

(
  export AGENT_COORD_ID="$ID"
  export AGENT_COORD_TMUX_TARGET="$TARGET"
  [[ -n "$COORD_DIR"      ]] && export AGENT_COORD_DIR="$COORD_DIR"
  [[ -n "$INCLUDE_ROOM"   ]] && export AGENT_COORD_INCLUDE_ROOM=1
  [[ -n "$ALLOWLIST"      ]] && export AGENT_COORD_ALLOWLIST="$ALLOWLIST"
  nohup node "$PUSHER" >> "$LOGDIR/pusher-$ID.log" 2>&1 &
  echo $! > "$PID_FILE"
)

echo "agent '$ID' started"
echo "  attach: tmux attach -t $SESSION"
echo "  pusher: pid $(cat "$PID_FILE")  log: $LOGDIR/pusher-$ID.log"
echo "  stop:   scripts/stop-agent.sh --id $ID"
