#!/bin/bash
# Wrapper for launchd — runs the extraction runner.
# P2.1a: credentials come from ~/.auxilo/credentials.json — no shell env sourcing.
# launchd does NOT inherit interactive shell env.

set -u

# Try to load env vars the way the user's shell would. Best-effort: don't fail if any step fails.
# Load only .zshenv (non-interactive, safe for launchd). No .zshrc (GOV-3: credentials via credentials.json only).
if [ -f "$HOME/.zshenv" ]; then
  # shellcheck disable=SC1091
  source "$HOME/.zshenv" 2>/dev/null || true
fi

# Ensure Node is in PATH (Homebrew default).
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

RUNNER="/Users/iamtylerkelley/Documents/Custom/auxilo/scripts/runner.js"
LOG="$HOME/.auxilo/extract.log"

mkdir -p "$HOME/.auxilo"

# Kill-switch: sweeper runs only if sentinel file exists.
if [ ! -f "$HOME/.auxilo/autonomous-enabled" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] sweeper skipped (autonomous mode not enabled)" >> "$LOG"
  exit 0
fi

# Mark this as an extraction run so any nested hooks bail out.
export AUXILO_EXTRACTING=1

exec /usr/bin/env node "$RUNNER" >> "$LOG" 2>&1
