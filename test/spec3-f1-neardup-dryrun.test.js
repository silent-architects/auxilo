'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { similarityScore } = require('../lib/similarity');
const {
  DEFAULT_FIXTURE,
  D1_THRESHOLD,
  COMPOSITE_THRESHOLD,
  tokenSet,
  setJaccard,
  unigramJaccard,
  tfCosine,
  titleJaccard,
  calibrateCosine,
  scoreChannels,
  pairKey,
  allPairs,
  rowsFromSnapshot,
  loadFixture,
  prepareFixture,
  diagnoseCurrentAlgorithm,
  connectedComponents,
  analyzeFixture,
  parseArgs,
  usage,
  main,
} = require('../scripts/neardup-dryrun');

const SCRIPT = path.resolve(__dirname, '../scripts/neardup-dryrun.js');

function learning(id, title, body, overrides = {}) {
  return {
    id,
    title,
    body,
    category: 'code-execution',
    status: 'approved',
    ...overrides,
  };
}

function tinyFixture(clusters, cleanApproved = [], sameDomainPairs = []) {
  return {
    duplicate_clusters: clusters,
    clean_approved: cleanApproved,
    same_domain_different_lesson_pairs: sameDomainPairs,
  };
}

function actualPreparedFixture() {
  const fixture = loadFixture(DEFAULT_FIXTURE);
  const snapshot = [
    ...fixture.duplicate_clusters.flatMap((cluster) => cluster.members),
    ...fixture.clean_approved,
  ];
  return { fixture, snapshot, prepared: prepareFixture(fixture, snapshot) };
}

describe('SPEC3-F1 Phase 0 lexical detector primitives', () => {
  it('D1 is the imported current similarity behavior at the current flag threshold', () => {
    const a = learning('a', 'Shared title', 'alpha beta gamma delta epsilon zeta eta theta');
    const b = learning('b', 'Shared title', 'alpha beta gamma delta epsilon zeta eta theta');

    assert.equal(D1_THRESHOLD, 0.60);
    assert.equal(scoreChannels(a, b).d1, similarityScore(a, b));
    assert.equal(scoreChannels(a, b).d1, 1);
  });

  it('D2 unigram token-set Jaccard is symmetric, bounded, and handles empty inputs', () => {
    const a = learning('a', '', 'alpha beta beta');
    const b = learning('b', '', 'beta gamma');
    const forward = unigramJaccard(a, b);
    const reverse = unigramJaccard(b, a);

    assert.equal(forward, 1 / 3);
    assert.equal(reverse, forward);
    assert.ok(forward >= 0 && forward <= 1);
    assert.equal(setJaccard(new Set(), new Set()), 0);
    assert.equal(unigramJaccard(learning('x', '', ''), learning('y', '', '')), 0);
    assert.deepEqual([...tokenSet('Alpha, ALPHA beta!')], ['alpha', 'beta']);
  });

  it('D3 TF cosine preserves term-frequency information and stays symmetric', () => {
    const a = learning('a', '', 'red red blue');
    const b = learning('b', '', 'red blue blue');
    const score = tfCosine(a, b);

    assert.ok(Math.abs(score - 0.8) < 1e-12);
    assert.equal(tfCosine(b, a), score);
    assert.equal(tfCosine(learning('x', '', ''), b), 0);
  });

  it('calibrates cosine 0.75 to the 0.60 Jaccard-equivalent composite scale', () => {
    assert.ok(Math.abs(calibrateCosine(0.75) - 0.60) < 1e-12);
    assert.equal(calibrateCosine(0), 0);
    assert.equal(calibrateCosine(1), 1);
  });

  it('D4 reads the title channel only', () => {
    const a = learning('a', 'alpha beta gamma', 'body one');
    const sameTitle = learning('b', 'alpha beta gamma', 'totally different body');
    const sameBody = learning('c', 'unrelated title', 'body one');

    assert.equal(titleJaccard(a, sameTitle), 1);
    assert.equal(titleJaccard(a, sameBody), 0);
  });

  it('composite remains content-primary: a shared title alone cannot flag a pair', () => {
    const sharedTitle = 'shared title words';
    const a = learning(
      'a',
      sharedTitle,
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima',
    );
    const b = learning(
      'b',
      sharedTitle,
      'mango nectarine orange papaya quince raspberry strawberry tangerine ugli vanilla',
    );
    const scores = scoreChannels(a, b);

    assert.equal(scores.d4, 1);
    assert.ok(scores.content < COMPOSITE_THRESHOLD);
    assert.ok(scores.composite > scores.content, 'title should corroborate content');
    assert.ok(scores.composite < COMPOSITE_THRESHOLD, 'title alone must not flag');
  });
});

describe('SPEC3-F1 Phase 0 fixture construction and clustering', () => {
  it('builds pair keys and pair lists deterministically with exact class denominators', () => {
    assert.equal(pairKey('z', 'a'), pairKey('a', 'z'));
    assert.deepEqual(
      allPairs([
        learning('c', '', ''),
        learning('a', '', ''),
        learning('b', '', ''),
      ]).map((pair) => [pair.a.id, pair.b.id]),
      [['a', 'b'], ['a', 'c'], ['b', 'c']],
    );

    const { prepared } = actualPreparedFixture();
    assert.equal(prepared.cleanApproved.length, 80);
    assert.equal(prepared.negativePairs.length, 80 * 79 / 2);
    assert.equal(
      prepared.negativePairs.filter(
        (pair) => pair.classes.includes('historically_clean'),
      ).length,
      80 * 79 / 2,
    );
    assert.equal(
      prepared.negativePairs.filter(
        (pair) => pair.classes.includes('same_domain_different_lesson'),
      ).length,
      3,
    );
    assert.deepEqual(
      prepared.negativePairs.map((pair) => pair.key),
      [...prepared.negativePairs.map((pair) => pair.key)].sort(),
    );
  });

  it('D5 connected components are deterministic, transitive, and expose closure', () => {
    const records = [
      learning('c', '', 'gamma delta'),
      learning('a', '', 'alpha beta'),
      learning('b', '', 'alpha beta gamma delta'),
      learning('isolated', '', 'quartz zephyr'),
    ];
    const first = connectedComponents(records, 0.49);
    const second = connectedComponents([...records].reverse(), 0.49);

    assert.deepEqual(first.components, [['a', 'b', 'c']]);
    assert.deepEqual(first.components, second.components);
    assert.equal(first.componentById.get('a'), first.componentById.get('c'));
    assert.ok(
      !first.edges.some((edge) => pairKey(edge.a, edge.b) === pairKey('a', 'c')),
      'A↔C is closure through B, not a direct flag edge',
    );
  });

  it('diagnoses rejected-status and cross-category scope skips through the imported algorithm', () => {
    const olderRejected = learning(
      'rejected',
      'same lesson',
      'alpha beta gamma delta epsilon zeta eta theta iota',
      {
        status: 'rejected',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    );
    const newerSameCategory = learning(
      'newer',
      'same lesson',
      'alpha beta gamma delta epsilon zeta eta theta iota',
      { created_at: '2026-01-02T00:00:00.000Z' },
    );
    const olderOtherCategory = learning(
      'other-category',
      'another duplicate',
      'one two three four five six seven eight nine',
      {
        category: 'storage-state',
        created_at: '2026-01-01T00:00:00.000Z',
      },
    );
    const newerCategoryCandidate = learning(
      'category-candidate',
      'another duplicate',
      'one two three four five six seven eight nine',
      { created_at: '2026-01-02T00:00:00.000Z' },
    );
    const diagnosis = diagnoseCurrentAlgorithm([
      {
        key: pairKey(olderRejected.id, newerSameCategory.id),
        a: olderRejected,
        b: newerSameCategory,
      },
      {
        key: pairKey(olderOtherCategory.id, newerCategoryCandidate.id),
        a: olderOtherCategory,
        b: newerCategoryCandidate,
      },
    ]);

    assert.equal(diagnosis.scope.total_pairs, 2);
    assert.equal(diagnosis.scope.current_compared, 0);
    assert.equal(diagnosis.scope.rejected_existing, 1);
    assert.equal(diagnosis.scope.category_mismatch, 1);
    assert.equal(diagnosis.scope.h1_recovered_comparisons, 1);
    assert.equal(diagnosis.scope.h2_recovered_comparisons, 1);
    assert.equal(diagnosis.scope.full_scope_fix_compared, 2);
    assert.equal(diagnosis.scope.full_scope_fix_detected, 2);
  });

  it('loads both split clean-negative fixture files and pins exactly 80 records', () => {
    const fixture = loadFixture(DEFAULT_FIXTURE);
    assert.equal(fixture.clean_approved_files.length, 2);
    assert.equal(fixture.clean_approved.length, 80);
    assert.equal(new Set(fixture.clean_approved.map((row) => row.id)).size, 80);
  });

  it('does not mutate fixture/snapshot inputs and produces deterministic analysis', () => {
    const { fixture, snapshot } = actualPreparedFixture();
    const fixtureBefore = structuredClone(fixture);
    const snapshotBefore = structuredClone(snapshot);
    const first = analyzeFixture(prepareFixture(fixture, snapshot));
    const second = analyzeFixture(prepareFixture(fixture, snapshot));

    assert.deepEqual(fixture, fixtureBefore);
    assert.deepEqual(snapshot, snapshotBefore);
    assert.deepEqual(first, second);
  });

  it('validates snapshot presence and pinned content before analysis', () => {
    const a = learning('a', 'A', 'alpha');
    const b = learning('b', 'B', 'beta');
    const fixture = tinyFixture([{ id: 'dupe', members: [a, b] }]);

    assert.throws(
      () => prepareFixture(fixture, [a]),
      /fixture IDs missing from snapshot: b/,
    );
    assert.throws(
      () => prepareFixture(fixture, [a, { ...b, body: 'changed' }]),
      /fixture content differs from snapshot: b\.body/,
    );
    assert.deepEqual(rowsFromSnapshot({ learnings: [a, b] }), [a, b]);
    assert.throws(() => rowsFromSnapshot({ rows: [a, b] }), /snapshot must be/);
  });
});

describe('SPEC3-F1 Phase 0 CLI contract', () => {
  it('parses positional and named snapshot paths and prints help without analysis', () => {
    assert.deepEqual(
      parseArgs(['node', SCRIPT, 'snapshot.json']),
      { snapshot: 'snapshot.json', fixture: DEFAULT_FIXTURE, help: false },
    );
    assert.deepEqual(
      parseArgs(['node', SCRIPT, '--snapshot', 'snapshot.json', '--fixture', 'fixture.json']),
      { snapshot: 'snapshot.json', fixture: 'fixture.json', help: false },
    );
    assert.throws(
      () => parseArgs(['node', SCRIPT, '--snapshot']),
      /requires a path/,
    );
    assert.throws(
      () => parseArgs(['node', SCRIPT, '--unknown']),
      /unknown flag/,
    );
    const output = [];
    assert.equal(main(['node', SCRIPT, '--help'], (line) => output.push(line)), 0);
    assert.equal(output.join('\n'), usage());
  });

  it('exits 2 on a measured gate failure and leaves the snapshot byte-for-byte unchanged', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec3-f1-test-'));
    try {
      const a = learning('positive-a', 'alpha', 'alpha');
      const b = learning('positive-b', 'zulu', 'zulu');
      const n1 = learning('negative-a', 'red', 'red');
      const n2 = learning('negative-b', 'blue', 'blue');
      const fixture = tinyFixture([{ id: 'must-miss', members: [a, b] }], [n1, n2]);
      const snapshot = [a, b, n1, n2];
      const fixturePath = path.join(tempDir, 'fixture.json');
      const snapshotPath = path.join(tempDir, 'snapshot.json');
      fs.writeFileSync(fixturePath, JSON.stringify(fixture));
      fs.writeFileSync(snapshotPath, JSON.stringify(snapshot));
      const before = fs.readFileSync(snapshotPath);

      const child = spawnSync(
        process.execPath,
        [SCRIPT, '--snapshot', snapshotPath, '--fixture', fixturePath],
        { encoding: 'utf8' },
      );

      assert.equal(child.status, 2, child.stderr || child.stdout);
      assert.match(child.stdout, /GATE VERDICT: FAIL — STOP/);
      assert.match(child.stdout, /READ-ONLY: report complete; no corpus data changed/);
      assert.deepEqual(fs.readFileSync(snapshotPath), before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
