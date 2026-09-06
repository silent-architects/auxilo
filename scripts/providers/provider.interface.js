/**
 * scripts/providers/provider.interface.js — Model Provider Interface (EXTRACT-PER-CLIENT W1 PART A)
 *
 * Doc-only contract, no runtime logic — mirrors scripts/sources/source.interface.js's
 * role for transcript sources, but for the model that DOES the extraction/dedup-judge
 * work. A provider module (scripts/providers/claude-code.js, codex-cli.js, byo-key.js)
 * is any object exposing the shape documented below; there is no base class to extend
 * because every provider's actual invocation mechanics (CLI spawn vs HTTP call) differ
 * too much to share an implementation, only the contract.
 *
 * @module providers/provider.interface
 */

'use strict';

/**
 * @typedef {'extract'|'judge'} RunModelMode
 *   'extract' (default) — draft learnings from a transcript.
 *   'judge' — binary anchored-dedup decision against previously captured lessons.
 *   A CLI provider may pick a different argv/parsing variant per mode (Claude Code
 * does — extraction and judge invocations differ today). A provider that has no
 * mode-specific behavior (e.g. codex-cli, PART B) may ignore `mode` and always use
 * the same invocation shape.
 */

/**
 * @typedef {object} RunModelUsage
 * @property {number} input_tokens
 * @property {number} output_tokens
 */

/**
 * @typedef {object} RunModelOptions
 * @property {string} prompt - The instruction text. Combined with `input` as the
 *   model's full instruction: `prompt + (input || '')` — stdin for CLI providers,
 *   message body for HTTP providers. This is the existing convention
 *   `extractWithClaudeCode` already used; providers do not change it.
 * @property {string} [input] - The transcript (extract mode) or empty (judge mode,
 *   where the full payload already lives in `prompt`).
 * @property {number} [timeoutMs] - Invocation timeout in milliseconds.
 * @property {Function} [log] - Logger sink, `(line: string) => void`.
 * @property {Function} [spawnSyncImpl] - Injectable `child_process.spawnSync`
 *   replacement (CLI providers only) — the test-injection seam.
 * @property {Function} [fetchImpl] - Injectable `fetch` replacement (HTTP providers
 *   only) — the test-injection seam.
 * @property {RunModelMode} [mode] - 'extract' (default) or 'judge'.
 * @property {object} [schema] - Optional JSON-Schema hint a provider MAY use to
 *   constrain its output. Claude Code ignores this — `extractJsonValue`'s
 *   fence-strip + brace-scan parser is already model-agnostic and needs no schema
 *   hint to do its job.
 */

/**
 * @typedef {object} RunModelResult
 * @property {boolean} ok
 * @property {string} text - Raw model output (empty string on failure).
 * @property {RunModelUsage|null} usage - Normalized token usage, or null when the
 *   provider cannot report it (e.g. codex-cli's `-o` file carries no token counts).
 *   Callers that need an estimate when usage is null do their own text-length
 *   fallback (see scripts/extract-local.js's judge-usage bookkeeping) — providers
 *   are not required to estimate on the caller's behalf.
 * @property {string} [reasonCode] - Machine-matchable failure/skip classifier
 *   (e.g. 'cli-unauthenticated', 'cli-billing-helper-configured', 'model-error',
 *   'unknown'). Present on both success and failure paths where applicable.
 * @property {string|null} [reason] - Human-readable reason, present when !ok.
 * @property {string} [authStatus] - 'logged-in' | 'logged-out' | 'unknown', when
 *   the provider has a meaningful concept of local auth state.
 * @property {object} [identity] - {provider, model, version, vendor} — which
 *   provider/model actually ran this call, for the extraction_model stamp
 *   (scripts/extract-local.js's resolveExtractionModelIdentity reads THIS
 *   field, not any other name). byo-key.js always sets it (full identity,
 *   read from its stored config). codex-cli.js sets it (provider/version;
 *   model/vendor null — codex exposes no per-call model id without --json).
 *   claude-code.js does not set one yet; resolveExtractionModelIdentity
 *   falls back to the resolved provider id alone when absent (EXTRACT-PER-
 *   CLIENT W1 FIX GATE-A item (a) — codex-cli.js used to export this same
 *   data under the field name `extraction_model`, which nothing here ever
 *   read, so its real version silently never reached the stamp; that field
 *   name survives one more release as a deprecated alias of `identity`).
 */

/**
 * @callback RunModel
 * @param {RunModelOptions} opts
 * @returns {Promise<RunModelResult>}
 */

/**
 * Contract a provider module implements:
 *   - runModel(opts) → Promise<RunModelResult>   (see typedefs above)
 *   - detect(opts) → boolean|Promise<boolean>     (installed/usable on this host?)
 *   - checkAuthStatus(opts) → string               ('logged-in'|'logged-out'|'unknown')
 *
 * No base class — see module comment. Nothing here is imported for its runtime
 * value; this file exists so the contract has one canonical, grep-able location.
 */

module.exports = {};
