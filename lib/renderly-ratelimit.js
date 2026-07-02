'use strict';

// S-5 FIX: per-caller sliding-window rate limiter for the renderly URL-proxy
// routes. The renderly routes fetch caller-supplied URLs; even with resolve-and-pin
// (S-1) closing the internal-proxy primitive, a tight cap blunts SSRF-based
// scanning / metadata polling and outbound-fetch abuse. This caps BOTH auth
// classes (api_key callers keyed by account, x402/other callers keyed by the
// trusted-proxy-derived client IP) at a fixed requests/minute.
//
// Extracted as a pure function so the window arithmetic is unit-testable without
// booting the HTTP server (server.js has no require-main guard).

/**
 * Check (and record) a request against a sliding window.
 * Mutates `store` (Map<callerKey, number[]>) in place: trims expired timestamps
 * and, when allowed, appends `now`.
 *
 * @param {Map<string, number[]>} store    - shared per-caller timestamp store
 * @param {string} callerKey               - e.g. "acct:<id>" or "ip:<addr>"
 * @param {number} limit                   - max requests per window
 * @param {number} windowMs                - window length in ms
 * @param {number} now                     - current epoch ms (injectable for tests)
 * @returns {{ allowed: boolean, limit: number, remaining: number, resetAt: number }}
 *          resetAt is epoch SECONDS.
 */
function checkRenderlyRateLimit(store, callerKey, limit, windowMs, now = Date.now()) {
  const windowStart = now - windowMs;
  const prev = store.get(callerKey) || [];
  const trimmed = prev.filter((ts) => ts > windowStart);

  const resetAt = Math.ceil(((trimmed.length > 0 ? trimmed[0] : now) + windowMs) / 1000);

  if (trimmed.length >= limit) {
    store.set(callerKey, trimmed);
    return { allowed: false, limit, remaining: 0, resetAt };
  }

  trimmed.push(now);
  store.set(callerKey, trimmed);
  return { allowed: true, limit, remaining: Math.max(0, limit - trimmed.length), resetAt };
}

module.exports = { checkRenderlyRateLimit };
