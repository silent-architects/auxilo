'use strict';

/**
 * Generic-term false-positive remediation for the SPEC3-E1 `account_vocab`
 * signal (2026-08-06).
 *
 * Live evidence that motivated this: the pending queue reached 30 items with 21
 * flagged `account_vocab` — a 70% hold rate against the E1 Phase-0 design gate
 * of <=10%. Every flagged term below was pulled from that live queue's
 * `sensitivity_evidence[].excerpt`. They are ordinary English compounds, caps
 * emphasis, and public product names — not account-private vocabulary.
 *
 * The two mechanisms under test:
 *   1. whole-token exclusion via the common-dev wordlist (`value`, `chatgpt`)
 *   2. compound decomposition (`isCompoundOfKnownTerms`) — every `-`/`_`
 *      segment known => exclude (`race` + `condition` => `race-condition`)
 *
 * The must-still-flag set is the guard: this remediation must not disarm the
 * signal, whose entire purpose is catching account-private identifiers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildAccountVocabulary,
  parseCommonDevTerms,
  isCompoundOfKnownTerms,
} = require('../lib/account-vocab.js');

const CONFIG = require('../config/account-vocab.json');
const COMMON_DEV_TERMS = parseCommonDevTerms(
  fs.readFileSync(path.join(__dirname, '..', 'config', 'common-dev-terms.txt'), 'utf8'));

// Terms observed flagged on the live queue 2026-08-06 that must NOT flag.
const MUST_NOT_FLAG = [
  'already-vetted', 'auto-generated', 'race-condition', 'home-dir', '7-day',
  'image-processing', 'mcp-server', 'codex-desktop',
  'VALUE', 'LOUDLY', 'B2B', 'ChatGPT', 'LinkedIn',
];

// Account-private identifiers that must KEEP flagging.
const MUST_FLAG = [
  'vandelay-brain', 'initech-pilot', 'acme_widget', 'FooBarBaz', 'WPR',
  'agentwork-lane', 'shared_queue',
];

function learning(term, n) {
  return {
    id: `${term}-${n}`,
    contributor_account_id: 'acc_a',
    status: 'pending_review',
    title: `Learning about ${term} behavior`,
    body: `The ${term} path fails under load; retry ${term} once.`,
    tags: ['debug'],
  };
}

function vocabularyFor(terms) {
  // Two learnings per term so each clears VOCAB_RECURRENCE_MIN.
  const rows = terms.flatMap((term) => [learning(term, 1), learning(term, 2)]);
  return buildAccountVocabulary(rows, {
    config: CONFIG,
    commonDevTerms: COMMON_DEV_TERMS,
  });
}

test('account_vocab: generic terms observed on the live queue are excluded', () => {
  const result = vocabularyFor([...MUST_NOT_FLAG, ...MUST_FLAG]);
  const flagged = new Set(result.account_terms.acc_a.map((row) => row.normalized));

  const leaked = MUST_NOT_FLAG.filter((term) => flagged.has(term.toLowerCase()));
  assert.deepEqual(leaked, [], `generic terms still flagged: ${leaked.join(', ')}`);
});

test('account_vocab: account-private identifiers still flag', () => {
  const result = vocabularyFor([...MUST_NOT_FLAG, ...MUST_FLAG]);
  const flagged = new Set(result.account_terms.acc_a.map((row) => row.normalized));

  const lost = MUST_FLAG.filter((term) => !flagged.has(term.toLowerCase()));
  assert.deepEqual(lost, [], `real identifiers no longer flagged: ${lost.join(', ')}`);
});

test('account_vocab: exclusions are attributed to the right mechanism', () => {
  const result = vocabularyFor(MUST_NOT_FLAG);
  const reasons = new Map(result.excluded_account_terms.acc_a
    .map((row) => [row.normalized, row.exclusion_reasons]));

  assert.ok(reasons.get('race-condition').includes('static_common_dev_compound'));
  assert.ok(reasons.get('7-day').includes('static_common_dev_compound'));
  assert.ok(reasons.get('value').includes('static_common_dev'));
  assert.ok(reasons.get('chatgpt').includes('static_common_dev'));
});

test('isCompoundOfKnownTerms: requires every segment known, >=2 segments', () => {
  const known = new Set(['race', 'condition', 'server', 'day']);

  assert.equal(isCompoundOfKnownTerms('race-condition', known), true);
  assert.equal(isCompoundOfKnownTerms('race_condition', known), true);
  assert.equal(isCompoundOfKnownTerms('7-day', known), true, 'numeric segments count as known');

  // One unknown segment keeps the flag — this is what preserves detection.
  assert.equal(isCompoundOfKnownTerms('acme-server', known), false);
  assert.equal(isCompoundOfKnownTerms('race-widget', known), false);

  // Single-segment tokens are the whole-token path's job, not this one.
  assert.equal(isCompoundOfKnownTerms('race', known), false);

  // Defensive: bad input never throws.
  assert.equal(isCompoundOfKnownTerms('', known), false);
  assert.equal(isCompoundOfKnownTerms(null, known), false);
  assert.equal(isCompoundOfKnownTerms('race-condition', null), false);
});

test('account_vocab: remediation holds the E1 hold-rate gate on a generic corpus', () => {
  // The E1 Phase-0 acceptance gate was <=10% hold on a historically clean
  // corpus. MUST_NOT_FLAG is exactly such a corpus — all generic.
  const result = vocabularyFor(MUST_NOT_FLAG);
  const held = result.account_terms.acc_a.length;
  const holdRate = held / MUST_NOT_FLAG.length;

  assert.ok(holdRate <= 0.10, `hold rate ${(holdRate * 100).toFixed(1)}% exceeds the 10% E1 gate`);
});
