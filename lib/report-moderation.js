'use strict';

function createReportModerationState(rows = []) {
  const state = {
    distinctReporters: new Map(),
    autoHideTriggered: new Set(),
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.learning_id !== 'string') continue;
    if (row.event === 'report_auto_hide') {
      state.autoHideTriggered.add(row.learning_id);
      continue;
    }
    if (typeof row.reporter_ip_hash !== 'string' || row.reporter_ip_hash.length === 0) continue;
    if (!state.distinctReporters.has(row.learning_id)) {
      state.distinctReporters.set(row.learning_id, new Set());
    }
    state.distinctReporters.get(row.learning_id).add(row.reporter_ip_hash);
  }
  return state;
}

function recordDistinctReport(state, learningId, reporterIpHash, threshold) {
  if (!state || !state.distinctReporters || typeof learningId !== 'string') {
    throw new TypeError('valid report moderation state and learning id are required');
  }
  if (!state.distinctReporters.has(learningId)) {
    state.distinctReporters.set(learningId, new Set());
  }
  const reporters = state.distinctReporters.get(learningId);
  if (typeof reporterIpHash === 'string' && reporterIpHash.length > 0) {
    reporters.add(reporterIpHash);
  }
  const normalizedThreshold = Number.isInteger(threshold) && threshold > 0 ? threshold : 3;
  return {
    distinctCount: reporters.size,
    thresholdReached: reporters.size >= normalizedThreshold,
    alreadyTriggered: state.autoHideTriggered.has(learningId),
  };
}

function markAutoHideTriggered(state, learningId) {
  if (state.autoHideTriggered.has(learningId)) return false;
  state.autoHideTriggered.add(learningId);
  return true;
}

module.exports = {
  createReportModerationState,
  recordDistinctReport,
  markAutoHideTriggered,
};
