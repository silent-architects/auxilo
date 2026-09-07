'use strict';
/*
 * scripts/providers/index.js — provider registry + selection
 * (EXTRACT-PER-CLIENT W1 PART A; selection fall-through added in the W1 P1
 * fix — PUNCH-LIST).
 *
 * resolveProvider(): which ONE provider to try first. Selection order:
 * AUXILO_EXTRACTION_PROVIDER env override (wins unconditionally, never
 * persisted — "wins, never writes") → else the persisted `selected` choice
 * from ~/.auxilo/providers.json if it is STILL usable (re-verified via its
 * own detect() every call, never trusted blindly — a stale persisted choice
 * falls through to a full re-scan rather than failing) → else the first
 * provider whose detect() is true, in fixed order (claude-code → codex-cli →
 * byo-key) → else ok:false, with a reason naming every provider tried.
 *
 * runModel(): resolves via resolveProvider(), then actually RUNS it. A
 * non-override resolution that fails with a reasonCode meaning "this
 * provider cannot run at all" (NON_RETRYABLE_FOR_THIS_PROVIDER — e.g.
 * unauthenticated, not installed, a billing helper is configured) falls
 * through to the next provider in PROVIDER_ORDER rather than reporting a
 * hard failure; a working provider that merely failed once (timeout, model
 * error) does not fall through — that is still the builder's chosen
 * provider having a bad run, not a reason to switch under them. An explicit
 * env override never falls through, honoring the operator's explicit
 * choice. Every provider exhausted → reasonCode 'no-usable-provider' with
 * every attempt's reason summarized in `reason`.
 *
 * codex-cli.js and byo-key.js don't exist yet (PART B/C). loadOptionalProvider()
 * degrades a missing module into a "not installed yet" stub so this file — and
 * everything that calls into it — never throws on a fresh PART A checkout; PART
 * B/C only need to add their files, not touch this registration.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

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

const PROVIDER_ORDER = Object.freeze(['claude-code', 'codex-cli', 'byo-key']);
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
  const env = opts.env || process.env;
  const override = env.AUXILO_EXTRACTION_PROVIDER;
  if (override) {
    if (!Object.prototype.hasOwnProperty.call(PROVIDERS, override)) {
      return {
        ok: false,
        reason: `AUXILO_EXTRACTION_PROVIDER="${override}" is not a known provider (expected one of: ${PROVIDER_ORDER.join(', ')})`,
      };
    }
    return { ok: true, id: override, module: PROVIDERS[override] };
  }

  const cache = opts.providerCache || defaultCache;
  if (cache.resolved) return cache.resolved;

  // Fast path (EXTRACT-PER-CLIENT W1 FIX, PUNCH-LIST P1, item 3): the
  // persisted `selected` choice — written by a prior successful resolution,
  // possibly in an earlier process — skips re-probing every provider ahead
  // of it in PROVIDER_ORDER when it is STILL usable (the common
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
  const persistedId = persistedState.selected;
  if (typeof persistedId === 'string' && Object.prototype.hasOwnProperty.call(PROVIDERS, persistedId)) {
    const persistedMod = PROVIDERS[persistedId];
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
  for (const id of PROVIDER_ORDER) {
    const mod = PROVIDERS[id];
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

/**
 * reasonCodes meaning "this provider cannot run at all right now" — safe to
 * try the NEXT provider in PROVIDER_ORDER rather than reporting a hard
 * failure (EXTRACT-PER-CLIENT W1 FIX, PUNCH-LIST P1, item 2). Everything
 * else (timeouts, model errors, malformed output, rate limits) means the
 * chosen provider DID run and failed on THIS call — that is not a signal to
 * silently switch providers out from under the builder, so those propagate
 * as-is (a working provider that failed once is still the builder's chosen
 * provider).
 */
const NON_RETRYABLE_FOR_THIS_PROVIDER = new Set([
  'cli-unauthenticated',
  'cli-not-installed',
  'cli-billing-helper-configured',
  'provider-not-configured',
  'providers-file-mode-unsafe',
]);

/**
 * runModel(opts) — resolve a starting provider via resolveProvider(), then
 * walk PROVIDER_ORDER from there, calling each candidate's OWN runModel()
 * (never a separate detect() pre-check — a provider's runModel() already
 * performs the equivalent authoritative check internally and returns a
 * specific, accurate reason, so a second detect() call would only add a
 * redundant probe without adding information). Falls through to the next
 * provider when the current one's failure reasonCode is in
 * NON_RETRYABLE_FOR_THIS_PROVIDER; when resolveProvider itself found no
 * usable provider at all, the walk starts at PROVIDER_ORDER's beginning so
 * every provider still gets an actual runModel() call and contributes its
 * own reason (not just a single generic "no provider available"). An
 * explicit AUXILO_EXTRACTION_PROVIDER override never falls through — it is
 * the operator's explicit choice, so its own failure reason is reported
 * as-is. When every provider tried is exhausted, returns reasonCode
 * 'no-usable-provider' with a bounded summary of every provider's reason in
 * `reason` (no secrets — each provider's own reason string is already
 * secret-free by contract). Never throws.
 */
async function runModel(opts = {}) {
  const mode = opts.mode === 'judge' ? 'judge' : 'extract';
  const env = opts.env || process.env;
  const override = env.AUXILO_EXTRACTION_PROVIDER;

  if (override) {
    const resolved = await resolveProvider(opts);
    if (!resolved.ok) {
      return {
        ok: false,
        text: '',
        usage: null,
        reasonCode: 'no-model-provider-available',
        reason: resolved.reason,
        authStatus: 'unknown',
      };
    }
    return resolved.module.runModel({ ...opts, mode });
  }

  const log = typeof opts.log === 'function' ? opts.log : console.error;
  const resolved = await resolveProvider(opts);
  const startIdx = resolved.ok ? PROVIDER_ORDER.indexOf(resolved.id) : -1;
  const order = startIdx === -1 ? PROVIDER_ORDER.slice() : PROVIDER_ORDER.slice(startIdx);

  const attempts = [];
  for (const id of order) {
    const mod = PROVIDERS[id];
    // eslint-disable-next-line no-await-in-loop
    const result = await mod.runModel({ ...opts, mode });
    if (result.ok) return result;
    attempts.push({ id, reasonCode: result.reasonCode, reason: result.reason });
    if (!NON_RETRYABLE_FOR_THIS_PROVIDER.has(result.reasonCode)) {
      return result;
    }
    log(`[providers] ${id} unusable (${result.reasonCode}); trying next provider`);
  }

  const summary = attempts
    .map((a) => `${a.id}=${a.reasonCode || 'unknown'}`)
    .join('; ')
    .slice(0, 480);
  const lastAttempt = attempts[attempts.length - 1];
  const lastReason = (lastAttempt && lastAttempt.reason) || resolved.reason || 'no provider available';
  return {
    ok: false,
    text: '',
    usage: null,
    reasonCode: 'no-usable-provider',
    reason: `${lastReason} (tried: ${summary})`.slice(0, 600),
    authStatus: 'unknown',
  };
}

module.exports = {
  runModel,
  resolveProvider,
  PROVIDER_ORDER,
  PROVIDERS_STATE_PATH,
  NON_RETRYABLE_FOR_THIS_PROVIDER,
};
