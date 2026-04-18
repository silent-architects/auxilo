/**
 * lib/providers/provider.interface.js — Extraction Provider Interface (P2.1a §6.1)
 *
 * Base class and error types for LLM extraction providers.
 * All providers must extend ExtractionProvider and implement extract() + getQuotaState().
 *
 * @module providers/provider.interface
 */

'use strict';

// ─── Error Classes ──────────────────────────────────────────────────────────

/**
 * Thrown when the provider returns HTTP 429.
 * The caller should respect retryAfterMs before retrying.
 */
class ProviderRateLimitError extends Error {
  /**
   * @param {string} message
   * @param {number} retryAfterMs - Suggested wait time in milliseconds
   */
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = retryAfterMs || 15000;
  }
}

/**
 * Thrown when the provider returns HTTP 5xx.
 * The caller should retry with exponential backoff.
 */
class ProviderUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * Thrown when the provider returns HTTP 401 or 403.
 * The caller should fail immediately and page ops — this is an operational failure.
 */
class ProviderAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProviderAuthError';
  }
}

// ─── Base Class ─────────────────────────────────────────────────────────────

/**
 * Abstract base class for extraction providers.
 *
 * Every provider must:
 * 1. Set static `id` and `defaultModel` properties.
 * 2. Implement `extract({ prompt, maxTokens, signal })`.
 * 3. Implement `getQuotaState()`.
 *
 * @abstract
 */
class ExtractionProvider {
  /** @type {string} Provider identifier, e.g. "anthropic" */
  static id = 'abstract';

  /** @type {string} Default model for this provider */
  static defaultModel = 'abstract';

  /**
   * Extract structured content from a prompt.
   *
   * @param {object} params
   * @param {string} params.prompt - The extraction prompt
   * @param {number} params.maxTokens - Maximum output tokens
   * @param {AbortSignal} [params.signal] - AbortSignal for timeout
   * @returns {Promise<{text: string, usage: {input_tokens: number, output_tokens: number}, model: string}>}
   * @throws {ProviderRateLimitError} on 429
   * @throws {ProviderUnavailableError} on 5xx
   * @throws {ProviderAuthError} on 401/403
   */
  async extract({ prompt, maxTokens, signal }) {
    throw new Error('ExtractionProvider.extract() must be implemented by subclass');
  }

  /**
   * Get the provider's current quota/rate-limit state.
   * Used for pre-flight checks before calling extract().
   *
   * @returns {Promise<{tokens_used_this_minute: number, tokens_remaining_this_minute: number}>}
   */
  async getQuotaState() {
    throw new Error('ExtractionProvider.getQuotaState() must be implemented by subclass');
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  ExtractionProvider,
  ProviderRateLimitError,
  ProviderUnavailableError,
  ProviderAuthError,
};
