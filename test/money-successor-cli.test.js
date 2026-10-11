'use strict';
// A2 operator tools: the offline restore names the retired source explicitly and holds its writer; the checkpoint tool
// retires only through the explicit `retire` mode with a stopped source. Both close every writer they open.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), proxyquire = require('proxyquire').noCallThru();
function dir(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'successor-cli-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
function restoreTool(t, restore) {
  const root = dir(t), opened = [], closed = [];
  const lock = { acquireMoneyWriter({ root: r }) { const writer = { root: r, close() { closed.push(r); } }; opened.push(r); return writer; } };
  const main = proxyquire('../scripts/money-restore', { '../lib/money-checkpoint': { restoreCheckpointCapacity: restore }, '../lib/money-writer-lock': lock }).main;
  const file = input => { const f = path.join(root, 'request.json'); fs.writeFileSync(f, JSON.stringify(input), { mode: 0o600 }); return f; };
  return { root, main, opened, closed, file, base: { mode: 'capacity', targetRoot: path.join(root, 'target'), execution_approval_ref: 'explicit-synthetic', checkpointDir: path.join(root, 'cp') } };
}
test('restore tool: no successor_claim passes no claim; successor_claim acquires the source writer and passes {sourceRoot, sourceWriter}', async t => {
  let received;
  const f = restoreTool(t, async input => { received = input; return { state: 'reconcile_only' }; });
  await f.main([f.file(f.base)]);
  assert.equal(Object.hasOwn(received, 'successorClaim'), false);
  assert.deepEqual(f.opened, [f.base.targetRoot]);
  f.opened.length = 0; f.closed.length = 0;
  const sourceRoot = path.join(f.root, 'source');
  await f.main([f.file({ ...f.base, successor_claim: { sourceRoot } })]);
  assert.equal(received.successorClaim.sourceRoot, sourceRoot);
  assert.equal(received.successorClaim.sourceWriter.root, sourceRoot);
  assert.deepEqual(f.opened, [f.base.targetRoot, sourceRoot]);
  assert.deepEqual(f.closed.sort(), [f.base.targetRoot, sourceRoot].sort(), 'both writers are released');
});
test('restore tool: a malformed or self-referential successor_claim is refused before any writer is taken', async t => {
  const f = restoreTool(t, async () => assert.fail('must not restore'));
  for (const bad of [{ sourceRoot: 'relative/path' }, { sourceRoot: f.base.targetRoot }, {}, { sourceRoot: path.join(f.root, 'source'), extra: 1 }, null]) {
    await assert.rejects(f.main([f.file({ ...f.base, successor_claim: bad })]), /successor_claim/);
  }
  assert.deepEqual(f.opened, []);
});
test('restore tool: a refused restore still releases the source and target writers', async t => {
  const f = restoreTool(t, async () => { throw Object.assign(Error('RESTORE_SUCCESSOR_HELD'), { code: 'RESTORE_SUCCESSOR_HELD' }); });
  const sourceRoot = path.join(f.root, 'source');
  await assert.rejects(f.main([f.file({ ...f.base, successor_claim: { sourceRoot } })]), { code: 'RESTORE_SUCCESSOR_HELD' });
  assert.equal(f.closed.length, 2);
});
test('checkpoint tool: retire mode needs an input file and an approval, takes the source writer, and uses a maintenance-only coordinator', async t => {
  const root = dir(t), closed = [], calls = [];
  const writer = { close() { closed.push('writer'); } }, epoch = { legacy_root: root }, store = { close() { closed.push('store'); }, maintenanceLease: fn => fn({ store }) };
  const tool = proxyquire('../scripts/money-checkpoint', {
    '../lib/money-checkpoint': { createRetiringCheckpoint: async options => { calls.push(options); assert.deepEqual(Object.keys(options.coordinator), ['maintenanceLease']); return { checkpoint_id: 'id', revision: 3, digest: 'd', unresolved_obligations: 1, completion_guaranteed: false, retirement: { generation_id: 'g' } }; }, checkpointDirectory: (r, id) => path.join(r, '.money-checkpoints', id) },
    '../lib/money-writer-lock': { acquireMoneyWriter: ({ root: r }) => { assert.equal(r, root); return writer; } },
    '../lib/financial-epoch': { resolveRuntimeEpoch: ({ root: r, writer: w }) => { assert.equal(w, writer); return epoch; } },
    '../lib/money-control-store': { openMoneyStore: ({ epoch: e, writer: w }) => { assert.equal(e, epoch); assert.equal(w, writer); return store; } }
  });
  await assert.rejects(tool.main([root, 'retire']), /input JSON/);
  const input = path.join(root, 'retire.json');
  fs.writeFileSync(input, JSON.stringify({ source_sha: 'a'.repeat(40), lifecycleControl: { schema_version: 1 } }));
  await assert.rejects(tool.main([root, 'retire', input]), /approval/);
  assert.deepEqual(closed, [], 'nothing was opened before the input was accepted');
  fs.writeFileSync(input, JSON.stringify({ approval_ref: 'approval:retire-1', source_sha: 'a'.repeat(40), lifecycleControl: { schema_version: 1 } }));
  const result = await tool.main([root, 'retire', input]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].approvalRef, 'approval:retire-1');
  assert.equal(calls[0].writer, writer);
  assert.equal(result.completion_guaranteed, false);
  assert.equal(result.unresolved_obligations, 1);
  assert.deepEqual(closed, ['store', 'writer']);
  await assert.rejects(tool.main([root, 'bogus']), /Expected request, validate or retire/);
});

// ---- review fix 1: a refused or withheld claim must not look like success -------------------------------------
const claimRequest = (f, extra = {}) => ({ mode: 'capacity', targetRoot: path.join(f.root, 'target'), execution_approval_ref: 'explicit-synthetic', checkpointDir: path.join(f.root, 'cp'), successor_claim: { sourceRoot: path.join(f.root, 'source') }, ...extra });
test('restore tool: a refused successor claim exits non-zero with its own code and the successor refusal code, and still releases both writers', async t => {
  const f = restoreTool(t, async () => ({ state: 'reconcile_only', successor: { state: 'refused', code: 'SUCCESSOR_ALREADY_CLAIMED' } }));
  await assert.rejects(f.main([f.file(claimRequest(f))]), error => {
    assert.equal(error.code, 'SUCCESSOR_REFUSED');
    assert.equal(error.successorCode, 'SUCCESSOR_ALREADY_CLAIMED');
    assert.equal(error.result.state, 'reconcile_only', 'the restore itself completed and is reported');
    assert.equal(error.exitCode, 3);
    return true;
  });
  assert.equal(f.closed.length, 2);
});
test('restore tool: a withheld successor claim exits with a distinct non-zero code', async t => {
  const f = restoreTool(t, async () => ({ state: 'reconcile_only', successor: { state: 'withheld' } }));
  await assert.rejects(f.main([f.file(claimRequest(f))]), error => error.code === 'SUCCESSOR_WITHHELD' && error.exitCode === 4 && error.successorCode === undefined);
});
test('restore tool: claimed (with or without an owed unlock) and a restore that asked for no claim succeed; the exit mapping is distinct per outcome', async t => {
  for (const successor of [{ state: 'claimed', continuation: 'minted' }, { state: 'claimed', continuation: 'none_owed' }]) {
    const f = restoreTool(t, async () => ({ state: 'reconcile_only', successor }));
    assert.deepEqual((await f.main([f.file(claimRequest(f))])).successor, successor);
  }
  const plain = restoreTool(t, async () => ({ state: 'reconcile_only', successor: { state: 'absent' } }));
  await plain.main([plain.file({ ...claimRequest(plain), successor_claim: undefined })]);
  const tool = require('../scripts/money-restore');
  assert.equal(tool.exitCodeFor({ exitCode: 3 }), 3);
  assert.equal(tool.exitCodeFor({ exitCode: 4 }), 4);
  assert.equal(tool.exitCodeFor(new Error('x')), 1);
});
