#!/bin/bash
# Wrapper for launchd — runs the extraction runner.
# P2.1a: credentials come from ~/.auxilo/credentials.json — no shell env sourcing.
# launchd does NOT inherit interactive shell env.
#
# P1-13: This script is INSTALLED to ~/.auxilo/bin/ by `node scripts/runner.js
# --install-sweeper` (copied, not symlinked). launchd must never execute anything
# under ~/Documents — macOS TCC blocks it ("Operation not permitted"). The RUNNER
# path below resolves relative to this script's own location, so the installed
# copy runs the installed runner.

set -u

# Try to load env vars the way the user's shell would. Best-effort: don't fail if any step fails.
# Load only .zshenv (non-interactive, safe for launchd). No .zshrc (GOV-3: credentials via credentials.json only).
if [ -f "$HOME/.zshenv" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.zshenv" 2>/dev/null || true
fi

# Ensure Node is in PATH (Homebrew default).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUNNER="$SCRIPT_DIR/scripts/runner.js"
LOG="$HOME/.auxilo/extract.log"

mkdir -p "$HOME/.auxilo"

# Kill-switch: sweeper runs only if sentinel file exists.
if [ ! -f "$HOME/.auxilo/autonomous-enabled" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sweeper skipped (autonomous mode not enabled)" >> "$LOG"
  exit 0
fi

# NOTE (P1-13 fix): do NOT export AUXILO_EXTRACTING here. The runner sets it
# itself after passing its own recursion-guard check (runner.js main()).
# Exporting it from the wrapper made the runner's guard trip on every launchd
# run, silently no-opping the sweeper.

# Do NOT redirect stdout into extract.log: the runner's log() already appends
# every line there itself, so the redirect wrote each line twice and the daily
# digest double-counted publish events. launchd captures stdout/stderr via the
# plist's StandardOutPath/StandardErrorPath instead.
exec /usr/bin/env node "$RUNNER"
