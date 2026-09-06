'use strict';

/**
 * lib/clean-lane.js — SPEC-3 B1 channel-hold + C1 clean-lane standing consent
 * (FLAG-DARK by default).
 *
 * WHAT THIS IS. The extraction channel's publish brake and, behind a default-off
 * flag, the consent artifact that can later release it. SPEC-3 (2026-07-19)
 * found that shipping extractor quality scores alone would silently flip hook
 * extraction from "everything held" to "clean items auto-publish" — because the
 * current /learn seamless predicate publishes any clean, floor-passing
 * submission immediately. The amendment (SPEC3 §3.1): the client marks hook
 * submissions `submission_channel:'extraction'`, and the SERVER holds
 * extraction-channel items in pending_review (reason `standing_consent_off`)
 * unless the account's clean-lane standing consent is active. Tyler ratified
 * the D1 Option-B DIRECTION 2026-07-19; the consent-text/ToS wording is
 * counsel-gated, so the consent surface ships DARK:
 *
 *   EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED (default OFF, absent = OFF)
 *
 * Flag OFF: the grant/revoke/status routes 404 and every extraction-channel
 * item holds. Flag ON + recorded grant: clean, floor-passing, threshold-passing
 * extraction items publish with a per-publish notice + 7-day retraction stamp,
 * under the retraction-rate auto-freeze guardrail below.
 *
 * CHANNEL TRUST (GOV-3, SPEC3 §3.2). `submission_channel` is client-asserted.
 * A lying client claiming 'direct' merely reaches the ALREADY-SHIPPED seamless
 * path any contribute-key holder has via auxilo_contribute today. The marker is
 * a BRAKE, never a new gas pedal — it is NOT a security boundary and nothing
 * here may treat it as one.
 *
 * CONSENT STORE. Own file (data/clean-lane-consent.jsonl), NOT
 * extraction-consent.jsonl: that file is keyed "latest row per account wins"
 * for the EXTRACTION grant/revoke state, so a clean-lane row appended there
 * would clobber an account's extraction consent (and vice-versa) — the exact
 * reason lib/tos-acceptance-log.js got its own file. Every append also lands on
 * the SHARED hash chain (lib/extraction-audit-writer) so all consent-class
 * events stay on one tamper-evident chain (P0-B doctrine). Rows carry a real
 * consent_version, satisfying the audit writer's hard assertion.
 *
 * NEVER-AGENT-ENROLLABLE (GOV-3 invariant, SPEC3 §4.2). mcp-server.js must
 * never reference this module or its routes (test-pinned). The grant route
 * additionally requires the VERBATIM human affirmation sentence
 * (CLEAN_LANE_AFFIRMATION) + agree:true + the exact current consent version on
 * the wire — the L-2 ToS-clickwrap posture, strengthened: the affirmation is
 * the §10.1 checkbox text itself, so the durable row evidences a human-shaped
 * affirmation, not a version echo.
 *
 * @module clean-lane
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// AUXILO_DATA_DIR overrides the data dir (test isolation — parallel test files
// each get their own temp dir). Resolved at module load, mirroring
// extraction-consent-reader.js / tos-acceptance-log.js.
const DATA_DIR = process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data');
const CLEAN_LANE_FILE = path.join(DATA_DIR, 'clean-lane-consent.jsonl');

// ── Constants ───────────────────────────────────────────────────────────────

/** Env flag gating the ENTIRE consent surface. Default OFF; absent = OFF. */
const CLEAN_LANE_FLAG_ENV = 'EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED';

/**
 * Dated consent-version id (SPEC3 §4.2, §5.9.3(b) versioned-log discipline).
 * A grant recorded under any OTHER version is NOT active — bumping this id
 * (e.g. when counsel revises the consent text) de-activates stale grants and
 * forces a fresh affirmative flow, exactly like CURRENT_TOS_VERSION.
 */
const CLEAN_LANE_CONSENT_VERSION = '2026-07-19-clean-lane-a1';

/**
 * The verbatim affirmation sentence the grant endpoint requires on the wire
 * (SPEC3 §10.1 checkbox text — DRAFT-FOR-MARKETING-THREAD; if the marketing/
 * counsel pass rewords it, bump CLEAN_LANE_CONSENT_VERSION with it).
 */
const CLEAN_LANE_AFFIRMATION = 'I understand and choose auto-publish for qualifying extracted learnings.';

/**
 * Unattended-publish quality threshold (SPEC3 §3.3 point 3): the auto-publish
 * lane gets a HIGHER bar (16) than the attended approve_clean default (14) —
 * a human is looking at the bulk list; nobody is looking at this lane.
 * Account-tunable per grant within [14, 20].
 */
const MIN_AUTO_PUBLISH_QUALITY_DEFAULT = 16;
const MIN_AUTO_PUBLISH_QUALITY_MIN = 14;
const MIN_AUTO_PUBLISH_QUALITY_MAX = 20;

/**
 * Retraction-rate auto-freeze guardrail (SPEC3 §7): if the account's 30-day
 * clean-lane retraction rate EXCEEDS 5%, the screens are missing things for
 * this account — freeze the lane (items fall back to the review queue) and
 * alert ops. Re-activation requires an explicit human re-grant, never an
 * auto-thaw.
 */
const RETRACTION_FREEZE_RATE = 0.05;
const RETRACTION_WINDOW_DAYS = 30;

/** Hold reasons this module can produce (surface in /learn review_reason). */
const HOLD_STANDING_CONSENT_OFF = 'standing_consent_off';
const HOLD_BELOW_AUTO_PUBLISH_THRESHOLD = 'below_auto_publish_threshold';

/** Stamp written on learnings published through the lane (audit parity with
 *  the chat-pipeline's published_via stamps). */
const PUBLISHED_VIA_CLEAN_LANE = 'clean_lane_standing_consent';

// ── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Is the C1 consent surface enabled at all? Repo convention for default-off
 * flags (FORCE_ALL_REVIEW): only the exact string 'true' enables.
 *
 * @param {object} [env] process.env-shaped object
 * @returns {boolean}
 */
function cleanLaneFlagEnabled(env = process.env) {
  return !!env && env[CLEAN_LANE_FLAG_ENV] === 'true';
}

/**
 * Normalize the client-asserted submission channel. Enum `direct|extraction`;
 * default AND unknown values → 'direct' (SPEC3 §3.2 — unknown must degrade to
 * today's behavior, never to the held lane, so a typo'd client is not silently
 * quarantined).
 *
 * @param {*} value
 * @returns {'direct'|'extraction'}
 */
function normalizeSubmissionChannel(value) {
  return value === 'extraction' ? 'extraction' : 'direct';
}

/**
 * Server-derived assessor provenance for quality_self_assessment (SPEC3 §3.2).
 * NOT client-trusted for display: the server overwrites whatever the client
 * sent. Hook path: 'extractor-local/<client>' with <client> parsed from the
 * contributor_agent convention 'auxilo-hook/<source>'. Everything else (MCP /
 * manual /learn) is the operator's agent filling the same rubric.
 *
 * @param {'direct'|'extraction'} channel  normalized submission channel
 * @param {string} [contributorAgent]
 * @returns {string} 'operator-agent' | 'extractor-local/<client>'
 */
function deriveAssessor(channel, contributorAgent) {
  if (channel !== 'extraction') return 'operator-agent';
  let client = 'unknown';
  if (typeof contributorAgent === 'string') {
    const m = contributorAgent.match(/^auxilo-hook\/([A-Za-z0-9._-]+)/);
    if (m) client = m[1];
  }
  return `extractor-local/${client}`;
}

/**
 * Is a consent state row an ACTIVE grant? Requires the latest action to be
 * 'grant' AND the exact current consent version (versioned clickwrap: a stale-
 * version grant is not consent to the current terms). 'revoke' and 'freeze'
 * rows both deactivate; only a fresh human grant reactivates.
 *
 * @param {object|null} state latest row from getCleanLaneState
 * @returns {boolean}
 */
function cleanLaneActive(state) {
  return !!state && state.action === 'grant' && state.consent_version === CLEAN_LANE_CONSENT_VERSION;
}

/**
 * THE publish decision for an extraction-channel item that already passed
 * every screen and the AUD19-6 quality floor (callers gate on that — this
 * function never overrides a screen or the floor; SPEC3 §3.3 point 1).
 *
 * @param {object} params
 * @param {boolean} params.flagEnabled       cleanLaneFlagEnabled(process.env)
 * @param {object|null} params.consentState  latest clean-lane row for the account
 * @param {number} params.qualityTotal       quality_self_assessment.total
 * @param {boolean} [params.accountSuspended]
 * @returns {{decision:'auto_publish', consent_version:string, min_quality:number}
 *          |{decision:'hold', reason:string, min_quality?:number}}
 */
function evaluateExtractionPublish({ flagEnabled, consentState, qualityTotal, accountSuspended } = {}) {
  if (!flagEnabled || accountSuspended || !cleanLaneActive(consentState)) {
    return { decision: 'hold', reason: HOLD_STANDING_CONSENT_OFF };
  }
  const min = clampMinQuality(consentState.min_auto_publish_quality);
  if (!Number.isFinite(qualityTotal) || qualityTotal < min) {
    return { decision: 'hold', reason: HOLD_BELOW_AUTO_PUBLISH_THRESHOLD, min_quality: min };
  }
  return { decision: 'auto_publish', consent_version: consentState.consent_version, min_quality: min };
}

/** Clamp a stored per-grant threshold into [14,20]; default 16 on anything malformed. */
function clampMinQuality(v) {
  if (!Number.isInteger(v)) return MIN_AUTO_PUBLISH_QUALITY_DEFAULT;
  if (v < MIN_AUTO_PUBLISH_QUALITY_MIN) return MIN_AUTO_PUBLISH_QUALITY_MIN;
  if (v > MIN_AUTO_PUBLISH_QUALITY_MAX) return MIN_AUTO_PUBLISH_QUALITY_MAX;
  return v;
}

/**
 * 30-day clean-lane retraction stats for one account (SPEC3 §7 guardrail
 * inputs). Scans the account's learnings bearing the clean-lane publish stamp:
 * publishes = created within the window; retractions = retracted within the
 * window. Deliberately simple and window-symmetric — the guardrail is a
 * protective brake, not an analytics product.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {object} [opts] { now (ms), windowDays }
 * @returns {{publishes:number, retractions:number, rate:number}}
 */
function computeCleanLaneRetractionStats(learnings, accountId, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const windowMs = (opts.windowDays || RETRACTION_WINDOW_DAYS) * 86400000;
  const since = now - windowMs;
  let publishes = 0;
  let retractions = 0;
  if (Array.isArray(learnings) && accountId) {
    for (const l of learnings) {
      if (!l || l.published_via !== PUBLISHED_VIA_CLEAN_LANE) continue;
      if (l.contributor_account_id !== accountId) continue;
      const createdAt = Date.parse(l.created_at || '');
      if (Number.isFinite(createdAt) && createdAt >= since) publishes += 1;
      if (l.status === 'retracted') {
        const retractedAt = Date.parse(l.retracted_at || '');
        if (Number.isFinite(retractedAt) && retractedAt >= since) retractions += 1;
      }
    }
  }
  const rate = publishes > 0 ? retractions / publishes : 0;
  return { publishes, retractions, rate };
}

/**
 * Freeze trigger: rate must EXCEED the 5% guardrail (1/20 = exactly 5% does
 * not freeze; 1/10 does). Zero publishes never freezes (no denominator).
 *
 * @param {{publishes:number, retractions:number}} stats
 * @returns {boolean}
 */
function shouldFreezeCleanLane(stats) {
  if (!stats || !Number.isFinite(stats.publishes) || stats.publishes <= 0) return false;
  if (!Number.isFinite(stats.retractions) || stats.retractions <= 0) return false;
  return stats.retractions / stats.publishes > RETRACTION_FREEZE_RATE;
}

/**
 * CLEAN-LANE-FLIP Phase B (notice hardening; GOV-2 counsel draft §6 read #2):
 * how many of an account's standing-consent publications the human has NOT
 * yet acknowledged. The cursor is the account's `standing_consent_ack_at`
 * (moved only by PATCH /account/settings — the dashboard's "I've reviewed
 * these" button). No cursor → every stamped row counts. With a cursor, only
 * rows created strictly AFTER it count; a row whose created_at is unparsable
 * cannot be proven newer and does not count. Status is deliberately ignored:
 * a retracted row was still a publication event the Builder is owed notice of.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {string|null|undefined} ackAt ISO date-time cursor (or none)
 * @returns {number}
 */
function countUnacknowledgedStandingConsentPublications(learnings, accountId, ackAt) {
  if (!Array.isArray(learnings) || !accountId) return 0;
  const cursor = typeof ackAt === 'string' ? Date.parse(ackAt) : NaN;
  const hasCursor = Number.isFinite(cursor);
  let count = 0;
  for (const l of learnings) {
    if (!l || l.published_via !== PUBLISHED_VIA_CLEAN_LANE) continue;
    if (l.contributor_account_id !== accountId) continue;
    if (!hasCursor) { count += 1; continue; }
    const createdAt = Date.parse(l.created_at || '');
    if (Number.isFinite(createdAt) && createdAt > cursor) count += 1;
  }
  return count;
}

// ── Consent store (own JSONL, latest row per account wins) ──────────────────

/** @type {Map<string, object>|null} */
let cache = null;

function loadFile() {
  const map = new Map();
  if (!fs.existsSync(CLEAN_LANE_FILE)) return map;
  const content = fs.readFileSync(CLEAN_LANE_FILE, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.account_id) map.set(row.account_id, row);
    } catch {
      // Skip malformed lines — never crash on corrupt data (sibling contract).
    }
  }
  return map;
}

/**
 * Latest clean-lane consent row for an account, or null.
 *
 * @param {string} accountId
 * @param {object} [opts] { forceReload } — publish decisions pass forceReload
 *   true (the §3.5.4 in-flight recheck discipline: never auto-publish on a
 *   cached grant a concurrent revoke already withdrew).
 * @returns {object|null}
 */
function getCleanLaneState(accountId, opts = {}) {
  if (!accountId) return null;
  if (!cache || opts.forceReload) cache = loadFile();
  return cache.get(accountId) || null;
}

/**
 * Append a clean-lane consent event (grant | revoke | freeze) to the durable
 * log and stamp the shared hash chain. The JSONL file is the source of truth
 * for reads; the chain write is the best-effort tamper-evidence augment
 * (sibling contract: a failed chain write is logged, never blocks — the
 * routes/guardrail gate on the JSONL row).
 *
 * The CALLER passes an already-redacted IP (redactIp lives with the handler),
 * exactly like the extraction-consent and ToS-acceptance call sites.
 *
 * @param {object} params
 * @param {string} params.accountId
 * @param {'grant'|'revoke'|'freeze'} params.action
 * @param {number} [params.minAutoPublishQuality]  grant only; clamped [14,20]
 * @param {string} [params.tosVersionAtGrant]      grant only; 'none' if never accepted
 * @param {string} [params.affirmation]            grant only; the EXACT affirmation text
 *   received on the wire (the handler has already verified it equals
 *   CLEAN_LANE_AFFIRMATION). Persisted as affirmation_sha256 so the Terms clause
 *   "records ... the affirmation" is literally true; null when not supplied.
 * @param {string} [params.ipRedacted]
 * @param {string} [params.userAgent]
 * @param {string} [params.acceptPath]  'web' | 'cli-api' | 'system' (freeze)
 * @param {string} [params.reason]      freeze only: 'retraction_rate' | 'notice_undeliverable'
 * @param {object} [params.stats]       freeze only: {publishes, retractions}
 * @returns {object} the row written
 */
function appendCleanLaneRow({ accountId, action, minAutoPublishQuality, tosVersionAtGrant,
  affirmation, ipRedacted, userAgent, acceptPath, reason, stats } = {}) {
  if (!accountId) throw new Error('appendCleanLaneRow: accountId is required');
  if (action !== 'grant' && action !== 'revoke' && action !== 'freeze') {
    throw new Error('appendCleanLaneRow: action must be grant, revoke, or freeze');
  }

  const row = {
    account_id: accountId,
    action,
    scope: 'clean_lane_auto_publish',
    consent_version: CLEAN_LANE_CONSENT_VERSION,
    timestamp: new Date().toISOString(),
    ip_redacted: ipRedacted || 'unknown',
    user_agent: userAgent || 'unknown',
    accept_path: acceptPath || (action === 'freeze' ? 'system' : 'unknown'),
    ...(action === 'grant' && {
      mode: 'automatic',
      notify: 'per_publish',
      min_auto_publish_quality: clampMinQuality(minAutoPublishQuality),
      tos_version_at_grant: tosVersionAtGrant || 'none',
      affirmed: true,
      // Gate-A 2026-09-06 (S2): the affirmation itself is recorded, as a
      // hash of the exact text received (never the sentence — the API does
      // not teach callers the affirmation; the hash still proves which text
      // was affirmed).
      affirmation_sha256: typeof affirmation === 'string'
        ? crypto.createHash('sha256').update(affirmation, 'utf8').digest('hex')
        : null,
    }),
    ...(action === 'freeze' && {
      reason: reason || 'unspecified',
      ...(stats && { stats: { publishes: stats.publishes, retractions: stats.retractions } }),
    }),
  };

  // Durable append (source of truth for reads).
  fs.mkdirSync(path.dirname(CLEAN_LANE_FILE), { recursive: true });
  fs.appendFileSync(CLEAN_LANE_FILE, JSON.stringify(row) + '\n', 'utf-8');

  // Tamper-evidence: same shared hash chain as extraction/ToS consent events
  // (P0-B: one chain for all consent-class events). Rows carry a real
  // consent_version, so the writer's hard assertion is satisfied.
  try {
    const { appendAuditRow } = require('./extraction-audit-writer');
    appendAuditRow({
      account_id: accountId,
      consent_version: row.consent_version,
      action: `clean_lane_${action}`,
      source: {
        type: 'clean_lane_consent',
        ip_redacted: row.ip_redacted,
        accept_path: row.accept_path,
        ...(action === 'grant' && { min_auto_publish_quality: row.min_auto_publish_quality, tos_version_at_grant: row.tos_version_at_grant, affirmed: true, affirmation_sha256: row.affirmation_sha256 }),
        ...(action === 'freeze' && { reason: row.reason }),
      },
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
      console.error('[clean-lane] Audit chain write failed:', err.message);
    });
  } catch (err) {
    console.error('[clean-lane] Audit chain integration error:', err.message);
  }

  cache = null;
  return row;
}

/** Test-only cache reset (sibling contract). */
function _resetCache() {
  cache = null;
}

module.exports = {
  CLEAN_LANE_FLAG_ENV,
  CLEAN_LANE_CONSENT_VERSION,
  CLEAN_LANE_AFFIRMATION,
  CLEAN_LANE_FILE,
  MIN_AUTO_PUBLISH_QUALITY_DEFAULT,
  MIN_AUTO_PUBLISH_QUALITY_MIN,
  MIN_AUTO_PUBLISH_QUALITY_MAX,
  RETRACTION_FREEZE_RATE,
  RETRACTION_WINDOW_DAYS,
  HOLD_STANDING_CONSENT_OFF,
  HOLD_BELOW_AUTO_PUBLISH_THRESHOLD,
  PUBLISHED_VIA_CLEAN_LANE,
  cleanLaneFlagEnabled,
  normalizeSubmissionChannel,
  deriveAssessor,
  cleanLaneActive,
  clampMinQuality,
  evaluateExtractionPublish,
  computeCleanLaneRetractionStats,
  shouldFreezeCleanLane,
  countUnacknowledgedStandingConsentPublications,
  getCleanLaneState,
  appendCleanLaneRow,
  _resetCache,
};
