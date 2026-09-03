'use strict';
/*
 * PRICE-NOBLOCK — scripts/backfill-pricing-blocks.js
 *
 * The load-bearing test is "shape C invariant": after the backfill, every
 * migrated row must be served exactly what it was served before. That property
 * is the whole justification for the migration being safe, so it is asserted
 * here rather than stated in a comment.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts/backfill-pricing-blocks.js');
const pricing = require('../lib/pricing.js');

function mk(i, over = {}) {
  return Object.assign({
    id: `lrn_t${i}`,
    title: `title ${i}`,
    body: 'x'.repeat(900),
    category: 'code-execution',
    outcome: 'success',
    created_at: new Date().toISOString(),
    visibility: 'public',
    status: 'approved',
    quality: { unlocks: 0, ratings: 0, helpfulness_sum: 0 },
    demand: { search_impressions_7d: 0, unlocks_7d: 0 },
    quality_self_assessment: { specificity: 3, actionability: 3, novelty: 3, completeness: 3 },
    tags: ['alpha', 'beta'],
  }, over);
}

function withStore(rows, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'price-noblock-'));
  const file = path.join(dir, 'learnings.json');
  fs.writeFileSync(file, JSON.stringify(rows, null, 2));
  try {
    return fn(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(file, dir, args) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      AUXILO_LEARNINGS_FILE: file,
      AUXILO_BACKUP_DIR: path.join(dir, 'backups'),
    }),
  });
}

function visible(rows) {
  return rows.filter((l) => l && l.visibility !== 'private' && (!l.status || l.status === 'approved'));
}

test('selection: only visible learnings without a pricing block are selected', () => {
  const rows = [
    mk(1),                                                   // in scope
    mk(2, { unlock_price: 0.08 }),                           // in scope
    mk(3, { visibility: 'private' }),                        // out: private
    mk(4, { status: 'pending_review' }),                     // out: not approved
    mk(5, { status: 'retracted' }),                          // out: retracted
    mk(6, { pricing: { base_price: 1, current_price: 1, builder_override_price: null } }), // out: already priced
  ];
  withStore(rows, (file, dir) => {
    const out = run(file, dir, ['--expect', '2']);
    assert.match(out, /selected \(visible, no pricing block\): 2/);
    assert.match(out, /DRY-RUN/);
  });
});

test('SHAPE C INVARIANT: no served price changes at apply', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(mk(i));
  rows.push(mk(90, { unlock_price: 0.08 }));
  rows.push(mk(91, { unlock_price: 0.08 }));
  withStore(rows, (file, dir) => {
    const before = new Map();
    const snap = visible(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const l of snap.filter((x) => !x.pricing)) {
      before.set(l.id, Number(pricing.getCurrentPrice(l, snap).toFixed(6)));
    }
    const out = run(file, dir, ['--expect', String(before.size), '--apply']);
    assert.match(out, /rows whose BUYER QUOTE changes at apply: 0/);

    const after = visible(JSON.parse(fs.readFileSync(file, 'utf8')));
    // Mirrors server.js:8228-8232 — what an unlock actually quotes.
    const quote = (l, cat) => Number((
      (l.pricing && l.pricing.current_price) || pricing.getCurrentPrice(l, cat) || l.unlock_price || 0.08
    ).toFixed(6));
    for (const l of after) {
      if (!before.has(l.id)) continue;
      const served = quote(l, after);
      assert.strictEqual(served, before.get(l.id), `${l.id} buyer quote moved`);
      assert.ok(l.pricing, `${l.id} has no pricing block`);
      assert.strictEqual(l.pricing.builder_override_price, null);
      assert.strictEqual(l.unlock_price, l.pricing.current_price, `${l.id} unlock_price out of step`);
    }
  });
});

test('base_price is the ENGINE figure, not the stored constant', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(mk(i));
  rows.push(mk(90, { unlock_price: 0.08 }));
  withStore(rows, (file, dir) => {
    run(file, dir, ['--expect', '26', '--apply']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    const row = after.find((l) => l.id === 'lrn_t90');
    assert.ok(row.pricing.base_price > 0.08, 'base_price should be the engine figure, above the stored 0.08');
    assert.ok(Math.abs(row.pricing.current_price - 0.067) < 0.05, 'current_price should stay near the served price');
  });
});

test('snapshot ordering: result does not depend on row order', () => {
  const build = () => {
    const r = [];
    for (let i = 0; i < 20; i += 1) r.push(mk(i));
    r.push(mk(90, { unlock_price: 0.08 }));
    return r;
  };
  const forward = build();
  const reversed = build().slice().reverse();
  const priceOf = (rows) => withStore(rows, (file, dir) => {
    run(file, dir, ['--expect', '21', '--apply']);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    return after.find((l) => l.id === 'lrn_t90').pricing.base_price;
  });
  assert.strictEqual(priceOf(forward), priceOf(reversed));
});

test('idempotent: a second run selects zero', () => {
  const rows = [];
  for (let i = 0; i < 10; i += 1) rows.push(mk(i));
  withStore(rows, (file, dir) => {
    run(file, dir, ['--expect', '10', '--apply']);
    const out = run(file, dir, ['--expect', '0']);
    assert.match(out, /selected \(visible, no pricing block\): 0/);
    assert.match(out, /Nothing to do/);
  });
});

test('--expect mismatch writes nothing and leaves the store byte-identical', () => {
  const rows = [mk(1), mk(2)];
  withStore(rows, (file, dir) => {
    const before = fs.readFileSync(file);
    assert.throws(() => run(file, dir, ['--expect', '99', '--apply']));
    assert.deepStrictEqual(fs.readFileSync(file), before, 'store must be untouched on a mismatch');
  });
});

test('--expect is mandatory', () => {
  const rows = [mk(1)];
  withStore(rows, (file, dir) => {
    assert.throws(() => run(file, dir, []));
  });
});

test('after migration one cron step moves a formerly-$0.08 row toward its base, by at most 15%', () => {
  const rows = [];
  for (let i = 0; i < 25; i += 1) rows.push(mk(i));
  rows.push(mk(90, { unlock_price: 0.08 }));
  withStore(rows, (file, dir) => {
    run(file, dir, ['--expect', '26', '--apply']);
    const after = visible(JSON.parse(fs.readFileSync(file, 'utf8')));
    const row = after.find((l) => l.id === 'lrn_t90');
    const old = row.pricing.current_price;
    // Reproduces server.js runDailyPricingCron's damping arithmetic.
    const next = Math.max(old * 0.85, Math.min(old * 1.15, pricing.getCurrentPrice(row, after)));
    assert.ok(next >= old, 'should move up toward the higher engine base');
    assert.ok(next <= old * 1.15 + 1e-9, 'must not exceed the 15% per-run cap');
    assert.ok(next <= row.pricing.base_price + 1e-9, 'must not overshoot the base');
  });
});
