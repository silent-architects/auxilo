'use strict';

/**
 * test/review-seamless.test.js: seamless learning-review flow.
 *
 * Three layers, matching the repo's conventions:
 *   A) Behavioral unit tests of the pure logic:
 *      - lib/self-review.js: summarizeOwnPending (ownership isolation, compact
 *        rows with NO body, sorting, clusters, quality bands) and
 *        applyBulkDecisions (validation, cap, counted confirmation,
 *        idempotency per id, duplicate handling, ownership discipline).
 *      - lib/review.js: selectForBulkApprove (approve-clean selection incl.
 *        flagged exclusion and threshold edges) and chunkDecisions.
 *      - mcp-server.js: planApproveClean (dry-run shape).
 *   B) Structural tests that server.js wires the routes correctly (scopes,
 *      confirm_count passthrough, single write per batch, audit line), in the
 *      LW-15 account-routes region. Mirrors test/r01-launch-blockers.test.js.
 *   C) Structural tests that the CLI and MCP keep the counted-confirmation
 *      contract: no --yes bypass on any approve path; MCP approve_clean is
 *      dry-run by default and requires confirm:true plus expected_count.
 *
 * Runner: node --test test/review-seamless.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const selfReview = require('../lib/self-review.js');
const reviewLib = require('../lib/review.js');
const { planApproveClean } = require('../mcp-server.js');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const CLI_SRC = fs.readFileSync(path.join(__dirname, '..', 'bin', 'auxilo-cli.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
const DASH_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf-8');

function sliceAt(src, marker, span = 3000) {
  const i = src.indexOf(marker);
  assert.notEqual(i, -1, `marker not found: ${marker}`);
  return src.slice(i, i + span);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ME = 'acc_me';
const OTHER = 'acc_other';
const TRUSTED_ACCOUNT = Object.freeze({
  publication_trust: { source: 'operator_grant', granted_at: 'test', ref: 'test:review-seamless' },
});

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
    learning('lrn_clean_hi', { quality_self_assessment: { total: 19 }, created_at: '2026-07-01T01:00:00.000Z' }),
    learning('lrn_clean_lo', { quality_self_assessment: { total: 11 } }),
    learning('lrn_unscored', { quality_self_assessment: undefined, created_at: '2026-07-02T00:00:00.000Z' }),
    learning('lrn_inj', { injection_flags: [{ pattern_id: 'ignore_previous' }], quality_self_assessment: { total: 20 } }),
    learning('lrn_sens', { sensitivity_signals: ['person_name'] }),
    learning('lrn_dupA', { possible_duplicate_of: 'lrn_clean_hi', possible_duplicate_similarity: 0.7 }),
    learning('lrn_dupB', { possible_duplicate_of: 'lrn_clean_hi', possible_duplicate_similarity: 0.66 }),
    learning('lrn_legacy', { quality_self_assessment: undefined, quality_estimate: 16 }),
    learning('lrn_approved', { status: 'approved' }),
    learning('lrn_rejected', { status: 'rejected' }),
    learning('lrn_theirs', { contributor_account_id: OTHER }),
    learning('lrn_theirs_approved', { contributor_account_id: OTHER, status: 'approved' }),
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// A1. summarizeOwnPending
// ─────────────────────────────────────────────────────────────────────────────

describe('summarizeOwnPending: triage summary', () => {
  it('counts only the caller\'s own pending items', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    assert.equal(s.pending_count, 8);
    assert.ok(!s.items.some((r) => r.id === 'lrn_theirs'), 'must never include another account\'s items');
    assert.ok(!s.items.some((r) => r.id === 'lrn_approved'), 'must never include non-pending items');
  });

  it('rows are compact: no body, no snippet', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    for (const r of s.items) {
      assert.equal('body' in r, false, `row ${r.id} must not carry the body`);
      assert.equal('snippet' in r, false, `row ${r.id} must not carry a snippet`);
    }
  });

  it('derives screen verdicts from the persisted flag fields', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const by = Object.fromEntries(s.items.map((r) => [r.id, r]));
    assert.equal(by.lrn_clean_hi.screens_passed, true);
    assert.deepEqual(by.lrn_inj.flags, ['injection']);
    assert.deepEqual(by.lrn_sens.flags, ['content_sensitivity']);
    assert.deepEqual(by.lrn_dupA.flags, ['near_duplicate']);
    assert.equal(s.clean_count, 4); // clean_hi, clean_lo, unscored, legacy
    assert.equal(s.flagged_count, 4);
  });

  it('quality falls back to legacy quality_estimate and marks unscored as null', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const by = Object.fromEntries(s.items.map((r) => [r.id, r]));
    assert.equal(by.lrn_legacy.quality, 16);
    assert.equal(by.lrn_legacy.quality_source, 'legacy_estimate');
    assert.equal(by.lrn_unscored.quality, null);
    assert.equal(by.lrn_unscored.quality_source, null);
  });

  it('sorts quality desc with unscored last, ties oldest first', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const qualities = s.items.map((r) => (r.quality == null ? -1 : r.quality));
    const sorted = [...qualities].sort((a, b) => b - a);
    assert.deepEqual(qualities, sorted, 'rows must be quality-descending with nulls last');
    assert.equal(s.items[s.items.length - 1].quality, null);
  });

  it('clusters near-duplicates among the caller\'s own pending set', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    assert.equal(s.near_dup_clusters.length, 1);
    const cluster = s.near_dup_clusters[0].slice().sort();
    assert.deepEqual(cluster, ['lrn_clean_hi', 'lrn_dupA', 'lrn_dupB']);
  });

  it('quality bands add up to the pending count', () => {
    const s = selfReview.summarizeOwnPending(fixtureCatalog(), ME);
    const bandTotal = Object.values(s.counts.by_quality_band).reduce((a, b) => a + b, 0);
    assert.equal(bandTotal, s.pending_count);
  });

  it('empty/foreign inputs return an empty summary', () => {
    assert.equal(selfReview.summarizeOwnPending([], ME).pending_count, 0);
    assert.equal(selfReview.summarizeOwnPending(fixtureCatalog(), 'acc_nobody').pending_count, 0);
    assert.equal(selfReview.summarizeOwnPending(null, ME).pending_count, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2. applyBulkDecisions
// ─────────────────────────────────────────────────────────────────────────────

describe('applyBulkDecisions: batch validation gates', () => {
  it('refuses a non-array / empty decisions payload without mutating', () => {
    const cat = fixtureCatalog();
    const before = JSON.stringify(cat);
    for (const bad of [undefined, null, 'x', {}, []]) {
      const r = selfReview.applyBulkDecisions(cat, ME, bad, { confirmCount: 0 });
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
    }
    assert.equal(JSON.stringify(cat), before, 'refused batches must not mutate');
  });

  it('enforces the hard cap (BULK_MAX) as a batch refusal', () => {
    const cat = fixtureCatalog();
    const decisions = Array.from({ length: selfReview.BULK_MAX + 1 }, (_, i) => ({ id: `lrn_${i}`, decision: 'approve' }));
    const r = selfReview.applyBulkDecisions(cat, ME, decisions, { confirmCount: decisions.length });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'too_many_decisions');
    assert.equal(r.status, 400);
  });

  it('counted confirmation: confirmCount must equal decisions.length', () => {
    const cat = fixtureCatalog();
    const before = JSON.stringify(cat);
    const decisions = [{ id: 'lrn_clean_hi', decision: 'approve' }];
    for (const bad of [undefined, null, 0, 2, '1', 1.5]) {
      const r = selfReview.applyBulkDecisions(cat, ME, decisions, { confirmCount: bad });
      assert.equal(r.ok, false, `confirmCount ${JSON.stringify(bad)} must be refused`);
      assert.equal(r.code, 'confirm_count_mismatch');
    }
    assert.equal(JSON.stringify(cat), before, 'mismatched confirmation must not mutate');
    const ok = selfReview.applyBulkDecisions(cat, ME, decisions, { confirmCount: 1, account: TRUSTED_ACCOUNT });
    assert.equal(ok.ok, true);
  });

  it('requires an authenticated account', () => {
    const r = selfReview.applyBulkDecisions(fixtureCatalog(), null, [{ id: 'x', decision: 'approve' }], { confirmCount: 1 });
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
  });
});

describe('applyBulkDecisions: per-entry semantics', () => {
  it('approves and rejects own pending items, stamping the self-review audit fields', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_clean_hi', decision: 'approve' },
      { id: 'lrn_clean_lo', decision: 'reject', reason: 'not good enough' },
    ], { confirmCount: 2, now: '2026-07-18T00:00:00.000Z', account: TRUSTED_ACCOUNT });

    assert.equal(r.ok, true);
    assert.equal(r.counts.approved, 1);
    assert.equal(r.counts.rejected, 1);
    assert.equal(r.counts.changed, 2);

    const hi = cat.find((l) => l.id === 'lrn_clean_hi');
    assert.equal(hi.status, 'approved');
    assert.equal(hi.moderation, 'manual');
    assert.equal(hi.self_review_action.action, 'self_approve');

    const lo = cat.find((l) => l.id === 'lrn_clean_lo');
    assert.equal(lo.status, 'rejected');
    assert.equal(lo.self_review_action.reason, 'not good enough');
  });

  it('is idempotent per id: already-in-target-state reports ok without change', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_approved', decision: 'approve' },
      { id: 'lrn_rejected', decision: 'reject' },
    ], { confirmCount: 2, account: TRUSTED_ACCOUNT });
    assert.equal(r.ok, true);
    assert.equal(r.counts.changed, 0);
    assert.equal(r.counts.idempotent, 2);
    for (const res of r.results) {
      assert.equal(res.ok, true);
      assert.equal(res.changed, false);
      assert.equal(res.idempotent, true);
    }
    // Retry safety: running the SAME approve twice ends in the same state.
    const cat2 = fixtureCatalog();
    selfReview.applyBulkDecisions(cat2, ME, [{ id: 'lrn_clean_hi', decision: 'approve' }], { confirmCount: 1, account: TRUSTED_ACCOUNT });
    const again = selfReview.applyBulkDecisions(cat2, ME, [{ id: 'lrn_clean_hi', decision: 'approve' }], { confirmCount: 1, account: TRUSTED_ACCOUNT });
    assert.equal(again.results[0].idempotent, true);
    assert.equal(cat2.find((l) => l.id === 'lrn_clean_hi').status, 'approved');
  });

  it('opposite decision on an already-decided item fails that entry (no silent flip)', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_approved', decision: 'reject' },
    ], { confirmCount: 1 });
    assert.equal(r.results[0].ok, false);
    assert.equal(r.results[0].code, 'not_pending');
    assert.equal(cat.find((l) => l.id === 'lrn_approved').status, 'approved');
  });

  it('ownership discipline: another account\'s id reads forbidden, even when already approved', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_theirs', decision: 'approve' },
      { id: 'lrn_theirs_approved', decision: 'approve' },
      { id: 'lrn_missing', decision: 'approve' },
    ], { confirmCount: 3 });
    assert.equal(r.results[0].code, 'forbidden');
    assert.equal(r.results[1].code, 'forbidden', 'idempotency must not leak another account\'s state');
    assert.equal(r.results[2].code, 'not_found');
    assert.equal(cat.find((l) => l.id === 'lrn_theirs').status, 'pending_review');
  });

  it('malformed entries fail individually; the rest of the batch proceeds', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_clean_hi', decision: 'approve' },
      { decision: 'approve' },
      { id: 'lrn_clean_lo', decision: 'publish' },
      { id: 'lrn_unscored', decision: 'reject', reason: 'x'.repeat(selfReview.BULK_REASON_MAX + 1) },
      'not-an-object',
    ], { confirmCount: 5, account: TRUSTED_ACCOUNT });
    assert.equal(r.ok, true);
    assert.equal(r.counts.approved, 1);
    assert.equal(r.counts.failed, 4);
    assert.equal(r.results[1].code, 'bad_entry');
    assert.equal(r.results[2].code, 'bad_decision');
    assert.equal(r.results[3].code, 'bad_reason');
    assert.equal(r.results[4].code, 'bad_entry');
    assert.equal(cat.find((l) => l.id === 'lrn_clean_hi').status, 'approved');
    assert.equal(cat.find((l) => l.id === 'lrn_unscored').status, 'pending_review');
  });

  it('duplicate id, same decision: echoes the first outcome as duplicate', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_clean_hi', decision: 'approve' },
      { id: 'lrn_clean_hi', decision: 'approve' },
    ], { confirmCount: 2, account: TRUSTED_ACCOUNT });
    assert.equal(r.counts.changed, 1, 'the item must only transition once');
    assert.equal(r.results[1].duplicate, true);
    assert.equal(r.results[1].ok, true);
  });

  it('duplicate id, conflicting decision: fails the later entry only', () => {
    const cat = fixtureCatalog();
    const r = selfReview.applyBulkDecisions(cat, ME, [
      { id: 'lrn_clean_hi', decision: 'approve' },
      { id: 'lrn_clean_hi', decision: 'reject' },
    ], { confirmCount: 2, account: TRUSTED_ACCOUNT });
    assert.equal(r.results[0].ok, true);
    assert.equal(r.results[1].code, 'conflicting_decision');
    assert.equal(cat.find((l) => l.id === 'lrn_clean_hi').status, 'approved');
  });

  it('every result carries the batch index for unambiguous mapping', () => {
    const r = selfReview.applyBulkDecisions(fixtureCatalog(), ME, [
      { id: 'lrn_clean_hi', decision: 'approve' },
      { id: 'lrn_missing', decision: 'approve' },
    ], { confirmCount: 2, account: TRUSTED_ACCOUNT });
    assert.deepEqual(r.results.map((x) => x.index), [0, 1]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3. selectForBulkApprove (approve-clean selection)
// ─────────────────────────────────────────────────────────────────────────────

function rowsFromFixture() {
  return selfReview.summarizeOwnPending(fixtureCatalog(), ME).items;
}

describe('selectForBulkApprove: approve-ready selection', () => {
  it('ready mode selects only server-ready items at or above the threshold', () => {
    const sel = reviewLib.selectForBulkApprove(rowsFromFixture(), { mode: 'ready', minQuality: 14 });
    const ids = sel.selected.map((r) => r.id).sort();
    assert.deepEqual(ids, ['lrn_clean_hi', 'lrn_legacy']);
  });

  it('NEVER selects screen-flagged items in ready mode, regardless of quality', () => {
    const sel = reviewLib.selectForBulkApprove(rowsFromFixture(), { mode: 'ready', minQuality: 0 });
    assert.ok(!sel.selected.some((r) => !r.screens_passed), 'flagged items must be excluded');
    assert.ok(sel.excluded_flagged.some((r) => r.id === 'lrn_inj'), 'the q=20 injection-flagged item stays excluded');
  });

  it('threshold edges: exact threshold passes, below fails, unscored excluded unless threshold 0', () => {
    const rows = rowsFromFixture();
    const at15 = reviewLib.selectForBulkApprove(rows, { mode: 'ready', minQuality: 19 });
    assert.deepEqual(at15.selected.map((r) => r.id), ['lrn_clean_hi'], 'quality 19 passes threshold 19');

    const strict = reviewLib.selectForBulkApprove(rows, { mode: 'ready', minQuality: 20 });
    assert.equal(strict.selected.length, 0);

    const dflt = reviewLib.selectForBulkApprove(rows, { mode: 'ready' });
    assert.equal(dflt.min_quality, reviewLib.DEFAULT_QUALITY_THRESHOLD);
    assert.ok(dflt.excluded_unscored.some((r) => r.id === 'lrn_unscored'));

    const zero = reviewLib.selectForBulkApprove(rows, { mode: 'ready', minQuality: 0 });
    assert.ok(zero.selected.some((r) => r.id === 'lrn_unscored'), 'threshold 0 explicitly includes unscored');
  });

  it('all mode: no quality gate, flagged excluded unless includeFlagged', () => {
    const rows = rowsFromFixture();
    const all = reviewLib.selectForBulkApprove(rows, { mode: 'all' });
    assert.equal(all.selected.length, 4);
    assert.equal(all.excluded_flagged.length, 4);

    const inclusive = reviewLib.selectForBulkApprove(rows, { mode: 'all', includeFlagged: true });
    assert.equal(inclusive.selected.length, 8);
    assert.equal(inclusive.excluded_flagged.length, 0);
  });

  it('includeFlagged has NO effect in ready mode', () => {
    const sel = reviewLib.selectForBulkApprove(rowsFromFixture(), { mode: 'ready', minQuality: 0, includeFlagged: true });
    assert.ok(!sel.selected.some((r) => !r.screens_passed), 'approve-ready must ignore includeFlagged');
  });
});

describe('chunkDecisions', () => {
  it('splits at the server cap and never emits an oversized chunk', () => {
    const list = Array.from({ length: 433 }, (_, i) => ({ id: `l${i}`, decision: 'approve' }));
    const chunks = reviewLib.chunkDecisions(list);
    assert.equal(chunks.length, 5);
    assert.ok(chunks.every((chk) => chk.length <= reviewLib.BULK_CHUNK));
    assert.equal(chunks.flat().length, 433);
    assert.equal(chunks[4].length, 33);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4. MCP planApproveClean (dry-run shape)
// ─────────────────────────────────────────────────────────────────────────────

describe('planApproveClean: MCP dry-run shape', () => {
  const summary = () => selfReview.summarizeOwnPending(fixtureCatalog(), ME);

  it('is a dry run by construction and reports exactly what would be approved', () => {
    const plan = planApproveClean(summary(), {});
    assert.equal(plan.dry_run, true);
    assert.equal(plan.min_quality, reviewLib.DEFAULT_QUALITY_THRESHOLD);
    assert.deepEqual(plan.would_approve.map((r) => r.id).sort(), ['lrn_clean_hi', 'lrn_legacy']);
    assert.equal(plan.would_approve_count, 2);
    assert.equal(plan.excluded_flagged_count, 4);
  });

  it('would_approve entries are compact (no body) and the next step names the exact count', () => {
    const plan = planApproveClean(summary(), {});
    for (const r of plan.would_approve) assert.equal('body' in r, false);
    assert.ok(plan.next_step.includes(`expected_count:${plan.would_approve_count}`), 'next_step must carry the counted-confirmation echo');
    assert.ok(plan.next_step.includes('confirm:true'));
  });

  it('respects min_quality overrides', () => {
    const plan = planApproveClean(summary(), { min_quality: 19 });
    assert.deepEqual(plan.would_approve.map((r) => r.id), ['lrn_clean_hi']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural: server.js wiring
// ─────────────────────────────────────────────────────────────────────────────

describe('server.js: summary + bulk routes (structural)', () => {
  it('summary route: read scope, summarizeOwnPending, inside the self-review region', () => {
    // SPEC3-B1 sanctioned pin update (2026-07-19): the route grew param parsing
    // (lane/flag/signal/category/ids/limit/offset/full) and the helper call
    // gained the opts argument — window widened, callsite pin updated.
    const h = sliceAt(SERVER_SRC, "app.get('/account/pending/summary'", 3600);
    assert.ok(h.includes("resolveSelfReviewAccount(c, 'read')"), 'summary must use read scope');
    assert.ok(h.includes('summarizeOwnPending(comparisonCatalog(learnings, accountId), accountId, opts)'),
      'summary must use the pure ownership-scoped helper over a caller-safe corpus');
  });

  it('bulk route: contribute scope, counted confirm passthrough, applyBulkDecisions', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/pending/bulk'", 2200);
    assert.ok(h.includes("resolveSelfReviewAccount(c, 'contribute')"), 'bulk mutations need contribute scope');
    assert.ok(h.includes('confirm_count'), 'bulk must read the counted confirmation from the body');
    assert.ok(h.includes('applyBulkDecisions(learnings, accountId, decisions, {'), 'bulk must delegate to the pure core');
    assert.ok(h.includes('account: loadAccounts()[accountId] || null'), 'bulk must pass durable publication trust context');
  });

  it('bulk route: exactly ONE persistence write per batch, only when something changed', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/pending/bulk'", 2200);
    const writes = h.split('safeWrite(LEARNINGS_FILE, learnings)').length - 1;
    assert.equal(writes, 1, 'one write per batch (existing safeWrite pattern)');
    assert.ok(h.includes('outcome.counts.changed > 0'), 'no write when nothing changed');
  });

  it('bulk route: audit lines per changed item plus a batch summary line', () => {
    const h = sliceAt(SERVER_SRC, "app.post('/account/pending/bulk'", 2200);
    assert.ok(h.includes('[REVIEW-BULK] [AUDIT] self_'), 'per-item audit line');
    assert.ok(h.includes('[REVIEW-BULK] [AUDIT] bulk_summary'), 'batch summary audit line');
  });

  it('both routes live in the LW-15 self-review region, before the S21-3 reporting region', () => {
    const lw15 = SERVER_SRC.indexOf('LW-15: Contributor Self-Review Queue');
    const s213 = SERVER_SRC.indexOf('S21-3: Content Reporting Endpoint');
    const summaryAt = SERVER_SRC.indexOf("app.get('/account/pending/summary'");
    const bulkAt = SERVER_SRC.indexOf("app.post('/account/pending/bulk'");
    assert.ok(lw15 > 0 && s213 > lw15);
    assert.ok(summaryAt > lw15 && summaryAt < s213, 'summary route must sit in the account self-review region');
    assert.ok(bulkAt > lw15 && bulkAt < s213, 'bulk route must sit in the account self-review region');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Structural: counted-confirmation rails in CLI, MCP, dashboard
// ─────────────────────────────────────────────────────────────────────────────

describe('CLI: counted-confirmation rails (structural)', () => {
  it('approve-ready and --all both require the typed-count confirmation', () => {
    const approveReady = sliceAt(CLI_SRC, "if (flags['approve-ready'] || flags['approve-clean'])", 2200);
    assert.ok(approveReady.includes('confirmByTypedCount'), '--approve-ready must confirm by typed count');
    const all = sliceAt(CLI_SRC, 'if (flags.all)', 1400);
    assert.ok(all.includes('confirmByTypedCount'), '--all must confirm by typed count');
  });

  it('no --yes bypass exists on approve paths; only safe keep-private/reject paths have it', () => {
    const occurrences = CLI_SRC.split('flags.yes').length - 1;
    assert.equal(occurrences, 2, 'flags.yes must appear exactly on the two safe-direction paths');
    const keepPrivate = sliceAt(CLI_SRC, "if (flags['keep-private'])", 1800);
    assert.ok(keepPrivate.includes('flags.yes'), '--keep-private may use the safe-direction bypass');
    const allReject = sliceAt(CLI_SRC, "if (flags['all-reject'])", 900);
    assert.ok(allReject.includes('flags.yes'), '--all-reject may use the safe-direction bypass');
    const approveReady = sliceAt(CLI_SRC, "if (flags['approve-ready'] || flags['approve-clean'])", 2200);
    const all = sliceAt(CLI_SRC, 'if (flags.all)', 1400);
    assert.equal(approveReady.includes('flags.yes'), false);
    assert.equal(all.includes('flags.yes'), false);
  });

  it('typed-count prompt demands the exact number', () => {
    const h = sliceAt(CLI_SRC, 'async function confirmByTypedCount', 900);
    assert.ok(h.includes('answer !== String(rows.length)'), 'confirmation must compare against the exact count');
  });

  it('review shows the summary first: fetchPendingSummary precedes every decision path', () => {
    const fnAt = CLI_SRC.indexOf('async function cmdReview');
    const summaryAt = CLI_SRC.indexOf('fetchPendingSummary', fnAt);
    const firstMode = CLI_SRC.indexOf("flags['approve-ready']", fnAt);
    assert.ok(summaryAt > fnAt && summaryAt < firstMode, 'summary fetch must come before mode handling');
    assert.ok(CLI_SRC.indexOf('printSummaryTable(summary)', fnAt) < firstMode, 'summary table must render before mode handling');
  });
});

describe('MCP: auxilo_review tool (structural)', () => {
  it('the tool is registered', () => {
    assert.ok(MCP_SRC.includes("name: 'auxilo_review'"), 'tool must be registered');
    assert.ok(MCP_SRC.includes("case 'auxilo_review':"), 'tool must be dispatched');
  });

  it('approve_clean executes ONLY with dry_run:false AND confirm:true', () => {
    const h = sliceAt(MCP_SRC, "if (args.action === 'approve_clean')", 2600);
    assert.ok(h.includes('args.dry_run !== false || args.confirm !== true'), 'dry run must be the default and confirm must be exact');
  });

  it('approve_clean execute requires the counted expected_count echo', () => {
    const h = sliceAt(MCP_SRC, "if (args.action === 'approve_clean')", 2600);
    assert.ok(h.includes('Number.isInteger(args.expected_count)'), 'expected_count is required');
    assert.ok(h.includes('args.expected_count !== plan.would_approve_count'), 'a drifted selection must refuse to execute');
  });

  it('every bulk chunk carries its counted confirm_count', () => {
    const h = sliceAt(MCP_SRC, 'async function postBulkChunks', 1200);
    assert.ok(h.includes('confirm_count: chunk.length'), 'chunks must self-count');
  });
});

describe('dashboard: bulk review UI (structural)', () => {
  it('bulk actions confirm with the exact count before calling the bulk endpoint', () => {
    const h = sliceAt(DASH_SRC, 'function bulkDecide', 2600);
    assert.ok(h.includes('window.confirm'), 'a confirm dialog is required');
    assert.ok(h.includes("ids.length + ' learning(s)?"), 'the dialog must show the exact count');
    assert.ok(h.includes('confirm_count: decisions.length'), 'chunks must self-count');
  });

  it('renders learning data via textContent only (XSS-safe pattern held)', () => {
    const triage = sliceAt(DASH_SRC, 'function buildTriageRow', 2400);
    assert.ok(!/innerHTML\s*=/.test(triage), 'triage rows must not use innerHTML');
    const detail = sliceAt(DASH_SRC, 'function toggleTriageDetail', 2400);
    assert.ok(!/innerHTML\s*=/.test(detail), 'detail rows must not use innerHTML');
    assert.ok(detail.includes('bodyPre.textContent'), 'bodies must render as plain text');
  });

  it('summary endpoint feeds the queue and the count badge', () => {
    assert.ok(DASH_SRC.includes("apiFetch('/account/pending/summary')"), 'dashboard must use the summary endpoint');
    assert.ok(DASH_SRC.includes('pending-count-badge'), 'count badge element must exist');
  });
});
