'use strict';

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, jobIdFor, hash } = require('../scripts/providers/route-binding.js');

const ID = { source: 'claude-code', sessionId: 'fixture-session', jobSha: hash('fixture transcript') };
const ROUTE = { route: 'claude-code', origin: 'auto', billingMode: 'cli-login', destinationFingerprint: null,
  cliFingerprint: hash('/fixture/claude'), cliVersion: '2.1.41' };
const dead = () => { throw Object.assign(new Error('fixture'), { code: 'ESRCH' }); };
const generation = file => /^g[0-9]{6}\.json$/.test(path.basename(String(file)));
const generationMutations = [];
afterEach(() => assert.deepEqual(generationMutations.splice(0), [], 'q12: no caught error may conceal a generation mutation'));

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'epc2-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = { routeBindingsDir: path.join(root, 'route-bindings'), bindingHost: 'fixture-host', bindingPid: 111,
    bindingNow: () => 1000, bindingKill: dead, log: () => {}, ...extra };
  return { root, opts, store: (overrides = {}, id = ID) => createStore(id, { ...opts, ...overrides }) };
}

function guardedFs(overrides = {}) {
  return new Proxy(fs, { get(target, key) {
    if (key === 'unlinkSync' || key === 'renameSync') return (...args) => {
      if (args.some(generation)) generationMutations.push({ key, args });
      assert.equal(args.some(generation), false, 'q12: generation files must never be unlinked or renamed');
      return (overrides[key] || target[key])(...args);
    };
    return overrides[key] || target[key];
  } });
}

test('q1/q12: every invocation boundary is a complete owned generation; release only appends', async t => {
  const f = fixture(t, { bindingFs: guardedFs() });
  const s = f.store();
  assert.equal((await s.acquire(() => ROUTE)).record.generation, 1);
  assert.equal(fs.statSync(s.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(s.dir, 'g000001.json')).mode & 0o777, 0o600);
  for (const stage of ['extract', 'judge']) {
    assert.equal(s.beforeInvocation(stage, 120000), true);
    const current = s.read().record;
    assert.equal(current.history.invocationBegun, true);
    assert.equal(current.history.stage, stage);
    assert.deepEqual(current.owner, s.record.owner);
    assert.equal(current.owner.pid, 111);
    assert.match(current.owner.token, /^[0-9a-f]{32}$/);
  }
  assert.equal(s.complete().record.owner, null);
  assert.equal(fs.readdirSync(s.dir).length, 4);
  assert.equal(s.beforeInvocation('extract', 120000), false);
  assert.equal(s.disposition.hold, 'lost-ownership');
});

for (const [label, overrides, expected] of [
  ['q5 live, even 30 days old', { bindingKill: () => {}, bindingNow: () => 30 * 86400000 }, 'job-active-elsewhere'],
  ['q5b EPERM', { bindingKill: () => { throw Object.assign(new Error(), { code: 'EPERM' }); } }, 'owner-liveness-uncertain'],
  ['q5b other error', { bindingKill: () => { throw new Error(); } }, 'owner-liveness-uncertain'],
  ['q5c other host', { bindingHost: 'other-host', bindingKill: () => assert.fail('must not probe another host') }, 'owner-liveness-uncertain'],
]) test(label + ' defers without resolving or changing files', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
  const bytes = fs.readFileSync(path.join(a.dir, 'g000001.json'), 'utf8');
  const b = f.store({ bindingPid: 222, ...overrides });
  assert.deepEqual(await b.acquire(() => assert.fail('must keep binding')), { deferred: expected });
  assert.equal(b.beforeInvocation('extract', 1), false);
  assert.equal(fs.readFileSync(path.join(a.dir, 'g000001.json'), 'utf8'), bytes);
});

test('q7/q12/q18: paused stale owner cannot mutate or release its successor', async t => {
  const f = fixture(t, { bindingFs: guardedFs() }); const a = f.store(); await a.acquire(() => ROUTE);
  const validatedToken = a.record.owner.token;
  const b = f.store({ bindingPid: 222 }); await b.acquire(() => assert.fail('no new resolution'));
  const file = path.join(b.dir, 'g000002.json'); const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(a.record.owner.token, validatedToken);
  assert.equal(a.beforeInvocation('extract', 120000), false);
  assert.equal(a.disposition.hold, 'lost-ownership');
  assert.equal(a.complete().hold, 'lost-ownership');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(b.beforeInvocation('extract', 120000), true);
});

test('q8: two reclaimers read the same dead owner; exactly one wins and the other defers', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
  let b; let injected = false; let bPromise;
  const c = f.store({ bindingPid: 333, bindingKill: pid => { if (pid === 111) return dead(); },
    bindingFs: guardedFs({ linkSync: (temp, target) => {
      if (!injected) { injected = true; bPromise = b.acquire(() => ROUTE); }
      return fs.linkSync(temp, target);
    } }) });
  b = f.store({ bindingPid: 222 });
  const result = await c.acquire(() => ROUTE); await bPromise;
  assert.equal(result.deferred, 'job-active-elsewhere');
  assert.equal(b.beforeInvocation('extract', 120000), true);
  assert.equal(c.beforeInvocation('extract', 120000), false);
  assert.equal(b.read().record.owner.pid, 222);
});

for (const stage of ['linked-before-invocation', 'invocation-begun', 'result-before-completion']) {
  test('q9 crash recovery: ' + stage, async t => {
    const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
    if (stage !== 'linked-before-invocation') a.beforeInvocation('extract', 120000);
    if (stage === 'result-before-completion') a.observe('observed-one');
    if (stage !== 'linked-before-invocation') {
      const early = f.store({ bindingPid: 222, bindingNow: () => 180999 });
      assert.equal((await early.acquire(() => assert.fail())).deferred, 'prior-invocation-may-be-running');
    }
    const recovered = f.store({ bindingPid: 333, bindingNow: () => 181000 });
    await recovered.acquire(() => assert.fail('recovery never resolves another route'));
    assert.equal(recovered.record.route, 'claude-code');
    assert.equal(recovered.record.recovered, true);
    assert.equal(recovered.canFallback(), false);
  });
}

test('q9/q17: an active or abandoned temp and unknown files are ignored, never removed', async t => {
  const f = fixture(t); const a = f.store(); fs.mkdirSync(a.dir, { recursive: true });
  const temp = path.join(a.dir, 'tmp.999.' + 'a'.repeat(32)); fs.writeFileSync(temp, 'partial private temp');
  fs.writeFileSync(path.join(a.dir, '.DS_Store'), 'unknown');
  assert.equal(a.read().record, null);
  await a.acquire(() => ROUTE);
  const b = f.store({ bindingKill: () => {} });
  assert.equal((await b.acquire(() => assert.fail())).deferred, 'job-active-elsewhere');
  assert.equal(fs.readFileSync(temp, 'utf8'), 'partial private temp');
  assert.equal(fs.readFileSync(path.join(a.dir, '.DS_Store'), 'utf8'), 'unknown');
});

for (const kind of ['malformed', 'truncated', 'missing-field', 'wrong-job', 'wrong-generation', 'gap']) {
  test('q10 corrupt ' + kind + ' holds without any publication', async t => {
    const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
    const first = path.join(a.dir, 'g000001.json'); const r = a.record;
    if (kind === 'malformed') fs.writeFileSync(first, 'invalid');
    if (kind === 'truncated') fs.writeFileSync(first, '{');
    if (kind === 'missing-field') { delete r.cliVersion; fs.writeFileSync(first, JSON.stringify(r)); }
    if (kind === 'wrong-job') { r.jobId = 'x'; fs.writeFileSync(first, JSON.stringify(r)); }
    if (kind === 'wrong-generation') { r.generation = 2; fs.writeFileSync(first, JSON.stringify(r)); }
    if (kind === 'gap') fs.writeFileSync(path.join(a.dir, 'g000003.json'), JSON.stringify({ ...r, generation: 3 }));
    const before = fs.readdirSync(a.dir); const b = f.store();
    assert.equal((await b.acquire(() => assert.fail())).hold, 'route-binding-corrupt');
    assert.equal(b.beforeInvocation('extract', 1), false);
    assert.deepEqual(fs.readdirSync(a.dir), before);
  });
}

test('q13: transcript identity changes the directory without touching the previous job', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
  const bytes = fs.readFileSync(path.join(a.dir, 'g000001.json'), 'utf8');
  const b = f.store({}, { ...ID, jobSha: hash('new transcript') }); await b.acquire(() => ROUTE);
  assert.notEqual(a.dir, b.dir);
  assert.equal(a.jobId, hash(ID.source + '\0' + ID.sessionId + '\0' + ID.jobSha));
  assert.equal(a.jobId, jobIdFor(ID));
  assert.equal(fs.readFileSync(path.join(a.dir, 'g000001.json'), 'utf8'), bytes);
});

test('q16: completion starts a new attempt, resets all attempt-local fields, and allows fresh fallback', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
  a.beforeInvocation('extract', 120000); a.observe('one'); a.observe('two'); a.complete();
  const b = f.store({ bindingPid: 222 }); await b.acquire(() => ({ ...ROUTE, cliVersion: '2.1.42' }));
  assert.equal(b.record.attempt, 2); assert.equal(b.record.recovered, false);
  assert.equal(b.record.observed_model, null); assert.equal(b.record.holdReason, null);
  assert.equal(b.record.model_changed_across_attempts, false); assert.equal(b.record.cliVersion, '2.1.42');
  assert.deepEqual(b.record.history, { invocationBegun: false, stage: null, invocationStartedAt: null, stageTimeoutMs: null });
  for (const key of ['jobId', 'source', 'sessionId', 'jobSha']) assert.equal(b.record[key], a.record[key]);
  assert.equal(b.canFallback(), true);
});

test('q15: held re-entry keeps route and history; explicit and recovered owners cannot fall back', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ({ ...ROUTE, origin: 'explicit' }));
  assert.equal(a.canFallback(), false); a.hold('pinned-route-unusable');
  const b = f.store({ bindingPid: 222 }); await b.acquire(() => assert.fail());
  assert.equal(b.record.route, 'claude-code'); assert.equal(b.record.recovered, true);
  assert.equal(b.canFallback(), false);
});

test('r: null observations are unknown, two differing non-null observations log exactly once', async t => {
  const logs = []; const f = fixture(t, { log: line => logs.push(line) }); const s = f.store(); await s.acquire(() => ROUTE);
  s.observe(null); assert.equal(s.record.generation, 1);
  s.observe('one'); s.observe(null); s.observe('one'); assert.equal(s.record.model_changed_across_attempts, false);
  s.observe('two'); s.observe('three'); assert.equal(s.record.observed_model, 'one');
  assert.equal(s.record.model_changed_across_attempts, true); assert.equal(logs.length, 1);
});

// Matrix q11/q12/q18/q19. The guard is applied on EVERY failure path, not
// just a source-text check. Test cleanup uses the real fs only after assertions.
for (const mutation of ['acquisition', 'recovery', 'route-update', 'invocation-begun', 'hold', 'completion']) {
  for (const fault of ['write', 'file-fsync', 'link-before', 'link-after', 'temp-unlink', 'directory-fsync']) {
    test(`q11/q12/q18/q19 ${mutation} / ${fault}`, async t => {
      let armed = false; let lastTarget; const fds = new Map();
      const fail = () => { throw Object.assign(new Error('PRIVATE_FS_ERROR'), { code: 'EIO' }); };
      const io = guardedFs({
        openSync: (...args) => { const fd = fs.openSync(...args); fds.set(fd, String(args[0])); return fd; },
        writeFileSync: (...args) => { if (armed && fault === 'write') fail(); return fs.writeFileSync(...args); },
        fsyncSync: fd => {
          const isTemp = path.basename(fds.get(fd) || '').startsWith('tmp.');
          if (armed && ((fault === 'file-fsync' && isTemp) || (fault === 'directory-fsync' && !isTemp))) fail();
          return fs.fsyncSync(fd);
        },
        linkSync: (from, to) => { lastTarget = to; if (armed && fault === 'link-before') fail();
          fs.linkSync(from, to); if (armed && fault === 'link-after') fail(); },
        unlinkSync: file => { if (armed && fault === 'temp-unlink') fail(); return fs.unlinkSync(file); },
      });
      const f = fixture(t, { bindingFs: io }); let s = f.store();
      // Pre-create dirs so the directory-fsync fault isolates publish itself.
      fs.mkdirSync(s.dir, { recursive: true });
      if (mutation !== 'acquisition') await s.acquire(() => ROUTE);
      if (mutation === 'recovery') s = f.store({ bindingPid: 222 });
      armed = true;
      let result;
      if (mutation === 'acquisition' || mutation === 'recovery') result = await s.acquire(() => ROUTE);
      if (mutation === 'route-update') result = s.mutate({ ...ROUTE, route: 'byo-key', billingMode: 'byo-key' });
      if (mutation === 'invocation-begun') { s.beforeInvocation('extract', 120000); result = s.disposition; }
      if (mutation === 'hold') result = s.hold('pinned-route-unusable');
      if (mutation === 'completion') result = s.complete();
      armed = false;
      const afterLink = ['link-after', 'temp-unlink', 'directory-fsync'].includes(fault);
      const baseGeneration = mutation === 'acquisition' ? 0 : 1;
      const current = s.read().record;
      assert.equal(current ? current.generation : 0, baseGeneration + Number(afterLink));
      if (afterLink && ['hold', 'completion'].includes(mutation)) assert.equal(current.owner, null);
      else if (current) assert.notEqual(current.owner, null);
      if (fault === 'link-after') {
        assert.equal(result.hold, undefined);
        assert.equal(fs.existsSync(lastTarget), true);
      } else {
        assert.equal(result.hold, afterLink ? 'route-binding-uncertain' : 'route-binding-unwritable');
        const files = fs.readdirSync(s.dir);
        assert.equal(s.beforeInvocation('judge', 120000), false);
        s.complete(); assert.deepEqual(fs.readdirSync(s.dir), files);
        assert.equal(JSON.stringify(result).includes('PRIVATE_FS_ERROR'), false);
      }
      if (afterLink && ['hold', 'completion'].includes(mutation)) {
        const entrant = f.store({ bindingPid: 333 }); await entrant.acquire(() => ROUTE);
        assert.equal(entrant.record.attempt, mutation === 'completion' ? 2 : 1);
        assert.equal(entrant.record.recovered, mutation === 'hold');
      }
    });
  }
}

test('q18: nlink=2 is not proof when the intended generation has a different inode', async t => {
  const f = fixture(t); const a = f.store(); await a.acquire(() => ROUTE);
  const b = f.store({ bindingFs: guardedFs({ linkSync: (temp, target) => {
    fs.linkSync(temp, path.join(path.dirname(temp), 'unrelated-link'));
    fs.writeFileSync(target, JSON.stringify({ ...a.record, generation: 2, owner: { ...a.record.owner, pid: 333 } }));
    throw Object.assign(new Error(), { code: 'EEXIST' });
  } }), bindingKill: pid => { if (pid === 111) return dead(); } });
  assert.equal((await b.acquire(() => ROUTE)).deferred, 'job-active-elsewhere');
  assert.equal(b.read().record.owner.pid, 333);
});

for (const parent of ['root', 'job']) test('q2/q20: ' + parent + ' creation fsync failure prevents publication', async t => {
  const f = fixture(t); const dirs = new Map();
  const io = guardedFs({ openSync: (...args) => { const fd = fs.openSync(...args); dirs.set(fd, String(args[0])); return fd; },
    fsyncSync: fd => { const target = parent === 'root' ? f.root : f.opts.routeBindingsDir;
      if (dirs.get(fd) === target) throw new Error('parent fsync'); return fs.fsyncSync(fd); } });
  const s = f.store({ bindingFs: io }); assert.equal((await s.acquire(() => ROUTE)).hold, 'route-binding-unwritable');
  assert.equal(s.beforeInvocation('extract', 120000), false); assert.equal(s.read().record, null);
});

test('q20: win32 skips only directory fsync and makes no durability claim', async t => {
  let synced = 0;
  const f = fixture(t, { platform: 'win32', bindingFs: guardedFs({ fsyncSync: fd => {
    assert.equal(fs.fstatSync(fd).isFile(), true); synced++; return fs.fsyncSync(fd);
  } }) });
  const s = f.store(); const result = await s.acquire(() => ROUTE);
  assert.equal(result.visible, true); assert.equal(result.durable, false); assert.equal(synced, 1);
});

test('A5 store root is supplied only by opts, never environment', t => {
  const f = fixture(t);
  const original = process.env.AUXILO_ROUTE_BINDINGS_DIR;
  process.env.AUXILO_ROUTE_BINDINGS_DIR = path.join(f.root, 'env-must-not-win');
  try {
    const s = f.store(); assert.equal(path.dirname(s.dir), f.opts.routeBindingsDir);
    // Constructor-only default check: it does not create anything under HOME.
    const defaultStore = createStore(ID);
    assert.equal(path.dirname(defaultStore.dir), path.join(os.homedir(), '.auxilo/route-bindings'));
  } finally {
    if (original === undefined) delete process.env.AUXILO_ROUTE_BINDINGS_DIR;
    else process.env.AUXILO_ROUTE_BINDINGS_DIR = original;
  }
});

test('q8 finite entry: three collisions defer, without deleting another publisher temp', async t => {
  let links = 0; const f = fixture(t); const s = f.store({ bindingFs: guardedFs({
    linkSync: (temp, target) => { links++; const record = JSON.parse(fs.readFileSync(temp, 'utf8'));
      fs.writeFileSync(target, JSON.stringify({ ...record, state: 'held', owner: null }));
      throw Object.assign(new Error(), { code: 'EEXIST' }); },
  }) });
  assert.equal((await s.acquire(() => ROUTE)).deferred, 'binding-contended'); assert.equal(links, 3);
});
