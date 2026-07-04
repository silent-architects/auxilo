/**
 * lib/tos-acceptance-log.js — Durable, versioned, hash-chained ToS acceptance log
 * (R-01 / red-team P0-3 + P0-B)
 *
 * WHY THIS EXISTS. The payee-agency appointment (Terms §5.10) is only legally
 * binding if each Builder AFFIRMATIVELY assents to it AND that assent is captured
 * as a durable, tamper-evident, evidentiary record. The account record
 * (lib/accounts.js) already stamps `tos_version`/`accepted_at`/IP/UA for FAST
 * gating reads and keeps an in-account acceptance history — but an in-account
 * array is mutable and not tamper-evident, which is exactly the property a
 * "you fabricated this acceptance" challenge attacks. This module is the
 * tamper-evident half: an append-only JSONL log PLUS a hash-chained audit stamp,
 * so an acceptance cannot be silently back-dated or forged after the fact.
 *
 * REUSE, NOT GREEN-FIELD (red-team P0-B). A durable, versioned, hash-chained
 * consent-capture mechanism already ships for Autonomous-Extraction consent
 * (lib/extraction-consent-reader.js `appendConsent` → row + lib/extraction-audit-
 * writer.js hash chain). This module is the SIBLING that shares that exact
 * pattern for ToS-level assent. It writes its OWN file (data/tos-acceptance.jsonl)
 * rather than reusing data/extraction-consent.jsonl, because that file is keyed
 * "latest row per account wins" for the extraction grant/revoke STATE — mixing a
 * `tos_acceptance` row in would clobber an account's extraction-consent state (and
 * vice-versa). The tamper-evident audit rows, however, DO land in the same shared
 * hash chain (extraction-audit-writer), so there is ONE chain covering all
 * consent-class events — which is the P0-B intent.
 *
 * SHIP DISCIPLINE. This capture layer and the §5.10 ToS text are an all-or-nothing
 * bundle: §5.10 must NOT be represented as in force until this is live, and this is
 * inert product until §5.10 is the published ToS. Do not deploy either alone.
 *
 * @module tos-acceptance-log
 */

'use strict';

const fs = require('fs');
const path = require('path');

// AUXILO_DATA_DIR overrides the data dir (test isolation — parallel test files
// each get their own temp dir). Resolved at module load: set the env var before
// the first require of this module. Mirrors extraction-consent-reader.js.
const DATA_DIR = process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data');
const TOS_LOG_FILE = path.join(DATA_DIR, 'tos-acceptance.jsonl');

// ─── In-memory cache (latest row per account) ───────────────────────────────

/** @type {Map<string, object>|null} */
let cache = null;

function loadFile() {
  const map = new Map();
  if (!fs.existsSync(TOS_LOG_FILE)) return map;
  const content = fs.readFileSync(TOS_LOG_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row.account_id) {
        // Append-only file: the later entry for an account is the current one.
        map.set(row.account_id, row);
      }
    } catch {
      // Skip malformed lines — never crash on corrupt data.
    }
  }
  return map;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Most recent durable acceptance row for an account, or null.
 * The account record (lib/accounts.js) remains the source of truth for GATING;
 * this is the tamper-evident evidentiary record for a dispute/audit.
 *
 * @param {string} accountId
 * @param {object} [opts]
 * @param {boolean} [opts.forceReload=false] Re-read the file from disk.
 * @returns {object|null} { account_id, action:"tos_acceptance", consent_version,
 *   timestamp, ip_redacted, user_agent, accept_path }
 */
function getAcceptanceRow(accountId, opts = {}) {
  if (!cache || opts.forceReload) cache = loadFile();
  return cache.get(accountId) || null;
}

/**
 * Append a ToS-acceptance event to the durable log and stamp the shared
 * hash-chained audit chain. Mirrors extraction-consent-reader.appendConsent:
 * the JSONL file is the source of truth for reads; the audit-chain write is a
 * best-effort tamper-evidence augment (a failed chain write is logged, never
 * blocks the acceptance — the account-record stamp already gates).
 *
 * The CALLER passes an ALREADY-REDACTED IP (ipRedacted), exactly like the
 * extraction-consent call sites do — redaction lives with the request handler
 * (server.js redactIp), keeping this module I/O-symmetric with its sibling.
 *
 * @param {object} params
 * @param {string} params.accountId
 * @param {string} params.tosVersion   The version accepted (server-authoritative).
 * @param {string} [params.ipRedacted] Redacted IP (e.g. "1.2.3.*"). NOT the raw IP.
 * @param {string} [params.userAgent]
 * @param {string} [params.acceptPath] "web" | "mcp-api" — how assent was captured.
 * @returns {object} The row written.
 */
function appendTosAcceptance({ accountId, tosVersion, ipRedacted, userAgent, acceptPath } = {}) {
  if (!accountId) throw new Error('appendTosAcceptance: accountId is required');
  if (!tosVersion) throw new Error('appendTosAcceptance: tosVersion is required');

  const row = {
    account_id: accountId,
    action: 'tos_acceptance',
    consent_version: tosVersion,
    timestamp: new Date().toISOString(),
    ip_redacted: ipRedacted || 'unknown',
    user_agent: userAgent || 'unknown',
    accept_path: acceptPath || 'unknown',
  };

  // Durable append (source of truth for reads).
  fs.mkdirSync(path.dirname(TOS_LOG_FILE), { recursive: true });
  fs.appendFileSync(TOS_LOG_FILE, JSON.stringify(row) + '\n', 'utf-8');

  // Tamper-evidence: land the acceptance in the SAME hash-chained audit chain as
  // extraction + extraction-consent rows (red-team P0-B: reuse the proven chain).
  // `tos_acceptance` carries a real consent_version, so it satisfies appendAuditRow's
  // consent_version assertion (it is NOT on the exempt list, and does not need to be).
  try {
    const { appendAuditRow } = require('./extraction-audit-writer');
    appendAuditRow({
      account_id: accountId,
      consent_version: row.consent_version,
      action: 'tos_acceptance',
      source: { type: 'tos', ip_redacted: row.ip_redacted, accept_path: row.accept_path },
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
      mode: 'tos',
    }).catch(err => {
      // Best-effort: the JSONL log is the source of truth. Do not break assent.
      console.error('[tos] Audit chain write failed:', err.message);
    });
  } catch (err) {
    console.error('[tos] Audit chain integration error:', err.message);
  }

  // Invalidate cache so the next read picks up the new row.
  cache = null;
  return row;
}

/**
 * Reset the in-memory cache. Test-only isolation helper (mirrors siblings).
 */
function _resetCache() {
  cache = null;
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  getAcceptanceRow,
  appendTosAcceptance,
  TOS_LOG_FILE,
  _resetCache,
};
