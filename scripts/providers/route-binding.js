'use strict';

// EPC2-2 A5. Exclusive runner ownership, not proof of remote completion.
// Each mutation exclusively links a complete immutable next generation.
// No generation is ever renamed, removed, or rewritten (including release).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GENERATION = /^g[0-9]{6}\.json$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jobIdFor = ({ source, sessionId, jobSha }) => hash(`${source}\0${sessionId}\0${jobSha}`);
const freshHistory = () => ({ invocationBegun: false, stage: null, invocationStartedAt: null, stageTimeoutMs: null });
const failure = hold => ({ hold });

function validRecord(r, jobId, generation) {
  if (!r || r.schemaVersion !== 1 || r.jobId !== jobId || r.generation !== generation ||
      !Number.isSafeInteger(r.attempt) || r.attempt < 1 ||
      !['source', 'sessionId', 'jobSha', 'route', 'billingMode'].every(k => typeof r[k] === 'string') ||
      jobIdFor(r) !== jobId || !['explicit', 'auto'].includes(r.origin) ||
      !['provisional', 'pinned', 'held', 'completed'].includes(r.state) ||
      typeof r.model_changed_across_attempts !== 'boolean' ||
      typeof r.recovered !== 'boolean' || !Number.isFinite(r.createdAt) || !Number.isFinite(r.updatedAt) ||
      !['holdReason', 'destinationFingerprint', 'cliFingerprint', 'cliVersion', 'observed_model'].every(k => r[k] === null || typeof r[k] === 'string')) return false;
  const h = r.history;
  if (!h || typeof h.invocationBegun !== 'boolean') return false;
  if (h.invocationBegun) {
    if (!['extract', 'judge'].includes(h.stage) || !Number.isFinite(h.invocationStartedAt) ||
        !Number.isFinite(h.stageTimeoutMs) || h.stageTimeoutMs <= 0) return false;
  } else if (h.stage !== null || h.invocationStartedAt !== null || h.stageTimeoutMs !== null) return false;
  if (r.owner === null) return r.state === 'held' || r.state === 'completed';
  return Boolean(r.owner && Number.isSafeInteger(r.owner.pid) && r.owner.pid > 0 &&
    typeof r.owner.host === 'string' && r.owner.host && /^[0-9a-f]{32}$/.test(r.owner.token) &&
    ['provisional', 'pinned'].includes(r.state));
}

function createStore(identity, opts = {}) {
  const io = opts.bindingFs || fs;
  const platform = opts.platform || process.platform;
  const now = opts.bindingNow || Date.now;
  const owner = Object.freeze({ pid: opts.bindingPid || process.pid, host: opts.bindingHost || os.hostname(), token: crypto.randomBytes(16).toString('hex') });
  const root = opts.routeBindingsDir || path.join(os.homedir(), '.auxilo', 'route-bindings');
  const jobId = jobIdFor(identity);
  const dir = path.join(root, jobId);
  const kill = opts.bindingKill || process.kill;
  let owned = null;
  let stopped = null;
  const clone = value => JSON.parse(JSON.stringify(value));

  function syncDirectory(directory) {
    if (platform === 'win32') return;
    const fd = io.openSync(directory, fs.constants.O_RDONLY);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }

  function makeDirectory(directory) {
    try {
      io.mkdirSync(directory, { mode: 0o700 });
      syncDirectory(path.dirname(directory));
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (!io.lstatSync(directory).isDirectory()) throw e;
    }
  }

  function prepare() {
    try {
      // The normal parent is ~/.auxilo. A first installation may not have it.
      if (!io.existsSync(path.dirname(root))) makeDirectory(path.dirname(root));
      makeDirectory(root);
      makeDirectory(dir);
      return null;
    } catch { return failure('route-binding-unwritable'); }
  }

  function read() {
    try {
      const names = io.readdirSync(dir).filter(name => GENERATION.test(name)).sort();
      if (!names.length) return { record: null };
      if (names.some((name, i) => name !== `g${String(i + 1).padStart(6, '0')}.json`)) return failure('route-binding-corrupt');
      const file = path.join(dir, names[names.length - 1]);
      if (!io.lstatSync(file).isFile()) return failure('route-binding-corrupt');
      const record = JSON.parse(io.readFileSync(file, 'utf8'));
      return validRecord(record, jobId, names.length) ? { record } : failure('route-binding-corrupt');
    } catch (e) {
      if (e.code === 'ENOENT' && !io.existsSync(dir)) return { record: null };
      return failure('route-binding-corrupt');
    }
  }

  function publish(record) {
    if (record.generation > 999999) return failure('route-binding-unwritable');
    const temp = path.join(dir, `tmp.${owner.pid}.${crypto.randomBytes(16).toString('hex')}`);
    const target = path.join(dir, `g${String(record.generation).padStart(6, '0')}.json`);
    let created = false;
    let linked = false;
    let fd;
    let outcome;
    try {
      fd = io.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      created = true;
      io.writeFileSync(fd, JSON.stringify(record));
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      try {
        io.linkSync(temp, target);
        linked = true;
      } catch {
        // Errors can be reported after a link took effect. nlink is not proof.
        let targetStat;
        try { targetStat = io.statSync(target); }
        catch (e) { outcome = failure(e.code === 'ENOENT' ? 'route-binding-unwritable' : 'route-binding-uncertain'); }
        if (targetStat) {
          try {
            const tempStat = io.statSync(temp);
            if (targetStat.dev === tempStat.dev && targetStat.ino === tempStat.ino) linked = true;
            else outcome = { lost: true };
          } catch { outcome = failure('route-binding-uncertain'); }
        }
      }
      if (linked) {
        io.unlinkSync(temp);
        created = false;
        syncDirectory(dir);
        return { record, visible: true, durable: platform !== 'win32' };
      }
    } catch {
      outcome = failure(linked ? 'route-binding-uncertain' : 'route-binding-unwritable');
    } finally {
      if (fd !== undefined) { try { io.closeSync(fd); } catch { /* no invocation after failure */ } }
      if (created && !linked) { try { io.unlinkSync(temp); } catch { /* own temp only; diagnosis may retain it */ } }
    }
    return { ...outcome, ...(linked && { record, visible: true, durable: false }) };
  }

  function liveness(record) {
    if (record.owner.host !== owner.host) return { deferred: 'owner-liveness-uncertain' };
    try { kill(record.owner.pid, 0); return { deferred: 'job-active-elsewhere' }; }
    catch (e) { return e.code === 'ESRCH' ? null : { deferred: 'owner-liveness-uncertain' }; }
  }

  async function acquire(resolve) {
    const setup = prepare();
    if (setup) return (stopped = setup);
    for (let pass = 0; pass < 3; pass += 1) {
      const current = read();
      if (current.hold) return (stopped = current);
      const r = current.record;
      let next;
      if (!r || (r.owner === null && r.state === 'completed')) {
        const route = await resolve();
        if (!route || route.hold || route.deferred) return (stopped = route || failure('pinned-route-unusable'));
        next = {
          schemaVersion: 1, ...identity, jobId, generation: r ? r.generation + 1 : 1,
          attempt: r ? r.attempt + 1 : 1, ...route, state: 'provisional', holdReason: null,
          history: freshHistory(), recovered: false, observed_model: null,
          model_changed_across_attempts: false, owner, createdAt: r ? r.createdAt : now(), updatedAt: now(),
        };
      } else {
        if (r.owner !== null) {
          const live = liveness(r);
          if (live) return (stopped = live);
          if (r.history.invocationBegun && now() < r.history.invocationStartedAt + r.history.stageTimeoutMs + 60000) {
            return (stopped = { deferred: 'prior-invocation-may-be-running' });
          }
        }
        next = { ...r, generation: r.generation + 1, state: 'pinned', recovered: true, owner, updatedAt: now() };
      }
      const result = publish(next);
      if (result.lost) continue;
      if (result.hold) return (stopped = result);
      owned = clone(next);
      return result;
    }
    return (stopped = { deferred: 'binding-contended' });
  }

  function mutate(patch) {
    if (stopped) return stopped;
    if (!owned || !owned.owner || owned.owner.token !== owner.token || owned.owner.pid !== owner.pid || owned.owner.host !== owner.host) {
      return (stopped = failure('lost-ownership'));
    }
    const next = { ...owned, ...patch, generation: owned.generation + 1, updatedAt: now() };
    const result = publish(next);
    if (result.lost) return (stopped = failure('lost-ownership'));
    if (result.hold) return (stopped = result);
    owned = clone(next);
    return result;
  }

  function beforeInvocation(stage, timeoutMs) {
    const result = mutate({ state: 'pinned', history: { invocationBegun: true, stage, invocationStartedAt: now(), stageTimeoutMs: timeoutMs } });
    return !result.hold && !result.deferred;
  }

  function observe(model) {
    if (typeof model !== 'string' || !model) return null;
    if (!owned || stopped) return stopped;
    if (owned.observed_model === null) return mutate({ observed_model: model });
    if (owned.observed_model !== model && !owned.model_changed_across_attempts) {
      const result = mutate({ model_changed_across_attempts: true });
      if (!result.hold) {
        try { (opts.log || console.error)('[providers] observed model changed across attempts'); } catch { /* logging cannot change ownership */ }
      }
      return result;
    }
    return null;
  }

  return {
    dir, jobId, read, acquire, mutate, beforeInvocation, observe,
    get record() { return owned ? clone(owned) : null; },
    get disposition() { return stopped ? { ...(stopped.hold && { hold: stopped.hold }), ...(stopped.deferred && { deferred: stopped.deferred }) } : {}; },
    canFallback() { return !!owned && !stopped && owned.origin === 'auto' && !owned.recovered && !owned.history.invocationBegun; },
    hold(reason) { return mutate({ state: 'held', holdReason: reason, owner: null }); },
    complete() { return mutate({ state: 'completed', holdReason: null, owner: null }); },
  };
}

// All three adapters use this at the final model-capable boundary. There is
// deliberately no implicit authorization for legacy/direct callers.
function invocationGate(opts) {
  const reasonCode = typeof opts.beforeModelInvocation === 'function' ? 'invocation-held' : 'invocation-hook-missing';
  if (reasonCode !== 'invocation-hook-missing') {
    try { if (opts.beforeModelInvocation() === true) return null; } catch { /* fail closed */ }
  }
  return { ok: false, text: '', usage: null, reasonCode, reason: reasonCode === 'invocation-hook-missing' ? 'model invocation requires an ownership hook' : 'model invocation held by ownership hook', hold: 'pinned-route-unusable', authStatus: 'unknown' };
}

module.exports = { createStore, jobIdFor, hash, invocationGate };
