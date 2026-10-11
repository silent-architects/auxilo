'use strict';
// Closure item 5 finding, reproduced without a server: the REAL checkpoint socket handler (lib/money-checkpoint.js startMoneyCheckpointServer) answers a
// request whose lifecycle record is EMPTY with a COMPLETE error reply, AUTHORITATIVE_LIFECYCLE_REQUIRED (lib/money-lifecycle.js validateLifecycleControl via
// createCheckpoint's assertLifecycleForCheckpoint). It does not close the socket and it never reports success: a checkpoint needs an authoritative lifecycle.
// The one path that DOES close the connection with no reply is a lifecycleControl() provider that throws synchronously inside the 'data' handler
// (server.js currentLifecycleControl -> readJSONStrict on a missing or blank lifecycle participant); the fixture's lifecycle participant is a populated
// object with no authoritative_control, so it takes the complete-error path.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), net = require('node:net'), path = require('node:path');
const cp = require('../lib/money-checkpoint'), lock = require('../lib/money-writer-lock');
const { syntheticEpoch } = require('./helpers/money-synthetic-epoch');
function ask(root, body) {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(path.join(root, '.money-control.sock')); let out = '';
    c.setTimeout(5000, () => c.destroy(new Error('SOCKET_TIMEOUT')));
    c.on('connect', () => c.write(body + '\n')); c.on('data', d => { out += d; }); c.on('end', () => resolve(out)); c.on('error', reject);
  });
}
test('empty lifecycle record: a complete AUTHORITATIVE_LIFECYCLE_REQUIRED reply, never an empty close and never a success; the strict key set refuses retire', async t => {
  const x = syntheticEpoch(t), writer = lock.injectMoneyWriter({ root: x.root, assertOwned: () => true });
  let maintenance = 0;
  const server = cp.startMoneyCheckpointServer({ epoch: { legacy_root: x.root }, writer, coordinator: { maintenanceLease: fn => { maintenance++; return fn({ store: {} }); } }, sourceSha: 'a'.repeat(40), lifecycleControl: () => undefined });
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const reply = await ask(x.root, JSON.stringify({ op: 'checkpoint', request_id: 'empty' }));
  assert.notEqual(reply, '', 'the handler must not close without a reply');
  assert.equal(reply.endsWith('\n'), true, 'a complete line');
  assert.deepEqual(JSON.parse(reply), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' });
  assert.equal(maintenance, 0, 'refused before any maintenance lease or write');
  assert.deepEqual(JSON.parse(await ask(x.root, JSON.stringify({ op: 'checkpoint', request_id: 'r1', retire: true }))), { error: 'CHECKPOINT_REQUEST_INVALID' });
  assert.deepEqual(JSON.parse(await ask(x.root, JSON.stringify({ op: 'retire', request_id: 'r2' }))), { error: 'CHECKPOINT_REQUEST_INVALID' });
  assert.equal(fs.existsSync(path.join(x.root, '.money-checkpoints')), false, 'no checkpoint directory was created');
  assert.equal(JSON.parse(fs.readFileSync(x.controlFile)).retirement, undefined);
});
