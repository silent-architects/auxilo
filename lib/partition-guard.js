'use strict';

// ─── PARTITION-GUARD: the trust page's §4 internal/external split ──────────
//
// TRUST-PAGE-BUILD-SPEC-2026-09-02.md rev 3g, finding 5 + build binding (c) +
// precondition 11. §4 states a frozen partition ("Auxilo's own learnings sit
// under two accounts... No outside builder has published here yet.") while
// §7 renders a live count on the same page. This module is the ONE partition
// computation both are meant to draw from (server.js wires §4's conditional
// render off it; §7 draws its counts from lib/stats-truth.js separately per
// the spec — the two are deliberately different derivations over the same
// visibleCatalog() input, never sharing raw numbers, per finding 2's
// corrected invariant).
//
// TRUST-P0 (2026-09-06): the rev-3g module above classified a row internal
// only when (a) isPlatformContributor said so, or (b) the row ITSELF carried
// a registered operator account id / wallet. That missed the shape the live
// catalog actually has: many rows carry the operator's real account id with
// NO wallet on that row at all (the wallet only appears elsewhere, on a
// different row from the same account, or was linked out-of-band via
// /account link-wallet). Those rows read as external with total_contributors
// = 2 on /knowledge/stats — a fabricated-looking "an outside builder has
// published here" on a catalog with no outside builder. Fix: derive from the
// SAME identity function GET /knowledge/stats uses (lib/stats-truth.js
// contributorIdentity — account id if present, else lowercased wallet, else
// the platform default) against one flat INTERNAL_IDENTITIES set, and add
// one-hop identity linking (wallet -> account id) so an account id that
// co-occurs on ANY visible row with a registered internal wallet is treated
// internal on EVERY row, wallet present or not.
//
// PRECEDENCE (spec precondition 11, GTM F-2, rev 3g — "the internal-wallet
// allowlist check must DOMINATE the null-account-equals-external rule",
// unchanged by TRUST-P0): this module never applies a standalone "no
// account id => external" rule. A row is external ONLY when neither the
// platform check nor the identity-membership check (including the linked
// account ids) resolves it internal.
//
// INTERNAL_IDENTITIES (buildInternalIdentitySet) =
//     PLATFORM_ACCOUNT_IDS (lib/accounts.js)
//   ∪ PLATFORM_WALLETS, lowercased (server.js, passed in as platformWallets)
//   ∪ the operator register's account_ids (config/internal-identities.json
//     + INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS)
//   ∪ the operator register's wallets, lowercased (same file
//     + INTERNAL_IDENTITIES_EXTRA_WALLETS)
//   ∪ account ids discovered by one-hop linking: any account id that
//     appears on a visible row TOGETHER WITH a registered internal wallet
//     (the operator register's wallets specifically — not platform wallets,
//     whose own account ids are already covered by PLATFORM_ACCOUNT_IDS
//     without needing inference) is added for the whole catalog. Logs
//     nothing (no wallet/account value ever reaches console/stderr here).
//
// A row is internal iff:
//   isPlatformContributor(row, platformWallets)                    -- OR
//   contributorIdentity(row) ∈ INTERNAL_IDENTITIES                 -- OR
//   row.contributor_account_id ∈ INTERNAL_IDENTITIES (when present) -- OR
//   normalizeWallet(row.contributor_wallet) ∈ INTERNAL_IDENTITIES (when present)
// The last three are one predicate (isInternalIdentityMatch): checking the
// account id and wallet independently, in addition to the identity function's
// own (account-id-first) pick, catches the shape where a row's `wallet` is
// internal but its `account id` alone would resolve to something not (yet)
// in the set — contributorIdentity() only reports ONE of the two per row.
//
// External = !Internal.
//
// GUARD (finding-13-class defense in depth, TRUST-P0 fixture f): after the
// per-row pass, if GET /knowledge/stats' own countDistinctContributors()
// over the same rows agrees that every distinct contributor present is
// internal, the partition is forced to state 'a' / external_n 0 even if a
// stray per-row check disagreed — the identity-level truth dominates a
// row-level miscount, so this module can never serve a fabricated State B
// on a catalog stats-truth itself says has no external contributor.
//
// FAIL-CLOSED: computePartition() never throws to its caller for a
// malformed catalog row (a bad row is skipped, not fatal) but DOES return
// null when it cannot form an opinion at all (empty/non-array input is a
// valid n=0 catalog, not a failure — that legitimately types as state 'a').
// The caller (server.js) additionally wraps the whole SSR call in try/catch
// so an unexpected throw here degrades to "neither branch" rather than a
// 500, per finding 13's render contract.

const fs = require('fs');
const { PLATFORM_ACCOUNT_IDS } = require('./accounts.js');
const { PLATFORM_IDENTITY, contributorIdentity, countDistinctContributors } = require('./stats-truth.js');

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeWallet(wallet) {
  if (wallet === null || wallet === undefined) return null;
  const s = String(wallet).trim();
  return s.length ? s.toLowerCase() : null;
}

function toSet(values) {
  const out = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed) out.add(trimmed);
  }
  return out;
}

function toWalletSet(values) {
  const out = new Set();
  for (const v of Array.isArray(values) ? values : []) {
    const w = normalizeWallet(v);
    if (w) out.add(w);
  }
  return out;
}

/**
 * Load the operator-identity register: config/internal-identities.json
 * (public-safe, wallet addresses and account ids only, per spec rev 3d)
 * PLUS env-additive entries — ADDITIVE per environment, never a replacement
 * for the tracked file (REGISTER-BEFORE-USE: a probe or staging wallet gets
 * added via env without editing the tracked file, and a real registration
 * still requires landing in the tracked file for it to survive across
 * environments).
 *
 * Env additions: INTERNAL_IDENTITIES_EXTRA_WALLETS /
 * INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS, comma-separated.
 *
 * A missing or unreadable file is NOT fatal — it degrades to an empty
 * operator register (isPlatformContributor's platform-wallet/account check
 * still runs unaffected), logged once so the gap is visible operationally
 * rather than silently under-registering.
 */
let registerReadErrorLogged = false;
function loadInternalIdentitiesRegister(filePath, env) {
  let fileWallets = [];
  let fileAccountIds = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      fileWallets = Array.isArray(parsed.wallets) ? parsed.wallets : [];
      fileAccountIds = Array.isArray(parsed.account_ids) ? parsed.account_ids : [];
    }
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) {
      if (!registerReadErrorLogged) {
        registerReadErrorLogged = true;
        console.error('[PARTITION-GUARD] internal-identities register unreadable, ' +
          'operator identities degrade to env-only (platform check unaffected):', e.message);
      }
    }
  }
  const envSource = env || process.env;
  const envWallets = (envSource.INTERNAL_IDENTITIES_EXTRA_WALLETS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const envAccountIds = (envSource.INTERNAL_IDENTITIES_EXTRA_ACCOUNT_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return {
    wallets: toWalletSet([...fileWallets, ...envWallets]),
    accountIds: toSet([...fileAccountIds, ...envAccountIds]),
  };
}

/**
 * Is this row the account of the builder behind Auxilo (or any other
 * registered operator identity)? Checked by account id (exact, trimmed) OR
 * by lowercased wallet — same dual check as the platform predicate, and for
 * the same reason (spec rev 3b: "accounts alone was not enough"). This is
 * the UNLINKED, single-row check against the register as tracked/env-loaded
 * (no cross-row inference) — kept as its own export because it is a useful,
 * cheap, pure predicate on its own and existing callers/tests exercise it
 * directly. computePartition below does NOT call this any more; it builds
 * the fuller, linked INTERNAL_IDENTITIES set (buildInternalIdentitySet) and
 * checks membership in that instead, which is a strict superset of what
 * this function alone recognizes.
 */
function isOperatorIdentity(row, register) {
  if (!row || typeof row !== 'object' || !register) return false;
  const accountId = nonEmptyString(row.contributor_account_id) ? row.contributor_account_id.trim() : null;
  if (accountId && register.accountIds.has(accountId)) return true;
  const wallet = normalizeWallet(row.contributor_wallet);
  if (wallet && register.wallets.has(wallet)) return true;
  return false;
}

/**
 * Build the flat INTERNAL_IDENTITIES set for one catalog snapshot: the
 * static allowlist (platform account ids/wallets + the operator register's
 * account ids/wallets) UNIONED with account ids discovered by one-hop
 * identity linking (TRUST-P0 item 2) — any account id that appears on a
 * visible row together with a REGISTERED internal wallet (the operator
 * register's wallets, file + env; deliberately not platformWallets, whose
 * own account ids are already covered by PLATFORM_ACCOUNT_IDS without
 * needing inference) is internal for the whole catalog, wallet present on
 * that particular row or not.
 *
 * No wallet or account id value is ever logged by this function.
 */
function buildInternalIdentitySet(rows, { platformWallets, register }) {
  const reg = register && register.wallets && register.accountIds
    ? register
    : { wallets: new Set(), accountIds: new Set() };

  const walletsLower = new Set();
  for (const w of Array.isArray(platformWallets) ? platformWallets : [platformWallets]) {
    const nw = normalizeWallet(w);
    if (nw) walletsLower.add(nw);
  }
  for (const w of reg.wallets) walletsLower.add(w);

  const accountIds = new Set(PLATFORM_ACCOUNT_IDS);
  for (const a of reg.accountIds) accountIds.add(a);

  // One-hop identity linking: wallet -> account id, sourced from the
  // operator register's wallets only (see comment above).
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const wallet = normalizeWallet(row.contributor_wallet);
    const accountId = nonEmptyString(row.contributor_account_id) ? row.contributor_account_id.trim() : null;
    if (wallet && accountId && reg.wallets.has(wallet)) accountIds.add(accountId);
  }

  const combined = new Set(accountIds);
  for (const w of walletsLower) combined.add(w);
  combined.add(PLATFORM_IDENTITY); // parity with contributorIdentity()'s null/null default
  return combined;
}

/**
 * The row-level internal/external predicate, spec build binding (c),
 * extended by TRUST-P0. `isPlatformContributorFn` is injected (lib/accounts.js
 * isPlatformContributor) rather than required here, so this module stays a
 * pure function of its arguments and does not re-import server.js's
 * PLATFORM_WALLETS wiring. `internalIdentities` is the flat set from
 * buildInternalIdentitySet — computed ONCE per catalog snapshot by the
 * caller (computePartition), not per row.
 */
function isInternalRow(row, { platformWallets, isPlatformContributorFn, internalIdentities }) {
  if (isPlatformContributorFn(row, platformWallets)) return true;
  if (!row || typeof row !== 'object' || !internalIdentities) return false;
  const identity = contributorIdentity(row);
  if (internalIdentities.has(identity)) return true;
  const accountId = nonEmptyString(row.contributor_account_id) ? row.contributor_account_id.trim() : null;
  if (accountId && internalIdentities.has(accountId)) return true;
  const wallet = normalizeWallet(row.contributor_wallet);
  if (wallet && internalIdentities.has(wallet)) return true;
  return false;
}

/**
 * Compute the §4 partition over the visible catalog.
 *   { total_n, external_n, null_account_n, state }  state: 'a' | 'b'
 * `null_account_n` is reported INSIDE external and is never itself a fail
 * condition (spec rev 3a correction) — a post-SEED-ATTR null-account visible
 * row is a wallet-only OUTSIDE submission, not a regression.
 *
 * Returns null only when `visibleRows` is not an array at all (a shape the
 * caller should treat as a derivation failure, not as n=0) — an EMPTY array
 * is a legitimate zero-learning catalog and correctly types as state 'a'.
 */
function computePartition(visibleRows, { platformWallets, register, isPlatformContributorFn }) {
  if (!Array.isArray(visibleRows)) return null;
  if (typeof isPlatformContributorFn !== 'function') return null;

  const internalIdentities = buildInternalIdentitySet(visibleRows, { platformWallets, register });

  let total = 0;
  let external = 0;
  let nullAccount = 0;
  const allIdentitiesPresent = new Set();
  const internalIdentitiesPresent = new Set();

  for (const row of visibleRows) {
    if (!row || typeof row !== 'object') continue;
    total++;
    const identity = contributorIdentity(row);
    allIdentitiesPresent.add(identity);
    if (isInternalRow(row, { platformWallets, isPlatformContributorFn, internalIdentities })) {
      internalIdentitiesPresent.add(identity);
      continue;
    }
    external++;
    if (!nonEmptyString(row.contributor_account_id)) nullAccount++;
  }

  // Fixture (f) guard: force state 'a' whenever the identity-level truth
  // stats-truth would report (countDistinctContributors) says every
  // distinct contributor present is internal — never let a stray row-level
  // disagreement fabricate a State B the stats page itself contradicts.
  if (total > 0 && countDistinctContributors(visibleRows) === internalIdentitiesPresent.size &&
      internalIdentitiesPresent.size === allIdentitiesPresent.size) {
    external = 0;
    nullAccount = 0;
  }

  return {
    total_n: total,
    external_n: external,
    null_account_n: nullAccount,
    state: external > 0 ? 'b' : 'a',
  };
}

/**
 * Contract check (TRUST-P0 item 1): the set of distinct contributorIdentity
 * values among rows the partition classes external must be EXACTLY the
 * catalog's full distinct-identity set minus INTERNAL_IDENTITIES — and no
 * identity may be split-brained (some of its rows internal, others external).
 * Returns a diagnostic object; `agrees` is the boolean a test asserts on.
 */
function partitionAgreesWithStatsTruth(rows, { platformWallets, register, isPlatformContributorFn }) {
  const list = Array.isArray(rows) ? rows : [];
  const internalIdentities = buildInternalIdentitySet(list, { platformWallets, register });

  const classification = new Map(); // identity -> 'internal' | 'external' | 'conflict'
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const identity = contributorIdentity(row);
    const internal = isInternalRow(row, { platformWallets, isPlatformContributorFn, internalIdentities });
    const cls = internal ? 'internal' : 'external';
    const prev = classification.get(identity);
    if (prev === undefined) classification.set(identity, cls);
    else if (prev !== cls) classification.set(identity, 'conflict');
  }

  const allIdentities = new Set(classification.keys());
  const externalIdentities = new Set(
    [...classification.entries()].filter(([, v]) => v === 'external').map(([k]) => k)
  );
  const conflictIdentities = new Set(
    [...classification.entries()].filter(([, v]) => v === 'conflict').map(([k]) => k)
  );
  const expectedExternal = new Set([...allIdentities].filter((id) => !internalIdentities.has(id)));

  const agrees = conflictIdentities.size === 0 &&
    expectedExternal.size === externalIdentities.size &&
    [...expectedExternal].every((id) => externalIdentities.has(id));

  return { agrees, allIdentities, externalIdentities, internalIdentities, conflictIdentities, expectedExternal };
}

module.exports = {
  loadInternalIdentitiesRegister,
  isOperatorIdentity,
  buildInternalIdentitySet,
  isInternalRow,
  computePartition,
  partitionAgreesWithStatsTruth,
};
