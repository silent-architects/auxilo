# Auxilo — Master Punch List

> Everything that must happen before launch. One list. No duplicates.
> Source files: TASKS.md, SECURITY-AUDIT.md, ANTIGRAVITY-REVIEW.md, VISUAL_IDENTITY.md, AGENT-TEAM.md
> Last updated: 2026-02-26 (A0 verification complete)

---

## Legend

- **Owner**: Role ID from AGENT-TEAM.md (e.g., BUILD-1 = Architect)
- **Status**: `OPEN` | `SPEC DONE` | `IN PROGRESS` | `DONE` | `BLOCKED`
- **Priority**: `P0` (blocks launch) | `P1` (blocks real money) | `P2` (blocks scale) | `P3` (polish)

---

## 1. Security — CRITICAL (P0)

These block real money. No exceptions. Source: SECURITY-AUDIT.md

| # | Finding | Owner | Status |
|---|---------|-------|--------|
| C1 | Withdrawal race condition (double-withdrawal exploit) — add per-wallet async mutex | BUILD-1 → BUILD-2 | SPEC DONE (A1) |
| C2 | No viem nonce management — nonce collision on concurrent TXs | BUILD-1 → BUILD-2 | VERIFIED (A0) — AUDIT-13 proof: T-A0-EDGE-004 |
| C3 | Non-atomic dual write on unlock — crash between learnings/earnings writes | BUILD-1 → BUILD-2 | SPEC DONE (A2) |
| C4 | Stuck settlement infinite loop — no max-retry, no auto-refund | BUILD-1 → BUILD-2 | SPEC DONE (A2) |
| C5 | x402 payment validation entirely external — no local crypto verification | BUILD-1 → BUILD-2 | SPEC DONE (A4) |
| C6 | Private key plaintext on disk — move to env var minimum | BUILD-2 | VERIFIED (A0) — T-A0-UNIT-001 + S3 grep |
| C7 | Challenge nonce reuse (replay attack) — consume before verify | BUILD-1 → BUILD-2 | VERIFIED (A3) |
| C8 | Pending balance deducted before broadcast — use reservation model | BUILD-1 → BUILD-2 | SPEC DONE (A1) |

**Review**: GOV-3 (Security Auditor) + SPEC-1 (Crypto Auditor) sign off on every fix. Separate context from Builder.

---

## 1b. Security — Sensitivity Filter (SPEC-SF, P0)

GOV-3 audit found 2 CRITICAL, 3 HIGH, 6 MEDIUM, 4 LOW in the learning pipeline. Prerequisite to Build-2 A-series.

| # | Finding | Owner | Status |
|---|---------|-------|--------|
| SF-C1 | 6 critical pattern gaps (SSH, Slack, Stripe, Google, npm, PEM) | BUILD-2 | DONE — patterns added to `lib/sensitivity-filter.js` |
| SF-C2 | sk_live_ not caught by generic sk- prefix | BUILD-2 | DONE — dedicated `stripe_key` pattern |
| SF-H2 | redactMatch leaks too many chars (6+4=10) | BUILD-2 | DONE — changed to 3+2=5 chars |
| SF-H3 | No unlock_price ceiling — DoS vector | BUILD-2 | DONE — `MAX_UNLOCK_PRICE = 1.00` enforced |
| SF-M1 | scanLearning() not wrapped in try/catch — fail open | BUILD-2 | DONE — fail closed (returns 500) |
| SF-M2 | PATTERNS missing /g flag invariant assertion | BUILD-2 | DONE — assertion at module load |
| SF-M3 | aws_secret matches substrings of larger base64 strings | BUILD-2 | DONE — word-boundary lookahead/lookbehind |
| SF-M4 | password pattern false-positives on null/undefined/placeholders | BUILD-2 | DONE — negative lookahead |
| SF-M5 | Dedup re-hashes every existing learning on every POST | BUILD-2 | DONE — pre-computed `body_hash` on new learnings; legacy fallback |
| SF-M6 | 409 Conflict exposes existing_id + existing_title | BUILD-2 | DONE — stripped from response |
| SF-L3 | Docs out of sync with live patterns | BUILD-2 | DONE — guide, punch-list, tasks updated |

**Tests**: 46 new cases (T-SF-UNIT-001/018, T-SF-INT-001/012, T-SF-EDGE-001/016). All 72 tests pass.

**GOV-3 Sign-off required** before Build-2 executes A-series (A3→A0→A2→A1→A4).

## 2. Security — HIGH (P1)

Block production traffic. Source: SECURITY-AUDIT.md

| # | Finding | Owner | Status |
|---|---------|-------|--------|
| H1 | No EIP-712 structured signing — implement typed data with domain separator | BUILD-1 → BUILD-2 | VERIFIED (A3) |
| H2 | Timestamp reuse on withdrawal signatures — add server-generated nonce | BUILD-1 → BUILD-2 | VERIFIED (A3) |
| H3 | No rate limit on /wallet/challenge — max 5 per wallet per 10 min | BUILD-2 | VERIFIED (A3) |
| H4 | Facilitator DDoS = revenue disabled — local verification fallback | BUILD-1 → BUILD-2 | SPEC DONE (A4) |
| H5 | Admin token — no expiry, no rotation, no scope limiting | BUILD-2 | SPEC DONE (A4) |

---

## 3. Security — MEDIUM (P2)

Fix before scale. Source: SECURITY-AUDIT.md

| # | Finding | Owner | Status |
|---|---------|-------|--------|
| M-A | In-memory rate limit lost on restart | BUILD-2 | OPEN |
| M-B | Earnings migration sets pending_balance without validating against learnings | BUILD-2 | OPEN |
| M-C | Settlement JSONL append-only, never compacted | BUILD-2 | OPEN |
| M-D | Backup cleanup runs on every safeWrite() call | BUILD-2 | OPEN |
| M-E | Silent JSON parse failures at startup | BUILD-2 | OPEN |
| M-F | No private key rotation mechanism | BUILD-2 | OPEN |
| M-G | Concurrent backup cleanup race condition | BUILD-2 | OPEN |

---

## 4. Antigravity Review — Open Questions (P1)

Fixes M1–M7 + R1 are applied but review questions are unresolved. Source: ANTIGRAVITY-REVIEW.md

| # | Question | Owner | Status |
|---|----------|-------|--------|
| AR-1 | M1: Should rate limit window burn on failed (pre-broadcast) withdrawals? | BUILD-1 | SPEC DONE (A1) — Yes, all attempts burn |
| AR-2 | M2: Double-toFixed redundancy — clean up or leave? | BUILD-2 | DONE — code comment only, no spec needed |
| AR-3 | M3: Consistency check runs before resolveStuckSettlements — causes false-positive drift warnings. Move after? | BUILD-1 | SPEC DONE (A2) — documented explicitly |
| AR-4 | M4: Backup cleanup in safeWrite() hot path — throttle to once/hour? | BUILD-1 | SPEC DONE (A2) — documented, defer to P2 |
| AR-5 | M5: Number(bigint) precision on large USDC values — use viem utility? | BUILD-2 | VERIFIED (A3+A0) — parseFloat(formatUnits(...)) mandatory, confirmed in tx-manager.js |
| AR-6 | M6/M7: Should pre-broadcast failures return 400/503 instead of 500? | BUILD-1 | SPEC DONE (A2) — pre=503, post=202 |
| AR-7 | M6/M7: Should timeout internals be exposed to client in processing response? | BUILD-1 | SPEC DONE (A2) — no, client polls /settlement/:id |
| AR-8 | Cross-fix interactions: Do the 7 fixes create new edge cases when combined? | GOV-3 + SPEC-1 | OPEN — post-implementation review |

---

## 5. Payment Infrastructure — Phase 0 (P0)

Without dual-rail payments, agents can't buy learnings. Source: TASKS.md

| # | Task | Owner | Status | Depends On |
|---|------|-------|--------|------------|
| 0.1 | Account system (email + magic link, API key gen, dashboard endpoint) | BUILD-1 → BUILD-2 | OPEN | — |
| 0.2 | Dual auth middleware (x402 OR API key, 401 with both options) | BUILD-1 → BUILD-2 | OPEN | 0.1 |
| 0.3 | Credit system (free tier 50 queries + 10 unlocks/mo, balance tracking) | BUILD-1 → BUILD-2 | OPEN | 0.1, 0.2 |
| 0.4 | Stripe integration (credit packs $5/$20/$50, webhook to credit account) | BUILD-1 → BUILD-2 | OPEN | 0.1, 0.3 |
| 0.5 | Updated earnings system (track by account ID, wallet-less start, backward compat) | BUILD-1 → BUILD-2 | OPEN | 0.1 |

**Review**: GOV-2 (Compliance) reviews Stripe terms for crypto-adjacent products. SPEC-3 (Builder UX) reviews account + earnings flows. SPEC-2 (Agent UX) reviews dual-auth developer experience.

---

## 6. Autonomous Publishing — Phase 1 (P0)

The product. If agents can't publish learnings, no supply. Source: TASKS.md

| # | Task | Owner | Status | Depends On |
|---|------|-------|--------|------------|
| 1.1 | System prompt template (learning detection, quality gate, dedup, structured output) | BUILD-3 + SPEC-2 | OPEN | — |
| 1.2 | Learning extractor (transcript → structured learnings, confidence scoring, dedup) | BUILD-1 → BUILD-2 | OPEN | 1.1 |
| 1.3 | OpenClaw adapter (read .md memory files, feed to extractor, heartbeat daemon) | BUILD-1 → BUILD-2 | OPEN | 1.2 |

**Review**: SPEC-2 (Agent UX) validates agent-side flows. BUILD-4 (QA) tests across Claude Code + OpenClaw minimum.

---

## 7. Brand & Narrative (P1)

Not before launch, but before public visibility. Source: VISUAL_IDENTITY.md

| # | Deliverable | Owner | Status |
|---|-------------|-------|--------|
| B-1 | BRAND_GUIDELINES.md — production-ready usage reference (strips exploration from VISUAL_IDENTITY.md) | BUILD-3 | OPEN |
| B-2 | Geometric pattern — quieter variant (scale down 40%, spacing 2x, opacity -30%) | BUILD-3 | OPEN |
| B-3 | Growth flywheel — rebuild in Figma/SVG with brand typeface, fix copy ("upload learnings" not "publish skills") | BUILD-3 | OPEN |
| B-4 | Section divider — SVG mark + CSS gradient implementation | BUILD-3 | OPEN |
| B-5 | Category icons — map from Phosphor Light or Lucide libraries | BUILD-3 | OPEN |
| B-6 | OG image template — tagline-swappable variants | BUILD-3 | OPEN |
| B-7 | Favicon — verify Angular A at 16px, simplify if stroke intersections mud up | BUILD-3 | OPEN |
| B-8 | Landing page copy (AFTER product works — strategic decision #7) | BUILD-3 | BLOCKED on Phase 0 + 1 |
| B-9 | Builder onboarding copy | BUILD-3 | BLOCKED on 0.1 |
| B-10 | LinkedIn launch content | BUILD-3 | BLOCKED on stealth mode lift |

---

## 8. Infrastructure & Deployment (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| I-1 | Deploy security fixes to Conway VM after review sign-off | BUILD-2 + BUILD-4 | OPEN |
| I-2 | Validate live deployment matches local behavior | BUILD-4 | OPEN |
| I-3 | Environment variable setup for private key (C6 minimum fix) | BUILD-2 | OPEN |
| I-4 | Conway VM production hardening (process restart, log rotation, monitoring) | BUILD-2 | OPEN |
| I-5 | npm package update (auxilo-mcp) after security fixes | BUILD-2 | OPEN |

---

## 9. Testing & QA (P0)

| # | Task | Owner | Status |
|---|------|-------|--------|
| T-1 | Write test cases for C1–C8 + H1–H5 fixes from SPEC-A0/A1/A2/A3/A4 BEFORE implementation begins | BUILD-4 | DONE — `specs/TEST-A-SERIES.md` (159 tests) |
| T-2 | Write test cases for Phase 0 features BEFORE implementation begins | BUILD-4 | OPEN |
| T-3 | Write test cases for Phase 1 features BEFORE implementation begins | BUILD-4 | OPEN |
| T-4 | Full regression: v0.1.0 endpoints (GET /, /health, /categories, /stats, POST /discover, GET /skill/:id, 4 MCP tools) | BUILD-4 | OPEN |
| T-5 | Full regression: v0.2.0 endpoints (POST /learn, POST /knowledge, GET /knowledge/:id, POST /knowledge/:id/rate, GET /knowledge/stats, GET /contributor/:wallet, openapi.json, agent.json, 5 MCP tools) | BUILD-4 | OPEN |
| T-6 | Full regression: v0.3.0 settlement (challenge/verify, withdrawal, settlement lifecycle, earnings migration, stuck resolution, admin) | BUILD-4 | OPEN |
| T-7 | Edge case sweep: concurrent withdrawals, malformed JSON on every POST, empty states, 10K+ char strings, unicode, duplicate submissions | BUILD-4 | OPEN |
| T-8 | Live validation on Conway VM after each deployment | BUILD-4 | OPEN |

---

## 10. Governance & Compliance (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| G-1 | Stripe terms review for crypto-adjacent products (before 0.4) | GOV-2 | OPEN |
| G-2 | Money transmission analysis (are we operating as an MSB?) | GOV-2 | OPEN |
| G-3 | Tax reporting obligations for builder payouts (1099 thresholds) | GOV-2 | OPEN |
| G-4 | Terms of service draft | GOV-2 | OPEN |
| G-5 | Privacy policy (what data we store, GDPR if applicable) | GOV-2 | OPEN |
| G-6 | Risk register — document and track all identified risks | GOV-2 | OPEN |

---

## 11. Agent Team Operationalization (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| A-1 | AGENT-TEAM.md created | GOV-1 | DONE |
| A-2 | Per-agent CLAUDE.md files (10 roles) | GOV-1 | DONE |
| A-3 | PUNCH-LIST.md created (this file) | GOV-1 | DONE |
| A-4 | TASKS.md updated with team ownership | GOV-1 | DONE |

---

## Execution Sequence

```
Phase 0 (parallel tracks):

  Track A: Security Fixes
  C1-C8 → Review (GOV-3 + SPEC-1) → H1-H5 → Review → Deploy → Live QA

  Track B: Payment Infrastructure
  0.1 Account System → 0.2 Dual Auth → 0.3 Credits → 0.4 Stripe → 0.5 Earnings
  (GOV-2 reviews Stripe terms in parallel with 0.1-0.3)

  Track C: Autonomous Publishing (can start during Track B)
  1.1 System Prompt Template → 1.2 Learning Extractor → 1.3 OpenClaw Adapter

  Track D: Brand (runs parallel, blocked items unblock as product ships)
  B-1 Brand Guidelines → B-2 through B-7 (assets) → B-8/B-9/B-10 (copy, post-product)

Gate: All P0 items DONE + all review sign-offs → Launch
```

---

## Counts

| Priority | Open | Spec Done | Done | Blocked | Total |
|----------|------|-----------|------|---------|-------|
| P0 (blocks launch) | 11 | 13 | 2 | 0 | 26 |
| P1 (blocks real money / production) | 17 | 6 | 2 | 3 | 28 |
| P2 (blocks scale) | 7 | 0 | 0 | 0 | 7 |
| P3 (polish) | 0 | 0 | 0 | 0 | 0 |
| **Total** | **35** | **19** | **4** | **3** | **61** |

> **Spec files**: `auxilo/specs/SPEC-A3.md` (Opus), `SPEC-A0.md` (Opus), `SPEC-A2.md` (Sonnet), `SPEC-A1.md` (Sonnet), `SPEC-A4.md` (Sonnet)
> **Next**: BUILD-4 writes test cases from specs → BUILD-2 implements → GOV-3 + SPEC-1 review
