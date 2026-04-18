/**
 * lib/providers/anthropic.js — Anthropic Extraction Provider (P2.1a §6.2)
 *
 * Implements ExtractionProvider for Anthropic's Messages API.
 * Extracted from the inline closure at server.js:3939-3959 and hardened per §6:
 *   - 429 → ProviderRateLimitError with retry-after from header
 *   - 5xx → ProviderUnavailableError
 *   - 401/403 → ProviderAuthError (fail immediately, page ops)
 *   - Timeout via AbortSignal (default 45s from model_config.json)
 *   - Process-local token counter for getQuotaState() (§6.5)
 *
 * Model is read from model_config.json extraction.primary.model — never hardcoded.
 *
 * @module providers/anthropic
 */

'use strict';

const {
  ExtractionProvider,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderAuthError,
} = require('./provider.interface');

// ─── Quota Tracker ──────────────────────────────────────────────────────────

/**
 * Process-local counter tracking input tokens consumed per UTC minute.
 * Client-side approximation of the org's ITPM cap (§6.5).
 */
const quotaTracker = {
  _minuteKey: '',
  _tokensUsed: 0,
  _minuteCap: 50000, // Tier 1 default for Haiku 4.5 (§6.3)

  _currentMinuteKey() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
  },

  recordUsage(inputTokens) {
    const key = this._currentMinuteKey();
    if (key !== this._minuteKey) {
      this._minuteKey = key;
      this._tokensUsed = 0;
    }
    this._tokensUsed += inputTokens;
  },

  getState() {
    const key = this._currentMinuteKey();
    if (key !== this._minuteKey) {
      return { tokens_used_this_minute: 0, tokens_remaining_this_minute: this._minuteCap };
    }
    return {
      tokens_used_this_minute: this._tokensUsed,
      tokens_remaining_this_minute: Math.max(0, this._minuteCap - this._tokensUsed),
    };
  },

  setMinuteCap(cap) {
    this._minuteCap = cap;
  },
};

// ─── AnthropicProvider ──────────────────────────────────────────────────────

class AnthropicProvider extends ExtractionProvider {
  static id = 'anthropic';
  static defaultModel = 'claude-haiku-4-5';

  /**
   * @param {object} config
   * @param {string} config.apiKey - Anthropic API key (from process.env.ANTHROPIC_API_KEY)
   * @param {string} [config.model] - Model name (from model_config.json)
   * @param {number} [config.timeoutMs] - Request timeout in milliseconds (default 45000)
   * @param {number} [config.minuteCap] - ITPM cap for quota tracking
   */
  constructor(config = {}) {
    super();
    this.apiKey = config.apiKey;
    this.model = config.model || AnthropicProvider.defaultModel;
    this.timeoutMs = config.timeoutMs || 45000;

    if (config.minuteCap) {
      quotaTracker.setMinuteCap(config.minuteCap);
    }
  }

  /**
   * Call Anthropic's Messages API to extract structured content.
   *
   * @param {object} params
   * @param {string} params.prompt - The extraction prompt
   * @param {number} params.maxTokens - Maximum output tokens (default 4096)
   * @param {AbortSignal} [params.signal] - External AbortSignal for cancellation
   * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, model: string}>}
   */
  async extract({ prompt, maxTokens = 4096, signal }) {
    if (!this.apiKey) {
      throw new ProviderAuthError('ANTHROPIC_API_KEY not configured');
    }

    // Compose abort signal: merge external signal with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });

      // ── Error classification per §6.2 ──

      if (res.status === 401 || res.status === 403) {
        const errText = await res.text().catch(() => '');
        throw new ProviderAuthError(`Anthropic auth error ${res.status}: ${errText.slice(0, 200)}`);
      }

      if (res.status === 429) {
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader
          ? parseInt(retryAfterHeader, 10) * 1000
          : 15000;
        throw new ProviderRateLimitError(
          `Anthropic rate limit (429)`,
          retryAfterMs
        );
      }

      if (res.status >= 500) {
        const errText = await res.text().catch(() => '');
        throw new ProviderUnavailableError(
          `Anthropic server error ${res.status}: ${errText.slice(0, 200)}`
        );
      }

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Anthropic API error ${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();

      // Track usage for quota pre-check
      const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
      quotaTracker.recordUsage(usage.input_tokens);

      return {
        text: data.content[0].text,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
        },
        model: data.model || this.model,
      };
    } catch (err) {
      // Re-throw known provider errors as-is
      if (err instanceof ProviderRateLimitError ||
          err instanceof ProviderUnavailableError ||
          err instanceof ProviderAuthError) {
        throw err;
      }

      // AbortError → timeout
      if (err.name === 'AbortError') {
        throw new ProviderUnavailableError(`Anthropic request timed out after ${this.timeoutMs}ms`);
      }

      // Network errors → unavailable
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.type === 'system') {
        throw new ProviderUnavailableError(`Anthropic network error: ${err.message}`);
      }

      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get current quota state.
   * Returns process-local approximation of tokens used this UTC minute.
   *
   * @returns {Promise<{tokens_used_this_minute: number, tokens_remaining_this_minute: number}>}
   */
  async getQuotaState() {
    return quotaTracker.getState();
  }
}

// ─── Retry/Fallback Orchestrator ────────────────────────────────────────────

/**
 * Execute an extraction with retry and fallback per §6.4.
 *
 * Retry policy:
 *   - ProviderRateLimitError → sleep retryAfterMs (or 15s × attempt), retry up to maxAttempts
 *   - ProviderUnavailableError → backoff 1s/4s/15s, retry up to maxAttempts
 *   - ProviderAuthError → fail immediately, page ops
 *   - All attempts on primary exhausted → fall through to fallbacks[0], same retry budget
 *   - All fallbacks exhausted → throw last error
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {number} params.maxTokens
 * @param {AbortSignal} [params.signal]
 * @param {object} extractionConfig - From model_config.json extraction section
 * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, model: string}>}
 */
async function extractWithRetry(params, extractionConfig) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const maxAttempts = extractionConfig.max_attempts_per_provider || 3;
  const timeoutMs = extractionConfig.timeout_ms || 45000;

  // Build provider chain: primary + fallbacks
  const providerConfigs = [
    extractionConfig.primary,
    ...(extractionConfig.fallbacks || []),
  ];

  let lastError = null;

  for (const providerCfg of providerConfigs) {
    if (providerCfg.provider !== 'anthropic') {
      // Only Anthropic is allowed per AGENTS.md hard rule
      continue;
    }

    const provider = new AnthropicProvider({
      apiKey,
      model: providerCfg.model,
      timeoutMs,
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await provider.extract(params);
      } catch (err) {
        lastError = err;

        // Auth error → fail immediately, no retry, no fallback
        if (err instanceof ProviderAuthError) {
          throw err;
        }

        // Rate limit → sleep and retry
        if (err instanceof ProviderRateLimitError) {
          if (attempt < maxAttempts) {
            const delay = err.retryAfterMs || (15000 * attempt);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break; // exhausted attempts, try next provider
        }

        // Unavailable → exponential backoff
        if (err instanceof ProviderUnavailableError) {
          if (attempt < maxAttempts) {
            const backoffMs = [1000, 4000, 15000][attempt - 1] || 15000;
            await new Promise(r => setTimeout(r, backoffMs));
            continue;
          }
          break; // exhausted attempts, try next provider
        }

        // Unknown error → do not retry
        throw err;
      }
    }
  }

  // All providers exhausted
  throw lastError || new ProviderUnavailableError('All extraction providers exhausted');
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  AnthropicProvider,
  extractWithRetry,
};
