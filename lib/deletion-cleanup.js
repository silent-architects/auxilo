'use strict';

const TOS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function isoAfter(now, durationMs) {
  return new Date(new Date(now).getTime() + durationMs).toISOString();
}

function planTosPruning(deletionRows, now = new Date()) {
  const nowMs = new Date(now).getTime();
  if (!Number.isFinite(nowMs) || !Array.isArray(deletionRows)) return [];
  return deletionRows.filter((row) => {
    const completedMs = Date.parse(row && row.completed_at);
    return Boolean(
      row && row.account_id && !row.tos_pruned_at && Number.isFinite(completedMs)
      && nowMs - completedMs >= TOS_RETENTION_MS
    );
  });
}

module.exports = {
  TOS_RETENTION_MS,
  BACKUP_RETENTION_MS,
  isoAfter,
  planTosPruning,
};
