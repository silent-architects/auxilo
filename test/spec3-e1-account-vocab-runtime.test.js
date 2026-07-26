'use strict';

/**
 * SPEC3-E1 Phase 1 — review-time account_vocab runtime contract.
 *
 * These tests pin the signal's detection semantics, dark controls, contributor
 * projection, lane/count effect, and the two structural safety boundaries:
 * never in submission screening and never in buyer projections.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const CONFIG = require('../config/account-vocab.json');
const RATIFIED = require('./fixtures/spec3-e1-phase0-ratified.json');
const COMMON_DEV_TERMS = fs.readFileSync(
  path.join(REPO, 'config', 'common-dev-terms.txt'),
  'utf8'
);
const {
  buildAccountVocabulary,
  extractCandidateTerms,
  parseCommonDevTerms,
} = require('../lib/account-vocab.js');
const {
  LANE_NEEDS_EYES,
  LANE_READY,
  summarizeOwnPending,
} = require('../lib/self-review.js');

const COMMON = parseCommonDevTerms(COMMON_DEV_TERMS);
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const SELF_REVIEW_SRC = fs.readFileSync(path.join(REPO, 'lib', 'self-review.js'), 'utf8');

const MUST_FLAG = [
  'lrn_79420271-6e3c-4da9-85b0-c19aa7888b4d',
  'lrn_3bd59e6a-422f-4561-addc-e12a7dd32d0e',
  'lrn_ed03b3f6-7380-4506-88a5-15422639d41a',
  'lrn_88a9757a-c09a-42ac-9d95-5975a05bf804',
  'lrn_3cf14441-5ab6-4333-b972-e249f514f054',
  'lrn_c50066f6-787a-4c66-994c-3c7ac5c54bac',
  'lrn_e2680863-9b3c-449e-9ab2-98e8564a7a6f',
];
const KNOWN_MISS = 'lrn_55390ea4-63de-41ed-bf61-3543dddac58d';
const RECLASSIFIED_OUT = 'lrn_63248f8e-edf5-4569-a153-e1f05b59a6b1';

function config(overrides = {}) {
  return { ...CONFIG, ...overrides };
}

function learning(id, accountId, body, overrides = {}) {
  return {
    id,
    contributor_account_id: accountId,
    title: 'Generic technical learning',
    body,
    tags: [],
    status: 'pending_review',
    quality_self_assessment: {
      specificity: 4,
      actionability: 4,
      novelty: 4,
      completeness: 4,
      total: 16,
    },
    created_at: '2026-07-25T00:00:00.000Z',
    ...overrides,
  };
}

function detector(corpus, configOverride) {
  return buildAccountVocabulary(corpus, {
    config: configOverride || CONFIG,
    commonDevTerms: COMMON,
  });
}

function routeSlice(route, nextRoute) {
  const start = SERVER_SRC.indexOf(route);
  const end = SERVER_SRC.indexOf(nextRoute, start + route.length);
  assert.ok(start >= 0 && end > start, `could not slice ${route}`);
  return SERVER_SRC.slice(start, end);
}

describe('SPEC3-E1 Phase 1 account_vocab runtime', () => {
  it('flags recurrence in two distinct same-account learnings but not a singleton', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use private-widget for this operation.'),
      learning('a2', 'acc_a', 'Retry private-widget after a failed operation.'),
      learning('a3', 'acc_a', 'Use singleton-widget for this operation.'),
    ];
    const result = detector(rows);

    assert.deepEqual(Object.keys(result.matches_by_learning_id), ['a1', 'a2']);
    assert.equal(result.account_terms.acc_a.some((row) => row.normalized === 'singleton-widget'), false);
  });

  it('never flags acronym, wordlist, tech-allowlist, or clean-corpus terms', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use PR webpack-cli Anthropic private-widget shared-widget.'),
      learning('a2', 'acc_a', 'Retry PR webpack-cli Anthropic private-widget shared-widget.'),
      learning('a3', 'acc_a', 'Publish private-widget.', { status: 'approved' }),
      learning('b1', 'acc_b', 'Publish shared-widget.', { status: 'approved' }),
    ];
    const result = detector(rows);

    assert.deepEqual(result.account_terms.acc_a, []);
    const excluded = new Map(result.excluded_account_terms.acc_a.map((row) => [row.normalized, row]));
    assert.ok(excluded.get('private-widget').exclusion_reasons.includes('approved_same_account'));
    assert.ok(excluded.get('shared-widget').exclusion_reasons.includes('approved_other_account'));
    assert.equal(extractCandidateTerms(rows[0], CONFIG).some((row) => row.normalized === 'pr'), false);
  });

  it('keeps S6 dark by default and permits an explicit config-on experiment', () => {
    const rows = [
      learning('a1', 'acc_a', 'Connect the Vandelay adapter for this operation.'),
      learning('a2', 'acc_a', 'Retry the Vandelay adapter after failure.'),
    ];

    assert.deepEqual(detector(rows).matches_by_learning_id, {});
    const enabled = detector(rows, config({
      VOCAB_SHAPES_ENABLED: [...CONFIG.VOCAB_SHAPES_ENABLED, 'S6'],
    }));
    assert.deepEqual(Object.keys(enabled.matches_by_learning_id), ['a1', 'a2']);
    assert.ok(enabled.matches_by_learning_id.a1[0].classes.includes('S6'));
  });

  it('keeps cross-account contrast dark below threshold and suppresses when explicitly activated', () => {
    const rows = ['acc_a', 'acc_b'].flatMap((accountId) =>
      Array.from({ length: 5 }, (_, index) =>
        learning(`${accountId}-${index}`, accountId,
          index < 2 ? 'Use shared-widget for this operation.' : `Use generic operation ${index}.`)));

    const dark = detector(rows);
    assert.equal(dark.contrast_active, false);
    assert.equal(dark.account_terms.acc_a.some((row) => row.normalized === 'shared-widget'), true);
    assert.equal(dark.account_terms.acc_b.some((row) => row.normalized === 'shared-widget'), true);

    const active = detector(rows, config({ VOCAB_CONTRAST_MIN_ACCOUNTS: 2 }));
    assert.equal(active.contrast_active, true);
    assert.ok(active.contrast_suppressed_terms.includes('shared-widget'));
    assert.equal(active.account_terms.acc_a.some((row) => row.normalized === 'shared-widget'), false);
    assert.equal(active.account_terms.acc_b.some((row) => row.normalized === 'shared-widget'), false);
  });

  it('re-lanes a ready item, decrements approvable_count, and emits account_vocab evidence', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use private-widget for this operation.'),
      learning('a2', 'acc_a', 'Retry private-widget after a failed operation.'),
      learning('a3', 'acc_a', 'Use a generic retry for this operation.'),
    ];
    const baseline = summarizeOwnPending(rows, 'acc_a');
    const summary = summarizeOwnPending(rows, 'acc_a', {
      accountVocab: { config: CONFIG, commonDevTerms: COMMON },
    });
    const flagged = summary.items.find((row) => row.id === 'a1');

    assert.equal(baseline.items.find((row) => row.id === 'a1').lane, LANE_READY);
    assert.equal(flagged.lane, LANE_NEEDS_EYES);
    assert.equal(baseline.approvable_count - summary.approvable_count, 2);
    assert.equal(summary.counts.by_signal.account_vocab, 2);
    assert.equal(summary.counts.by_screen.account_vocab, 2);
    assert.equal(flagged.why,
      "recurring term 'private-widget' appears only in your own learnings — likely internal system vocabulary; genericize via sanitize");
    assert.deepEqual(flagged.sensitivity_signals, ['account_vocab']);
    assert.equal(flagged.sensitivity_evidence[0].signal, 'account_vocab');
    assert.ok(flagged.sensitivity_evidence[0].excerpt.length <= 60);
  });

  it('is structurally absent from every submission screening module and route', () => {
    for (const relative of [
      'lib/content-sensitivity.js',
      'lib/content-sensitivity-llm.js',
      'lib/injection-screen.js',
      'lib/sensitivity-filter.js',
    ]) {
      const source = fs.readFileSync(path.join(REPO, relative), 'utf8');
      assert.doesNotMatch(source, /account-vocab|account_vocab/);
    }
    assert.doesNotMatch(routeSlice("app.post('/learn'", "app.delete('/learn/"), /accountVocab|account_vocab|account-vocab/);
    assert.doesNotMatch(routeSlice("app.post('/extract'", "app.post('/extract/consent'"), /accountVocab|account_vocab|account-vocab/);
  });

  it('preserves the regex-clean LLM sensitivity path for /learn and /extract', () => {
    const evaluator = SERVER_SRC.slice(
      SERVER_SRC.indexOf('async function evaluateContentSensitivity'),
      SERVER_SRC.indexOf('// Load skill catalog')
    );
    assert.match(evaluator, /if \(regex\.sensitive\)/);
    assert.match(evaluator, /await classifySensitivityLLM\(title, body, tags\)/);
    assert.match(evaluator, /combineSensitivity\(\{ regex, llm, llmEnabled: true \}\)/);
    assert.equal((SERVER_SRC.match(/await evaluateContentSensitivity\(/g) || []).length, 3);
  });

  it('keeps account_vocab evidence contributor-only while all four buyer strips stay pinned', () => {
    assert.match(SELF_REVIEW_SRC, /row\.sensitivity_evidence = vocabEvidence/);
    assert.equal((SERVER_SRC.match(/sensitivity_evidence: _se\b/g) || []).length, 2);
    assert.equal((SERVER_SRC.match(/sensitivity_evidence: _sec\b/g) || []).length, 1);
    assert.equal((SERVER_SRC.match(
      /moderation, sensitivity_signals, sensitivity_source, sensitivity_evidence, learning_type/g
    ) || []).length, 1);
  });

  it('returns byte-for-byte equivalent data for the same corpus and options', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use private-widget for this operation.'),
      learning('a2', 'acc_a', 'Retry private-widget after a failed operation.'),
    ];
    const before = JSON.stringify(rows);
    const first = JSON.stringify(detector(rows));
    const second = JSON.stringify(detector(rows));

    assert.equal(first, second);
    assert.equal(JSON.stringify(rows), before);
  });

  it('lands all seven ratified fixtures in needs_your_eyes and preserves both exclusions', () => {
    const helper = learning(
      'fixture-recurrence-helper',
      'acc_647b846b',
      'Verify latestMessageId against threadId before processing stale queue state.'
    );
    const rows = RATIFIED.map((row) => ({
      ...row,
      quality_self_assessment: {
        specificity: 4,
        actionability: 4,
        novelty: 4,
        completeness: 4,
        total: 16,
      },
      created_at: '2026-07-25T00:00:00.000Z',
    })).concat(helper);
    const summary = summarizeOwnPending(rows, 'acc_647b846b', {
      accountVocab: { config: CONFIG, commonDevTerms: COMMON },
    });
    const byId = new Map(summary.items.map((row) => [row.id, row]));

    for (const id of MUST_FLAG) {
      assert.equal(byId.get(id).lane, LANE_NEEDS_EYES, id);
      assert.ok(byId.get(id).flags.includes('account_vocab'), id);
    }
    assert.equal(byId.get(KNOWN_MISS).flags.includes('account_vocab'), false);
    assert.equal(byId.get(RECLASSIFIED_OUT).flags.includes('account_vocab'), false);
  });

  it('loads every threshold and default-enabled shape from config', () => {
    assert.equal(CONFIG.VOCAB_RECURRENCE_MIN, 2);
    assert.equal(CONFIG.VOCAB_PUBLIC_DF, 3);
    assert.deepEqual(CONFIG.VOCAB_SHAPES_ENABLED, ['S1', 'S2', 'S3', 'S4', 'S5']);
    assert.equal(CONFIG.VOCAB_CONTRAST_MIN_ACCOUNTS, 10);
    assert.equal(CONFIG.VOCAB_CONTRAST_MIN_LEARNINGS, 5);
  });
});

// INCIDENT 2026-07-26: the wordlist shipped in data/, which prod's volume mount
// shadows — boot ENOENT'd into a crash-loop (~6min outage, v56 rolled back).
// These pins keep the two halves of the fix from regressing independently.
describe('SPEC3-E1 incident regression: wordlist location + fail-open boot', () => {
  it('loads the wordlist from config/ (image), never data/ (volume-shadowed in prod)', () => {
    assert.ok(SERVER_SRC.includes("path.join(__dirname, 'config', 'common-dev-terms.txt')"));
    assert.equal(SERVER_SRC.includes("path.join(__dirname, 'data', 'common-dev-terms.txt')"), false);
    assert.ok(fs.existsSync(path.join(REPO, 'config', 'common-dev-terms.txt')));
  });

  it('fail-open guard actually fires: unreadable wordlist yields an empty Set, not a throw', () => {
    // Execute the loader IIFE from server.js source against a missing file,
    // with the same parse fn the server uses — watching the guard fire beats
    // asserting its source shape (a guard never watched firing is unverified).
    const start = SERVER_SRC.indexOf('const ACCOUNT_VOCAB_COMMON_DEV_TERMS = (() => {');
    assert.ok(start > 0, 'loader IIFE present');
    const end = SERVER_SRC.indexOf('})();', start);
    const iife = SERVER_SRC.slice(start + 'const ACCOUNT_VOCAB_COMMON_DEV_TERMS = '.length, end + '})();'.length)
      .replace("path.join(__dirname, 'config', 'common-dev-terms.txt')", "path.join(__dirname, 'config', 'DOES-NOT-EXIST.txt')");
    const result = new Function(
      'fs', 'path', '__dirname', 'parseAccountVocabCommonTerms', 'console',
      `return ${iife}`
    )(fs, path, REPO, parseCommonDevTerms, { error: () => {} });
    assert.ok(result instanceof Set);
    assert.equal(result.size, 0);
  });
});
