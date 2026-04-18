#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────
# migrate-data.sh — move Auxilo /app/data from Conway sandbox → Fly volume
#
# What this does, in order:
#   1. Runs `tar czf` on the Conway sandbox via its /exec API, producing
#      /tmp/auxilo-data.tgz on the Conway side (mtimes preserved by tar).
#   2. Downloads that tarball locally via Conway's /files API.
#   3. SFTPs the tarball into the running Fly machine at /data/…
#   4. SSH-execs `tar xzf` on the Fly side so files land on the mounted
#      volume with their original mtimes and permissions.
#   5. Restarts the Fly machine so server.js re-opens the imported audit
#      chain and catalog cleanly.
#
# Requirements (in PATH):  curl, flyctl, tar
# Requirements (env):      X_PAYMENT, FLY_APP
# Optional env:
#   SANDBOX_ID       — Conway sandbox UUID (default: value below)
#   CONWAY_API_BASE  — Conway management API base (default: official)
#   REMOTE_DATA_DIR  — path inside Conway VM (default: /app/data)
#   FLY_REMOTE_DIR   — path inside Fly machine (default: /app/data)
#   KEEP_LOCAL       — "1" to keep the local tarball after success
#
# Flags:
#   --dry-run   list what would be transferred; hit neither Conway write
#               paths nor Fly write paths
#
# Behaviour:
#   - Idempotent up to the point of extraction. Re-running on a partially
#     populated Fly volume will overlay files (tar extracts in-place),
#     which is safe for append-only JSONL but will OVERWRITE credits.json,
#     accounts.json, earnings.json. Run once, cleanly.
#   - Missing files on the Conway side are tolerated by tar. If /app/data
#     does not exist there, the script exits non-zero before touching Fly.
# ─────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────
: "${X_PAYMENT:?X_PAYMENT (Conway API key) is required}"
: "${FLY_APP:?FLY_APP (Fly app name, e.g. auxilo) is required}"

SANDBOX_ID="${SANDBOX_ID:-ad64fba3-0a7f-4ffd-8d60-2a2c98f8a84f}"
CONWAY_API_BASE="${CONWAY_API_BASE:-https://api.conway.tech/v1/sandboxes}"
REMOTE_DATA_DIR="${REMOTE_DATA_DIR:-/app/data}"
FLY_REMOTE_DIR="${FLY_REMOTE_DIR:-/app/data}"
KEEP_LOCAL="${KEEP_LOCAL:-0}"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

CONWAY_API="${CONWAY_API_BASE}/${SANDBOX_ID}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOCAL_TARBALL="./auxilo-data-${TS}.tgz"
REMOTE_CONWAY_TARBALL="/tmp/auxilo-data-${TS}.tgz"
REMOTE_FLY_TARBALL="/data/auxilo-data-${TS}.tgz"

log()   { printf '[migrate-data] %s\n' "$*"; }
fatal() { printf '[migrate-data][FATAL] %s\n' "$*" >&2; exit 1; }

# ── Helper: run a command inside the Conway sandbox via /exec ───────────
conway_exec() {
  local cmd="$1"
  local label="${2:-$cmd}"
  log "conway exec: ${label}"
  local resp
  resp=$(curl -fsS -X POST "${CONWAY_API}/exec" \
    -H "X-API-Key: ${X_PAYMENT}" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"command":%s}' "$(printf '%s' "$cmd" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
  ) || fatal "conway /exec failed for: ${label}"
  printf '%s\n' "$resp"
}

# ── Helper: download a file from the Conway sandbox via /files ──────────
conway_download() {
  local remote_path="$1"
  local local_path="$2"
  log "conway download: ${remote_path} → ${local_path}"
  curl -fsS "${CONWAY_API}/files?path=${remote_path}" \
    -H "X-API-Key: ${X_PAYMENT}" \
    -o "${local_path}" \
    || fatal "conway /files GET failed for ${remote_path}"
}

# ── Sanity: flyctl authenticated and app reachable ──────────────────────
if ! flyctl auth whoami >/dev/null 2>&1; then
  fatal "flyctl not authenticated. Run: flyctl auth login"
fi
if ! flyctl status --app "${FLY_APP}" >/dev/null 2>&1; then
  fatal "Fly app '${FLY_APP}' not found or not accessible."
fi

# ── Step 1: inventory the Conway data directory (always, even in dry-run)
log "listing ${REMOTE_DATA_DIR} on Conway sandbox ${SANDBOX_ID} …"
LISTING=$(conway_exec "ls -la ${REMOTE_DATA_DIR} 2>/dev/null || echo '__MISSING__'" "ls ${REMOTE_DATA_DIR}")
printf '%s\n' "${LISTING}"

if printf '%s' "${LISTING}" | grep -q '__MISSING__'; then
  fatal "${REMOTE_DATA_DIR} does not exist on Conway. Nothing to migrate."
fi

# Also capture a file manifest with sizes + mtimes for the dry-run report
MANIFEST=$(conway_exec \
  "find ${REMOTE_DATA_DIR} -type f -printf '%TY-%Tm-%Td %TH:%TM  %10s  %p\n' | sort" \
  "manifest ${REMOTE_DATA_DIR}")
printf '\n── File manifest ──\n%s\n───────────────────\n\n' "${MANIFEST}"

if [[ "${DRY_RUN}" -eq 1 ]]; then
  log "DRY RUN complete. No files transferred. No Fly-side writes performed."
  exit 0
fi

# ── Step 2: tar the data dir on Conway ──────────────────────────────────
# `tar czf` preserves mtimes. --exclude keeps the pre-migration backup
# copies out (there are ~20 of them and they are redundant with the
# live earnings.json).
log "creating tarball on Conway → ${REMOTE_CONWAY_TARBALL}"
conway_exec \
  "cd /app && tar czf ${REMOTE_CONWAY_TARBALL} --exclude='data/*.pre-migration-*' data && ls -la ${REMOTE_CONWAY_TARBALL}" \
  "tar czf ${REMOTE_CONWAY_TARBALL}"

# ── Step 3: download the tarball locally ────────────────────────────────
conway_download "${REMOTE_CONWAY_TARBALL}" "${LOCAL_TARBALL}"
LOCAL_SIZE=$(wc -c < "${LOCAL_TARBALL}" | tr -d ' ')
log "downloaded ${LOCAL_TARBALL} (${LOCAL_SIZE} bytes)"
[[ "${LOCAL_SIZE}" -lt 100 ]] && fatal "tarball suspiciously small; aborting"

# Leave a breadcrumb on the local side: verify the tarball is valid gzip
tar tzf "${LOCAL_TARBALL}" > /dev/null || fatal "local tarball failed integrity check"
log "tarball integrity OK"

# ── Step 4: SFTP the tarball into the Fly machine ───────────────────────
# `flyctl ssh sftp shell` is interactive; use `flyctl ssh sftp put` which
# takes (local, remote) and exits non-zero on failure.
log "uploading tarball to Fly machine at ${REMOTE_FLY_TARBALL}"
flyctl ssh sftp shell --app "${FLY_APP}" <<SFTP_EOF || fatal "sftp upload failed"
put ${LOCAL_TARBALL} ${REMOTE_FLY_TARBALL}
SFTP_EOF

# ── Step 5: extract on Fly volume + chown ───────────────────────────────
# -p  preserves permissions
# -m  would CLOBBER mtimes (the default tar behaviour is to preserve); we
#     want preservation, so we do NOT pass -m.
# Extracting with `-C /app` means the `data/` entries in the tarball land
# at `/app/data/…`, which is the mounted volume path.
log "extracting tarball on Fly volume"
flyctl ssh console --app "${FLY_APP}" -C "sh -c '
  set -e
  cd /app
  tar xzpf ${REMOTE_FLY_TARBALL}
  chown -R node:node /app/data
  rm -f ${REMOTE_FLY_TARBALL}
  echo ---
  ls -la /app/data | head -20
  echo ---
  find /app/data -type f | wc -l
'" || fatal "extract-on-fly failed"

# ── Step 6: clean up the Conway-side tarball (best effort) ──────────────
conway_exec "rm -f ${REMOTE_CONWAY_TARBALL}" "cleanup conway tarball" >/dev/null || true

# ── Step 7: restart the Fly machine so server re-reads audit chain ──────
log "restarting Fly machine so server.js re-opens the imported state"
flyctl machine restart --app "${FLY_APP}" || fatal "flyctl machine restart failed"

# Wait for health to go green
log "waiting for /health on Fly (max 60s) …"
ATTEMPTS=0
until flyctl status --app "${FLY_APP}" 2>/dev/null | grep -q "started"; do
  ATTEMPTS=$((ATTEMPTS + 1))
  [[ "${ATTEMPTS}" -ge 30 ]] && fatal "machine did not report 'started' within 60s"
  sleep 2
done

# ── Step 8: optionally keep the local tarball as a belt-and-suspenders ──
if [[ "${KEEP_LOCAL}" != "1" ]]; then
  log "removing local tarball ${LOCAL_TARBALL} (set KEEP_LOCAL=1 to retain)"
  rm -f "${LOCAL_TARBALL}"
else
  log "local tarball retained at ${LOCAL_TARBALL}"
fi

log "DONE. Verify with: curl -fsS https://${FLY_APP}.fly.dev/stats | head -c 200"
