'use strict';
// EMFR A2 successor gate, native rows A1.5 a-e (Linux only; owned volume; one fixture at a time). Ordinary checkpoints stay
// outside this file: successor status 'none' is unchanged for every existing path. NOT RUN on the author's macOS host.
// Row f (inherited selected compensation restored from a retiring checkpoint) is covered by the unit gate matrix
// (test/money-successor-gate.test.js: RS includes the inherited compensation) and is NOT repeated natively here.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const N = require('./helpers/money-continuation-native-fixture');
const T = { skip: N.SKIP, timeout: 240000 };
const checkpointOf = cut => ({ checkpointDir: cut.directory, digest: cut.digest });
const CAPABILITY_REFUSALS = [{ funding: true }, { spend: true }, { reconcile: true }];

test('A1.5a/b/c unclaimed (a retiring checkpoint restored with no successorClaim): capabilities and contexts refuse, inspection and restore resume are allowed', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  // Crash the restore after SQL commit so that "restore resumed to completion" is part of the unclaimed behaviour (c).
  const crashed = N.worker({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), claim: 'none', crashAfter: 'sql:committed' });
  assert.equal(crashed.crashed, true, crashed.stdout + crashed.stderr);
  const resumed = N.workerOk({ mode: 'restore', root: f.root, target, ...checkpointOf(cut), claim: 'none', resume: true });
  assert.equal(resumed.successor.state, 'absent');
  const detail = f.control(target);
  assert.ok(detail.control.successorOf, 'a successor marker');
  assert.equal(detail.restore.plan.successorClaim, null);
  // a: the operator path. Control bytes must be identical after every refused transition.
  const controlFile = path.join(detail.financialDir, 'epoch-control.json'), before = fs.readFileSync(controlFile), snapshot = f.snapshot(target);
  for (const patch of CAPABILITY_REFUSALS) assert.equal(N.workerOk({ mode: 'transition', root: target, patch }).code, 'EPOCH_SUCCESSOR_UNCLAIMED', JSON.stringify(patch));
  assert.deepEqual(fs.readFileSync(controlFile), before);
  // b: money contexts and a participant effect through registerRecoveryAnchor.
  const contexts = N.workerOk({ mode: 'contexts', root: target, spendId: f.spend.id });
  for (const name of ['reconcile', 'funding', 'spend', 'buyer_return', 'anchor_persist_result', 'anchor_participant_effect', 'anchor_boot_recovery', 'anchor_compensate']) assert.equal(contexts[name].code, 'EPOCH_SUCCESSOR_UNCLAIMED', name);
  assert.deepEqual(N.withoutIdentity(f.snapshot(target)), N.withoutIdentity(snapshot), 'SQL, credits and earnings unchanged');
  // c: read-only inspection works, and the unclaimed target refuses to realize at boot with nothing manufactured.
  assert.equal(contexts.failure.state !== undefined, true);
  const boot = await f.coldBoot(target, 'unclaimed');
  assert.equal(boot.booted, false);
  N.assertHeldUnrealized(f.snapshot(target), f.retained);
});

test('A1.5c boot with no pending work reaches /health on an unclaimed successor', T, async t => {
  const owned = N.admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json');
  t.after(() => { if (fs.existsSync(locator)) { const x = N.json(locator); for (const k of ['root', 'target']) if (x[k]) fs.rmSync(x[k], { recursive: true, force: true }); } fs.rmSync(box, { recursive: true, force: true }); });
  N.admittedWorker({ mode: 'setup', locator });
  const located = N.json(locator), cut = N.workerOk({ mode: 'retire', root: located.root });
  const outcome = N.workerOk({ mode: 'restore', root: located.root, target: located.target, ...checkpointOf(cut), claim: 'none' });
  assert.equal(outcome.successor.state, 'absent');
  const boot = await N.coldBoot(box, located.target, 'no-pending');
  assert.equal(boot.booted, true, boot.output);
  assert.equal(boot.health.financial_epoch?.capacity_available === undefined || typeof boot.health.financial_epoch.capacity_available === 'boolean', true);
});

test('A1.5d/e claimed: boot recovery completes the owed unlock once, then every ordinary context and capability is refused until the barrier is reconciled', T, async t => {
  const f = await N.crashedSource(t), cut = f.retire(), target = f.targetPath('main');
  assert.equal(f.restore({ target, ...checkpointOf(cut) }).successor.state, 'claimed');
  const boots = [await f.coldBoot(target, 'boot-a'), await f.coldBoot(target, 'boot-b')];
  assert.deepEqual(boots.map(b => b.booted), [true, true], boots.map(b => b.output).join('\n'));
  N.assertRealizedOnce(f.snapshot(target), f.retained);
  const contexts = N.workerOk({ mode: 'contexts', root: target, spendId: f.spend.id });
  for (const name of ['reconcile', 'funding', 'spend', 'buyer_return', 'anchor_persist_result', 'anchor_participant_effect']) assert.equal(contexts[name].code, 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED', name);
  assert.notEqual(contexts.anchor_boot_recovery.code, 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED', 'recovery of the authorized spend is not refused by the successor gate');
  const controlFile = path.join(f.control(target).financialDir, 'epoch-control.json'), before = fs.readFileSync(controlFile);
  assert.equal(N.workerOk({ mode: 'transition', root: target, patch: { spend: true } }).code, 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED');
  assert.equal(N.workerOk({ mode: 'transition', root: target, patch: { funding: true } }).code, 'EPOCH_SUCCESSOR_ACTIVATION_REQUIRED');
  assert.deepEqual(fs.readFileSync(controlFile), before);
  // e: no supported writer of barrier state 'reconciled' exists in the repository; this fixture is corruption-style and labelled as such.
  N.workerOk({ mode: 'reconcile-barrier', root: target });
  const activated = N.workerOk({ mode: 'transition', root: target, patch: { spend: true } });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(activated.capabilities.spend, true);
});
