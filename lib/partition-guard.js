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
// PRECEDENCE (spec precondition 11, GTM F-2, rev 3g — "the internal-wallet
// allowlist check must DOMINATE the null-account-equals-external rule"):
// this module never applies a standalone "no account id => external" rule.
// A row is external ONLY when it fails BOTH the platform check and the
// operator-register check. That is what makes an account-less submission
// from Auxilo's own wallet resolve internal instead of flipping the page to
// State B — isPlatformContributor (lib/accounts.js) already checks the
// wallet before falling through to the account-id-only branch, so reusing
// it here (rather than re-deriving a competing predicate) inherits that
// fix instead of re-introducing the bug it closed.
//
// Internal = isPlatformContributor(row, platformWallets)              -- the
//            existing REFUSE-gate predicate: platform wallet OR platform
//            account id OR (no wallet AND no account, i.e. fully
//            unattributed => platform by default) OR ...
//          OR isOperatorIdentity(row, register)                        -- "the
//            account of the builder behind Auxilo" (spec binding (c)): a
//            SEPARATE identity from the platform account, registered by
//            account id or by lowercased wallet in the tracked config file
//            plus any env-additive entries (REGISTER-BEFORE-USE, rev 3d).
//
// External = !Internal. Never a separate "null-account" branch evaluated
// ahead of or instead of the two checks above.
//
// FAIL-CLOSED: computePartition() never throws to its caller for a
// malformed catalog row (a bad row is skipped, not fatal) but DOES return
// null when it cannot form an opinion at all (empty/non-array input is a
// valid n=0 catalog, not a failure — that legitimately types as state 'a').
// The caller (server.js) additionally wraps the whole SSR call in try/catch
// so an unexpected throw here degrades to "neither branch" rather than a
// 500, per finding 13's render contract.

const fs = require('fs');

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
 * the same reason (spec rev 3b: "accounts alone was not enough").
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
 * The row-level internal/external predicate, spec build binding (c).
 * `isPlatformContributorFn` is injected (lib/accounts.js isPlatformContributor)
 * rather than required here, so this module stays a pure function of its
 * arguments and does not re-import server.js's PLATFORM_WALLETS wiring.
 */
function isInternalRow(row, { platformWallets, register, isPlatformContributorFn }) {
  if (isPlatformContributorFn(row, platformWallets)) return true;
  return isOperatorIdentity(row, register);
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
  let total = 0;
  let external = 0;
  let nullAccount = 0;
  for (const row of visibleRows) {
    if (!row || typeof row !== 'object') continue;
    total++;
    if (isInternalRow(row, { platformWallets, register, isPlatformContributorFn })) continue;
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

module.exports = {
  loadInternalIdentitiesRegister,
  isOperatorIdentity,
  isInternalRow,
  computePartition,
};
