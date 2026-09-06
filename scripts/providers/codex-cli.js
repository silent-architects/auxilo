'use strict';
/*
 * scripts/providers/codex-cli.js — Codex CLI provider adapter
 * (EXTRACT-PER-CLIENT W1 PART B).
 *
 * Same runModel/detect shape as claude-code.js (this dir's other provider):
 * spawns `codex exec` with the transcript+prompt on stdin, reads the model's
 * answer back out, and never bills Auxilo — the child runs under the
 * builder's own `codex` login (or their own OPENAI_API_KEY, see detect()
 * below), scrubbed of every var that could redirect billing elsewhere.
 *
 * Flags verified live against `codex exec --help` (codex-cli 0.144.5) before
 * this module was written — see BUILD-SPEC-EXTRACT-PER-CLIENT-W1 §1/§6:
 *   -s, --sandbox <read-only|workspace-write|danger-full-access>
 *   --skip-git-repo-check   (codex refuses to run outside a git repo otherwise)
 *   --ephemeral              (no session file left behind)
 *   --ignore-user-config     (don't load ~/.codex/config.toml — auth still
 *                             comes from CODEX_HOME/auth.json regardless)
 *   --output-schema <FILE>   (a JSON-Schema HINT, not a hard parser — see
 *                             schemas/*.schema.json for the shapes)
 *   -o, --output-last-message <FILE>  (where the final answer lands)
 *   [PROMPT] — `-` reads the prompt from stdin instead of argv.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { SCRUBBED_CLIENT_ENV_VARS } = require('./claude-code.js');

const EXTRACTION_SCHEMA_PATH = path.join(__dirname, 'schemas', 'extraction-envelope.schema.json');
const JUDGE_SCHEMA_PATH = path.join(__dirname, 'schemas', 'judge-decisions.schema.json');

/** Resolve the `codex` binary — hook/launchd env may have a minimal PATH. */
function resolveCodexBin(opts = {}) {
  const homeDir = typeof opts.homeDir === 'string' ? opts.homeDir : os.homedir();
  const existsSync = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync;
  const candidates = [
    path.join(homeDir, '.npm-global', 'bin', 'codex'),
    '/usr/local/bin/codex',
    '/opt/homebrew/bin/codex',
    path.join(homeDir, '.local', 'bin', 'codex'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  // No explicit filesystem candidate — let PATH resolve the final option.
  return 'codex';
}

/**
 * Build the subscription/login-only environment for the codex child — the
 * SAME 28-name scrub PART A's claude-code.js established (imported, not
 * duplicated: one list, no drift between providers), PLUS this module never
 * reads or forwards OPENAI_API_KEY itself, even though its presence in the
 * builder's own ~/.codex/auth.json is not disqualifying for detect() (see
 * detect() below) — an env-level OPENAI_API_KEY could silently redirect
 * billing to a DIFFERENT account than the one auth.json names, so it is
 * scrubbed here regardless of source.
 */
function codexChildEnv() {
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  for (const key of SCRUBBED_CLIENT_ENV_VARS) delete childEnv[key];
  delete childEnv.OPENAI_API_KEY;
  return childEnv;
}

/**
 * Read ~/.codex/auth.json and return its `auth_mode` string, or null when the
 * file is missing, unreadable, malformed, or auth_mode is absent/falsy. Never
 * throws. A truthy `OPENAI_API_KEY` alongside a truthy auth_mode is fine and
 * not inspected here — that key bills the BUILDER's own account if codex ever
 * uses it, which zero-inference does not forbid (it forbids Auxilo billing);
 * codexChildEnv() above still scrubs it from what our own child sees.
 */
function readAuthMode(opts = {}) {
  const homeDir = typeof opts.homeDir === 'string' ? opts.homeDir : os.homedir();
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  try {
    const raw = readFileSyncImpl(path.join(homeDir, '.codex', 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.auth_mode === 'string' && parsed.auth_mode) {
      return parsed.auth_mode;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * detect(): true iff BOTH (a) the `codex` binary resolves — an explicit
 * filesystem candidate, or (failing that) a cheap `codex --version` probe
 * confirming PATH actually resolves it — AND (b) ~/.codex/auth.json exists,
 * parses, and has a truthy auth_mode. Both legs required: a binary with no
 * login, or a login with no binary, both mean extraction cannot run.
 */
function detect(opts = {}) {
  if (!readAuthMode(opts)) return false;
  const bin = typeof opts.codexBin === 'string' ? opts.codexBin : resolveCodexBin(opts);
  if (bin !== 'codex') return true; // explicit filesystem candidate found
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  try {
    const res = spawnSyncImpl(bin, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    return Boolean(res && !res.error && res.status === 0);
  } catch {
    return false;
  }
}

// ─── codex --version capture (extraction_model.version) ───────────────────
//
// codex exposes no per-call model identifier (no --json event stream is
// requested here, and -o's last-message file carries prose/schema-shaped
// output only) — the CLI build version is the honest proxy for "which codex
// build ran this extraction". Captured once per process and cached: every
// runModel() call after the first reuses the cached value, so a session that
// calls runModel() twice (extract, then judge) only pays for one version
// probe. `undefined` = not yet probed; `null` = probed, could not determine.
let cachedVersion;

function getCodexVersion(opts = {}) {
  if (cachedVersion !== undefined) return cachedVersion;
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const bin = typeof opts.codexBin === 'string' ? opts.codexBin : resolveCodexBin(opts);
  try {
    const res = spawnSyncImpl(bin, ['--version'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
    cachedVersion = (res && !res.error && res.status === 0) ? String(res.stdout || '').trim() || null : null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/** Test-only: reset the module-level version cache between fixtures. */
function _resetVersionCacheForTests() {
  cachedVersion = undefined;
}

function makeOutputPath(opts, mode) {
  if (typeof opts.outputPath === 'string') return opts.outputPath;
  const rand = crypto.randomBytes(6).toString('hex');
  return path.join(os.tmpdir(), `auxilo-codex-${mode}-${process.pid}-${rand}.txt`);
}

function classifySpawnError(error, bin) {
  if (error && error.code === 'ENOENT') {
    return { reasonCode: 'cli-not-installed', reason: `codex binary not found (${bin}) — run \`npm install -g @openai/codex\` or the platform's install path` };
  }
  if (error && (error.code === 'ETIMEDOUT' || error.code === 'ETIMEOUT')) {
    return { reasonCode: 'cli-timeout', reason: `codex exec timed out (${bin}): ${error.message}` };
  }
  return { reasonCode: 'unknown', reason: `spawn failed (${bin}): ${error ? error.message : 'no process result'}` };
}

/**
 * Shared invocation for both modes: builds argv, spawns, reads the answer
 * back from the `-o` file (falling back to stdout only if that file cannot
 * be read — see module comment on why: --output-last-message's own docs
 * promise a file is written on a normal completion, but say nothing about a
 * crash/timeout/schema-rejection path, so a defensive stdout fallback covers
 * the cases where no file ever landed; text as documented is the file's
 * content and stdout is treated as the exception path, never the default).
 */
function invoke(opts, mode) {
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  const unlinkSyncImpl = typeof opts.unlinkSyncImpl === 'function' ? opts.unlinkSyncImpl : fs.unlinkSync;
  const bin = typeof opts.codexBin === 'string' ? opts.codexBin : resolveCodexBin(opts);

  const authMode = readAuthMode(opts);
  if (!authMode) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'codex CLI is not authenticated in this context (run `codex login` once); skipping deterministic extraction',
      reasonCode: 'cli-unauthenticated',
      authStatus: 'logged-out',
    };
  }

  const schemaFile = mode === 'judge' ? JUDGE_SCHEMA_PATH : EXTRACTION_SCHEMA_PATH;
  const outputPath = makeOutputPath(opts, mode);
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const stdin = prompt + String(opts.input || '');
  const args = [
    'exec',
    '-s', 'read-only',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--output-schema', schemaFile,
    '-o', outputPath,
    '-',
  ];

  let res;
  try {
    res = spawnSyncImpl(bin, args, {
      input: stdin,
      encoding: 'utf-8',
      env: codexChildEnv(),
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const classified = classifySpawnError(error, bin);
    return { ok: false, text: '', usage: null, authStatus: 'unknown', ...classified };
  }
  if (!res) {
    return { ok: false, text: '', usage: null, reason: `spawn failed (${bin}): no process result`, reasonCode: 'unknown', authStatus: 'unknown' };
  }
  if (res.error) {
    const classified = classifySpawnError(res.error, bin);
    return { ok: false, text: '', usage: null, authStatus: 'unknown', ...classified };
  }
  // spawnSync signals a timeout via `signal` (no `error`) when the child was
  // killed for exceeding `timeout` and didn't set its own exit code.
  if (res.signal && res.status === null) {
    return { ok: false, text: '', usage: null, reason: `codex exec timed out (${bin}), signal ${res.signal}`, reasonCode: 'cli-timeout', authStatus: 'unknown' };
  }

  const stdout = String(res.stdout || '');
  if (/not authenticated|not logged in|codex login/i.test(stdout) || /not authenticated|not logged in|codex login/i.test(String(res.stderr || ''))) {
    return { ok: false, text: '', usage: null, reason: 'codex CLI reported it is not authenticated', reasonCode: 'cli-unauthenticated', authStatus: 'unknown' };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: `codex exec exited ${res.status}: ${(stdout || String(res.stderr || '')).slice(0, 160)}`,
      reasonCode: 'model-error',
      authStatus: 'unknown',
    };
  }

  let text;
  let usedStdoutFallback = false;
  try {
    text = String(readFileSyncImpl(outputPath, 'utf8'));
  } catch {
    // --output-last-message's own docs make no promise about a file existing
    // outside a normal completion — fall back to stdout rather than
    // reporting a false failure when codex exited 0 but the file is absent.
    text = stdout;
    usedStdoutFallback = true;
  } finally {
    try { unlinkSyncImpl(outputPath); } catch { /* best-effort cleanup only */ }
  }

  if (!text.trim()) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: usedStdoutFallback
        ? 'codex exec produced no output-last-message file and stdout was empty'
        : 'codex exec produced an empty output-last-message file',
      reasonCode: 'cli-bad-output',
      authStatus: 'unknown',
    };
  }

  return {
    ok: true,
    text,
    usage: null, // the -o file carries no token counts; caller estimates from text length
    reason: null,
    authStatus: 'unknown',
    extraction_model: {
      provider: 'codex-cli',
      model: null, // codex exposes no per-call model id without --json (not requested)
      version: getCodexVersion(opts),
    },
  };
}

/** runModel(opts) — the provider.interface.js contract. */
async function runModel(opts = {}) {
  const mode = opts.mode === 'judge' ? 'judge' : 'extract';
  return invoke(opts, mode);
}

module.exports = {
  runModel,
  detect,
  resolveCodexBin,
  readAuthMode,
  codexChildEnv,
  getCodexVersion,
  EXTRACTION_SCHEMA_PATH,
  JUDGE_SCHEMA_PATH,
  _resetVersionCacheForTests,
};
