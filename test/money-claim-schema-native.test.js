'use strict';
// EMFR A2 claim schema, native rows D2.4 a, b and d (Linux only; owned volume; one fixture at a time). NOT RUN on the
// author's macOS host. Row c (the validator rows) is a pure-JS test: test/money-continuation-authority.test.js and
// test/money-successor-claim.test.js (RESTORE_CLAIM_INVALID / CONFLICT / REGRESSION, the A2.3 defect row, recorded -> intent).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture');
const T = { skip: N.SKIP, timeout: 240000 };
const checkpointOf = cut => ({ checkpointDir: cut.directory, digest: cut.digest });
const INIT = 'money-atomic-restore-initialization.json', CONTROL = 'money-atomic-restore-control.bin';
const CLAIM_KEYS = ['checkpointDigest', 'generationId', 'initializationDigest', 'restoreId', 'schema', 'state', 'successorDigest'];
const sha = file => require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('D2.4a crash immediately after the recorded-state write and BEFORE continuation minting: the same target resumes with the same nonce and claim, T and successorClaim are minted exactly once, and the owed unlock completes once', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  const crashed = N.worker({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), crashAfter: 'claim:recorded-durable' });
  assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
  const dir = f.control(target).financialDir, initBefore = fs.readFileSync(path.join(dir, INIT)), initSha = sha(path.join(dir, INIT));
  const claimBefore = f.control(target).restore.claim;
  assert.deepEqual(Object.keys(claimBefore).sort(), CLAIM_KEYS, 'exactly the seven keys, in the recorded state');
  assert.equal(claimBefore.state, 'recorded');
  assert.match(claimBefore.successorDigest, /^[a-f0-9]{64}$/);
  assert.equal(f.control(target).restore.phase, 'initializing', 'the plan is not minted yet');
  assert.equal(f.control(target).restore.plan, null);
  const resumed = N.workerOk({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), resume: true });
  assert.equal(resumed.successor.state, 'claimed');
  assert.deepEqual(fs.readFileSync(path.join(dir, INIT)), initBefore, 'the initialization file bytes are unchanged (same nonce)');
  assert.equal(sha(path.join(dir, INIT)), initSha);
  const after = f.control(target).restore;
  assert.deepEqual(after.claim, claimBefore, 'body.claim is byte-equal to the pre-crash value');
  assert.equal(after.plan.continuationEarnings.entries.length, 1, 'T is minted exactly once');
  assert.ok(after.plan.successorClaim, 'plan.successorClaim is non-null');
  assert.equal(after.plan.successorClaim.successorDigest, claimBefore.successorDigest);
  assert.equal(after.plan.successorClaim.initializationDigest, claimBefore.initializationDigest);
  const again = N.workerOk({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), resume: true });
  assert.equal(again.successor.state, 'claimed', 'a second restart is a no-op');
  assert.deepEqual(f.control(target).restore.plan, after.plan);
  const boots = [await f.coldBoot(target, 'boot-a'), await f.coldBoot(target, 'boot-b')];
  assert.deepEqual(boots.map(b => b.booted), [true, true], boots.map(b => b.output).join('\n'));
  N.assertRealizedOnce(f.snapshot(target), f.retained);
});

test('D2.4d crash cuts at claim:intent-durable and claim:cas-durable still resume with the FULL claim retained (all four identity fields in both states)', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  assert.equal(N.worker({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), crashAfter: 'claim:intent-durable' }).crashed, true);
  const intent = f.control(target).restore.claim;
  assert.deepEqual(Object.keys(intent).sort(), CLAIM_KEYS);
  assert.equal(intent.state, 'intent');
  assert.equal(intent.successorDigest, null);
  assert.equal(f.control(f.root).control.retirement.successor, null, 'the CAS had not happened');
  assert.equal(N.worker({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), resume: true, crashAfter: 'claim:cas-durable' }).crashed, true);
  const sourceSuccessor = f.control(f.root).control.retirement.successor;
  assert.ok(sourceSuccessor, 'the CAS is durable at this cut');
  assert.deepEqual(f.control(target).restore.claim, intent, 'the claim is still the intent record, retained whole');
  const resumed = N.workerOk({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), resume: true });
  assert.equal(resumed.successor.state, 'claimed');
  const recorded = f.control(target).restore.claim;
  for (const key of ['restoreId', 'generationId', 'initializationDigest', 'checkpointDigest', 'schema']) assert.equal(recorded[key], intent[key], key + ' survives the intent -> recorded write');
  assert.equal(recorded.state, 'recorded');
  assert.deepEqual(f.control(f.root).control.retirement.successor, sourceSuccessor, 'the source successor is byte-stable across the resume');
});

test('D2.4b a second target cannot reuse the first target\'s evidence: its restore control copied in is RESTORE_CLAIM_CONFLICT, its initialization file copied in is RESTORE_INITIALIZATION_QUARANTINED, and the source successor never moves', T, async t => {
  const f = await N.crashedSource(t), c1 = f.retire(), c2 = f.retire({ via: 'tool' }), t1 = f.targetPath('t1'), t2 = f.targetPath('t2');
  assert.equal(f.restore({ target: t1, ...checkpointOf(c1) }).successor.state, 'claimed');
  const successor = f.control(f.root).control.retirement.successor, d1 = f.control(t1).financialDir;
  // T2 is physically staged from the replacement checkpoint, then given T1's evidence before its capacity restore.
  assert.deepEqual(N.workerOk({ mode: 'restore', root: f.root, target: t2, ...checkpointOf(c2), onlyStage: true }), { staged: true });
  const d2 = f.control(t2).financialDir;
  // (i) T1's restore control (carrying its claim) copied into T2's financial directory.
  fs.copyFileSync(path.join(d1, CONTROL), path.join(d2, CONTROL)); fs.chmodSync(path.join(d2, CONTROL), 0o600);
  let attempt = N.worker({ mode: 'restore', root: f.root, target: t2, ...checkpointOf(c2), resume: true });
  assert.equal(attempt.error?.code, 'RESTORE_CLAIM_CONFLICT', JSON.stringify(attempt.error) + attempt.stdout);
  assert.deepEqual(f.control(f.root).control.retirement.successor, successor);
  fs.rmSync(path.join(d2, CONTROL));
  // (ii) T1's initialization file copied into T2.
  fs.copyFileSync(path.join(d1, INIT), path.join(d2, INIT)); fs.chmodSync(path.join(d2, INIT), 0o600);
  attempt = N.worker({ mode: 'restore', root: f.root, target: t2, ...checkpointOf(c2), resume: true });
  assert.equal(attempt.error?.code, 'RESTORE_INITIALIZATION_QUARANTINED', JSON.stringify(attempt.error) + attempt.stdout);
  assert.deepEqual(f.control(f.root).control.retirement.successor, successor, 'no CAS was attempted');
  fs.rmSync(path.join(d2, INIT));
  // (iii) T2's own restore from the replacement checkpoint: refused at the source record, plan finalized SUCCESSOR_REFUSED.
  const own = N.workerOk({ mode: 'restore', root: f.root, target: t2, ...checkpointOf(c2), resume: true });
  assert.deepEqual(own.successor, { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' });
  assert.equal(f.control(t2).restore.plan.continuationWithheld, 'SUCCESSOR_REFUSED');
  assert.deepEqual(f.control(f.root).control.retirement.successor, successor);
  f.drop(t2);
  // T1 remains resumable and completes.
  assert.equal((await f.coldBoot(t1, 't1-boot')).booted, true);
  N.assertRealizedOnce(f.snapshot(t1), f.retained);
});
