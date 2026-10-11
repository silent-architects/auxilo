'use strict';
// TEST-ONLY native fixture for EMFR A2 authenticated continuation (Linux, owned diagnostic volume, one fixture at a time).
// It builds on the stamped admitted-restore fixture WITHOUT editing it: the same typed six-cent funding, the same exact
// crash after update_learnings, the same physical restore, but with explicit control over retirement, the claim, crash
// cuts and the target boot. Nothing here grants production authority; every value is synthetic.
//
// Every state-changing step runs in a short-lived child process (a real process, a real flock), exactly as an operator
// would run it, and returns JSON. A child that is asked to crash exits with status 79 at the named afterStep hook.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), { spawn, spawnSync } = require('node:child_process');
const admitted = require('./money-admitted-restore-fixture'), { stageServer, reservePort, bootServer, stopServer } = require('./staged-server');
const ROOT = path.resolve(__dirname, '..', '..'), SELF = __filename, ADMITTED = path.join(__dirname, 'money-admitted-restore-fixture.js'), MiB = 1048576;
const LIFECYCLE = Object.freeze({ schema_version: 1, rule_version: 'a2-native-v1', approval_ref: 'synthetic', deletion_barrier: { sequence: 0, hash: 'a'.repeat(64) }, seals: [], records: [], holds: [] });
const CRASH_EXIT = 79, SKIP = process.platform !== 'linux' ? 'requires patched Linux runtime and owned diagnostic volume' : false;
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---- child-process workers ---------------------------------------------------------------------------------------
function run(file, env, timeout = 90000) {
  const result = spawnSync(process.execPath, [file], { env: { ...process.env, NODE_TEST_CONTEXT: 'a2-native', ...env }, encoding: 'utf8', timeout, maxBuffer: 4 * MiB });
  const ok = result.stdout.split('\n').find(x => x.startsWith('A2_RESULT ')), bad = result.stdout.split('\n').find(x => x.startsWith('A2_ERROR '));
  return { status: result.status, crashed: result.status === CRASH_EXIT, result: ok ? JSON.parse(ok.slice(10)) : undefined, error: bad ? JSON.parse(bad.slice(9)) : undefined, stdout: result.stdout, stderr: result.stderr };
}
const worker = (request, timeout) => run(SELF, { EMFR_A2_WORKER: JSON.stringify(request) }, timeout);
// A real concurrent child (for the two-target race): resolves with the same shape as worker().
function workerAsync(request, timeout = 90000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SELF], { env: { ...process.env, NODE_TEST_CONTEXT: 'a2-native', EMFR_A2_WORKER: JSON.stringify(request) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout); timer.unref();
    child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('close', status => { clearTimeout(timer); const ok = stdout.split('\n').find(x => x.startsWith('A2_RESULT ')), bad = stdout.split('\n').find(x => x.startsWith('A2_ERROR ')); resolve({ status, crashed: status === CRASH_EXIT, result: ok ? JSON.parse(ok.slice(10)) : undefined, error: bad ? JSON.parse(bad.slice(9)) : undefined, stdout, stderr }); });
  });
}
function workerOk(request, timeout) {
  const r = worker(request, timeout);
  assert.equal(r.status, 0, request.mode + ' failed\n' + r.stdout + r.stderr);
  return r.result;
}
// The stamped helper's own worker (setup, snapshot) is reused untouched.
function admittedWorker(request) {
  const r = spawnSync(process.execPath, [ADMITTED], { env: { ...process.env, NODE_TEST_CONTEXT: 'admitted-restore-characterization', EMFR_ADMITTED_PROBE_WORKER: JSON.stringify(request) }, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * MiB });
  assert.equal(r.status, 0, 'admitted worker ' + request.mode + ' failed\n' + r.stdout + r.stderr);
  const line = r.stdout.split('\n').find(x => x.startsWith('ADMITTED_RESULT '));
  return line ? JSON.parse(line.slice(16)) : undefined;
}
const snapshot = (root, walId) => withRawFailure(root, () => admittedWorker({ mode: 'snapshot', root, walId }));

// ---- the crash server (copied from the stamped F-WAL test so both crash at the same exact point) -------------------
async function stage(box, name, root, { crash = false } = {}) {
  const { port } = await reservePort();
  assert.ok(port, 'native loopback required');
  const directory = path.join(box, name), marker = "  markStepComplete(walId, 'update_learnings');", search = marker + "\n\n  if(prospectiveMoney?.failureControl && fundingSource==='credit_pack'){";
  stageServer({
    repoRoot: ROOT, tmpDir: directory, nodeModulesDir: path.join(ROOT, 'node_modules'), port, rootFiles: ['server.js', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'], linkDirs: ['public', 'prompts'], copyDirs: ['lib', 'config'],
    replacements: crash ? [{ name: 'exact paid unlock after update_learnings crash', search, replace: search.replace(marker, marker + "\n  process.stderr.write('F_WAL_FAULT_HIT '+walId+'\\n'); process.exit(73);") }] : []
  });
  fs.writeFileSync(path.join(directory, 'deny-network.cjs'), "const deny=()=>{throw Error('SYNTHETIC_NETWORK_DENIED')};require('http').request=deny;require('https').request=deny;global.fetch=deny;\n", { mode: 0o600 });
  return { directory, port, env: { HOME: directory, AUXILO_HOME: directory, AUXILO_DATA_DIR: root, AUXILO_WAL_DIR: '', AUXILO_SQLITE_TMPDIR: path.join(root, 'sqlite-runtime-temp'), NODE_ENV: 'test', NODE_OPTIONS: '--require=' + path.join(directory, 'deny-network.cjs'), SESSION_SECRET: 'synthetic-only-'.repeat(5), WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32), LLM_SENSITIVITY_ENABLED: 'false', PAYMENTS_ENABLED: 'true', AUXILO_RUNNER_AUTOUPDATE: '0' } };
}
const boot = s => bootServer({ tmpDir: s.directory, port: s.port, env: s.env, timeoutMs: 15000, maxAttempts: 1 });
// One cold start of the target: booted with /health, or refused with the server output (which carries the gate line).
async function coldBoot(box, root, name) {
  const s = await stage(box, name, root);
  try {
    const started = await boot(s), response = await fetch('http://127.0.0.1:' + s.port + '/health'), health = await response.json();
    await stopServer(started.child);
    return { booted: true, health, output: started.getOutput?.() || started.output };
  } catch (error) {
    return { booted: false, error: error.message, output: error.output || String(error) };
  }
}

// ---- the fixture: an owned source with the admitted unlock crashed exactly after update_learnings ---------------------
async function crashedSource(t) {
  const owned = admitted.ownership();
  assert.deepEqual(fs.readdirSync(owned.root).sort(), ['.probe-owner', 'lost+found'].sort(), 'one fixture at a time');
  const box = fs.mkdtempSync(path.join(owned.root, 'a2-native-')), locator = path.join(box, 'locator.json'), extra = [];
  let child;
  t.after(async () => {
    await stopServer(child);
    if (fs.existsSync(locator)) {
      const located = json(locator);
      for (const file of [located.root, located.target, ...extra]) if (file) { assert.ok(path.dirname(file) === owned.root && path.basename(file).startsWith('epoch-foundation-')); fs.rmSync(file, { recursive: true, force: true }); }
    }
    fs.rmSync(box, { recursive: true, force: true });
  });
  admittedWorker({ mode: 'setup', locator });
  const located = json(locator), initial = snapshot(located.root);
  const crashStage = await stage(box, 'crash-server', located.root, { crash: true }), running = await boot(crashStage);
  child = running.child;
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  try { await fetch('http://127.0.0.1:' + crashStage.port + '/knowledge/' + admitted.LEARNING_ID, { headers: { 'X-API-Key': admitted.API_KEY }, signal: AbortSignal.timeout(10000) }); } catch {}
  const crash = await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(() => resolve({ timeout: true }), 10000); timer.unref(); })]);
  assert.equal(crash.code, 73, JSON.stringify(crash) + running.getOutput?.());
  child = null;
  const retained = snapshot(located.root);
  assert.equal(retained.wals.length, 1);
  assert.equal(retained.wals[0].accrualFence.state, 'not_started');
  assert.equal(retained.earningsDigest, initial.earningsDigest);
  return {
    owned, box, locator, located, retained, wal: retained.wals[0], spend: retained.spends[0], root: located.root,
    // a sibling target path inside the owned volume, cleaned with the fixture
    // The owned volume holds about four estates: drop a target as soon as its assertions are done.
    drop(file) { assert.ok(path.dirname(file) === owned.root && path.basename(file).startsWith('epoch-foundation-')); fs.rmSync(file, { recursive: true, force: true }); },
    targetPath(tag) { const file = tag === 'main' ? located.target : located.root + '-' + tag; if (tag !== 'main') extra.push(file); return file; },
    retire: (options = {}) => workerOk({ mode: 'retire', root: located.root, ...options }),
    retireRaw: (options = {}) => worker({ mode: 'retire', root: located.root, ...options }),
    restore: (options = {}) => workerOk({ mode: 'restore', root: located.root, ...options }),
    restoreRaw: (options = {}) => worker({ mode: 'restore', root: located.root, ...options }),
    snapshot: (root, walId) => snapshot(root, walId ?? retained.wals[0].id),
    control: root => workerOk({ mode: 'control', root }),
    coldBoot: (root, name) => coldBoot(box, root, name),
    stage: (root, name, options) => stage(box, name, root, options)
  };
}

// ---- worker side ---------------------------------------------------------------------------------------------------
function openSource(root) {
  process.env.AUXILO_DATA_DIR = root;
  process.env.AUXILO_SQLITE_TMPDIR = path.join(root, 'sqlite-runtime-temp');
  const e = require('../../lib/financial-epoch'), writer = require('../../lib/money-writer-lock').acquireMoneyWriter({ root });
  try { const epoch = e.resolveRuntimeEpoch({ root, writer }), money = require('../../lib/money-control').initializeMoneyRuntime({ epoch, writer }); return { epoch, money, writer }; } catch (error) { writer.close(); throw error; }
}
const hook = crashAfter => name => { if (crashAfter && name === crashAfter) process.exit(CRASH_EXIT); };
async function retire({ root, approvalRef = 'approval:a2-retire', via = 'live', crashAfter }) {
  const cp = require('../../lib/money-checkpoint');
  if (via === 'tool') {
    const input = path.join(path.dirname(root), path.basename(root) + '-retire-' + process.pid + '.json');
    fs.writeFileSync(input, JSON.stringify({ approval_ref: approvalRef, source_sha: 'a'.repeat(40), lifecycleControl: LIFECYCLE }), { mode: 0o600 });
    try { return await require('../../scripts/money-checkpoint').main([root, 'retire', input]); } finally { fs.rmSync(input, { force: true }); }
  }
  if (via === 'ordinary') {
    const f = openSource(root);
    try { const cut = await cp.createMoneyCheckpoint({ epoch: f.epoch, writer: f.writer, coordinator: f.money, sourceSha: 'a'.repeat(40), lifecycleControl: LIFECYCLE }); return { ...cut, directory: cp.checkpointDirectory(root, cut.checkpoint_id) }; } finally { f.money.store.close(); f.writer.close(); }
  }
  const f = openSource(root);
  try {
    const cut = await cp.createRetiringCheckpoint({ epoch: f.epoch, writer: f.writer, coordinator: f.money, sourceSha: 'a'.repeat(40), lifecycleControl: LIFECYCLE, approvalRef, afterStep: hook(crashAfter) });
    return { ...cut, directory: cp.checkpointDirectory(root, cut.checkpoint_id) };
  } finally { f.money.store.close(); f.writer.close(); }
}
// claim: 'source' passes the held source writer; 'none' offers no source at all.
// The request id derives from the barrier digest, so every restart of the SAME restore must pass the barrier digest of its first run:
// after completion the published barrier differs, and a request built from it is a different (foreign) restore of that target.
function allowanceFor({ target, manifest, digest, barrierDigest, tag }) {
  const api = require('../../lib/money-atomic-restore'), MiB = 1048576;
  const base = { schema: 1, checkpointDigest: digest, bindingDigest: manifest.binding_digest, profileDigest: manifest.atomic_capacity_cut.profileDigest, databaseSchema: 3, barrierDigest, permanentBoundBytes: 4 * MiB, publicationBoundBytes: MiB, maxGrowthPages: 64, maxNetOccupiedPages: 64, evidenceRef: 'SYNTHETIC A2 native: new free engineering bytes, not admission-funded recovery estate' };
  const executionApprovalRef = 'explicit-test-only-a2-' + tag;
  return { executionApprovalRef, restoreAllowance: { ...base, requestId: api.deriveRestoreRequestId({ targetRoot: target, executionApprovalRef, restoreAllowance: base }) } };
}
async function restore({ root, target, checkpointDir, digest, claim = 'source', claimRoot, crashAfter, tag = 'a2', onlyStage, resume = false, barrierDigest }) {
  const cp = require('../../lib/money-checkpoint'), api = require('../../lib/money-atomic-restore'), lock = require('../../lib/money-writer-lock'), p = require('../../lib/stripe-transfer-persistence');
  const manifest = cp.validateCheckpointEnvelope(checkpointDir);
  if (!resume) fs.mkdirSync(target, { mode: 0o700 });
  let targetWriter, sourceWriter;
  try {
    targetWriter = lock.acquireMoneyWriter({ root: target });
    // resume re-enters after the physical copy: the barrier, the allowance and therefore the restore id are unchanged.
    if (!resume) cp.restoreCheckpoint({ checkpointDir, targetRoot: target, writer: targetWriter, authoritativeLifecycle: LIFECYCLE, expectedCheckpointDigest: digest });
    if (onlyStage === true) return { staged: true };
    const barrier = p.readJSONStrict(path.join(target, cp.RESTORE));
    const { executionApprovalRef, restoreAllowance } = allowanceFor({ target, manifest, digest, barrierDigest: barrierDigest || barrier.checksum, tag });
    if (claim === 'source') sourceWriter = lock.acquireMoneyWriter({ root: claimRoot || root });
    const outcome = await cp.restoreCheckpointCapacity({
      targetRoot: target, writer: targetWriter, checkpointDir, expectedCheckpointDigest: digest, expectedBarrierDigest: barrierDigest || barrier.checksum, authoritativeLifecycle: LIFECYCLE, executionApprovalRef, restoreAllowance, afterStep: hook(crashAfter),
      ...(claim === 'source' ? { successorClaim: { sourceRoot: claimRoot || root, sourceWriter } } : {})
    });
    return { ...outcome, request: { barrierDigest: barrierDigest || barrier.checksum } };
  } finally { try { sourceWriter?.close(); } finally { targetWriter?.close(); } }
}
const SLOT = 65536;
// While a restore is initializing (or crashed before publishing) the live control is .stage-restore-control-<id>; the fixed file is
// then either absent or a PREDECESSOR copy. Once published, the fixed file is the control.
function activeRestoreControlFile(dir) {
  const staged = fs.readdirSync(dir).filter(n => n.startsWith('.stage-restore-control-')).sort();
  return staged.length ? path.join(dir, staged[0]) : path.join(dir, 'money-atomic-restore-control.bin');
}
function restoreControlSlots(dir) {
  const p = require('../../lib/stripe-transfer-persistence'), file = activeRestoreControlFile(dir);
  if (!fs.existsSync(file)) return { file, bytes: Buffer.alloc(0), rows: [] };
  const bytes = fs.readFileSync(file), rows = [];
  for (let i = 0; i < 2; i++) { const raw = bytes.subarray(i * SLOT, (i + 1) * SLOT), end = raw.indexOf(0); if (end < 1) continue; const { checksum, ...body } = JSON.parse(raw.subarray(0, end)); if (p.digestJSON(body) === checksum) rows.push({ index: i, body }); }
  rows.sort((a, b) => b.body.sequence - a.body.sequence);
  return { file, bytes, rows };
}
function readControls(root) {
  const e = require('../../lib/financial-epoch'), binding = JSON.parse(fs.readFileSync(path.join(root, e.BINDING_FILE))), dir = path.join(root, 'financial-epochs', binding.identity.epoch_id);
  const out = { control: JSON.parse(fs.readFileSync(path.join(dir, e.CONTROL_FILE))), financialDir: dir };
  { const top = restoreControlSlots(dir).rows[0]?.body; out.restore = top && { phase: top.phase, restoreId: top.restoreId, claim: top.claim ?? null, plan: top.plan, sequence: top.sequence, bodyBytes: JSON.stringify(top).length }; }
  const fc = path.join(dir, 'money-first-failure-control.bin');
  if (fs.existsSync(fc)) { const bytes = fs.readFileSync(fc), p = require('../../lib/stripe-transfer-persistence'); const rows = []; for (let i = 0; i < 2; i++) { const raw = bytes.subarray(i * 4096, (i + 1) * 4096), end = raw.indexOf(0); if (end < 1) continue; const { checksum, ...body } = JSON.parse(raw.subarray(0, end)); if (p.digestJSON(body) === checksum) rows.push(body); } rows.sort((a, b) => b.sequence - a.sequence); out.failure = rows[0] ?? null; }
  return out;
}
// The failure control as the SERVER left it: parsed from the raw file (2 x 4096 B slots, highest valid sequence, checksum verified).
// Opening a runtime starts a recovery scan (initializeMoneyRuntime -> beginRecoveryScan) and would overwrite an idle state.
function rawFailureControl(root) {
  const p = require('../../lib/stripe-transfer-persistence'), binding = JSON.parse(fs.readFileSync(path.join(root, 'financial-epoch.json'))), file = path.join(root, 'financial-epochs', binding.identity.epoch_id, 'money-first-failure-control.bin');
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file), rows = [];
  for (let i = 0; i < 2; i++) { const raw = bytes.subarray(i * 4096, (i + 1) * 4096), end = raw.indexOf(0); if (end < 1) continue; try { const { checksum, ...body } = JSON.parse(raw.subarray(0, end)); if (p.digestJSON(body) === checksum) rows.push(body); } catch {} }
  rows.sort((a, b) => b.sequence - a.sequence);
  return rows[0] ?? null;
}
// Reads the failure control BEFORE the snapshot function opens the runtime, then reports that state in the snapshot.
function withRawFailure(root, snapshotFn) {
  const failure = rawFailureControl(root), state = snapshotFn();
  return failure ? { ...state, failure } : state;
}
// Forge the highest restore-control slot with a VALID slot checksum. recompute=true also recomputes planDigest (so only the SQL binding can refuse it).
function forgePlan({ target, field, value, recompute = false }) {
  const p = require('../../lib/stripe-transfer-persistence'), e = require('../../lib/financial-epoch');
  const binding = JSON.parse(fs.readFileSync(path.join(target, e.BINDING_FILE))), dir = path.join(target, 'financial-epochs', binding.identity.epoch_id), slots = restoreControlSlots(dir), top = slots.rows[0];
  const plan = structuredClone(top.body.plan); const keys = field.replace(/^plan\./, '').split('.'); let at = plan; for (const k of keys.slice(0, -1)) at = at[k]; at[keys.at(-1)] = value;
  if (recompute) { const { planDigest, ...rest } = plan; plan.planDigest = p.digestJSON(rest); }
  const body = { ...top.body, plan }, encoded = Buffer.from(p.canonicalJSON({ ...body, checksum: p.digestJSON(body) })), padded = Buffer.alloc(SLOT);
  assert.ok(encoded.length < SLOT);
  encoded.copy(padded);
  const fd = fs.openSync(slots.file, 'r+'); try { fs.writeSync(fd, padded, 0, SLOT, top.index * SLOT); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return { forged: field };
}
// Replace a participant with an equal-byte copy on a new inode (the explicit negative input of C3-D2).
function swapInode(target, name) {
  const e = require('../../lib/financial-epoch'), binding = JSON.parse(fs.readFileSync(path.join(target, e.BINDING_FILE))), file = path.join(target, 'financial-epochs', binding.identity.epoch_id, name), bytes = fs.readFileSync(file), before = fs.statSync(file);
  fs.rmSync(file); fs.writeFileSync(file, bytes, { mode: 0o600 });
  const after = fs.statSync(file); assert.notEqual(after.ino, before.ino);
  return { name, before: before.ino, after: after.ino };
}
// Contexts a claimed or unclaimed successor must (not) enter. Returns the error code of each attempt, never throws.
async function contexts({ root, spendId }) {
  const f = openSource(root), out = {};
  try {
    const m = f.money;
    while (m.failureControl.status().state === 'recovery_scan') m.scanFailureRecoveryPageSync({ limit: 100 });
    const attempt = async (name, fn) => { try { await fn(); out[name] = { ok: true }; } catch (error) { out[name] = { code: error.code || error.message }; } };
    for (const kind of ['reconcile', 'funding', 'spend', 'buyer_return']) await attempt(kind, () => m.withMoneyControl({ kind }, () => 1));
    for (const action of ['persist_result', 'participant_effect', 'boot_recovery', 'compensate']) {
      // Name the held anchor at boot entry (as the server's own recovery does). Without it the failure control answers first, which is
      // correct and unrelated to the successor gate: a successor with an owed WAL legitimately holds failure_pending.
      const anchor = m.recoveryAnchors.resolveCommittedAnchor({ kind: 'spend', id: spendId, accountId: 'buyer' });
      await attempt('anchor_' + action, () => m.withMoneyBootControl({ recoveryAnchor: anchor, action }, ctx => { ctx.registerRecoveryAnchor(anchor, { action }); }));
    }
    out.failure = m.failureControl.statusDetail();
    return out;
  } finally { f.money.store.close(); f.writer.close(); }
}
// Two overlapping contexts on a drained runtime: the money lease must serialize them.
async function lease({ root }) {
  const f = openSource(root);
  try {
    const m = f.money; while (m.failureControl.status().state === 'recovery_scan') m.scanFailureRecoveryPageSync({ limit: 100 });
    const events = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), mark = (id, phase) => events.push({ id, phase, at: process.hrtime.bigint().toString() });
    const one = id => m.withMoneyControl({ kind: 'reconcile' }, async () => { mark(id, 'start'); await sleep(150); mark(id, 'end'); });
    await Promise.all([one('first'), one('second')]);
    return events;
  } finally { f.money.store.close(); f.writer.close(); }
}
// The checkpoint socket in-process, with a supplied lifecycle control (the staged server has no authoritative lifecycle record, and its
// socket handler would die reading one). Proves the socket op never retires and its strict key set refuses anything else.
async function socketCheckpoint({ root }) {
  const net = require('node:net'), cp = require('../../lib/money-checkpoint'), f = openSource(root);
  const server = cp.startMoneyCheckpointServer({ epoch: f.epoch, writer: f.writer, coordinator: f.money, sourceSha: 'a'.repeat(40), lifecycleControl: LIFECYCLE });
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const viaSocket = await cp.requestMoneyCheckpoint({ root });
    const raw = body => new Promise((resolve, reject) => { const c = net.createConnection(path.join(root, '.money-control.sock')); let out = ''; c.on('connect', () => c.write(body + '\n')); c.on('data', d => { out += d; }); c.on('end', () => resolve(JSON.parse(out))); c.on('error', reject); });
    const extra = await raw(JSON.stringify({ op: 'checkpoint', request_id: 'r1', retire: true, approvalRef: 'approval:socket' }));
    const wrongOp = await raw(JSON.stringify({ op: 'retire', request_id: 'r2' }));
    return { retired: Object.hasOwn(viaSocket.manifest, 'sourceRetirement'), completionGuaranteed: viaSocket.completion_guaranteed, extra, wrongOp };
  } finally { await new Promise(resolve => server.close(resolve)); f.money.store.close(); f.writer.close(); }
}
function transition({ root, patch }) {
  const lock = require('../../lib/money-writer-lock'), e = require('../../lib/financial-epoch'), op = require('../../lib/financial-epoch-operator'), writer = lock.acquireMoneyWriter({ root });
  try {
    const epoch = e.resolveRuntimeEpoch({ root, writer }), { control } = e.requireEpoch(epoch), evidence = { approval_ref: 'a2-native-transition' };
    for (const k of Object.keys(patch)) evidence[k] = 'f'.repeat(64);
    try { const next = op.transitionEpoch({ epoch, writer, expectedRevision: control.generation, patch, evidence }); return { ok: true, generation: next.activation_revision, capabilities: next.capabilities }; } catch (error) { return { code: error.code || error.message }; }
  } finally { writer.close(); }
}
// A corruption-style fixture, NOT a supported writer: the repository has no code that writes barrier state 'reconciled'.
function reconcileBarrier({ root }) {
  const e = require('../../lib/financial-epoch'), p = require('../../lib/stripe-transfer-persistence'), file = path.join(root, 'money-restore-barrier.json'), barrier = p.readJSONStrict(file);
  p.writeJSONAtomic(file, e.seal({ ...barrier, state: 'reconciled', capacity_recreation_required: false }));
  return { reconciled: true };
}
// Boot-time diagnostic: the one gate line the server prints before it exits.
const gateLine = output => (String(output).match(/\[money-recovery\] gate=CONTINUATION_AUTHORITY_REQUIRED[^\n]*/) || [])[0] || null;

if (require.main === module) {
  const r = JSON.parse(process.env.EMFR_A2_WORKER);
  const modes = { retire, restore, socket: socketCheckpoint, contexts, lease, transition, 'reconcile-barrier': reconcileBarrier, control: ({ root }) => readControls(root), forge: forgePlan, swap: ({ target, name }) => swapInode(target, name) };
  Promise.resolve().then(() => (modes[r.mode] || (() => assert.fail('unknown worker mode ' + r.mode)))(r)).then(value => { process.stdout.write('A2_RESULT ' + JSON.stringify(value ?? null) + '\n'); }).catch(error => { process.stdout.write('A2_ERROR ' + JSON.stringify({ code: error.code, message: error.message, check: error.check }) + '\n'); process.exitCode = 2; });
}
module.exports = { forgePlan, allowanceFor, readControls, restoreControlSlots, rawFailureControl, withRawFailure, SKIP, LIFECYCLE, CRASH_EXIT, MiB, crashedSource, coldBoot, stage, boot, snapshot, worker, workerAsync, workerOk, admittedWorker, run, gateLine, json, admitted, stopServer };

// ---- shared assertions ----------------------------------------------------------------------------------------------
// The owed unlock completed exactly once (the stamped F-WAL positive assertions, restated for any restored target).
function assertRealizedOnce(final, retained) {
  const { spend } = { spend: retained.spends[0] };
  assert.equal(final.wals.length, 0, 'original paid unlock must reach terminal realization');
  assert.equal(final.failure.state, 'idle', 'idle requires actual terminal proof');
  assert.equal(final.pools.length, 1);
  assert.equal(final.pools[0].platformShareMicros, 15000);
  assert.equal(final.pools[0].contributorShareMicros, 35000);
  assert.equal(final.source.spentMicros, 50000);
  assert.equal(final.source.retiredMicros, 0);
  assert.equal(final.credits.buyer.dollar_lots[0].remaining_usd, 0.01);
  assert.deepEqual(final.spends[0].intent, spend.intent);
  assert.notEqual(final.spends[0].state, 'returned');
  assert.equal(final.earnings.maker.total_gross, 0.05);
  assert.equal(final.earnings.maker.total_contributor, 0.035);
  assert.equal(final.earnings.maker.total_platform, 0.015);
  assert.equal(final.earnings.maker.by_learning[admitted.LEARNING_ID].unlocks, 1);
}
// The owed unlock never realized and nothing was manufactured: the WAL is still not_started and no pool exists.
function assertHeldUnrealized(state, retained) {
  assert.equal(state.wals.length, 1);
  assert.equal(state.wals[0].accrualFence.state, 'not_started');
  assert.deepEqual(state.wals[0], retained.wals[0], 'the immutable WAL and fence are byte-for-byte unchanged');
  assert.equal(state.pools.length, 0);
  assert.equal(state.earningsDigest, retained.earningsDigest, 'no earnings were written');
  assert.notEqual(state.failure.state, 'compensation_requested');
  assert.equal(state.credits.buyer.dollar_lots[0].remaining_usd, 0.01);
  assert.equal(state.spends[0].state, 'acknowledged');
}
const withoutIdentity = state => { const { earningsIdentity, metadata, failure, ...rest } = state; return rest; };
Object.assign(module.exports, { assertRealizedOnce, assertHeldUnrealized, withoutIdentity });
