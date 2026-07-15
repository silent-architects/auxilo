# Auxilo — Master Punch List

> Everything that must happen before launch. One list. No duplicates.
> Source files: TASKS.md, SECURITY-AUDIT.md, ANTIGRAVITY-REVIEW.md, VISUAL_IDENTITY.md, AGENT-TEAM.md
> Last updated: 2026-03-30 (Wave 1 verified + deployed. PD-1–PD-5 fixed. PD-6 deferred. 5-agent audit: BUILD-2a–2d DONE, H-3 OPEN. 4 open items remain.)
> 2026-07-15: +§20 Tech Debt & Governance Hygiene — TD-CONWAY-1 (`tech.conway.*` dead-host naming purge, open) + DG-1 (`docs/INDEX.md` public-repo gap — resolved same day via public-safe stub). P3 open 0→1.

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
| C1 | Withdrawal race condition (double-withdrawal exploit) — add per-wallet async mutex | BUILD-1 → BUILD-2 | DONE (A1) — deployed 86c77f2 |
| C2 | No viem nonce management — nonce collision on concurrent TXs | BUILD-1 → BUILD-2 | VERIFIED (A0) — AUDIT-13 proof: T-A0-EDGE-004 |
| C3 | Non-atomic dual write on unlock — crash between learnings/earnings writes | BUILD-1 → BUILD-2 | DONE (A2) — deployed 86c77f2 |
| C4 | Stuck settlement infinite loop — no max-retry, no auto-refund | BUILD-1 → BUILD-2 | DONE (A2) — deployed 86c77f2 |
| C5 | x402 payment validation entirely external — no local crypto verification | BUILD-1 → BUILD-2 | DONE (A4) — deployed 86c77f2 |
| C6 | Private key plaintext on disk — move to env var minimum | BUILD-2 | VERIFIED (A0) — T-A0-UNIT-001 + S3 grep |
| C7 | Challenge nonce reuse (replay attack) — consume before verify | BUILD-1 → BUILD-2 | VERIFIED (A3) |
| C8 | Pending balance deducted before broadcast — use reservation model | BUILD-1 → BUILD-2 | DONE (A1) — deployed 86c77f2 |

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
| H4 | Facilitator DDoS = revenue disabled — local verification fallback | BUILD-1 → BUILD-2 | DONE (A4) — deployed 86c77f2 |
| H5 | Admin token — no expiry, no rotation, no scope limiting | BUILD-2 | DONE (A4) — deployed 86c77f2 |

---

## 3. Security — MEDIUM (P2)

Fix before scale. Source: SECURITY-AUDIT.md

| # | Finding | Owner | Status |
|---|---------|-------|--------|
| M-A | In-memory rate limit lost on restart | BUILD-2 | DONE — Sprint 08, persist to disk on write + restore on boot |
| M-B | Earnings migration sets pending_balance without validating against learnings | BUILD-2 | DONE — Sprint 08, cross-check validation on earnings load |
| M-C | Settlement JSONL append-only, never compacted | BUILD-2 | DONE — Sprint 08, compaction at threshold with atomic rewrite |
| M-D | Backup cleanup runs on every safeWrite() call | BUILD-2 | DONE — Sprint 08, throttled to once/hour max |
| M-E | Silent JSON parse failures at startup | BUILD-2 | DONE — Sprint 08, loadDataFile with critical vs non-critical distinction |
| M-F | No private key rotation mechanism | BUILD-2 | DONE — Sprint 08, /admin/stage-key endpoint |
| M-G | Concurrent backup cleanup race condition | BUILD-2 | DONE — Sprint 08, cleanupRunning mutex with finally block |
| M-H | Ghost settlement on-chain check — `resolveStuckSettlements` should verify on-chain like `resolveProcessingSettlements` | BUILD-2 | DONE — Sprint 01 Track 1 |
| M-I | Daemon overlap guard — `let running = false` flag to prevent concurrent daemon ticks | BUILD-2 | DONE — Sprint 01 Track 1 |
| M-J | Reservation orphan cross-reference — filter against pending/retry settlements before releasing reservations | BUILD-2 | DONE — Sprint 01 Track 1 |

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
| AR-8 | Cross-fix interactions: Do the 7 fixes create new edge cases when combined? | GOV-3 + SPEC-1 | DONE — Sprint 03, PASS WITH OBSERVATIONS (3M + 2L, no blockers) |

---

## 5. Payment Infrastructure — Phase 0 (P0)

Without dual-rail payments, agents can't buy learnings. Source: TASKS.md

| # | Task | Owner | Status | Depends On |
|---|------|-------|--------|------------|
| 0.1 | Account system (email + magic link, API key gen, dashboard endpoint) | BUILD-1 → BUILD-2 | DONE — 74/74 tests, deployed to Conway VM, 12/12 live checks | — |
| 0.2 | Dual auth middleware (x402 OR API key, 401 with both options) | BUILD-1 → BUILD-2 | DONE — Sprint 02, deployed to Conway VM, 10/10 live checks | 0.1 |
| 0.3 | Credit system (free tier 50 queries + 10 unlocks/mo, balance tracking) | BUILD-1 → BUILD-2 | DONE — Sprint 03, 49/49 tests, deployed to Conway VM, 5/5 live checks | 0.1, 0.2 |
| 0.4 | Stripe integration (credit packs $5/$20/$50, webhook to credit account) | BUILD-1 → BUILD-2 | DONE — Sprint 04, 13/13 live checks, deployed 2026-03-08 | 0.1, 0.3 |
| 0.5 | Updated earnings system (track by account ID, wallet-less start, backward compat) | BUILD-1 → BUILD-2 | DONE — Sprint 02, deployed to Conway VM, 8/8 live checks | 0.1 |

**Review**: GOV-2 (Compliance) reviews Stripe terms for crypto-adjacent products. SPEC-3 (Builder UX) reviews account + earnings flows. SPEC-2 (Agent UX) reviews dual-auth developer experience.

---

## 6. Autonomous Publishing — Phase 1 (P0)

The product. If agents can't publish learnings, no supply. Source: TASKS.md

| # | Task | Owner | Status | Depends On |
|---|------|-------|--------|------------|
| 1.1 | System prompt template (learning detection, quality gate, dedup, structured output) | BUILD-3 + SPEC-2 | DONE — Sprint 03, 48/48 tests, deployed to Conway VM, 3/3 live checks | — |
| 1.2 | Learning extractor (transcript → structured learnings, confidence scoring, dedup) | BUILD-1 → BUILD-2 | DONE — Sprint 05, 35/35 tests, deployed 2026-03-08, 15/15 live checks | 1.1 |
| 1.3 | OpenClaw adapter (read .md memory files, feed to extractor, heartbeat daemon) | BUILD-1 → BUILD-2 | DONE — Sprint 06, 31/31 tests, deployed 2026-03-09, 18/18 live checks | 1.2 |

**Review**: SPEC-2 (Agent UX) validates agent-side flows. BUILD-4 (QA) tests across Claude Code + OpenClaw minimum.

---

## 7. Brand & Narrative (P1)

Not before launch, but before public visibility. Source: VISUAL_IDENTITY.md

| # | Deliverable | Owner | Status |
|---|-------------|-------|--------|
| B-1 | BRAND_GUIDELINES.md — production-ready usage reference (strips exploration from VISUAL_IDENTITY.md) | BUILD-3 | DONE — Sprint 13, 159 lines, 6 sections |
| B-2 | Geometric pattern — quieter variant (scale down 40%, spacing 2x, opacity -30%) | BUILD-3 | DONE |
| B-3 | Growth flywheel — rebuild in Figma/SVG with brand typeface, fix copy ("upload learnings" not "publish skills") | BUILD-3 | DONE |
| B-4 | Section divider — SVG mark + CSS gradient implementation | BUILD-3 | DONE |
| B-5 | Category icons — map from Phosphor Light or Lucide libraries | BUILD-3 | DONE |
| B-6 | OG image template — tagline-swappable variants | BUILD-3 | DONE |
| B-7 | Favicon — verify Angular A at 16px, simplify if stroke intersections mud up | BUILD-3 | DONE |
| B-8 | Landing page copy (AFTER product works — strategic decision #7) | BUILD-3 | DONE — Sprint 13, 194 lines, 7 sections, all prices verified against live API |
| B-9 | Builder onboarding copy | BUILD-3 | DONE |
| B-10 | LinkedIn launch content | BUILD-3 | ON HOLD — GTM/marketing paused until marketplace fully functional (Tyler, 2026-03-30) |

---

## 8. Infrastructure & Deployment (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| I-1 | Deploy security fixes to Conway VM after review sign-off | BUILD-2 + BUILD-4 | DONE — 86c77f2 live |
| I-2 | Validate live deployment matches local behavior | BUILD-4 | DONE — T-DEPLOY 5/5 + x402v2 7/7 |
| I-3 | Environment variable setup for private key (C6 minimum fix) | BUILD-2 | DONE — start.sh manages WALLET_PRIVATE_KEY + SESSION_SECRET |
| I-4 | Conway VM production hardening (process restart, log rotation, monitoring) | BUILD-2 | DONE — Sprint 08, PM2 + health monitoring + graceful shutdown |
| I-5 | npm package update (auxilo-mcp) after security fixes | BUILD-2 | DONE — Sprint 08 v0.6.0; Sprint 12 v0.7.0 (8 new tools); v0.7.0 published to npm 2026-03-14 |
| I-6 | Deployment documentation (DEPLOY-GUIDE.md) | BUILD-2 | DONE — Conway API, chunked uploads, env vars, troubleshooting |

---

## 9. Testing & QA (P0)

| # | Task | Owner | Status |
|---|------|-------|--------|
| T-1 | Write test cases for C1–C8 + H1–H5 fixes from SPEC-A0/A1/A2/A3/A4 BEFORE implementation begins | BUILD-4 | DONE — `specs/TEST-A-SERIES.md` (159 tests) |
| T-2 | Write test cases for Phase 0 features BEFORE implementation begins | BUILD-4 | DONE — 0.1 (37), 0.2 (37), 0.3 (49), 0.5 (34), 0.4 (25) done; Phase 0 complete |
| T-3 | Write test cases for Phase 1 features BEFORE implementation begins | BUILD-4 | DONE — 1.1 (48), 1.2 (35), 1.3 (31); Phase 1 complete |
| T-4 | Full regression: v0.1.0 endpoints (GET /, /health, /categories, /stats, POST /discover, GET /skill/:id, 4 MCP tools) | BUILD-4 | DONE — Sprint 07, 26/26 tests pass |
| T-5 | Full regression: v0.2.0 endpoints (POST /learn, POST /knowledge, GET /knowledge/:id, POST /knowledge/:id/rate, GET /knowledge/stats, GET /contributor/:wallet, openapi.json, agent.json, 5 MCP tools) | BUILD-4 | DONE — Sprint 07, 30/30 tests pass |
| T-6 | Full regression: v0.3.0 settlement (challenge/verify, withdrawal, settlement lifecycle, earnings migration, stuck resolution, admin) | BUILD-4 | DONE — covered by 108 A-series tests |
| T-7 | Edge case sweep: concurrent withdrawals, malformed JSON on every POST, empty states, 10K+ char strings, unicode, duplicate submissions | BUILD-4 | DONE — Sprint 07, 58/58 tests pass |
| T-8 | Live validation on Conway VM after each deployment | BUILD-4 | DONE — T-DEPLOY 5/5 + x402v2 7/7 + Sprint 02 18/18 + Sprint 03 8/8 + Sprint 04 13/13 + Sprint 05 15/15 + Sprint 06 18/18 + Sprint 07 157/157 live regression + Sprint 10 19/19 |
| T-9 | CI green on main: viem→2.54.2 lockfile bump (pulls ws 8.21.0, clears GHSA-96hv-2xvq-fx4p audit fail); darwin-skip digest plist tests; replace stale retraction-sweeper plist tests (LaunchAgent retired 2026-06-11); length-independent source-introspection windows broken by PR #5 restructure | BUILD-4 | IN REVIEW — PR `fix/ci-green`; Gate B (SPEC-1) on viem bump |

---

## 10. Governance & Compliance (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| G-1 | Stripe terms review for crypto-adjacent products (before 0.4) | GOV-2 | DONE |
| G-2 | Money transmission analysis (are we operating as an MSB?) | GOV-2 | DONE |
| G-3 | Tax reporting obligations for builder payouts (1099 thresholds) | GOV-2 | DONE |
| G-4 | Terms of service draft | GOV-2 | DONE |
| G-5 | Privacy policy (what data we store, GDPR if applicable) | GOV-2 | DONE |
| G-6 | Risk register — document and track all identified risks | GOV-2 | DONE |

---

## 11. Agent Team Operationalization (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| A-1 | AGENT-TEAM.md created | GOV-1 | DONE |
| A-2 | Per-agent CLAUDE.md files (10 roles) | GOV-1 | DONE |
| A-3 | PUNCH-LIST.md created (this file) | GOV-1 | DONE |
| A-4 | TASKS.md updated with team ownership | GOV-1 | DONE |
| A-5 | Sprint Orchestrator pattern (ORCHESTRATOR.md + 4 prompt templates) | BUILD-1 | DONE — punchlist→sprint→agents→deploy pipeline |

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

## 12. Post-Sprint 08 Audit Findings (P1/P2)

Source: AUDIT-POST-S8-RESULTS.md (GOV-3 audit, 2026-03-11). 28 checklist items, 18 findings.

| # | Finding | Severity | Owner | Status |
|---|---------|----------|-------|--------|
| AU-1 | OpenClaw endpoints unauthenticated (S-3) | HIGH | BUILD-2 | DONE — Sprint 09, adminAuth() added to all 4 endpoints |
| AU-2 | Unbounded in-memory Maps leak memory (E-7) | HIGH | BUILD-2 | DONE — Sprint 09, 10-min sweep timer for 3 stores |
| AU-3 | Reservations + compaction writes skip fsync (S-10) | MEDIUM | BUILD-2 | DONE — Sprint 09, writeAndSync() for 3 call sites |
| AU-4 | processing_unresolved is dead-end state (F-9) | MEDIUM | BUILD-2 | DONE — Sprint 09, daemon resolution + 48h forced-fail |
| AU-5 | /extract endpoint broken auth + rate limiter (S-1/F-2) | LOW | BUILD-2 | DONE — Sprint 09, adminAuth() + rate limiter fix |
| AU-6 | Startup parallelization (E-8) | HIGH (eff) | BUILD-2 | DONE |
| AU-7 | Cache accounts + settlements in memory (E-2) | MEDIUM | BUILD-2 | DONE |
| AU-8 | Per-API-key rate limit on paid endpoints (S-5) | MEDIUM | BUILD-2 | DONE |
| AU-9 | Root endpoint missing 20+ routes in docs (F-1) | MEDIUM | BUILD-2 | DONE — Sprint 10, 11 routes added (32 total documented) |
| AU-10 | MCP missing Renderly + stats tools (F-7) | MEDIUM | BUILD-2 | DONE — Sprint 11, 8 tools added (renderly_markdown, renderly_extract, renderly_readable, renderly_llms_txt, renderly_health, renderly_pricing, get_stats, get_knowledge_stats) |
| AU-11 | CORS Conway URL documentation (S-7) | LOW | BUILD-2 | DONE — Sprint 11, comment added documenting URL format, current origins, update instructions |
| AU-12 | err.message in signature error responses (S-8) | LOW | BUILD-2 | DONE — Sprint 11, stripped details field from /wallet/verify + /withdraw catch blocks; kept in console.error |
| AU-13 | .catch(console.error) on startup (F-4) | LOW | BUILD-2 | DONE — Sprint 11, replaced with contextual handlers logging subsystem + stack; non-critical (continues with warning) |

---

---

## 13. Post-Audit Cleanup & Next Features (P1/P2)

Source: Audit remediation session 2026-03-20. Items identified during 13-track deploy + documentation review.

### Cleanup (P1)

| # | Task | Owner | Status |
|---|------|-------|--------|
| CL-1 | Remove orphaned `public/terms.html` (no route serves it — `/terms` uses `docs/TERMS-OF-SERVICE.md`) | BUILD-2 | DONE — deleted 2026-03-20 |
| CL-2 | Remove orphaned `public/privacy.html` (no route serves it — `/privacy` uses `docs/PRIVACY-POLICY.md`) | BUILD-2 | DONE — deleted 2026-03-20 |
| CL-3 | Update "Last Updated" date in `docs/TERMS-OF-SERVICE.md` from March 17 → March 20 | BUILD-2 | DONE — 2026-03-20 |
| CL-4 | Update "Last Updated" date in `docs/PRIVACY-POLICY.md` from March 17 → March 20 | BUILD-2 | DONE — 2026-03-20 |
| CL-5 | Add `favicon.ico` to `public/` (explicit route exists at line 3031 but file is missing — returns 404) | BUILD-3 | DONE — favicon.svg created + routes updated (W1-F1, verified 2026-03-30) |
| CL-6 | Deploy `docs/SITE-ARCHITECTURE.md` to Conway VM | BUILD-2 | DONE — Wave 1 full deploy 2026-03-30 (22 files, 11/12 live checks, 1 test bug fixed) |

### Next Features (P2 — designed, not built)

| # | Task | Owner | Status |
|---|------|-------|--------|
| NF-1 | Multi-environment onboarding — per-LLM setup instructions for builders with multiple agents | SPEC-3 + BUILD-2 | DONE — 5 templates in `prompts/` (W1-D1, verified 2026-03-30) |
| NF-2 | MCP `instructions` field — proactive Auxilo checking prompt in tool metadata | SPEC-2 + BUILD-2 | DONE — already implemented in mcp-server.js `instructions` field |
| NF-3 | `npx auxilo-mcp init` / `add-environment` CLI — builder onboarding tool | BUILD-2 | OPEN — depends on D2 (scoped keys) |
| NF-4 | Scoped API keys per environment — one account, multiple keys with labels | BUILD-1 → BUILD-2 | DONE — multi-key with labels, 3 endpoints (W1-D2, verified 2026-03-30) |
| NF-5 | Dynamic pricing engine activation — `lib/pricing.js` exists but not wired to live pricing | BUILD-2 | DONE — pricing wired to 3 routes + cron + 2 analytics endpoints (W1-E1/E2, verified 2026-03-30) |

---

## 14. Wave 1 — Documentation Architecture + Agent Adoption (P1/P2)

Source: Documentation audit session 2026-03-20. All specs in `specs/WAVE1-*.md`.

### Documentation — Keystone Docs (P1)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-A1 | `docs/PRODUCT.md` — Product Requirements Document | `specs/WAVE1-DOC-A1-PRODUCT.md` | Opus | DONE (verified 2026-03-30) |
| W1-A2 | `docs/MARKETPLACE.md` — Marketplace mechanics reference | `specs/WAVE1-DOC-A2-MARKETPLACE.md` | Opus | DONE (verified 2026-03-30) |
| W1-A3 | `docs/GTM.md` — Go-to-market plan | `specs/WAVE1-DOC-A3-GTM.md` | Opus | DONE (verified 2026-03-30) |
| W1-A4 | `docs/FINANCIAL-PLAN.md` — Consolidated financial model | `specs/WAVE1-DOC-A4-FINANCIAL.md` | Opus | DONE (verified 2026-03-30) |

### Documentation — Reference Docs (P1)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-B1 | `docs/UX-FLOWS.md` — User journey maps | `specs/WAVE1-DOC-B1-UX-FLOWS.md` | Opus | DONE (verified 2026-03-30) |
| W1-B2 | `docs/DEVELOPER-GUIDE.md` — API quickstart | `specs/WAVE1-DOC-B2-DEVELOPER-GUIDE.md` | Sonnet | DONE (verified 2026-03-30) |
| W1-B3 | `docs/RUNBOOK.md` — Operations runbook | `specs/WAVE1-DOC-B3-RUNBOOK.md` | Opus | DONE (verified 2026-03-30) |
| W1-B4 | `docs/INDEX.md` — Master documentation map | `specs/WAVE1-DOC-B4-INDEX.md` | Opus | DONE (verified 2026-03-30) |

### Fixes — Stale Content + File Moves (P1)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-C1 | Fix stale pricing in ONBOARDING-COPY.md, mcp-server.js, llms.txt + version normalization | `specs/WAVE1-FIX-C1-STALE-CONTENT.md` | Sonnet | DONE (verified 2026-03-30) |
| W1-C2 | Move competitive analysis to `docs/COMPETITIVE.md` + mark 4 superseded docs | `specs/WAVE1-FIX-C2-FILE-MOVES.md` | Sonnet | DONE (verified 2026-03-30) |

### Build — Agent Adoption (P1)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-D1 | Per-LLM instruction templates (Cursor, Windsurf, Cline, OpenAI, Claude Desktop) | `specs/WAVE1-BUILD-D1-LLM-TEMPLATES.md` | Sonnet | DONE (verified 2026-03-30) |
| W1-D2 | Scoped API keys with labels (one account, multiple keys) | `specs/WAVE1-BUILD-D2-SCOPED-KEYS.md` | Sonnet | DONE (verified 2026-03-30) |

### Build — Pricing Engine (P2)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-E1 | Wire `lib/pricing.js` to live routes (POST /learn, POST /knowledge, GET /knowledge/:id) | `specs/WAVE1-BUILD-E1-PRICING-ENGINE.md` | Sonnet | DONE (verified 2026-03-30) |
| W1-E2 | Search impression tracking + daily pricing cron + GET /pricing/categories + GET /contributor/:wallet/pricing-insights | `specs/WAVE1-BUILD-E2-IMPRESSIONS-CRON.md` | Sonnet | DONE (verified 2026-03-30) |

### Build — Cleanup (P1)

| # | Task | Spec File | Owner | Status |
|---|------|-----------|-------|--------|
| W1-F1 | Create `public/favicon.svg` + version normalization in server.js + openapi.json | `specs/WAVE1-BUILD-F1-FAVICON-VERSION.md` | Sonnet | DONE (verified 2026-03-30) |

---

## 15. Governance: Documentation Rules

**These rules apply to ALL future work. No exceptions.**

### Rule 1: No Undocumented Features
Every new feature, endpoint, pricing change, policy change, or UX flow MUST be reflected in its domain's source-of-truth document BEFORE the PR/deploy is considered complete. The build spec must list which docs to update.

### Rule 2: INDEX.md Is the Map
`docs/INDEX.md` maps every document to its domain and declares source-of-truth status. New documents MUST be registered in INDEX.md. If a document is superseded, it gets a banner AND an INDEX.md update.

> ⚠️ 2026-07-15: the public repo's `docs/INDEX.md` is a **public-safe stub** — the sensitivity scrub `f70a6ef` deleted the full index (it mapped ~62 internal docs). The stub (committed via §20 DG-1) maps only the published docs and points to the private canon, which holds the complete index. Register new **public** docs in the stub; the full internal map is maintained in the private-canon `docs/INDEX.md`.

### Rule 3: One Source of Truth Per Domain
Each domain (product, marketplace, pricing, GTM, etc.) has exactly ONE source-of-truth document as designated in INDEX.md. Business decisions live in domain docs, NOT in MEMORY.md. MEMORY.md stores operational context only (credentials, VM IDs, session state).

### Rule 4: Build Specs Reference Docs
Every build spec (`specs/WAVE1-*.md`, `specs/BUILD-SPEC-*.md`) must include a "Documentation Impact" section listing which docs need updating. Reviewers check this before sign-off.

### Rule 5: Stale Detection
Any document with "Last updated" older than 30 days gets flagged in the next sprint planning. The sprint must include a documentation review item.

### Rule 6: Punch List Tracks Everything
Every planned enhancement, optimization, or addon gets a line item in PUNCH-LIST.md with: task description, owner, status, and spec file reference (if applicable). Nothing lives only in conversation history or memory bullets.

---

## 16. Review & Inspection Gates

**Reviews are gate-based, not calendar-based. Every change triggers the relevant gates before merge/deploy. No exceptions.**

### Gate A: Every Deploy/Merge (mandatory)

| Gate | Owner | Pass Criteria |
|------|-------|---------------|
| **Engineering Review** | BUILD-1 (Architect) | Spec matches architecture, no unintended side effects, fallback chains intact |
| **Code Inspection** | BUILD-4 (QA) | `node --check server.js` passes, all tests green, no regressions, scope check (only listed files modified) |
| **Security Review** | GOV-3 (Security Auditor) | Auth correct, input validated, no secrets in code, OWASP top 10 checked, no new attack surface |
| **Documentation Review** | GOV-1 (PM) | §15 Rule 1 enforced — domain docs updated, INDEX.md current, PUNCH-LIST.md updated |

### Gate B: Scope-Triggered (only when change touches that domain)

| Gate | Trigger | Owner | Pass Criteria |
|------|---------|-------|---------------|
| **Financial Integrity** | Any file in outputs/, financial model, investor deck, pricing assumptions, revenue projections | GOV-4 (CFO) | Every number traces to FOUNDATION.md, FOUNDATION.lock hash valid, no stale assumptions, cross-file sync verified |
| **Crypto/Payment** | Wallets, x402, pricing, payouts | SPEC-1 (Crypto Auditor) | Payment dedup intact, price bounds enforced, no fund loss paths |
| **Agent UX** | API responses, MCP tools, discovery, search | SPEC-2 (Agent UX) | Backward-compatible, agent can discover/query/unlock without breaking, error messages actionable |
| **Builder UX** | Onboarding, earnings, dashboard, API keys | SPEC-3 (Builder UX) | Flow completable end-to-end, earnings visible, no dead ends |
| **Legal/Compliance** | Terms, privacy, data handling, public claims, payments | GOV-2 (Compliance) | ToS/Privacy consistent, GENIUS Act compliant, no unapproved data collection |
| **Brand/Narrative** | Copy, messaging, external-facing text, landing page | BUILD-3 (Brand) | Voice consistent with BRAND_GUIDELINES.md, no jargon drift, ICP messaging intact |
| **SEO** | Page content, meta tags, URLs, sitemap | BUILD-3 (Brand) | Title/description tags present, structured data valid, canonical URLs, no broken links |
| **GEO (Generative Engine Optimization)** | llms.txt, agent.json, MCP descriptions, OpenAPI spec, instructions field | SPEC-2 (Agent UX) | Agent-discoverable, tool descriptions accurate, OpenAPI paths match live routes, llms.txt current |

### Gate C: Milestone Deep Dives (at major releases or when entering operate mode)

| Review | Trigger | Owner | Pass Criteria |
|--------|---------|-------|---------------|
| **Competitive** | Major release or quarterly | GOV-1 (PM) | Landscape scanned, moat intact, pricing competitive, no new threats unaddressed |
| **Catalog Health** | Major release or quarterly | GOV-1 (PM) | No stale learnings (>90d unrated), pricing distribution healthy, category gaps identified |
| **Infrastructure/Dependency** | Major release or quarterly | BUILD-4 (QA) | `npm audit` clean, Conway VM healthy, backups verified, uptime >99% |
| **Financial** | Major release or quarterly | GOV-2 (Compliance) | Revenue tracking accurate, payout math verified, tax reporting current |
| **Full UX Audit** | Major release | SPEC-2 + SPEC-3 | All user journeys tested, mobile responsive, accessibility basics met |

### How It Works in Practice

1. Build spec lists files to modify → that determines which Gate B reviews activate
2. Builder (BUILD-2) implements the spec
3. Gate A reviews run (all four, every time)
4. Gate B reviews run (only the ones triggered by scope)
5. All reviewers sign "SHIP" or "SHIP WITH FIXES" → fixes applied → re-review
6. GOV-1 (PM) gives final sign-off
7. Deploy to Conway VM
8. Post-deploy smoke test (BUILD-4)

**The agent who builds is never the only agent who reviews.**

---

## 17. GTM & Acquisition

| # | Finding | Priority | Owner | Status |
|---|---------|----------|-------|--------|
| GTM-1 | **History upload pipeline non-functional** — `requireSession` middleware undefined in server.js, `accounts` data structure unverified. Every POST /pipeline/upload request fails. Blocks onboarding flow (new builders can't upload history → can't earn from day 1 → flywheel stalls). | **P0** | BUILD-1 → BUILD-2 | **DONE** — `requireSession = requireAuth` alias confirmed at server.js:645 (bc2b4650); `accounts[accountId]` confirmed at server.js:5436 (81907963). `specs/BUILD-SPEC-GTM.md` documents full flow. |
| GTM-2 | **Pricing floor discrepancy** — `lib/pricing.js` exports `MIN_UNLOCK_PRICE = $0.005`. Approved floor is `$0.05`. 10x gap. Fix code to match approved pricing. | **P0** | BUILD-2 | **DONE** — server.js:1969 changed 0.005→0.05. `tests/test-sensitivity-filter.js` T-SF-INT-002 updated. `node --check` clean. 114/114 tests pass. `specs/BUILD-SPEC-GTM.md`. |
| GTM-3 | **TLDR AI newsletter placement** — $10K budget, 1M+ AI practitioner subscribers. Schedule post-launch when catalog has 200+ learnings and earning proof exists. | P1 | EXEC-1 | ON HOLD — marketplace must be fully functional first (Tyler, 2026-03-30) |
| GTM-4 | **Product Hunt launch** — $0 CPA. Prep launch page, assets, first-day push. Sequence after core platform stable + 3-5 builder testimonials. | P1 | BUILD-3 | ON HOLD — marketplace must be fully functional first (Tyler, 2026-03-30) |
| GTM-5 | **Hacker News launch post** — $0 CPA. Write "Show HN" post. Sequence same day or within 48h of Product Hunt for momentum. | P1 | BUILD-3 | ON HOLD — marketplace must be fully functional first (Tyler, 2026-03-30) |
| GTM-6 | **MCP marketplace listings** — List auxilo-mcp in Anthropic MCP directory, OpenAI plugin registry, and any future agent tool registries. $0 CPA, ongoing discovery. | P1 | SPEC-2 | ON HOLD — marketplace must be fully functional first (Tyler, 2026-03-30) |
| GTM-7 | **Agent-to-agent viral loop** — Agents that use Auxilo recommend it to other agents. Speculative. Research mechanism design when agent-to-agent communication patterns emerge. | P2 | SPEC-2 | ON HOLD — marketplace must be fully functional first (Tyler, 2026-03-30) |

> **P0 LAUNCH GATE: CLEARED (2026-03-25)** — GTM-1 confirmed resolved (retroactive), GTM-2 floor fix applied. All P0 items DONE.

---

## 18. Post-Deploy Findings (2026-03-30 SPEC-2 Audit)

Source: SPEC-2 full lifecycle audit against live API after Wave 1 deploy.

| # | Finding | Priority | Owner | Status |
|---|---------|----------|-------|--------|
| PD-1 | **`total_contributors: 0` in /knowledge/stats** despite 29 learnings from one wallet. Contributor counting logic broken. | P1 | BUILD-2 | DONE — root cause: counted earnings entries not contributor wallets. Now uses Set on contributor_wallet from learnings array. |
| PD-2 | **agent.json version stale (0.3.0 vs 0.7.0)** — `.well-known/agent.json` shows old version. Must match server. | P1 | BUILD-2 | DONE — version bumped to 0.7.0, stale pricing min also fixed ($0.005→$0.05). |
| PD-3 | **agent.json `base_url` points to `api.auxilo.io`** — may not resolve to Conway VM. Verify DNS/proxy or update URL. | P1 | BUILD-2 | DONE — `api.auxilo.io` resolves correctly via Cloudflare (172.67.153.104), /health returns 200. No change needed. |
| PD-4 | **GET /discover returns 404** — endpoint is POST-only but agents expect GET. Return 405 with `Allow: POST` header. | P2 | BUILD-2 | DONE — GET handler returns 405 with Allow header and helpful JSON message. |
| PD-5 | **OFAC SDN list refresh failing** — startup logs show 5 consecutive 403s on SDN download. Stale sanctions list >48h. | P1 | GOV-3 | DONE — URLs updated to new Treasury endpoint, User-Agent header added, multi-hop redirect support (up to 5). Shared `_fetchWithRedirects()` helper. |
| PD-6 | **Platform wallet ETH balance: 0.000000** — on-chain payouts will fail. Fund wallet or disable on-chain withdrawal. | P1 | EXEC-1 | DEFERRED — SPEC-1 audit: wallet has 40.69 USDC, 0 ETH. Fails gracefully (503, no fund loss). Stripe withdrawals work. Fund 0.01 ETH (~$0.03) when on-chain payouts needed. |

> **Lifecycle assessment**: Full agent lifecycle (search → preview → unlock → rate → contribute) is FUNCTIONAL. No blockers in the core chain.

---

## 19. Post-Deploy 5-Agent Audit (2026-03-30)

Source: 5-agent audit against live API after Wave 1 deploy. Top 5 findings addressed; remaining deferred to backlog.

| # | Finding | Priority | Owner | Status |
|---|---------|----------|-------|--------|
| BUILD-2a | **JSON 404 catch-all + security headers** — JSON 404 at line 5937, security headers middleware at line 84 of server.js. | P1 | BUILD-2 | DONE — deployed and verified live. |
| BUILD-2b | **Unauthenticated IP rate limiting on /knowledge and /discover** — `isSearchUnauthRateLimited()` at line 3544, applied at line 2344. 30 req/min per IP for unauth callers. | P1 | BUILD-2 | DONE — deployed and verified live. |
| BUILD-2c | **Batch validation on POST /learn** — `validationErrors` array at lines 3596-3623, returns all errors + `expected_fields` schema in single response. | P1 | BUILD-2 | DONE — deployed and verified live (POST /learn with `{}` returns errors array). |
| BUILD-2d | **Template tool names + URLs** — Fixed `auxilo_search_knowledge` → `auxilo_knowledge`, `auxilo_submit_learning` → `auxilo_contribute`, `auxilo_list_categories` → `auxilo_categories`. Replaced `auxilo.example.com` → `api.auxilo.io` across all 6 template files. | P1 | BUILD-2 | DONE — deployed to VM. |
| H-3 | **OFAC health visibility** — add monitoring/alerting for OFAC list fetch failures (currently fails silently). | P1 | GOV-3 | OPEN |

> Remaining audit items not in top 5: deferred to backlog. Will be triaged in next sprint planning.

---

## 20. Tech Debt & Governance Hygiene (P3)

> Added 2026-07-15 — GOV-1 surfaced these during r01-noncustodial-launch test triage. Both are P3 (polish); neither blocks launch, money, or scale. Full inventory captured here so the work isn't lost to conversation history (Rule 6).

| # | Item | Priority | Owner | Status |
|---|------|----------|-------|--------|
| TD-CONWAY-1 | Purge the dead-host `tech.conway.*` prefix from local automations, tests, and specs (detail below) | P3 | BUILD-2 + BUILD-4 | OPEN |
| DG-1 | `docs/INDEX.md` (doc-governance entrypoint) was scrubbed from the public repo — CLAUDE.md + §15 Rule 2 still mandate it (detail below) | P3 | GOV-1 | DONE — public-safe stub committed 2026-07-15 (option a) |

### TD-CONWAY-1 — Purge stale `tech.conway.*` naming

`tech.conway.*` is the pre-Fly host prefix (the retired Conway VM); production moved to fly.io, but the **local macOS LaunchAgents on the dev machine** still carry the dead-host name. **Three** labels exist across 9 files — the original handoff flagged only two; `auxilo-sweeper` was missed:

| Label | Status | Source-of-truth | Other references |
|---|---|---|---|
| `tech.conway.auxilo-sweeper` | **LIVE** (extraction sweeper) | `scripts/runner.js:362` (`SWEEPER_LABEL`, `installSweeper()`) | `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md:741,809`; `specs/TEST-P2.1a.md:1093` |
| `tech.conway.auxilo-digest` | **LIVE** (daily digest, re-enabled per LW-17) | `scripts/runner.js:452` (`DIGEST_LABEL`, `installDigest()`) | `jobs/daily-digest.js:25`; `test/p2-1a-digest.test.js` (6×, darwin-only skip guard); `specs/REWORK-P2.1a.md:179` |
| `tech.conway.auxilo-retraction-sweeper` | RETIRED 2026-06-11 (P1-13a) | — plist deleted | `jobs/retraction-sunset.js:20`; `test/p2-1a-retraction.test.js:180,195` |

**Delete vs. rename is Tyler's call** — two of the three are live jobs, not dead automations, so "delete the `tech.conway.*` local automations" may mean rename-off-the-dead-prefix for those. When the parent task runs:

1. **Automations** — change (or remove) the installed label at the source-of-truth constants `SWEEPER_LABEL` (`scripts/runner.js:362`) and `DIGEST_LABEL` (`scripts/runner.js:452`), re-run `node scripts/runner.js --install-sweeper` / `--install-digest` to rewrite the plists, and `launchctl bootout` the old labels.
2. **Digest test** (`test/p2-1a-digest.test.js:183-210`) — re-point the darwin-only plist assertions (path, label, `content.includes(...)`) to the new label once step 1 lands.
3. **Retraction test** (`test/p2-1a-retraction.test.js:189-205`) — ⚠️ the handoff called this "permanently inert / always skips"; that's **stale**. PR #11 rewrote it from a machine-state check to a source-doc assertion that pins `jobs/retraction-sunset.js` still contains the string `tech.conway.auxilo-retraction-sweeper` — it runs (and passes) on **every** host, CI included. To purge: update the retirement note (`jobs/retraction-sunset.js:20`) and the matching assertion string together, or drop the `B2` block — but that block also guards against re-introducing a local LaunchAgent that operates on dead data, so don't drop the guard silently.
4. **Specs & comments** — `specs/REWORK-P2.1a.md:179`, `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md:741,809`, `specs/TEST-P2.1a.md:1093`, plus the comments in `jobs/daily-digest.js:25` and `scripts/runner.js:444`.

### DG-1 — `docs/INDEX.md` absent from the public repo

`docs/INDEX.md` — the doc-governance entrypoint that **CLAUDE.md and §15 Rule 2 both mandate reading first** — was **deliberately deleted from this public repo** by the sensitivity scrub `f70a6ef` ("scrub business-sensitive content from public repo"); the commit body records that it "indexed ~62 internal docs (FINANCIAL-PLAN, RISK-REGISTER, …)". So its absence is by design (this repo is public) — but CLAUDE.md + Rule 2 still send every change to a file that no longer exists in any public checkout (this branch, r01, fresh clones). The full INDEX.md survives untracked in the private canon (`~/dev/auxilo/docs/INDEX.md`).

**Resolved 2026-07-15 — option (a) committed.** A *public-safe* `docs/INDEX.md` now maps only the published docs (with served routes: `/terms`, `/privacy`, `/legal/subprocessors`, `/legal/supported-clients`, `/dmca`) plus a directory-level pointer to other public artifacts, and a banner walling off the private canon — restoring the CLAUDE.md / Rule 2 entrypoint in public checkouts without republishing the ~62-doc internal index. Options weighed:
- **(a) [recommended]** Commit a *public-safe* `docs/INDEX.md` mapping only the 8 tracked public docs (AGENT-LEARNING-GUIDE, CONSENT-LOG-INTEGRITY, DMCA-POLICY, ONBOARDING-COPY, PRIVACY-POLICY, SUBPROCESSORS, SUPPORTED-CLIENTS, TERMS-OF-SERVICE), with a line noting the full internal index lives in the private canon. Restores the entrypoint without re-leaking.
- **(b)** Amend CLAUDE.md + §15 Rule 2 to point doc-governance at the private-canon INDEX.md and stop mandating a public-repo file.
- **(c)** Leave as-is; this line tracks the gap.

---

## Counts

| Priority | Open | On Hold | Deferred | Done/Verified | Total |
|----------|------|---------|----------|---------------|-------|
| P0 (blocks launch) | **0** | 0 | 0 | **28** | 28 |
| P1 (blocks real money / production) | **1** | 5 | 1 | 68 | 75 |
| P2 (blocks scale) | **3** | 1 | 0 | 23 | 27 |
| P3 (polish) | **1** | 0 | 0 | 4 | 5 |
| **Total** | **5** | **6** | **1** | **123** | **135** |

> **P2.1a Autonomous Extraction**: DONE (2026-04-15). Server-side extraction pipeline, admin CLI, transcript sources, runner, cron jobs, legal docs updated.
> PD-6: DEFERRED — Stripe withdrawals work, on-chain needs 0.01 ETH when ready.
> PD-1–PD-5: All DONE (2026-03-30). BUILD-2a–2d: DONE (5-agent audit, 2026-03-30). H-3 (OFAC monitoring): OPEN.

> **Spec files**: `auxilo/specs/SPEC-A3.md` (Opus), `SPEC-A0.md` (Opus), `SPEC-A2.md` (Sonnet), `SPEC-A1.md` (Sonnet), `SPEC-A4.md` (Sonnet)
> **P0 LAUNCH GATE: CLEARED** — All 26 P0 items DONE/VERIFIED. Sprint 07 closed T-4 (26/26), T-5 (30/30), T-7 (58/58). Total regression: 157/157 green.
> **Sprint 08 DONE**: Production Hardening — P1 Infra (I-4, I-5) + P2 Security (M-A through M-G). 28/28 S8 tests + 49/49 P03 regression + 11/11 live checks. See `specs/SPRINT-08.md`.
> **Sprint 09 DONE**: Audit Remediation — 5/5 audit findings fixed (AU-1 through AU-5). 10/10 regression checks green. 8 findings deferred. See `specs/SPRINT-09.md` + `specs/AUDIT-POST-S8-RESULTS.md`.
> **Sprint 11 DONE**: MCP Completeness + Security Polish — AU-10 (8 MCP tools), AU-11 (CORS docs), AU-12 (err.message stripped), AU-13 (startup .catch replaced). 4/4 items closed.
> **Sprint 12 DONE**: Deploy (server already current, S11 live-confirmed), auxilo-mcp v0.7.0 packaged (BLOCKED npm auth — `npm login` required), live 9/9 PASS. AU-12 confirmed no `details` field; 32 routes; /renderly/health, /stats, /knowledge/stats all 200.
> **Sprint 13 DONE**: Brand & Narrative — BRAND_GUIDELINES.md (B-1, 159 lines) + landing-page-copy.md (B-8, 194 lines). Zero code changes. Opus model.
> **Sprint 14 DONE**: Landing Page Build & Deploy — index.html (34KB), styles.css (22KB), server.js route changes (Approach A: / → landing page, /api → API discovery). PM2 restart. 7/7 live checks 200. Sonnet model. No new punch list items closed (build/deploy bridges B-1 + B-8 into production).
> **Sprint 15 DONE**: Brand Assets & Governance — B-6 (OG image, 1200×630 PNG deployed to VM, serves 200), B-7 (favicon, inline SVG data URI in index.html), G-1 (Stripe terms review, 15.5KB compliance doc). 3 items closed. Opus model. Key insight from G-1: x402 and Stripe must be separate rails — no fiat↔crypto conversion.
> **Sprint 16 DONE**: Content & Assets — B-5 (8 SVG icons, 24×24, monoline stroke, currentColor), B-9 (onboarding copy, 6 sections covering full builder flow). 2 items closed. Opus model. No deployment needed (assets not yet integrated into UI).
> **Sprint 17 DONE**: Brand Assets Final — B-2 (geometric-pattern.svg, tile-ready, 8-12% Aurum opacity), B-3 (growth-flywheel.svg, 4-stage circular loop, "learnings" not "skills"), B-4 (section-divider.svg, centered A mark + gradient fade lines). 3 items closed. Opus model. All P1 brand items now DONE.
> **Sprint 18 DONE**: Governance Sweep — G-2 (MSB analysis, MEDIUM risk, marketplace exemption likely applies), G-3 (tax reporting, 1099-K at $600 threshold), G-4 (ToS draft, Wyoming recommended), G-5 (privacy policy draft, GDPR/CCPA covered), G-6 (risk register, 20 risks, 9 HIGH/CRITICAL). 5 items closed. Opus model. **All P0 + P1 items now DONE.** Only 3 deferred P2 audit items + 1 blocked remain.
> **Sprint 19 DONE**: Integration & Deploy — Icons integrated into landing page (5 feature icons + 3 step icons, inline SVG, currentColor). Growth flywheel section added between #how-it-works and #for-builders. OG image deployed (31552 bytes, serves 200). `auxilo-mcp@0.7.0` published to npm (npm auth blocker cleared via granular access token). 5/5 live checks pass. Sonnet model for integration, manual deploy via ttyd.
> **Sprint 20 DONE**: P2 Scale Optimizations — AU-6 (startup parallelization, WAL sequential then Promise.all for settlements), AU-7 (in-memory TTL cache for accounts 60s + settlements 30s), AU-8 (per-API-key sliding window rate limiter, x402 bypass). Audited by Opus (SHIP WITH FIXES → 4 fixes applied → re-audit SHIP). Deployed to VM, 6/6 live checks pass. **All open items CLOSED. Only B-10 (LinkedIn launch content) remains BLOCKED on stealth mode lift.**
> **Sprints 21-25 DONE**: Production Readiness — 4 parallel review agents (Legal, Security, Infra, Ops) identified 18 unique blockers. All addressed across 5 sprints: S21 (x402 payment dedup, content moderation hold, reporting endpoint, SESSION_SECRET validation, health-check.js), S22 (OFAC SDN screening from treasury.gov + alt.csv, backup.sh + setup-cron.sh), S23 (legal doc hardening: contact info, indemnification, GENIUS Act, payment characterization normalization, payout mechanism language, DMCA registration guide), S24 (version normalization 0.7.0, OpenAPI 36→45 paths, security.txt, status page, error code reference), S25 (audit remediation: backup path fix, PII hash in reports, OFAC alt.csv, Bitcoin case sensitivity). Consolidated audit: SHIP WITH FIXES → 4 HIGHs fixed → deployed. 8/8 live checks pass.
> **Unblocked**: B-9 (onboarding copy) — Phase 0 + 1 now complete
> **Orchestrator**: Run via ORCHESTRATOR.md — dispatches scoped agents with fresh context per sprint item
> **Docs**: DEPLOY-GUIDE.md (Conway deployment), ORCHESTRATOR.md (sprint execution pattern)
> **P2.1a — Autonomous Learning Extraction**:
> - A6 Option B: `scheduled` extraction mode removed from validModes (server.js) and openapi.json enum. Review surface deferred to P2.1b.
> - B16: No-op — Option B selected, no `/extract/review/*` routes needed. Confirmed no stale routes exist.
> - Legacy 4-learning flush: DONE 2026-04-18 (3 published via `/learn` POST: mailersend, cloudflare-email-routing, cloudflare-pages. 4th (private-email-stack) correctly rejected by sensitivity-filter v0.4 for real PII — moved to ~/.auxilo/rejected-sensitive-20260418/).
> - FOUNDATION.md prerequisite: P2.1a launch depends on the governance framework in FOUNDATION.md (not yet created). Cross-reference the P0 governance track.

> **P2.1a — Bugs discovered during T-107/T-108 runs (2026-04-18), queued as P1 fast-follows**:
> - P1-1: `claude-code source.discoverSessions` looked in wrong path (`conversations/` subdir) — ✅ FIXED `2732ac6`.
> - P1-2: `claude-code source.readSession` extracted `msg.content` (wrong level) — ✅ FIXED `2732ac6`. Real shape is `msg.message.content` array of typed blocks.
> - P1-3: `runner.js --transcript <path>` handler missing — ✅ FIXED `ece8072`. Single-file mode now works via source adapter + scrub + POST pipeline; plain-text fallback when readSession fails.
> - P1-4: `ip_redacted` IPv4-only regex — ✅ FIXED `799c972`. New `redactIp()` helper handles IPv4 (mask last octet) + IPv6 (truncate at /64 prefix). Unit-tested in-place.
> - P1-5: `/extract` Idempotency-Key undocumented — ✅ FIXED `560adec`. AGENT-LEARNING-GUIDE §4 now has full request example + 8-row error-code cheat sheet.
> - P1-6: `/extract/consent` POST route missing — ✅ FIXED `799c972`. Thin wrapper over appendConsent with action→mode mapping (grant→automatic, revoke→off).
> - P1-7: `/account/settings` Bearer-JWT-only, rejects X-API-Key — ⏸ DEFERRED. Runner can't flip modes programmatically. Needs auth-surface review before changing; post-soak task.
> - P1-8: `runner.js` ignored `~/.auxilo/credentials.json` — ✅ FIXED `ece8072`. `loadCredentials()` now reads env → file → localhost default. Matches mcp-server.js.
> - P1-9: Extractor chunk failures silent — ✅ FIXED `dcd3d91`. Server now logs `X/Y chunks failed LLM extraction: <error>` to stderr when `providerResult.stats.chunks_failed > 0`.
> - P1-10: Dockerfile runs as root — ✅ FIXED `5a1cf91`. New `scripts/docker-entrypoint.sh` chowns /app/data then `exec su-exec node`. Applied on next Fly deploy.
> - P1-11: Anthropic dashboard truncated-key display confusion — pending doc note in AGENT-LEARNING-GUIDE (P2 polish).
> - P1-12: npm audit high advisories — ✅ FIXED `6cc3f73`. 4 advisories patched via in-major upgrades (hono, path-to-regexp, express-rate-limit, @hono/node-server). 0 vulnerabilities remaining.
> - P1-13: LaunchAgent `auxilo-sweeper` TCC-blocked on `~/Documents/` — ⏸ DEFERRED. Tyler's machine-local fix (move wrapper to `~/.auxilo/bin/` + update plist path + launchctl reload). Doesn't block Fly.
> - P1-14: `deploy.js` pkill+nohup legacy code — SUPERSEDED (current deploy uses git-pull path via `a7eb2cf`). Delete post-Conway-decom.
> - P1-15: Conway sandbox `dc034f2b...` 48h standby — decommission deadline 2026-04-21. Requires Tyler's go (destructive prod action).
> - P1-16: Cloudflare proxy re-enable with Full (strict) SSL — post-soak enhancement, Tyler's call.
>
> **P1 fix burn-down (2026-04-18 session)**: 9 fixes shipped, 3 deferred (P1-7, P1-13 need Tyler review; P1-16 is an enhancement), 1 pending non-urgent doc polish (P1-11). Commits: `2732ac6`, `560adec`, `799c972`, `ece8072`, `5a1cf91`, `6cc3f73`, `82a7a21`, `dcd3d91`. All in `origin/main`, will land on next `flyctl deploy` (post-soak).

> **P2.1a — T-109 execution log (2026-04-18)**:
> - T-105 ✅ (skipped — doc checks against pre-migration infra; post-migration docs pending separate T-105 re-run)
> - T-106 ✅ consent grant recorded: audit chain genesis at 2026-04-18T17:03:41Z
> - T-107 ✅ server-side pipeline exercised end-to-end (extract_attempt audit row, idempotency row, chain continuity verified)
> - T-108 ✅ real publish: 2 learnings, cost $0.02376, retraction_window_ends 2026-04-25
> - T-109 steps 1-8 ✅ (retraction, recursion guard, kill switch, server revocation all verified 2026-04-18)
> - T-109 step 9: **IN PROGRESS** — 72h soak started 2026-04-18T17:54Z, expected pass at 2026-04-21T17:54Z
