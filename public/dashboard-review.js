(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AuxiloReviewLanes = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var READY = 'ready_to_publish';
  var NEEDS_SCORE = 'needs_score';
  var NEEDS_EYES = 'needs_your_eyes';
  var ORDER = [READY, NEEDS_SCORE, NEEDS_EYES];

  function explicitLane(row) {
    return row && ORDER.indexOf(row.lane) !== -1 ? row.lane : null;
  }

  function legacyLane(row) {
    if (!row || !row.screens_passed) return NEEDS_EYES;
    return row.quality != null && Number.isFinite(row.quality) && row.quality >= 14
      ? READY
      : NEEDS_SCORE;
  }

  function laneForRow(row) {
    var lane = explicitLane(row);
    return { lane: lane || legacyLane(row), versionSkew: !lane };
  }

  function groupRows(summary) {
    var groups = {};
    ORDER.forEach(function (lane) { groups[lane] = []; });
    var versionSkew = false;

    (summary && summary.items || []).forEach(function (row) {
      var resolved = laneForRow(row);
      versionSkew = versionSkew || resolved.versionSkew;
      groups[resolved.lane].push(row);
    });

    var byLane = summary && summary.counts && summary.counts.by_lane;
    var counts = {};
    ORDER.forEach(function (lane) {
      counts[lane] = !versionSkew && byLane && Number.isFinite(byLane[lane])
        ? byLane[lane]
        : groups[lane].length;
    });

    return {
      groups: groups,
      counts: counts,
      order: ORDER.slice(),
      versionSkew: versionSkew,
    };
  }

  function selectReadyRows(summary) {
    return groupRows(summary).groups[READY].slice();
  }

  return {
    READY: READY,
    NEEDS_SCORE: NEEDS_SCORE,
    NEEDS_EYES: NEEDS_EYES,
    ORDER: ORDER.slice(),
    laneForRow: laneForRow,
    groupRows: groupRows,
    selectReadyRows: selectReadyRows,
  };
}));
