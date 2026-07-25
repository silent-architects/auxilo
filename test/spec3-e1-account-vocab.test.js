'use strict';

/**
 * Phase 0 tests for SPEC3-E1's read-only corpus vocabulary dry run.
 *
 * The production signal does not land in this phase. These tests pin the
 * offline analyzer that Tyler must accept before lib/self-review.js changes.
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
  analyzeCorpus,
  mergeCorpora,
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

describe('SPEC3-E1 Phase 0 account-vocabulary analyzer', () => {
  it('flags an unknown proper noun recurring in two same-account learnings, but not a singleton', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use Vandelay when the primary path fails.'),
      learning('a2', 'acc_a', 'Retry Vandelay after clearing the cache.'),
      learning('a3', 'acc_a', 'Use Initech only for this isolated case.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, contrastMinAccounts: 10 });

    assert.deepEqual(result.flagged_items.map((row) => row.id), ['a1', 'a2']);
    assert.deepEqual(result.flagged_items[0].terms, ['Vandelay']);
    assert.equal(result.account_terms.acc_a.some((row) => row.term === 'Initech'), false);
  });

  it('never flags a recurring TECH_ALLOWLIST term', () => {
    const rows = Array.from({ length: 10 }, (_, index) =>
      learning(`a${index}`, 'acc_a', `Use Anthropic for provider call ${index}.`));

    const result = analyzeCorpus(rows, { recurrenceMin: 2, contrastMinAccounts: 10 });

    assert.equal(result.flagged_items.length, 0);
    assert.deepEqual(result.account_terms.acc_a || [], []);
  });

  it('does not treat a sentence-initial capitalized token as account vocabulary', () => {
    const rows = [
      learning('a1', 'acc_a', 'Vandelay handles this retry.'),
      learning('a2', 'acc_a', 'Vandelay handles the fallback too.'),
    ];

    const result = analyzeCorpus(rows, { recurrenceMin: 2, contrastMinAccounts: 10 });

    assert.equal(result.flagged_items.length, 0);
  });

  it('keeps cross-account contrast dark below its threshold, then suppresses shared terms when enabled', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use Vandelay for the first path.'),
      learning('a2', 'acc_a', 'Retry Vandelay for the second path.'),
      learning('b1', 'acc_b', 'Use Vandelay for the first path.'),
      learning('b2', 'acc_b', 'Retry Vandelay for the second path.'),
      learning('a3', 'acc_a', 'A filler row with no special term.'),
      learning('a4', 'acc_a', 'Another filler row with no special term.'),
      learning('a5', 'acc_a', 'Final filler row with no special term.'),
      learning('b3', 'acc_b', 'A filler row with no special term.'),
      learning('b4', 'acc_b', 'Another filler row with no special term.'),
      learning('b5', 'acc_b', 'Final filler row with no special term.'),
    ];

    const dark = analyzeCorpus(rows, { recurrenceMin: 2, contrastMinAccounts: 10 });
    const enabled = analyzeCorpus(rows, { recurrenceMin: 2, contrastMinAccounts: 2 });

    assert.equal(dark.contrast_active, false);
    assert.equal(dark.flagged_items.length, 4);
    assert.equal(enabled.contrast_active, true);
    assert.equal(enabled.flagged_items.length, 0);
    assert.deepEqual(enabled.suppressed_cross_account_terms, ['vandelay']);
  });

  it('computes recall and historically-clean approved hold rate from the same deterministic result', () => {
    const rows = [
      learning('known-1', 'acc_a', 'Use Vandelay for the first path.', { status: 'approved' }),
      learning('known-2', 'acc_a', 'Retry Vandelay for the second path.', { status: 'approved' }),
      ...Array.from({ length: 18 }, (_, index) =>
        learning(`clean-${index}`, 'acc_a', `Use the generic retry path number ${index}.`, { status: 'approved' })),
    ];

    const result = analyzeCorpus(rows, {
      recurrenceMin: 2,
      contrastMinAccounts: 10,
      knownIdPrefixes: ['known-1', 'known-2'],
    });

    assert.deepEqual(result.recall, { expected: 2, found: 2, flagged: 2, rate: 1 });
    assert.deepEqual(result.hold_rate, { eligible: 20, flagged: 2, rate: 0.1 });
  });

  it('deduplicates exact ids without mutating either input corpus', () => {
    const primary = [learning('a1', 'acc_a', 'Use Vandelay here.')];
    const archive = [
      learning('a1', 'acc_a', 'An older duplicate must not replace the primary row.'),
      learning('a2', 'acc_a', 'Retry Vandelay here.'),
    ];
    const before = JSON.stringify({ primary, archive });

    const merged = mergeCorpora(primary, archive);

    assert.equal(merged.length, 2);
    assert.equal(merged[0].body, 'Use Vandelay here.');
    assert.equal(JSON.stringify({ primary, archive }), before);
  });

  it('runs against a snapshot path without changing the snapshot', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-vocab-dryrun-'));
    const snapshot = path.join(dir, 'learnings.json');
    fs.writeFileSync(snapshot, JSON.stringify([
      learning('a1', 'acc_a', 'Use Vandelay here.'),
      learning('a2', 'acc_a', 'Retry Vandelay here.'),
    ]));
    const before = crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');

    const run = spawnSync(process.execPath, [SCRIPT, snapshot], { encoding: 'utf8' });
    const after = crypto.createHash('sha256').update(fs.readFileSync(snapshot)).digest('hex');

    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /VOCAB DRY RUN \(read-only\)/);
    assert.equal(after, before);
  });

  it('is deterministic for the same corpus and configuration', () => {
    const rows = [
      learning('a1', 'acc_a', 'Use Vandelay here.'),
      learning('a2', 'acc_a', 'Retry Vandelay here.'),
    ];
    const opts = { recurrenceMin: 2, contrastMinAccounts: 10 };

    assert.deepEqual(analyzeCorpus(rows, opts), analyzeCorpus(rows, opts));
  });
});
