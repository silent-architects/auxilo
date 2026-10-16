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

// ---- amendment: every handler failure is a complete reply, the busy flag always resets, and the socket stays usable -------------
function rig(t, { provider, lease } = {}) {
  const x = syntheticEpoch(t), writer = lock.injectMoneyWriter({ root: x.root, assertOwned: () => true }), state = { provider: provider || (() => undefined), lease: lease || (() => { throw Error('lease not expected'); }) };
  const server = cp.startMoneyCheckpointServer({ epoch: { legacy_root: x.root }, writer, coordinator: { maintenanceLease: fn => state.lease(fn) }, sourceSha: 'a'.repeat(40), lifecycleControl: () => state.provider() });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const stderr = [], realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = chunk => { stderr.push(String(chunk)); return true; };
  t.after(() => { process.stderr.write = realWrite; });
  return { x, state, stderr, ready: new Promise(resolve => server.once('listening', resolve)), request: id => ask(x.root, JSON.stringify({ op: 'checkpoint', request_id: id })) };
}
const good = { schema_version: 1, rule_version: 'synthetic', approval_ref: 'synthetic', deletion_barrier: { sequence: 0, hash: 'a'.repeat(64) }, seals: [], records: [], holds: [] };
const complete = reply => { assert.notEqual(reply, '', 'a reply, never a silent close'); assert.equal(reply.endsWith('\n'), true, 'newline-terminated'); assert.equal(reply.indexOf('\n'), reply.length - 1, 'exactly one line'); return JSON.parse(reply); };

test('a synchronous lifecycle-provider throw is a complete error reply, the busy flag resets, the diagnostic names the exception, and the socket stays usable', async t => {
  const r = rig(t), before = fs.readFileSync(r.x.controlFile);
  await r.ready;
  r.state.provider = () => { throw Object.assign(new Error('provider exploded: blank lifecycle'), { code: 'EMPTY_FINANCIAL_PRIMARY' }); };
  assert.deepEqual(complete(await r.request('sync-1')), { error: 'EMPTY_FINANCIAL_PRIMARY' });
  const line = r.stderr.find(l => l.startsWith('CHECKPOINT_SOCKET_ERROR '));
  assert.ok(line, 'the handler writes the exception to stderr before closing');
  const detail = JSON.parse(line.slice('CHECKPOINT_SOCKET_ERROR '.length));
  assert.equal(detail.code, 'EMPTY_FINANCIAL_PRIMARY');
  assert.equal(detail.message, 'provider exploded: blank lifecycle');
  assert.match(detail.stack, /provider exploded/);
  assert.ok(detail.stack.length <= 2000, 'bounded');
  r.state.provider = () => { throw new Error('no code on this one'); };
  assert.deepEqual(complete(await r.request('sync-2')), { error: 'CHECKPOINT_FAILED' }, 'an error without a code keeps the existing mapping');
  r.state.provider = () => undefined;
  assert.deepEqual(complete(await r.request('after-1')), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' }, 'not CHECKPOINT_BUSY: the flag was reset');
  assert.deepEqual(complete(await ask(r.x.root, JSON.stringify({ op: 'checkpoint', request_id: 'x', retire: true }))), { error: 'CHECKPOINT_REQUEST_INVALID' }, 'existing request validation is unchanged');
  assert.deepEqual(fs.readFileSync(r.x.controlFile), before, 'source control bytes unchanged');
});
test('an asynchronous checkpoint rejection is the same complete reply and leaves the socket usable', async t => {
  const r = rig(t, { provider: () => good }), before = fs.readFileSync(r.x.controlFile);
  await r.ready;
  r.state.lease = () => Promise.reject(Object.assign(new Error('maintenance lease refused'), { code: 'MAINTENANCE_REFUSED' }));
  assert.deepEqual(complete(await r.request('async-1')), { error: 'MAINTENANCE_REFUSED' });
  assert.match(r.stderr.join(''), /CHECKPOINT_SOCKET_ERROR .*MAINTENANCE_REFUSED/);
  r.state.lease = () => Promise.reject(new Error('uncoded'));
  assert.deepEqual(complete(await r.request('async-2')), { error: 'CHECKPOINT_FAILED' });
  r.state.provider = () => undefined;
  assert.deepEqual(complete(await r.request('after-2')), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' });
  assert.deepEqual(fs.readFileSync(r.x.controlFile), before);
  assert.equal(fs.existsSync(path.join(r.x.root, '.money-checkpoints')), false, 'no checkpoint was published by any failed request');
});
test('a result that cannot be serialized does not escape the handler either: complete error reply and the flag resets', async t => {
  const r = rig(t, { provider: () => good });
  await r.ready;
  r.state.lease = () => { const loop = {}; loop.self = loop; return loop; };
  const first = complete(await r.request('ser-1'));
  assert.equal(typeof first.error, 'string');
  r.state.provider = () => undefined;
  assert.deepEqual(complete(await r.request('after-3')), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' });
});
test('concurrent requests are still refused with CHECKPOINT_BUSY, and the flag resets after the held request fails', async t => {
  const r = rig(t, { provider: () => good });
  await r.ready;
  let release; r.state.lease = () => new Promise((_, reject) => { release = () => reject(Object.assign(new Error('held then failed'), { code: 'HELD_FAILED' })); });
  const held = r.request('held');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(complete(await r.request('second')), { error: 'CHECKPOINT_BUSY' });
  release();
  assert.deepEqual(complete(await held), { error: 'HELD_FAILED' });
  r.state.provider = () => undefined;
  assert.deepEqual(complete(await r.request('third')), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' });
});

// ---- the staged server's own lifecycle provider (server.js currentLifecycleControl), extracted verbatim and run with a real lifecycle file ----------
// The provider used a bare readJSONStrict that server.js never binds (ReferenceError, code-less, CHECKPOINT_FAILED). It must read through
// lib/stripe-transfer-persistence exactly as server.js loadDataFile does. No production behaviour is exercised beyond that one read.
function serverProvider(file) {
  const vm = require('node:vm'), { createRequire } = require('node:module'), serverFile = path.join(__dirname, '..', 'server.js');
  const source = fs.readFileSync(serverFile, 'utf8'), match = source.match(/function currentLifecycleControl\(\) \{\n[\s\S]*?\n\}\n/);
  assert.ok(match, 'server.js defines currentLifecycleControl');
  const sandbox = { prospectiveEpoch: { epoch_id: 'fresh-1' }, financialEpoch: { pathFor: (name, epoch) => { assert.equal(name, 'lifecycle'); assert.equal(epoch.epoch_id, 'fresh-1'); return file; } }, require: createRequire(serverFile) };
  vm.runInNewContext(match[0] + '\nthis.provider = currentLifecycleControl;', sandbox);
  return sandbox.provider;
}
test('server.js lifecycle provider is bound: no authoritative control is a complete AUTHORITATIVE_LIFECYCLE_REQUIRED reply, a laid-down one is returned and valid', async t => {
  const persistence = require('../lib/stripe-transfer-persistence'), x = syntheticEpoch(t), file = path.join(x.root, 'financial-lifecycle.json');
  fs.writeFileSync(file, JSON.stringify({ binding_digest: 'b'.repeat(64), blocked_accounts: {}, conflicts: {}, epoch_id: 'fresh-1', schema_version: 1 }) + '\n');
  const provider = serverProvider(file);
  assert.doesNotThrow(() => provider(), 'the provider reads the lifecycle file; it must not throw a ReferenceError');
  assert.equal(provider(), undefined, 'the empty fixture has no authoritative_control');
  const r = rig(t, { provider });
  await r.ready;
  assert.deepEqual(complete(await r.request('bound-1')), { error: 'AUTHORITATIVE_LIFECYCLE_REQUIRED' });
  const line = r.stderr.find(l => l.startsWith('CHECKPOINT_SOCKET_ERROR '));
  assert.equal(JSON.parse(line.slice('CHECKPOINT_SOCKET_ERROR '.length)).code, 'AUTHORITATIVE_LIFECYCLE_REQUIRED');
  // The shape production writes (lib/financial-epoch-operator.js transitionEpoch): state.authoritative_control = the lifecycle evidence.
  const state = persistence.readJSONStrict(file); state.authoritative_control = structuredClone(good); persistence.writeJSONAtomic(file, state);
  assert.deepEqual(provider(), good);
  assert.doesNotThrow(() => require('../lib/money-lifecycle').validateLifecycleControl(provider()));
});
