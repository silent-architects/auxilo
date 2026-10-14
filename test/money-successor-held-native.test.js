'use strict';
// EMFR A2 closure item 4, native (Linux only; owned volume; one fixture at a time). Filter: 'A2.5-held-resume'. NOT RUN on the author's macOS host.
// The claim at the source is consumed the moment it is recorded. A deterministic fault after that point must leave the target HELD (not cleared,
// not reassigned): the same target resumes once the fault is corrected, mints exactly once, and every other target stays refused.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture');
const checkpointOf = cut => ({ checkpointDir: cut.directory, digest: cut.digest });

test('A2.5-held-resume: a controlled bad target identity after the recorded claim is HELD; the source successor stays this target; another target is refused; the same target resumes and mints exactly once', { skip: N.SKIP, timeout: 240000 }, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), t1 = f.targetPath('t1');
  const crashed = N.worker({ mode: 'restore', root: f.root, target: t1, ...checkpointOf(cut), crashAfter: 'claim:recorded-durable' });
  assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
  const claimBefore = f.control(t1).restore.claim, successorBefore = f.control(f.root).control.retirement.successor;
  assert.equal(claimBefore.state, 'recorded');
  assert.ok(successorBefore, 'the source successor names this target');
  // the controlled fault: equal inode, changed bytes on the target earnings file (RESTORE_CONTINUATION_IDENTITY at the mint)
  const earnings = path.join(f.control(t1).financialDir, 'earnings.json'), original = fs.readFileSync(earnings), inode = fs.statSync(earnings).ino;
  fs.writeFileSync(earnings, Buffer.concat([original, Buffer.from(' ')]));
  assert.equal(fs.statSync(earnings).ino, inode);
  for (let attempt = 1; attempt <= 2; attempt++) {
    const held = N.worker({ mode: 'restore', root: f.root, target: t1, ...checkpointOf(cut), resume: true });
    assert.equal(held.error?.code, 'RESTORE_SUCCESSOR_HELD', JSON.stringify(held.error) + held.stdout);
    assert.equal(held.error.reason, 'RESTORE_CONTINUATION_IDENTITY');
    const state = f.control(t1).restore;
    assert.equal(state.phase, 'initializing', 'the restore is left in its phase, not finalized');
    assert.equal(state.plan, null, 'nothing is minted, no plan is finalized');
    assert.deepEqual(state.claim, claimBefore, 'the claim is never cleared or rewritten');
    assert.deepEqual(f.control(f.root).control.retirement.successor, successorBefore, 'the source successor still names this target');
  }
  // another target cannot take the consumed claim while this one is held
  const t2 = f.targetPath('t2');
  assert.deepEqual(f.restore({ target: t2, ...checkpointOf(cut) }).successor, { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' });
  assert.deepEqual(f.control(f.root).control.retirement.successor, successorBefore);
  assert.equal(f.control(t2).restore.plan.continuationEarnings, null, 'the refused target holds no continuation');
  f.drop(t2);
  // correct the fault: the SAME target resumes and mints exactly once
  fs.writeFileSync(earnings, original);
  const resumed = N.workerOk({ mode: 'restore', root: f.root, target: t1, ...checkpointOf(cut), resume: true });
  assert.equal(resumed.successor.state, 'claimed');
  assert.equal(resumed.successor.continuation, 'minted');
  const after = f.control(t1).restore;
  assert.deepEqual(after.claim, claimBefore);
  assert.equal(after.plan.continuationEarnings.entries.length, 1, 'minted exactly once');
  assert.equal(after.plan.successorClaim.successorDigest, claimBefore.successorDigest);
  assert.deepEqual(f.control(f.root).control.retirement.successor, successorBefore);
  const boot = await f.coldBoot(t1, 'resumed');
  assert.equal(boot.booted, true, boot.output);
  N.assertRealizedOnce(f.snapshot(t1), f.retained);
});
