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

// CI-5 (PUNCH-LIST §30): retired learning-category labels. An item wearing one
// can never be (re-)approved into publication — recategorize or reject. Pure
// require (category-scope-migration has no fs/network), so this module stays
// unit-testable without booting the server.
const { RETIRED_LEARNING_CATEGORIES, TECH_LEARNING_CATEGORIES } = require('./category-scope-migration.js');

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
  // SPEC3 B2: the evidence rows behind those signals — the matched span, ±40
  // chars of context, and one neutral human sentence per signal (incl. the
  // LLM layer's reason as an llm_semantic row). CONTRIBUTOR-ONLY: this is the
  // sensitive span by definition; buyer projections strip it (count-pinned).
  if (l.sensitivity_evidence) out.sensitivity_evidence = l.sensitivity_evidence;
  // SPEC3 B3: sanitize lineage, both directions.
  if (l.sanitized_from) out.sanitized_from = l.sanitized_from;
  if (l.sanitized_to) out.sanitized_to = l.sanitized_to;
  // CI-7: the system-fact screen's verdict — the reviewer sees WHY it needs
  // eyes (process advice is not a learning; approve only if it is actually a
  // misclassified system fact).
  if (l.learning_type) out.learning_type = l.learning_type;
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

  // CI-5: publication gate — a retired-label item (e.g. a legacy record the
  // boot migration demoted) must not re-enter the catalog via approve; this
  // covers the single route AND the bulk route (applyBulkDecisions delegates
  // here). Reject remains allowed — rejection is the intended disposal path.
  if (decision === 'approve' && RETIRED_LEARNING_CATEGORIES.includes(learning.category)) {
    return {
      ok: false,
      code: 'category_out_of_scope',
      status: 409,
      error: `Category '${learning.category}' is retired — Auxilo publishes technical learnings only. ` +
        `Resubmit the content under one of: ${TECH_LEARNING_CATEGORIES.join(', ')}, or reject this item.`,
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
  // CI-7: the system-fact screen held this item as process advice — a
  // content-TYPE judgment the human must appeal or confirm, so it needs eyes
  // (laneOf: any flag → needs_your_eyes). Even a 19/20 score cannot make
  // process advice a learning — the rubric cannot see this dimension.
  if (l.learning_type === 'process_advice') flags.push('process_advice');
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
 * SPEC3 B1 (assessor provenance, §3.2): `assessor` names WHO scored the item
 * so a reviewing human can weigh the number — 'operator-agent' (MCP/manual
 * /learn; also the default when the stamp is missing), 'extractor-local/<client>'
 * (hook path; server-derived at /learn, never client-trusted for display),
 * 'server-import' (legacy chat-pipeline estimates).
 *
 * @param {object} l
 * @returns {{ quality: number|null, source: 'self_assessment'|'legacy_estimate'|null, assessor: string|null }}
 */
function qualityOf(l) {
  const qa = l.quality_self_assessment;
  if (qa && Number.isFinite(qa.total)) {
    const assessor = (typeof qa.assessor === 'string' && qa.assessor) ? qa.assessor : 'operator-agent';
    return { quality: qa.total, source: 'self_assessment', assessor };
  }
  if (Number.isFinite(l.quality_estimate)) return { quality: l.quality_estimate, source: 'legacy_estimate', assessor: 'server-import' };
  return { quality: null, source: null, assessor: null };
}

// ── SPEC3 B1: the three-lane builder taxonomy (§2.2) ────────────────────────
//
// "Clean" is a screens verdict, "approvable" is a screens+score verdict, and
// "pending" mixed five reasons for being there — the "4 clean / 0 approvable"
// confusion was structural. Every pending item is in exactly ONE lane, computed
// from fields that already exist, named in words a builder understands:
//
//   ready_to_publish  screens passed AND quality >= LANE_READY_QUALITY (14)
//   needs_score       screens passed AND (unscored OR below the floor)
//   needs_your_eyes   any screen flag
//
// LANE_READY_QUALITY deliberately equals QUALITY_FLOOR_TOTAL AND the
// approve_clean DEFAULT_QUALITY_THRESHOLD (lib/review.js) so `approvable_count`
// (the summary headline) can never disagree with what the bulk gate selects.
// A cross-lib test pins the three constants together.
//
// Naming rule (SPEC3 §2.2): builder-facing surfaces lead with lane names and
// never render the word "clean" again; `clean_count` stays in the API for
// compatibility but is demoted in every rendering.

const LANE_READY = 'ready_to_publish';
const LANE_NEEDS_SCORE = 'needs_score';
const LANE_NEEDS_EYES = 'needs_your_eyes';
const LANES = [LANE_READY, LANE_NEEDS_SCORE, LANE_NEEDS_EYES];
const LANE_READY_QUALITY = QUALITY_FLOOR_TOTAL;

/**
 * Derive the lane for one triage row ({flags, quality} suffice — accepts a
 * projectTriageRow output or any row-shaped object).
 *
 * @param {{flags?: string[], quality?: number|null}} row
 * @returns {string} one of LANES
 */
function laneOf(row) {
  const flags = Array.isArray(row && row.flags) ? row.flags : [];
  if (flags.length > 0) return LANE_NEEDS_EYES;
  const q = row && row.quality;
  if (q != null && Number.isFinite(q) && q >= LANE_READY_QUALITY) return LANE_READY;
  return LANE_NEEDS_SCORE;
}

/**
 * SPEC3 B2: one human sentence explaining WHY a flagged item needs eyes.
 * Preference order: the first sensitivity_evidence hint (already a filled
 * neutral template, incl. llm_semantic reasons), then per-flag fallbacks for
 * items that predate evidence capture. Null for unflagged rows.
 *
 * @param {object} l      the learning record
 * @param {string[]} flags  screenFlags(l) output
 * @returns {string|null}
 */
function deriveWhy(l, flags) {
  if (!Array.isArray(flags) || flags.length === 0) return null;
  if (Array.isArray(l.sensitivity_evidence) && l.sensitivity_evidence.length > 0) {
    const hint = l.sensitivity_evidence[0] && l.sensitivity_evidence[0].hint;
    if (typeof hint === 'string' && hint) return hint;
  }
  if (flags.includes('injection') && Array.isArray(l.injection_flags) && l.injection_flags[0]) {
    const f = l.injection_flags[0];
    const excerpt = typeof f.excerpt === 'string' && f.excerpt ? `: '${f.excerpt.slice(0, 80)}'` : '';
    return `Matched a prompt-injection pattern (${f.pattern_id || 'unknown'})${excerpt}.`;
  }
  if (flags.includes('content_sensitivity')) {
    const names = Array.isArray(l.sensitivity_signals) ? l.sensitivity_signals.join(', ') : 'unspecified';
    return `Held by the content-sensitivity screen (${names}).`;
  }
  if (flags.includes('near_duplicate') && l.possible_duplicate_of) {
    const sim = l.possible_duplicate_similarity != null ? ` (similarity ${l.possible_duplicate_similarity})` : '';
    return `Possible duplicate of ${l.possible_duplicate_of}${sim}.`;
  }
  if (flags.includes('process_advice')) {
    return 'The system-fact screen judged this process/workflow advice, not a system fact — approve only if that is wrong.';
  }
  return null;
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
    // SPEC3 B1: who scored it (assessor provenance) — null when unscored.
    quality_assessor: q.assessor,
    screens_passed: flags.length === 0,
    flags,
    created_at: l.created_at,
  };
  // SPEC3 B1: lane derived AFTER flags+quality exist on the row.
  row.lane = laneOf(row);
  // SPEC3 B2 (§5.1): one human sentence — the first evidence hint (or a
  // per-flag fallback) — so the reviewer reads WHY without opening the body.
  // Contributor-only surface; still the disclosure discipline of projectPending.
  const why = deriveWhy(l, flags);
  if (why) row.why = why;
  // SPEC3 B1 (§5.2 filters): signal NAMES on the compact row so by-signal
  // triage doesn't require opening bodies. Names only — the evidence excerpts
  // are slice B2; the names already ship on the full pending projection
  // (projectPending), so this adds no new disclosure class.
  if (Array.isArray(l.sensitivity_signals) && l.sensitivity_signals.length > 0) {
    row.sensitivity_signals = l.sensitivity_signals;
  }
  // SPEC3 B3: lineage on the compact row (the reviewer sees the chain).
  if (l.sanitized_from) row.sanitized_from = l.sanitized_from;
  if (l.sanitized_to) row.sanitized_to = l.sanitized_to;
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

/** Max rows that may carry full bodies in one summary response (SPEC3 §5.5:
 *  full-body dumps stay on GET /account/pending; the summary must never
 *  re-create the 174KB-payload class it exists to kill). */
const FULL_ROWS_MAX = 25;

/** Max explicit ids per summary request. */
const SUMMARY_IDS_MAX = 200;

/**
 * Build the caller's pending-review triage summary: counts plus compact rows,
 * sorted quality desc (unscored last), ties oldest-first. Near-dup clusters
 * are derived among the caller's OWN pending items only: items whose
 * possible_duplicate_of points at another of the caller's pending items are
 * grouped, so the reviewer can decide the cluster together.
 *
 * SPEC3 B1 additions (all additive; absent opts ⇒ today's shape exactly):
 *
 *   COUNTS are ALWAYS computed over the caller's FULL own-pending set —
 *   filters and pagination narrow ROWS only, never counts. New top-level
 *   `approvable_count` (= lane ready_to_publish) and `needs_score_count`;
 *   `counts.by_lane` + `counts.by_signal` (per-signal histogram, §5.2).
 *   `clean_count`/`flagged_count`/`by_screen`/`by_quality_band` retained.
 *
 *   ROW opts: lane / flag / signal / category / ids narrow the row list;
 *   limit + offset paginate AFTER the sort (absent limit = all rows, the
 *   pre-B1 behavior — the default-50 flip rides the client that understands
 *   pagination, SPEC3 §5.5). `returned_count` + `truncated` always present.
 *
 *   BODIES: rows are compact (no body) unless opts.full — and full is bounded:
 *   explicit ids, or limit forced <= FULL_ROWS_MAX.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {object} [opts] { lane, flag, signal, category, ids, limit, offset, full }
 * @returns {object}
 */
function summarizeOwnPending(learnings, accountId, opts = {}) {
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
  const byScreen = { injection: 0, content_sensitivity: 0, near_duplicate: 0, process_advice: 0 };
  const byBand = { '18-20': 0, '14-17': 0, '10-13': 0, below_10: 0, unscored: 0 };
  const bySignal = {};
  const byLane = { [LANE_READY]: 0, [LANE_NEEDS_SCORE]: 0, [LANE_NEEDS_EYES]: 0 };
  let cleanCount = 0;
  for (const row of items) {
    byCategory[row.category || 'uncategorized'] = (byCategory[row.category || 'uncategorized'] || 0) + 1;
    for (const f of row.flags) byScreen[f] += 1;
    byBand[qualityBand(row.quality)] += 1;
    byLane[row.lane] += 1;
    if (row.screens_passed) cleanCount += 1;
    // SPEC3 §5.2: per-signal histogram = sensitivity signal names ∪ injection
    // ∪ near_duplicate, so flag-class triage has counts without opening rows.
    if (Array.isArray(row.sensitivity_signals)) {
      for (const s of row.sensitivity_signals) bySignal[s] = (bySignal[s] || 0) + 1;
    }
    if (row.flags.includes('injection')) bySignal.injection = (bySignal.injection || 0) + 1;
    if (row.flags.includes('near_duplicate')) bySignal.near_duplicate = (bySignal.near_duplicate || 0) + 1;
    if (row.flags.includes('process_advice')) bySignal.process_advice = (bySignal.process_advice || 0) + 1;
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

  // ── Row filtering (rows only — counts above stay full-set) ────────────────
  let rows = items;
  const idsFilter = Array.isArray(opts.ids) && opts.ids.length > 0
    ? new Set(opts.ids.slice(0, SUMMARY_IDS_MAX).map(String))
    : null;
  if (idsFilter) rows = rows.filter((r) => idsFilter.has(r.id));
  if (opts.lane && LANES.includes(opts.lane)) rows = rows.filter((r) => r.lane === opts.lane);
  if (opts.flag && typeof opts.flag === 'string') rows = rows.filter((r) => r.flags.includes(opts.flag));
  if (opts.signal && typeof opts.signal === 'string') {
    const sig = opts.signal;
    rows = rows.filter((r) =>
      (sig === 'injection' && r.flags.includes('injection')) ||
      (sig === 'near_duplicate' && r.flags.includes('near_duplicate')) ||
      (sig === 'process_advice' && r.flags.includes('process_advice')) ||
      (Array.isArray(r.sensitivity_signals) && r.sensitivity_signals.includes(sig)));
  }
  if (opts.category && typeof opts.category === 'string') {
    rows = rows.filter((r) => (r.category || 'uncategorized') === opts.category);
  }
  const filteredCount = rows.length;

  // ── Pagination (after sort + filters) ─────────────────────────────────────
  const full = opts.full === true;
  let limit = Number.isInteger(opts.limit) && opts.limit >= 1 ? opts.limit : null;
  const offset = Number.isInteger(opts.offset) && opts.offset >= 0 ? opts.offset : 0;
  // full without explicit ids: force a body-safe page size.
  if (full && !idsFilter) limit = limit == null ? FULL_ROWS_MAX : Math.min(limit, FULL_ROWS_MAX);
  if (limit != null || offset > 0) {
    rows = rows.slice(offset, limit != null ? offset + limit : undefined);
  }

  // ── Bodies only when explicitly requested (and bounded above) ─────────────
  if (full && rows.length > 0) {
    const bodyById = new Map(own.map((l) => [l.id, l.body]));
    rows = rows.map((r) => ({ ...r, body: bodyById.get(r.id) }));
  }

  return {
    pending_count: items.length,
    clean_count: cleanCount,
    flagged_count: items.length - cleanCount,
    // SPEC3 B1: the headline the bulk gate actually uses. No surface can say
    // "clean" while approve_clean says 0 again — the server states both.
    approvable_count: byLane[LANE_READY],
    needs_score_count: byLane[LANE_NEEDS_SCORE],
    counts: { by_category: byCategory, by_screen: byScreen, by_quality_band: byBand, by_signal: bySignal, by_lane: byLane },
    items: rows,
    returned_count: rows.length,
    truncated: rows.length < filteredCount,
    near_dup_clusters,
  };
}

/**
 * SPEC3 B2 (§5.2): select the caller's OWN pending ids carrying one signal.
 * Signal semantics IDENTICAL to the summary `signal` row filter: the three
 * screen-level names (injection / near_duplicate / process_advice) match on
 * flags; anything else matches sensitivity_signals membership. Ownership
 * filtered like every other path in this module. Pure — the server's counted
 * reject-by-signal gate compares expected_count against this selection.
 *
 * @param {Array<object>} learnings
 * @param {string} accountId
 * @param {string} signal
 * @returns {string[]} ids (stable catalog order)
 */
function selectPendingIdsBySignal(learnings, accountId, signal) {
  if (!Array.isArray(learnings) || !accountId || typeof signal !== 'string' || !signal) return [];
  const out = [];
  for (const l of learnings) {
    if (!l || l.status !== PENDING_STATUS || l.contributor_account_id !== accountId) continue;
    const flags = screenFlags(l);
    const matches =
      (signal === 'injection' && flags.includes('injection')) ||
      (signal === 'near_duplicate' && flags.includes('near_duplicate')) ||
      (signal === 'process_advice' && flags.includes('process_advice')) ||
      (Array.isArray(l.sensitivity_signals) && l.sensitivity_signals.includes(signal));
    if (matches) out.push(l.id);
  }
  return out;
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
  LANE_READY,
  LANE_NEEDS_SCORE,
  LANE_NEEDS_EYES,
  LANES,
  LANE_READY_QUALITY,
  FULL_ROWS_MAX,
  SUMMARY_IDS_MAX,
  laneOf,
  meetsQualityFloor,
  adoptWalletOrphans,
  projectPending,
  listOwnPending,
  applySelfDecision,
  screenFlags,
  qualityOf,
  deriveWhy,
  projectTriageRow,
  qualityBand,
  summarizeOwnPending,
  selectPendingIdsBySignal,
  applyBulkDecisions,
};
