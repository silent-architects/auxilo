'use strict';

/**
 * test/spec3-b1-server.test.js — SPEC-3 slice B1 (server) + C1 flag-dark.
 *
 * Covers (spec: ~/.auxilo/handoffs/BUILD-SPEC-SPEC3-B1-2026-07-19.md):
 *   1. Three-lane taxonomy: laneOf + summarizeOwnPending lanes/counts/filters/
 *      pagination/full-bodies — incl. the cross-lib drift pin that
 *      approvable_count can NEVER disagree with selectForBulkApprove.
 *   2. Channel-hold: normalizeSubmissionChannel + evaluateExtractionPublish
 *      (extraction-channel items hold unless the clean lane is active).
 *   3. C1 dark posture: flag default-off, consent store round-trip (own file,
 *      never extraction-consent.jsonl), retraction-rate auto-freeze math,
 *      never-agent-enrollable pin (mcp-server.js has zero clean-lane refs).
 *   4. Structural wiring of server.js (repo convention: server.js hardcodes
 *      PORT/DATA_DIR, so routes are asserted statically like the LW-15 /
 *      review-seamless / aud19-funnel suites).
 *
 * Runner: node --test test/spec3-b1-server.test.js
 */

// Test isolation: point the clean-lane consent store (and the shared audit
// chain) at a temp dir BEFORE the module is required (module-load resolution,
// same contract as extraction-consent-reader / tos-acceptance-log).
const os = require('os');
const fs = require('fs');
const path = require('path');
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3-b1-'));
process.env.AUXILO_DATA_DIR = TMP_DATA;

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const selfReview = require('../lib/self-review.js');
const reviewLib = require('../lib/review.js');
const cleanLane = require('../lib/clean-lane.js');

const REPO_ROOT = path.join(__dirname, '..');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
const OPENAPI_SRC = fs.readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf-8');

function sliceAt(src, marker, span = 4000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ME = 'acc_me';
const OTHER = 'acc_other';

function learning(id, overrides = {}) {
  return {
    id,
    title: `title ${id}`,
    body: `body of ${id} with enough words to matter`,
    category: 'code-execution',
    tags: ['x'],
    status: 'pending_review',
    contributor_account_id: ME,
    created_at: '2026-07-01T00:00:00.000Z',
    quality_self_assessment: { total: 15 },
    ...overrides,
  };
}

function fixtureCatalog() {
  return [
    learning('lrn_ready_hi', { quality_self_assessment: { total: 19, assessor: 'extractor-local/claude-code' }, created_at: '2026-07-01T01:00:00.000Z' }),
    learning('lrn_ready_floor', { quality_self_assessment: { total: 14 } }),
    learning('lrn_below_floor', { quality_self_assessment: { total: 11 } }),
    learning('lrn_unscored', { quality_self_assessment: undefined, created_at: '2026-07-02T00:00:00.000Z' }),
    learning('lrn_inj', { injection_flags: [{ pattern_id: 'ignore_previous' }], quality_self_assessment: { total: 20 } }),
    learning('lrn_sens', { sensitivity_signals: ['person_name', 'private_path'] }),
    learning('lrn_sens2', { sensitivity_signals: ['person_name'], category: 'web-interaction' }),
    learning('lrn_dupA', { possible_duplicate_of: 'lrn_ready_hi', possible_duplicate_similarity: 0.7 }),
    learning('lrn_legacy', { quality_self_assessment: undefined, quality_estimate: 16 }),
    learning('lrn_approved', { status: 'approved' }),
    learning('lrn_theirs', { contributor_account_id: OTHER }),
  ];
}
// Own pending set = 9 rows (lrn_approved and lrn_theirs excluded).
// Lanes: ready {lrn_ready_hi 19, lrn_ready_floor 14, lrn_legacy 16} = 3
//        needs_score {lrn_below_floor 11, lrn_unscored} = 2
//        needs_your_eyes {lrn_inj, lrn_sens, lrn_sens2, lrn_dupA} = 4

// ─────────────────────────────────────────────────────────────────────────────
// A. Lane derivation
// ─────────────────────────────────────────────────────────────────────────────

describe('laneOf: three-lane taxonomy (SPEC3 §2.2)', () => {
  it('exports the three lane names', () => {
    assert.equal(selfReview.LANE_READY, 'ready_to_publish');
    assert.equal(selfReview.LANE_NEEDS_SCORE, 'needs_score');
    assert.equal(selfReview.LANE_NEEDS_EYES, 'needs_your_eyes');
    assert.deepEqual(selfReview.LANES, ['ready_to_publish', 'needs_score', 'needs_your_eyes']);
  });

  it('any flag wins the lane — even a 20/20 injection-flagged item needs eyes', () => {
    assert.equal(selfReview.laneOf({ flags: ['injection'], quality: 20 }), 'needs_your_eyes');
    assert.equal(selfReview.laneOf({ flags: ['content_sensitivity'], quality: null }), 'needs_your_eyes');
  });

  it('clean + quality >= 14 → ready_to_publish (exactly at the floor too)', () => {
    assert.equal(selfReview.laneOf({ flags: [], quality: 14 }), 'ready_to_publish');
    assert.equal(selfReview.laneOf({ flags: [], quality: 19 }), 'ready_to_publish');
  });

  it('clean + unscored OR below floor → needs_score', () => {
    assert.equal(selfReview.laneOf({ flags: [], quality: null }), 'needs_score');
    assert.equal(selfReview.laneOf({ flags: [], quality: 11 }), 'needs_score');
    assert.equal(selfReview.laneOf({ flags: [], quality: 13 }), 'needs_score');
  });

  it('the lane threshold IS the approve-clean default and the quality floor (drift pin)', () => {
    assert.equal(selfReview.LANE_READY_QUALITY, selfReview.QUALITY_FLOOR_TOTAL);
    assert.equal(selfReview.LANE_READY_QUALITY, reviewLib.DEFAULT_QUALITY_THRESHOLD);
  });
});

describe('qualityOf: assessor provenance (SPEC3 §3.2)', () => {
  it('self_assessment default assessor is operator-agent', () => {
    assert.deepEqual(selfReview.qualityOf({ quality_self_assessment: { total: 15 } }),
      { quality: 15, source: 'self_assessment', assessor: 'operator-agent' });
  });
  it('persisted assessor passes through', () => {
    const q = selfReview.qualityOf({ quality_self_assessment: { total: 18, assessor: 'extractor-local/claude-code' } });
    assert.equal(q.assessor, 'extractor-local/claude-code');
  });
  it('legacy estimates read as server-import; unscored is null', () => {
    assert.equal(selfReview.qualityOf({ quality_estimate: 16 }).assessor, 'server-import');
    assert.equal(selfReview.qualityOf({}).assessor, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Summary: counts, filters, pagination, full bodies
// ─────────────────────────────────────────────────────────────────────────────

describe('summarizeOwnPending: lanes + approvable_count (SPEC3 §2.2)', () => {
  it('every row carries a lane and the by_lane counts add up', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    assert.equal(s.pending_count, 9);
    for (const r of s.items) assert.ok(selfReview.LANES.includes(r.lane), `row ${r.id} lane`);
    assert.deepEqual(s.counts.by_lane, { ready_to_publish: 3, needs_score: 2, needs_your_eyes: 4 });
    assert.equal(s.approvable_count, 3);
    assert.equal(s.needs_score_count, 2);
    // clean_count retained (compat) and flagged_count === needs_your_eyes.
    assert.equal(s.clean_count, 5);
    assert.equal(s.flagged_count, 4);
    assert.equal(s.flagged_count, s.counts.by_lane.needs_your_eyes);
  });

  it('THE B1 invariant: approvable_count === what bulk approve-clean selects (no more "4 clean / 0 approvable")', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const sel = reviewLib.selectForBulkApprove(s.items, { mode: 'clean' });
    assert.equal(s.approvable_count, sel.selected.length);
    // And the selected ids are exactly the ready-lane ids.
    const readyIds = s.items.filter((r) => r.lane === 'ready_to_publish').map((r) => r.id).sort();
    assert.deepEqual(sel.selected.map((r) => r.id).sort(), readyIds);
  });

  it('by_signal histogram: sensitivity names ∪ injection ∪ near_duplicate (SPEC3 §5.2)', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    assert.equal(s.counts.by_signal.person_name, 2);
    assert.equal(s.counts.by_signal.private_path, 1);
    assert.equal(s.counts.by_signal.injection, 1);
    assert.equal(s.counts.by_signal.near_duplicate, 1);
  });

  it('rows surface quality_assessor and signal names; compact rows still carry no body', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const hi = s.items.find((r) => r.id === 'lrn_ready_hi');
    assert.equal(hi.quality_assessor, 'extractor-local/claude-code');
    const legacy = s.items.find((r) => r.id === 'lrn_legacy');
    assert.equal(legacy.quality_assessor, 'server-import');
    const sens = s.items.find((r) => r.id === 'lrn_sens');
    assert.deepEqual(sens.sensitivity_signals, ['person_name', 'private_path']);
    for (const r of s.items) assert.equal('body' in r, false, `row ${r.id} must not carry the body`);
  });

  it('back-compat: no opts → all rows, returned_count/truncated additive', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    assert.equal(s.items.length, 9);
    assert.equal(s.returned_count, 9);
    assert.equal(s.truncated, false);
  });
});

describe('summarizeOwnPending: filters narrow rows, NEVER counts (SPEC3 §5.5)', () => {
  it('lane filter', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { lane: 'ready_to_publish' });
    assert.equal(s.items.length, 3);
    assert.ok(s.items.every((r) => r.lane === 'ready_to_publish'));
    // counts stay full-set
    assert.equal(s.pending_count, 9);
    assert.equal(s.approvable_count, 3);
    assert.deepEqual(s.counts.by_lane, { ready_to_publish: 3, needs_score: 2, needs_your_eyes: 4 });
  });

  it('flag / signal / category filters', () => {
    const flagged = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { flag: 'content_sensitivity' });
    assert.deepEqual(flagged.items.map((r) => r.id).sort(), ['lrn_sens', 'lrn_sens2']);

    const bySignal = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { signal: 'private_path' });
    assert.deepEqual(bySignal.items.map((r) => r.id), ['lrn_sens']);

    const injSignal = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { signal: 'injection' });
    assert.deepEqual(injSignal.items.map((r) => r.id), ['lrn_inj']);

    const byCat = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { category: 'web-interaction' });
    assert.deepEqual(byCat.items.map((r) => r.id), ['lrn_sens2']);
  });

  it('ids filter: own pending only — foreign/non-pending ids silently absent (no oracle)', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME, {
      ids: ['lrn_ready_hi', 'lrn_theirs', 'lrn_approved', 'lrn_nope'],
    });
    assert.deepEqual(s.items.map((r) => r.id), ['lrn_ready_hi']);
    assert.equal(s.pending_count, 9, 'counts stay full-set under ids filter');
  });
});

describe('summarizeOwnPending: pagination + full bodies (SPEC3 §5.5)', () => {
  it('limit/offset slice AFTER the sort; truncated reflects the cut', () => {
    const all = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const page1 = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { limit: 4 });
    const page2 = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { limit: 4, offset: 4 });
    assert.deepEqual(page1.items.map((r) => r.id), all.items.slice(0, 4).map((r) => r.id));
    assert.deepEqual(page2.items.map((r) => r.id), all.items.slice(4, 8).map((r) => r.id));
    assert.equal(page1.returned_count, 4);
    assert.equal(page1.truncated, true);
    assert.equal(page1.pending_count, 9, 'counts never paginate');
  });

  it('full with explicit ids attaches bodies to those rows', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME, { ids: ['lrn_ready_hi'], full: true });
    assert.equal(s.items.length, 1);
    assert.equal(s.items[0].body, 'body of lrn_ready_hi with enough words to matter');
  });

  it('full WITHOUT ids forces a body-safe page (<= FULL_ROWS_MAX)', () => {
    const big = [];
    for (let i = 0; i < 40; i++) big.push(learning(`lrn_${i}`));
    const s = selfReview.summarizeOwnPending(big, ME, { full: true });
    assert.equal(selfReview.FULL_ROWS_MAX, 25);
    assert.equal(s.items.length, 25, 'full without ids must never dump every body');
    assert.ok(s.items.every((r) => typeof r.body === 'string'));
    assert.equal(s.truncated, true);
    const capped = selfReview.summarizeOwnPending(big, ME, { full: true, limit: 200 });
    assert.equal(capped.items.length, 25, 'an explicit huge limit is still capped under full');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Channel + clean-lane pure logic
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeSubmissionChannel (SPEC3 §3.2)', () => {
  it('only the exact string "extraction" marks the channel; everything else degrades to direct', () => {
    assert.equal(cleanLane.normalizeSubmissionChannel('extraction'), 'extraction');
    for (const v of ['direct', undefined, null, '', 'EXTRACTION', 'hook', 42, {}]) {
      assert.equal(cleanLane.normalizeSubmissionChannel(v), 'direct', `value ${String(v)}`);
    }
  });
});

describe('cleanLaneFlagEnabled: DARK by default', () => {
  it('absent / empty / false-ish / "1" are all OFF; only exact "true" is ON', () => {
    assert.equal(cleanLane.cleanLaneFlagEnabled({}), false);
    assert.equal(cleanLane.cleanLaneFlagEnabled({ EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: '' }), false);
    assert.equal(cleanLane.cleanLaneFlagEnabled({ EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'false' }), false);
    assert.equal(cleanLane.cleanLaneFlagEnabled({ EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: '1' }), false);
    assert.equal(cleanLane.cleanLaneFlagEnabled({ EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'TRUE' }), false);
    assert.equal(cleanLane.cleanLaneFlagEnabled({ EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'true' }), true);
  });
});

describe('deriveAssessor (SPEC3 §3.2)', () => {
  it('extraction channel derives from the auxilo-hook contributor_agent convention', () => {
    assert.equal(cleanLane.deriveAssessor('extraction', 'auxilo-hook/claude-code'), 'extractor-local/claude-code');
    assert.equal(cleanLane.deriveAssessor('extraction', 'auxilo-hook/cursor extra'), 'extractor-local/cursor');
  });
  it('unparseable agents degrade to extractor-local/unknown; direct is operator-agent', () => {
    assert.equal(cleanLane.deriveAssessor('extraction', 'something-else'), 'extractor-local/unknown');
    assert.equal(cleanLane.deriveAssessor('extraction', undefined), 'extractor-local/unknown');
    assert.equal(cleanLane.deriveAssessor('direct', 'auxilo-hook/claude-code'), 'operator-agent');
  });
});

describe('evaluateExtractionPublish: the channel-hold decision (SPEC3 §4.4)', () => {
  const GRANT = {
    account_id: ME, action: 'grant',
    consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
    min_auto_publish_quality: 16,
  };

  it('flag OFF holds standing_consent_off even with a recorded grant (dark = zero behavior change)', () => {
    const v = cleanLane.evaluateExtractionPublish({ flagEnabled: false, consentState: GRANT, qualityTotal: 20 });
    assert.deepEqual(v, { decision: 'hold', reason: 'standing_consent_off' });
  });

  it('no state / revoked / frozen / stale-version grants all hold standing_consent_off', () => {
    for (const state of [
      null,
      { ...GRANT, action: 'revoke' },
      { ...GRANT, action: 'freeze' },
      { ...GRANT, consent_version: '2025-01-01-clean-lane-a0' },
    ]) {
      const v = cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: state, qualityTotal: 20 });
      assert.equal(v.decision, 'hold');
      assert.equal(v.reason, 'standing_consent_off');
    }
  });

  it('active grant + below threshold holds below_auto_publish_threshold (floor-passing 15 < default 16)', () => {
    const v = cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: GRANT, qualityTotal: 15 });
    assert.deepEqual(v, { decision: 'hold', reason: 'below_auto_publish_threshold', min_quality: 16 });
  });

  it('active grant + threshold-passing score publishes; per-grant threshold respected', () => {
    const v = cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: GRANT, qualityTotal: 16 });
    assert.equal(v.decision, 'auto_publish');
    assert.equal(v.consent_version, cleanLane.CLEAN_LANE_CONSENT_VERSION);
    const strict = { ...GRANT, min_auto_publish_quality: 18 };
    assert.equal(cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: strict, qualityTotal: 17 }).decision, 'hold');
    assert.equal(cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: strict, qualityTotal: 18 }).decision, 'auto_publish');
  });

  it('a malformed stored threshold clamps to the default 16, never below 14', () => {
    const weird = { ...GRANT, min_auto_publish_quality: 3 };
    // clamp floor is 14 — a stored 3 can never arm a below-floor auto-publish
    assert.equal(cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: weird, qualityTotal: 13 }).decision, 'hold');
    assert.equal(cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: weird, qualityTotal: 14 }).decision, 'auto_publish');
    const missing = { ...GRANT, min_auto_publish_quality: undefined };
    assert.equal(cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: missing, qualityTotal: 15 }).decision, 'hold');
  });

  it('suspended accounts never auto-publish', () => {
    const v = cleanLane.evaluateExtractionPublish({ flagEnabled: true, consentState: GRANT, qualityTotal: 20, accountSuspended: true });
    assert.deepEqual(v, { decision: 'hold', reason: 'standing_consent_off' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. Consent store (own file) + freeze guardrail
// ─────────────────────────────────────────────────────────────────────────────

describe('clean-lane consent store: own JSONL, latest row wins', () => {
  beforeEach(() => {
    cleanLane._resetCache();
    if (fs.existsSync(cleanLane.CLEAN_LANE_FILE)) fs.unlinkSync(cleanLane.CLEAN_LANE_FILE);
  });

  it('writes its OWN file, never extraction-consent.jsonl (state-clobber guard)', () => {
    assert.ok(cleanLane.CLEAN_LANE_FILE.endsWith('clean-lane-consent.jsonl'));
    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant', minAutoPublishQuality: 16, tosVersionAtGrant: '2026-07-04-payee-agency-a1' });
    assert.ok(fs.existsSync(cleanLane.CLEAN_LANE_FILE));
    assert.ok(!fs.existsSync(path.join(TMP_DATA, 'extraction-consent.jsonl')),
      'a clean-lane append must NEVER create/touch the extraction consent file');
  });

  it('grant → revoke → grant: latest row wins; freeze deactivates; re-grant reactivates', () => {
    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant', minAutoPublishQuality: 17 });
    let state = cleanLane.getCleanLaneState(ME, { forceReload: true });
    assert.equal(state.action, 'grant');
    assert.equal(state.min_auto_publish_quality, 17);
    assert.equal(state.mode, 'automatic');
    assert.equal(state.notify, 'per_publish');
    assert.equal(state.affirmed, true);
    assert.equal(cleanLane.cleanLaneActive(state), true);

    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'revoke' });
    state = cleanLane.getCleanLaneState(ME, { forceReload: true });
    assert.equal(cleanLane.cleanLaneActive(state), false);

    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant' });
    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'freeze', reason: 'retraction_rate', stats: { publishes: 10, retractions: 2 } });
    state = cleanLane.getCleanLaneState(ME, { forceReload: true });
    assert.equal(state.action, 'freeze');
    assert.equal(state.reason, 'retraction_rate');
    assert.equal(cleanLane.cleanLaneActive(state), false, 'freeze must deactivate the lane');

    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant' });
    state = cleanLane.getCleanLaneState(ME, { forceReload: true });
    assert.equal(cleanLane.cleanLaneActive(state), true, 'an explicit human re-grant reactivates');
  });

  it('grant rows record the ToS version they were granted under', () => {
    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant', tosVersionAtGrant: '2026-07-04-payee-agency-a1' });
    const state = cleanLane.getCleanLaneState(ME, { forceReload: true });
    assert.equal(state.tos_version_at_grant, '2026-07-04-payee-agency-a1');
    cleanLane.appendCleanLaneRow({ accountId: OTHER, action: 'grant' });
    assert.equal(cleanLane.getCleanLaneState(OTHER, { forceReload: true }).tos_version_at_grant, 'none');
  });

  it('accounts are isolated; unknown account reads null', () => {
    cleanLane.appendCleanLaneRow({ accountId: ME, action: 'grant' });
    assert.equal(cleanLane.getCleanLaneState(OTHER, { forceReload: true }), null);
    assert.equal(cleanLane.getCleanLaneState('', { forceReload: true }), null);
  });
});

describe('retraction-rate auto-freeze guardrail (SPEC3 §7)', () => {
  const NOW = Date.parse('2026-07-19T00:00:00.000Z');
  function published(id, { daysAgo, retractedDaysAgo, account = ME } = {}) {
    return {
      id,
      status: retractedDaysAgo !== undefined ? 'retracted' : 'approved',
      contributor_account_id: account,
      published_via: 'clean_lane_standing_consent',
      created_at: new Date(NOW - daysAgo * 86400000).toISOString(),
      ...(retractedDaysAgo !== undefined && { retracted_at: new Date(NOW - retractedDaysAgo * 86400000).toISOString() }),
    };
  }

  it('exactly 5% (1/20) does NOT freeze; above 5% (1/10) does', () => {
    const twenty = [];
    for (let i = 0; i < 19; i++) twenty.push(published(`p${i}`, { daysAgo: 5 }));
    twenty.push(published('r0', { daysAgo: 5, retractedDaysAgo: 1 }));
    const at5 = cleanLane.computeCleanLaneRetractionStats(twenty, ME, { now: NOW });
    assert.deepEqual({ p: at5.publishes, r: at5.retractions }, { p: 20, r: 1 });
    assert.equal(cleanLane.shouldFreezeCleanLane(at5), false, 'rate must EXCEED 5%');

    const ten = twenty.slice(10);
    const at10 = cleanLane.computeCleanLaneRetractionStats(ten, ME, { now: NOW });
    assert.equal(cleanLane.shouldFreezeCleanLane(at10), true);
  });

  it('zero publishes never freezes; retractions outside the 30d window are ignored', () => {
    assert.equal(cleanLane.shouldFreezeCleanLane({ publishes: 0, retractions: 5 }), false);
    const old = [
      published('p1', { daysAgo: 5 }),
      published('rOld', { daysAgo: 45, retractedDaysAgo: 40 }),
    ];
    const stats = cleanLane.computeCleanLaneRetractionStats(old, ME, { now: NOW });
    assert.deepEqual({ p: stats.publishes, r: stats.retractions }, { p: 1, r: 0 });
  });

  it('only clean-lane items count — ordinary retractions and other accounts are invisible', () => {
    const mixed = [
      published('p1', { daysAgo: 2 }),
      { id: 'ordinary', status: 'retracted', contributor_account_id: ME, created_at: new Date(NOW - 86400000).toISOString(), retracted_at: new Date(NOW - 3600000).toISOString() },
      published('theirs', { daysAgo: 2, retractedDaysAgo: 1, account: OTHER }),
    ];
    const stats = cleanLane.computeCleanLaneRetractionStats(mixed, ME, { now: NOW });
    assert.deepEqual({ p: stats.publishes, r: stats.retractions }, { p: 1, r: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. Server wiring (structural — repo convention for server.js routes)
// ─────────────────────────────────────────────────────────────────────────────

describe('server.js /learn wiring: channel + assessor + hold (structural)', () => {
  it('destructures and normalizes submission_channel; persists it on the learning', () => {
    assert.match(SERVER_SRC, /quality_self_assessment, extraction_context, submission_channel, visibility \} = body/);
    assert.match(SERVER_SRC, /const submissionChannel = normalizeSubmissionChannel\(submission_channel\)/);
    assert.match(SERVER_SRC, /submission_channel: submissionChannel,/);
  });

  it('assessor is server-derived and OVERWRITES the client value', () => {
    assert.match(SERVER_SRC, /quality_self_assessment\.assessor = deriveAssessor\(submissionChannel, contributor_agent\)/);
  });

  it('the extraction branch sits on top of the unchanged screens+score predicate', () => {
    const slice = sliceAt(SERVER_SRC, 'const seamlessScreensAndScore =', 5200);
    assert.match(slice, /qualityMeetsFloor;/);
    assert.match(slice, /seamlessScreensAndScore && submissionChannel === 'extraction'/);
    assert.match(slice, /getCleanLaneState\(contributor_account_id, \{ forceReload: true \}\)/, 'publish decisions must re-read consent (in-flight recheck)');
    assert.match(slice, /learnReviewReasons\.push\(laneVerdict\.reason\)/);
    assert.match(slice, /HOLD_STANDING_CONSENT_OFF/);
  });

  it('auto-publish is guarded by the retraction-rate freeze BEFORE publishing', () => {
    const slice = sliceAt(SERVER_SRC, "laneVerdict.decision === 'auto_publish'", 1800);
    assert.match(slice, /computeCleanLaneRetractionStats\(learnings, contributor_account_id\)/);
    assert.match(slice, /shouldFreezeCleanLane/);
    assert.match(slice, /action: 'freeze'/);
    assert.match(slice, /category: 'clean-lane'/);
  });

  it('clean-lane publishes stamp published_via + consent version + retraction deadline, and the response carries the notice', () => {
    assert.match(SERVER_SRC, /published_via: PUBLISHED_VIA_CLEAN_LANE,\s*\n\s*standing_consent_version: cleanLanePublish\.consent_version,\s*\n\s*retractable_until:/);
    assert.match(SERVER_SRC, /standing_consent_notice: `Published under your standing consent/);
  });
});

describe('server.js clean-lane routes: FLAG-DARK posture (structural)', () => {
  it('all three routes exist and each checks the dark guard FIRST', () => {
    for (const marker of [
      "app.get('/account/clean-lane'",
      "app.post('/account/clean-lane/grant'",
      "app.post('/account/clean-lane/revoke'",
    ]) {
      const slice = sliceAt(SERVER_SRC, marker, 400);
      assert.match(slice, /cleanLaneDarkGuard\(c\)/, `${marker} must be dark-guarded`);
      const guardIdx = slice.indexOf('cleanLaneDarkGuard');
      const authIdx = slice.indexOf('resolveSelfReviewAccount');
      assert.ok(guardIdx > -1 && (authIdx === -1 || guardIdx < authIdx),
        `${marker}: dark guard must run BEFORE auth (the surface leaks nothing while dark)`);
    }
    const guard = sliceAt(SERVER_SRC, 'function cleanLaneDarkGuard', 300);
    assert.match(guard, /cleanLaneFlagEnabled\(process\.env\)/);
    assert.match(guard, /404/);
  });

  it('grant enforces the strengthened L-2 clickwrap: exact version (409), agree:true, VERBATIM affirmation', () => {
    const slice = sliceAt(SERVER_SRC, "app.post('/account/clean-lane/grant'", 4200);
    assert.match(slice, /consent_version !== CLEAN_LANE_CONSENT_VERSION/);
    assert.match(slice, /CONSENT_VERSION_MISMATCH/);
    assert.match(slice, /agree !== true/);
    assert.match(slice, /AFFIRMATION_REQUIRED/);
    assert.match(slice, /affirmation !== CLEAN_LANE_AFFIRMATION/);
    assert.match(slice, /AFFIRMATION_TEXT_MISMATCH/);
    assert.match(slice, /resolveSelfReviewAccount\(c, 'contribute'\)/, 'grant = contribute minimum (D2 scoped keys)');
    assert.match(slice, /acquireAccountLock\(accountId\)/);
    assert.match(slice, /tosVersionAtGrant: account\.tos_version \|\| 'none'/, 'the consent artifact records its ToS version');
    assert.match(slice, /redactIp\(getClientIp\(c\)\)/);
  });

  it('revoke = contribute minimum; status = read', () => {
    const revoke = sliceAt(SERVER_SRC, "app.post('/account/clean-lane/revoke'", 800);
    assert.match(revoke, /resolveSelfReviewAccount\(c, 'contribute'\)/);
    const status = sliceAt(SERVER_SRC, "app.get('/account/clean-lane'", 800);
    assert.match(status, /resolveSelfReviewAccount\(c, 'read'\)/);
  });

  it('retraction of a clean-lane item re-runs the guardrail (best-effort, try/caught)', () => {
    const slice = sliceAt(SERVER_SRC, 'learning.published_via === PUBLISHED_VIA_CLEAN_LANE', 1600);
    assert.match(slice, /computeCleanLaneRetractionStats\(learnings, accountId\)/);
    assert.match(slice, /shouldFreezeCleanLane/);
    assert.match(slice, /catch \(guardErr\)/);
  });

  it('Gate-A F2: the dark 404 body is the catch-all shape — no fingerprint', () => {
    const guard = sliceAt(SERVER_SRC, 'function cleanLaneDarkGuard', 800);
    assert.match(guard, /No endpoint at \$\{c\.req\.method\} \$\{c\.req\.path\}/,
      'dark guard must return the catch-all message shape');
    assert.match(guard, /See GET \/api for all available endpoints/,
      'dark guard must return the catch-all help string');
  });

  it('Gate-A F3: the affirmation-mismatch error never echoes the expected sentence', () => {
    const slice = sliceAt(SERVER_SRC, "app.post('/account/clean-lane/grant'", 4800);
    assert.match(slice, /AFFIRMATION_TEXT_MISMATCH/);
    assert.ok(!slice.includes('expected_affirmation'),
      'the API error must not teach callers the affirmation sentence — dashboard/CLI carry it');
  });
});

describe('never-agent-enrollable (GOV-3 invariant, SPEC3 §4.2)', () => {
  it('mcp-server.js contains ZERO clean-lane references — no tool can enroll the consent', () => {
    assert.ok(!/clean[-_]lane/i.test(MCP_SRC),
      'mcp-server.js must never reference the clean-lane consent surface; enrollment is dashboard/CLI-only');
    assert.ok(!MCP_SRC.includes('EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED'));
  });

  it('the affirmation constant is the human checkbox sentence, transmitted verbatim', () => {
    assert.equal(cleanLane.CLEAN_LANE_AFFIRMATION,
      'I understand and choose auto-publish for qualifying extracted learnings.');
  });

  it('the consent version is a dated id (versioned-clickwrap discipline)', () => {
    assert.match(cleanLane.CLEAN_LANE_CONSENT_VERSION, /^\d{4}-\d{2}-\d{2}-clean-lane-[a-z0-9]+$/);
  });
});

describe('server.js summary route: params + back-compat (structural)', () => {
  it('parses lane/flag/signal/category/ids/limit/offset/full and passes opts through', () => {
    const slice = sliceAt(SERVER_SRC, "app.get('/account/pending/summary'", 3600);
    for (const param of ["'lane'", "'flag'", "'signal'", "'category'", "'ids'", "'limit'", "'offset'", "'full'"]) {
      assert.ok(slice.includes(`q.has(${param})`) || slice.includes(`q.get(${param})`), `summary route must read ${param}`);
    }
    assert.match(slice, /summarizeOwnPending\(comparisonCatalog\(learnings, accountId\), accountId, opts\)/);
    assert.match(slice, /SELF_REVIEW_LANES\.includes\(lane\)/, '400 on unknown lane');
  });
});

describe('openapi.json documents the B1 contract', () => {
  it('summary path + approvable_count + lane; /learn gains submission_channel', () => {
    assert.ok(OPENAPI_SRC.includes('/account/pending/summary'));
    assert.ok(OPENAPI_SRC.includes('approvable_count'));
    assert.ok(OPENAPI_SRC.includes('ready_to_publish'));
    assert.ok(OPENAPI_SRC.includes('submission_channel'));
  });
  it('the DARK clean-lane routes are NOT advertised while dark', () => {
    assert.ok(!OPENAPI_SRC.includes('/account/clean-lane'),
      'dark consent routes must not be published in openapi until C1 activation');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Behavioral: boot the real server — auto-freeze guardrail END TO END
//    (Gate-A F1 on fcf606b: token-presence pins cannot detect a disabled
//    brake — a `false &&` mutation at either guardrail call site survived
//    them. This leg kills BOTH mutations behaviorally: the post-retraction
//    freeze via the status read after retract, the pre-publish freeze via
//    the re-grant-then-submit hold. Boot pattern: pricing-visibility.)
// ─────────────────────────────────────────────────────────────────────────────

const RAW_API_KEY = 'axl_' + 'a'.repeat(40);
const BOOT_ACCOUNT = 'acc_spec3boot';

function bootFixtureCatalog() {
  // Clone a real seed record so every field migrations/scoring expect exists.
  // Non-empty catalog = no CS-1 re-seeding.
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  const l = JSON.parse(JSON.stringify(base));
  l.id = 'boot_seed_1';
  l.status = 'approved';
  return [l];
}

function bootFixtureAccounts() {
  const now = new Date().toISOString();
  return {
    [BOOT_ACCOUNT]: {
      id: BOOT_ACCOUNT,
      email: 'spec3-boot@test.local',
      created_at: now,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: now,
      publication_trust: {
        source: 'operator_grant',
        granted_at: now,
        ref: 'operator:spec3-b1-fixture',
      },
      api_keys: [{
        id: 'key_spec3boot',
        hash: crypto.createHash('sha256').update(RAW_API_KEY).digest('hex'),
        label: 'spec3-boot',
        scope: 'contribute',
        scope_version: 2,
        created_at: now,
        active: true,
      }],
    },
  };
}

/** A clean, floor+threshold-passing extraction-channel /learn payload.
 *  Bodies are deliberately boring tech prose: no names, paths, handles,
 *  client/company phrasing — they must pass the regex sensitivity layer. */
function extractionPayload(n) {
  const topics = {
    1: {
      title: 'Retry idempotent requests with jittered backoff on 502',
      body: 'Exponential backoff with jitter resolves intermittent 502 errors from upstream gateways when retrying idempotent requests. Cap retries at five attempts and honor any retry-after header the gateway returns before the next attempt.',
      tags: ['http', 'retry', 'backoff'],
    },
    2: {
      title: 'Enable write-ahead logging before concurrent sqlite readers',
      body: 'Enable write-ahead logging mode in embedded sqlite databases before allowing concurrent readers; otherwise a long-running write transaction blocks every reader and the stalls surface as random query timeouts under load.',
      tags: ['sqlite', 'wal', 'concurrency'],
    },
    3: {
      title: 'Set server name indication explicitly behind tls-terminating proxies',
      body: 'Set the server name indication field explicitly when connecting through a reverse proxy that terminates tls for many hostnames; without it certificate validation fails intermittently depending on which backend certificate the proxy presents first.',
      tags: ['tls', 'sni', 'proxy'],
    },
    4: {
      title: 'Pin cron schedules in utc to avoid daylight saving drift',
      body: 'Cron schedules run in the timezone of the host daemon, not the calling shell; pin every schedule in utc and convert at render time, or jobs silently shift by an hour across daylight saving transitions.',
      tags: ['cron', 'timezone', 'scheduling'],
    },
  };
  const t = topics[n];
  return {
    ...t,
    category: 'code-execution',
    task_context: 'spec3 b1 behavioral boot test',
    outcome: 'success',
    contributor_agent: 'auxilo-hook/claude-code',
    submission_channel: 'extraction',
    quality_self_assessment: { specificity: 4, actionability: 4, novelty: 4, completeness: 4, total: 16 },
  };
}

describe('behavioral: clean-lane guardrail + channel-hold end to end', () => {
  it('freeze fires at BOTH call sites; dark 404 is un-fingerprintable; grant row while dark still holds', { timeout: 240_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
      );
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (structural pins remain enforcing)');
      return;
    }
    const reservation = await reservePort();
    if (reservation.skipReason) {
      t.skip(reservation.skipReason);
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-spec3boot-'));
    let child = null;
    let baseUrl;
    const H = { 'X-API-Key': RAW_API_KEY, 'Content-Type': 'application/json' };
    const get = async (p, expectStatus = 200) => {
      const res = await fetch(`${baseUrl}${p}`, { headers: H });
      assert.equal(res.status, expectStatus, `GET ${p} → ${res.status}`);
      return res.json();
    };
    const post = async (p, body, expectStatus) => {
      const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
      assert.equal(res.status, expectStatus, `POST ${p} → ${res.status}: ${JSON.stringify(await res.clone().json().catch(() => ({})))}`);
      return res.json();
    };
    const grantBody = {
      consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
      agree: true,
      affirmation: cleanLane.CLEAN_LANE_AFFIRMATION,
    };

    try {
      // ── Stage the sandbox (pricing-visibility pattern) ────────────────────
      stageServer({
        repoRoot: REPO_ROOT,
        tmpDir,
        nodeModulesDir,
        port: reservation.port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['lib', 'public', 'prompts', 'config'],
        replacements: [],
      });
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(bootFixtureCatalog(), null, 2));
      fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify(bootFixtureAccounts(), null, 2));

      const bootEnv = {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        // regex-only sensitivity: the LLM layer fails CLOSED without a real
        // key, which would hold every submission and mask the lane under test
        LLM_SENSITIVITY_ENABLED: 'false',
        // lib modules resolve through the symlinked repo lib/, so point their
        // data reads and writes back at the staged fixture store explicitly.
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
      };

      // ══ BOOT 1: flag LIT ══════════════════════════════════════════════════
      let boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: { ...bootEnv, EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'true' },
        timeoutMs: 60_000,
        maxAttempts: 4,
      });
      if (boot.skipReason) {
        t.skip(boot.skipReason);
        return;
      }
      child = boot.child;
      baseUrl = boot.baseUrl;

      // No consent yet → status visible (flag on) and inactive.
      const s0 = await get('/account/clean-lane');
      assert.equal(s0.clean_lane_active, false);
      assert.equal(s0.consent_version_current, cleanLane.CLEAN_LANE_CONSENT_VERSION);

      // Grant (strengthened clickwrap).
      const g1 = await post('/account/clean-lane/grant', grantBody, 200);
      assert.equal(g1.clean_lane_active, true);
      assert.equal(g1.min_auto_publish_quality, 16);

      // Submission 1: clean + 16/20 + extraction → AUTO-PUBLISHES with stamps + notice.
      const r1 = await post('/learn', extractionPayload(1), 201);
      assert.equal(r1.status, 'approved', `expected clean-lane auto-publish, got ${r1.status} (${JSON.stringify(r1.review_reason || [])})`);
      assert.equal(r1.published_via, 'clean_lane_standing_consent');
      assert.ok(typeof r1.standing_consent_notice === 'string' && r1.standing_consent_notice.includes('Retractable until'));
      assert.ok(r1.retractable_until);

      // Retract it → 1/1 in 30d = 100% > 5% → the POST-RETRACTION guardrail
      // site must freeze the lane NOW.
      const delRes = await fetch(`${baseUrl}/learn/${r1.id}?reason=retract`, { method: 'DELETE', headers: H });
      assert.equal(delRes.status, 200, `retraction → ${delRes.status}`);
      const del = await delRes.json();
      assert.equal(del.status, 'retracted');

      // KILLS the post-retraction `false &&` mutation: with the guardrail
      // disabled there, the lane would still read active/grant here.
      const s1 = await get('/account/clean-lane');
      assert.equal(s1.clean_lane_active, false, 'retraction-rate breach must freeze the lane at the retraction site');
      assert.equal(s1.last_action, 'freeze');
      assert.equal(s1.freeze_reason, 'retraction_rate');

      // Frozen lane → next clean+scored extraction item HOLDS.
      const r2 = await post('/learn', extractionPayload(2), 201);
      assert.equal(r2.status, 'pending_review');
      assert.ok(r2.review_reason.includes('standing_consent_off'), `expected standing_consent_off, got ${JSON.stringify(r2.review_reason)}`);

      // Explicit human re-grant reactivates the lane...
      const g2 = await post('/account/clean-lane/grant', grantBody, 200);
      assert.equal(g2.clean_lane_active, true);

      // ...but the 30d stats still show the breach, so the PRE-PUBLISH
      // guardrail site must freeze again and HOLD this item.
      // KILLS the pre-publish `false &&` mutation: with the guardrail disabled
      // there, this submission would auto-publish 'approved'.
      const r3 = await post('/learn', extractionPayload(3), 201);
      assert.equal(r3.status, 'pending_review', 're-grant under a standing breach must re-freeze at the publish site, never publish');
      assert.ok(r3.review_reason.includes('standing_consent_off'), `expected standing_consent_off, got ${JSON.stringify(r3.review_reason)}`);
      const s2 = await get('/account/clean-lane');
      assert.equal(s2.last_action, 'freeze', 'the pre-publish guardrail must have re-frozen the lane');

      // Bonus lane coverage: both held items sit in ready_to_publish — one
      // counted bulk-approve away (the B1 contract, behaviorally).
      const summary = await get('/account/pending/summary');
      const lanes = Object.fromEntries(summary.items.map((r) => [r.title, r.lane]));
      assert.equal(lanes[extractionPayload(2).title], 'ready_to_publish');
      assert.equal(lanes[extractionPayload(3).title], 'ready_to_publish');
      assert.ok(summary.approvable_count >= 2);

      // Leave an ACTIVE grant row on disk for the dark boot below.
      await post('/account/clean-lane/grant', grantBody, 200);

      await stopServer(child);
      child = null;

      // ══ BOOT 2: flag DARK (absent), SAME data dir ═════════════════════════
      boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: bootEnv,
        timeoutMs: 60_000,
        maxAttempts: 4,
      });
      if (boot.skipReason) {
        t.skip(boot.skipReason);
        return;
      }
      child = boot.child;
      baseUrl = boot.baseUrl;

      // F2: the dark 404 must be byte-shape-identical to the catch-all 404 —
      // same keys, same error/help, same message pattern — so the routes'
      // existence cannot be fingerprinted by a body diff.
      const darkRes = await fetch(`${baseUrl}/account/clean-lane`, { headers: H });
      assert.equal(darkRes.status, 404);
      const dark = await darkRes.json();
      const unknownRes = await fetch(`${baseUrl}/account/definitely-not-a-route`, { headers: H });
      assert.equal(unknownRes.status, 404);
      const unknown = await unknownRes.json();
      assert.deepEqual(Object.keys(dark).sort(), Object.keys(unknown).sort(), 'dark 404 body keys must match the catch-all');
      assert.equal(dark.error, unknown.error);
      assert.equal(dark.help, unknown.help);
      assert.equal(dark.message, 'No endpoint at GET /account/clean-lane');
      assert.equal(unknown.message, 'No endpoint at GET /account/definitely-not-a-route');
      await post('/account/clean-lane/grant', grantBody, 404);

      // The reviewer's forged-grant-row probe: an ACTIVE grant row exists on
      // disk, but with the flag dark the lane must not arm — clean+scored
      // extraction items still HOLD.
      const r4 = await post('/learn', extractionPayload(4), 201);
      assert.equal(r4.status, 'pending_review', 'a grant row on disk must be inert while the flag is dark');
      assert.ok(r4.review_reason.includes('standing_consent_off'), `expected standing_consent_off, got ${JSON.stringify(r4.review_reason)}`);
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
