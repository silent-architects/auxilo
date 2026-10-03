'use strict';
/*
 * EPC2-2 A+B: routing is pinned per job; initial automatic precedence is
 * unchanged with Codex dark. An existing binding wins over new configuration.
 * Only a fresh, continuously owned automatic attempt with no invocation may
 * fall back on an explicit pre-invocation refusal. CLI model consistency is
 * observed, not enforced. Runner ownership does not prove a prior remote
 * request stopped; a recovered request can consume quota or bill a key again.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bindings = require('./route-binding.js');
const SOURCE_ROUTES = Object.freeze({ 'claude-code': 'claude-code' });

const claudeCode = require('./claude-code.js');

function notInstalledProvider(id) {
  return {
    id,
    detect() {
      return false;
    },
    async runModel() {
      return {
        ok: false,
        text: '',
        usage: null,
        reasonCode: 'provider-not-installed',
        reason: `${id} support is not installed yet`,
        refusal: 'pre-invocation',
        authStatus: 'unknown',
      };
    },
  };
}

function loadOptionalProvider(id, modulePath) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(modulePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      return notInstalledProvider(id);
    }
    throw err;
  }
}

const codexCli = loadOptionalProvider('codex-cli', './codex-cli.js');
const byoKey = loadOptionalProvider('byo-key', './byo-key.js');

const KNOWN_PROVIDER_IDS = Object.freeze(['claude-code', 'codex-cli', 'byo-key']);
const AUTOMATIC_PROVIDER_ORDER = Object.freeze(['claude-code', 'byo-key']);
const PROVIDERS = {
  'claude-code': claudeCode,
  'codex-cli': codexCli,
  'byo-key': byoKey,
};

// TEST-HOME-ISOLATION: same AUXILO_HOME-over-os.homedir() fallback as
// scripts/providers/byo-key.js's DEFAULT_PROVIDERS_STATE_PATH (duplicated,
// not imported — see that file's docblock; test/byo-key-provider.test.js
// pins the two byte-equal). opts.providersStatePath, threaded through every
// resolveProvider()/runModel()/persistSelected() call site in this repo's
// tests, still wins over both.
const PROVIDERS_STATE_PATH = path.join(process.env.AUXILO_HOME || os.homedir(), '.auxilo', 'providers.json');

function readProvidersState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Persist the auto-detected choice into ~/.auxilo/providers.json's `selected`
 * key — the SAME file PART C's BYO-key store uses (one file, not two). Never
 * called for an env-override selection (item 7: "env override always wins,
 * never writes"). Persisting is a convenience for `auxilo status`, not a
 * correctness requirement — failure here is swallowed.
 *
 * Routes through byo-key.js's writeProvidersStateAtomic — GOV-3 item 1's
 * "ONE writer" for every providers.json write, so this call gets the exact
 * same tmp+wx+rename+POST-RENAME-chmod discipline byo-key.js's own writers
 * use, instead of a second, independently-drifted copy that (as found)
 * omitted the post-rename chmod. It merges only the `selected` field — the
 * `byo` object (and anything else already in the file) is read back and
 * passed through UNCHANGED, never reconstructed or re-derived here, so this
 * function cannot corrupt or partially rewrite credential fields it did not
 * itself validate.
 */
function persistSelected(providerId, opts) {
  const statePath = opts.providersStatePath || PROVIDERS_STATE_PATH;
  try {
    if (typeof byoKey.writeProvidersStateAtomic !== 'function') return; // PART C not installed yet
    const state = readProvidersState(statePath);
    state.origin = 'auto';
    state.selected = providerId; // merge only this field — `byo` (if present) passes through as-read
    byoKey.writeProvidersStateAtomic(state, opts);
  } catch {
    // Best-effort — selection still works in-process even if the write fails.
  }
}

/**
 * Resolve which provider should run this call. Auto-detect results are cached
 * (per the supplied `opts.providerCache` object, or a module-level default for
 * real production runs) so a single extraction session detects once and reuses
 * the choice across both the extraction call and the judge call — mirrors the
 * one-call-per-session runner pattern (runner.js calls postExtractDetailed once
 * per session; extractLocally's extract call and its anchored-judge call are the
 * two runModel invocations within that one session that must agree).
 * An env override is re-evaluated every call (cheap: no detect() needed) and is
 * never cached or persisted.
 */
const defaultCache = {};

async function resolveProvider(opts = {}) {
  const registry = opts.providerRegistry || PROVIDERS;
  const sourceMap = opts.sourceMap || SOURCE_ROUTES;
  const env = opts.env || process.env;
  const override = env.AUXILO_EXTRACTION_PROVIDER;
  if (override) {
    if (!Object.prototype.hasOwnProperty.call(registry, override)) {
      return {
        ok: false,
        reason: `AUXILO_EXTRACTION_PROVIDER="${override}" is not a known provider (expected one of: ${KNOWN_PROVIDER_IDS.join(', ')})`,
      };
    }
    return { ok: true, id: override, module: registry[override] };
  }

  // Fast path (EXTRACT-PER-CLIENT W1 FIX, PUNCH-LIST P1, item 3): the
  // persisted `selected` choice — written by a prior successful resolution,
  // possibly in an earlier process — skips re-probing every provider ahead
  // of it in AUTOMATIC_PROVIDER_ORDER when it is STILL usable (the common
  // steady-state case: same builder, same login, repeated extraction
  // calls). "Usable" is re-verified via that provider's own detect() every
  // time, never trusted blindly from the file alone. A stale persisted
  // choice does NOT fail — it logs one line and falls through to the full
  // ordered scan below, which re-detects from scratch and persists (and
  // caches) whatever wins.
  //
  // GOV-3 item 2 ("checked on WRITE only, never on READ") is satisfied HERE
  // by delegation, not by a duplicate check: `persistedMod.detect(opts)`
  // below, when the persisted choice is 'byo-key', IS byo-key.js's own
  // detect() — which (post-fix) checks isProvidersFileModeUnsafe before
  // trusting anything on disk and returns false on an unsafe file. That
  // reads as "no longer usable" through the EXACT SAME stale-selection path
  // already below (log one line, fall through to the full ordered scan,
  // where byo-key's own detect() applies the identical check again on its
  // turn). A second, generic mode check gated on the `selected` string
  // alone was tried and reverted here — it broke the legitimate steady-state
  // fast path for claude-code/codex-cli selections (neither of which reads
  // this file's contents at all, so an insecure-mode providers.json is not
  // their concern) whenever the fixture file wasn't deliberately chmod'd
  // 0600 (e.g. a plain `fs.writeFileSync` at the OS umask). Gating strictly
  // on "is the persisted provider byo-key" would be correct but is also a
  // no-op — byo-key.detect() already returns false in that case, which is
  // exactly what the fast path's existing fallthrough handles.
  const log = typeof opts.log === 'function' ? opts.log : console.error;
  const statePath = opts.providersStatePath || PROVIDERS_STATE_PATH;
  const persistedState = readProvidersState(statePath);

  // EPC2-2 E0: codex-cli failed the live isolation sentinel and is therefore
  // ineligible for automatic selection. Treat a cached pre-E0 winner as
  // absent in memory on EVERY resolution, even if the best-effort migration
  // below cannot rewrite providers.json. The explicit env override above is
  // intentionally untouched and remains the only route to codex-cli.
  if (persistedState.selected === 'codex-cli') {
    delete persistedState.selected;
    try {
      if (typeof byoKey.writeProvidersStateAtomic !== 'function') throw new Error('writer unavailable');
      byoKey.writeProvidersStateAtomic(persistedState, opts);
    } catch {
      log('[providers] could not clear retired automatic codex-cli selection; continuing without it');
    }
  }

  const cache = opts.providerCache || defaultCache;
  if (cache.resolved && cache.resolved.id !== 'codex-cli') return cache.resolved;
  if (cache.resolved && cache.resolved.id === 'codex-cli') delete cache.resolved;

  const persistedId = persistedState.selected;
  if (typeof persistedId === 'string' && Object.prototype.hasOwnProperty.call(registry, persistedId)) {
    const persistedMod = registry[persistedId];
    let stillUsable = false;
    try {
      stillUsable = await persistedMod.detect(opts);
    } catch {
      stillUsable = false;
    }
    if (stillUsable) {
      const resolved = { ok: true, id: persistedId, module: persistedMod };
      cache.resolved = resolved;
      return resolved;
    }
    log(`[providers] persisted selection "${persistedId}" is no longer usable; re-detecting`);
  }

  const tried = [];
  const native = sourceMap[opts.source];
  const order = [...new Set([...(AUTOMATIC_PROVIDER_ORDER.includes(native) ? [native] : []), ...AUTOMATIC_PROVIDER_ORDER])];
  for (const id of order) {
    const mod = registry[id];
    tried.push(id);
    let available = false;
    try {
      available = await mod.detect(opts);
    } catch {
      available = false;
    }
    if (available) {
      const resolved = { ok: true, id, module: mod };
      cache.resolved = resolved;
      persistSelected(id, opts);
      return resolved;
    }
  }
  return { ok: false, reason: `no extraction model provider available — tried: ${tried.join(', ')}` };
}

/** Bounded message classification only. Reason codes never authorize fallback. */
const NON_RETRYABLE_FOR_THIS_PROVIDER = new Set([
  'cli-unauthenticated',
  'cli-not-installed',
  'cli-billing-helper-configured',
  'provider-not-configured',
  'providers-file-mode-unsafe',
  'cli-settings-isolation-unsupported',
]);

/**
 * EXTRACTION-MODEL-PROVENANCE (PUNCH-LIST P1, follow-up to the
 * EXTRACT-LOG-HOOKS-EVIDENCE row): `identity` on a runModel() result is
 * provenance — a record of which provider actually produced this text — not
 * a guess. It must never be re-derived after the fact from a fresh detect(),
 * because a fresh detect() answers "what would run now", not "what ran".
 * This registry is the only thing that KNOWS which module's runModel() it
 * just invoked for a given attempt, so identity is enforced HERE, centrally,
 * rather than trusted to per-provider convention (the gap this row closes:
 * before this fix, a provider `ok:true` return that forgot to attach
 * `identity` would silently fall through to extract-local.js's
 * resolveExtractionModelIdentity() re-detecting via resolveProvider() —
 * decoupled from which module actually ran).
 */
function hasUsableIdentity(identity) {
  return Boolean(
    identity
    && typeof identity === 'object'
    && typeof identity.provider === 'string'
    && identity.provider
  );
}

/** Report only known provider/version facts; never infer an observed model. */
function deriveIdentity(id, result) {
  if (id === 'claude-code') {
    return {
      provider: 'claude-code',
      model: null,
      requested_model: null,
      observed_model: null,
      identity_unresolved: 'missing',
      version: (result && result.cliVersion) || null,
      vendor: 'anthropic',
    };
  }
  if (!(result && result.ok)) {
    return { provider: id, model: null, requested_model: null, observed_model: null, identity_unresolved: 'missing', version: null, vendor: null };
  }
  return { provider: 'unknown', model: null, requested_model: null, observed_model: null, identity_unresolved: 'missing', version: null, vendor: null };
}

/**
 * Attach a derived identity to `result` IFF it doesn't already carry a
 * usable one — never overwrites a provider-reported identity (e.g.
 * byo-key's real model name). Applied to every result this registry
 * returns, success or failure, so the per-run `[providers]` log
 * (scripts/extract-local.js's logProviderRunSummary) names the provider
 * that actually ran even on a failure — the automatic fall-through failure
 * case is now claude-code skipped, byo-key ran and failed with no identity
 * of its own, and the stamp must not be re-guessed as claude-code by the
 * caller.
 */
function withIdentity(id, result) {
  if (hasUsableIdentity(result && result.identity)) return result;
  return { ...result, identity: deriveIdentity(id, result) };
}

/** Credential-free binding destination, calculated exactly as the adapter does. */
function routeMetadata(id, opts, origin) {
  let destinationFingerprint = null;
  let cliFingerprint = null;
  let cliVersion = null;
  if (id === 'byo-key') {
    const config = byoKey.readByoConfig(opts);
    if (config) {
      const vendor = byoKey.resolveVendor(config.provider);
      destinationFingerprint = bindings.hash(vendor + '\n' + byoKey.baseUrlFor(vendor, config.base_url) + '\n' + config.model);
    }
  } else if (id === 'claude-code') {
    const bin = opts.claudeBin || claudeCode.resolveClaudeBin(opts);
    cliFingerprint = bindings.hash(bin);
    cliVersion = claudeCode.getClaudeCliVersion(bin, opts);
  } else if (id === 'codex-cli') {
    const bin = opts.codexBin || codexCli.resolveCodexBin(opts);
    cliFingerprint = bindings.hash(bin);
    // getCodexVersion is --version, never a model-capable request.
    cliVersion = codexCli.getCodexVersion(opts);
  }
  return { route: id, origin, billingMode: id === 'byo-key' ? 'byo-key' : 'cli-login', destinationFingerprint, cliFingerprint, cliVersion };
}

function dispositionResult(disposition) {
  const code = disposition.hold || disposition.deferred;
  return { ok: false, text: '', usage: null, reasonCode: code, reason: 'job route is held or deferred', authStatus: 'unknown', ...disposition };
}

function finishJob(context) {
  if (!context || !context.store) return {};
  const existing = context.store.disposition;
  if (existing.hold || existing.deferred) return existing;
  if (context.hold) return { hold: context.hold };
  const result = context.store.complete();
  return result.hold ? { hold: result.hold } : {};
}

async function runModel(opts = {}) {
  const mode = opts.mode === 'judge' ? 'judge' : 'extract';
  const registry = opts.providerRegistry || PROVIDERS;
  const context = opts.routeContext || {};
  const standalone = !opts.routeContext;
  if (context.hold) return dispositionResult({ hold: context.hold });
  if (!context.store) {
    const identity = {
      source: opts.source || '', sessionId: opts.sessionId || opts.runId || crypto.randomUUID(),
      jobSha: opts.jobSha || bindings.hash(String(opts.input || opts.prompt || '')),
    };
    context.store = bindings.createStore(identity, opts);
    const acquired = await context.store.acquire(async () => {
      const resolved = await resolveProvider({ ...opts, providerCache: opts.providerCache || {} });
      const explicit = Boolean((opts.env || process.env).AUXILO_EXTRACTION_PROVIDER);
      if (!resolved.ok && explicit) return { hold: 'pinned-route-unusable' };
      return routeMetadata(resolved.ok ? resolved.id : 'claude-code', opts, explicit ? 'explicit' : 'auto');
    });
    if (acquired.hold || acquired.deferred) return dispositionResult(context.store.disposition);
  }
  const store = context.store;
  if (store.disposition.hold || store.disposition.deferred) return dispositionResult(store.disposition);
  const record = store.record;
  const current = routeMetadata(record.route, opts, record.origin);
  if (['destinationFingerprint', 'cliFingerprint', 'cliVersion', 'billingMode'].some(k => current[k] !== record[k])) {
    const release = store.hold('pinned-route-changed');
    context.hold = release.hold || 'pinned-route-changed';
    return dispositionResult({ hold: context.hold });
  }
  const configuredByo = Boolean(byoKey.readByoConfig(opts));
  // A retained BYO cache refusal rescans the ordinary order, including BYO.
  const order = [record.route, ...AUTOMATIC_PROVIDER_ORDER.filter(id =>
    (id !== record.route || record.route === 'byo-key') && (id !== 'byo-key' || configuredByo))];
  const attempts = [];
  let firstFailure = null;
  for (const id of order) {
    if (id !== store.record.route) {
      const updated = store.mutate(routeMetadata(id, opts, 'auto'));
      if (updated.hold) return dispositionResult(store.disposition);
    }
    const mod = registry[id];
    let called = false;
    const beforeModelInvocation = () => {
      if (called) return false;
      called = true;
      return store.beforeInvocation(mode, opts.timeoutMs || 120000);
    };
    let raw;
    try {
      raw = mod ? await mod.runModel({ ...opts, mode, beforeModelInvocation }) :
        { ok: false, text: '', usage: null, reason: 'provider is not installed', reasonCode: 'provider-not-installed', refusal: 'pre-invocation' };
    } catch {
      raw = { ok: false, text: '', usage: null, reason: 'provider invocation failed', reasonCode: 'unknown' };
    }
    let result = withIdentity(id, raw);
    const stopped = store.disposition;
    if (stopped.hold || stopped.deferred) return { ...result, ...stopped };
    if (result.ok) {
      const observed = store.observe(result.identity && result.identity.observed_model);
      if (observed && observed.hold) return { ...result, hold: observed.hold };
      if (standalone) result = { ...result, ...finishJob(context) };
      return result;
    }
    if (!attempts.length) firstFailure = result;
    attempts.push(id + '=' + (NON_RETRYABLE_FOR_THIS_PROVIDER.has(result.reasonCode) ? result.reasonCode : 'unavailable'));
    if (result.refusal !== 'pre-invocation' || !store.canFallback()) {
      const release = store.hold('pinned-route-unusable');
      context.hold = release.hold || 'pinned-route-unusable';
      return { ...result, hold: context.hold };
    }
    (opts.log || console.error)('[providers] ' + id + ' refused before invocation; trying next provider');
  }
  const released = store.hold('pinned-route-unusable');
  context.hold = released.hold || 'pinned-route-unusable';
  if (!configuredByo && !attempts.some(attempt => attempt.startsWith('byo-key='))) attempts.push('byo-key=provider-not-configured');
  // EXT-0806c: a generic 'no-usable-provider' reads as UNKNOWN downstream and never alerts. When the
  // first-choice provider was refused for an unauthenticated CLI, the chain already knows the
  // actionable cause, so surface it; the attempts list stays in `reason`. Read from the first
  // attempt's result object, never from the attempts strings.
  const unauthenticated = Boolean(firstFailure) && firstFailure.reasonCode === 'cli-unauthenticated';
  return { ok: false, text: '', usage: null, authStatus: unauthenticated ? 'logged-out' : 'unknown',
    reasonCode: unauthenticated ? 'cli-unauthenticated' : 'no-usable-provider',
    reason: 'no usable extraction provider (tried: ' + attempts.join('; ') + ')', hold: context.hold };
}

module.exports = {
  runModel,
  finishJob,
  SOURCE_ROUTES,
  resolveProvider,
  KNOWN_PROVIDER_IDS,
  AUTOMATIC_PROVIDER_ORDER,
  PROVIDERS_STATE_PATH,
  NON_RETRYABLE_FOR_THIS_PROVIDER,
};
