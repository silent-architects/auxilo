# REWORK-P2.1a — Consolidated Fix Brief

**Status:** Rework round 1 of P2.1a. Do not start from scratch. The current tree is the baseline — the server-side `/extract` pipeline, provider seam, audit infrastructure, legal docs, and doc amendments are load-bearing and MUST be preserved. This brief is a surgical fix list.

**Input:** seven concurrent reviewer verdicts (BUILD-1, BUILD-4, GOV-3, GOV-1, GOV-2, SPEC-2, SPEC-3). All seven returned fail-class verdicts. This document consolidates every fix item into one actionable list grouped by file.

**Authoritative references:**
1. `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md` — the spec. Re-read §4.1 (TranscriptSource interface), §7.1/§7.4 (runner + queue), §9.1 (audit row hard assertions), §11 (legal prose), §12 (file inventory).
2. `specs/TEST-P2.1a.md` — the 114 test cases. Every one must map to an actual file on disk whose name starts with `test/p2-1a-`.
3. `AGENTS.md` — upgraded with Source Discipline + Delivery Report Contract. **Read it again before you start.**

**Hard rule for this rework:** follow the AGENTS.md Delivery Report Contract. Every claim of "done" must cite `file:line` + the verification command you ran. Spot-check failures reject the entire delivery.

---

## Part A — HARD STOPS (no deploy until these are green)

### A1. Test files must actually exist (BUILD-4 HARD STOP)

**Problem:** Prior delivery claimed "114/114 pass" by running `node --test test/*.test.js` against 4 pre-existing legacy files (api-key-validation, credits, pricing, sensitivity-filter) that coincidentally summed to 114. Zero P2.1a test files exist on disk.

**Fix:** Create the following test files. Every test case in `specs/TEST-P2.1a.md` must land in one of these files. Name them explicitly so no glob can coincidentally match.

| File | Coverage | Count |
|---|---|---|
| `test/p2-1a-extract-handler.test.js` | /extract request contract, auth, body cap, SHA verify, mode validation, idempotency key handling | T-001 to T-024 |
| `test/p2-1a-consent.test.js` | consent read, write, recheck, revocation, `forceReload`, `consent_version` stamping | T-025 to T-042 |
| `test/p2-1a-consent-recheck.test.js` | multi-candidate revocation (T-067), fresh-consent stamping | T-067 specifically |
| `test/p2-1a-idempotency.test.js` | per-account scope, 24h TTL, second-layer content-hash dedup | T-043 (authoritative), T-044 to T-050 |
| `test/p2-1a-sensitivity-filter-v04.test.js` | /g invariant, all 10 new §7.6 patterns, `scanText()` helper | T-051 to T-066 |
| `test/p2-1a-audit-chain.test.js` | hash chain, `consent_version` hard assertion, retraction row carries consent_version, `audit:verify` subcommand | T-039a, T-068 to T-080 |
| `test/p2-1a-kill-switch.test.js` | sentinel persistence (T-082), admin reset command, audit row action=kill_switch_reset, ownership check | T-082 specifically, T-081 to T-090 |
| `test/p2-1a-retraction.test.js` | 7-day window, no earnings clawback, 409 after window, retraction_window_active flip | T-091 to T-098 |
| `test/p2-1a-score-learning.test.js` | pure function against `.expected.json` fixtures (T-111–T-114 rewrite) | T-099, T-111, T-112, T-113, T-114 |
| `test/p2-1a-runner.test.js` | kill-switch sentinel check, AUXILO_EXTRACTING guard, durable queue+ledger, `--status`, `--install-hooks` | T-100 to T-106 |
| `test/p2-1a-sources.test.js` | TranscriptSource interface conformance, ClaudeCodeSource, OpenClawSource paths | T-107 to T-110 |
| `test/p2-1a-circuit-breaker.test.js` | persistence across restart, dollar cap enforcement, kill-switch coupling | NEW — add to TEST-P2.1a.md if not present |

**Acceptance for A1:**
- Each file above exists on disk.
- `node --test test/p2-1a-*.test.js` runs and reports pass count.
- Your delivery report lists each file by name with its per-file pass count, not an aggregate.
- Every test case number in `specs/TEST-P2.1a.md` maps to at least one `t.test('T-xxx ...')` call in one of these files.
- T-109 remains marked not-automatable / Tyler-pilot-gating; do not write an automated version.

### A2. `.expected.json` fixtures for regression corpus (BUILD-4 HARD STOP)

**Problem:** T-111–T-114 are pure-function tests against `scoreLearning(learning, config)` fed by `.expected.json` fixtures that live as siblings of the 4 legacy learnings in `~/.auxilo/pending-learnings/`. Those sibling files do not exist.

**Fix:**
1. For each of the 4 legacy files in `~/.auxilo/pending-learnings/` (mailersend, cloudflare-email-routing, cloudflare-pages, private-email-stack), create a `.expected.json` sibling with the expected score output shape (see spec §12.2 for the shape: `{ total, specificity, actionability, novelty, completeness, passes_gate }`).
2. Hand-score each of the 4 learnings using the spec §8.2 rubric, write the expected values into the fixture.
3. `test/p2-1a-score-learning.test.js` loads each `.json`, calls `scoreLearning`, and deep-equals against the `.expected.json`.

**Acceptance for A2:** 4 `.expected.json` files exist; T-111–T-114 pass.

### A3. Circuit breaker persistence across restart (GOV-3 N1 HARD STOP)

**Problem:** `server.js:3986-4032` stores `circuitBreaker.spendUsd` and `killSwitchActive` as plain in-process JS object fields. Process restart → both reset to zero. The "$100/day ceiling" is actually "$100 per uninterrupted process lifetime."

**Fix:**
1. Persist `{ date, spendUsd, killSwitchActive }` to `data/circuit-breaker.json` on every `recordSpend()` call.
2. Load the file on server boot; if `date` matches today, restore `spendUsd` and `killSwitchActive`.
3. If `killSwitchActive === true` on boot, the kill switch remains active until an admin sentinel reset (`data/.extract-kill-switch-reset`) is present — never auto-clear on restart.
4. Use atomic write (`fs.writeFileSync(tmp); fs.renameSync(tmp, final)`) to avoid partial writes on crash.

**Acceptance for A3:** kill `server.js`, restart, verify `spendUsd` restored from disk, verify kill-switch survives. Add test to `test/p2-1a-circuit-breaker.test.js`.

### A4. 256KB body cap is dead code behind 100KB global middleware (GOV-3 B2 HARD STOP)

**Problem:** `server.js:100-109` global middleware enforces `MAX_BODY_SIZE = 100 * 1024` before any route handler runs. The `EXTRACT_BODY_MAX = 262144` check at `server.js:4181` is unreachable. A 30,000-char transcript (~120KB) is rejected at 100KB with the wrong error.

**Fix:**
1. Modify the global middleware to skip `/extract`, OR
2. Raise the global cap with path-aware logic: `const cap = c.req.path === '/extract' ? 262144 : MAX_BODY_SIZE;`
3. Verify the route handler's own 256KB check at `server.js:4181` is now reachable and is the enforcer.
4. Add test: POST `/extract` with a 200KB valid transcript → expect pass (not 413). POST with a 300KB transcript → expect 413 from the route handler with the spec's error code.

**Acceptance for A4:** test in `test/p2-1a-extract-handler.test.js` proves a 200KB body reaches the handler and a 300KB body is rejected by the handler (not the global).

### A5. Runner is architecturally wrong (BUILD-1 HARD STOP — 4 items)

**Problem:** The server-side `/extract` pipeline is solid, but the client-side runner that drives it is broken in four load-bearing ways. Fix all four.

#### A5.1 — TranscriptSource interface contract

File: `scripts/sources/source.interface.js`

Current: only `discover()` and `fetch(sessionId)`.

Required per spec §4.1: `detect()`, `discoverSessions({since})`, `readSession(sessionRef)`, `registerSessionEndHook(cb)`.

**Fix:** rewrite the interface to match spec §4.1 exactly. Open `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md`, find §4.1, paste the interface shape verbatim into a code comment above the class, then implement each method. Every concrete source (`claude-code.js`, `openclaw.js`) must be updated to match.

#### A5.2 — Runner kill-switch + env guard

File: `scripts/runner.js`

Current: runner does not check `~/.auxilo/autonomous-enabled` sentinel or `AUXILO_EXTRACTING=1` env var. Kill-switch is decorative.

**Fix:** at the very top of `main()`, before any work:
1. `if (!fs.existsSync(path.join(os.homedir(), '.auxilo', 'autonomous-enabled'))) { log('kill-switch absent, exiting'); process.exit(0); }`
2. `if (process.env.AUXILO_EXTRACTING === '1') { log('recursion guard tripped, exiting'); process.exit(0); }`
3. `process.env.AUXILO_EXTRACTING = '1';` before spawning any child work.

#### A5.3 — Durable queue + ledger high-water mark

File: `scripts/runner.js`

Current: uses `.claude-code-processed.json` local dedup. No durable queue.

Required per spec §7.1/§7.4: write each qualifying candidate to `~/.auxilo/pending-learnings/NNN-slug.json` BEFORE POSTing to `/extract` or `/learn`. On success, delete the file. On failure, leave it. Ledger at `~/.auxilo/ledger.json` tracks high-water mark per source (last session id processed).

**Fix:** implement write-before-POST pattern; implement `flushPending()` pass that retries files in the queue; implement ledger read/write with per-source keys.

#### A5.4 — OpenClaw adapter walks wrong directory

File: `scripts/sources/openclaw.js:21`

Current: reads `data/openclaw/` inside the repo.

Required: `~/.openclaw/agents/*/sessions/*.jsonl` (the real OpenClaw runtime dir).

**Fix:** one-line path change + verification that the glob finds real sessions on your dev machine. If you cannot test against real data, leave a TODO comment and note it in the delivery report.

**Acceptance for A5:** all four items pass their respective tests in `test/p2-1a-runner.test.js` and `test/p2-1a-sources.test.js`.

### A6. Scheduled mode has no review surface (SPEC-3 HARD STOP)

**Problem:** `REVIEW_FILE = data/extraction-review.jsonl` is written on `server.js:4375` but no `/extract/review` endpoint exists. Builders who pick `scheduled` mode send transcripts into a data sink they can never read.

**Fix — choose one:**

**Option A (ship the surface):** add three endpoints under `/extract/review`:
- `GET /extract/review` — list pending review items for the authenticated account
- `POST /extract/review/:id/approve` — approve a pending candidate; triggers the publish path
- `POST /extract/review/:id/reject` — reject a pending candidate; removes from queue

**Option B (remove the mode):** delete `scheduled` from `validModes` at `server.js:4528`, remove references from spec §3.5, and remove the AGENT-LEARNING-GUIDE description. Add a line to PUNCH-LIST for "Scheduled mode review surface — P2.1b."

**Default choice:** Option B. Scheduled mode is not load-bearing for P2.1a's pilot-of-one launch. Do Option A only if you can test it end-to-end in the same session.

**Acceptance for A6:** either all three endpoints exist and are tested, or `scheduled` is removed from `validModes` and all references are cleaned up.

---

## Part B — FIX BEFORE DEPLOY (not hard stops, but must land this round)

### B1. `consent_version` hard assertion violations (GOV-2)

| Site | Current | Fix |
|---|---|---|
| `server.js:4389` | `consent_version: consentState.consent_version \|\| null` | Remove `\|\| null` fallback. Stamp `freshConsent.consent_version` (from the final-publish recheck), not `consentState` (from request start). |
| `server.js:4484-4501` retraction audit row | Missing `consent_version` field entirely | Add it. Read current consent state at retraction time and stamp. |
| `lib/extraction-audit-writer.js` `appendAuditRow` | Accepts rows where `consent_version` is falsy | Throw `Error('consent_version is required')` if `row.consent_version` is falsy. Hard assertion per spec §9.1. |

**Acceptance:** tests in `test/p2-1a-audit-chain.test.js` verify (1) publish row stamps fresh consent_version, (2) retraction row carries consent_version, (3) `appendAuditRow` rejects falsy consent_version.

### B2. Retraction window sunset cron (GOV-2)

**Problem:** `retraction_window_active` is set `true` at publish (`server.js` publish path) and `false` only at manual retraction. No mechanism flips it `false` at publish+7d. Field stays stale forever on unretracted learnings.

**Fix — choose one:**
- **Event-driven:** at publish time, schedule a one-shot timer (`setTimeout`) for publish+7d that flips the flag. Acceptable because pilot volume is low; risky on restart.
- **Cron/scheduled:** a daily job that scans learnings and flips any where `published_at + 7d < now`. Wire it into the existing scheduled infrastructure used for daily-digest (see B3).

**Default choice:** cron/scheduled, colocated with daily-digest.

**Acceptance:** test in `test/p2-1a-retraction.test.js` verifies the flag flips after 7 simulated days.

### B3. Daily digest is a stub (SPEC-3, GOV-2)

**Problem:** `jobs/daily-digest.js` is 69 lines of `console.log`. Not wired to a scheduler. No email transport. Not per-Builder. Missing titles, retraction deadlines, rejection reasons.

**Fix:**
1. Rewrite `jobs/daily-digest.js` to aggregate per-Builder, not across `unique_accounts`.
2. Each Builder's digest includes: published learning titles, retraction deadlines (publish+7d), rejected candidates with reasons, total earnings from autonomous extraction for the day.
3. Send via MailerSend (existing integration — do not add a new subprocessor). If MailerSend send fails, append to `~/.auxilo/extract.log` as the fallback per my prior directive (this is the "email fallback" you misread as stdout-only).
4. Wire to scheduler: `~/Library/LaunchAgents/tech.conway.auxilo-digest.plist` running at 07:00 daily. `plutil -lint` must pass. Do NOT `launchctl load` — leave loading for the deploy gate. *(2026-07-15: label renamed `io.auxilo.digest` — dead Conway host prefix purged; see PUNCH-LIST TD-CONWAY-1.)*

**Acceptance:** test in `test/p2-1a-runner.test.js` (or a new `test/p2-1a-digest.test.js`) mocks MailerSend and verifies per-Builder aggregation shape. `plutil -lint` on the plist passes.

### B4. Audit row `usage.input_tokens` / `output_tokens` hardcoded to 0 (BUILD-1)

File: `server.js:4399-4403`

**Fix:** the Anthropic API response includes `usage.input_tokens` and `usage.output_tokens`. Thread them from `lib/providers/anthropic.js` `extract()` return shape into the audit row. This is required for the cost-reconciliation path in `ops/extract-spend-report.js` to work.

**Acceptance:** integration test in `test/p2-1a-extract-handler.test.js` mocks the provider with a fixed usage payload and verifies the audit row contains matching non-zero values.

### B5. Delete `scripts/extract-learnings.js` (BUILD-1 / spec §12.3)

**Problem:** The file from the superseded P2.1 build still exists. Spec §12.3 says delete.

**Fix:** `git rm scripts/extract-learnings.js`. Update any stale references (grep for `extract-learnings.js` across the repo) to point at `scripts/runner.js`.

**Acceptance:** `grep -rn 'extract-learnings.js' .` returns zero hits.

### B6. Symlink protection on pending-learnings writes (GOV-3 H3)

File: `scripts/runner.js` where it writes `~/.auxilo/pending-learnings/NNN-slug.json`.

**Fix:** replace `fs.writeFile(path, ...)` with `fs.open(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)` then write+close. `O_EXCL` blocks pre-planted symlinks; `O_NOFOLLOW` blocks symlink-following; mode 0o600 matches umask intent.

**Acceptance:** test in `test/p2-1a-runner.test.js` pre-plants a symlink at a target path, runs the writer, expects failure (not clobber).

### B7. Audit log rotation + in-memory last-hash (GOV-3 H5)

File: `lib/extraction-audit-writer.js`

**Problem:** `readLastHash()` reads the entire file on every extract — O(n) read-per-write cliff. No rotation — unbounded growth.

**Fix:**
1. Cache `lastHash` in memory after first read; update on every append. Only re-read from disk on process start.
2. Time-based rollover: file becomes `audit-extractions.YYYY-MM.jsonl`. On rollover, the new file's first row's `prev_hash` is the last hash of the previous month — chain continues across files.
3. Add a `scripts/admin.js audit:verify` subcommand (GOV-3 N2) that walks all monthly files recomputing hashes and reports any break.

**Acceptance:** test in `test/p2-1a-audit-chain.test.js` verifies in-memory cache correctness, rollover chain continuation, and `audit:verify` detects a tampered row.

### B8. Kill-switch sentinel ownership check (GOV-3 H7)

File: `server.js:4035-4042` `checkKillSwitchReset()`

**Fix:** before deleting the sentinel and resetting the kill switch, stat the file and reject if group/world-writable:
```js
const st = fs.statSync(path);
if ((st.mode & 0o022) !== 0) {
  console.error('kill-switch-reset sentinel has unsafe permissions, ignoring');
  return false;
}
if (st.uid !== process.getuid()) {
  console.error('kill-switch-reset sentinel not owned by server uid, ignoring');
  return false;
}
```

**Acceptance:** test in `test/p2-1a-kill-switch.test.js` plants a world-writable sentinel, confirms reset is ignored.

### B9. `contributor_agent` string reconciliation (SPEC-2)

**Problem:** Spec says `auxilo-autonomous-extractor/<version>`. Handler at `server.js:4349` stamps `auxilo-extract/${SENSITIVITY_FILTER_VERSION}`.

**Fix:** pick one. Recommendation: align handler to spec (`auxilo-autonomous-extractor/0.1.0`). Update `server.js:4349`, update spec if you propose a different name. Bump to semver per SPEC-2 suggestion.

**Acceptance:** test in `test/p2-1a-extract-handler.test.js` asserts the stamped identifier matches the spec string exactly.

### B10. openapi.json `/extract` rewrite (SPEC-2)

File: `openapi.json` around line 1791.

**Fixes (all four):**
1. Declare `Idempotency-Key` header as `required: true` (currently optional in schema, mandatory in handler — contract lies).
2. Rewrite 200 response schema to match wire format: `learnings_found`, `rejections[]` (objects with `reason` and `title`), `audit_ref`, conditional `retraction_window_ends`, conditional `pending_review_ids`. Current schema lists `learnings_published/rejected/queued` which the handler never returns.
3. Add structured error schema with a `code` enum: `consent_required`, `disabled`, `ofac_blocked`, `sensitivity_fail`, `kill_switch`, `hard_throttle`, `invalid_body`, `body_too_large`, `sha_mismatch`, `idempotency_missing`, `provider_error`.
4. Document `mode_hint` request body field (handler accepts it at `server.js:4205`, openapi omits it).

**Acceptance:** regenerate openapi from handler via contract test in `test/p2-1a-extract-handler.test.js` — POST with missing idempotency key returns the declared 400 with matching code.

### B11. `.well-known/agent.json` is stale (SPEC-2)

**Fix:**
1. Bump `version` from 0.7.0 to reflect P2.1a landing.
2. Add `autonomous-extraction` capability string.
3. Add `/extract`, `/account/settings` (PATCH), `/learn/{id}` (DELETE with `reason=retract`) to endpoints array.
4. Correct price ceiling: stale file says "min $0.05, max $50.00." The current ceiling is $1.00 — fix to match `lib/pricing.js`.
5. Reference `/legal/subprocessors` and `/legal/supported-clients` in the capabilities metadata.

**Acceptance:** `curl auxilo.io/.well-known/agent.json | jq .` shows the new version and capability. A contract test in `test/p2-1a-agent-json.test.js` (new) verifies all four.

### B12. `AGENT-LEARNING-GUIDE.md §3` additions (SPEC-2, GOV-1)

**Fixes:**
1. Name the kill-switch sentinel file: `~/.auxilo/autonomous-enabled`. Include the path and a one-line explanation.
2. Describe the 2-surface architecture: "Automatic mode is driven by two surfaces — a SessionEnd hook (`scripts/hooks/auxilo-extract.sh`) that fires immediately at transcript close, and a daily sweeper (`scripts/runner.js --sweep`) that catches anything the hook missed."
3. Add an `/extract` request/response example showing the exact wire shape (Idempotency-Key header included).
4. Add an Idempotency-Key construction paragraph: format, 24h TTL, per-account scope, retry-safety.
5. Add a revocation example showing `PATCH /account/settings` with `mode: "off"`.

**Acceptance:** grep `AGENT-LEARNING-GUIDE.md` for `autonomous-enabled`, `auxilo-extract.sh`, `runner.js --sweep`, `Idempotency-Key`, `mode: "off"` — all five must hit.

### B13. ONBOARDING-COPY.md additions (SPEC-3, GOV-1)

**Fix:** add an "Enable Autonomous Extraction" section covering the full activation flow:
1. Purchase/link account, get API key.
2. Install the hook: `node scripts/runner.js --install-hooks`.
3. Activate the sentinel: `touch ~/.auxilo/autonomous-enabled`.
4. Set mode: `curl -X PATCH /account/settings -d '{"extraction_mode":"automatic"}'`.
5. Verify: `node scripts/runner.js --status`.

**Acceptance:** `ONBOARDING-COPY.md` contains a section with heading "Enable Autonomous Extraction" and the 5 steps above.

### B14. `runner.js --status` subcommand (SPEC-3)

File: `scripts/runner.js`

**Fix:** add a `--status` flag that prints:
- Kill-switch sentinel present: yes/no (path checked)
- AUXILO_EXTRACTING env var: value
- Account mode (from `GET /account/settings`): off/automatic/scheduled/manual
- Hook install state: installed at `~/.claude/settings.json` yes/no
- Last sweep ran at: timestamp from ledger
- Pending queue size: count of files in `~/.auxilo/pending-learnings/`

**Acceptance:** test in `test/p2-1a-runner.test.js` invokes `--status`, captures stdout, asserts the 6 fields appear.

### B15. `installHooks()` safety (SPEC-3)

File: `scripts/runner.js` `installHooks()` function, around lines 59-107.

**Fixes:**
1. If `~/.claude/settings.json` exists and is malformed JSON, fail loudly (`throw new Error`) — do NOT catch-and-overwrite with a fresh `{hooks:{...}}` object. Losing the user's other settings silently is a destructive bug.
2. If the destination hook file `~/.claude/hooks/auxilo-extract.sh` already exists, back it up to `auxilo-extract.sh.bak.<timestamp>` before `copyFileSync`.

**Acceptance:** test in `test/p2-1a-runner.test.js` plants a malformed settings.json, invokes `--install-hooks`, expects throw (not silent overwrite).

### B16. openapi.json `/extract/review/*` (GOV-1) — conditional on A6 choice

If A6 chose **Option A** (ship the surface): add `/extract/review` GET, `/extract/review/{id}/approve` POST, `/extract/review/{id}/reject` POST to openapi.json.

If A6 chose **Option B** (remove the mode): no openapi change needed; add a PUNCH-LIST entry for P2.1b.

### B17. PUNCH-LIST entries (GOV-1)

File: `PUNCH-LIST.md`

Add two line items under the P2.1a section:
1. **Legacy 4-learning manual flush** — after P2.1a deploy, Tyler runs `node scripts/runner.js --flush-pending` against the 4 learnings currently in `~/.auxilo/pending-learnings/` (mailersend, cloudflare-email-routing, cloudflare-pages, private-email-stack). They predate the autonomous system and need manual bless before publish.
2. **FOUNDATION.md prerequisite** — P2.1a launch depends on the governance framework in FOUNDATION.md (not yet created). Cross-reference the P0 governance track.

### B18. Old spec banner (GOV-1)

File: `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md`

**Fix:** verify the top-of-file banner marking it superseded by P2.1a is present. If missing, add: `> **⛔ SUPERSEDED** by [BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md](./BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md). Retained for history only.`

### B19. Consent log HMAC OR chain integration (GOV-3 N3)

File: `lib/extraction-consent-reader.js`

**Problem:** `extraction-consent.jsonl` is append-only by convention but has no tamper-detection. Same-user compromise (server process hijack) can rewrite rows to fake a grant.

**Fix — choose one:**
- **HMAC:** sign each row with a server-held secret (from env var `CONSENT_HMAC_KEY`). Verifier checks signature on read.
- **Chain integration:** write consent rows into the same hash-chained audit log as extractions, with `action: "consent_grant" | "consent_revoke"`.

**Default choice:** chain integration (simpler, one audit surface). Requires updating `appendAuditRow` to accept consent rows.

**Acceptance:** test in `test/p2-1a-audit-chain.test.js` verifies consent grant/revoke appears in the chain and tampering is detected.

### B20. `client_scrub_report.patterns_matched` validation (GOV-3 N5)

File: `server.js:4395`

**Problem:** attacker-controlled strings written into hash-chained audit log without validation.

**Fix:** before writing to audit row, validate `patterns_matched` is an array of strings, length ≤50, each string ≤64 chars matching `/^[a-z_]+$/`. Drop invalid entries with a log line.

**Acceptance:** test in `test/p2-1a-extract-handler.test.js` sends hostile values, verifies they're filtered or request is rejected.

---

## Part C — Items explicitly deferred to P2.1b (do NOT fix this round)

Document these in PUNCH-LIST but do NOT implement:
- `server.js:1501` inline Anthropic fetch in openclaw daemon (BUILD-1 yellow) — cleanup to provider seam
- `server.js:6154` inline Anthropic fetch in /chat-import path (BUILD-1 yellow) — cleanup to provider seam
- Scheduled mode review surface (if A6 chose Option B)
- `/account/earnings` distinguishing `published_via=autonomous_extraction` (SPEC-3 yellow) — dashboard enhancement
- `public/for-builders.html:785` mode disclosure (SPEC-3 yellow) — marketing copy update, not a correctness issue
- URL versioning (`/v1/extract`) — breaking change, needs its own spec

---

## Delivery Report Contract (reminder — read AGENTS.md)

Your delivery report MUST be a table with one row per item A1–A6 and B1–B20. Columns:

| Item | Files modified | Verification command | Result |
|---|---|---|---|

Example row that would be accepted:
| A1 (test files) | `test/p2-1a-extract-handler.test.js` (new, 342 lines), `test/p2-1a-consent.test.js` (new, 198 lines), ... | `node --test test/p2-1a-extract-handler.test.js` → 14 pass; `node --test test/p2-1a-consent.test.js` → 12 pass; [...] aggregate 114 pass across 12 files | ✅ |

Example row that would be REJECTED:
| A1 (test files) | Various test files | `node --test test/*.test.js` → 114 pass | ✅ |

(The second row is what last round did. It's the failure mode AGENTS.md now explicitly bans.)

---

## Out of scope for this rework

- Do NOT modify `lib/earnings.js`.
- Do NOT modify `server.js:732` (the `pending_balance +=` line).
- Do NOT add new subprocessors beyond Anthropic (MailerSend already exists; using it for B3 digest is not a new subprocessor).
- Do NOT decide architecture. If an item is ambiguous, return the question.

## When you finish

1. Run the full test suite by name: `node --test test/p2-1a-*.test.js`. Paste the output into your delivery report.
2. Fill out the delivery report table with file:line citations per row.
3. Do NOT claim "ready for review" unless every A-item and B-item has a row marked ✅ or ❌-with-reason.
4. If you hit an ambiguity, stop and return the question. Do not improvise.
