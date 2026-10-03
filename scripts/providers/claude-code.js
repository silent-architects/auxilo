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
const { invocationGate } = require('./route-binding.js');

/** Leading major.minor.patch only; unreadable versions retain fallback behavior. */
function versionParts(version) {
  const match = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/** Resolve the newest readable CLI — hook/launchd env may have a minimal PATH. */
function resolveClaudeBin(opts = {}) {
  const homeDir = typeof opts.homeDir === 'string' ? opts.homeDir : os.homedir();
  const existsSync = typeof opts.existsSync === 'function' ? opts.existsSync : fs.existsSync;
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  const candidates = [
    path.join(homeDir, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(homeDir, '.local', 'bin', 'claude'),
    path.join(homeDir, '.npm-global', 'bin', 'claude'),
  ];
  // Read directly: the sweeper install does not include lib/installer.js.
  try {
    const config = JSON.parse(readFileSyncImpl(path.join(homeDir, '.auxilo', 'runner-config.json'), 'utf8'));
    const recorded = config && config.claude_bin;
    if (typeof recorded === 'string' && path.isAbsolute(recorded) && path.basename(recorded) === 'claude') {
      candidates.unshift(recorded);
    }
  } catch (_) { /* missing/malformed config means no recorded candidate */ }

  let firstExisting;
  let newest;
  let newestVersion;
  for (const c of candidates) {
    try {
      if (!existsSync(c)) continue;
      if (!firstExisting) firstExisting = c;
      const version = versionParts(getClaudeCliVersion(c, opts));
      if (version && (!newestVersion || compareVersions(version, newestVersion) > 0)) {
        newest = c;
        newestVersion = version;
      }
    } catch (_) { /* ignore */ }
  }
  // Absolute launchd fallbacks are absent; let PATH resolve the final option.
  return newest || firstExisting || 'claude';
}

// ─── Child settings/hooks isolation (EXTRACTION-CHILD-HOOKS, PUNCH-LIST P1,
// 0.9.15) ────────────────────────────────────────────────────────────────
//
// Every `claude -p` extraction child previously loaded the OPERATOR'S OWN
// ~/.claude/settings.json and therefore fired their personal SessionStart
// hooks (mandate.sh, session-context.sh, ...) — output that reaches the
// extraction/judge prompt without ever passing the package's scrubber. That
// is a privacy defect: content from the machine's own hook configuration
// (potentially personal notes, live queries, etc.) enters a transcript that
// gets sent to the resolved provider.
//
// `--setting-sources <sources>` ("Comma-separated list of setting sources to
// load (user, project, local)") is documented on both installed CLIs probed
// during investigation (2.1.12, 2.1.260) — scratchpad hooks-0914/
// EXTRACTION-CHILD-HOOKS-FINDINGS.md. This build (hooks-0915) tested LIVE
// whether an EMPTY list (`--setting-sources ''`) — the narrowest, fully
// cwd-independent value, loading none of user/project/local — is accepted:
// it is (2.1.12, exit 0, hook_response count 0, well-formed result). Shipping
// `''` means no fresh-temp-cwd workaround is needed: an empty source list
// loads nothing regardless of the child's cwd, unlike the `project,local`
// fallback (which still honors a target repo's own `.claude/settings.json`).
const SETTING_SOURCES_VALUE = '';
const SETTING_SOURCES_ARGS = Object.freeze(['--setting-sources', SETTING_SOURCES_VALUE]);

/**
 * Fail-closed detection of "this CLI build doesn't understand
 * --setting-sources at all" (an old install predating the flag, or a rename).
 * Detected from the SAME spawn that already carries the flag — no extra
 * `--help`/`--version` probe call, so the happy-path spawn count for every
 * existing caller/test is unchanged. A CLI rejecting an unknown flag exits
 * non-zero with a message naming the flag (commander.js-style "error:
 * unknown option '--setting-sources'"); this pattern-matches for that
 * specific shape rather than treating every non-zero exit as unsupported (a
 * real model/auth error must NOT be misreported as isolation-unsupported).
 * Cached module-wide for the lifetime of the process ("once per run"): the
 * first spawn that hits this failure marks the CLI unsupported and every
 * subsequent runModel() call in the same process short-circuits BEFORE
 * spawning again — it must never spawn without the flag, and re-attempting a
 * doomed spawn every call would be silent waste, not safety.
 */
let cachedSettingSourcesUnsupported; // undefined = not yet observed; true once detected

function looksLikeUnsupportedSettingSourcesFlag(res) {
  if (!res || res.status === 0) return false;
  const combined = `${String(res.stdout || '')}\n${String(res.stderr || '')}`;
  return /--setting-sources/.test(combined) && /\b(unknown|unrecognized|invalid)\b.{0,20}\b(option|argument|flag)\b/i.test(combined);
}

function settingSourcesIsolationUnsupportedResult(authStatus) {
  return {
    ok: false,
    text: '',
    usage: null,
    reason: 'installed Claude Code CLI does not support --setting-sources; extraction declines to run a child that would load the operator\'s own settings/hooks unisolated',
    reasonCode: 'cli-settings-isolation-unsupported',
    authStatus: authStatus || 'unknown',
  };
}

/** Test-only: reset the module-level isolation-support cache between fixtures. */
function _resetSettingSourcesCacheForTests() {
  cachedSettingSourcesUnsupported = undefined;
}

// ─── CLI version, for selection, auth gating and provenance (no spawn) ──────
//
// Resolves the installed package's own package.json version by following the
// resolved binary's real path (e.g. `/usr/local/bin/claude` -> `.../
// node_modules/@anthropic-ai/claude-code/cli.js`) and reading the sibling
// package.json, or the named parent package for the native bin/claude.exe
// layout — filesystem-only, so it never adds a spawn to the extraction
// path (verified live: realpath + package.json read, no `claude --version`
// call). Best-effort: any failure (bare `claude` unresolved via PATH, an
// install layout that doesn't carry either package.json, a fixture path in
// tests) yields null, never throws.
function getClaudeCliVersion(bin, opts = {}) {
  const realpathSyncImpl = typeof opts.realpathSyncImpl === 'function' ? opts.realpathSyncImpl : fs.realpathSync;
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  try {
    const real = realpathSyncImpl(bin);
    const dir = path.dirname(real);
    for (const [pkgDir, requireName] of [[dir, false], [path.dirname(dir), true]]) {
      try {
        const pkg = JSON.parse(readFileSyncImpl(path.join(pkgDir, 'package.json'), 'utf8'));
        if (pkg && typeof pkg.version === 'string' && (!requireName || pkg.name === '@anthropic-ai/claude-code')) {
          return pkg.version;
        }
      } catch (_) { /* unreadable sibling may still have a valid parent */ }
    }
  } catch {
    /* unresolved binary */
  }
  return null;
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
// Named + frozen so a byte-pinned test (test/extraction-zero-tool-calls.test.js,
// test/claude-code-provider.test.js) can assert the exact argv without
// duplicating the literal, and so a future flag change is a conscious,
// greppable edit here rather than a silent literal tweak buried in the two
// runXMode() functions below. No behavior change: the two spawnSyncImpl()
// call sites below now pass these constants instead of inline array literals
// of the identical contents. 0.9.15 (EXTRACTION-CHILD-HOOKS) appends
// SETTING_SOURCES_ARGS to both — the child loads none of user/project/local
// settings, so the operator's own SessionStart hooks never fire.
// Strict mode with no --mcp-config also excludes account-connected MCP servers.
const EXTRACT_MODE_ARGV = Object.freeze(['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', ...SETTING_SOURCES_ARGS, '--strict-mcp-config']);
const JUDGE_MODE_ARGV = Object.freeze(['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '', ...SETTING_SOURCES_ARGS, '--strict-mcp-config']);

/**
 * Build the subscription-auth-only environment shared by BOTH the extraction and
 * judge Claude CLI children — one function, no drift between the two spawns.
 */
function claudeChildEnv() {
  const childEnv = { ...process.env, AUXILO_EXTRACTING: '1' };
  for (const key of SCRUBBED_CLIENT_ENV_VARS) delete childEnv[key];
  childEnv.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  return childEnv;
}

// A managed-config refusal is observed after spawn. Keep it out of the
// pre-spawn skip and provider-fallback sets; never expose the CLI's message.
function enterpriseMcpRefusal(res, authStatus) {
  if (!Number.isInteger(res.status) || res.status === 0) return null;
  const phrase = 'You cannot use --strict-mcp-config when an enterprise MCP config is present';
  if (![res.stdout, res.stderr].some(value => String(value || '').includes(phrase))) return null;
  return {
    ok: false, text: '', usage: null,
    reason: 'Claude Code refused MCP isolation with managed configuration',
    reasonCode: 'isolation-unverified', authStatus,
  };
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
  const version = versionParts(getClaudeCliVersion(bin, opts));
  // Unknown and old versions can interpret this probe as a model prompt.
  if (!version || compareVersions(version, [2, 1, 41]) < 0) return 'unknown';
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
function runExtractMode(opts) { return runCliMode(opts, 'extract'); }

function decodeWrapper(stdout) {
  let wrapper;
  try { wrapper = JSON.parse(stdout); }
  catch {
    const values = [];
    const lines = stdout.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      let value = lines[i].trim();
      if (value.startsWith('{') || value.startsWith('[')) {
        // Consume the whole container, including pretty-printed extra values.
        // A line-only JSON.parse scan could silently overlook that second value.
        let depth = 0; let quoted = false; let escaped = false; let closed = false;
        const parts = [];
        for (; i < lines.length; i += 1) {
          const line = lines[i]; parts.push(line);
          for (let j = 0; j < line.length; j += 1) {
            const char = line[j];
            if (quoted) {
              if (escaped) escaped = false;
              else if (char === '\\') escaped = true;
              else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === '{' || char === '[') depth += 1;
            else if (char === '}' || char === ']') {
              depth -= 1;
              if (depth === 0) {
                if (line.slice(j + 1).trim()) return { malformed: true };
                closed = true; break;
              }
            }
          }
          if (closed) break;
        }
        if (!closed) return { malformed: true };
        value = parts.join('\n');
        try { values.push(JSON.parse(value)); } catch { return { malformed: true }; }
      } else {
        try { values.push(JSON.parse(value)); } catch { /* non-JSON diagnostic */ }
      }
      if (values.length > 1) return { malformed: true };
    }
    if (values.length !== 1 || !values[0] || values[0].type !== 'result') return { malformed: true };
    [wrapper] = values;
  }
  if (!wrapper || wrapper.type !== 'result' || typeof wrapper.result !== 'string' || wrapper.is_error === true) {
    return { unsuccessful: true, wrapper };
  }
  return { wrapper };
}

function wrapperIdentity(wrapper, cliVersion) {
  const models = [...new Set(Object.values(wrapper.modelUsage || {}).map(entry => entry && entry.canonicalModel)
    .filter(value => typeof value === 'string' && value.trim()))];
  const observed = models.length === 1 ? models[0] : null;
  return { provider: 'claude-code', model: observed, requested_model: null, observed_model: observed,
    version: cliVersion || null, vendor: 'anthropic',
    ...(observed === null && { identity_unresolved: models.length ? 'ambiguous' : 'missing' }) };
}

// Exact production CLI wording (verified 2026-09-27..10-01). Add another alternative only for
// another CONFIRMED real CLI message, never a guessed synonym.
const OAUTH_EXPIRED_PATTERN = /Failed to authenticate:\s*OAuth session expired and could not be refreshed/i;

function runCliMode(opts, mode) {
  const spawn = typeof opts.spawnSyncImpl === 'function' ? opts.spawnSyncImpl : spawnSync;
  const bin = typeof opts.claudeBin === 'string' ? opts.claudeBin : resolveClaudeBin(opts);
  if (cachedSettingSourcesUnsupported) return { ...settingSourcesIsolationUnsupportedResult('unknown'), refusal: 'pre-invocation' };
  const authStatus = mode === 'extract' ? checkAuthStatus({ ...opts, claudeBin: bin }) : 'unknown';
  const authReason = 'local model not authenticated in this context (run `claude auth login` once); skipping deterministic extraction';
  if (authStatus === 'logged-out') return { ok: false, text: '', usage: null, reason: authReason,
    reasonCode: 'cli-unauthenticated', authStatus, refusal: 'pre-invocation' };
  const argv = mode === 'judge' ? JUDGE_MODE_ARGV : EXTRACT_MODE_ARGV;
  const cliVersion = getClaudeCliVersion(bin, opts);
  const meta = { authStatus, argv, cliVersion };
  const fail = (reasonCode, reason) => ({ ok: false, text: '', usage: null, reasonCode, reason, ...meta });
  const gate = invocationGate(opts);
  if (gate) return { ...gate, ...meta };
  let res;
  try {
    res = spawn(bin, argv, {
      input: (typeof opts.prompt === 'string' ? opts.prompt : '') + (mode === 'extract' ? String(opts.input || '').slice(0, 200000) : ''),
      encoding: 'utf-8', env: claudeChildEnv(), timeout: opts.timeoutMs || 120000, maxBuffer: 20 * 1024 * 1024,
    });
  } catch { return fail('unknown', 'local model spawn failed'); }
  if (!res) return fail('unknown', 'local model returned no process result');
  if (looksLikeUnsupportedSettingSourcesFlag(res)) {
    cachedSettingSourcesUnsupported = true;
    return { ...settingSourcesIsolationUnsupportedResult(authStatus), argv, cliVersion };
  }
  if (res.error || (res.signal && res.status === null)) return fail('unknown', 'local model invocation failed');
  const mcp = enterpriseMcpRefusal(res, authStatus);
  if (mcp) return { ...mcp, argv, cliVersion };
  const stdout = String(res.stdout || '');
  const decoded = decodeWrapper(stdout);
  // A wrapper's result is content, never an authentication signal.
  const authPattern = /Please run \/login|authentication_error/i;
  if ((!decoded.wrapper && authPattern.test(stdout)) || authPattern.test(String(res.stderr || ''))) {
    return { ...fail('cli-unauthenticated', authReason), ...(authStatus === 'logged-in' && { authDiscrepancy: true }) };
  }
  // EXT-0806c: an expired, unrefreshable OAuth session exits nonzero with this exact CLI
  // message on either stream. Nonzero exit only, and stdout only when no result wrapper
  // decoded, so a successful run whose own text discusses an auth bug never matches. Like
  // the check above it is a post-spawn outcome: no `refusal`, so it never permits fallback.
  if (Number.isInteger(res.status) && res.status !== 0
    && ((!decoded.wrapper && OAUTH_EXPIRED_PATTERN.test(stdout)) || OAUTH_EXPIRED_PATTERN.test(String(res.stderr || '')))) {
    return { ...fail('cli-unauthenticated', authReason), ...(authStatus === 'logged-in' && { authDiscrepancy: true }) };
  }
  if (res.status !== 0) return fail('model-error', 'local model exited unsuccessfully');
  if (decoded.malformed) return fail('model-error', mode === 'judge' ? 'local judge returned malformed JSON wrapper' : 'local model returned malformed JSON wrapper');
  if (decoded.unsuccessful) return fail('model-error', 'local model returned no successful result');
  return { ok: true, text: decoded.wrapper.result, usage: normalizeJudgeUsage(decoded.wrapper.usage), reason: null,
    ...meta, identity: wrapperIdentity(decoded.wrapper, cliVersion) };
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

/** mode:'judge' — binary anchored-dedup decision. Argv byte-identical to pre-move plus
 * the same --setting-sources '' isolation the extraction spawn above gains (0.9.15). */
function runJudgeMode(opts) { return runCliMode(opts, 'judge'); }

/**
 * runModel(opts) — the provider.interface.js contract. Checks the billing-helper
 * detector BEFORE any auth check or spawn (both modes); mode:'extract' then does
 * its existing pre-spawn auth short-circuit, mode:'judge' spawns directly as it
 * always has (auth failure there is only knowable post-hoc, from the output).
 */
function runModelImpl(opts) {
  if (detectBillingHelperConfigured(opts)) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'a foreign-billing CLI helper is configured — extraction declines to run under it',
      reasonCode: 'cli-billing-helper-configured',
      refusal: 'pre-invocation',
      authStatus: 'unknown',
    };
  }
  const mode = opts.mode === 'judge' ? 'judge' : 'extract';
  return mode === 'judge' ? runJudgeMode(opts) : runExtractMode(opts);
}

async function runModel(opts = {}) {
  try { return runModelImpl(opts); }
  catch { return { ok: false, text: '', usage: null, reasonCode: 'unknown', reason: 'local model invocation failed', authStatus: 'unknown' }; }
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
      refusal: 'pre-invocation',
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
  // test/claude-code-provider.test.js; TRUST-PAGE control — SITE-PM: put the
  // zero-tool-call assertion in the test suite). Carries the 0.9.15 argv
  // (SETTING_SOURCES_ARGS included).
  EXTRACT_MODE_ARGV,
  JUDGE_MODE_ARGV,
  // EXTRACTION-CHILD-HOOKS (0.9.15) — exported for direct unit coverage
  // (test/claude-code-provider.test.js) and for extract-local.js's provider-run
  // log line (getClaudeCliVersion).
  SETTING_SOURCES_VALUE,
  SETTING_SOURCES_ARGS,
  getClaudeCliVersion,
  looksLikeUnsupportedSettingSourcesFlag,
  _resetSettingSourcesCacheForTests,
  OAUTH_EXPIRED_PATTERN,
};
