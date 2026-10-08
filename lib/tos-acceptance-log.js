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
const TOS_LOG_FILE = require('./financial-epoch').resolveParticipantPath('tos_acceptance', { legacyPath: path.join(DATA_DIR, 'tos-acceptance.jsonl') });

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
function appendTosAcceptance({ accountId, tosVersion, ipRedacted, userAgent, acceptPath, affirmed } = {}) {
  if (require('./financial-epoch').getRuntimeEpoch()) throw Object.assign(new Error('PROSPECTIVE_CONSENT_SAGA_REQUIRED'), {code:'PROSPECTIVE_CONSENT_SAGA_REQUIRED'});
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
    // L-2 (Gate-B): the explicit affirmation, carried into the tamper-evident record so the
    // hash-chained evidence shows an affirmation was transmitted, not just a version-echo.
    affirmed: affirmed === true,
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
      source: { type: 'tos', ip_redacted: row.ip_redacted, accept_path: row.accept_path, affirmed: row.affirmed },
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
 * Remove every durable ToS row for an account after the deletion-retention
 * window. Malformed lines are retained verbatim: a cleanup job must never turn
 * a recoverable log-corruption issue into evidence loss for other accounts.
 *
 * @param {string} accountId
 * @returns {number} rows removed
 */
function pruneTosAcceptanceRows(accountId) {
  if (require('./financial-epoch').getRuntimeEpoch()) throw Object.assign(new Error('MONEY_LIFECYCLE_REQUIRED'), {code:'MONEY_LIFECYCLE_REQUIRED'});
  if (!accountId || !fs.existsSync(TOS_LOG_FILE)) return 0;
  const lines = fs.readFileSync(TOS_LOG_FILE, 'utf8').split('\n');
  let removed = 0;
  const kept = lines.filter((line) => {
    if (!line.trim()) return false;
    try {
      const row = JSON.parse(line);
      if (row.account_id === accountId) {
        removed++;
        return false;
      }
    } catch {
      // Preserve malformed evidence exactly as read.
    }
    return true;
  });
  if (removed > 0) {
    const tmp = `${TOS_LOG_FILE}.tmp`;
    fs.writeFileSync(tmp, `${kept.join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, TOS_LOG_FILE);
    cache = null;
  }
  return removed;
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
  pruneTosAcceptanceRows,
  TOS_LOG_FILE,
  _resetCache,
};

// The account projection is durable before the evidence acknowledgement. A retry
// resumes the saved consent identity, including after an account-saved/log-failed cut.
async function recordProspectiveConsent({epoch, accountId, version, affirmed, acceptedAt} = {}) {
  const boundary = require('./financial-epoch');
  const money = require('./money-control');
  const persistence = require('./stripe-transfer-persistence');
  const accounts = require('./accounts');
  const evidence = epoch && epoch.policy_evidence;
  const reject = code => { throw Object.assign(new Error(code), {code}); };
  if (!epoch || !accountId || affirmed !== true) reject('AFFIRMATION_REQUIRED');
  if (!evidence || evidence.published !== true || version !== epoch.policy_ref || version !== accounts.CURRENT_TOS_VERSION || evidence.policy_version !== version || !Number.isFinite(Date.parse(evidence.effective_at)) || !/^[a-f0-9]{64}$/.test(evidence.disclosure_sha256 || '') || !/^[a-f0-9]{64}$/.test(evidence.evidence_ref || '')) reject('PUBLISHED_POLICY_EVIDENCE_REQUIRED');
  boundary.assertProspectiveAllowed({action:'identity', epoch, expectedRevision:epoch.activation_revision, accountId});
  return money.runInMoneyContext(async () => {
    const file = boundary.pathFor('policy_consents', epoch);
    money.assertParticipantWrite(file);
    const store = persistence.readJSONStrict(file);
    if (!store.consents || Array.isArray(store.consents)) reject('POLICY_CONSENTS_CORRUPT');
    const consentId = persistence.digestJSON({epoch_id:epoch.epoch_id, binding_digest:epoch.binding_digest, account_id:accountId, policy_version:version});
    let row = store.consents[consentId];
    if (row && (row.evidence_ref !== evidence.evidence_ref || row.effective_at !== evidence.effective_at)) reject('POLICY_CONSENT_CONFLICT');
    if (row && row.state === 'acknowledged') return row;
    const save = () => { try { persistence.writeJSONAtomic(file, store); } catch(error) { money.poisonMoneyRuntime(error); throw error; } };
    if (!row) {
      const when = acceptedAt || new Date().toISOString();
      if (!Number.isFinite(Date.parse(when))) reject('POLICY_ACCEPTANCE_TIME_INVALID');
      row = store.consents[consentId] = {consent_id:consentId, epoch_id:epoch.epoch_id, binding_digest:epoch.binding_digest, account_id:accountId, policy_version:version, effective_at:evidence.effective_at, accepted_at:when, evidence_ref:evidence.evidence_ref, disclosure_sha256:evidence.disclosure_sha256, state:'pending'};
      save();
    }
    const immutable = {...row}; delete immutable.state; delete immutable.audit_receipt;
    const receiptDigest = persistence.digestJSON(immutable);
    const map = accounts.loadAccounts(), account = map[accountId];
    if (!account) reject('ACCOUNT_NOT_FOUND');
    account.financial_policy_receipts ||= {};
    const receipt = account.financial_policy_receipts[consentId];
    if (receipt && receipt.digest !== receiptDigest) reject('POLICY_ACCOUNT_RECEIPT_CONFLICT');
    if (!receipt) {
      account.financial_policy_receipts[consentId] = {consent_id:consentId, digest:receiptDigest, policy_version:version, accepted_at:row.accepted_at};
      accounts.saveAccounts(map);
    }
    const logRow = {...immutable, action:'prospective_policy_acceptance', affirmed:true, receipt_digest:receiptDigest};
    money.assertParticipantWrite(TOS_LOG_FILE);
    try { persistence.appendJSONLOnce(TOS_LOG_FILE, logRow, {key:'consent_id'}); }
    catch(error) { money.poisonMoneyRuntime(error); throw error; }
    const auditReceipt = await require('./extraction-audit-writer').appendAuditRow({audit_id:'consent_'+consentId, ts:row.accepted_at, account_id:accountId, consent_version:version, action:'tos_acceptance', consent_id:consentId, epoch_id:epoch.epoch_id, binding_digest:epoch.binding_digest, receipt_digest:receiptDigest});
    row.audit_receipt = auditReceipt;
    row.state = 'acknowledged';
    save();
    cache = null;
    return row;
  }, {kind:'policy-consent', accounts:[accountId]});
}
module.exports.recordProspectiveConsent = recordProspectiveConsent;
