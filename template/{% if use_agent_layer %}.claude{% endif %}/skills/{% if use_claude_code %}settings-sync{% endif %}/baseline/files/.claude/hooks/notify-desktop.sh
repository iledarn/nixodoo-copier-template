#!/usr/bin/env bash
# Notification hook — cross-app desktop popup + sound when Claude Code is waiting
# for permission or input. Reads the hook event JSON on stdin.
# Why: preferredNotifChannel=terminal_bell stays inside VSCode and is silent when
# VSCode is backgrounded; notify-send reaches the KDE daemon regardless of focus.
set -uo pipefail

input=$(cat)
message=$(printf '%s' "$input" \
  | python3 -c "import sys, json; print(json.load(sys.stdin).get('message') or 'Claude Code needs your attention')" \
  2>/dev/null) || message="Claude Code needs your attention"
[ -n "$message" ] || message="Claude Code needs your attention"

notify-send --app-name="Claude Code" --urgency=normal --icon=dialog-information \
  "Claude Code" "$message" 2>/dev/null || true

sound="/usr/share/sounds/freedesktop/stereo/message.oga"
[ -f "$sound" ] && pw-play "$sound" >/dev/null 2>&1 &

exit 0
