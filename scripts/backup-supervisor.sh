#!/bin/sh
# scripts/backup-supervisor.sh — Wave 2a (LW-4): 6h loop around backup-runner.js.
#
# Spawned as a BACKGROUND sibling of the server by docker-entrypoint.sh (as
# the node user). Crash-isolation contract:
#   - this script never exits nonzero into anything the server's supervision
#     sees (it is backgrounded; its exit affects nothing),
#   - a runner crash/failure is logged and retried in 30 min,
#   - exit code 2 from the runner means "unconfigured" -> feature off, loop ends.
# The runner is one-shot, so no backup memory is held between cycles
# (matters on the 512MB VM).

INTERVAL_OK=21600    # 6h between successful cycles
INTERVAL_FAIL=1800   # 30 min retry after a failed cycle

echo "[backup-supervisor] started (cycle every ${INTERVAL_OK}s)"

while :; do
  node /app/scripts/backup-runner.js
  code=$?
  if [ "$code" -eq 2 ]; then
    echo "[backup-supervisor] runner unconfigured (exit 2) — backups disabled, supervisor exiting"
    exit 0
  elif [ "$code" -ne 0 ]; then
    echo "[backup-supervisor] cycle failed (exit $code) — retry in ${INTERVAL_FAIL}s"
    sleep "$INTERVAL_FAIL"
  else
    sleep "$INTERVAL_OK"
  fi
done
