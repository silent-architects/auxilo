'use strict';
/*
 * scripts/providers/byo-key.js — BYO (bring-your-own) provider-key adapter
 * (EXTRACT-PER-CLIENT W1 PART C).
 *
 * The builder's OWN key against an OpenAI-compatible chat-completions
 * endpoint, or one of two thin payload variants (Anthropic Messages, Gemini
 * generateContent) — selected by the `provider` field stored in
 * ~/.auxilo/providers.json's `byo` object (the SAME file
 * scripts/providers/index.js persists auto-detected `selected` into — one
 * file, not two). Auxilo never sees this key: it is read from disk, used for
 * exactly one outbound HTTP call, and never logged.
 *
 * providers.json shape (0600):
 *   {
 *     "selected": "byo-key",             // written by index.js, untouched here
 *     "byo": {
 *       "provider": "openai"|"anthropic"|"gemini"|<custom>,
 *       "base_url": "https://...",       // optional; vendor default if absent
 *       "model": "gpt-4o-mini",
 *       "api_key": "sk-..."
 *     }
 *   }
 *
 * Routing: provider 'anthropic' -> Anthropic Messages; provider 'gemini' ->
 * Gemini generateContent; anything else (including 'openai' and any custom
 * label with a custom base_url) -> the OpenAI-compatible chat-completions
 * shape. `vendor` in the returned identity is always one of
 * 'openai-compatible'|'anthropic'|'gemini' (the wire shape actually used),
 * distinct from the free-form stored `provider` label.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** Same literal value as scripts/providers/index.js's PROVIDERS_STATE_PATH —
 * duplicated (not imported) to avoid a circular require (index.js loads this
 * module dynamically via loadOptionalProvider). test/byo-key-provider.test.js
 * pins the two paths equal.
 *
 * TEST-HOME-ISOLATION: `AUXILO_HOME`, when set, wins over `os.homedir()` —
 * a dedicated override for auxilo's own state directory, distinct from the
 * general-purpose `HOME` every other os.homedir()-based path in this repo
 * reads (settings.json, the VERSION stamp, credentials.json, ...). Per-call
 * `opts.providersStatePath` (every test in this repo passes one) still wins
 * over BOTH — this only narrows what an omitted opts falls back to, closing
 * the gap that let a bare `bin/auxilo-cli.js provider status|clear` call (no
 * opts seam of its own — see cmdProvider in bin/auxilo-cli.js) or any future
 * test that forgets its own override reach the real ~/.auxilo/providers.json
 * (TEST-HOME-ISOLATION incident, 2026-09-06). Evaluated once at module load,
 * same as before — every entry point that cares (scripts/test/run-isolated.js
 * for `npm test`, scripts/check-test-count.sh for the CI gate) sets both
 * AUXILO_HOME and HOME before node starts, so this still resolves correctly
 * even though it's a frozen constant, not a per-call lookup. */
const DEFAULT_PROVIDERS_STATE_PATH = path.join(process.env.AUXILO_HOME || os.homedir(), '.auxilo', 'providers.json');

const VENDOR_DEFAULT_BASE_URL = Object.freeze({
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': 'https://api.openai.com/v1',
});

const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

function statePath(opts = {}) {
  return opts.providersStatePath || DEFAULT_PROVIDERS_STATE_PATH;
}

/**
 * true iff `target` did not resolve to an absolute path (EXTRACT-PER-CLIENT
 * W1 FIX GOV-3 item 13). `os.homedir()` can — rarely — return `''` (HOME/
 * USERPROFILE unset and the OS lookup fails); DEFAULT_PROVIDERS_STATE_PATH
 * is a plain `path.join(os.homedir(), ...)` module constant, so that failure
 * mode silently turns it into a RELATIVE path under the process's cwd — in
 * this repo, a public git tree. Every entry point that touches
 * providers.json (read, write, or clear) checks this first and refuses
 * rather than guess a location, with reasonCode 'provider-home-unresolved'.
 * A caller-supplied `opts.providersStatePath` (every test in this repo, and
 * any future explicit override) is never subject to this — the caller
 * chose that path deliberately.
 */
function isHomeUnresolved(target) {
  return typeof target !== 'string' || !target || !path.isAbsolute(target);
}

/**
 * true iff something already sits at `target` and it is NOT a plain regular
 * file owned by this process's own uid (EXTRACTION-LOW-FOLLOWUPS item 4).
 * Guards the pre-rename chmod below: chmod follows symlinks, so a planted
 * symlink at `target` (pointing at, say, another account's file, or a
 * device node) would previously get its chmod(0600) applied to whatever it
 * points at, not to providers.json itself — same-uid threat model only
 * (matches item 2's TOCTOU acceptance above), but a fail-closed lstat is a
 * one-line guard against it. ENOENT (nothing there yet) is safe — the write
 * below creates it fresh with O_EXCL. Any other stat failure, a non-file
 * (symlink/dir/fifo/device), or a foreign owner all fail CLOSED (refuse),
 * never silently proceed.
 */
function isUnsafeExistingTarget(target, opts = {}) {
  const lstatSyncImpl = typeof opts.lstatSyncImpl === 'function' ? opts.lstatSyncImpl : fs.lstatSync;
  let stat;
  try {
    stat = lstatSyncImpl(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false; // nothing there — nothing to protect
    return true; // cannot verify what's there — fail closed
  }
  if (!stat.isFile()) return true; // symlink, directory, fifo, device, … — never chmod/rename onto it
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return true; // foreign owner
  return false;
}

/**
 * ONE writer for every providers.json write (EXTRACT-PER-CLIENT W1 FIX
 * GOV-3 item 1 + should-fix item 9) — writeByoConfig, clearProvidersFile,
 * AND scripts/providers/index.js's persistSelected all route through this,
 * so there is exactly one place that gets the tmp+rename+chmod discipline
 * right instead of three independent (and, before this fix, drifted) copies
 * of it. Discipline, in order:
 *   1. mkdir the parent dir 0700 (idempotent).
 *   2. lstat whatever already sits at `target` and refuse (reasonCode
 *      'provider-state-target-unsafe') if it exists and is not a regular
 *      file owned by this uid (EXTRACTION-LOW-FOLLOWUPS item 4) — checked
 *      BEFORE the chmod below, which would otherwise follow a planted
 *      symlink.
 *   3. If a file already sits at `target`, chmod it 0600 BEFORE the
 *      rename lands (belt-and-suspenders — the post-rename chmod below is
 *      the one that actually matters for a stale `.tmp`).
 *   4. Unlink any leftover `${target}.tmp` first (a crashed prior run, or a
 *      planted symlink), THEN create it fresh with `flag:'wx'` (O_EXCL) —
 *      refuses to silently reuse or follow anything already at that path.
 *   5. Atomic rename tmp -> target.
 *   6. chmodSync(target, 0o600) AFTER the rename. This is the literal fix
 *      for GOV-3 finding 1: writeFileSync's `mode` option only applies on
 *      CREATION, so a stale `.tmp` that survived a crash at 0644 would
 *      rename onto `target` and KEEP 0644, silently falsifying the
 *      "readable only by your user account" consent promise. The old
 *      `persistSelected` (scripts/providers/index.js) had this exact gap;
 *      this writer closes it everywhere at once.
 * Throws (does not swallow) when the home directory could not be resolved
 * (isHomeUnresolved) or the existing target is unsafe (reasonCode
 * 'provider-state-target-unsafe') — callers decide how to surface that; see
 * writeByoConfig/clearProvidersFile below and cmdProvider in
 * bin/auxilo-cli.js, which catches this rather than let a raw stack out
 * (should-fix item 10).
 */
function writeProvidersStateAtomic(state, opts = {}) {
  const target = statePath(opts);
  if (isHomeUnresolved(target)) {
    const err = new Error('cannot resolve ~/.auxilo/providers.json — the home directory did not resolve to an absolute path');
    err.reasonCode = 'provider-home-unresolved';
    throw err;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (isUnsafeExistingTarget(target, opts)) {
    const err = new Error('refusing to write ~/.auxilo/providers.json — an existing entry at that path is not a regular file owned by this account (possible symlink or foreign owner)');
    err.reasonCode = 'provider-state-target-unsafe';
    throw err;
  }
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  const tmp = `${target}.tmp`;
  try { fs.unlinkSync(tmp); } catch { /* nothing there, or already gone — fine either way */ }
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600); // the fix: applies even when the rename source was a stale, wider-mode tmp.
  return target;
}

/** Read ~/.auxilo/providers.json. Never throws; missing/malformed -> {}. */
function readProvidersState(opts = {}) {
  try {
    const raw = fs.readFileSync(statePath(opts), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The `byo` object, or null when absent/malformed/incomplete. */
function readByoConfig(opts = {}) {
  const state = readProvidersState(opts);
  const byo = state.byo;
  if (!byo || typeof byo !== 'object' || Array.isArray(byo)) return null;
  if (typeof byo.provider !== 'string' || !byo.provider) return null;
  if (typeof byo.model !== 'string' || !byo.model) return null;
  if (typeof byo.api_key !== 'string' || !byo.api_key) return null;
  return {
    provider: byo.provider,
    base_url: typeof byo.base_url === 'string' && byo.base_url ? byo.base_url : null,
    model: byo.model,
    api_key: byo.api_key,
  };
}

/**
 * Write the `byo` object into providers.json, preserving every other
 * top-level key (notably `selected`, written by index.js). 0600 tmp+rename —
 * mirrors lib/installer.js's writeCredentials discipline (that module is not
 * imported here to keep this file's dependency surface HTTP/fs-only, per
 * source discipline; the discipline itself — chmod-then-tmp-write-then-
 * rename, both 0600 — is copied, not the code).
 *
 * Throws a tagged error (writeProvidersStateAtomic) on 'provider-home-
 * unresolved' OR, since EXTRACTION-LOW-FOLLOWUPS item 4, on
 * 'provider-state-target-unsafe' (an existing entry at the target path is
 * a symlink or owned by a different uid) — cmdProvider in bin/auxilo-cli.js
 * catches both rather than let a raw stack out.
 *
 * @param {{provider:string, base_url?:string|null, model:string, api_key:string}} byoConfig
 */
function writeByoConfig(byoConfig, opts = {}) {
  const state = readProvidersState(opts);
  state.byo = {
    provider: byoConfig.provider,
    ...(byoConfig.base_url && { base_url: byoConfig.base_url }),
    model: byoConfig.model,
    api_key: byoConfig.api_key,
  };
  return writeProvidersStateAtomic(state, opts);
}

/**
 * `clear` removes only the BYO credentials (the `byo` object) from
 * providers.json — per spec, the `selected` field (written by
 * scripts/providers/index.js's auto-detect path) is preserved, so clearing
 * a BYO key never silently reverts or loses the account's auto-detected
 * provider choice. (W1 integration: this replaces the narrower "delete the
 * whole file" behavior PART C shipped as a flagged deviation.)
 *
 * If nothing is left after `byo` is removed (an empty object — no
 * `selected` and nothing else was ever stored there), the file itself is
 * removed rather than leaving an empty `{}` on disk. Otherwise the file is
 * rewritten with `byo` gone via the same 0600 tmp+rename discipline as
 * writeByoConfig. Never throws.
 *
 * `target` is checked for home-dir resolution before anything else
 * (GOV-3 item 13) — an unresolved home directory returns 'unresolved'
 * rather than guess a location to read/write. A stat/read failure other
 * than ENOENT (e.g. EACCES) returns 'unreadable' rather than rethrow — this
 * function's contract really is "never throws" now (should-fix item 10; the
 * old rethrow on non-ENOENT contradicted this same docblock). The rewrite
 * path below can now also throw (writeProvidersStateAtomic's
 * 'provider-state-target-unsafe', EXTRACTION-LOW-FOLLOWUPS item 4) — caught
 * here too, folded into 'unreadable', so this function's own "never throws"
 * contract holds regardless of what writeProvidersStateAtomic does.
 *
 * @returns {'removed-file'|'removed-byo'|'noop'|'unreadable'|'unresolved'}
 *   'noop' covers both "no file" and "a file with no `byo` key to clear".
 */
function clearProvidersFile(opts = {}) {
  const target = statePath(opts);
  if (isHomeUnresolved(target)) return 'unresolved';
  const readFileSyncImpl = typeof opts.readFileSyncImpl === 'function' ? opts.readFileSyncImpl : fs.readFileSync;
  let raw;
  try {
    raw = readFileSyncImpl(target, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'noop';
    return 'unreadable'; // e.g. EACCES — cannot verify contents; never throws (contract)
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return 'noop'; // malformed JSON — nothing safely parseable to preserve or clear
  }
  if (!state || typeof state !== 'object' || Array.isArray(state) || !('byo' in state)) {
    return 'noop';
  }
  delete state.byo;
  if (Object.keys(state).length === 0) {
    try {
      fs.unlinkSync(target);
    } catch {
      return 'unreadable'; // cannot remove it either — never throws (contract)
    }
    return 'removed-file';
  }
  try {
    writeProvidersStateAtomic(state, opts);
  } catch {
    return 'unreadable'; // e.g. provider-state-target-unsafe — never throws (contract)
  }
  return 'removed-byo';
}

/** Routing: which wire vendor a stored `provider` label maps to. */
function resolveVendor(providerLabel) {
  if (providerLabel === 'anthropic') return 'anthropic';
  if (providerLabel === 'gemini') return 'gemini';
  return 'openai-compatible';
}

function baseUrlFor(vendor, configured) {
  if (configured) return configured.replace(/\/+$/, '');
  return VENDOR_DEFAULT_BASE_URL[vendor];
}

/**
 * "Owner-read-only" predicate (EXTRACT-PER-CLIENT W1 FIX, PUNCH-LIST P1) —
 * the runtime twin of bin/auxilo-cli.js's `providersFileModeUnsafe`, which
 * only ever ran once, interactively, before `provider set` first wrote the
 * file. That left a gap: if providers.json widens (a stray `chmod`, a
 * umask surprise, manual editing) AFTER setup, detect()/runModel() would
 * still call it "installed" and hand the builder's key to a spawn/fetch
 * under insecure permissions. Duplicated (not imported) for the same reason
 * DEFAULT_PROVIDERS_STATE_PATH above is duplicated — avoids a circular
 * require, since bin/auxilo-cli.js requires this module, not the reverse.
 * No file yet is not unsafe (writeByoConfig always writes 0600 itself); any
 * OTHER stat failure (e.g. EACCES) fails CLOSED (treated as unsafe) rather
 * than silently trusting a permission state it could not verify. Never
 * throws.
 */
function isProvidersFileModeUnsafe(opts = {}) {
  // EXTRACTION-LOW-FOLLOWUPS item 2 (TOCTOU, accepted on the record): a
  // window exists between this check and readByoConfig()'s read below; only the same uid could win that race, and that uid already owns the key on disk, so it is accepted rather than replaced with an fd-based check-then-read.
  const target = statePath(opts);
  if (isHomeUnresolved(target)) return true; // can't even name the file — fail closed
  const statSyncImpl = typeof opts.statSyncImpl === 'function' ? opts.statSyncImpl : fs.statSync;
  let stat;
  try {
    stat = statSyncImpl(target);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    return true; // cannot verify permissions — fail closed, not open
  }
  return (stat.mode & 0o077) !== 0;
}

/** true iff the configured base_url is present and is NOT https:// (GOV-3
 * item 3 — a plaintext endpoint would send the transcript, and for two of
 * the three vendors the key itself, in cleartext). An absent base_url is
 * fine — the vendor default is always https (VENDOR_DEFAULT_BASE_URL). */
function isBaseUrlInsecure(baseUrl) {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).protocol !== 'https:';
  } catch {
    return true; // unparseable — treat as insecure, not as "no opinion"
  }
}

/** detect(): true iff a complete BYO config is on disk, its file is
 * actually owner-read-only, the home directory resolved, and any configured
 * base_url is https:// — "usable now", not merely "configured once". */
function detect(opts = {}) {
  if (isHomeUnresolved(statePath(opts))) return false;
  if (isProvidersFileModeUnsafe(opts)) return false;
  const config = readByoConfig(opts);
  if (!config) return false;
  return !isBaseUrlInsecure(config.base_url);
}

/** BYO has no meaningful local-auth concept — the key IS the auth. */
function checkAuthStatus() {
  return 'unknown';
}

function buildRequest(vendor, config, text, opts) {
  const baseUrl = baseUrlFor(vendor, config.base_url);
  if (vendor === 'anthropic') {
    return {
      url: `${baseUrl}/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.api_key,
        'anthropic-version': ANTHROPIC_API_VERSION,
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: opts.maxTokens || DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: text }],
      }),
    };
  }
  if (vendor === 'gemini') {
    // GOV-3 item 5: the key rides the `x-goog-api-key` header, never the URL
    // query string — credentials in URLs land in proxy logs, server access
    // logs, and any future error path that echoes `request.url`.
    return {
      url: `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.api_key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text }] }],
      }),
    };
  }
  // openai-compatible (default): OpenAI itself, or any OpenAI-compatible
  // chat-completions endpoint (custom base_url).
  return {
    url: `${baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: text }],
    }),
  };
}

/** Extract the model's reply text from each vendor's distinct response shape. */
function extractText(vendor, data) {
  if (vendor === 'anthropic') {
    const block = Array.isArray(data && data.content) ? data.content.find((b) => b && b.type === 'text') : null;
    return block && typeof block.text === 'string' ? block.text : '';
  }
  if (vendor === 'gemini') {
    const candidate = data && Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];
    return parts.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
  }
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content
    : '';
  return content;
}

/** Extract usage where the vendor reports it; null otherwise (caller falls
 * back to its own text-length estimate — same degrade-not-break contract
 * every other provider follows, per provider.interface.js). */
function extractUsage(vendor, data) {
  if (!data || typeof data !== 'object') return null;
  if (vendor === 'anthropic' && data.usage) {
    const inputTokens = Number(data.usage.input_tokens) || 0;
    const outputTokens = Number(data.usage.output_tokens) || 0;
    if (!inputTokens && !outputTokens) return null;
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  if (vendor === 'openai-compatible' && data.usage) {
    const inputTokens = Number(data.usage.prompt_tokens) || 0;
    const outputTokens = Number(data.usage.completion_tokens) || 0;
    if (!inputTokens && !outputTokens) return null;
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  // Gemini's usageMetadata uses yet another field naming; folded in defensively.
  if (vendor === 'gemini' && data.usageMetadata) {
    const inputTokens = Number(data.usageMetadata.promptTokenCount) || 0;
    const outputTokens = Number(data.usageMetadata.candidatesTokenCount) || 0;
    if (!inputTokens && !outputTokens) return null;
    return { input_tokens: inputTokens, output_tokens: outputTokens };
  }
  return null;
}

// GOV-3 should-fix item 8: cap the response body at 2MB, in both directions
// — a Content-Length that already exceeds the cap is rejected without
// reading a byte, and a body with no (or a lying) Content-Length is read in
// chunks with a running byte count, aborted the moment it crosses the cap.
// Without this, a stalling or oversized endpoint hangs or OOMs an
// unattended session-end hook.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESPONSE_TOO_LARGE = Symbol('provider-response-too-large');

function headerContentLength(res) {
  try {
    if (res && res.headers && typeof res.headers.get === 'function') {
      const raw = res.headers.get('content-length');
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
  } catch { /* no headers on this response — fall through to the byte-counted read */ }
  return null;
}

/**
 * Read `res` as JSON with the 2MB cap enforced. Prefers a byte-counted
 * streaming read (undici's real fetch Response always exposes `res.body` as
 * a ReadableStream) so a body with no/lying Content-Length is still capped;
 * falls back to `res.json()` when the response has no stream body at all —
 * covers this repo's test fixtures, which hand back a plain
 * `{ok,status,json}` object, not a real Response.
 */
async function readBoundedJson(res) {
  const declaredLength = headerContentLength(res);
  if (declaredLength !== null && declaredLength > MAX_RESPONSE_BYTES) {
    const err = new Error(`response Content-Length ${declaredLength} exceeds the ${MAX_RESPONSE_BYTES}-byte cap`);
    err[RESPONSE_TOO_LARGE] = true;
    throw err;
  }
  if (!res || !res.body || typeof res.body.getReader !== 'function') {
    return res.json();
  }
  const reader = res.body.getReader();
  let total = 0;
  const chunks = [];
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value ? value.byteLength : 0;
    if (total > MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* best-effort */ }
      const err = new Error(`response body exceeded the ${MAX_RESPONSE_BYTES}-byte cap (byte-counted read)`);
      err[RESPONSE_TOO_LARGE] = true;
      throw err;
    }
    if (value) chunks.push(value);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  return JSON.parse(text);
}

/**
 * runModel(opts) — the provider.interface.js contract. `prompt`/`input`
 * combine exactly like every other provider (`prompt + (input || '')`, the
 * full instruction). No retries — a 429 or 5xx returns immediately with a
 * matching reasonCode; the caller (extract-local.js) treats a failed
 * provider as a skip, never as something to hammer.
 *
 * The key is READ from disk and used in exactly two places: the
 * Authorization/x-api-key/x-goog-api-key header — Gemini moved off the URL
 * query string, GOV-3 item 5, so ALL three vendors now carry the key in a
 * header only. It is never interpolated into any log/console call in this
 * module — a build-time grep test (test/byo-key-provider.test.js) asserts
 * that no console or log call in this file's source can carry it.
 *
 * The abort timer is kept alive through the ENTIRE call, including the body
 * read — GOV-3 should-fix item 8's other half: the old code cleared it in
 * the `finally` of the fetch await, which resolves at headers, leaving
 * `res.json()` unbounded in time. `clearTimer()` below runs on every exit
 * path via the outer try/finally.
 */
async function runModel(opts = {}) {
  const target = statePath(opts);
  if (isHomeUnresolved(target)) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'cannot resolve ~/.auxilo/providers.json — the home directory did not resolve to an absolute path',
      reasonCode: 'provider-home-unresolved',
      authStatus: 'unknown',
    };
  }
  // Checked BEFORE config completeness — a widened-permissions file is
  // refused even if it happens to hold a complete config; defense in depth
  // alongside detect()'s own gate above (this module's runModel may also be
  // reached directly via an AUXILO_EXTRACTION_PROVIDER override, which never
  // calls detect() at all).
  if (isProvidersFileModeUnsafe(opts)) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: '~/.auxilo/providers.json is not owner-read-only; refusing to use the stored key until its permissions are fixed (chmod 600 ~/.auxilo/providers.json) or the file is removed (`auxilo provider clear`)',
      reasonCode: 'providers-file-mode-unsafe',
      authStatus: 'unknown',
    };
  }
  const config = readByoConfig(opts);
  if (!config) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: 'no BYO provider key configured — run `auxilo provider set`',
      reasonCode: 'provider-not-configured',
      authStatus: 'unknown',
    };
  }
  // GOV-3 item 3: same override the CLI enforces at `set` time, re-checked
  // here at read time — this module's runModel can be reached directly
  // (AUXILO_EXTRACTION_PROVIDER override) without ever going through
  // detect(), and a config could have been hand-edited on disk since `set`.
  if (isBaseUrlInsecure(config.base_url)) {
    return {
      ok: false,
      text: '',
      usage: null,
      reason: `configured base_url "${config.base_url}" is not https:// — refusing to send the transcript or the key over an insecure connection`,
      reasonCode: 'provider-base-url-insecure',
      authStatus: 'unknown',
    };
  }
  const vendor = resolveVendor(config.provider);
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const text = prompt + String(opts.input || '');
  const request = buildRequest(vendor, config, text, opts);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const timeoutMs = opts.timeoutMs || 120000;

  const identity = { provider: 'byo-key', model: config.model, version: null, vendor };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const clearTimer = () => { if (timer) clearTimeout(timer); };

  try {
    let res;
    try {
      res = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        // GOV-3 item 4: a cross-host redirect would re-send the transcript
        // (and, for two of three vendors, the key) to whatever the redirect
        // target is, and accept its reply as the model's answer. One line.
        redirect: 'error',
        ...(controller && { signal: controller.signal }),
      });
    } catch (error) {
      return {
        ok: false,
        text: '',
        usage: null,
        reason: `BYO provider request failed: ${error.message}`,
        reasonCode: 'provider-error',
        authStatus: 'unknown',
        identity,
      };
    }

    if (res.status === 429) {
      return {
        ok: false,
        text: '',
        usage: null,
        reason: 'BYO provider rate-limited the request (HTTP 429)',
        reasonCode: 'provider-rate-limited',
        authStatus: 'unknown',
        identity,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        text: '',
        usage: null,
        reason: `BYO provider returned HTTP ${res.status}`,
        reasonCode: 'provider-error',
        authStatus: 'unknown',
        identity,
      };
    }

    let data;
    try {
      data = await readBoundedJson(res);
    } catch (error) {
      if (error && error[RESPONSE_TOO_LARGE]) {
        return {
          ok: false,
          text: '',
          usage: null,
          reason: `BYO provider response exceeded the ${MAX_RESPONSE_BYTES}-byte cap`,
          reasonCode: 'provider-response-too-large',
          authStatus: 'unknown',
          identity,
        };
      }
      return {
        ok: false,
        text: '',
        usage: null,
        reason: `BYO provider returned a non-JSON body: ${error.message}`,
        reasonCode: 'provider-error',
        authStatus: 'unknown',
        identity,
      };
    }

    return {
      ok: true,
      text: extractText(vendor, data),
      usage: extractUsage(vendor, data),
      reason: null,
      authStatus: 'unknown',
      identity,
    };
  } finally {
    clearTimer();
  }
}

module.exports = {
  runModel,
  detect,
  checkAuthStatus,
  readProvidersState,
  readByoConfig,
  writeByoConfig,
  clearProvidersFile,
  resolveVendor,
  DEFAULT_PROVIDERS_STATE_PATH,
  // Exported for direct unit coverage (test/byo-key-provider.test.js,
  // test/extract-w1-fix2.test.js) AND for scripts/providers/index.js, which
  // routes persistSelected's write through writeProvidersStateAtomic (ONE
  // writer for every providers.json write, GOV-3 item 1) and checks
  // isProvidersFileModeUnsafe before trusting a persisted `selected` value
  // it reads (GOV-3 item 2, "read too, not just write").
  isProvidersFileModeUnsafe,
  isHomeUnresolved,
  isBaseUrlInsecure,
  writeProvidersStateAtomic,
  // Exported for direct unit coverage (EXTRACTION-LOW-FOLLOWUPS item 4).
  isUnsafeExistingTarget,
  MAX_RESPONSE_BYTES,
};
