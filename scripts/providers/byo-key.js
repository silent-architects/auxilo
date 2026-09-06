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
 * pins the two paths equal. */
const DEFAULT_PROVIDERS_STATE_PATH = path.join(os.homedir(), '.auxilo', 'providers.json');

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
 * @param {{provider:string, base_url?:string|null, model:string, api_key:string}} byoConfig
 */
function writeByoConfig(byoConfig, opts = {}) {
  const target = statePath(opts);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const state = readProvidersState(opts);
  state.byo = {
    provider: byoConfig.provider,
    ...(byoConfig.base_url && { base_url: byoConfig.base_url }),
    model: byoConfig.model,
    api_key: byoConfig.api_key,
  };
  if (fs.existsSync(target)) fs.chmodSync(target, 0o600);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, target);
  fs.chmodSync(target, 0o600);
  return target;
}

/**
 * `clear` deletes ~/.auxilo/providers.json outright (per this part's task
 * brief — a narrower behavior than leaving `selected` intact; flagged as a
 * deliberate deviation from the fuller spec draft in the build report).
 * Never throws; absent file is a no-op success.
 */
function clearProvidersFile(opts = {}) {
  const target = statePath(opts);
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
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

/** detect(): true iff a complete BYO config is on disk. Never throws. */
function detect(opts = {}) {
  return readByoConfig(opts) !== null;
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
    return {
      url: `${baseUrl}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.api_key)}`,
      headers: { 'Content-Type': 'application/json' },
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

/**
 * runModel(opts) — the provider.interface.js contract. `prompt`/`input`
 * combine exactly like every other provider (`prompt + (input || '')`, the
 * full instruction). No retries — a 429 or 5xx returns immediately with a
 * matching reasonCode; the caller (extract-local.js) treats a failed
 * provider as a skip, never as something to hammer.
 *
 * The key is READ from disk and used in exactly two places: the
 * Authorization/x-api-key header and, for Gemini only, a URL query
 * parameter (Gemini's own wire contract — no header alternative). It is
 * never interpolated into any log/console call in this module — a
 * build-time grep test (test/byo-key-provider.test.js) asserts that no
 * console or log call in this file's source can carry it.
 */
async function runModel(opts = {}) {
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
  const vendor = resolveVendor(config.provider);
  const prompt = typeof opts.prompt === 'string' ? opts.prompt : '';
  const text = prompt + String(opts.input || '');
  const request = buildRequest(vendor, config, text, opts);
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : fetch;
  const timeoutMs = opts.timeoutMs || 120000;

  const identity = { provider: 'byo-key', model: config.model, version: null, vendor };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
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
  } finally {
    if (timer) clearTimeout(timer);
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
    data = await res.json();
  } catch (error) {
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
};
