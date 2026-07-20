'use strict';

/**
 * lib/ofac-rescreen.js — CP-1 (PUNCH-LIST §22, AML-PROGRAM §G-1): re-screen
 * VERIFIED-BUT-UNLINKED wallets on every SUCCESSFUL 24h OFAC SDN refresh.
 *
 * server.js's rescreenLinkedWallets() ("─── CP-1: Recurring linked-wallet
 * re-screen" section, near refreshOFACList) already re-screens every
 * account-linked wallet on each successful refresh and SUSPENDS THE ACCOUNT on
 * a hit (account.disabled_at blocks every authed route — requireAuth,
 * requireSessionOrApiKey, and the wallet-signed /withdraw suspension check).
 *
 * That sweep only walks account.wallet, though, and linkWallet() requires a
 * wallet to already be in the verifiedWallets store before it can be linked
 * (lib/accounts.js linkWallet step 3) — so every linked wallet is already a
 * MEMBER of verifiedWallets. The residual gap PUNCH-LIST CP-1 names ("re-run
 * checkOFAC over all linked + verified wallets") is wallets that completed
 * /wallet/verify but were NEVER linked to an account: wallet-only contributors
 * act entirely through wallet-signed routes (POST /learn contributor_wallet,
 * unlock settlement, /withdraw, /account/link-wallet) — no account, no
 * session — and every one of those routes already calls checkOFAC() live
 * against the freshly-refreshed sanctioned Set on every attempt. So payout
 * eligibility for a newly-sanctioned verified-only wallet is ALREADY frozen
 * the instant the refresh lands, with no new gate required anywhere on the
 * money-movement paths.
 *
 * What this sweep adds is the continuing-obligation RECORD (AML-PROGRAM
 * §G-1): detect the hit proactively — right when the list refreshes — instead
 * of waiting on the wallet's next attempted transaction (which may be days
 * away, or may never come while the wallet's learnings stay listed in the
 * catalog), log it to the OFAC block log, and alert ops. Idempotent: the hit
 * is stamped onto the wallet's OWN record inside the existing verifiedWallets
 * store (no parallel flag invented) so a persistent sanctions hit does not
 * re-alert every 24h cycle — mirrors the account.disabled_at alert-fatigue
 * guard rescreenLinkedWallets() already applies.
 *
 * Pure/injectable (deps object) so the decision logic is unit-testable
 * against a fixture without booting the server or waiting on the 24h timer —
 * mirrors the deps-injection pattern lib/x402-router.js already uses for its
 * own OFAC gate (checkOFAC/ofacScreeningReady/logOFACBlock passed in).
 *
 * Never throws: every external call (checkOFAC, logOFACBlock, sendOpsAlert)
 * is caller-supplied and assumed to already be defensive (checkOFAC is a pure
 * Set lookup; logOFACBlock catches its own fs write; sendOpsAlert never
 * throws per its own doc) — this function additionally never lets a bad
 * per-wallet iteration abort the sweep for the remaining wallets.
 */

/**
 * @param {object} params
 * @param {object} params.verifiedWallets
 *   The live verifiedWallets object (walletLower -> true | {verified, ofac_hit_at}).
 *   MUTATED IN PLACE on a hit — caller is responsible for persisting it
 *   (safeWrite(VERIFIED_WALLETS_FILE, verifiedWallets)) when results.hits > 0.
 * @param {Set<string>|string[]} params.linkedWalletsLower
 *   Lowercased account.wallet addresses already covered by the account-level
 *   sweep (rescreenLinkedWallets) — skipped here to avoid double-processing
 *   and double-alerting the same wallet under two different freeze semantics.
 * @param {string[]} params.platformWallets
 *   Platform identity wallets (any case) — never screened; screening our own
 *   boot wallet would self-brick every route that checks it for identity.
 * @param {(wallet: string) => boolean} params.checkOFAC
 * @param {(wallet: string, endpoint: string) => void} params.logOFACBlock
 * @param {(subject: string, body: string, opts: object) => Promise<any>} [params.sendOpsAlert]
 *   Optional — fire-and-forget; a missing/failing alert never blocks the sweep.
 * @returns {{ screened: number, hits: number, newlyFrozen: string[], alreadyFrozen: number }}
 */
function rescreenVerifiedWallets({
  verifiedWallets,
  linkedWalletsLower,
  platformWallets = [],
  checkOFAC,
  logOFACBlock,
  sendOpsAlert,
} = {}) {
  const results = { screened: 0, hits: 0, newlyFrozen: [], alreadyFrozen: 0 };
  if (!verifiedWallets || typeof verifiedWallets !== 'object') return results;
  if (typeof checkOFAC !== 'function' || typeof logOFACBlock !== 'function') return results;

  const linkedSet = linkedWalletsLower instanceof Set
    ? linkedWalletsLower
    : new Set(Array.isArray(linkedWalletsLower) ? linkedWalletsLower : []);
  const platformSet = new Set(
    (Array.isArray(platformWallets) ? platformWallets : [platformWallets])
      .filter((w) => typeof w === 'string')
      .map((w) => w.toLowerCase())
  );

  for (const rawWallet of Object.keys(verifiedWallets)) {
    try {
      const record = verifiedWallets[rawWallet];
      if (!record) continue; // falsy/revoked entry — not currently verified
      if (typeof rawWallet !== 'string') continue;
      const walletLower = rawWallet.toLowerCase();

      if (platformSet.has(walletLower)) continue; // never screen our own boot wallet
      if (linkedSet.has(walletLower)) continue;    // covered by the account-level sweep

      results.screened++;
      if (!checkOFAC(walletLower)) continue;

      const alreadyFlagged = typeof record === 'object' && !!record.ofac_hit_at;
      if (alreadyFlagged) {
        results.alreadyFrozen++;
        continue;
      }

      results.hits++;
      results.newlyFrozen.push(walletLower);
      logOFACBlock(walletLower, 'rescreen');
      // Freeze: stamp the hit on the wallet's OWN record in the existing
      // verifiedWallets store — checkOFAC() is already consulted live at
      // every wallet-signed money-movement route this wallet can reach, so
      // this stamp exists for the compliance record + alert-fatigue
      // idempotency, not to gate a route that wasn't already gated.
      verifiedWallets[rawWallet] = {
        verified: true,
        ofac_hit_at: new Date().toISOString(),
      };
    } catch (perWalletErr) {
      // One bad record must not abort the sweep for the rest of the store.
      console.error(`[OFAC] [CP-1] verified-wallet re-screen: skipping ${rawWallet} after error: ${perWalletErr.message}`);
    }
  }

  if (results.hits > 0 && typeof sendOpsAlert === 'function') {
    try {
      sendOpsAlert(
        '[Auxilo][OFAC] Verified-wallet re-screen HIT — payout eligibility frozen',
        `The 24h SDN refresh matched ${results.hits} verified-but-unlinked wallet(s) not previously flagged: ` +
        `${results.newlyFrozen.join(', ')}. checkOFAC() already blocks these wallets at every wallet-signed ` +
        `money-movement route (contribute, unlock settlement, /withdraw, /account/link-wallet) on the NEXT ` +
        `attempt; this alert is the continuing-obligation record required by AML-PROGRAM §G-1. Release ` +
        `requires manual compliance review per docs/AML-PROGRAM.md.`,
        { category: 'ofac' }
      ).catch(() => {});
    } catch {
      // sendOpsAlert must never be able to break the sweep.
    }
  }

  return results;
}

module.exports = { rescreenVerifiedWallets };
