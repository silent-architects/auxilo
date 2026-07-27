'use strict';

/**
 * test/aud19-funnel.test.js — 2026-07-19 audit: first-contribution funnel fixes
 *
 * Covers PUNCH-LIST §26 rows:
 *   AUD19-4 — MCP quality passthrough + self-approval discoverability
 *   AUD19-6 — server-side quality floor (quarantine, not reject)
 *   AUD19-3 — wallet-only orphan cure (adoption + guidance + queue-entry alert)
 *   AUD19-8 — dashboard CP-7 framing (held-balance visibility; sweep tests live
 *             in test/cp6-accrual-gate.test.js)
 *
 * Style matches the cp6/assent suites: pure-logic tests against lib modules
 * (the load-bearing behavior) + source-level wiring assertions against
 * server.js / mcp-server.js / dashboard.html (server.js hardcodes PORT/DATA_DIR
 * so its endpoints are otherwise only assertable statically).
 *
 * Runner: node --test test/aud19-funnel.test.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  meetsQualityFloor,
  QUALITY_FLOOR_TOTAL,
  QUALITY_FLOOR_DIMENSION,
  adoptWalletOrphans,
  listOwnPending,
  applySelfDecision,
} = require('../lib/self-review.js');
const {
  EIP712_DOMAIN,
  CHALLENGE_TYPES,
  createNonce,
  consumeNonce,
  linkAction,
  verifyLinkSignature,
} = require('../lib/eip712.js');
const { linkWallet } = require('../lib/accounts.js');
const { privateKeyToAccount } = require('viem/accounts');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');
const DASHBOARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf-8');

// ─── AUD19-6: quality floor predicate ───────────────────────────────────────────

describe('meetsQualityFloor (AUD19-6)', () => {
  it('exports the documented floor constants (14 total / 3 per dimension)', () => {
    assert.equal(QUALITY_FLOOR_TOTAL, 14);
    assert.equal(QUALITY_FLOOR_DIMENSION, 3);
  });
  it('true at exactly the floor (4+4+3+3 = 14)', () => {
    assert.equal(meetsQualityFloor({ specificity: 4, actionability: 4, novelty: 3, completeness: 3, total: 14 }), true);
  });
  it('true well above the floor', () => {
    assert.equal(meetsQualityFloor({ specificity: 5, actionability: 5, novelty: 4, completeness: 4, total: 18 }), true);
  });
  it('false one below the total floor (13)', () => {
    assert.equal(meetsQualityFloor({ specificity: 4, actionability: 3, novelty: 3, completeness: 3, total: 13 }), false);
  });
  it('false when ANY dimension is below 3, even with total >= 14 (5+5+5+2 = 17)', () => {
    assert.equal(meetsQualityFloor({ specificity: 5, actionability: 5, novelty: 5, completeness: 2, total: 17 }), false);
  });
  it('fail-closed on null / missing / malformed input', () => {
    assert.equal(meetsQualityFloor(null), false);
    assert.equal(meetsQualityFloor(undefined), false);
    assert.equal(meetsQualityFloor({}), false);
    assert.equal(meetsQualityFloor([]), false);
    assert.equal(meetsQualityFloor({ specificity: 4, actionability: 4, novelty: 3, completeness: 3 }), false); // no total
    assert.equal(meetsQualityFloor({ specificity: '4', actionability: 4, novelty: 3, completeness: 3, total: 14 }), false); // non-int dim
  });
});

describe('server.js: quality floor wiring (AUD19-6)', () => {
  it('imports meetsQualityFloor and folds it into the /learn seamless predicate', () => {
    assert.ok(SERVER_SRC.includes('meetsQualityFloor'), 'imported');
    assert.ok(/qualityMeetsFloor = qualityPresent && meetsQualityFloor\(quality_self_assessment\)/.test(SERVER_SRC),
      'floor evaluated at the validation/predicate site');
    assert.ok(/qualityPresent &&\s*\n\s*qualityMeetsFloor;/.test(SERVER_SRC),
      'seamlessEligible requires the floor, not just presence');
  });
  it("quarantines below-floor submissions with review_reason 'below_quality_floor' (never a hard reject)", () => {
    assert.ok(SERVER_SRC.includes("learnReviewReasons.push('below_quality_floor')"));
    // No 400/422 return keyed on the floor — quarantine only.
    assert.ok(!/below_quality_floor[\s\S]{0,200}?,\s*4\d\d\)/.test(SERVER_SRC),
      'the floor must route to pending_review, not an error status');
  });
  it('contributor self-approval deliberately carries NO quality gate (documented choice)', () => {
    const selfReviewSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'self-review.js'), 'utf-8');
    assert.ok(selfReviewSrc.includes('DELIBERATE NON-GATE'),
      'the choice must be documented where the floor lives');
  });
});

describe('applySelfDecision keeps human authority over below-floor items (AUD19-6)', () => {
  it('a human self-approve succeeds on an item quarantined below the floor', () => {
    const learnings = [{
      id: 'lrn_lowq',
      title: 'Low-scored but human-vetted',
      status: 'pending_review',
      category: 'code-execution',
      contributor_account_id: 'acc_h',
      quality_self_assessment: { specificity: 3, actionability: 3, novelty: 3, completeness: 3, total: 12 },
    }];
    const r = applySelfDecision(learnings, 'acc_h', 'lrn_lowq', 'approve');
    assert.equal(r.ok, true);
    assert.equal(learnings[0].status, 'approved');
    assert.equal(learnings[0].moderation, 'manual');
  });
});

// ─── AUD19-3(b): wallet-orphan adoption ─────────────────────────────────────────

const W = '0xAbC0000000000000000000000000000000000009';

function orphan(id, status, extra = {}) {
  return {
    id,
    title: `orphan ${id}`,
    status,
    contributor_account_id: null,
    contributor_wallet: W.toLowerCase(),
    ...extra,
  };
}

describe('adoptWalletOrphans (AUD19-3b)', () => {
  it('adopts a null-account, matching-wallet pending item: binds ownership + stamps provenance', () => {
    const learnings = [orphan('lrn_o1', 'pending_review')];
    const ids = adoptWalletOrphans(learnings, 'acc_new', W.toLowerCase());
    assert.deepEqual(ids, ['lrn_o1']); // MED-3: ids returned, not just a count
    assert.equal(learnings[0].contributor_account_id, 'acc_new');
    assert.equal(learnings[0].ownership_adopted.via, 'verified_wallet_link');
    assert.equal(learnings[0].ownership_adopted.by, 'acc_new');
  });
  it('is case-insensitive on the wallet address', () => {
    const learnings = [orphan('lrn_o2', 'pending_review')];
    const ids = adoptWalletOrphans(learnings, 'acc_new', W); // mixed-case input
    assert.equal(ids.length, 1);
  });
  it('adopts across statuses (published wallet-only items regain retraction/attribution too)', () => {
    const learnings = [orphan('lrn_o3', 'pending_review'), orphan('lrn_o4', 'approved')];
    assert.deepEqual(adoptWalletOrphans(learnings, 'acc_new', W), ['lrn_o3', 'lrn_o4']);
  });
  it('NEVER touches already-owned items or other wallets; returns the exact count', () => {
    const learnings = [
      orphan('lrn_o5', 'pending_review'),
      { id: 'lrn_owned', status: 'pending_review', contributor_account_id: 'acc_other', contributor_wallet: W.toLowerCase() },
      { id: 'lrn_otherw', status: 'pending_review', contributor_account_id: null, contributor_wallet: '0xdead000000000000000000000000000000000001' },
      { id: 'lrn_nowallet', status: 'pending_review', contributor_account_id: null, contributor_wallet: null },
    ];
    const ids = adoptWalletOrphans(learnings, 'acc_new', W);
    assert.deepEqual(ids, ['lrn_o5']);
    assert.equal(learnings[1].contributor_account_id, 'acc_other'); // foreign ownership untouched
    assert.equal(learnings[2].contributor_account_id, null);
    assert.equal(learnings[3].contributor_account_id, null);
  });
  it('is idempotent: a second adoption pass adopts nothing', () => {
    const learnings = [orphan('lrn_o6', 'pending_review')];
    assert.equal(adoptWalletOrphans(learnings, 'acc_new', W).length, 1);
    assert.equal(adoptWalletOrphans(learnings, 'acc_new', W).length, 0);
  });
  it('no-ops safely on missing inputs', () => {
    assert.deepEqual(adoptWalletOrphans(null, 'acc', W), []);
    assert.deepEqual(adoptWalletOrphans([], null, W), []);
    assert.deepEqual(adoptWalletOrphans([orphan('x', 'pending_review')], 'acc', null), []);
  });
  it('END-TO-END CURE: invisible orphan → adopt → listed → self-approvable', () => {
    const learnings = [orphan('lrn_cure', 'pending_review', { body: 'the held learning body', category: 'monitoring', created_at: 'now' })];
    // Before: the account-scoped queue cannot see it, and a decision is forbidden.
    assert.equal(listOwnPending(learnings, 'acc_new').length, 0);
    assert.equal(applySelfDecision(learnings, 'acc_new', 'lrn_cure', 'approve').code, 'forbidden');
    // Adoption (server calls this only with the account's VERIFIED linked wallet).
    assert.equal(adoptWalletOrphans(learnings, 'acc_new', W).length, 1);
    // After: visible and decidable — the whole existing review stack works.
    const listed = listOwnPending(learnings, 'acc_new');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, 'lrn_cure');
    const r = applySelfDecision(learnings, 'acc_new', 'lrn_cure', 'approve');
    assert.equal(r.ok, true);
    assert.equal(learnings[0].status, 'approved');
  });
});

describe('server.js: adoption wiring (AUD19-3b)', () => {
  it('link-wallet adopts orphans with the just-verified wallet (result.wallet, never a claimed one)', () => {
    const i = SERVER_SRC.indexOf("app.post('/account/link-wallet'");
    assert.notEqual(i, -1);
    const h = SERVER_SRC.slice(i, i + 16000); // handler grew with the HIGH-1 challenge flow + CP-2 capture (Wave 2b)
    assert.ok(h.includes('adoptWalletOrphans(learnings, accountId, result.wallet)'));
    assert.ok(/adoptedIds\.length > 0[\s\S]{0,220}safeWrite\(LEARNINGS_FILE/.test(h), 'persists only when something adopted');
  });
  it('pending read paths run the lazy retroactive cure with a VERIFIED-wallet ownership check', () => {
    const i = SERVER_SRC.indexOf('function adoptOrphansForAccount');
    assert.notEqual(i, -1, 'lazy-adoption helper must exist');
    const h = SERVER_SRC.slice(i, i + 1500);
    assert.ok(h.includes('loadAccounts()[accountId]'), 'authoritative account read');
    assert.ok(h.includes('verifiedWallets['), 'defense-in-depth re-check against the verified store');
    // Wired into both read surfaces.
    const pendingIdx = SERVER_SRC.indexOf("app.get('/account/pending'");
    const summaryIdx = SERVER_SRC.indexOf("app.get('/account/pending/summary'");
    assert.ok(SERVER_SRC.slice(pendingIdx, pendingIdx + 1200).includes('adoptOrphansForAccount(accountId)'));
    assert.ok(SERVER_SRC.slice(summaryIdx, summaryIdx + 1200).includes('adoptOrphansForAccount(accountId)'));
  });
});

// ─── AUD19-3(a)+AUD19-4: actionable pending response ────────────────────────────

describe('server.js: /learn pending response tells the contributor how to act (AUD19-4 / AUD19-3a)', () => {
  it('includes a how_to_review field on pending_review responses', () => {
    assert.ok(SERVER_SRC.includes('how_to_review'), 'field exists');
    assert.ok(/\.\.\.\(howToReview && \{ how_to_review: howToReview \}\)/.test(SERVER_SRC), 'attached to the /learn 201');
  });
  it('account-bound guidance names all three self-review surfaces', () => {
    const i = SERVER_SRC.indexOf('const howToReview');
    const h = SERVER_SRC.slice(i, i + 1600);
    assert.ok(h.includes('auxilo review'), 'CLI');
    assert.ok(h.includes('/dashboard'), 'dashboard queue');
    assert.ok(h.includes('/account/pending'), 'API surface');
  });
  it('wallet-only guidance points at the setup + same-wallet-link cure (npx auxilo setup)', () => {
    const i = SERVER_SRC.indexOf('const howToReview');
    const h = SERVER_SRC.slice(i, i + 1600);
    assert.ok(h.includes('npx auxilo setup'));
    assert.ok(h.includes('auxilo_verify_wallet'));
    assert.ok(h.includes('auxilo_link_wallet'));
  });
});

// ─── AUD19-3(c): queue-entry ops alert ──────────────────────────────────────────

describe('server.js: pending_review queue-entry ops alert (AUD19-3c)', () => {
  it('defines a batched/throttled notifier wired to sendOpsAlert', () => {
    const i = SERVER_SRC.indexOf('function notePendingReviewEntries');
    assert.notEqual(i, -1);
    const h = SERVER_SRC.slice(i, i + 2500);
    assert.ok(h.includes('PENDING_REVIEW_ALERT_INTERVAL_MS'), 'throttled by the interval');
    assert.ok(h.includes('sendOpsAlert'), 'delivers via the ops-alert rail');
    assert.ok(h.includes('_pendingAlertNewCount += newCount'), 'restores the count on failed delivery');
  });
  it('interval is env-tunable with a sane multi-hour default', () => {
    assert.ok(/PENDING_REVIEW_ALERT_INTERVAL_MS\s*=[\s\S]{0,300}6 \* 60 \* 60 \* 1000/.test(SERVER_SRC));
  });
  it('fires on the /learn, /extract, and chat-pipeline pending paths', () => {
    const calls = SERVER_SRC.match(/notePendingReviewEntries\(/g) || [];
    assert.ok(calls.length >= 4, `definition + >=3 call sites expected, found ${calls.length}`); // 1 def + 3 sites
    assert.ok(/source: '\/learn'/.test(SERVER_SRC));
    assert.ok(/source: '\/extract'/.test(SERVER_SRC));
    assert.ok(/source: 'chat_pipeline'/.test(SERVER_SRC));
  });
});

// ─── AUD19-4: MCP contract (ships via npm auxilo-mcp@0.9.2) ─────────────────────

describe('mcp-server.js: auxilo_contribute quality passthrough (AUD19-4)', () => {
  it('inputSchema declares quality_self_assessment with all four dimensions + total', () => {
    const i = MCP_SRC.indexOf("name: 'auxilo_contribute'");
    assert.notEqual(i, -1);
    const h = MCP_SRC.slice(i, MCP_SRC.indexOf("name: 'auxilo_knowledge'", i));
    assert.ok(h.includes('quality_self_assessment'), 'field present in the tool schema');
    for (const dim of ['specificity', 'actionability', 'novelty', 'completeness', 'total']) {
      assert.ok(h.includes(`${dim}:`), `schema declares ${dim}`);
    }
    assert.ok(/required: \['specificity', 'actionability', 'novelty', 'completeness', 'total'\]/.test(h),
      'sub-fields required so a cold LLM sends the full shape');
  });
  it('the handler passes quality_self_assessment through to POST /learn', () => {
    const i = MCP_SRC.indexOf("case 'auxilo_contribute':");
    assert.notEqual(i, -1);
    const h = MCP_SRC.slice(i, i + 1600);
    assert.ok(h.includes('quality_self_assessment: args.quality_self_assessment'),
      'without the passthrough qualityPresent is always false server-side');
  });
  it('tool description teaches the floor + the pending self-review path', () => {
    const i = MCP_SRC.indexOf("name: 'auxilo_contribute'");
    const h = MCP_SRC.slice(i, i + 2600);
    assert.ok(h.includes('quality_self_assessment'), 'description names the field');
    assert.ok(h.includes('auxilo review'), 'description names the self-review surface');
  });
  it('auxilo_account_earnings description names held_pending_assent (AUD19-8b passthrough)', () => {
    const i = MCP_SRC.indexOf("name: 'auxilo_account_earnings'");
    const h = MCP_SRC.slice(i, i + 1200);
    assert.ok(h.includes('held_pending_assent'));
  });
});

// ─── Gate-A HIGH-1: account-bound proof of wallet control at link time ──────────
//
// The takeover chain the review found: /wallet/verify is unauthenticated and
// account-blind; every wallet-only contributor's wallet is in verifiedWallets
// by construction; linkWallet checked only global-set membership + uniqueness.
// So any ToS-accepted attacker account could link a victim's verified wallet
// and the adoption/migration/sweep hooks would hand it the victim's learnings
// and earnings, with the 409-uniqueness check locking the real owner out. The
// fix: linking demands a FRESH EIP-712 signature by the wallet's key over a
// single-use nonce whose signed action string carries the linking accountId.

const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // well-known dev key, never used on-chain
const ATTACKER_PK = '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'; // second well-known dev key
const ownerAccount = privateKeyToAccount(OWNER_PK);
const attackerAccount = privateKeyToAccount(ATTACKER_PK);
const OWNER_WALLET = ownerAccount.address;

function signLink(signer, wallet, accountId, nonce, timestamp) {
  return signer.signTypedData({
    domain: EIP712_DOMAIN,
    types: CHALLENGE_TYPES,
    primaryType: 'Challenge',
    message: { wallet, nonce, timestamp: BigInt(timestamp), action: linkAction(accountId) },
  });
}

describe('link challenge crypto (HIGH-1)', () => {
  it('HAPPY PATH: the wallet key signing its own account-bound link challenge verifies', async () => {
    const { nonce, timestamp } = createNonce(OWNER_WALLET, linkAction('acc_owner'));
    const sig = await signLink(ownerAccount, OWNER_WALLET, 'acc_owner', nonce, timestamp);
    const consumed = consumeNonce(OWNER_WALLET);
    assert.equal(consumed.action, linkAction('acc_owner'));
    assert.equal(await verifyLinkSignature(OWNER_WALLET, 'acc_owner', consumed.nonce, consumed.timestamp, sig), true);
  });
  it('ATTACKER KEY: a signature from any other key never verifies for the wallet', async () => {
    const { nonce, timestamp } = createNonce(OWNER_WALLET, linkAction('acc_attacker'));
    // Attacker signs with THEIR key, claiming the victim's wallet.
    const sig = await signLink(attackerAccount, OWNER_WALLET, 'acc_attacker', nonce, timestamp);
    const consumed = consumeNonce(OWNER_WALLET);
    assert.equal(await verifyLinkSignature(OWNER_WALLET, 'acc_attacker', consumed.nonce, consumed.timestamp, sig), false);
  });
  it('CROSS-ACCOUNT REPLAY: a signature minted for one account fails verification for another', async () => {
    const { nonce, timestamp } = createNonce(OWNER_WALLET, linkAction('acc_owner'));
    const sig = await signLink(ownerAccount, OWNER_WALLET, 'acc_owner', nonce, timestamp);
    const consumed = consumeNonce(OWNER_WALLET);
    // The accountId is inside the SIGNED message — verifying for a different
    // account changes the message and the signature no longer matches.
    assert.equal(await verifyLinkSignature(OWNER_WALLET, 'acc_other', consumed.nonce, consumed.timestamp, sig), false);
  });
  it('NONCE REPLAY: the link nonce is single-use — a second consume returns null', () => {
    createNonce(OWNER_WALLET, linkAction('acc_owner'));
    assert.notEqual(consumeNonce(OWNER_WALLET), null);
    assert.equal(consumeNonce(OWNER_WALLET), null);
  });
  it('ACTION BINDING: a generic verify-challenge nonce is distinguishable from a link nonce', () => {
    createNonce(OWNER_WALLET, 'challenge');
    const consumed = consumeNonce(OWNER_WALLET);
    // The server-side gate checks action === linkAction(accountId); a plain
    // 'challenge' nonce (from /wallet/challenge) must never satisfy it.
    assert.notEqual(consumed.action, linkAction('acc_owner'));
  });
});

describe('server.js: link-wallet demands account-bound proof (HIGH-1 wiring)', () => {
  const i = SERVER_SRC.indexOf("app.post('/account/link-wallet'");
  const h = SERVER_SRC.slice(i, i + 16000); // widened for CP-2 capture (Wave 2b)
  it('no signature → returns the account-bound challenge (link_signature_required), rate-limited', () => {
    assert.ok(h.includes("code: 'link_signature_required'"));
    assert.ok(h.includes('checkChallengeRateLimit(wallet)'), 'challenge minting shares the /wallet/challenge rate limit');
    assert.ok(h.includes('linkAction(accountId)'), 'the accountId is bound into the challenge action');
  });
  it('signature path consumes the nonce and verifies the account-bound signature BEFORE linking', () => {
    const consumeAt = h.indexOf('consumeNonce(wallet)');
    const verifyAt = h.indexOf('verifyLinkSignature');
    const linkAt = h.indexOf('linkWallet(accountId');
    assert.ok(consumeAt !== -1 && verifyAt !== -1 && linkAt !== -1);
    assert.ok(consumeAt < verifyAt && verifyAt < linkAt,
      'consume (single-use) → verify → link, in that order');
    assert.ok(h.includes("linkNonce.action !== linkAction(accountId)"),
      'a nonce issued for another account (or a non-link nonce) is rejected');
  });
  it('adoption/migration/sweep run only AFTER the proof (takeover chain broken)', () => {
    const verifyAt = h.indexOf('verifyLinkSignature');
    for (const hook of ['lazyMigrateOnWalletLink', 'sweepHeldEarnings', 'adoptWalletOrphans']) {
      assert.ok(h.indexOf(hook) > verifyAt, `${hook} must sit after signature verification`);
    }
  });
  it('TEST_MODE bypass is production-gated (mirrors /wallet/verify)', () => {
    assert.ok(/NODE_ENV !== 'production' && process\.env\.TEST_MODE === '1' && signature === 'test-bypass'/.test(h));
  });
  it('MED-3: the response surfaces adopted_learning_ids, not just a count', () => {
    assert.ok(h.includes('adopted_learning_ids'));
  });
  it('grandfathering is documented at the route (no retro-invalidation of existing links)', () => {
    // The policy lives in the comment block ABOVE app.post — look at the region
    // leading into the handler, not just the handler body.
    const lead = SERVER_SRC.slice(Math.max(0, i - 2500), i);
    assert.ok(lead.includes('GRANDFATHERING'));
  });
});

// ─── Gate-A MED-2: platform-wallet linking refusal ──────────────────────────────

describe('linkWallet refuses platform wallets (MED-2)', () => {
  const PLATFORM = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';
  it('linking a platform wallet → 403, before any account/disk access', () => {
    const r = linkWallet('acc_x', PLATFORM, { [PLATFORM.toLowerCase()]: true }, [PLATFORM]);
    assert.equal(r.success, false);
    assert.equal(r.status_code, 403);
    assert.ok(/platform wallet/i.test(r.error));
  });
  it('refusal is case-insensitive', () => {
    const r = linkWallet('acc_x', PLATFORM.toLowerCase(), { [PLATFORM.toLowerCase()]: true }, [PLATFORM.toUpperCase().replace('0X', '0x')]);
    assert.equal(r.success, false);
    assert.equal(r.status_code, 403);
  });
  it('server passes PLATFORM_WALLETS into linkWallet at the route', () => {
    assert.ok(SERVER_SRC.includes('linkWallet(accountId, wallet, verifiedWallets, PLATFORM_WALLETS)'));
  });
});

describe('mcp-server.js: auxilo_link_wallet carries the two-step flow (HIGH-1 client)', () => {
  it('inputSchema declares the signature parameter', () => {
    const i = MCP_SRC.indexOf("name: 'auxilo_link_wallet'");
    const h = MCP_SRC.slice(i, MCP_SRC.indexOf("name: 'auxilo_account_earnings'", i));
    assert.ok(h.includes('signature:'), 'signature in schema');
    assert.ok(/TWO-STEP FLOW/.test(h), 'description teaches the challenge flow');
  });
  it('handler passes the signature through and surfaces the challenge as a next step, not an error', () => {
    const i = MCP_SRC.indexOf("case 'auxilo_link_wallet':");
    const h = MCP_SRC.slice(i, i + 2200);
    assert.ok(h.includes('signature: args.signature'));
    assert.ok(h.includes("'link_signature_required'"));
    assert.ok(h.includes("status: 'signature_required'"));
  });
});

// ─── AUD19-8(c): dashboard CP-7 framing ─────────────────────────────────────────

describe('dashboard.html: held line reads as an undisbursable receipt (CP-7)', () => {
  it('reads the public held_pending_assent field first', () => {
    assert.ok(DASHBOARD_SRC.includes('held_pending_assent'));
  });
  it('label + explainer use receipt framing, never "money we hold for you"', () => {
    assert.ok(DASHBOARD_SRC.includes('Undisbursable receipts'), 'CP-7 label');
    assert.ok(DASHBOARD_SRC.includes('released on Terms acceptance') || DASHBOARD_SRC.includes('releases them to your withdrawable share'),
      'release-on-acceptance framing');
    assert.ok(!DASHBOARD_SRC.includes('Held: accept Terms to release'), 'old possession-framed label removed');
    // Strip JS line comments first: the CP-7 rule is about USER-VISIBLE copy;
    // code comments may quote the forbidden phrasing to document the rule.
    const visible = DASHBOARD_SRC.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/holding (your|it) (money|funds)/i.test(visible), 'no possession language in visible copy');
  });
});
