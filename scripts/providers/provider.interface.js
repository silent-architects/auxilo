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
 *   Claude Code uses the same isolated JSON transport and strict decoder in
 * both modes. Prompt bytes and candidate parsing are separate from transport.
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
 * @property {Function} beforeModelInvocation - Required at every model-capable
 *   adapter boundary. Called exactly once immediately before spawn/fetch; only
 *   literal true authorizes it. The registry supplies the owned binding hook.
 *   Pre-invocation refusals return without consulting the hook.
 * @property {string} [source] - Transcript source (unknown means no native route).
 * @property {string} [sessionId] - Source session identifier.
 * @property {string} [jobSha] - SHA256 of the exact received transcript bytes.
 * @property {object} [routeContext] - Job-local owned binding shared by stages.
 * @property {string} [routeBindingsDir] - Test seam only; never read from env.
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
 *   'isolation-precondition', 'isolation-unverified', 'isolation-violation', 'output-schema-rejected',
 *   'unknown'). Present on both success and failure paths where applicable.
 * @property {string|null} [reason] - Fixed classification, present when !ok;
 *   never raw output, errors, local paths or configured URLs.
 * @property {'pre-invocation'} [refusal] - Positive pre-invocation refusal only.
 * @property {string} [hold] - Blocks further inference, not candidate submission.
 * @property {string} [deferred] - Ownership or recovery-wait disposition.
 * @property {string} [authStatus] - 'logged-in' | 'logged-out' | 'unknown', when
 *   the provider has a meaningful concept of local auth state.
 * @property {object} [identity] - {provider, model, requested_model,
 *   observed_model, version, vendor, identity_unresolved?}. Unknown is null.
 *   requested_model is the BYO configuration, never evidence of what ran.
 *   observed_model comes only from the vendor response or Claude canonicalModel;
 *   zero distinct canonical values means missing, several means ambiguous.
 *   Codex remains unobserved (missing). Legacy model is observed_model or null.
 *   version is the actual CLI version. Usage never implies model identity.
 *   These fields reach the local stamp; server preservation is EPC2-3's scope.
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
