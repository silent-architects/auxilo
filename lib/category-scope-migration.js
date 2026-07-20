'use strict';

/**
 * lib/category-scope-migration.js — CI-5 TECHNICAL-ONLY SCOPE (PUNCH-LIST §30).
 *
 * Tyler's 2026-07-19 hard-scope decision: non-technical learnings are out of
 * scope for Auxilo entirely — not collected, not accepted, not published, for
 * ALL users. The category labels `communication` and `content-generation`
 * mixed content-TYPE with content-DOMAIN (live evidence: all 138 purged
 * non-tech pending items wore these two labels; the one TECHNICAL item wearing
 * them — lrn_resend01, an email-API quirk — belongs in web-interaction).
 * Taxonomy ruling (BUILD-SPEC-CI5-SCOPE-2026-07-19 §0, option (a)): both
 * labels are RETIRED; the learning taxonomy is the six tech categories below.
 *
 * This module is the server-side source of truth for the learning-category
 * scope AND the idempotent boot migration that repairs stored items wearing
 * retired labels. It follows the AC-1 pipeline-owner-migration idiom: pure
 * in-memory mutation, caller persists (single safeWrite) only when changed.
 *
 * NOTE: the capability/skills registry keeps its own 8-category taxonomy
 * (`communication` is a legitimate SKILL domain — "sends email"). This module
 * governs LEARNINGS only.
 *
 * @module category-scope-migration
 */

/** The learning taxonomy under CI-5: technical categories only. */
const TECH_LEARNING_CATEGORIES = [
  'data-processing', 'web-interaction', 'code-execution',
  'storage-state', 'payment-financial', 'monitoring',
];

/** Retired learning-category labels (CI-5). Never accepted, never approved. */
const RETIRED_LEARNING_CATEGORIES = ['communication', 'content-generation'];

/**
 * Known TECHNICAL items that were stored wearing a retired label, with their
 * correct tech category. Reviewed per-item before entry (the map is the ONLY
 * path that recategorizes without human review at boot).
 *
 * lrn_resend01: "Resend requires 'from' address to use a verified domain" —
 * a third-party HTTP email-API integration quirk → web-interaction (the same
 * shelf as other external-API behavior learnings).
 */
const CI5_RECATEGORIZE_MAP = {
  lrn_resend01: 'web-interaction',
};

/**
 * Is this stored learning visible (published)? Mirrors the backward-compat
 * reading of visibleLearningsList in server.js: a missing status is treated
 * as approved (legacy records predate the moderation field).
 */
function isVisible(l) {
  return !l.status || l.status === 'approved';
}

/**
 * CI-5 boot migration over the in-memory learnings array. Idempotent:
 *   1. Retired-label item in CI5_RECATEGORIZE_MAP (any status) → recategorized
 *      to its mapped tech category, stamped with provenance
 *      (category_migrated_from / category_migrated_at).
 *   2. Retired-label item that is VISIBLE and not in the map → demoted to
 *      pending_review with a scope_hold stamp (safety net — "not published"
 *      must hold even for unexpected store drift; the approve-path guard in
 *      lib/self-review.js refuses to re-approve it while retired-labeled).
 *   3. Retired-label item that is already non-visible (pending_review /
 *      rejected / retracted) → untouched: historical audit record.
 *
 * Second run: (1) no longer matches (label changed), (2) no longer matches
 * (not visible), so changed === 0 — the caller skips the write.
 *
 * @param {Array<object>} learnings  in-memory catalog (mutated in place)
 * @param {object} [opts]            { now } — injectable timestamp for tests
 * @returns {{recategorized: string[], demoted: string[], changed: number}}
 */
function migrateRetiredCategories(learnings, opts = {}) {
  const result = { recategorized: [], demoted: [], changed: 0 };
  if (!Array.isArray(learnings)) return result;
  const now = opts.now || new Date().toISOString();

  for (const l of learnings) {
    if (!l || typeof l !== 'object') continue;
    if (!RETIRED_LEARNING_CATEGORIES.includes(l.category)) continue;

    const mapped = CI5_RECATEGORIZE_MAP[l.id];
    if (mapped) {
      // Rule 1: known-technical item — recategorize with provenance.
      l.category_migrated_from = l.category;
      l.category_migrated_at = now;
      l.category = mapped;
      l.updated_at = now;
      result.recategorized.push(l.id);
      result.changed++;
    } else if (isVisible(l)) {
      // Rule 2: visible item wearing a retired label with no reviewed mapping —
      // pull it from publication. Never guess a category at boot.
      l.status = 'pending_review';
      l.scope_hold = { action: 'ci5_scope_demotion', at: now };
      l.updated_at = now;
      result.demoted.push(l.id);
      result.changed++;
    }
    // Rule 3: non-visible retired-label items stay as historical record.
  }
  return result;
}

module.exports = {
  TECH_LEARNING_CATEGORIES,
  RETIRED_LEARNING_CATEGORIES,
  CI5_RECATEGORIZE_MAP,
  migrateRetiredCategories,
};
