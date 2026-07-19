# Auxilo — Master Task List

> Source of truth for all Auxilo build work. Updated per session.
> Owner IDs reference AGENT-TEAM.md. Full item tracking in PUNCH-LIST.md.
> Last updated: 2026-02-25

---

## Strategic Decisions (Locked)

These were decided in the 2026-02-25 strategy session. Don't revisit unless Tyler reopens.

1. **Runtime-agnostic** — Auxilo works with ANY agent runtime (OpenClaw, Claude Code, CrewAI, custom). No vendor lock-in. No partnerships required.
2. **Dual payment rails** — x402 (crypto-native) AND API key + credits (traditional). Both hit the same endpoints. Builders earn the same regardless of which rail the buyer used.
3. **API key path is demand-side unlock** — Without it, agents can't buy learnings. One-sided marketplace dies. This is not optional.
4. **Wallet-less start for builders** — Publish learnings without a wallet. Earnings accumulate. Connect wallet later to withdraw. Defer crypto friction until money is waiting.
5. **OpenClaw is primary distribution channel** — 60K+ GitHub stars, MCP-native, active plugin ecosystem (ClawHub). Ship an Auxilo skill there before anyone else occupies the knowledge monetization niche.
6. **System prompt template is the atomic unit** — If agents can't reliably detect and publish learnings, nothing else matters.
7. **Landing page comes AFTER the product works** — Don't build a pretty page for a broken funnel. Onboarding, earnings, and demand must work first.
8. **Stealth mode** — No partnerships, no announcements. Build quietly, launch fully operational.

---

## SPEC-SF: Sensitivity Filter Security Fixes (GOV-3 Prerequisite)

> **Required before Build-2 A-series execution.** GOV-3 sign-off gates A3→A0→A2→A1→A4.
>
> **Owner:** BUILD-2 (implementer) | **Reviewer:** GOV-3

| Finding | Fix | Status | Tests |
|---------|-----|--------|-------|
| C-1: Pattern gaps (SSH/Slack/Stripe/Google/npm/PEM) | 6 new `PATTERNS` entries | DONE | T-SF-UNIT-001..012 |
| C-2: sk_live_ not caught | Dedicated `stripe_key` pattern | DONE | T-SF-UNIT-006..008 |
| H-2: redactMatch leaks too many chars | Changed to 3+2 char format | DONE | T-SF-UNIT-016..017 |
| H-3: No unlock_price ceiling | `MAX_UNLOCK_PRICE = 1.00` | DONE | T-SF-INT-003..004 |
| M-1: scanLearning not try/catched | Fail-closed 500 response | DONE | T-SF-INT-012 |
| M-2: No /g flag assertion | Assertion at module load | DONE | T-SF-EDGE-015 |
| M-3: aws_secret substring match | Word-boundary regex | DONE | T-SF-EDGE-013 |
| M-4: password false positives | Negative lookahead | DONE | T-SF-EDGE-007..011 |
| M-5: Dedup re-hashes on every POST | Pre-computed `body_hash` stored on new learnings | DONE | T-SF-INT-005..009 |
| M-6: 409 exposes existing_id/title | Stripped from response | DONE | T-SF-INT-006..007 |
| L-3: Docs out of sync | Guide, punch-list, tasks updated | DONE | — |

**Files changed:** `lib/sensitivity-filter.js`, `server.js`, `tests/test-sensitivity-filter.js`, `AGENT-LEARNING-GUIDE.md`, `PUNCH-LIST.md`, `TASKS.md`

---

## Phase 0: Payment Infrastructure

> **Why first:** Without dual-rail payments, agents can't buy learnings. No demand = no earnings = builders leave. This is the load-bearing wall.
>
> **Review assignments:** GOV-2 (Compliance) reviews Stripe terms for crypto-adjacent products. SPEC-3 (Builder UX) reviews account + earnings flows. SPEC-2 (Agent UX) reviews dual-auth developer experience.

### 0.1 — Account System
- **Owner:** BUILD-1 (Architect specs) → BUILD-2 (Builder implements)
- [ ] Email-based account creation (magic link or email + password)
- [ ] API key generation per account
- [ ] Account dashboard endpoint (balance, usage, keys)
- **Files:** server.js (new routes), new accounts data file
- **Dependencies:** None
- **Notes:** Keep it minimal. Email + API key. No OAuth, no social login. Ship fast.

### 0.2 — Dual Auth Middleware
- **Owner:** BUILD-1 → BUILD-2
- [ ] Modify paid endpoints to accept EITHER x402 payment header OR `Authorization: Bearer {api_key}`
- [ ] x402 path unchanged — verify via facilitator as today
- [ ] API key path — verify key validity, check credit balance, debit on success
- [ ] Neither present → return 401 with both options explained
- **Files:** server.js (auth middleware refactor)
- **Dependencies:** 0.1 (accounts must exist for API keys to validate)
- **Regression:** All existing x402 flows must still work identically. Zero breaking changes for current API consumers.

### 0.3 — Credit System
- **Owner:** BUILD-1 → BUILD-2
- [x] ~~Free tier: 50 discovery queries + 10 unlocks per month per account~~ **KILLED — no free tier. Every account is funded. Discovery/search are free for all.**
- [ ] Credit balance tracking per account
- [ ] Credit debit on successful paid request
- [x] ~~Monthly free tier reset (cron or on-request check)~~ **KILLED — no free tier.**
- **Files:** server.js, new credits data file
- **Dependencies:** 0.1, 0.2

### 0.4 — Stripe Integration
- **Owner:** BUILD-1 → BUILD-2 | **Review:** GOV-2 (Stripe terms for crypto-adjacent products)
- [ ] Credit pack purchases ($5 / $20 / $50)
- [ ] Stripe Checkout or Payment Links (simplest path)
- [ ] Webhook to credit account on successful payment
- [ ] Receipt/confirmation
- **Files:** server.js (new routes), Stripe config
- **Dependencies:** 0.1, 0.3
- **Notes:** Stripe has compliance requirements. Research terms for crypto-adjacent products before integrating.

### 0.5 — Updated Earnings System
- **Owner:** BUILD-1 → BUILD-2
- [ ] Track earnings by account ID (not just wallet)
- [ ] Builder publishes with API key → earnings attributed to their account
- [ ] Builder connects wallet later → earnings become withdrawable
- [ ] Backward compatible: existing wallet-based earnings still work
- **Files:** server.js, earnings.json schema update
- **Dependencies:** 0.1
- **Regression:** Existing wallet-verified builders must see no change in earnings or withdrawal flow.

---

## Phase 1: Autonomous Publishing (The Atomic Unit)

> **Why second:** This is the product. If agents can't detect and publish learnings reliably, the marketplace has no supply.
>
> **Review assignments:** SPEC-2 (Agent UX) validates agent-side flows. BUILD-4 (QA) tests across Claude Code + OpenClaw minimum.

### 1.1 — System Prompt Template
- **Owner:** BUILD-3 (Brand & Narrative) + SPEC-2 (Agent UX)
- [ ] Write battle-tested prompt instructions for learning detection
- [ ] Define learning triggers: error→workaround, multi-attempt→success, undocumented behavior, novel tool chain, performance optimization
- [ ] Include quality gate: confidence scoring (only publish at 7+/10)
- [ ] Include dedup check: search Auxilo before publishing
- [ ] Include structured output format (title, body, category, tags, task_context, outcome)
- [ ] Test across multiple agent frameworks (Claude Code, OpenClaw at minimum)
- [ ] Iterate until false positive rate is acceptable
- **Files:** New file — `auxilo/prompts/learning-detection.md`
- **Dependencies:** None (can be built in parallel with Phase 0)
- **Notes:** This is prompt engineering, not code. But it IS the product. Treat it with the same rigor as code — test, iterate, version.

### 1.2 — Learning Extractor (Post-Session)
- **Owner:** BUILD-1 → BUILD-2
- [ ] Core extraction logic: takes a session transcript → identifies learning moments → outputs structured learnings
- [ ] Confidence scoring per extracted learning
- [ ] Deduplication against existing Auxilo knowledge base
- [ ] Input: plain text (runtime-agnostic)
- [ ] Output: array of structured learning objects ready for POST /learn
- **Files:** New file — `auxilo/extractor.js` (or separate package)
- **Dependencies:** 1.1 (uses the same detection triggers, but applied to transcripts rather than inline)

### 1.3 — OpenClaw Adapter
- **Owner:** BUILD-1 → BUILD-2
- [ ] Reads OpenClaw's Markdown memory files
- [ ] Feeds them to the learning extractor (1.2)
- [ ] Runs on OpenClaw's heartbeat daemon (scheduled extraction)
- [ ] Configurable: extraction frequency, confidence threshold, auto-publish vs. review queue

---

## Phase 2.1a: Autonomous Learning Extraction (Server-Side)

> **Spec:** `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md`
> **Status:** DONE (2026-04-15). All code implemented. 114/114 tests pass. T-109 E2E pilot pending Tyler.
> **Supersedes:** Phase 1 client-side extraction. `scripts/extract-learnings.js` deprecated.

### Summary
Rewired extraction from client-side Anthropic calls to a secure server-side pipeline via `POST /extract`. Three trigger modes (automatic/scheduled/manual), $100/day circuit breaker, hash-chained audit logging, 7-day retraction window, tiered rate limiting, and full legal amendments (ToS §5.9.3/§5.9.4, PP §1.2/§3.8/§7.5/§8.3).

### New Files
| File | Role |
|---|---|
| `scripts/runner.js` | Client-side runner (replaces `extract-learnings.js`) |
| `scripts/sources/source.interface.js` | TranscriptSource base class |
| `scripts/sources/claude-code.js` | Claude Code adapter |
| `scripts/sources/openclaw.js` | OpenClaw adapter (poll-only v1) |
| `scripts/hooks/auxilo-extract.sh` | Post-session hook template |
| `scripts/admin.js` | Admin CLI (`extract:reset-kill-switch`) |
| `lib/providers/provider.interface.js` | ExtractionProvider base + error classes |
| `lib/providers/anthropic.js` | Anthropic implementation |
| `lib/extraction-consent-reader.js` | Consent log reader |
| `lib/extraction-audit-writer.js` | Hash-chained audit writer |
| `jobs/daily-digest.js` | Daily extraction digest |
| `ops/extract-spend-report.js` | 7-day spend report |
| `docs/SUBPROCESSORS.md` | Public subprocessor list |
| `docs/SUPPORTED-CLIENTS.md` | Supported client integrations |

### Modified Files
| File | Change |
|---|---|
| `server.js` | `/extract` rewire, `DELETE /learn/:id`, `PATCH /account/settings` |
| `lib/sensitivity-filter.js` | `scanText()` + 10 new patterns |
| `lib/extractor.js` | `sanitizeLearningBody()` + `scoreLearning()` |
| `config/model_config.json` | `extraction` section |
| `docs/TERMS-OF-SERVICE.md` | §5.9.3 + §5.9.4 |
| `docs/PRIVACY-POLICY.md` | §1.2, §3.8, §4, §7.5, §8.3 |
| `docs/RISK-REGISTER.md` | R-21 |
| `docs/INDEX.md` | Added SUBPROCESSORS.md, SUPPORTED-CLIENTS.md |
| `docs/RUNBOOK.md` | §10 extraction ops |
| `AGENT-LEARNING-GUIDE.md` | §3 three-mode architecture |

### Legacy Backlog
- [ ] Tyler manually flushes 4-learning backlog under `contributor_agent: auxilo-extract-slash/1` before or after deploy — independent timeline per GOV-1 decision.