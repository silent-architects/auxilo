'use strict';

/**
 * Phase 0 tests for SPEC3-E1's read-only REV 2 vocabulary dry run.
 *
 * The production signal does not land in this phase. These tests pin the
 * offline analyzer that Tyler must accept before runtime changes.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'vocab-dryrun.js');
const {
  COMMON_DEV_TERMS,
  analyzeCorpus,
  extractCandidateTerms,
  mergeCorpora,
  parseArgs,
} = require(SCRIPT);

function learning(id, accountId, body, overrides = {}) {
  return {
    id,
    contributor_account_id: accountId,
    title: `Learning ${id}`,
    body,
    tags: [],
    status: 'pending_review',
    ...overrides,
  };
}

describe('SPEC3-E1 Phase 0 REV 2 account-vocabulary analyzer', () => {
  it('extracts S1–S6 candidates and preserves overlapping shape attribution', () => {
    const terms = extractCandidateTerms(learning(
      'a1',
      'acc_a',
      'Use ops-consumer with private_queue, AgentWork, WPR, enqueue-agent-work.py, and the Vandelay adapter.',
    ));
    const byKey = new Map(terms.map((term) => [term.key, term.classes]));

    assert.deepEqual(byKey.get('ops-consumer'), ['S1']);
    assert.deepEqual(byKey.get('private_queue'), ['S2']);
    assert.deepEqual(byKey.get('agentwork'), ['S3']);
    assert.deepEqual(byKey.get('wpr'), ['S4']);
    assert.deepEqual(byKey.get('enqueue-agent-work.py'), ['S5']);
    assert.ok(byKey.get('vandelay').includes('S6'));
  });

  it('flags each shape only after recurrence in two distinct same-account learnings', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use ops-consumer private_queue AgentWork WPR enqueue-agent-work.py and the Vandelay adapter.'),
      learning('a2', 'acc_a', 'Retry ops-consumer private_queue AgentWork WPR enqueue-agent-work.py with the Vandelay adapter.'),
      learning('a3', 'acc_a', 'Use isolated-widget only once.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });

    assert.deepEqual(result.flagged_items.map((row) => row.id), ['a1', 'a2']);
    assert.deepEqual(result.flagged_items[0].classes, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    assert.equal(result.account_terms.acc_a.some((row) => row.normalized === 'isolated-widget'), false);
  });

  it('excludes the S4 acronym allowlist and existing TECH_ALLOWLIST terms', () => {
    const rows = [
      learning('a1', 'acc_a', 'HTTP JSON API AWS and Anthropic are standard.'),
      learning('a2', 'acc_a', 'HTTP JSON API AWS and Anthropic recur.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });

    assert.equal(result.flagged_items.length, 0);
    assert.deepEqual(result.account_terms.acc_a, []);
  });

  it('keeps the S6 sentence-initial exclusion from the existing classifier', () => {
    const rows = [
      learning('a1', 'acc_a', 'Vandelay handles this retry.'),
      learning('a2', 'acc_a', 'Vandelay handles the fallback too.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });

    assert.equal(result.flagged_items.length, 0);
  });

  it('loads a checked-in common-dev baseline with at least 500 entries', () => {
    assert.ok(COMMON_DEV_TERMS.size >= 500, `only ${COMMON_DEV_TERMS.size} entries`);
    assert.ok(COMMON_DEV_TERMS.has('webpack-cli'));
    assert.ok(COMMON_DEV_TERMS.has('github_token'));
    assert.ok(COMMON_DEV_TERMS.has('docker-compose'));
  });

  it('excludes recurring candidates found in the static common-dev baseline', () => {
    const rows = [
      learning('a1', 'acc_a', 'Run webpack-cli with docker-compose.'),
      learning('a2', 'acc_a', 'Retry webpack-cli with docker-compose.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });

    assert.equal(result.flagged_items.length, 0);
    assert.ok(result.excluded_account_terms.acc_a.some((row) =>
      row.normalized === 'webpack-cli' && row.exclusion_reasons.includes('static_common_dev')));
  });

  it('excludes a candidate appearing in any approved learning from another account', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use private-widget here.'),
      learning('a2', 'acc_a', 'Retry private-widget here.'),
      learning('b1', 'acc_b', 'The private-widget pattern is public.', { status: 'approved' }),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });

    assert.equal(result.flagged_items.filter((row) => row.account_id === 'acc_a').length, 0);
    assert.ok(result.excluded_account_terms.acc_a.some((row) =>
      row.normalized === 'private-widget' &&
      row.exclusion_reasons.includes('approved_other_account')));
  });

  it('counts same-account approvals toward the configurable approved public DF', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use private-widget here.', { status: 'approved' }),
      learning('a2', 'acc_a', 'Retry private-widget here.', { status: 'approved' }),
      learning('a3', 'acc_a', 'Document private-widget here.', { status: 'approved' }),
    ];

    const excluded = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 3 });
    const survives = analyzeCorpus(rows, { recurrenceMin: 2, publicDf: 4 });

    assert.equal(excluded.flagged_items.length, 0);
    assert.equal(survives.flagged_items.length, 3);
    assert.ok(excluded.excluded_account_terms.acc_a.some((row) =>
      row.normalized === 'private-widget' &&
      row.exclusion_reasons.includes('approved_df_3')));
  });

  it('reports recall and hold-rate contribution independently for every shape class', () => {
    const shapes = [
      ['known-s1', 'ops-consumer'],
      ['known-s2', 'private_queue'],
      ['known-s3', 'AgentWork'],
      ['known-s4', 'WPR'],
      ['known-s5', 'enqueue-agent-work.py'],
      ['known-s6', 'Vandelay'],
    ];
    const rows = shapes.flatMap(([id, term]) => [
      learning(`${id}-1`, 'acc_a', `Use ${term} here.`),
      learning(`${id}-2`, 'acc_a', `Retry ${term} here.`),
    ]);

    const result = analyzeCorpus(rows, {
      recurrenceMin: 2,
      publicDf: 3,
      knownIdPrefixes: shapes.map(([id]) => `${id}-1`),
    });

    assert.equal(result.recall.flagged, 6);
    for (const shape of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6']) {
      assert.ok(result.per_shape_class[shape].recall_flagged >= 1, shape);
      assert.equal(result.per_shape_class[shape].hold_flagged, 0);
    }
  });

  it('computes clean-approved hold rate and top false-positive terms', () => {
    const rows = [
      learning('known-1', 'acc_a', 'Use private-widget here.', { status: 'approved' }),
      learning('known-2', 'acc_a', 'Retry private-widget here.', { status: 'approved' }),
      ...Array.from({ length: 18 }, (_, index) =>
        learning(`clean-${index}`, 'acc_a', `Use generic retry path ${index}.`, { status: 'approved' })),
    ];

    const result = analyzeCorpus(rows, {
      recurrenceMin: 2,
      publicDf: 3,
      knownIdPrefixes: ['known-1', 'known-2'],
    });

    assert.deepEqual(result.recall, { expected: 2, found: 2, flagged: 2, rate: 1 });
    assert.deepEqual(result.hold_rate, { eligible: 20, flagged: 2, rate: 0.1 });
    assert.deepEqual(result.top_false_positive_terms[0], {
      term: 'private-widget',
      normalized: 'private-widget',
      classes: ['S1'],
      clean_learning_count: 2,
      learning_ids: ['known-1', 'known-2'],
    });
  });

  it('explains a fixture miss caused by recurrence and baseline exclusion', () => {
    const rows = [
      learning('known', 'acc_a', 'Use singleton-widget and public-widget.'),
      learning('a2', 'acc_a', 'Retry public-widget.', { status: 'approved' }),
      learning('b1', 'acc_b', 'Document public-widget.', { status: 'approved' }),
    ];

    const result = analyzeCorpus(rows, {
      recurrenceMin: 2,
      publicDf: 3,
      knownIdPrefixes: ['known'],
    });

    assert.equal(result.recall_items[0].flagged, false);
    assert.match(result.recall_items[0].miss_reason, /all recurring candidates excluded/);
    assert.match(result.recall_items[0].miss_reason, /approved_other_account/);
  });

  it('deduplicates exact ids without mutating either input corpus', () => {
    const primary = [learning('a1', 'acc_a', 'Use private-widget here.')];
    const archive = [
      learning('a1', 'acc_a', 'An older duplicate must not replace the primary row.'),
      learning('a2', 'acc_a', 'Retry private-widget here.'),
    ];
    const before = JSON.stringify({ primary, archive });

    const merged = mergeCorpora(primary, archive);

    assert.equal(merged.length, 2);
    assert.equal(merged[0].body, 'Use private-widget here.');
    assert.equal(JSON.stringify({ primary, archive }), before);
  });

  it('runs against a snapshot path with --public-df without changing the snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-vocab-dryrun-'));
    const snapshot = path.join(dir, 'learnings.json');
    fs.writeFileSync(snapshot, JSON.stringify([
      learning('a1', 'acc_a', 'Use private-widget here.'),
      learning('a2', 'acc_a', 'Retry private-widget here.'),
    ]));
    const before = crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');

    const run = spawnSync(process.execPath, [SCRIPT, snapshot, '--public-df', '4'], { encoding: 'utf8' });
    const after = crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /VOCAB DRY RUN REV 2 \(read-only\)/);
    assert.match(run.stdout, /approved public DF: 4/);
    assert.equal(after, before);
  });

  it('parses both REV 2 thresholds and is deterministic for the same inputs', () => {
    const args = parseArgs(['node', SCRIPT, 'snapshot.json', '--recurrence-min', '3', '--public-df', '5']);
    assert.equal(args.recurrenceMin, 3);
    assert.equal(args.publicDf, 5);

    const rows = [
      learning('a1', 'acc_a', 'Use private-widget here.'),
      learning('a2', 'acc_a', 'Retry private-widget here.'),
    ];
    const options = { recurrenceMin: 2, publicDf: 3 };
    assert.deepEqual(analyzeCorpus(rows, options), analyzeCorpus(rows, options));
  });
});
