'use strict';
// EMFR A2 retirement identity, native rows (Linux only; owned volume; one fixture at a time). NOT RUN on the author's macOS host.
// Addendum 1 A3.4a (copy rejection) and A3.4b (old-binary refusal against REAL retired and successor directories), plus
// Addendum 2 D1.7a (a checkpoint taken before finalization still claims after it). The remaining D1.7 rows are exercised
// without a database in test/money-retirement-identity.test.js, test/money-retiring-checkpoint.test.js and
// test/money-successor-claim.test.js, and their native crash-cut forms live in test/money-continuation-authority-native.test.js.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture'), { materializeBaseline } = require('./helpers/money-baseline');
const T = { skip: N.SKIP, timeout: 240000 };
const checkpointOf = cut => ({ checkpointDir: cut.directory, digest: cut.digest });

test('A3.4a copy rejection: a file-level copy of the retired source offered as sourceRoot is SOURCE_IDENTITY_MISMATCH, neither copy nor original gains a successor, and the genuine claim then succeeds once', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), detail = f.control(f.root);
  // A minimal file-level copy is enough: the root, lock and database inodes of any copy differ from the recorded ones.
  const copy = f.targetPath('copy'), epochId = N.json(path.join(f.root, 'financial-epoch.json')).identity.epoch_id;
  fs.mkdirSync(path.join(copy, 'financial-epochs', epochId), { recursive: true, mode: 0o700 });
  for (const name of ['financial-epoch.json']) fs.copyFileSync(path.join(f.root, name), path.join(copy, name));
  for (const name of ['epoch-control.json', 'money-control.json', 'money-control.sqlite']) fs.copyFileSync(path.join(detail.financialDir, name), path.join(copy, 'financial-epochs', epochId, name));
  const copyBefore = fs.readFileSync(path.join(copy, 'financial-epochs', epochId, 'epoch-control.json')), originalBefore = fs.readFileSync(path.join(detail.financialDir, 'epoch-control.json'));
  const refused = N.workerOk({ mode: 'restore', root: f.root, target: f.targetPath('t1'), ...checkpointOf(cut), claimRoot: copy });
  assert.deepEqual(refused.successor, { state: 'refused', code: 'SOURCE_IDENTITY_MISMATCH' });
  assert.deepEqual(fs.readFileSync(path.join(copy, 'financial-epochs', epochId, 'epoch-control.json')), copyBefore);
  assert.deepEqual(fs.readFileSync(path.join(detail.financialDir, 'epoch-control.json')), originalBefore, 'the original gained no successor');
  assert.equal(f.control(f.root).control.retirement.successor, null);
  f.drop(f.targetPath('t1')); f.drop(copy);
  const genuine = N.workerOk({ mode: 'restore', root: f.root, target: f.targetPath('t2'), ...checkpointOf(cut) });
  assert.equal(genuine.successor.state, 'claimed');
  assert.ok(f.control(f.root).control.retirement.successor);
});

test('A3.4b old binary: the pre-A2 modules (git archive 6653298 lib) cannot resolve a REAL retired source or a REAL successor target', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  f.restore({ target, ...checkpointOf(cut) });
  const old = materializeBaseline(t).load('financial-epoch.js');
  for (const [name, root] of [['retired source', f.root], ['successor target', target]]) {
    assert.throws(() => old.resolveRuntimeEpoch({ root }), { code: 'EPOCH_CONTROL_INVALID' }, name);
  }
  // The A2 binary still resolves both (the new validator accepts schema_version 2).
  const current = require('../lib/financial-epoch');
  assert.equal(current.readEpochControl(f.root).control.retirement.state, 'retired');
  assert.ok(current.readEpochControl(target).control.successorOf);
});

test('D1.7a a checkpoint taken BEFORE finalization claims after finalization, and the replacement carries the same projection', T, async t => {
  const f = await N.crashedSource(t), crashed = f.retireRaw({ crashAfter: 'retire:published' });
  assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
  assert.equal(f.control(f.root).control.retirement.state, 'retiring');
  const orphanName = fs.readdirSync(path.join(f.root, '.money-checkpoints')).filter(n => !n.endsWith('.tmp'))[0], orphan = path.join(f.root, '.money-checkpoints', orphanName);
  const orphanManifest = N.json(path.join(orphan, 'money-checkpoint-manifest.json'));
  const second = f.retire({ via: 'tool' }), finalized = f.control(f.root).control.retirement;
  assert.equal(finalized.state, 'retired');
  const secondManifest = N.json(path.join(second.directory, 'money-checkpoint-manifest.json'));
  assert.deepEqual(secondManifest.sourceRetirement, orphanManifest.sourceRetirement, 'same generationId, identityDigest and byte-equal identity');
  assert.notEqual(secondManifest.checksum, orphanManifest.checksum);
  assert.equal(finalized.identityDigest, orphanManifest.sourceRetirement.identityDigest);
  const outcome = f.restore({ target: f.targetPath('main'), checkpointDir: orphan, digest: orphanManifest.checksum });
  assert.equal(outcome.successor.state, 'claimed', 'the v2/A3.1 digest of the retiring-era control would have failed here');
});
