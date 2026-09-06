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
// TRUST-P0 PASS 2 (2026-09-06, adversarial re-check, two more findings):
//
// FINDING B1 — isInternalRow carried two extra per-row fallback checks
// beyond the identity-membership test: `accountId && internalIdentities.has
// (accountId)` (redundant — identical to the identity check whenever an
// account id is present, since contributorIdentity() already picks the
// account id first) and, critically, `wallet && internalIdentities.has
// (wallet)` — this second one tested the ROW'S OWN wallet value against the
// flat identity set, which also contains every registered wallet string
// verbatim. A genuinely external account (its own account id, never
// registered, never linked) that happens to carry a registered/platform
// wallet on ONE of its rows (address reuse, a corrupted field, an
// out-of-band artifact) got THAT row flipped internal by the wallet check
// alone, split-braining the identity: some of its rows internal, some
// external, at the mercy of that catalog's actual wallet values. Depending
// on how those rows fell, this reproduced the same fabricated-partition
// failure mode findng 5 already named, on a shape rev-3g's fixtures never
// exercised (an external identity with a MIX of its own wallet and a
// registered wallet across its own rows).
//
// Fix: classification is per IDENTITY only. isInternalRow is now exactly
//   isPlatformContributorFn(row, platformWallets)            -- OR
//   internalIdentities.has(contributorIdentity(row))
// (isPlatformContributorFn is provably a subset of the identity check: every
// row shape it accepts already resolves, via contributorIdentity(), to an
// identity buildInternalIdentitySet always includes — PLATFORM_ACCOUNT_IDS,
// a platform wallet, or the platform default — so keeping it first is a
// fast path, never a source of disagreement.) The one-hop wallet->account
// link (buildInternalIdentitySet) is correspondingly tightened: an account
// id is added to INTERNAL_IDENTITIES only when EVERY row of that account
// which carries ANY wallet carries a wallet registered in the operator
// register (reg.wallets) — one row with a conflicting/unregistered wallet
// disqualifies the whole account from being linked. Both changes together
// make per-row disagreement within one identity structurally impossible
// (contributorIdentity(row) is the same value for every row of an identity,
// and internalIdentities.has(...) of that one value cannot itself vary), so
// the runtime check below is provable-always-passing given this logic — and
// still wired in as defense in depth against future drift.
//
// RUNTIME CONTRACT CHECK (replaces the old ad hoc "fixture f" guard):
// computePartition() calls partitionAgreesWithStatsTruth() on every
// invocation. If it ever reports a conflict (an identity classified both
// internal and external across its own rows — which the B1 fix above makes
// unreachable through this module's own logic, but a future edit could
// reintroduce), computePartition refuses to render either branch:
//   { state: null, reason: 'identity-conflict', conflicts: [...], total_n,
//     external_n: null, null_account_n: null }
// The caller (renderTrustPagePartition, server.js) treats partition.state
// === null exactly like a derivation failure — the static container's
// default data-partition-state="none" is left untouched, the page still
// 200s, and nothing is fabricated on either side.
//
// FINDING B2 — loadInternalIdentitiesRegister silently degraded ANY read
// failure (a corrupt/unparseable file, a permissions error — anything other
// than the file being absent) to an EMPTY register, the same shape as "no
// operator identities registered at all." That is indistinguishable from a
// legitimately-empty register to every caller downstream, so a corrupted
// config/internal-identities.json silently under-registered the operator
// identity and reproduced the exact live bug (a real internal row reads
// external, fabricating State B with a false magnitude sentence) — except
// triggered by file corruption instead of a missed one-hop link. ENOENT
// (the file genuinely absent) is unchanged and still degrades to an empty
// file layer (env additions still apply on top) — tests exercise this
// deliberately via a nonexistent path, and in production the tracked file's
// absence is a deploy-health question, not this function's to adjudicate on
// its own by fabricating a page state. Any OTHER read/parse failure (the
// file exists but is corrupt, unreadable, wrong shape) now returns a
// sentinel `{ error: message }` instead — logged once (registerReadErrorLogged)
// so the operational gap is visible without spamming stderr per request.
// computePartition checks for this sentinel before doing anything else and
// returns { state: null, reason: 'register-error', error, total_n,
// external_n: null, null_account_n: null } — same "neither branch" render
// contract as the identity-conflict path above.
//
// FAIL-CLOSED: computePartition() never throws to its caller for a
// malformed catalog row (a bad row is skipped, not fatal) but DOES return
// null when it cannot form an opinion at all (empty/non-array input is a
// valid n=0 catalog, not a failure — that legitimately types as state 'a'),
// and returns a `{ state: null, reason, ... }` object (never null itself)
// for the two "can compute total_n but must not pick a branch" cases above
// (identity-conflict, register-error). The caller (server.js) additionally
// wraps the whole SSR call in try/catch so an unexpected throw here
// degrades to "neither branch" rather than a 500, per finding 13's render
// contract.

const fs = require('fs');
const { PLATFORM_ACCOUNT_IDS } = require('./accounts.js');
const { PLATFORM_IDENTITY, contributorIdentity } = require('./stats-truth.js');

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
 * A missing file (ENOENT) is NOT fatal — it degrades to an empty file layer
 * (env additions still apply on top; isPlatformContributor's platform-
 * wallet/account check runs unaffected either way). TRUST-P0 pass 2
 * (finding B2): any OTHER read/parse failure — the file exists but is
 * corrupt, malformed, or unreadable for a reason other than absence — is no
 * longer degraded to an empty register. Silently treating "corrupt" the
 * same as "legitimately empty" is what let a broken config file reproduce
 * the live fabricated-State-B bug. Instead this returns a sentinel
 * `{ error: message }`; computePartition() checks for it up front and
 * refuses to serve either partition branch. Logged once (not per read) so
 * the operational gap is visible without spamming stderr on every request.
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
    if (e && e.code === 'ENOENT') {
      // Absent file: not fatal, degrade to an empty file layer below (env
      // additions still apply). See the doc comment above.
    } else {
      if (!registerReadErrorLogged) {
        registerReadErrorLogged = true;
        console.error('[PARTITION-GUARD] internal-identities register unreadable/corrupt, ' +
          'refusing to degrade to an empty register (partition renders neither branch):', e.message);
      }
      return { error: (e && e.message) || String(e) };
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
 * identity linking — sourced from the operator register's wallets only
 * (file + env; deliberately not platformWallets, whose own account ids are
 * already covered by PLATFORM_ACCOUNT_IDS without needing inference).
 *
 * TRUST-P0 pass 2 (finding B1, item c): linking now requires UNANIMITY, not
 * mere presence. An account id is linked internal only if EVERY row of that
 * account which carries ANY wallet carries a wallet registered in the
 * operator register — one row of the account carrying a conflicting,
 * unregistered wallet (address reuse, a corrupted field, an out-of-band
 * artifact) disqualifies the whole account from being linked. Rows of the
 * account that carry NO wallet at all are not evidence either way and do
 * not affect the vote. This is the change that makes the one-hop link
 * order-independent AND conflict-safe: it pre-scans every row of an account
 * before deciding, so a genuinely external account can never be flipped
 * internal by one stray row, in either direction.
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

  // One-hop identity linking (unanimity required — see doc comment above):
  // collect every wallet seen against each account id first, THEN decide.
  const walletsByAccount = new Map(); // accountId -> Set(normalizedWallet)
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    const accountId = nonEmptyString(row.contributor_account_id) ? row.contributor_account_id.trim() : null;
    if (!accountId) continue;
    const wallet = normalizeWallet(row.contributor_wallet);
    if (!wallet) continue;
    if (!walletsByAccount.has(accountId)) walletsByAccount.set(accountId, new Set());
    walletsByAccount.get(accountId).add(wallet);
  }
  for (const [accountId, wallets] of walletsByAccount) {
    let allRegistered = true;
    for (const w of wallets) {
      if (!reg.wallets.has(w)) { allRegistered = false; break; }
    }
    if (allRegistered) accountIds.add(accountId);
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
 *
 * TRUST-P0 pass 2 (finding B1): classification is per IDENTITY, not per
 * row. This used to also fall back to checking the row's OWN account id and
 * wallet directly against internalIdentities — the wallet fallback in
 * particular meant a row's classification could flip based on its own
 * wallet value alone, regardless of the account id that actually owns the
 * row, so a genuinely external account with one row carrying a registered
 * wallet (address reuse, a corrupted field) got THAT row read as internal
 * while its sibling rows read external — the same identity, split-brained.
 * The account-id fallback was always redundant (contributorIdentity()
 * already resolves to the account id first when one is present). Both are
 * gone: this is now exactly isPlatformContributorFn OR identity membership.
 */
function isInternalRow(row, { platformWallets, isPlatformContributorFn, internalIdentities }) {
  if (isPlatformContributorFn(row, platformWallets)) return true;
  if (!row || typeof row !== 'object' || !internalIdentities) return false;
  return internalIdentities.has(contributorIdentity(row));
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
 *
 * TRUST-P0 pass 2: two additional "cannot form an opinion, and must not
 * guess" cases, each returned as `{ state: null, reason, total_n,
 * external_n: null, null_account_n: null, ... }` (a real object, not a bare
 * null, so total_n stays reportable) — the caller (renderTrustPagePartition)
 * treats `partition.state === null` exactly like the plain-null case: serve
 * neither branch, leave data-partition-state at its default "none".
 *   reason: 'register-error'      — loadInternalIdentitiesRegister returned
 *                                    its corruption sentinel (finding B2);
 *                                    refused before any classification runs.
 *   reason: 'identity-conflict'   — partitionAgreesWithStatsTruth found an
 *                                    identity classified both internal and
 *                                    external across its own rows (finding
 *                                    B1's runtime contract check; the fixes
 *                                    in this module make this unreachable
 *                                    through this module's own logic, kept
 *                                    as defense in depth against drift).
 */
function computePartition(visibleRows, { platformWallets, register, isPlatformContributorFn }) {
  if (!Array.isArray(visibleRows)) return null;
  if (typeof isPlatformContributorFn !== 'function') return null;

  let total = 0;
  for (const row of visibleRows) {
    if (row && typeof row === 'object') total++;
  }

  if (register && register.error) {
    return {
      state: null,
      reason: 'register-error',
      error: register.error,
      total_n: total,
      external_n: null,
      null_account_n: null,
    };
  }

  const contract = partitionAgreesWithStatsTruth(visibleRows, { platformWallets, register, isPlatformContributorFn });
  if (!contract.agrees) {
    return {
      state: null,
      reason: 'identity-conflict',
      conflicts: [...contract.conflictIdentities],
      total_n: total,
      external_n: null,
      null_account_n: null,
    };
  }

  let external = 0;
  let nullAccount = 0;
  for (const row of visibleRows) {
    if (!row || typeof row !== 'object') continue;
    if (isInternalRow(row, { platformWallets, isPlatformContributorFn, internalIdentities: contract.internalIdentities })) continue;
    external++;
    if (!nonEmptyString(row.contributor_account_id)) nullAccount++;
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
