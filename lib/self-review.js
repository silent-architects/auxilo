'use strict';

/**
 * lib/self-review.js — LW-15 contributor self-review queue (ownership-isolation core)
 *
 * The incident: a power user ran background extraction and private learnings
 * auto-published before any human looked. LW-13 made extraction land
 * `pending_review`; this module lets the CONTRIBUTOR review their OWN pending
 * candidates and approve/reject before anything goes public.
 *
 * THE LOAD-BEARING PROPERTY: every function here filters/guards strictly on
 * `learning.contributor_account_id === accountId`. A caller must NEVER be able
 * to see, approve, or reject another account's pending item. This is NOT the
 * admin queue — it is account-scoped to the API key's own account.
 *
 * Pure module: no fs, no Hono, no network. That is what makes the ownership
 * guarantee unit-testable without booting the server (server.js hardcodes
 * PORT/DATA_DIR, so its endpoints are otherwise only assertable statically).
 * server.js wires these into account-scoped, API-key-authenticated routes and
 * persists via safeWrite; the CLI drives them over HTTP.
 */

const PENDING_STATUS = 'pending_review';

/**
 * Project a single learning to the reviewer-facing shape. Unlike the
 * buyer-facing projections (which strip body + safety flags), this is the
 * contributor's OWN content, so it deliberately includes the FULL body and any
 * safety signals — the human must read the whole thing to judge it.
 *
 * @param {object} l
 * @returns {object}
 */
function projectPending(l) {
  const out = {
    id: l.id,
    title: l.title,
    body: l.body,            // FULL body — reviewer reads it to judge
    category: l.category,
    tags: l.tags || [],
    outcome: l.outcome || null,
    created_at: l.created_at,
    status: l.status,
  };
  // Reviewer safety signals (only present when the screen/dedup flagged them).
  if (l.injection_flags) out.injection_flags = l.injection_flags;
  // LW-16: content-sensitivity signals — the reasons this item was held (e.g.
  // person_name, proprietary_context). The contributor reads these to decide
  // whether the held item is actually safe to approve.
  if (l.sensitivity_signals) out.sensitivity_signals = l.sensitivity_signals;
  if (l.possible_duplicate_of) {
    out.possible_duplicate_of = l.possible_duplicate_of;
    if (l.possible_duplicate_similarity !== undefined) {
      out.possible_duplicate_similarity = l.possible_duplicate_similarity;
    }
  }
  return out;
}

/**
 * List the caller's OWN pending_review learnings, projected for review.
 *
 * Returns ONLY entries where status === 'pending_review' AND
 * contributor_account_id === accountId. No platform-wide view ever.
 *
 * @param {Array<object>} learnings   the full catalog
 * @param {string} accountId          the caller's account id (from validateApiKey)
 * @returns {Array<object>}           reviewer-facing projections of own pending items
 */
function listOwnPending(learnings, accountId) {
  if (!Array.isArray(learnings) || !accountId) return [];
  return learnings
    .filter((l) => l && l.status === PENDING_STATUS && l.contributor_account_id === accountId)
    .map(projectPending);
}

/**
 * Apply a self-review decision to ONE learning, with ownership enforced.
 *
 * Ownership is checked BEFORE pending-status so a caller probing another
 * account's id always gets `forbidden` — never `not_pending` or `not_found` —
 * so the response never leaks the existence or state of another account's
 * learnings (M-6 info-disclosure discipline). A non-owned id returns
 * `forbidden` whether or not it exists.
 *
 * Mutates the matched learning in place on success (caller persists). Matches
 * the admin-moderation audit analog: a lightweight `self_review_action` stamp
 * (NOT the heavy extraction `appendAuditRow`, which requires consent_version
 * plumbing and writes an extraction-ledger row — wrong tool for a catalog-state
 * transition the contributor makes on their own content).
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {string} id                 learning id to act on
 * @param {'approve'|'reject'} decision
 * @param {object} [opts]             { reason, now }
 * @returns {{ok:true, learning:object}
 *          |{ok:false, code:'bad_decision'|'not_found'|'forbidden'|'not_pending', status:number, error:string}}
 */
function applySelfDecision(learnings, accountId, id, decision, opts = {}) {
  if (decision !== 'approve' && decision !== 'reject') {
    return { ok: false, code: 'bad_decision', status: 400, error: 'decision must be "approve" or "reject"' };
  }
  if (!accountId) {
    return { ok: false, code: 'forbidden', status: 403, error: 'Authentication required' };
  }

  const learning = Array.isArray(learnings) ? learnings.find((l) => l && l.id === id) : undefined;

  if (!learning) {
    // No learning anywhere with this id.
    return { ok: false, code: 'not_found', status: 404, error: 'Learning not found' };
  }

  // OWNERSHIP GATE — checked before status. A non-owned id is indistinguishable
  // from one that does not belong to the caller: always 403, no state leak.
  if (learning.contributor_account_id !== accountId) {
    return { ok: false, code: 'forbidden', status: 403, error: 'Not authorized to review this learning' };
  }

  if (learning.status !== PENDING_STATUS) {
    return {
      ok: false,
      code: 'not_pending',
      status: 409,
      error: `Learning is not pending review (status: ${learning.status})`,
    };
  }

  const now = opts.now || new Date().toISOString();
  if (decision === 'approve') {
    learning.status = 'approved';
    // 'manual' so a self-approved item is indistinguishable downstream from an
    // admin-approved one — both are human-vetted (parity with admin approve).
    learning.moderation = 'manual';
    learning.self_review_action = { action: 'self_approve', by: accountId, at: now };
  } else {
    learning.status = 'rejected';
    learning.self_review_action = { action: 'self_reject', by: accountId, at: now };
    if (opts.reason && typeof opts.reason === 'string') {
      learning.self_review_action.reason = opts.reason;
    }
  }
  learning.updated_at = now;

  return { ok: true, learning };
}

// ── Review-seamless additions (2026-07-18) ──────────────────────────────────
//
// Triage summary + bulk decisions. Same load-bearing property as above: every
// path filters on contributor_account_id === accountId. The bulk path exists so
// a contributor with a large backlog can approve in batches WITHOUT weakening
// the consent contract: each item still becomes public only through an explicit
// decision the contributor sent. The counted-confirmation rail (confirmCount
// must equal decisions.length) is the 2026-06-10 mass-publish lesson applied at
// the API layer: no client can bulk-mutate without counting what it sends.

/** Hard cap on decisions per bulk call. Clients chunk above this. */
const BULK_MAX = 100;

/** Max length of a per-item reject reason in a bulk call. */
const BULK_REASON_MAX = 500;

/**
 * Screen-verdict flags for one learning, derived from the persisted moderation
 * fields the submission screens left on the record. Empty array = the item
 * passed every platform screen (it is pending for a non-screen reason such as
 * forced review, a missing quality self-score, or a legacy hold).
 *
 * @param {object} l
 * @returns {string[]} subset of ['injection','content_sensitivity','near_duplicate']
 */
function screenFlags(l) {
  const flags = [];
  if (Array.isArray(l.injection_flags) && l.injection_flags.length > 0) flags.push('injection');
  if (Array.isArray(l.sensitivity_signals) && l.sensitivity_signals.length > 0) flags.push('content_sensitivity');
  if (l.possible_duplicate_of) flags.push('near_duplicate');
  return flags;
}

// ── AUD19-6: server-side quality floor ──────────────────────────────────────
//
// The 14/20 quality gate was prompt-only: the server validated the sum
// arithmetic of quality_self_assessment but never enforced total >= 14 /
// dimension >= 3, so once MCP clients started sending assessments (AUD19-4) a
// clean `total: 4` submission would auto-publish. These constants + predicate
// are the floor the /learn seamless-publish path enforces. Submissions below
// the floor are QUARANTINED to pending_review (review_reason
// 'below_quality_floor'), never hard-rejected: the prompt-side gate already
// tells agents not to submit < 14, so a below-floor submission is more likely a
// mis-scored good contribution than spam — a human look is cheaper than losing
// it, and a 400 would teach agents to omit the assessment entirely.
//
// DELIBERATE NON-GATE: contributor self-approval (applySelfDecision above)
// carries NO quality check. The floor stops unattended auto-publish; it does
// not overrule the human contributor's explicit decision on their own content
// (LW-15/LW-18 consent contract — the human decision is the authority; the
// review surfaces show the score + flag so that decision is informed).

const QUALITY_FLOOR_TOTAL = 14;
const QUALITY_FLOOR_DIMENSION = 3;

/**
 * Does a quality_self_assessment meet the seamless-publish floor?
 * Assumes shape-validation (ints 1-5, total == sum) already happened at the
 * /learn validator; this only answers the threshold question. Fail-closed:
 * anything malformed/missing reads as below-floor.
 *
 * @param {object|null|undefined} qa  quality_self_assessment
 * @returns {boolean}
 */
function meetsQualityFloor(qa) {
  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) return false;
  const dims = [qa.specificity, qa.actionability, qa.novelty, qa.completeness];
  if (!dims.every((d) => Number.isInteger(d) && d >= QUALITY_FLOOR_DIMENSION)) return false;
  return Number.isFinite(qa.total) && qa.total >= QUALITY_FLOOR_TOTAL;
}

// ── AUD19-3(b): wallet-orphan ownership adoption ────────────────────────────
//
// A wallet-only submission has contributor_account_id: null, and every
// self-review path above filters on contributor_account_id === accountId — so
// a wallet-only pending_review item could never be self-approved (orphaned
// forever). The cure: when an account has PROVEN ownership of a wallet
// (verified signature + linked via linkWallet), ADOPT every orphaned learning
// bearing that wallet — bind contributor_account_id so the ENTIRE existing
// review stack (queue, decide, bulk, CLI, dashboard, MCP) works unchanged.
// Adoption, not a read-time fallback filter: a fallback would list items the
// ownership gate still 403s on.
//
// SECURITY CONTRACT (caller-enforced): `wallet` MUST be the account's
// VERIFIED + LINKED wallet (accounts[id].wallet, which linkWallet only sets
// after verification), never a claimed/request-supplied address. Pure module —
// the server call sites perform that check.

/**
 * Bind ownership of wallet-only orphaned learnings to the account that has
 * proven ownership of the wallet. Adopts across ALL statuses (ownership is
 * ownership — also fixes retraction/attribution for published wallet-only
 * items), per LW-15 doctrine: account is ownership, wallet is payout.
 * Never touches items that already have a contributor_account_id.
 *
 * Mutates matched learnings in place (caller persists). Idempotent.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {string} wallet     the account's VERIFIED linked wallet (see contract above)
 * @param {object} [opts]     { now }
 * @returns {string[]}        ids of the learnings adopted (AUD19 MED-3: surfaced to the
 *                            linking response so the operator sees exactly what changed
 *                            hands; empty array when nothing adopted)
 */
function adoptWalletOrphans(learnings, accountId, wallet, opts = {}) {
  if (!Array.isArray(learnings) || !accountId || !wallet || typeof wallet !== 'string') return [];
  const walletLower = wallet.toLowerCase();
  const now = opts.now || new Date().toISOString();
  const adoptedIds = [];
  for (const l of learnings) {
    if (!l || l.contributor_account_id) continue;
    if (typeof l.contributor_wallet !== 'string') continue;
    if (l.contributor_wallet.toLowerCase() !== walletLower) continue;
    l.contributor_account_id = accountId;
    l.ownership_adopted = { via: 'verified_wallet_link', wallet: walletLower, by: accountId, at: now };
    l.updated_at = now;
    adoptedIds.push(l.id);
  }
  return adoptedIds;
}

/**
 * Best available quality score for a pending learning, on the repo's 0-20
 * scale. Primary: quality_self_assessment.total (SPEC-P1.1, extraction path).
 * Fallback: quality_estimate (legacy chat-history import path). Null when the
 * record carries neither (treated as unscored; approve-clean skips it unless
 * the threshold is explicitly 0).
 *
 * @param {object} l
 * @returns {{ quality: number|null, source: 'self_assessment'|'legacy_estimate'|null }}
 */
function qualityOf(l) {
  const qa = l.quality_self_assessment;
  if (qa && Number.isFinite(qa.total)) return { quality: qa.total, source: 'self_assessment' };
  if (Number.isFinite(l.quality_estimate)) return { quality: l.quality_estimate, source: 'legacy_estimate' };
  return { quality: null, source: null };
}

/**
 * Project one pending learning to a compact triage row: NO body (the summary
 * is a scanning surface, not a reading surface; the full body stays on
 * GET /account/pending and the single-item flows).
 *
 * @param {object} l
 * @returns {object}
 */
function projectTriageRow(l) {
  const flags = screenFlags(l);
  const q = qualityOf(l);
  const row = {
    id: l.id,
    title: l.title,
    category: l.category,
    quality: q.quality,
    quality_source: q.source,
    screens_passed: flags.length === 0,
    flags,
    created_at: l.created_at,
  };
  if (l.possible_duplicate_of) {
    row.possible_duplicate_of = l.possible_duplicate_of;
    if (l.possible_duplicate_similarity !== undefined) {
      row.possible_duplicate_similarity = l.possible_duplicate_similarity;
    }
  }
  return row;
}

/** Quality band label for the summary counts. */
function qualityBand(quality) {
  if (quality == null) return 'unscored';
  if (quality >= 18) return '18-20';
  if (quality >= 14) return '14-17';
  if (quality >= 10) return '10-13';
  return 'below_10';
}

/**
 * Build the caller's pending-review triage summary: counts plus compact rows,
 * sorted quality desc (unscored last), ties oldest-first. Near-dup clusters
 * are derived among the caller's OWN pending items only: items whose
 * possible_duplicate_of points at another of the caller's pending items are
 * grouped, so the reviewer can decide the cluster together.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @returns {object}
 */
function summarizeOwnPending(learnings, accountId) {
  const own = (Array.isArray(learnings) && accountId)
    ? learnings.filter((l) => l && l.status === PENDING_STATUS && l.contributor_account_id === accountId)
    : [];

  const items = own.map(projectTriageRow);
  items.sort((a, b) => {
    const qa = a.quality == null ? -1 : a.quality;
    const qb = b.quality == null ? -1 : b.quality;
    if (qb !== qa) return qb - qa;
    return String(a.created_at || '').localeCompare(String(b.created_at || ''));
  });

  const byCategory = {};
  const byScreen = { injection: 0, content_sensitivity: 0, near_duplicate: 0 };
  const byBand = { '18-20': 0, '14-17': 0, '10-13': 0, below_10: 0, unscored: 0 };
  let cleanCount = 0;
  for (const row of items) {
    byCategory[row.category || 'uncategorized'] = (byCategory[row.category || 'uncategorized'] || 0) + 1;
    for (const f of row.flags) byScreen[f] += 1;
    byBand[qualityBand(row.quality)] += 1;
    if (row.screens_passed) cleanCount += 1;
  }

  // Near-dup clusters among the caller's own pending set (union by dup target).
  const pendingIds = new Set(items.map((r) => r.id));
  const clusterByRoot = new Map();
  for (const row of items) {
    if (row.possible_duplicate_of && pendingIds.has(row.possible_duplicate_of)) {
      const root = row.possible_duplicate_of;
      if (!clusterByRoot.has(root)) clusterByRoot.set(root, new Set([root]));
      clusterByRoot.get(root).add(row.id);
    }
  }
  const near_dup_clusters = [...clusterByRoot.values()]
    .filter((s) => s.size >= 2)
    .map((s) => [...s]);

  return {
    pending_count: items.length,
    clean_count: cleanCount,
    flagged_count: items.length - cleanCount,
    counts: { by_category: byCategory, by_screen: byScreen, by_quality_band: byBand },
    items,
    near_dup_clusters,
  };
}

/**
 * Apply a batch of self-review decisions with the same per-item semantics as
 * applySelfDecision, plus:
 *
 *   COUNTED CONFIRMATION (batch gate): opts.confirmCount must equal
 *   decisions.length or the whole batch is refused before any mutation. Every
 *   client is forced to count what it submits (2026-06-10 incident rail).
 *
 *   CAP: at most BULK_MAX decisions per call (batch refusal, no mutation).
 *
 *   IDEMPOTENCY per id: a decision whose learning is already in the target
 *   state (approved for approve, rejected for reject) and owned by the caller
 *   reports ok:true, changed:false, idempotent:true. Retrying a chunk after a
 *   partial failure is therefore safe.
 *
 *   DUPLICATES inside one call: the first occurrence of an id is processed;
 *   a repeat with the same decision echoes the first outcome (duplicate:true);
 *   a repeat with a conflicting decision fails that entry only.
 *
 * Per-entry failures (bad shape, not found, not owned, not pending) fail that
 * entry only; the rest of the batch proceeds. Mutations happen in memory via
 * applySelfDecision; the CALLER persists once after the call (single write,
 * matching the existing safeWrite pattern).
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {Array<{id:string, decision:'approve'|'reject', reason?:string}>} decisions
 * @param {object} [opts]  { confirmCount, now }
 * @returns {{ok:true, results:Array<object>, counts:object}
 *          |{ok:false, code:string, status:number, error:string}}
 */
function applyBulkDecisions(learnings, accountId, decisions, opts = {}) {
  if (!accountId) {
    return { ok: false, code: 'forbidden', status: 403, error: 'Authentication required' };
  }
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { ok: false, code: 'bad_decisions', status: 400, error: 'decisions must be a non-empty array' };
  }
  if (decisions.length > BULK_MAX) {
    return {
      ok: false,
      code: 'too_many_decisions',
      status: 400,
      error: `Too many decisions in one call (max ${BULK_MAX}). Split into chunks and confirm each.`,
    };
  }
  if (!Number.isInteger(opts.confirmCount) || opts.confirmCount !== decisions.length) {
    return {
      ok: false,
      code: 'confirm_count_mismatch',
      status: 400,
      error: `confirm_count must equal the number of decisions submitted (${decisions.length}). This is the counted-confirmation gate for bulk review: count what you are about to publish or reject, then send that number.`,
    };
  }

  const results = [];
  const counts = { processed: 0, approved: 0, rejected: 0, failed: 0, idempotent: 0, changed: 0 };
  const firstOutcome = new Map(); // id -> { decision, result }
  const now = opts.now || new Date().toISOString();

  decisions.forEach((entry, index) => {
    counts.processed += 1;
    const base = { index };

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      counts.failed += 1;
      results.push({ ...base, ok: false, code: 'bad_entry', error: 'each decision must be an object {id, decision}' });
      return;
    }
    const { id, decision } = entry;
    base.id = typeof id === 'string' ? id : null;
    base.decision = decision;

    if (typeof id !== 'string' || id.length === 0) {
      counts.failed += 1;
      results.push({ ...base, ok: false, code: 'bad_entry', error: 'id must be a non-empty string' });
      return;
    }
    if (decision !== 'approve' && decision !== 'reject') {
      counts.failed += 1;
      results.push({ ...base, ok: false, code: 'bad_decision', error: 'decision must be "approve" or "reject"' });
      return;
    }
    if (entry.reason !== undefined && (typeof entry.reason !== 'string' || entry.reason.length > BULK_REASON_MAX)) {
      counts.failed += 1;
      results.push({ ...base, ok: false, code: 'bad_reason', error: `reason must be a string of at most ${BULK_REASON_MAX} characters` });
      return;
    }

    // Duplicate ids inside this call.
    if (firstOutcome.has(id)) {
      const first = firstOutcome.get(id);
      if (first.decision === decision) {
        const echoed = { ...first.result, index, duplicate: true };
        if (echoed.ok) counts.idempotent += 1; else counts.failed += 1;
        results.push(echoed);
      } else {
        counts.failed += 1;
        results.push({ ...base, ok: false, code: 'conflicting_decision', error: 'this id appears earlier in the batch with the opposite decision' });
      }
      return;
    }

    // Idempotency: already in the target state (ownership checked first so a
    // non-owned id still reads as forbidden, per the M-6 discipline above).
    const learning = learnings.find((l) => l && l.id === id);
    const targetStatus = decision === 'approve' ? 'approved' : 'rejected';
    if (learning && learning.contributor_account_id === accountId && learning.status === targetStatus) {
      counts.idempotent += 1;
      const result = { ...base, ok: true, status: targetStatus, changed: false, idempotent: true };
      firstOutcome.set(id, { decision, result });
      results.push(result);
      return;
    }

    const applied = applySelfDecision(learnings, accountId, id, decision, {
      reason: decision === 'reject' ? entry.reason : undefined,
      now,
    });
    if (!applied.ok) {
      counts.failed += 1;
      const result = { ...base, ok: false, code: applied.code, error: applied.error };
      firstOutcome.set(id, { decision, result });
      results.push(result);
      return;
    }

    counts.changed += 1;
    if (decision === 'approve') counts.approved += 1; else counts.rejected += 1;
    const result = { ...base, ok: true, status: applied.learning.status, changed: true };
    firstOutcome.set(id, { decision, result });
    results.push(result);
  });

  return { ok: true, results, counts };
}

module.exports = {
  PENDING_STATUS,
  BULK_MAX,
  BULK_REASON_MAX,
  QUALITY_FLOOR_TOTAL,
  QUALITY_FLOOR_DIMENSION,
  meetsQualityFloor,
  adoptWalletOrphans,
  projectPending,
  listOwnPending,
  applySelfDecision,
  screenFlags,
  qualityOf,
  projectTriageRow,
  qualityBand,
  summarizeOwnPending,
  applyBulkDecisions,
};
