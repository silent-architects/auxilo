'use strict';
// A2 MONEY lane, lib/wal.js (v3 3.1-3.4): the one extra accept branch of beginEarningsWrite, the always-unchanged
// COMPENSATION_ACCRUAL_CONFLICT code with non-enumerable gate/check, the entry-limit admission guard, and the
// read-only inspector. The restore proof itself is stubbed here and exercised by the pure-helper and native tests.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const proxyquire = require('proxyquire').noCallThru(), p = require('../lib/stripe-transfer-persistence');
const code = c => error => error.code === c;

function fixture(t, { assertContinuation } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wal-continuation-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const epoch = { financial_dir: dir, legacy_root: dir }, files = { wal: path.join(dir, 'wal'), earnings: path.join(dir, 'earnings.json'), credits: path.join(dir, 'credits.json') };
  fs.mkdirSync(files.wal); fs.writeFileSync(files.earnings, '{}');
  const participantDraws = [{ lotId: 'lot', kind: 'dollar_paid', amountMicros: 2000000, sourceId: 'source', promoReceiptId: null }];
  const intent = { id: 'spend', accountId: 'buyer', draws: [{ sourceId: 'source', amountMicros: 2000000 }], participantDraws };
  const spend = { ...intent, intent, digest: p.digestJSON(intent), state: 'acknowledged' };
  fs.writeFileSync(files.credits, JSON.stringify({ buyer: { money_receipts: { spend: { projection_id: 'spend', digest: spend.digest } }, dollar_lots: [{ lot_id: 'lot', kind: 'dollar_paid', remaining_usd: 8, inflight_usd: 2 }] } }));
  const ctx = { epoch, flush() {}, getSpend: () => structuredClone(spend), getPool: () => null, getSourceByLot: () => ({ id: 'source' }) };
  let marker = null, root = { id: 'capacity:root', restoreBinding: { planDigest: 'a'.repeat(64) } };
  const manager = { assertCompensation: () => marker, status: () => ({ state: 'failure_pending', compensation: marker }) };
  const runtime = { epoch, writer: { token: 'writer' }, store: { getSpend: () => structuredClone(spend), getCapacityRecord: () => root }, failureControl: manager };
  const money = { getMoneyRuntime: () => runtime, assertMoneyContext: () => ctx, assertParticipantWrite() {}, poisonMoneyRuntime() {}, toMicros: n => Math.round(n * 1e6) };
  const calls = [];
  const restore = { assertRestoredContinuationIdentity(input) { calls.push(input); if (assertContinuation) return assertContinuation(input); return true; } };
  const wal = proxyquire('../lib/wal', { './money-control': money, './money-atomic-restore': restore, './financial-epoch': { getRuntimeEpoch: () => epoch, resolveParticipantPath: name => files[name], pathFor: name => files[name] } });
  const draws = [{ lot_id: 'lot', kind: 'dollar_paid', amount: 2, spend_id: 'spend', inflight_marked: true }];
  const create = () => wal.createWalEntry('unlock', { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: draws }, { preWalCapability: wal.createPreWalPhase({ spendId: 'spend' }) });
  const walFile = id => path.join(files.wal, id + '.wal.json');
  // A restored target: same bytes, a different inode (copy then rename over).
  // The replacement is created BEFORE the original is removed (write beside it, then rename over it), so the two inodes are alive together and cannot share a
  // number. The earlier remove-then-write let Linux (ext4, tmpfs) hand the freed inode number straight to the new file: same dev and ino, so the reader
  // correctly saw the live identity and the "new inode" cases never reached the restore proof. macOS does not reuse numbers that fast, which hid it.
  const moveInode = () => {
    const before = fs.statSync(files.earnings), bytes = fs.readFileSync(files.earnings), beside = files.earnings + '.moved';
    fs.writeFileSync(beside, bytes); fs.renameSync(beside, files.earnings);
    const after = fs.statSync(files.earnings);
    assert.notEqual(after.ino, before.ino, 'the fixture must really present a new inode');
  };
  return { dir, files, wal, spend, calls, create, walFile, moveInode, runtime, setRoot: v => { root = v; }, draws, ctx, restore };
}

test('live path: identical inode never enters the continuation branch; the fence moves not_started -> write_started once', t => {
  const x = fixture(t), id = x.create();
  const cap = x.wal.beginEarningsWrite(id);
  assert.equal(x.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(x.walFile(id))).accrualFence.state, 'write_started');
  assert.ok(cap);
  assert.throws(() => x.wal.beginEarningsWrite(id), code('COMPENSATION_ACCRUAL_CONFLICT'), 'second use refuses on the fence state');
});
test('digest strictness is its own clause and unchanged: a changed earnings digest refuses before any identity decision (C3-D1)', t => {
  const x = fixture(t), id = x.create();
  fs.writeFileSync(x.files.earnings, '{"changed":true}');
  x.moveInode();
  assert.throws(() => x.wal.beginEarningsWrite(id), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && error.gate === undefined);
  assert.equal(x.calls.length, 0, 'the restore proof is never consulted for a digest mismatch');
  assert.equal(JSON.parse(fs.readFileSync(x.walFile(id))).accrualFence.state, 'not_started');
});
test('equal bytes on a new inode consult the restore proof with the exact inputs; an accepted proof rewrites only the fence state (F2)', t => {
  const x = fixture(t), id = x.create(), before = fs.readFileSync(x.walFile(id));
  x.moveInode();
  const cap = x.wal.beginEarningsWrite(id);
  assert.ok(cap);
  assert.equal(x.calls.length, 1);
  const input = x.calls[0], entry = JSON.parse(before);
  assert.equal(input.entry.id, id);
  assert.deepEqual(input.walBytes, before);
  assert.deepEqual(input.fence, entry.accrualFence);
  assert.equal(input.spend.id, 'spend');
  assert.equal(input.epoch, x.runtime.epoch);
  assert.equal(input.writer, x.runtime.writer);
  assert.equal(input.root.id, 'capacity:root');
  assert.equal(input.actual.sha256, entry.accrualFence.earningsBeforeDigest);
  assert.equal(input.actual.bytes, fs.statSync(x.files.earnings).size);
  assert.equal(input.actual.ino, fs.statSync(x.files.earnings).ino);
  assert.equal(input.failure.state, 'failure_pending');
  const after = JSON.parse(fs.readFileSync(x.walFile(id)));
  assert.deepEqual({ ...after, accrualFence: { ...after.accrualFence, state: 'not_started' } }, entry, 'only the fence state changed');
  assert.equal(after.accrualFence.state, 'write_started');
  assert.throws(() => x.wal.beginEarningsWrite(id), code('COMPENSATION_ACCRUAL_CONFLICT'), 'single use');
});
for (const check of ['NO_RESTORE_BINDING', 'RECORD_ABSENT', 'LINEAGE', 'ENTRY_MISSING', 'ENTRY_DUPLICATE', 'WAL_FILE', 'FENCE', 'SPEND', 'DRAW_VECTOR', 'EARNINGS_DIGEST', 'TARGET_IDENTITY', 'FAILURE_STATE']) {
  test('a refused proof (' + check + ') is COMPENSATION_ACCRUAL_CONFLICT with non-enumerable gate and check, and changes nothing', t => {
    const x = fixture(t, { assertContinuation: () => { throw Object.assign(Error('COMPENSATION_ACCRUAL_CONFLICT'), { code: 'COMPENSATION_ACCRUAL_CONFLICT', check }); } });
    const id = x.create(), before = fs.readFileSync(x.walFile(id));
    x.moveInode();
    assert.throws(() => x.wal.beginEarningsWrite(id), error => {
      assert.equal(error.code, 'COMPENSATION_ACCRUAL_CONFLICT');
      assert.equal(error.gate, 'CONTINUATION_AUTHORITY');
      assert.equal(error.check, check);
      assert.deepEqual(Object.keys(error), ['code'], 'gate/check/walId/spendId are not enumerable');
      assert.equal(JSON.stringify(error), '{"code":"COMPENSATION_ACCRUAL_CONFLICT"}');
      assert.equal(error.walId, id);
      assert.equal(error.spendId, 'spend');
      return true;
    });
    assert.deepEqual(fs.readFileSync(x.walFile(id)), before, 'the fence is not rewritten');
  });
}
test('C3-D2 shape: no restore binding refuses with the same code and a NO_RESTORE_BINDING check', t => {
  const x = fixture(t, { assertContinuation: () => { throw Object.assign(Error('COMPENSATION_ACCRUAL_CONFLICT'), { code: 'COMPENSATION_ACCRUAL_CONFLICT', check: 'NO_RESTORE_BINDING' }); } });
  x.setRoot({ id: 'capacity:root' });
  const id = x.create();
  x.moveInode();
  assert.throws(() => x.wal.beginEarningsWrite(id), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && error.check === 'NO_RESTORE_BINDING');
  assert.equal(x.calls[0].root.restoreBinding, undefined);
});
test('failures before the proof (debit receipt, draw vector, WAL changed between reads) still surface as the same code with a closed-enum check', t => {
  let x = fixture(t), id = x.create();
  x.moveInode();
  fs.writeFileSync(x.files.credits, JSON.stringify({ buyer: { money_receipts: {}, dollar_lots: [] } }));
  assert.throws(() => x.wal.beginEarningsWrite(id), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && error.check === 'SPEND' && error.gate === 'CONTINUATION_AUTHORITY');
  x = fixture(t); id = x.create(); x.moveInode();
  x.runtime.store.getSpend = () => { const s = structuredClone(x.spend); s.intent.participantDraws[0].amountMicros = 1; s.digest = p.digestJSON(s.intent); return s; };
  fs.writeFileSync(x.files.credits, JSON.stringify({ buyer: { money_receipts: { spend: { projection_id: 'spend', digest: p.digestJSON({ ...x.spend.intent, participantDraws: [{ ...x.spend.intent.participantDraws[0], amountMicros: 1 }] }) } } } }));
  assert.throws(() => x.wal.beginEarningsWrite(id), error => error.code === 'COMPENSATION_ACCRUAL_CONFLICT' && ['DRAW_VECTOR', 'SPEND'].includes(error.check));
  assert.equal(x.calls.length, 0);
});
test('entry limit: a second not_started obligation is refused BEFORE the pre-WAL capability is invalidated (v3 3.3, 6.10)', t => {
  const x = fixture(t), first = x.create();
  const phase = x.wal.createPreWalPhase({ spendId: 'spend' });
  assert.throws(() => x.wal.createWalEntry('unlock', { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: x.draws }, { preWalCapability: phase }), code('CONTINUATION_OBLIGATION_LIMIT'));
  assert.deepEqual(x.wal.getPendingWalEntries().map(e => e.id), [first], 'no second WAL is created');
  // The exact fallback keeps working: the same capability still verifies compensation authority.
  const proof = x.wal.verifyCompensationAuthority({ spend: x.spend, preWalCapability: phase });
  assert.equal(proof.walId, null);
  fs.rmSync(x.walFile(first));
  assert.doesNotThrow(() => x.wal.createWalEntry('unlock', { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: x.draws }, { preWalCapability: phase }), 'the capability was never spent');
});
test('entry limit counts only pending not_started fences: write_started, unfenced and canceled WALs do not count', t => {
  for (const patch of [e => { e.accrualFence.state = 'write_started'; }, e => { delete e.accrualFence; }]) {
    const x = fixture(t), id = x.create(), entry = JSON.parse(fs.readFileSync(x.walFile(id)));
    patch(entry); fs.writeFileSync(x.walFile(id), JSON.stringify(entry));
    assert.doesNotThrow(() => x.create());
  }
  const x = fixture(t), id = x.create();
  fs.renameSync(x.walFile(id), x.walFile(id).replace(/\.wal\.json$/, '.compensation.json'));
  assert.doesNotThrow(() => x.create(), 'a canceled compensation WAL is not an open obligation');
});
test('entry limit: a symlinked or hard-linked WAL file fails closed', t => {
  const x = fixture(t), id = x.create();
  fs.linkSync(x.walFile(id), path.join(x.files.wal, 'extra.wal.json'));
  assert.throws(() => x.wal.createWalEntry('unlock', { funding_source: 'credit_pack', purchaser_account_id: 'buyer', dollar_draws: x.draws }, { preWalCapability: x.wal.createPreWalPhase({ spendId: 'spend' }) }), code('COMPENSATION_WAL_AUTHORITY_REQUIRED'));
});
test('inspectEarningsContinuation is read-only and re-derives the failed check from durable state', t => {
  const x = fixture(t), id = x.create(), snapshot = () => ({ wal: fs.readFileSync(x.walFile(id)), earnings: fs.readFileSync(x.files.earnings), list: fs.readdirSync(x.files.wal).sort() });
  const before = snapshot();
  assert.deepEqual(x.wal.inspectEarningsContinuation(id), { walId: id, spendId: 'spend', ok: true, check: null, mode: 'live_identity' });
  x.moveInode();
  assert.deepEqual(x.wal.inspectEarningsContinuation(id), { walId: id, spendId: 'spend', ok: true, check: null, mode: 'restored_continuation' });
  x.restore.assertRestoredContinuationIdentity = () => { throw Object.assign(Error('X'), { code: 'COMPENSATION_ACCRUAL_CONFLICT', check: 'TARGET_IDENTITY' }); };
  assert.deepEqual(x.wal.inspectEarningsContinuation(id), { walId: id, spendId: 'spend', ok: false, check: 'TARGET_IDENTITY', mode: null });
  fs.writeFileSync(x.files.earnings, '{"changed":true}');
  assert.equal(x.wal.inspectEarningsContinuation(id).check, 'EARNINGS_DIGEST');
  fs.writeFileSync(x.files.earnings, '{}');
  const after = snapshot();
  assert.deepEqual(after.wal, before.wal);
  assert.deepEqual(after.list, before.list);
  const entry = JSON.parse(before.wal); entry.accrualFence.state = 'write_started'; fs.writeFileSync(x.walFile(id), JSON.stringify(entry));
  assert.equal(x.wal.inspectEarningsContinuation(id).check, 'FENCE');
});

test('a planted not_started WAL that names no real spend cannot be resolved as a recovery anchor, so the post-compensation scan of the exact fallback cannot go idle (6.10b: 503 with the refund done)', t => {
  const x = fixture(t), planted = { id: 'planted_open_1', operation: 'unlock', payload: { funding_source: 'credit_pack' }, accrualFence: { schema: 1, state: 'not_started', spendId: 'spend_planted', spendDigest: '0'.repeat(64), earningsBeforeDigest: '1'.repeat(64), earningsFileIdentity: { dev: 1, ino: 2 } }, steps_completed: ['update_learnings'], created_at: 1 };
  fs.writeFileSync(path.join(x.files.wal, 'planted_open_1.wal.json'), JSON.stringify(planted), { mode: 0o600 });
  assert.deepEqual(x.wal.scanRecoveryWals({ limit: 10 }).items.map(i => i.id), ['planted_open_1'], 'the scan lists it');
  assert.throws(() => x.wal.readRecoveryProof('planted_open_1', { store: { getSpend: () => undefined, getSourceByLot: () => ({ id: 's' }) }, epoch: x.runtime.epoch }), error => /AUTHORITY|SPEND_RECEIPT_REQUIRED/.test(error.code), 'the anchor cannot be read');
});
