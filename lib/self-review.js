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

module.exports = {
  PENDING_STATUS,
  projectPending,
  listOwnPending,
  applySelfDecision,
};
