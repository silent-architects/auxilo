'use strict';
// EMFR A2 closure item 3, native (Linux only; owned volume; one fixture at a time). Filter: 'A1.5f'. NOT RUN on the author's macOS host.
// A SELECTED compensation (failure control compensation_requested, pre-WAL) exists at the retiring cut. The unclaimed successor refuses to complete it
// (EPOCH_SUCCESSOR_UNCLAIMED, state preserved); the claimed successor completes the inherited compensation EXACTLY ONCE across two cold opens.
//
// Reachability: createRetiringCheckpoint refuses only when a credits compensation STAGE file exists (lib/money-checkpoint.js: "if(retire&&compensationStage)",
// CHECKPOINT_RETIRE_COMPENSATION_STAGE_UNSUPPORTED). A selected compensation AT REST has no stage file, so it retires normally; the 'candidate' shape of
// test/money-atomic-restore-native.test.js (a staged credits.json.<uuid>.tmp mid-compensation) stays refused and is not exercised here.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), { spawnSync } = require('node:child_process');
const N = require('./helpers/money-continuation-native-fixture');

// ---- worker side ----------------------------------------------------------------------------------------------------
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function prepare({ locator }) {
  const h = require('./helpers/money-compensation-native-fixture'), f = await h.setup({ onRoot: root => fs.writeFileSync(locator, JSON.stringify({ root })) });
  try {
    await f.coordinator.withMoneyControl({ kind: 'unlock', accounts: ['buyer'], credits: ['buyer'], action: 'new_spend' }, async () => {
      const debit = await f.credits.deductCredit('buyer', 'unlock', 0.02);
      assert.equal(debit.success, true);
      const spend = f.coordinator.store.listSpends({ limit: 10 }).items[0], anchor = f.coordinator.recoveryAnchors.resolveCommittedAnchor({ kind: 'spend', id: spend.id });
      f.coordinator.failureControl.requestCompensation({ spendCapability: anchor, preWalCapability: debit.preWalCapability });
    });
    const status = f.coordinator.failureControl.status();
    assert.equal(status.state, 'compensation_requested');
    return { spendId: status.compensation.spendId, walId: status.compensation.walId };
  } finally { f.coordinator.store.close(); f.writer.close(); }
}
function openRuntime(root) {
  process.env.AUXILO_DATA_DIR = root; process.env.AUXILO_SQLITE_TMPDIR = path.join(root, 'sqlite-runtime-temp');
  const e = require('../lib/financial-epoch'), writer = require('../lib/money-writer-lock').acquireMoneyWriter({ root });
  try { const epoch = e.resolveRuntimeEpoch({ root, writer }); return { epoch, writer, money: require('../lib/money-control').initializeMoneyRuntime({ epoch, writer }) }; } catch (error) { writer.close(); throw error; }
}
function observe(money, epoch) {
  const e = require('../lib/financial-epoch'), credits = JSON.parse(fs.readFileSync(e.pathFor('credits', epoch))).buyer, spends = money.store.listSpends({ limit: 10 }).items;
  return { failure: money.failureControl.status().state, spends: spends.map(s => s.state), remaining: credits.dollar_lots[0].remaining_usd, inflight: credits.dollar_lots[0].inflight_usd, receipts: Object.keys(credits.money_receipts || {}).sort(), spentMicros: money.store.getSource('fund').spentMicros };
}
// The boot-recovery step of server.js recoverProspectiveLocalAtBoot for compensation_requested, then the scan to idle.
function recover({ root }) {
  const f = openRuntime(root);
  try {
    const wal = require('../lib/wal'), manager = f.money.failureControl, initial = manager.status();
    const before = observe(f.money, f.epoch), out = { before, error: null };
    if (initial.state === 'compensation_requested') {
      try { f.money.withMoneyBootControl({ recoveryAnchor: f.money.recoveryAnchors.restore(initial.anchor), action: 'compensate' }, () => wal.completeCompensationSync(manager.resumeCompensation())); } catch (error) { out.error = error.code || error.message; }
      if (!out.error) require('./helpers/money-compensation-native-fixture').scan(f.money);
    }
    out.after = observe(f.money, f.epoch);
    return out;
  } finally { f.money.store.close(); f.writer.close(); }
}
function files({ root }) {
  const e = require('../lib/financial-epoch'), binding = JSON.parse(fs.readFileSync(path.join(root, e.BINDING_FILE))), dir = path.join(root, 'financial-epochs', binding.identity.epoch_id);
  return Object.fromEntries(['money-first-failure-control.bin', 'credits.json', 'earnings.json'].map(n => [n, sha(path.join(dir, n))]));
}
if (require.main === module && process.env.EMFR_A2_COMP_WORKER) {
  const r = JSON.parse(process.env.EMFR_A2_COMP_WORKER), modes = { prepare, recover, files };
  Promise.resolve().then(() => modes[r.mode](r)).then(v => process.stdout.write('A2_RESULT ' + JSON.stringify(v) + '\n')).catch(error => { process.stdout.write('A2_ERROR ' + JSON.stringify({ code: error.code, message: error.message }) + '\n'); process.exitCode = 2; });
  return;
}

// ---- test side --------------------------------------------------------------------------------------------------------
const compWorker = request => N.run(__filename, { EMFR_A2_COMP_WORKER: JSON.stringify(request) });
function compOk(request) { const r = compWorker(request); assert.equal(r.status, 0, request.mode + ' failed\n' + r.stdout + r.stderr); return r.result; }
const checkpointOf = cut => ({ checkpointDir: cut.directory, digest: cut.digest });

test('A1.5f inherited selected compensation: the unclaimed successor refuses to complete it and preserves state; the claimed successor completes it exactly once across two cold opens', { skip: N.SKIP, timeout: 240000 }, async t => {
  const owned = N.admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json'), extra = [];
  t.after(() => { if (fs.existsSync(locator)) { const x = N.json(locator); for (const file of [x.root, ...extra]) if (file) fs.rmSync(file, { recursive: true, force: true }); } fs.rmSync(box, { recursive: true, force: true }); });
  const selected = compOk({ mode: 'prepare', locator }), root = N.json(locator).root;
  assert.equal(selected.walId, null, 'a pre-WAL selected compensation');
  const cut = N.workerOk({ mode: 'retire', root }), manifest = N.json(path.join(cut.directory, 'money-checkpoint-manifest.json'));
  assert.equal(manifest.first_failure_control.state, 'compensation_requested');
  assert.equal(manifest.atomic_capacity_cut.compensationEarnings.spendId, selected.spendId, 'the cut carries the selected compensation');
  assert.equal(manifest.atomic_capacity_cut.continuationEarnings, null, 'no WAL, no continuation entry');
  assert.ok(manifest.sourceRetirement);

  // Unclaimed: restored from the retiring checkpoint with no claim offered.
  const unclaimed = root + '-u'; extra.push(unclaimed);
  assert.equal(N.workerOk({ mode: 'restore', root, target: unclaimed, ...checkpointOf(cut), claim: 'none' }).successor.state, 'absent');
  const filesBefore = compOk({ mode: 'files', root: unclaimed }), refused = compOk({ mode: 'recover', root: unclaimed });
  assert.equal(refused.error, 'EPOCH_SUCCESSOR_UNCLAIMED', 'the unclaimed successor refuses to complete the inherited compensation');
  assert.equal(refused.after.failure, 'compensation_requested');
  assert.deepEqual(refused.after.spends, ['acknowledged']);
  assert.equal(refused.after.remaining, refused.before.remaining, 'principal untouched');
  assert.equal(refused.after.spentMicros, refused.before.spentMicros);
  assert.deepEqual(refused.after.receipts, refused.before.receipts, 'no restore receipt');
  assert.deepEqual(compOk({ mode: 'files', root: unclaimed }), filesBefore, 'failure control, credits and earnings are byte-identical');
  fs.rmSync(unclaimed, { recursive: true, force: true });

  // Claimed: the SAME checkpoint, this time claiming the source.
  const claimed = root + '-c'; extra.push(claimed);
  assert.equal(N.workerOk({ mode: 'restore', root, target: claimed, ...checkpointOf(cut) }).successor.state, 'claimed');
  const first = compOk({ mode: 'recover', root: claimed });
  assert.equal(first.error, null, JSON.stringify(first));
  assert.equal(first.before.failure, 'compensation_requested');
  assert.equal(first.after.failure, 'idle');
  assert.deepEqual(first.after.spends, ['returned']);
  assert.equal(first.after.remaining, 0.02, 'principal restored');
  assert.equal(first.after.inflight, 0);
  assert.equal(first.after.spentMicros, 0);
  assert.equal(first.after.receipts.filter(id => id.endsWith(':restore')).length, 1, 'one restore receipt');
  const second = compOk({ mode: 'recover', root: claimed });
  assert.equal(second.error, null);
  assert.equal(second.before.failure === 'idle' || second.before.failure === 'recovery_scan', true, 'nothing left to complete');
  assert.deepEqual({ ...second.after, failure: undefined }, { ...first.after, failure: undefined }, 'a second cold open changes nothing: no duplicate refund, receipt or spend');
});
