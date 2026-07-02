#!/usr/bin/env bash
# ─── S22-2: Cron Setup Script ────────────────────────────────────────────────
# Installs crontab entries for:
#   1. backup.sh    — every 6 hours
#   2. health-check — every 5 minutes
#
# Usage: ./scripts/setup-cron.sh
# Idempotent — removes existing Auxilo entries before adding new ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_SCRIPT="$SCRIPT_DIR/backup.sh"
HEALTH_CHECK_SCRIPT="$SCRIPT_DIR/health-check.js"

echo "[setup-cron] Setting up cron jobs for Auxilo..."
echo "[setup-cron] Project directory: $PROJECT_DIR"

# ─── Validate scripts exist ─────────────────────────────────────────────────
if [ ! -f "$BACKUP_SCRIPT" ]; then
  echo "[setup-cron] [ERROR] backup.sh not found at $BACKUP_SCRIPT"
  exit 1
fi

if [ ! -f "$HEALTH_CHECK_SCRIPT" ]; then
  echo "[setup-cron] [WARNING] health-check.js not found at $HEALTH_CHECK_SCRIPT"
  echo "[setup-cron] Will still set up backup cron. Create health-check.js and re-run to add it."
fi

# ─── Make scripts executable ─────────────────────────────────────────────────
chmod +x "$BACKUP_SCRIPT"
echo "[setup-cron] Made backup.sh executable"

# ─── Build new crontab entries ───────────────────────────────────────────────
# Marker comments for idempotent management
CRON_MARKER="# AUXILO-MANAGED"

# Backup: every 6 hours (0:00, 6:00, 12:00, 18:00 UTC)
BACKUP_CRON="0 */6 * * * cd $PROJECT_DIR && bash $BACKUP_SCRIPT >> $PROJECT_DIR/data/backup-cron.log 2>&1 $CRON_MARKER"

# Health check: every 5 minutes
HEALTH_CRON="*/5 * * * * cd $PROJECT_DIR && node $HEALTH_CHECK_SCRIPT >> $PROJECT_DIR/data/health-cron.log 2>&1 $CRON_MARKER"

# ─── Install crontab entries (idempotent) ────────────────────────────────────
# Get existing crontab (suppress "no crontab" error)
EXISTING_CRON=$(crontab -l 2>/dev/null || true)

# Remove any existing Auxilo-managed entries
CLEANED_CRON=$(echo "$EXISTING_CRON" | grep -v "$CRON_MARKER" || true)

# Build new crontab
NEW_CRON="$CLEANED_CRON"

# Add backup entry
NEW_CRON="${NEW_CRON}
${BACKUP_CRON}"

# Add health check entry (only if script exists)
if [ -f "$HEALTH_CHECK_SCRIPT" ]; then
  NEW_CRON="${NEW_CRON}
${HEALTH_CRON}"
fi

# Remove leading/trailing blank lines and install
echo "$NEW_CRON" | sed '/^$/N;/^\n$/d' | crontab -

echo ""
echo "[setup-cron] ═══ Cron Jobs Installed ═══"
echo ""
echo "[setup-cron] 1. Backup (every 6h):"
echo "   $BACKUP_CRON"
echo ""

if [ -f "$HEALTH_CHECK_SCRIPT" ]; then
  echo "[setup-cron] 2. Health Check (every 5min):"
  echo "   $HEALTH_CRON"
  echo ""
fi

echo "[setup-cron] Logs:"
echo "   Backup:       $PROJECT_DIR/data/backup-cron.log"
if [ -f "$HEALTH_CHECK_SCRIPT" ]; then
  echo "   Health Check: $PROJECT_DIR/data/health-cron.log"
fi
echo ""
echo "[setup-cron] Verify with: crontab -l"
echo "[setup-cron] Done."
