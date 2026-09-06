(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AuxiloCleanLane = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // CLEAN-LANE-FLIP Phase A (SPEC3-C1 standing consent) — the pure view logic
  // behind the dashboard's "Auto-publish clean learnings" card. Mirrors the
  // dashboard-review.js pattern: a UMD module the inline dashboard script
  // calls and node:test requires directly. No DOM, no fetch, no state.
  //
  // The affirmation sentence is deliberately NOT here: the card reads it from
  // the DOM label (public/dashboard.html #clean-lane-affirmation), and a test
  // pins that label byte-equal to lib/clean-lane.js CLEAN_LANE_AFFIRMATION.
  // The consent version is never a client literal either — it always comes
  // from GET /account/clean-lane (consent_version_current).

  var STATE_UNAVAILABLE = 'unavailable'; // route 404s (flag dark)
  var STATE_ERROR = 'error';             // any other non-2xx
  var STATE_OFF = 'off';                 // flag on, no active grant
  var STATE_ON = 'on';                   // active grant
  var STATE_FROZEN = 'frozen';           // auto-freeze recorded; re-grant required

  var NOT_AVAILABLE_TEXT = 'Not yet available on this account.';

  var MIN_QUALITY_MIN = 14;
  var MIN_QUALITY_MAX = 20;
  var DEFAULT_MIN_QUALITY = 16;

  /** Stamp lib/clean-lane.js writes on lane publishes (test-pinned equal). */
  var PUBLISHED_VIA_CLEAN_LANE = 'clean_lane_standing_consent';

  /**
   * CLEAN-LANE-FLIP Phase B: the GET /account/learnings query for the
   * "Published under standing consent" list — server-side published_via
   * filter + newest-first, so one page holds the common case and the client
   * never walks an account's whole catalog from the oldest end
   * (WAVE-0905-RESIDUALS (1)/(2)). `pageLimit` is interpolated, never a
   * literal. selectStandingConsentItems stays as the defensive second filter.
   * Gate-A 2026-09-06 (N2, badge vs list): no status filter — the badge counts
   * stamped rows regardless of status, so the list shows every stamped row the
   * server returns (its default status set), each with a status label.
   */
  function standingConsentListQuery(pageLimit, offset) {
    var limit = parseInt(pageLimit, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = 500;
    var off = parseInt(offset, 10);
    if (!Number.isInteger(off) || off < 0) off = 0;
    return '/account/learnings?visibility=public' +
      '&published_via=' + encodeURIComponent(PUBLISHED_VIA_CLEAN_LANE) +
      '&sort=desc&limit=' + limit + '&offset=' + off;
  }

  /**
   * Map a GET /account/clean-lane result to a card state.
   * 404 → unavailable (the flag is off; never an error state). Other non-2xx →
   * error with the server's message. 2xx → on / frozen / off from the body.
   */
  function viewState(status, data) {
    var body = data && typeof data === 'object' ? data : {};
    if (status === 404) return { state: STATE_UNAVAILABLE, message: NOT_AVAILABLE_TEXT };
    if (status < 200 || status >= 300) {
      return { state: STATE_ERROR, message: body.error || 'Could not load auto-publish status.' };
    }
    if (body.clean_lane_active === true) return { state: STATE_ON };
    if (body.freeze_reason || body.last_action === 'freeze') {
      return { state: STATE_FROZEN, freezeReason: body.freeze_reason || 'unknown' };
    }
    return { state: STATE_OFF };
  }

  /** The 14-20 threshold choices; `selected` marks the default (or the given value). */
  function qualityOptions(selectedValue) {
    var selected = Number.isInteger(selectedValue) ? selectedValue : DEFAULT_MIN_QUALITY;
    var out = [];
    for (var v = MIN_QUALITY_MIN; v <= MIN_QUALITY_MAX; v += 1) {
      out.push({ value: v, selected: v === selected });
    }
    return out;
  }

  /**
   * Body for POST /account/clean-lane/grant. `affirmationText` is whatever the
   * caller read from the DOM label — this module never supplies the sentence.
   */
  function buildGrantBody(opts) {
    var o = opts || {};
    var q = parseInt(o.minQuality, 10);
    if (!Number.isInteger(q) || q < MIN_QUALITY_MIN || q > MIN_QUALITY_MAX) q = DEFAULT_MIN_QUALITY;
    return {
      consent_version: o.consentVersion,
      agree: true,
      affirmation: o.affirmationText,
      min_auto_publish_quality: q,
    };
  }

  function isoDate(value) {
    var t = Date.parse(value);
    if (!Number.isFinite(t)) return 'unknown date';
    return new Date(t).toISOString().slice(0, 10);
  }

  /** "Auto-publish is ON since <date> at quality ≥ N (consent <version>)". */
  function onStateLine(data) {
    var body = data || {};
    var q = Number.isInteger(body.min_auto_publish_quality) ? body.min_auto_publish_quality : DEFAULT_MIN_QUALITY;
    return 'Auto-publish is ON since ' + isoDate(body.last_action_at) +
      ' at quality ≥ ' + q +
      ' (consent ' + (body.consent_version_recorded || body.consent_version_current || 'unknown') + ')';
  }

  /** The red line for a frozen lane. */
  function frozenLine(reason) {
    return 'Auto-publish is FROZEN (' + (reason || 'unknown') + '). ' +
      'Nothing auto-publishes until you grant consent again below.';
  }

  /**
   * CLEAN-LANE-FLIP Phase B (notice hardening; GOV-2 counsel draft §6 read #2):
   * the unread count from GET /account/clean-lane `unacknowledged_publications`
   * — a non-negative integer, 0 for anything missing or malformed. The server
   * computes it from the account's ack cursor; this module never counts rows.
   */
  function unacknowledgedCount(data) {
    var body = data && typeof data === 'object' ? data : {};
    var n = body.unacknowledged_publications;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return 0;
    return n;
  }

  /** "N auto-published since you last checked" — the persistent badge text. */
  function unreadBadgeLine(count) {
    var n = Number.isInteger(count) && count > 0 ? count : 0;
    return n + ' auto-published since you last checked';
  }

  /**
   * Body for PATCH /account/settings from the "I've reviewed these" button:
   * the acknowledgement cursor, stamped to now (or the given ms). This PATCH
   * is the ONLY thing that clears the badge — viewing never does.
   */
  function buildAckBody(nowMs) {
    var t = Number.isFinite(nowMs) ? nowMs : Date.now();
    return { standing_consent_ack_at: new Date(t).toISOString() };
  }

  /**
   * Items published under standing consent, newest first, each with its
   * retraction window state. Input: rows from GET /account/learnings (any
   * shape); only rows carrying standing_consent_version count.
   */
  function selectStandingConsentItems(rows, now) {
    var nowMs = Number.isFinite(now) ? now : Date.now();
    var items = (rows || []).filter(function (r) {
      return r && typeof r === 'object' && !!r.standing_consent_version;
    }).map(function (r) {
      var until = Date.parse(r.retractable_until);
      return {
        id: r.id,
        title: r.title || '(no title)',
        status: typeof r.status === 'string' && r.status ? r.status : 'approved',
        created_at: r.created_at || null,
        standing_consent_version: r.standing_consent_version,
        retractable_until: r.retractable_until || null,
        retractable: Number.isFinite(until) && nowMs < until,
      };
    });
    items.sort(function (a, b) {
      var ta = Date.parse(a.created_at); var tb = Date.parse(b.created_at);
      if (!Number.isFinite(ta)) ta = 0;
      if (!Number.isFinite(tb)) tb = 0;
      return tb - ta;
    });
    return items;
  }

  return {
    STATE_UNAVAILABLE: STATE_UNAVAILABLE,
    STATE_ERROR: STATE_ERROR,
    STATE_OFF: STATE_OFF,
    STATE_ON: STATE_ON,
    STATE_FROZEN: STATE_FROZEN,
    NOT_AVAILABLE_TEXT: NOT_AVAILABLE_TEXT,
    MIN_QUALITY_MIN: MIN_QUALITY_MIN,
    MIN_QUALITY_MAX: MIN_QUALITY_MAX,
    DEFAULT_MIN_QUALITY: DEFAULT_MIN_QUALITY,
    PUBLISHED_VIA_CLEAN_LANE: PUBLISHED_VIA_CLEAN_LANE,
    standingConsentListQuery: standingConsentListQuery,
    viewState: viewState,
    qualityOptions: qualityOptions,
    buildGrantBody: buildGrantBody,
    onStateLine: onStateLine,
    frozenLine: frozenLine,
    unacknowledgedCount: unacknowledgedCount,
    unreadBadgeLine: unreadBadgeLine,
    buildAckBody: buildAckBody,
    selectStandingConsentItems: selectStandingConsentItems,
  };
}));
