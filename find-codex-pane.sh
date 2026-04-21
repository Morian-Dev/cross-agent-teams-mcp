#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  find-codex-pane.sh [--pid PID | --tty TTY] [--pattern REGEX] [--pane-only]

Options:
  --pid PID        Limit the search to the tmux pane owning this process tty.
  --tty TTY        Limit the search to a tty like ttys026 or /dev/ttys026.
  --pattern REGEX  Override the process match regex.
  --pane-only      Print only matching pane ids.
  -h, --help       Show this help message.

Default match regex:
  (^|[[:space:]/])(codex|codex-aarch64-a)( |$)

Notes:
  - This script ignores "codex app-server".
  - It identifies panes by mapping pane tty -> real tty processes.
EOF
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

normalize_tty() {
  local raw="$1"
  raw="${raw#/dev/}"
  printf '%s\n' "$raw"
}

SEARCH_PATTERN='(^|[[:space:]/])(codex|codex-aarch64-a)( |$)'
TARGET_PID=''
TARGET_TTY=''
PANE_ONLY=0

while (($# > 0)); do
  case "$1" in
    --pid)
      [[ $# -ge 2 ]] || {
        echo "--pid requires a value" >&2
        exit 1
      }
      TARGET_PID="$2"
      shift 2
      ;;
    --tty)
      [[ $# -ge 2 ]] || {
        echo "--tty requires a value" >&2
        exit 1
      }
      TARGET_TTY="$(normalize_tty "$2")"
      shift 2
      ;;
    --pattern)
      [[ $# -ge 2 ]] || {
        echo "--pattern requires a value" >&2
        exit 1
      }
      SEARCH_PATTERN="$2"
      shift 2
      ;;
    --pane-only)
      PANE_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd tmux
require_cmd ps
require_cmd awk

if [[ -n "$TARGET_PID" && -n "$TARGET_TTY" ]]; then
  echo "use either --pid or --tty, not both" >&2
  exit 1
fi

if [[ -n "$TARGET_PID" ]]; then
  TARGET_TTY="$(
    ps -p "$TARGET_PID" -o tty= 2>/dev/null | tr -d '[:space:]'
  )"
  if [[ -z "$TARGET_TTY" || "$TARGET_TTY" == "??" ]]; then
    echo "could not resolve tty for pid: $TARGET_PID" >&2
    exit 1
  fi
fi

matches=()
pane_rows="$(
  tmux list-panes -a -F '#{pane_id}	#{session_name}	#{window_index}	#{pane_index}	#{pane_active}	#{pane_tty}	#{pane_pid}	#{pane_current_command}	#{pane_title}'
)"

while IFS=$'\t' read -r pane_id session_name window_index pane_index pane_active pane_tty pane_pid pane_command pane_title; do
  [[ -n "$pane_id" ]] || continue

  short_tty="$(normalize_tty "$pane_tty")"
  if [[ -n "$TARGET_TTY" && "$short_tty" != "$TARGET_TTY" ]]; then
    continue
  fi

  tty_processes="$(ps -t "$short_tty" -o pid=,ppid=,stat=,command= 2>/dev/null || true)"
  [[ -n "$tty_processes" ]] || continue

  matched_processes="$(
    printf '%s\n' "$tty_processes" | awk -v pattern="$SEARCH_PATTERN" '
      BEGIN { IGNORECASE = 1 }
      {
        line = $0
        if (line ~ /codex app-server/) next
        if (line ~ /find-codex-pane\.sh/) next
        if (line ~ pattern) print line
      }
    '
  )"
  [[ -n "$matched_processes" ]] || continue

  if (( PANE_ONLY == 1 )); then
    matches+=("$pane_id")
    continue
  fi

  matches+=(
"$pane_id
  session=$session_name window=$window_index pane=$pane_index active=$pane_active
  tty=$short_tty pane_pid=$pane_pid pane_command=$pane_command
  title=$pane_title
  matched_processes:
$(printf '%s\n' "$matched_processes" | sed 's/^/    /')"
  )
done <<<"$pane_rows"

if ((${#matches[@]} == 0)); then
  if [[ -n "$TARGET_TTY" ]]; then
    echo "no matching pane found for tty=$TARGET_TTY" >&2
  else
    echo "no matching pane found" >&2
  fi
  exit 1
fi

printf '%s\n' "${matches[@]}"
