'use strict';
/*
 * scripts/providers/claude-code.js — Claude Code provider adapter
 * (EXTRACT-PER-CLIENT W1 PART A, absorbs 0913 PART A / EXTRACT-TOOLS-LOCK).
 *
 * Moved out of scripts/extract-local.js: resolveClaudeBin, checkClaudeAuthStatus,
 * the extraction spawn, and the dedup-judge spawn. Behavior preserved except two
 * deliberate hardenings (PUNCH-LIST EXTRACT-TOOLS-LOCK):
 *   1. The extraction spawn gains `--tools ''` (already true of the judge spawn) —
 *      the model receives prompt+transcript on stdin and needs no tool access.
 *   2. BOTH spawns now share ONE claudeChildEnv() that scrubs every gateway/cloud
 *      billing var (not just ANTHROPIC_API_KEY) — closing the drift where the judge
 *      built its own inline (single-var) env copy.
 * Plus one new gate: a foreign-billing CLI helper (settings.json apiKeyHelper /
 * awsAuthRefresh / awsCredentialExport / gcpAuthRefresh) short-circuits BEFORE any
 * spawn, with reasonCode 'cli-billing-helper-configured' — extraction declines to
 * run under a billing path it cannot audit.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/** Resolve the `claude` binary — hook/launchd env may have a minimal PATH. */
function resolveClaudeBin(opts = {}) {
  const homeDir = typeof opts.homeDir === 'string' ? opts.homeDir : os.homedir();
  const existsSync = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync;
  const candidates = [
    path.join(homeDir, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(homeDir, '.local', 'bin', 'claude'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  // Absolute launchd fallbacks are absent; let PATH resolve the final option.
  return 'claude';
}

// ─── Env scrub (EXTRACT-TOOLS-LOCK, PUNCH-LIST) ────────────────────────────
//
// SME-confirmed list (claude-code-guide, verified against official docs and
// `claude --help` on 2.1.251). Precedence per docs: cloud switches > AUTH_TOKEN >
// API_KEY > apiKeyHelper > OAUTH_TOKEN > profiles > subscription OAuth — every one
// of these wins over the user's login if present, so every one must be scrubbed
// for the child to run on the user's own subscription auth, never a billed path.
const SCRUBBED_CLIENT_ENV_VARS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_MANTLE',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLOUD_ML_REGION',
]);

// ─── Spawn argv (EXTRACTION-ZERO-TOOL-CALLS control) ───────────────────────
//
// Named + frozen so a byte-pinned test (test/extraction-zero-tool-calls.test.js)
// can assert the exact argv without duplicating the literal, and so a future
// flag change is a conscious, greppable edit here rather than a silent literal
// tweak buried in the two runXMode() functions below. No behavior change: the
// two spawnSyncImpl() call sites below now pass these constants instead of
// inline array literals of the identical contents.
const EXTRACT_MODE_ARGV = Object.freeze(['-p', '--no-session-persistence', '--tools', '']);
const JUDGE_MODE_ARGV = Object.freeze(['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '']);

/**
 * Build the subscription-auth-only environment shared by BOTH the extraction and
 * judge Claude CLI children — one function, no drift between the two spawns.
 */
function claudeChildEnv() {
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  for (const key of SCRUBBED_CLIENT_ENV_VARS) delete childEnv[key];
  return childEnv;
}

// ─── Billing-helper detector ────────────────────────────────────────────────
//
// NOT scrubbable via env: settings.json `apiKeyHelper`, `awsAuthRefresh`,
// `awsCredentialExport`, `gcpAuthRefresh` let the CLI shell out for credentials
// at runtime, bypassing the env scrub entirely. We detect and decline rather than
// silently letting an audited-looking run bill through a helper we can't see.
const BILLING_HELPER_KEYS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh'];

function readJsonSafe(filePath, readFileSyncImpl) {
  try {
    const raw = readFileSyncImpl(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function settingsHasBillingHelper(settings) {
  if (!settings || typeof settings !== 'object') return false;
  return BILLING_HELPER_KEYS.some((key) => Boolean(settings[key]));
}

/** Walk upward from `startDir` for the nearest `.claude` directory. Never throws. */
function findNearestProjectClaudeDir(startDir, existsSyncImpl) {
  try {
    let dir = startDir;
    // Bounded by the filesystem root — dirname(dir) === dir terminates the walk.
    for (let i = 0; i < 1024; i += 1) {
      const candidate = path.join(dir, '.claude');
      if (existsSyncImpl(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

// Enterprise/organization "managed settings" (EXTRACT-PER-CLIENT W1 FIX
// GOV-3 item 6). These outrank every one of ~/.claude/settings.json and the
// project settings.json/settings.local.json above, AND are loaded by
// headless (`-p`) sessions — the exact case this detector exists for. A
// managed apiKeyHelper would bill a foreign account while the detector
// reported "no helper" if these paths were never checked. Paths verified
// live against the Claude Code SME + official docs:
//   https://code.claude.com/docs/en/managed-settings#choose-a-delivery-mechanism
// ("File-based: managed-settings.json ... in the system directory:
// /Library/Application Support/ClaudeCode/ on macOS, /etc/claude-code/ on
// Linux and WSL, and C:\Program Files\ClaudeCode\ on Windows.")
const MANAGED_SETTINGS_PATH_BY_PLATFORM = Object.freeze({
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-settings.json',
  // linux, and everything else this repo runs tests on (WSL is a Linux
  // filesystem for this purpose per the doc above) — the Linux path.
  linux: '/etc/claude-code/managed-settings.json',
});

function managedSettingsPathForPlatform(opts) {
  // opts.managedSettingsPath is a direct test-injection seam (this path
  // otherwise names a fixed, real, OS-level location no test should touch).
  if (typeof opts.managedSettingsPath === 'string') return opts.managedSettingsPath;
  const platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
  // EXTRACTION-LOW-FOLLOWUPS item 1: a raw `[platform]` index is reachable
  // (only via the test seam opts.platform, per the row) with a prototype key
  // ('constructor', 'toString', '__proto__', …) and would return a truthy
  // Object.prototype value instead of falling through to the Linux default —
  // fails OPEN with a bogus path silently in place of the real managed-
  // settings check. hasOwnProperty scopes the lookup to the object's own
  // enumerable keys, mirroring the guard at scripts/providers/index.js:139,
  // so an unknown or prototype-polluting key falls CLOSED to the Linux path
  // exactly like any other unrecognized platform string does today.
  if (Object.prototype.hasOwnProperty.call(MANAGED_SETTINGS_PATH_BY_PLATFORM, platform)) {
    return MANAGED_SETTINGS_PATH_BY_PLATFORM[platform];
  }
  return MANAGED_SETTINGS_PATH_BY_PLATFORM.linux;
}

/**
 * Managed settings get a STRICTER read than the user/project files below:
 * present-but-unreadable (EACCES, a policy file this account can't open) or
 * present-but-unparseable is NOT treated as "no helper" — it fails CLOSED
 * (helper-configured = true), because we cannot verify a policy file we know
 * exists. (User/project settings.json stay fail-open on malformed content —
 * see the module's "malformed settings.json is treated as no helper" note;
 * that matches Claude Code's own behavior for those files, which this
 * managed path does not share.)
 */
function managedSettingsBlocksOrUnverifiable(filePath, existsSyncImpl, readFileSyncImpl, log) {
  let exists;
  try {
    exists = existsSyncImpl(filePath);
  } catch {
    exists = false;
  }
  if (!exists) return false;
  const parsed = readJsonSafe(filePath, readFileSyncImpl);
  if (parsed === null) {
    // EXTRACTION-LOW-FOLLOWUPS item 3: this fail-closed branch silently
    // switches the builder away from claude-code (reasonCode
    // 'cli-billing-helper-configured', same as a real detected helper) with
    // no visible signal that the cause was an UNVERIFIABLE managed-settings
    // file rather than an actual foreign-billing helper. One stderr line
    // naming the reason code — never the file's contents or any key
    // material, both of which stay out of every log call in this module.
    log('[providers] managed-settings.json is present but unreadable/unparseable; failing closed and switching away from claude-code (reasonCode cli-billing-helper-configured)');
    return true; // present but unreadable/unparseable — fail closed
  }
  return settingsHasBillingHelper(parsed);
}

/**
 * true iff `~/.claude/settings.json`, the nearest project
 * `.claude/settings.json`/`.claude/settings.local.json` upward from cwd, OR
 * this platform's managed-settings.json (see above) has a truthy
 * apiKeyHelper/awsAuthRefresh/awsCredentialExport/gcpAuthRefresh — or the
 * managed file exists but could not be verified. Never throws —
 * missing/malformed USER/PROJECT files are treated as "no helper configured"
 * (matches the CLI's own fail-open behavior there); an unreadable/malformed
 * MANAGED file is NOT — see managedSettingsBlocksOrUnverifiable above.
 */
function detectBillingHelperConfigured(opts = {}) {
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  const existsSyncImpl = typeof opts.existsSyncImpl === 'function' ? opts.existsSyncImpl : fs.existsSync;
  const homeDir = typeof opts.homeDir === 'string' ? opts.homeDir : os.homedir();
  const cwd = typeof opts.cwd === 'string' ? opts.cwd : process.cwd();
  const log = typeof opts.log === 'function' ? opts.log : console.error;

  if (managedSettingsBlocksOrUnverifiable(managedSettingsPathForPlatform(opts), existsSyncImpl, readFileSyncImpl, log)) {
    return true;
  }

  const filesToCheck = [path.join(homeDir, '.claude', 'settings.json')];
  const projectClaudeDir = findNearestProjectClaudeDir(cwd, existsSyncImpl);
  if (projectClaudeDir) {
    filesToCheck.push(path.join(projectClaudeDir, 'settings.json'));
    filesToCheck.push(path.join(projectClaudeDir, 'settings.local.json'));
  }

  for (const filePath of filesToCheck) {
    if (settingsHasBillingHelper(readJsonSafe(filePath, readFileSyncImpl))) return true;
  }
  return false;
}

/**
 * Ask Claude Code for its authoritative local auth state. Only the boolean
 * `loggedIn` field is classified; every other outcome is 'unknown' so callers can
 * fall through to the real model invocation as the classifier of record.
 */
function checkAuthStatus(opts = {}) {
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const bin = typeof opts.claudeBin === 'string' ? opts.claudeBin : resolveClaudeBin(opts);
  let res;
  try {
    res = spawnSyncImpl(bin, ['auth', 'status'], {
      encoding: 'utf-8',
      env: claudeChildEnv(),
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return 'unknown';
  }
  if (!res || res.error || res.status !== 0) return 'unknown';
  try {
    const status = JSON.parse(String(res.stdout || ''));
    if (!status || typeof status.loggedIn !== 'boolean') return 'unknown';
    return status.loggedIn ? 'logged-in' : 'logged-out';
  } catch {
    return 'unknown';
  }
}

/**
 * detect(): "usable now", not merely "installed" (EXTRACT-PER-CLIENT W1 FIX,
 * PUNCH-LIST P1). Two bugs fixed here:
 *   1. A resolved filesystem candidate used to short-circuit straight to
 *      `true` with NO auth check at all — a stale, logged-out install still
 *      "detected". Now the auth check ALWAYS runs, regardless of how the
 *      binary was found.
 *   2. The PATH-fallback branch returned `status !== 'unknown'`, which is
 *      true for BOTH 'logged-in' AND 'logged-out' — only 'unknown' (auth
 *      state could not be determined) read as unusable. That is backwards:
 *      'unknown' cannot PROVE the builder is logged out, so the real call is
 *      the classifier of record (see runExtractMode's own pre-spawn check);
 *      'logged-out' is the one status detect() can act on with confidence.
 * true iff: the billing-helper detector does NOT fire (a foreign-billing
 * helper is a skip, not a usable provider — see detectBillingHelperConfigured
 * above) AND auth status is 'logged-in' or 'unknown' (never 'logged-out').
 */
function detect(opts = {}) {
  if (detectBillingHelperConfigured(opts)) return false;
  const bin = resolveClaudeBin(opts);
  const status = checkAuthStatus({ ...opts, claudeBin: bin });
  return status === 'logged-in' || status === 'unknown';
}

/**
 * mode:'extract' — draft learnings from a transcript. Sync (no I/O the caller
 * needs to await beyond the spawn itself); `runModel` wraps it in a resolved
 * Promise, per the provider.interface.js contract.
 */
function runExtractMode(opts) {
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const bin = typeof opts.claudeBin === 'string' ? opts.claudeBin : resolveClaudeBin(opts);
  const authStatus = checkAuthStatus({ spawnSyncImpl, claudeBin: bin, ...opts });
  if (authStatus === 'logged-out') {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'local model not authenticated in this context (run `claude auth login` once); skipping deterministic extraction',
      reasonCode: 'cli-unauthenticated',
      authStatus,
    };
  }
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const stdin = prompt + String(opts.input || '').slice(0, 200000);
  let res;
  try {
    // --no-session-persistence (EXTRACT-PER-CLIENT W1 FIX GIVENS): matches the
    // judge spawn below — an extraction run leaves no session file behind either.
    res = spawnSyncImpl(bin, EXTRACT_MODE_ARGV, {
      input: stdin,
      encoding: 'utf-8',
      env: claudeChildEnv(),
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, text: '', usage: null, reason: `spawn failed (${bin}): ${error.message}`, reasonCode: 'unknown', authStatus };
  }
  if (!res) {
    return { ok: false, text: '', usage: null, reason: `spawn failed (${bin}): no process result`, reasonCode: 'unknown', authStatus };
  }
  const out = String(res.stdout || '');
  if (res.error) {
    return { ok: false, text: '', usage: null, reason: `spawn failed (${bin}): ${res.error.message}`, reasonCode: 'unknown', authStatus };
  }
  // Claude prints auth failures ("API Error: 401 ... Please run /login") to stdout.
  if (/Please run \/login|authentication_error|401/i.test(out) || /Please run \/login|authentication_error/i.test(String(res.stderr || ''))) {
    return {
      ok: false,
      text: out,
      usage: null,
      reason: 'local model not authenticated in this context (run `claude auth login` once); skipping deterministic extraction',
      reasonCode: 'cli-unauthenticated',
      authStatus,
      ...(authStatus === 'logged-in' && { authDiscrepancy: true }),
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      text: out,
      usage: null,
      reason: `local model exited ${res.status}: ${(out || String(res.stderr || '')).slice(0, 160)}`,
      reasonCode: 'model-error',
      authStatus,
    };
  }
  return { ok: true, text: out, usage: null, reason: null, authStatus };
}

/**
 * Normalize Claude/Anthropic's raw wrapper.usage (input_tokens, output_tokens,
 * cache_creation_input_tokens, cache_read_input_tokens) into the provider
 * contract's {input_tokens, output_tokens} shape. Cache tokens fold into
 * input_tokens (unchanged summing logic from the pre-move judgeUsage). Returns
 * null when no usable numbers are present — the caller (extract-local.js) does
 * its own text-length estimate fallback in that case, generically, for whichever
 * provider ran.
 */
function normalizeJudgeUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const directInput = Number(rawUsage.input_tokens) || 0;
  const cacheCreation = Number(rawUsage.cache_creation_input_tokens) || 0;
  const cacheRead = Number(rawUsage.cache_read_input_tokens) || 0;
  const output = Number(rawUsage.output_tokens) || 0;
  const inputSum = directInput + cacheCreation + cacheRead;
  if (!inputSum && !output) return null;
  return { input_tokens: inputSum, output_tokens: output };
}

/** mode:'judge' — binary anchored-dedup decision. Argv byte-identical to pre-move. */
function runJudgeMode(opts) {
  const spawnSyncImpl = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const bin = typeof opts.claudeBin === 'string' ? opts.claudeBin : resolveClaudeBin(opts);
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  let res;
  try {
    res = spawnSyncImpl(bin, JUDGE_MODE_ARGV, {
      input: prompt,
      encoding: 'utf8',
      env: claudeChildEnv(),
      timeout: opts.timeoutMs || 120000,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    return { ok: false, text: '', usage: null, reason: `judge spawn failed (${bin}): ${error.message}`, reasonCode: 'unknown', authStatus: 'unknown' };
  }
  if (!res) {
    return { ok: false, text: '', usage: null, reason: `judge spawn failed (${bin}): no process result`, reasonCode: 'unknown', authStatus: 'unknown' };
  }
  const stdout = String(res.stdout || '');
  if (res.error) {
    return { ok: false, text: '', usage: null, reason: `judge spawn failed (${bin}): ${res.error.message}`, reasonCode: 'unknown', authStatus: 'unknown' };
  }
  if (/Please run \/login|authentication_error|401/i.test(stdout) || /Please run \/login|authentication_error/i.test(String(res.stderr || ''))) {
    return { ok: false, text: '', usage: null, reason: 'local judge model is not authenticated', reasonCode: 'cli-unauthenticated', authStatus: 'unknown' };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: `local judge exited ${res.status}: ${(stdout || String(res.stderr || '')).slice(0, 160)}`,
      reasonCode: 'model-error',
      authStatus: 'unknown',
    };
  }
  let wrapper;
  try {
    wrapper = JSON.parse(stdout);
  } catch {
    return { ok: false, text: '', usage: null, reason: 'local judge returned malformed JSON wrapper', reasonCode: 'model-error', authStatus: 'unknown' };
  }
  if (!wrapper || typeof wrapper.result !== 'string' || wrapper.is_error === true) {
    return { ok: false, text: '', usage: null, reason: 'local judge returned no successful result', reasonCode: 'model-error', authStatus: 'unknown' };
  }
  return { ok: true, text: wrapper.result, usage: normalizeJudgeUsage(wrapper.usage), reason: null, authStatus: 'unknown' };
}

/**
 * runModel(opts) — the provider.interface.js contract. Checks the billing-helper
 * detector BEFORE any auth check or spawn (both modes); mode:'extract' then does
 * its existing pre-spawn auth short-circuit, mode:'judge' spawns directly as it
 * always has (auth failure there is only knowable post-hoc, from the output).
 */
async function runModel(opts = {}) {
  if (detectBillingHelperConfigured(opts)) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'a foreign-billing CLI helper is configured — extraction declines to run under it',
      reasonCode: 'cli-billing-helper-configured',
      authStatus: 'unknown',
    };
  }
  const mode = opts.mode === 'judge' ? 'judge' : 'extract';
  return mode === 'judge' ? runJudgeMode(opts) : runExtractMode(opts);
}

/**
 * Legacy-shaped synchronous entry point — extractWithClaudeCode(transcript, opts).
 * Kept (not deleted) because test/ext-0806b-silent-skip.test.js imports it
 * directly from scripts/extract-local.js (which re-exports it from here) and
 * exercises its exact auth short-circuit / reason-code behavior. Implemented as a
 * direct call into the same runExtractMode() runModel() itself uses — no drift
 * between the two entry points, including the billing-helper gate.
 */
function extractWithClaudeCode(transcript, opts = {}) {
  if (detectBillingHelperConfigured(opts)) {
    return {
      ok: false,
      out: '',
      reason: 'a foreign-billing CLI helper is configured — extraction declines to run under it',
      reasonCode: 'cli-billing-helper-configured',
      authStatus: 'unknown',
    };
  }
  const result = runExtractMode({ ...opts, input: transcript });
  return {
    ok: result.ok,
    out: result.text,
    reason: result.reason,
    reasonCode: result.reasonCode,
    authStatus: result.authStatus,
    ...(result.authDiscrepancy !== undefined && { authDiscrepancy: result.authDiscrepancy }),
  };
}

/** Legacy name preserved for direct re-export (test/ext-0806b-silent-skip.test.js). */
const checkClaudeAuthStatus = checkAuthStatus;

module.exports = {
  runModel,
  detect,
  checkAuthStatus,
  // Legacy-shaped re-exports (extract-local.js forwards these; tests import them
  // directly from extract-local.js's module.exports, per source discipline: grep
  // confirmed no other consumer needs invokeJudgeWithClaudeCode/judgeUsage moved
  // this way, so those two are NOT re-exported — no dead surface carried).
  extractWithClaudeCode,
  checkClaudeAuthStatus,
  resolveClaudeBin,
  // Exported for direct unit coverage (test/claude-code-provider.test.js) and for
  // bin/auxilo-cli.js's cmdStatus provider line.
  claudeChildEnv,
  SCRUBBED_CLIENT_ENV_VARS,
  detectBillingHelperConfigured,
  // Exported for direct unit coverage (test/extract-w1-fix2.test.js, GOV-3 item 6).
  managedSettingsPathForPlatform,
  MANAGED_SETTINGS_PATH_BY_PLATFORM,
  // Exported for direct byte-pinned coverage (test/extraction-zero-tool-calls.test.js,
  // TRUST-PAGE control — SITE-PM: put the zero-tool-call assertion in the test suite).
  EXTRACT_MODE_ARGV,
  JUDGE_MODE_ARGV,
};
