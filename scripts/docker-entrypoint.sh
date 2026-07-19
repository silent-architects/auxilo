#!/bin/sh
# scripts/docker-entrypoint.sh — production entrypoint for the Fly container.
#
# Why this exists: Fly volumes restored from the legacy host's tarballs had root:root
# ownership on files (tar preserves source ownership by default). The
# `node` user (uid 1000) couldn't read them and the server crashed with
# EACCES on startup. Earlier fix (commit 1ecf811) removed `USER node`
# from the Dockerfile so the container runs as root — unblocking pilot
# but regressing security posture.
#
# This entrypoint runs as root, repairs ownership on the volume
# mountpoint (idempotent, cheap — `chown -R` on ~200 files takes <100ms),
# then exec's the main node process under the `node` user via su-exec.
# The container is root only for the tiny startup window and node only
# thereafter.
#
# su-exec is the Alpine equivalent of gosu — tiny static binary, no
# shell injection, preserves signals for clean SIGTERM handling.

set -eu

# Only chown if the data dir exists (it will on Fly — mounted volume;
# may not exist in pure `docker run` without a volume).
if [ -d /app/data ]; then
  chown -R node:node /app/data
fi

# Also ensure the app tree is node-owned for any files the server
# writes (logs, etc). /app itself is baked in from the image, but node
# needs write access to subdirs like /app/data/backups.
chown node:node /app 2>/dev/null || true

# Wave 2a (LW-4): off-VM backup runner — spawned as a crash-isolated
# BACKGROUND sibling of the server, as the node user. Only starts when the
# backup env is present (staged secrets activate at deploy), so local
# `docker run` and unconfigured machines are unaffected. A supervisor/runner
# failure can never block or kill the server: it is a separate process and
# nothing here waits on it.
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] && [ -n "${BUCKET_NAME:-}${BACKUP_S3_BUCKET:-}" ]; then
  echo "[entrypoint] starting backup supervisor (LW-4 off-VM backups)"
  su-exec node sh /app/scripts/backup-supervisor.sh &
else
  echo "[entrypoint] backup env not set — off-VM backup runner disabled"
fi

# Hand off to node under the node user. `exec` replaces the shell
# process so signals from tini → su-exec → node work correctly.
exec su-exec node "$@"
