#!/bin/bash
# Auxilo SessionEnd hook — packaged template (LW-12).
#
# Preferred install path: `npx auxilo setup` GENERATES a copy of this hook at
# ~/.auxilo/bin/auxilo-extract.sh with absolute paths embedded (lib/installer.js
# renderHookScript). This template is the $HOME-relative fallback used by the
# legacy `scripts/runner.js --install-hooks` copy step.
#
# Reads the Claude Code SessionEnd JSON from stdin, extracts the transcript
# path, and spawns the extraction runner detached so shutdown is not blocked.
# Runner location per P1-13: executable surface lives in ~/.auxilo/bin —
# NEVER under ~/Documents (macOS TCC blocks launchd/hook execution there).

set -u

# Kill-switch: runner fires only if the consent sentinel exists.
#   enable:  npx auxilo setup (consent step)   disable: npx auxilo disable
if [ ! -f "$HOME/.auxilo/autonomous-enabled" ]; then
  exit 0
fi

# Recursion guard: bail if we're already inside an extraction chain.
if [ "${AUXILO_EXTRACTING:-0}" = "1" ]; then
  exit 0
fi

input_json=$(cat)

transcript_path=$(printf '%s' "$input_json" | /usr/bin/env node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).transcript_path||"")}catch{}})' 2>/dev/null)

if [ -z "$transcript_path" ] || [ ! -f "$transcript_path" ]; then
  exit 0
fi

RUNNER="$HOME/.auxilo/bin/scripts/runner.js"
if [ ! -f "$RUNNER" ]; then
  exit 0
fi

mkdir -p "$HOME/.auxilo"
LOG="$HOME/.auxilo/extract.log"

# Spawn detached — do not block session teardown.
# P1-13 lesson: do NOT set AUXILO_EXTRACTING here — runner.js's own recursion
# guard would trip and silently no-op every run. The runner sets it itself
# for child processes.
nohup /usr/bin/env node "$RUNNER" --transcript "$transcript_path" >> "$LOG" 2>&1 &

exit 0
