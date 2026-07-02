#!/usr/bin/env bash
# ─── S22-2: Automated Off-VM Backup Script ───────────────────────────────────
# Tar + gzip critical data files, store locally (keep last 7), and upload
# to a private GitHub Gist for off-VM redundancy.
#
# Usage: ./scripts/backup.sh
# Cron:  Every 6 hours via setup-cron.sh
#
# Requires:
#   - GITHUB_TOKEN env var (with gist scope) for off-VM upload
#   - BACKUP_GIST_ID env var (optional — created on first run if not set)
#
# Exit codes: 0 = success, 1 = failure
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_DIR/data"
BACKUP_DIR="$DATA_DIR/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILENAME="auxilo-backup-${TIMESTAMP}.tar.gz"
BACKUP_PATH="$BACKUP_DIR/$BACKUP_FILENAME"
MAX_LOCAL_BACKUPS=7

# ─── Ensure backup directory exists ──────────────────────────────────────────
mkdir -p "$BACKUP_DIR"

echo "[backup] Starting backup at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "[backup] Project directory: $PROJECT_DIR"

# ─── Collect files to backup ─────────────────────────────────────────────────
# Build a list of files/directories that exist
BACKUP_FILES=()

declare -a CRITICAL_FILES=(
  "data/earnings.json"
  "data/accounts.json"
  "data/learnings.json"
  "data/settlements.jsonl"
  "data/tx-hashes.log"
  "data/reports.log"
)

declare -a CRITICAL_DIRS=(
  "data/wal"
)

for f in "${CRITICAL_FILES[@]}"; do
  if [ -f "$PROJECT_DIR/$f" ]; then
    BACKUP_FILES+=("$f")
  else
    echo "[backup] [SKIP] $f does not exist"
  fi
done

for d in "${CRITICAL_DIRS[@]}"; do
  if [ -d "$PROJECT_DIR/$d" ]; then
    BACKUP_FILES+=("$d")
  else
    echo "[backup] [SKIP] $d/ does not exist"
  fi
done

if [ ${#BACKUP_FILES[@]} -eq 0 ]; then
  echo "[backup] [ERROR] No data files found to backup"
  exit 1
fi

echo "[backup] Archiving ${#BACKUP_FILES[@]} items: ${BACKUP_FILES[*]}"

# ─── Create tar.gz archive ──────────────────────────────────────────────────
cd "$PROJECT_DIR"
tar -czf "$BACKUP_PATH" "${BACKUP_FILES[@]}"

BACKUP_SIZE=$(wc -c < "$BACKUP_PATH" | tr -d ' ')
BACKUP_SIZE_KB=$((BACKUP_SIZE / 1024))
echo "[backup] Archive created: $BACKUP_FILENAME (${BACKUP_SIZE_KB}KB)"

# ─── Rotate local backups (keep last 7) ─────────────────────────────────────
LOCAL_BACKUPS=$(ls -1t "$BACKUP_DIR"/auxilo-backup-*.tar.gz 2>/dev/null || true)
BACKUP_COUNT=$(echo "$LOCAL_BACKUPS" | grep -c '.' || true)

if [ "$BACKUP_COUNT" -gt "$MAX_LOCAL_BACKUPS" ]; then
  echo "[backup] Rotating local backups (keeping last $MAX_LOCAL_BACKUPS of $BACKUP_COUNT)"
  echo "$LOCAL_BACKUPS" | tail -n +"$((MAX_LOCAL_BACKUPS + 1))" | while read -r old_backup; do
    echo "[backup] [ROTATE] Removing: $(basename "$old_backup")"
    rm -f "$old_backup"
  done
fi

# ─── Upload to GitHub Gist (Option A: off-VM backup) ────────────────────────
UPLOAD_SUCCESS=false

if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "[backup] Uploading to GitHub Gist..."

  # Base64-encode the backup for Gist storage (Gist is text-based)
  BACKUP_B64=$(base64 < "$BACKUP_PATH")

  # Build the JSON payload
  # Use a manifest + the base64 data as the gist content
  GIST_CONTENT=$(cat <<MANIFEST
# Auxilo Backup — ${TIMESTAMP}
# Size: ${BACKUP_SIZE_KB}KB
# Files: ${BACKUP_FILES[*]}
# Restore: base64 -d < backup-data.txt > ${BACKUP_FILENAME}

${BACKUP_B64}
MANIFEST
)

  # Escape JSON properly using python if available, otherwise use sed
  if command -v python3 &>/dev/null; then
    ESCAPED_CONTENT=$(python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" <<< "$GIST_CONTENT")
  else
    # Fallback: basic escaping
    ESCAPED_CONTENT=$(echo "$GIST_CONTENT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' | tr -d '\n')
    ESCAPED_CONTENT="\"${ESCAPED_CONTENT}\""
  fi

  GIST_PAYLOAD=$(cat <<EOF
{
  "description": "Auxilo Backup ${TIMESTAMP}",
  "public": false,
  "files": {
    "backup-${TIMESTAMP}.txt": {
      "content": ${ESCAPED_CONTENT}
    }
  }
}
EOF
)

  if [ -n "${BACKUP_GIST_ID:-}" ]; then
    # Update existing gist
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" \
      -X PATCH \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      "https://api.github.com/gists/${BACKUP_GIST_ID}" \
      -d "$GIST_PAYLOAD" \
      --max-time 120)

    if [ "$HTTP_CODE" = "200" ]; then
      echo "[backup] Gist updated successfully (ID: ${BACKUP_GIST_ID})"
      UPLOAD_SUCCESS=true
    else
      echo "[backup] [WARNING] Gist update failed (HTTP ${HTTP_CODE})"
    fi
  else
    # Create new gist
    RESPONSE=$(curl -s -w "\n%{http_code}" \
      -X POST \
      -H "Authorization: Bearer ${GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -H "Content-Type: application/json" \
      "https://api.github.com/gists" \
      -d "$GIST_PAYLOAD" \
      --max-time 120)

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [ "$HTTP_CODE" = "201" ]; then
      NEW_GIST_ID=$(echo "$BODY" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | grep -o '"[^"]*"$' | tr -d '"')
      echo "[backup] Gist created successfully (ID: ${NEW_GIST_ID})"
      echo "[backup] Set BACKUP_GIST_ID=${NEW_GIST_ID} in your environment for future updates."
      UPLOAD_SUCCESS=true
    else
      echo "[backup] [WARNING] Gist creation failed (HTTP ${HTTP_CODE})"
    fi
  fi
else
  echo "[backup] [SKIP] GITHUB_TOKEN not set — skipping off-VM upload"
  echo "[backup] Set GITHUB_TOKEN (with gist scope) and optionally BACKUP_GIST_ID for off-VM backups"
fi

# ─── Summary ────────────────────────────────────────────────────────────────
echo ""
echo "[backup] ═══ Backup Summary ═══"
echo "[backup] File:     $BACKUP_FILENAME"
echo "[backup] Size:     ${BACKUP_SIZE_KB}KB"
echo "[backup] Local:    $BACKUP_PATH"
echo "[backup] Upload:   $([ "$UPLOAD_SUCCESS" = true ] && echo 'SUCCESS' || echo 'SKIPPED')"
echo "[backup] Time:     $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

if [ "$UPLOAD_SUCCESS" = true ] || [ -z "${GITHUB_TOKEN:-}" ]; then
  # Success — local backup always created, upload success or not configured
  exit 0
else
  # Upload was attempted but failed
  echo "[backup] [WARNING] Local backup succeeded but off-VM upload failed"
  exit 1
fi
