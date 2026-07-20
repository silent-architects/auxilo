'use strict';

/**
 * test/wave5a-money-closures.test.js — Wave-5A (2026-07-19)
 *
 * Covers BUILD-SPEC-WAVE5A-2026-07-19 (PUNCH-LIST rows):
 *   §1 CH-5     — verdict/quality rebalance: the verdict compares price to a
 *                 VALUE benchmark (diy × quality × freshness), so quality and
 *                 freshness cancel and a fresh q16-19 fact lands approvable at
 *                 cold demand while the ungated 3.0x shelf stays "expensive".
 *   §2 CH-6     — rating integrity: per-account replace semantics, distinct-
 *                 rater activation gates, JSONL coherence, leak guard.
 *   §3 AUD19-16 — USDC withdrawal timeout double-pay: debit at broadcast,
 *                 disposition-aware resolution, in-flight 409, settlement-id
 *                 keyed reservations, WAL recovery extension, hourly liveness.
 *   §4 GTM-9    — timestamped unlock events at the WAL-protected commit point.
 *
 * Style matches the aud19/wave1 suites: pure-logic tests against libs +
 * source-level wiring assertions against server.js (it hardcodes PORT/DATA_DIR,
 * so endpoints are only assertable statically).
 *
 * Runner: node --test test/wave5a-money-closures.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pricing = require('../lib/pricing.js');
const wal = require('../lib/wal.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

// ─── Slices ──────────────────────────────────────────────────────────────────

function slice(startMarker, endMarker) {
  const start = SERVER_SRC.indexOf(startMarker);
  assert.ok(start !== -1, `slice start marker missing: ${startMarker}`);
  const end = SERVER_SRC.indexOf(endMarker, start);
  assert.ok(end !== -1, `slice end marker missing: ${endMarker}`);
  return SERVER_SRC.slice(start, end);
}

const unlockSlice = () => slice("app.get('/knowledge/:id'", "app.post('/knowledge/:id/rate'");
const rateSlice = () => slice("app.post('/knowledge/:id/rate'", "app.get('/pricing/categories'");
const withdrawSlice = () => slice("app.post('/withdraw', async (c) => {", "app.get('/contributor/:wallet/settlements'");
const processingResolverSlice = () => slice('async function resolveProcessingSettlements', 'const SETTLEMENT_MAX_RETRIES');
const stuckResolverSlice = () => slice('async function resolveStuckSettlements', '// ─── Pipeline Data');
const walWithdrawRecoverySlice = () => slice("if (entry.operation === 'withdraw') {", "} else if (entry.operation === 'withdraw_stripe') {");
const replayUnlockSlice = () => slice('function replayUnlock(entry)', 'function replayPipelineApprove');
const compactSlice = () => slice('function compactSettlements()', '// ─── Transaction Manager (SPEC-A0)');

// ─── Builders (mirror pricing-density-gate.test.js) ──────────────────────────

const DAY = 86400000;
const QA14 = { specificity: 4, actionability: 4, novelty: 3, completeness: 3, total: 14 };
const QA16 = { specificity: 4, actionability: 4, novelty: 4, completeness: 4, total: 16 };
const QA18 = { specificity: 5, actionability: 5, novelty: 4, completeness: 4, total: 18 };
const QA19 = { specificity: 5, actionability: 5, novelty: 5, completeness: 4, total: 19 };

function baseLearning(id, category, overrides = {}) {
  return {
    id,
    title: `Learning ${id}`,
    body: 'B'.repeat(600), // moderate band regardless of QA total
    category,
    tags: [`t-${id}-a`, `t-${id}-b`, `t-${id}-c`],
    status: 'approved',
    quality: { unlocks: 0, ratings: 0, avg_helpfulness: 0, score: 0 },
    demand: { search_impressions_7d: 0, unlocks_7d: 0 },
    created_at: new Date(Date.now() - 40 * DAY).toISOString(),
    ...overrides,
  };
}

function fillerCatalog(count, category = 'code-execution') {
  const cat = [];
  for (let i = 0; i < count; i++) {
    cat.push(baseLearning(`lrn_f${i}`, i % 2 === 0 ? category : 'web-interaction'));
  }
  return cat;
}

/** Cold live-quoted candidate: no pricing object, no unlock_price. */
function coldCandidate(qa, createdAt) {
  const l = baseLearning('lrn_cand', 'code-execution', {
    tags: ['cand-a', 'cand-b', 'cand-c'],
    ...(qa ? { quality_self_assessment: qa } : {}),
    ...(createdAt ? { created_at: createdAt } : {}),
  });
  delete l.pricing;
  delete l.unlock_price;
  return l;
}

function verdictOf(l, catalog) {
  const price = pricing.getCurrentPrice(l, catalog);
  return pricing.calculateVerdict({ ...l, pricing: { current_price: price } });
}

// ════════════════════════════════════════════════════════════════════════════
// §1 CH-5 — verdict/quality rebalance
// ════════════════════════════════════════════════════════════════════════════

describe('CH-5: value-adjusted verdict benchmark (lib/pricing.js)', () => {
  it('V1 headline: a FRESH (<7d) q19 wall-test fact lands "consider" at cold demand', () => {
    const l = coldCandidate(QA19, new Date().toISOString());
    assert.equal(verdictOf(l, fillerCatalog(58)), 'consider',
      'the extraction-floor survivor class must be approvable on arrival');
  });

  it('V2: fresh q16 and 31-180d q18 cold items land "consider"', () => {
    assert.equal(verdictOf(coldCandidate(QA16, new Date().toISOString()), fillerCatalog(58)), 'consider');
    assert.equal(verdictOf(coldCandidate(QA18), fillerCatalog(58)), 'consider');
  });

  it('V2b: every self-score tier 14-20 is "consider" at the 1.5 cap, cold, any freshness bracket', () => {
    // Quality and freshness cancel out of the ratio: uniqueness × demand =
    // 1.5 × 0.8412 = 1.262 for the whole family.
    for (const qa of [QA14, QA16, QA18, QA19]) {
      for (const ageDays of [1, 10, 20, 40, 200]) {
        const l = coldCandidate(qa, new Date(Date.now() - ageDays * DAY).toISOString());
        assert.equal(verdictOf(l, fillerCatalog(58)), 'consider',
          `qa=${qa.total} age=${ageDays}d must be consider`);
      }
    }
  });

  it('V3 anti-whitewash: the ungated 3.0x stored shelf price still reads "expensive"', () => {
    // Uniqueness (and demand) deliberately stay OUT of the benchmark.
    const l = baseLearning('lrn_shelf', 'code-execution', {
      pricing: { base_price: 2.736, current_price: 2.30 },
      unlock_price: 2.30,
    });
    assert.equal(pricing.calculateVerdict(l), 'expensive');
    // Even max quality + first-week freshness cannot launder a 3.0x price:
    const lq = baseLearning('lrn_shelf2', 'code-execution', {
      quality_self_assessment: QA18,
      created_at: new Date().toISOString(),
      pricing: { base_price: 3.384, current_price: 3.384 * 1.25 * 0.8412 },
    });
    assert.equal(pricing.calculateVerdict(lq), 'expensive');
  });

  it('V6: the default-priced $0.067 class stays strong_buy (benchmark change is not inflation)', () => {
    const l = baseLearning('lrn_d1', 'web-interaction', { unlock_price: 0.08 });
    delete l.pricing;
    assert.equal(verdictOf(l, fillerCatalog(58)), 'strong_buy');
  });

  it('V7: zero/absent price still short-circuits to "recommended"', () => {
    const l = baseLearning('lrn_free', 'code-execution');
    delete l.pricing;
    delete l.unlock_price;
    assert.equal(pricing.calculateVerdict(l), 'recommended');
  });

  it('V8: >=3 DISTINCT bad ratings SHRINK the benchmark (community overrides self-assessment)', () => {
    const selfOnly = baseLearning('lrn_v8a', 'code-execution', { quality_self_assessment: QA18 });
    const panned = baseLearning('lrn_v8b', 'code-execution', {
      quality_self_assessment: QA18,
      quality: {
        unlocks: 0, score: 0,
        ratings: 3, avg_helpfulness: 1.0,
        rater_scores: { acc_a: 1, acc_b: 1, acc_c: 1 },
      },
    });
    const bSelf = pricing.estimateValueBenchmark(selfOnly);
    const bPanned = pricing.estimateValueBenchmark(panned);
    assert.ok(bPanned < bSelf,
      `community-panned benchmark must shrink: ${bPanned} !< ${bSelf}`);
    // A price that read "consider" against the self-claimed value degrades:
    const price = 1.42; // the converged cold q18 quote
    assert.equal(pricing.calculateVerdict({ ...selfOnly, pricing: { current_price: price } }), 'consider');
    assert.equal(pricing.calculateVerdict({ ...panned, pricing: { current_price: price } }), 'expensive');
  });

  it('CH-4 merge flag closed: the submission synthetic carries contributor identity (F2 binds at submission)', () => {
    const s = slice('const syntheticForPricing = {', 'const calculatedPrice');
    assert.ok(s.includes('contributor_account_id: contributor_account_id || null,'),
      'account identity must reach countTagNeighbors on the submission path');
    assert.ok(s.includes('contributor_wallet: walletLower || null,'),
      'wallet identity (lowercased, matching stored learnings) must reach countTagNeighbors');
  });

  it('exports: estimateValueBenchmark = diy × quality × freshness', () => {
    const l = coldCandidate(QA18); // 40d → freshness 1.0
    const expected = pricing.estimateDiyCost(l)
      * pricing.calculateQualityMultiplier(l)
      * pricing.calculateFreshnessMultiplier(l);
    assert.ok(Math.abs(pricing.estimateValueBenchmark(l) - expected) < 1e-12);
    assert.equal(typeof pricing.estimateValueBenchmark, 'function');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §2 CH-6 — rating integrity
// ════════════════════════════════════════════════════════════════════════════

describe('CH-6: distinct-rater activation gates (lib/pricing.js)', () => {
  it('distinctRaterCount: map size when present; ratings fallback for frozen legacy shapes', () => {
    assert.equal(pricing.distinctRaterCount({ rater_scores: { a: 5, b: 4 }, ratings: 9 }), 2);
    assert.equal(pricing.distinctRaterCount({ rater_scores: {}, ratings: 7 }), 0);
    assert.equal(pricing.distinctRaterCount({ ratings: 5 }), 5); // pre-CH-6 shape
    assert.equal(pricing.distinctRaterCount(null), 0);
    assert.equal(pricing.distinctRaterCount({}), 0);
  });

  it('R2: three rating EVENTS from one account do NOT activate either gate', () => {
    const sybil = {
      quality_self_assessment: QA18,
      quality: { ratings: 3, avg_helpfulness: 5.0, rater_scores: { acc_sybil: 5 } },
      created_at: new Date(Date.now() - 40 * DAY).toISOString(),
      category: 'code-execution', body: 'B'.repeat(600),
    };
    // Rating multiplier stays neutral:
    assert.equal(pricing.calculateRatingMultiplier(sybil), 1.0);
    // Community blend stays inactive — multiplier equals the self-only value:
    const selfOnly = { ...sybil, quality: { ratings: 0, avg_helpfulness: 0 } };
    assert.equal(pricing.calculateQualityMultiplier(sybil),
      pricing.calculateQualityMultiplier(selfOnly));
  });

  it('R3: three DISTINCT raters activate both gates', () => {
    const rated = {
      quality_self_assessment: QA18,
      quality: { ratings: 3, avg_helpfulness: 4.8, rater_scores: { a: 5, b: 5, c: 4 } },
      created_at: new Date(Date.now() - 40 * DAY).toISOString(),
      category: 'code-execution', body: 'B'.repeat(600),
    };
    assert.equal(pricing.calculateRatingMultiplier(rated), 1.10);
    const selfOnly = { ...rated, quality: { ratings: 0, avg_helpfulness: 0 } };
    assert.notEqual(pricing.calculateQualityMultiplier(rated),
      pricing.calculateQualityMultiplier(selfOnly));
  });

  it('R7: pre-CH-6 legacy shape (no map) keeps its gate behavior via the fallback', () => {
    const legacy = { quality: { ratings: 3, avg_helpfulness: 4.8 } };
    assert.equal(pricing.calculateRatingMultiplier(legacy), 1.10);
  });
});

describe('CH-6: replace semantics + JSONL coherence (source + contract)', () => {
  const r = rateSlice();

  it('per-account slot replace: rater_scores[account] assignment, replaced score captured', () => {
    assert.ok(r.includes('q.rater_scores[raterAccountId] = helpfulness;'), 'one slot per account');
    assert.ok(r.includes('replaced: replacedScore'), 'JSONL carries the overwritten score');
    assert.ok(r.includes("replaced: replacedScore !== null"), 'response reports replacement');
    assert.ok(!r.includes('q.ratings = (q.ratings || 0) + 1;'),
      'the unconditional re-increment is gone');
  });

  it('lazy migration freezes pre-CH-6 aggregates into the legacy bucket', () => {
    assert.ok(r.includes('q.legacy_ratings = q.ratings || 0;'));
    assert.ok(r.includes('q.legacy_helpfulness_sum = q.helpfulness_sum || 0;'));
    assert.ok(r.includes('q.rater_scores = {};'));
  });

  it('aggregates recomputed as legacy + slots; distinct_raters maintained', () => {
    assert.ok(r.includes('q.distinct_raters = slotScores.length;'));
    assert.ok(r.includes('q.ratings = (q.legacy_ratings || 0) + slotScores.length;'));
    assert.ok(r.includes('q.helpfulness_sum = (q.legacy_helpfulness_sum || 0) + slotSum;'));
  });

  it('JSONL (event log) is appended BEFORE the catalog snapshot write', () => {
    const jsonlAt = r.indexOf('fs.appendFileSync(RATINGS_FILE');
    const catalogAt = r.indexOf('safeWrite(LEARNINGS_FILE, learnings);');
    assert.ok(jsonlAt !== -1 && catalogAt !== -1 && jsonlAt < catalogAt,
      'the durable rating log must land first — it is the source of truth on crash');
  });

  it('LW-7 pins hold: purchase gate + account-keyed cooldown unchanged', () => {
    assert.ok(r.includes('if (!hasPurchase(raterAccountId, id)) {'));
    assert.ok(r.includes('const rateKey = `${raterAccountId}:${id}`;'));
  });

  it('leak guard: stripOpsCounters strips the rater map + legacy buckets', () => {
    const s = slice('function stripOpsCounters(quality)', 'return pub;');
    assert.ok(s.includes('rater_scores: _rs'), 'rater account ids must never reach buyers');
    assert.ok(s.includes('legacy_ratings: _lr'));
    assert.ok(s.includes('legacy_helpfulness_sum: _lhs'));
    assert.ok(s.includes('unlocks_total: _ut'), 'W2B-2 strip still present');
  });

  it('R5 coherence property: folding the JSONL last-write-wins per account reproduces the map', () => {
    // The documented contract (spec §2): rater_scores is exactly the fold of
    // the event log per (learning, account).
    const log = [
      { learning_id: 'lrn_1', rater_account_id: 'acc_a', helpfulness: 5, replaced: null },
      { learning_id: 'lrn_1', rater_account_id: 'acc_a', helpfulness: 2, replaced: 5 },
      { learning_id: 'lrn_1', rater_account_id: 'acc_b', helpfulness: 4, replaced: null },
      { learning_id: 'lrn_2', rater_account_id: 'acc_a', helpfulness: 3, replaced: null }, // R8: other learning
      { learning_id: 'lrn_1', helpfulness: 5 }, // legacy line, no account → legacy bucket
    ];
    const fold = {};
    let legacyCount = 0;
    for (const e of log) {
      if (e.learning_id !== 'lrn_1') continue;
      if (!e.rater_account_id) { legacyCount++; continue; }
      fold[e.rater_account_id] = e.helpfulness;
    }
    assert.deepEqual(fold, { acc_a: 2, acc_b: 4 });
    assert.equal(legacyCount, 1);
    // Replace semantics: 3 events from acc_a+acc_b collapse to 2 slots.
    assert.equal(Object.keys(fold).length, 2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §3 AUD19-16 — withdrawal timeout double-pay
// ════════════════════════════════════════════════════════════════════════════

describe('AUD19-16(1): timeout branch debits at broadcast (source)', () => {
  let w, timeoutBranch;
  before(() => {
    w = withdrawSlice();
    timeoutBranch = w.slice(
      w.indexOf("} else if (txResult.status === 'timeout') {"),
      w.indexOf('} else {', w.indexOf("} else if (txResult.status === 'timeout') {"))
    );
  });

  it('disposition recorded in the WAL payload BEFORE the debit', () => {
    const dispAt = timeoutBranch.indexOf("updateWalPayload(walId, { broadcast_disposition: 'timeout', tx_hash: txResult.hash });");
    const debitAt = timeoutBranch.indexOf('debitWithdrawableBalance(freshEntry, payout_amount);');
    assert.ok(dispAt !== -1, 'updateWalPayload call must exist in the timeout branch');
    assert.ok(debitAt !== -1, 'the timeout branch must debit');
    assert.ok(dispAt < debitAt, 'disposition must land before the ledger write');
  });

  it('debit mirrors the confirmed path: debitWithdrawableBalance + markProcessedSettlement + safeWrite', () => {
    assert.ok(timeoutBranch.includes('debitWithdrawableBalance(freshEntry, payout_amount);'));
    assert.ok(timeoutBranch.includes('markProcessedSettlement(freshEntry, settlementId);'));
    assert.ok(timeoutBranch.includes('safeWrite(EARNINGS_FILE, earnings);'));
    assert.equal(w.split('debitWithdrawableBalance(freshEntry, payout_amount);').length - 1, 2,
      'exactly two debit sites: confirmed + timeout');
  });

  it('settlement row is stamped debited_at_broadcast and the WAL is committed (dual-write complete)', () => {
    assert.ok(timeoutBranch.includes('debited_at_broadcast: true'));
    assert.ok(timeoutBranch.includes("markStepComplete(walId, 'earnings_deducted');"));
    assert.ok(timeoutBranch.includes("markStepComplete(walId, 'settlement_appended');"));
    assert.ok(timeoutBranch.includes('commitWal(walId);'));
    assert.ok(!timeoutBranch.includes('Do NOT commit WAL'),
      'the old leave-the-WAL-open model is gone');
  });
});

describe('AUD19-16(2): resolver asymmetry fixed, disposition-aware (source)', () => {
  const p = processingResolverSlice();

  it('resolution branches key off debited_at_broadcast', () => {
    assert.ok(p.includes('const debited = !!s.debited_at_broadcast;'));
  });

  it('the broken shapes are GONE: no lone total_withdrawn bump, no phantom refund', () => {
    assert.ok(!p.includes('entry.total_withdrawn += s.amount;'),
      'old success branch bumped total_withdrawn without debiting pending');
    assert.ok(!p.includes('entry.pending_balance += s.amount;'),
      'old revert branch refunded a never-debited balance');
  });

  it('legacy undebited success now debits with the correct dual shape', () => {
    assert.ok(p.includes("entry.total_withdrawn = parseFloat(((entry.total_withdrawn || 0) + s.amount).toFixed(6));"));
    assert.ok(p.includes('entry.pending_balance = parseFloat(Math.max(0, (entry.pending_balance || 0) - s.amount).toFixed(6));'));
  });

  it('refund is marker-guarded and inverts the full debit (pending, total_withdrawn, count)', () => {
    const rf = slice('function refundDebitedSettlement(entry, s)', 'let processingResolverRunning');
    assert.ok(rf.includes('const refundMarker = `${s.id}:refund`;'));
    assert.ok(rf.includes('if (hasProcessedSettlement(entry, refundMarker)) {'), 'idempotent across replays');
    assert.ok(rf.includes('entry.pending_balance = parseFloat(((entry.pending_balance || 0) + s.amount).toFixed(6));'));
    assert.ok(rf.includes('entry.total_withdrawn = parseFloat(Math.max(0, (entry.total_withdrawn || 0) - s.amount).toFixed(6));'));
    assert.ok(rf.includes('entry.withdrawal_count = Math.max(0, (entry.withdrawal_count || 0) - 1);'));
    assert.ok(rf.includes('markProcessedSettlement(entry, refundMarker);'));
  });

  it('S9-4 processing_unresolved branches are debited-aware too', () => {
    const s = stuckResolverSlice();
    assert.ok(s.includes("if (srcU1 !== 'new' && !s.debited_at_broadcast && !hasProcessedSettlement(entryU1, s.id)) {"),
      'unresolved-confirm must not double-debit a broadcast-debited settlement');
    assert.ok(s.includes("if (srcU2 !== 'new' && s.debited_at_broadcast) {"),
      'unresolved-revert refunds only what was debited');
    assert.ok(s.includes("if (srcU3 !== 'new' && s.debited_at_broadcast) {"),
      '48h force-fail refunds only what was debited');
    assert.ok(!s.includes('entryU2.pending_balance += s.amount;'),
      'the unconditional revert refund is gone');
    assert.ok(!s.includes('entryU3.pending_balance += s.amount;'),
      'the unconditional force-fail refund is gone');
  });
});

describe('AUD19-16 liveness: hourly reconciler reaches processing_timeout (source)', () => {
  it('resolveStuckSettlements tail-calls resolveProcessingSettlements every tick', () => {
    assert.ok(stuckResolverSlice().includes('await resolveProcessingSettlements();'));
    assert.ok(SERVER_SRC.includes('setInterval(() => resolveStuckSettlements()'),
      'hourly interval wiring intact');
  });

  it('resolveProcessingSettlements is reentrancy-guarded (startup + hourly overlap)', () => {
    const p = processingResolverSlice();
    assert.ok(SERVER_SRC.includes('let processingResolverRunning = false;'));
    assert.ok(p.includes('if (processingResolverRunning) return;'));
    assert.ok(p.includes('processingResolverRunning = false;'));
  });
});

describe('AUD19-16(3): /withdraw in-flight guard (source)', () => {
  const w = withdrawSlice();

  it('unresolved statuses are the full in-flight set', () => {
    const g = slice('const UNRESOLVED_SETTLEMENT_STATUSES', 'function findUnresolvedSettlement');
    for (const st of ['pending', 'retry', 'processing', 'processing_timeout', 'processing_unresolved']) {
      assert.ok(g.includes(`'${st}'`), `status ${st} must block a new withdrawal`);
    }
  });

  it('409 WITHDRAWAL_IN_FLIGHT before the nonce burns, re-checked under the lock', () => {
    assert.equal(w.split("code: 'WITHDRAWAL_IN_FLIGHT'").length - 1, 2,
      'guard fires pre-nonce AND under the wallet lock (TOCTOU)');
    const firstGuard = w.indexOf('findUnresolvedSettlement(walletLower)');
    const nonceAt = w.indexOf('consumeNonce(wallet)');
    assert.ok(firstGuard !== -1 && nonceAt !== -1 && firstGuard < nonceAt,
      'a blocked caller must not burn their withdrawal challenge');
    const lockAt = w.indexOf('acquireWalletLock(walletLower)');
    const secondGuard = w.indexOf('findUnresolvedSettlement(walletLower)', lockAt);
    assert.ok(secondGuard > lockAt, 'the second check sits inside the lock');
  });
});

describe('AUD19-16(4): reservations keyed by settlement id (source)', () => {
  it('createReservation writes one slot per settlement id', () => {
    const cr = slice('function createReservation(settlementId, walletAddress, amount)', 'function _setReservationStatus');
    assert.ok(cr.includes('reservations[settlementId] = {'));
    assert.ok(cr.includes('wallet: walletAddress,'), 'the wallet rides inside the record now');
  });

  it('commit/release resolve the id key first, then the legacy wallet key', () => {
    const st = slice('function _setReservationStatus', 'const lastWithdrawalAttempt');
    assert.ok(st.includes('reservations[settlementId]) ? settlementId'));
    assert.ok(st.includes('reservations[walletAddress]) ? walletAddress'));
  });

  it('the withdraw route mints the settlement id BEFORE the reservation and keys every call by it', () => {
    const w = withdrawSlice();
    const idAt = w.indexOf('const settlementId = `wd_${crypto.randomUUID()}`;');
    const resAt = w.indexOf('createReservation(settlementId, walletLower, payout_amount);');
    assert.ok(idAt !== -1 && resAt !== -1 && idAt < resAt);
    assert.ok(w.includes('commitReservation(settlementId, walletLower);'));
    assert.equal(w.split('releaseReservation(settlementId, walletLower);').length - 1, 2,
      'pre-broadcast failure + failed broadcast both release the id-keyed slot');
  });

  it('releaseOrphanedReservation releases the id-keyed slot directly (guard is legacy-only)', () => {
    const ro = slice('function releaseOrphanedReservation(wallet, amount, settlementId', 'function runConsistencyCheck');
    assert.ok(ro.includes('if (settlementId && reservations[settlementId]) {'));
    assert.ok(ro.includes('releaseReservation(settlementId, wallet);'));
  });
});

describe('AUD19-16: WAL withdraw-recovery extended to the new model (source)', () => {
  const rec = walWithdrawRecoverySlice();

  it('disposition + tx_hash read from the payload', () => {
    assert.ok(rec.includes("const walDisposition = entry.payload.broadcast_disposition || null;"));
    assert.ok(rec.includes('const walTxHash = entry.payload.tx_hash || null;'));
  });

  it('both-steps-complete no longer leaks the WAL entry', () => {
    assert.ok(rec.includes("if (completed.includes('earnings_deducted') && completed.includes('settlement_appended')) {"));
  });

  it('deducted-only + timeout disposition appends a debited processing_timeout record, never a phantom settled', () => {
    const branch = rec.slice(rec.indexOf("if (walDisposition === 'timeout') {"), rec.indexOf('} else {', rec.indexOf("if (walDisposition === 'timeout') {")));
    assert.ok(branch.includes("status: 'processing_timeout'"));
    assert.ok(branch.includes('debited_at_broadcast: true'));
    assert.ok(branch.includes('tx_hash: walTxHash'));
  });

  it('replayed debit is marker-guarded and uses the correct dual shape', () => {
    assert.ok(rec.includes('if (hasProcessedSettlement(wEntry, settlement_id)) {'), 'no double-debit under replay');
    assert.ok(rec.includes('wEntry.pending_balance = parseFloat(Math.max(0, (wEntry.pending_balance || 0) - amount).toFixed(6));'));
    assert.ok(rec.includes('wEntry.total_withdrawn = parseFloat(((wEntry.total_withdrawn || 0) + amount).toFixed(6));'));
    assert.ok(!rec.includes('wEntry.total_withdrawn = parseFloat((wEntry.total_withdrawn + amount).toFixed(6));'),
      'the old lone total_withdrawn bump (no pending debit) is gone');
  });

  it('no-steps + timeout disposition replays the FULL completion instead of releasing a live broadcast', () => {
    assert.ok(rec.includes('Replaying timeout completion for broadcast withdrawal'));
    // the plain no-steps release survives for the undispositioned case:
    assert.ok(rec.includes('Releasing reservation for incomplete withdrawal'));
  });
});

describe('AUD19-16: lib/wal.js updateWalPayload (behavioral)', () => {
  it('merges the patch into payload, preserves steps, and is readable back', () => {
    const id = wal.createWalEntry('withdraw', { wallet_address: '0xabc', amount: 1.5, settlement_id: 'wd_test' });
    try {
      wal.markStepComplete(id, 'earnings_deducted');
      wal.updateWalPayload(id, { broadcast_disposition: 'timeout', tx_hash: '0xhash' });
      const entry = wal.getPendingWalEntries().find(e => e.id === id);
      assert.ok(entry, 'entry must be pending');
      assert.equal(entry.payload.broadcast_disposition, 'timeout');
      assert.equal(entry.payload.tx_hash, '0xhash');
      assert.equal(entry.payload.wallet_address, '0xabc', 'original payload preserved');
      assert.deepEqual(entry.steps_completed, ['earnings_deducted'], 'steps preserved');
    } finally {
      wal.commitWal(id);
    }
  });

  it('missing entry is a warn, not a throw', () => {
    assert.doesNotThrow(() => wal.updateWalPayload('no-such-id', { x: 1 }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// §4 GTM-9 — timestamped unlock events
// ════════════════════════════════════════════════════════════════════════════

describe('GTM-9: unlock-event log (source)', () => {
  it('separate append-only file — never folded into the settlements state machine', () => {
    assert.ok(SERVER_SRC.includes("const UNLOCK_EVENTS_FILE = path.join(DATA_DIR, 'unlock-events.jsonl');"));
    assert.ok(!compactSlice().includes('UNLOCK_EVENTS_FILE'),
      'compactSettlements must never touch the event log');
    const ap = slice('function appendUnlockEvent(event)', 'function hasUnlockEvent');
    assert.ok(ap.includes('fs.appendFileSync(UNLOCK_EVENTS_FILE'));
  });

  it('U1: written at the WAL-protected commit point with the exact shape, no buyer PII', () => {
    const h = unlockSlice();
    const earningsStepAt = h.indexOf("markStepComplete(walId, 'update_earnings');");
    const eventAt = h.indexOf('appendUnlockEvent({');
    const eventStepAt = h.indexOf("markStepComplete(walId, 'unlock_event_appended');");
    const commitAt = h.indexOf('commitWal(walId);');
    assert.ok(earningsStepAt !== -1 && eventAt !== -1 && eventStepAt !== -1 && commitAt !== -1);
    assert.ok(earningsStepAt < eventAt && eventAt < eventStepAt && eventStepAt < commitAt,
      'event append sits between update_earnings and the WAL commit');

    const eventObj = h.slice(eventAt, h.indexOf('});', eventAt));
    assert.ok(eventObj.includes('id: walId'), 'event id == WAL id (dedupe key)');
    assert.ok(eventObj.includes('ts: unlockedAt'));
    assert.ok(eventObj.includes('amount_paid_usd: accrualBasis'), 'basis, not list price');
    assert.ok(eventObj.includes('funding_source: fundingSource'));
    assert.ok(!eventObj.includes('purchaser'), 'NO buyer identity in the event row');
    assert.ok(!eventObj.includes('ip'), 'no IP fields');
  });

  it('U1b: the canonical timestamp is stored in the WAL payload (replay determinism)', () => {
    const h = unlockSlice();
    assert.ok(h.includes('const unlockedAt = new Date().toISOString();'));
    assert.ok(h.includes('unlocked_at: unlockedAt,'), 'payload carries the same instant');
  });

  it('U1c: an event-append IO failure is best-effort — the money path is never hostage', () => {
    const h = unlockSlice();
    const tryAt = h.indexOf('try {', h.indexOf("markStepComplete(walId, 'update_earnings');"));
    const catchAt = h.indexOf('} catch (evtErr) {');
    assert.ok(tryAt !== -1 && catchAt !== -1 && tryAt < catchAt,
      'appendUnlockEvent wrapped in its own try/catch');
  });

  it('U2: replayUnlock re-emits the row when the step is missing, duplicate-scanned', () => {
    const rp = replayUnlockSlice();
    assert.ok(rp.includes("if (!steps.includes('unlock_event_appended'))"));
    assert.ok(rp.includes('if (!hasUnlockEvent(entry.id)) {'),
      'crash between append and step marker must not duplicate the row');
    assert.ok(rp.includes('ts: entry.payload.unlocked_at'), 'replay uses the stored instant');
    assert.ok(rp.includes('amount_paid_usd: grossAmount'), 'replay books the stored basis');
  });

  it('U3: hasUnlockEvent parses per-line and matches on id', () => {
    const he = slice('function hasUnlockEvent(eventId)', 'function compactSettlements');
    assert.ok(he.includes('JSON.parse(line).id === eventId'));
  });
});
