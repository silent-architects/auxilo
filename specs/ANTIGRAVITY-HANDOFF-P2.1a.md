# Antigravity Handoff — P2.1a Autonomous Learning Extraction

## 1. Mission

Implement P2.1a autonomous learning extraction per the build spec. Ship working code that passes every test in `specs/TEST-P2.1a.md`. Tyler is the pilot user and **T-109 is the gating acceptance test** — no merge until T-109 is green on Tyler's machine.

## 2. Required reading (in this order)

1. `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md` — authoritative spec; do not deviate.
2. `specs/TEST-P2.1a.md` — 115 test cases (114 + T-039a); every one must pass.
3. `CLAUDE.md` (project root) — governance rules, source discipline.
4. `docs/INDEX.md` — doc map; you will update several domain docs as part of this build.
5. Existing code you are extending:
   - `lib/extractor.js`
   - `lib/sensitivity-filter.js`
   - `lib/openclaw-adapter.js`
   - `server.js` lines 3566–3982 (existing `/extract` + `/learn` handlers)

## 3. Scope — DO NOT

- **Do not touch `lib/earnings.js`.** Instant-credit at `server.js:725` stays exactly as-is.
- **Do not add new subprocessors beyond Anthropic.** Haiku 4.5 primary, Sonnet 4.5 fallback — both Anthropic direct.
- **Do not invent product promises.** Consult `docs/PROMISE-VERIFICATION-REGISTER.md` — every user-facing string must trace to an existing canonical source.
- **Do not decide architecture.** The spec decides. If the spec is ambiguous on a point, STOP and return the question; do not improvise.
- **Do not modify existing `/learn` validation or OFAC screening.** Reuse `checkOFAC` at `server.js:~3648` and the `/learn` write path at `server.js:3566-3900`.
- **Do not skip the test suite.** All 115 cases must pass, including T-109 (gating Tyler-pilot E2E).

## 4. Scope — DO

- Implement every file listed in spec §12.1 (new) and §12.2 (modified).
- Implement `scoreLearning(learning, config)` export on `lib/extractor.js` per the signature in spec §12.2. Pure function, no LLM, no I/O, ~15 LOC. Used by regression corpus T-111–T-114.
- Implement `scripts/admin.js extract:reset-kill-switch --reason <str> --acknowledged-by <str>` per spec §3.6 and §15.3. Writes audit row `action="kill_switch_reset"`.
- Add `consent_version` field to audit rows per spec §9.1 and §3.5 step 3. Captured from the matched grant row at consent-check time, threaded through to every audit write.
- Implement **final-publish-recheck** cancellation per spec §3.5.4: fresh consent-state read with `forceReload: true` immediately before each candidate's POST to `/learn`, not once per extraction. Reject in-flight candidates with `reason="revoked_in_flight"`.
- Implement **per-account idempotency scope** per spec §3.7 and §13 Q2. Key is `(account_id, session_id, transcript_sha256)`. Never global.
- **Default model: `claude-haiku-4-5`** per spec §6.3. **Fallback: `claude-sonnet-4-5`**. Both configured in `model_config.json` under `extraction`. Swappable without code change.
- Implement `$100/day` kill switch as **manual reset only** — does NOT auto-reset at UTC midnight. Only the `$50/day` throttle auto-resets. See spec §3.6.
- Run the full test suite; report pass/fail per test ID in your delivery summary.

## 5. Handoff assets inventory

**New files (spec §12.1):**
- `scripts/runner.js` — thin transport layer replacing `scripts/extract-learnings.js` (~200 LOC)
- `scripts/sources/source.interface.js` — `TranscriptSource` base
- `scripts/sources/claude-code.js` — Claude Code adapter
- `scripts/sources/openclaw.js` — OpenClaw adapter (poll-only v1)
- `lib/providers/provider.interface.js` — `ExtractionProvider` base + error classes
- `lib/providers/anthropic.js` — Anthropic implementation (Haiku default)
- `data/extractions.jsonl` — idempotency ledger
- `data/extraction-consent.jsonl` — versioned consent log
- `data/extraction-review.jsonl` — scheduled/manual review queue
- `data/audit-extractions.jsonl` — hash-chained audit log
- `data/extract-cap-overrides.json` — per-account override config
- `jobs/daily-digest.js` — digest + retraction sweeper cron
- `ops/extract-spend-report.js` — CFO-1 daily spend email
- `docs/SUBPROCESSORS.md` — public subprocessor list
- `docs/SUPPORTED-CLIENTS.md` — public supported-clients list

**Modified files (spec §12.2):**
- `server.js` — rewire `/extract` handler; add `DELETE /learn/:id?reason=retract`; add `PATCH /account/settings`; middleware for dollar-breaker, idempotency, consent check
- `lib/sensitivity-filter.js` — add `scanText()`, 10 new patterns, normalization pass, bump version
- `lib/extractor.js` — add `sanitizeLearningBody()`; export `scoreLearning(learning, config)`
- `model_config.json` — add `extraction` section (Haiku primary, Sonnet fallback)
- `docs/TERMS-OF-SERVICE.md` — §5.9 restructure + new §5.9.3 / §5.9.4
- `docs/PRIVACY-POLICY.md` — §1.2, §3.8, §4, §7.5, §8.3 amendments
- `docs/RISK-REGISTER.md` — R-21 addition + changelog
- `docs/INDEX.md` — add SUBPROCESSORS.md, SUPPORTED-CLIENTS.md; mark P2.1 superseded
- `docs/RUNBOOK.md` — kill-switch reset procedure (§15.3), daily-digest worker, retraction CLI
- `AGENT-LEARNING-GUIDE.md` — §3 rewrite for three-mode architecture
- `PUNCH-LIST.md`, `TASKS.md` — add P2.1a phase entries
- `openapi.json` — `/extract`, `/extract/review/*`, `DELETE /learn/:id`, `PATCH /account/settings`
- `~/.claude/hooks/auxilo-extract.sh` — replace nohup spawn with local curl
- `auxilo/scripts/auxilo-sweeper-wrapper.sh` — remove `~/.zshrc` sourcing

**Deprecated (spec §12.3):**
- `scripts/extract-learnings.js` — delete after GO
- `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md` — mark superseded banner + INDEX update

## 6. Acceptance criteria (green signal)

- All 115 tests in `specs/TEST-P2.1a.md` pass (114 original + T-039a).
- **T-109 (Tyler pilot E2E) demonstrably works on Tyler's machine** — gating.
- No modifications to `lib/earnings.js` or `server.js:725`.
- All four legacy learnings at `~/.auxilo/pending-learnings/001-*.json` … `004-*.json` score deterministically via `scoreLearning` against frozen `.expected.json` fixtures (T-111–T-114).
- Audit log rows contain `consent_version` on all success paths (T-039a).
- `$100/day` kill switch persists across UTC midnight and only resets via `scripts/admin.js extract:reset-kill-switch` (T-082).
- GOV-3 BLOCKERS B1–B4 resolved (auth, body-size, zero persistence, consent record).

## 7. Review gates triggered

**Gate A (always):**
- BUILD-1 (architecture / self-review against delivered code)
- BUILD-4 (code inspection + QA sign-off against the test suite)
- GOV-3 (security — verify B1–B4)
- GOV-1 (documentation governance)

**Gate B (scope-triggered for this spec):**
- GOV-2 (compliance — transcript forwarding, consent log, ToS §5.9.3/§5.9.4, Privacy Policy amendments)
- SPEC-2 (agent-UX — new `/extract` endpoint contract, runner API, OpenClaw adapter)
- SPEC-3 (builder-UX — kill switch, account-level mode toggle, daily digest)

All Gate A + Gate B reviews run **concurrent post-delivery**. Antigravity ships first; reviewers run against the delivered code. Do not wait for reviews before delivering.

## 8. Escalation

- **Blocking ambiguity:** return a question, do not improvise.
- **Decision the spec didn't anticipate:** return the decision, do not make it.
- **Test that can't be satisfied as written:** return the test ID and your reading of the gap, do not silently rewrite it.

## 9. Why this exists

This feature is the load-bearing promise behind Auxilo's "your agents learn, you earn" value prop. Tyler surfaced the gap as user #1. The P2.1 iteration built it wrong (client-side, no server endpoint, no consent log, no audit trail). P2.1a is the corrected server-side architecture with full compliance scaffolding. The spec is the synthesis of five specialist reviews (BUILD-1, BUILD-4, GOV-3, GOV-2, CFO-1, GOV-1). Don't relitigate it — ship it.

---

**End of handoff. Start at spec §0. Deliver against §12.1 + §12.2. Ship when the test suite is green.**
