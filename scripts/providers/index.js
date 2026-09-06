'use strict';
/*
 * scripts/providers/index.js — provider registry + selection
 * (EXTRACT-PER-CLIENT W1 PART A).
 *
 * Selection order: AUXILO_EXTRACTION_PROVIDER env override (wins unconditionally,
 * never persisted — "wins, never writes") → else the first provider whose
 * detect() is true, in fixed order (claude-code → codex-cli → byo-key) → else
 * null, with a reason naming every provider tried (the PART A slice of "loud
 * terminal state"; full enumeration completes with PART B/C).
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

const PROVIDERS_STATE_PATH = path.join(os.homedir(), '.auxilo', 'providers.json');

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
 */
function persistSelected(providerId, opts) {
  const statePath = opts.providersStatePath || PROVIDERS_STATE_PATH;
  try {
    const state = readProvidersState(statePath);
    state.selected = providerId;
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, statePath);
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

/** runModel(opts) — resolve a provider, then delegate. Never throws. */
async function runModel(opts = {}) {
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
  return resolved.module.runModel({ ...opts, mode: opts.mode === 'judge' ? 'judge' : 'extract' });
}

module.exports = {
  runModel,
  resolveProvider,
  PROVIDER_ORDER,
  PROVIDERS_STATE_PATH,
};
