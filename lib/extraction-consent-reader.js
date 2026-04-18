/**
 * lib/extraction-consent-reader.js — Consent Log Reader (P2.1a §3.5)
 *
 * Reads and writes the durable, versioned consent log at data/extraction-consent.jsonl.
 *
 * Design choices:
 *   - On first call, loads the entire file into a Map<account_id, latestRow>.
 *   - Subsequent calls serve from cache unless forceReload: true is passed.
 *   - forceReload: true re-reads the file from disk — REQUIRED by §3.5.4 in-flight
 *     recheck to avoid serving stale consent state between candidates in the same request.
 *   - appendConsent() is an atomic append-to-file + cache invalidation.
 *
 * @module extraction-consent-reader
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONSENT_FILE = path.join(__dirname, '..', 'data', 'extraction-consent.jsonl');

// ─── In-memory cache ────────────────────────────────────────────────────────

/** @type {Map<string, object>|null} */
let consentCache = null;

/**
 * Load consent entries from the JSONL file into the cache.
 * @returns {Map<string, object>} Map of account_id -> most recent consent row
 */
function loadConsentFile() {
  const map = new Map();

  if (!fs.existsSync(CONSENT_FILE)) {
    return map;
  }

  const content = fs.readFileSync(CONSENT_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.account_id) {
        // Most recent row wins (file is append-only, later entries override)
        map.set(row.account_id, row);
      }
    } catch {
      // Skip malformed lines — do not crash on corrupt data
    }
  }

  return map;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Get the most recent consent state for an account.
 *
 * @param {string} accountId
 * @param {object} [opts]
 * @param {boolean} [opts.forceReload=false] - When true, re-reads the file from disk.
 *   REQUIRED for the §3.5.4 in-flight consent recheck before each publish.
 * @returns {object|null} Most recent consent row, or null if no consent record exists.
 *   Shape: { account_id, action: "grant"|"revoke", consent_version, timestamp, ip_redacted, user_agent }
 */
function getConsentState(accountId, opts = {}) {
  if (!consentCache || opts.forceReload) {
    consentCache = loadConsentFile();
  }
  return consentCache.get(accountId) || null;
}

/**
 * Append a consent action to the log and invalidate cache.
 *
 * @param {object} params
 * @param {string} params.accountId
 * @param {string} params.action - "grant" or "revoke"
 * @param {string} params.consentVersion - ISO date version string
 * @param {string} params.ipRedacted - Redacted IP address (e.g. "1.2.*.*")
 * @param {string} params.userAgent - Request user-agent string
 */
function appendConsent({ accountId, action, consentVersion, ipRedacted, userAgent }) {
  const row = {
    account_id: accountId,
    action,
    consent_version: consentVersion || new Date().toISOString().split('T')[0],
    timestamp: new Date().toISOString(),
    ip_redacted: ipRedacted || 'unknown',
    user_agent: userAgent || 'unknown',
  };

  // Atomic append: open, write line, close
  fs.appendFileSync(CONSENT_FILE, JSON.stringify(row) + '\n', 'utf-8');

  // B19: Also write to the hash-chained audit log so consent events
  // land in the same chain as extraction rows. The consent log file
  // remains the source of truth for forceReload reads — this augments.
  try {
    const { appendAuditRow } = require('./extraction-audit-writer');
    const auditAction = action === 'grant' ? 'consent_grant' : 'consent_revoke';
    // Note: consent_grant/consent_revoke are exempt from the consent_version
    // hard assertion in appendAuditRow — the row IS the consent stamp.
    appendAuditRow({
      account_id: accountId,
      consent_version: row.consent_version,
      action: auditAction,
      source: { type: 'consent', ip_redacted: row.ip_redacted },
      transcript_sha256: '',
      transcript_length: 0,
      scrubber_version: 'n/a',
      client_scrub_matches: [],
      server_scrub_matches: [],
      provider: 'none',
      model: 'none',
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      quality_pass_count: 0,
      quality_fail_count: 0,
      published_learning_ids: [],
      mode: 'consent',
    }).catch(err => {
      // Best-effort: consent log is the source of truth.
      // If audit write fails, log but don't break consent flow.
      console.error('[consent] Audit chain write failed:', err.message);
    });
  } catch (err) {
    console.error('[consent] Audit chain integration error:', err.message);
  }

  // Invalidate cache so next read picks up the new state
  consentCache = null;
}

/**
 * Check if an account has active consent (most recent action is "grant").
 *
 * @param {string} accountId
 * @param {object} [opts] - Same as getConsentState
 * @returns {boolean}
 */
function hasActiveConsent(accountId, opts = {}) {
  const state = getConsentState(accountId, opts);
  return state !== null && state.action === 'grant';
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getConsentState,
  appendConsent,
  hasActiveConsent,
};
