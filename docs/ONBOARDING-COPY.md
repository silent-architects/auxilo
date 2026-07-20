# Auxilo — Builder Onboarding Copy

> Updated 2026-03-25: Aligned to FOUNDATION.md v1 — query/search fees killed, free tier killed
> Reconciled 2026-07-19 (AUD19-13): §5 dashboard sections + update cadence aligned to the shipped dashboard; §6 purchases empty-state retargeted; §9 marked designed-not-yet-shipped

All user-facing copy for the builder onboarding flow. Voice: direct, technical, second person. No buzzwords.

---

## 1. Welcome / Sign-Up

**Headline**
Your agents learn. You earn.

**Body**
Auxilo is the discovery layer for the agent economy. Your agents generate operational knowledge every day — workarounds, undocumented behaviors, real solutions. Most of it disappears after the session ends.

Auxilo captures that knowledge, scores it, and lists it in a catalog. When other agents discover and pay to unlock what yours found, you earn up to 70% of every transaction — 70% on direct unlocks, 60% when Auxilo's search surfaces your learning to the buyer. The remainder sustains the network.

One API. Protocol-level micropayments. No inventory to manage.

**CTA**
Create Your Account →

---

## 2. Create Your First Learning

**Headline**
Publish what your agent already knows.

**Body**
A learning is a single piece of operational knowledge — something an agent discovered that other agents would pay to know. You define four things:

- **Title** — What the learning covers. Be specific. "Handling rate limits on Stripe's Payment Intent endpoint" beats "Stripe tips."
- **Description** — A brief summary agents see before unlocking. This is your pitch — make it concrete.
- **Category** — Where it lives in the catalog. Six categories, all technical: data processing, web interaction, code execution, storage & state, payment & financial, monitoring. (Auxilo publishes technical learnings only — non-technical content is out of scope.)
- **Content** — The full body. This is what agents pay to read. Include the solution, the context, and any caveats. Quality scoring rewards specificity, actionability, novelty, and completeness.

Learnings are quality-scored automatically across four dimensions. Higher scores rank higher in search results and get more unlocks.

**CTA**
Create Learning →

---

## 3. Set Your Price

**Headline**
Pricing is calculated automatically. You can override it.

**Body**
Every learning has an unlock price set by the dynamic pricing engine. The system estimates what an agent would spend to discover the same knowledge independently — and prices your learning at roughly 2% of that cost. You can leave pricing on automatic or set your own price manually.

Price range: **$0.05 – $50.00** (the engine clamps to a $0.05 floor — `MIN_UNLOCK_PRICE`, lib/pricing.js)

| Tier | Price Range | Typical Learning |
|------|-------------|-----------------|
| Micro | $0.05 – $0.10 | Config tips, common patterns, simple workarounds |
| Standard | $0.10 – $1.00 | Integration patterns, workflow optimizations |
| Premium | $1.00 – $10.00 | Production-saving discoveries, debugging insights |
| Expert | $10.00 – $50.00 | Architectural insights, complex system patterns |

**Default starting price**: $0.08 (used when the system can't estimate value from available data).

If you set a manual price that differs more than 3× from the calculated value, the system shows an advisory — you can still publish at your price, but the advisory helps you catch accidental mispricing.

**How earnings split (two-tier, ToS §5.4):**
- **You keep 70%** of a direct unlock (buyer came straight to your learning).
- **You keep 60%** of a discovery-driven unlock (Auxilo's search surfaced it to the buyer).
- **The remainder sustains the network** — infrastructure, ranking, quality scoring.

Discovery is free — agents search and preview your learnings at zero cost. Unlocks are where you earn. The pricing engine optimizes for conversions — learnings priced in line with their value unlock more often.

Submitting learnings is free. You only earn when agents pay.

**CTA**
Set Price & Publish →

---

## 3.5 Accept the Terms (before you get paid)

**Headline**
One quick agreement, then you're earning.

**Body**
Before you link a payout wallet or withdraw, we ask you to accept the current Terms. They include Section 5.10, under which you appoint Auxilo as your limited agent to collect your share of each unlock on your behalf — so a buyer's payment settles cleanly to you. You accept once; we only ask again if the Terms materially change.

**Web:** tick "I agree" on your dashboard and click **Accept and continue**. (The box starts unchecked — the choice is yours.)

**Agents / MCP:** your agent records your acceptance by calling the `auxilo_accept_terms` tool. Linking a wallet or withdrawing is blocked until it does.

**CTA**
Review the Terms → · Accept and continue →

**Microcopy (blocked action, web + API):**
"Accept the current Terms to link a wallet or withdraw." (403 `TERMS_NOT_ACCEPTED`)

---

## 4. Get Paid

**Headline**
Link your payout method. Withdraw when you're ready.

**Body**
Auxilo uses x402 protocol micropayments to collect earnings on your behalf. Your earnings accrue to your Auxilo account now. Withdrawals — both Stripe-to-bank and USDC to a Base wallet — are rolling out on our non-custodial rail and are opening soon; your balance is safe in the meantime. You can link a Base-compatible wallet now so it's ready when USDC withdrawals open.

**Setup (wallet):**
1. Connect a Base wallet (Coinbase Wallet, MetaMask, or any EVM-compatible wallet on Base).
2. Sign a verification message (EIP-712 structured signing — no transaction, no gas fee).
3. Your wallet is now linked and verified for when USDC withdrawals open.

Withdrawal minimums and timing depend on the payout method you choose; the dashboard shows the current terms for each. Wallet linking requires accepting the current Terms first (see §3.5).

If you don't have a Base wallet yet, [Coinbase Wallet](https://www.coinbase.com/wallet) is the fastest path. Create a wallet, switch to Base network, and you're ready.

> Internal note: Keep this aligned with the live payout posture — launch is ACCRUE-ONLY: BOTH withdrawal rails are paused. USDC withdrawals are gated by R-01 (router inert), and Stripe-to-bank payouts are gated behind the CUSTODIAL_WITHDRAW_ENABLED kill-switch (unset at launch → POST /withdraw/stripe returns 503). Present both as "opening soon" until they actually go live. Do not restore "Stripe payouts are live today," "settlements happen on the protocol layer — not batched, not delayed," or "no minimum payout threshold" until the respective rail is live and those terms are confirmed against the settlement code.

**CTA**
Connect Wallet →

---

## 5. Dashboard Overview

**Headline**
Everything your learnings are doing.

**Body**
Your dashboard shows five things:

- **Earnings** — Your owned lifetime share, your withdrawable balance, and any share held pending Terms acceptance (`unassented_pending`), from `GET /account/earnings`.
- **Payouts** — Your linked payout wallet and the current withdrawal posture (both rails are paused during the non-custodial migration; the pause is server-reported via `payouts_paused`).
- **Pending Review Queue** — Your own learnings held for review, with the reason each was held, and approve/reject controls.
- **API Keys** — The keys your agents authenticate with: create, label, and revoke.
- **Credit Purchase History** — The credit packs you have bought, with what each included.

Numbers load fresh each time you open the dashboard.

**CTA**
View Dashboard →

---

## 6. Empty States

### No Learnings Yet

**Headline**
No learnings published yet.

**Body**
Your catalog is empty. Publish your first learning — something your agent figured out that other agents would pay to know. Start with one. You can always add more.

**CTA**
Create Your First Learning →

---

### No Earnings Yet

**Headline**
No earnings yet.

**Body**
Earnings appear here when agents unlock your learnings. Two things help: specific titles that match what agents search for, and competitive pricing aligned with the dynamic pricing engine ($0.05–$50.00 algorithmic range; most learnings start at the $0.08 default). Quality scores matter — higher-scored learnings rank higher in results.

**CTA**
Review Your Learnings →

---

### No Purchases Yet

**Headline**
No credit purchases yet.

**Body**
This history shows the credit packs you buy — date, pack, and what it included. Buy a pack to give your agents query and unlock credits, or skip it entirely and let them pay per-call with x402.

**CTA**
Explore the Catalog →

> Internal note (2026-07-19): the shipped dashboard has no per-unlock sales feed — unlock earnings appear aggregated in the Earnings card. The old "agent purchases feed" empty state described a feature that does not exist; re-add only if/when that feed ships.

---

## 7. Autonomous Extraction — Consent

**Headline**
Let your agents extract learnings automatically.

**Body**
Autonomous extraction watches your coding sessions and identifies reusable knowledge: workarounds, integration patterns, debugging insights. When you enable it, a local runner scrubs your session transcripts on your machine, your own model client (your claude CLI, on your subscription) drafts learnings from the scrubbed text the same way your normal sessions run, and only the finished drafts are sent to Auxilo, where qualifying learnings publish to the catalog under your account. Your transcripts, raw or scrubbed, are never sent to Auxilo.

**Before anything happens, you grant explicit consent.** Consent is versioned and recorded in an immutable, append-only log. You can revoke at any time — revocation takes effect immediately, even for in-flight extractions.

Three modes:
- **Off** — Default. No extraction occurs.
- **Automatic** — A learning that passes every screen (secrets, sensitivity, injection, near-duplicate, quality) publishes immediately, and you get a 7-day retraction window. Anything a screen flags is the exception: it waits in your private pending-review queue instead of publishing.
- **Manual** — Every learning is parked for your review before publishing.

**Local safety switch:** To stop extraction instantly, delete `~/.auxilo/autonomous-enabled`. The runner checks for this file on every wake — if missing, it exits without processing. To re-enable, run `touch ~/.auxilo/autonomous-enabled`. This works even if the server is unreachable.

**CTA**
Enable Extraction →

---

## 8. Autonomous Extraction — Retraction Window

**Headline**
7 days to change your mind.

**Body**
Every learning published via autonomous extraction comes with a **7-day retraction window**. During this window, you can retract any learning — no reason needed, no approval required.

After 7 days, the window closes. From that point, removing a learning follows the standard takedown process.

**What retraction does:**
- Immediately removes the learning from search results and unlocks.
- Records an audit entry (immutable, hash-chained).
- Does not reverse earnings from prior unlocks — those are finalized.

To retract: go to your dashboard, find the learning, and click **Retract**. Or use the API:

```
DELETE /learn/{learning_id}?reason=retract
```

**CTA**
View Your Learnings →

---

## 9. Dashboard — Autonomous Extraction Status

> Internal note (2026-07-19): DESIGNED, NOT YET SHIPPED. The live dashboard shows Earnings / Payouts / Pending Review Queue / API Keys / Credit Purchase History only — there is no extraction-status section. Extraction status lives in `npx auxilo status` today. Keep this section as the design spec; do not present it as shipped.

**Headline**
Your extraction pipeline at a glance.

**Body**
Your dashboard includes an extraction status section when autonomous mode is enabled:

- **Mode** — Current extraction mode (automatic, manual, or off).
- **Consent** — Whether consent is active, and the consent version timestamp.
- **Recent Extractions** — Last 10 extraction runs with counts: published, rejected, queued for review.
- **Retraction Window** — Learnings still within the 7-day retraction window, with days remaining.
- **Safety Switch** — Status of the local `~/.auxilo/autonomous-enabled` sentinel (present = active, absent = disabled).

Numbers update in real time. The consent version shown matches the version stamped on every extraction — you can verify the audit chain with `node scripts/admin.js audit:verify`.

**CTA**
View Extraction Status →

---

## Copy Notes (Internal)

*This section is for the engineering team, not for builders.*

- **Voice**: Direct, technical, second person. Active voice throughout. Short sentences. No "revolutionary," "cutting-edge," "game-changing," or emoji.
- **Vocabulary**: Use "learnings" (not content/assets), "discover" (not search/browse), "builders" (not users/creators), "agents" (not bots), "earnings" (not revenue), "micropayments" (not transactions).
- **Typography**: Headlines in Bold (700) weight per brand guidelines — builder-facing copy uses punchy, direct energy. Body in Regular (400).
- **Aurum accent**: Use on CTAs, links, and key figures (70%, earnings amounts). Never dominant.
- **Tone calibration**: These are developers. They want to know what the product does, how the money works, and how to set it up. Don't oversimplify. Don't sell. State facts.
