# TEST-P2.1a — Autonomous Learning Extraction Test Suite

**Author:** BUILD-4 (QA)
**Spec under test:** `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md`
**Created:** 2026-04-14
**Status:** Authored pre-implementation. Antigravity runs this against delivered code. Gate A uses green-signal from this suite to sign off on merge. T-109 is the Tyler-pilot acceptance test and is the final gating check before any non-Tyler Builder is allowed onto the feature.

---

## 0. Test matrix overview

### 0.1 How the suite is organized

| Category | Range | Count | Purpose |
|---|---|---|---|
| Unit | T-001 – T-030 | 30 | Per-module correctness for new or modified code |
| Integration | T-031 – T-050 | 20 | `/extract` happy paths, mode branching, idempotency, retraction, consent, audit chain |
| Security | T-051 – T-072 | 22 | GOV-3 blockers B1–B4 and HIGH #1–#7 reproduced as adversarial cases |
| Rate limit | T-073 – T-082 | 10 | Per-account tiers + global `$-breaker` |
| Failure | T-083 – T-092 | 10 | Provider/network/crash resilience |
| Compliance / promise | T-093 – T-104 | 12 | One test per user-facing ToS/PP/spec promise |
| End-to-end (Tyler pilot) | T-105 – T-110 | 6 | Full pilot-of-one acceptance — load-bearing |
| Regression corpus | T-111 – T-114 | 4 | Legacy learning extraction quality baseline, permanent |
| **Total** | — | **114** | — |

### 0.2 How to run it

```bash
# Unit + integration + security + rate-limit + failure + compliance
npm test -- --runInBand tests/p2-1a/

# Regression corpus (locked 14/20 quality gate — can only ratchet up, never down)
node tests/p2-1a/regression/run-corpus.js

# Tyler-pilot e2e — manual, single operator, destructive to Tyler's account state
node tests/p2-1a/e2e/pilot.js --operator tyler --confirm
```

### 0.3 What "green" means (merge gate)

- 100% of unit, integration, security, rate-limit, failure, and compliance tests pass.
- 4/4 regression corpus learnings score >=14/20 with no dimension <3 (§5.1.3, spec §16).
- The Tyler-pilot e2e sequence (T-109) completes end-to-end with every observation satisfied.
- No test below is skipped without a written Architect waiver.

### 0.4 Test case format

```
### T-XXX: [name]
**Category:** unit | integration | security | rate-limit | failure | compliance | e2e | regression
**Spec reference:** §X.Y
**Resolves:** GOV-3 B#, GOV-3 HIGH #, BUILD-1 §, CFO-1 §, as applicable
**Setup:** starting state
**Action:** what the test does
**Expected:** pass criteria
**Fail signal:** what "broken" looks like
**Automation:** jest | curl | manual | cron-driven
```

---

## 1. Unit tests

### T-001: `lib/providers/anthropic.js` exports provider interface shape
**Category:** unit
**Spec reference:** §6.1, §6.2
**Resolves:** BUILD-1 provider seam
**Setup:** Fresh `require('lib/providers/anthropic')`.
**Action:** Inspect exported class for `static id === "anthropic"`, `static defaultModel`, and instance methods `extract()` and `getQuotaState()`.
**Expected:** All four present; `defaultModel` matches `model_config.json:extraction.primary.model`.
**Fail signal:** Missing method, wrong id, or hard-coded model divergent from config.
**Automation:** jest

### T-002: Anthropic provider — happy path returns `{text, usage, model}`
**Category:** unit
**Spec reference:** §6.1
**Setup:** Mock `fetch` to return a canned 200 Anthropic messages response with 8041 input / 1232 output tokens.
**Action:** `await provider.extract({prompt: "hello", maxTokens: 2048, signal: AbortSignal.timeout(45000)})`.
**Expected:** Returned object has `text` (string, non-empty), `usage.input_tokens === 8041`, `usage.output_tokens === 1232`, `model === "claude-sonnet-4-5-20250929"`.
**Fail signal:** Shape mismatch or unit drift in usage numbers.
**Automation:** jest

### T-003: Anthropic provider — 429 raises `ProviderRateLimitError` with header delay
**Category:** unit
**Spec reference:** §6.2, §6.4
**Setup:** Mock `fetch` to return 429 with `retry-after: 12` header.
**Action:** Call `extract()`.
**Expected:** Throws `ProviderRateLimitError` with `retryAfterMs === 12000`.
**Fail signal:** Wrong class, missing `retryAfterMs`, or silent retry inside provider (retry belongs to caller).
**Automation:** jest

### T-004: Anthropic provider — 429 without `retry-after` header defaults to 15s × attempt
**Category:** unit
**Spec reference:** §6.4
**Setup:** Mock 429 with no `retry-after`.
**Action:** Caller retries up to 3; inspect sleeps.
**Expected:** Sleeps 15_000, 30_000, 45_000ms between attempts.
**Fail signal:** Any other backoff schedule.
**Automation:** jest

### T-005: Anthropic provider — 500/502/503 raises `ProviderUnavailableError`
**Category:** unit
**Spec reference:** §6.2
**Setup:** Mock each of 500, 502, 503.
**Action:** `extract()`.
**Expected:** Each throws `ProviderUnavailableError`; caller backoff schedule 1s/4s/15s.
**Fail signal:** Wrong error class or wrong backoff.
**Automation:** jest

### T-006: Anthropic provider — 401/403 raises `ProviderAuthError`, no retry
**Category:** unit
**Spec reference:** §6.2, §6.4
**Setup:** Mock 401 response.
**Action:** `extract()`.
**Expected:** Throws `ProviderAuthError` exactly once; caller pages ops and does not retry (§6.4).
**Fail signal:** Retry attempted or wrong error class.
**Automation:** jest

### T-007: Anthropic provider — 404 on versioned model falls back to alias
**Category:** unit
**Spec reference:** §6.2
**Setup:** Mock 404 with body containing model name `claude-sonnet-4-5-20250929`.
**Action:** `extract()` with primary model.
**Expected:** Provider retries once against `claude-sonnet-4-5` (alias) before raising.
**Fail signal:** No fallback attempted; raises without retry.
**Automation:** jest

### T-008: Anthropic provider — timeout honors `signal.abort()` at 45s
**Category:** unit
**Spec reference:** §6.2
**Setup:** Mock `fetch` to hang 60s.
**Action:** `extract()` with a 45s `AbortController`.
**Expected:** Call aborts at ~45s, `AbortError` surfaces.
**Fail signal:** Call runs past 45s or swallows AbortError.
**Automation:** jest

### T-009: `getQuotaState()` reports tokens-used-this-UTC-minute
**Category:** unit
**Spec reference:** §6.2, §6.5
**Setup:** Simulate 3 successful calls totaling 9000 input tokens inside one minute.
**Action:** `provider.getQuotaState()`.
**Expected:** `tokens_used_this_minute === 9000`; `tokens_remaining_this_minute === 1000` at 10k org cap.
**Fail signal:** Wrong math or counter not resetting on minute boundary.
**Automation:** jest

### T-010: `getQuotaState()` resets on UTC-minute rollover
**Category:** unit
**Spec reference:** §6.2
**Setup:** Clock-mock into second 59 of minute N with 9000 tokens used; advance 2 seconds.
**Action:** `getQuotaState()`.
**Expected:** `tokens_used_this_minute === 0`.
**Fail signal:** Counter carries into minute N+1.
**Automation:** jest

### T-011: `sanitizeLearningBody()` strips raw HTML tags
**Category:** unit
**Spec reference:** §5.1.6
**Resolves:** GOV-3 HIGH #6
**Setup:** Learning body `"Use <script>alert('x')</script> before the call"`.
**Action:** `sanitizeLearningBody(body)`.
**Expected:** Output contains no `<` or `>`; text preserved around tags.
**Fail signal:** Any HTML element survives.
**Automation:** jest

### T-012: `sanitizeLearningBody()` converts non-allowlisted URLs to plain text
**Category:** unit
**Spec reference:** §5.1.6
**Resolves:** GOV-3 HIGH #6
**Setup:** Body with `[click](https://evil.example.com/x)` and `[docs](https://docs.anthropic.com/x)`.
**Action:** `sanitizeLearningBody(body)`.
**Expected:** `docs.anthropic.com` link preserved; `evil.example.com` converted to plain text (no markdown link syntax).
**Fail signal:** Non-allowlisted URL remains clickable.
**Automation:** jest

### T-013: `sanitizeLearningBody()` strips markdown image syntax entirely
**Category:** unit
**Spec reference:** §5.1.6
**Resolves:** GOV-3 HIGH #6 (tracker pixel)
**Setup:** Body containing `![tracker](https://pixel.example/1x1.gif)`.
**Action:** Sanitize.
**Expected:** No `![...](...)` survives and no URL survives.
**Fail signal:** Image markdown or URL remains.
**Automation:** jest

### T-014: `sanitizeLearningBody()` rejects base64 blobs >200 chars
**Category:** unit
**Spec reference:** §5.1.6
**Setup:** Body containing a 240-char base64 blob.
**Action:** Sanitize.
**Expected:** Returns rejection (or throws `LearningBodyRejected`) with reason `base64_blob`.
**Fail signal:** Blob passes through unchanged.
**Automation:** jest

### T-015: `sanitizeLearningBody()` allowlist covers documented vendor domains
**Category:** unit
**Spec reference:** §5.1.6
**Setup:** Body with links to `docs.anthropic.com`, `github.com/x/y`, `stackoverflow.com/q/1`, `aws.amazon.com/docs`, `cloud.google.com/docs`.
**Action:** Sanitize.
**Expected:** All 5 links preserved as real markdown links.
**Fail signal:** Any vendor doc link demoted.
**Automation:** jest

### T-016: `scanText()` detects all 14 pre-existing sensitivity patterns
**Category:** unit
**Spec reference:** §7.5
**Setup:** Text fixture with one match per existing pattern (`lib/sensitivity-filter.js:21-103`).
**Action:** `scanText(fixture)`.
**Expected:** `matches.length === 14`, each matched pattern name returned, no raw values in returned object (redaction hints only).
**Fail signal:** Any miss; any raw secret returned in `matches[].value`.
**Automation:** jest

### T-017: `scanText()` detects new email pattern (non-allowlisted domain)
**Category:** unit
**Spec reference:** §7.6 (#1)
**Resolves:** GOV-3 HIGH #2
**Setup:** Text containing `alice@competitor.example`.
**Action:** `scanText()`.
**Expected:** `matches` includes `email`.
**Fail signal:** Email passes.
**Automation:** jest

### T-018: `scanText()` detects E.164 and US phone formats
**Category:** unit
**Spec reference:** §7.6 (#2)
**Setup:** Text containing `+14165551234` and `(416) 555-1234`.
**Action:** `scanText()`.
**Expected:** Both detected.
**Fail signal:** Either format slips.
**Automation:** jest

### T-019: `scanText()` detects `Cookie:` / `Set-Cookie:` / `Authorization:` headers (case-insensitive)
**Category:** unit
**Spec reference:** §7.6 (#3, #4)
**Setup:** Three lines, one each, mixed case (`COOKIE:`, `set-cookie:`, `AuThOrIzAtIoN: Bearer xyz`).
**Action:** `scanText()`.
**Expected:** All three detected.
**Fail signal:** Case-sensitive miss.
**Automation:** jest

### T-020: `scanText()` detects GCP service-account JSON
**Category:** unit
**Spec reference:** §7.6 (#5)
**Setup:** Fixture containing `"type": "service_account"`.
**Action:** `scanText()`.
**Expected:** `gcp_service_account` match.
**Fail signal:** Miss.
**Automation:** jest

### T-021: `scanText()` detects Azure SAS `sig=...`
**Category:** unit
**Spec reference:** §7.6 (#6)
**Setup:** Fixture containing `sig=aBcD1234567890aBcD1234567890aB%3D`.
**Action:** `scanText()`.
**Expected:** `azure_sas` match.
**Fail signal:** Miss or URL-encoded bypass.
**Automation:** jest

### T-022: `scanText()` detects GitHub fine-grained PAT
**Category:** unit
**Spec reference:** §7.6 (#7)
**Setup:** Fixture `github_pat_` + 82 random chars.
**Action:** `scanText()`.
**Expected:** `github_pat` match.
**Fail signal:** Miss.
**Automation:** jest

### T-023: `scanText()` detects OpenAI project key `sk-proj-...`
**Category:** unit
**Spec reference:** §7.6 (#8)
**Setup:** Fixture `sk-proj-` + 24 chars.
**Action:** `scanText()`.
**Expected:** `openai_proj_key` match.
**Fail signal:** Miss.
**Automation:** jest

### T-024: `scanText()` detects Anthropic key `sk-ant-...`
**Category:** unit
**Spec reference:** §7.6 (#9)
**Setup:** Fixture `sk-ant-api03-abcDEF_-123456789012345678`.
**Action:** `scanText()`.
**Expected:** `anthropic_key` match.
**Fail signal:** Miss — this is a reputational nuke.
**Automation:** jest

### T-025: `scanText()` detects Discord bot token
**Category:** unit
**Spec reference:** §7.6 (#10)
**Setup:** Discord token fixture.
**Action:** `scanText()`.
**Expected:** `discord_bot_token` match.
**Fail signal:** Miss.
**Automation:** jest

### T-026: `scanText()` normalization: URL-decoded token window matches regex
**Category:** unit
**Spec reference:** §7.6 (normalization pass)
**Setup:** Fixture containing `sk-ant-api03-%61%62%63` (URL-encoded characters inside a likely token window).
**Action:** `scanText()`.
**Expected:** Normalization pass decodes, regex matches `anthropic_key`.
**Fail signal:** Bypass via URL encoding.
**Automation:** jest

### T-027: `SENSITIVITY_FILTER_VERSION` bumps on pattern set changes
**Category:** unit
**Spec reference:** §7.6
**Setup:** Snapshot test locking the current `SENSITIVITY_FILTER_VERSION` constant.
**Action:** Snapshot check + assertion that version is semver and >= `0.3.1`.
**Expected:** Version present and stable across test run; any pattern-list edit must bump it.
**Fail signal:** Missing constant or stale version after pattern edit.
**Automation:** jest

### T-028: Claude Code adapter `detect()` returns true only when `~/.claude/projects` + settings.json readable
**Category:** unit
**Spec reference:** §4.2
**Setup:** Three cases — (a) both exist, (b) only projects exists, (c) neither.
**Action:** `detect()`.
**Expected:** true / false / false.
**Fail signal:** Any other combination.
**Automation:** jest + tmp fs

### T-029: Claude Code adapter `discoverSessions({since})` filters by mtime
**Category:** unit
**Spec reference:** §4.2
**Setup:** Three `.jsonl` fixtures with mtimes old/recent/future.
**Action:** `discoverSessions({since: now - 1h})`.
**Expected:** Only recent and future returned.
**Fail signal:** Old session included or recent excluded.
**Automation:** jest

### T-030: OpenClaw adapter `discoverSessions()` walks `sessions.json` index, skips first line of JSONL
**Category:** unit
**Spec reference:** §4.3
**Setup:** Tmp `~/.openclaw/agents/agentA/sessions/` with `sessions.json` + one `s1.jsonl` whose first line is metadata, next 3 lines are messages.
**Action:** `discoverSessions({since: 0})` then `readSession()`.
**Expected:** Returns the 3 message lines as `ROLE: text` blocks; metadata line excluded.
**Fail signal:** Metadata leaked into transcript or messages lost.
**Automation:** jest

---

## 2. Integration tests

### T-031: `/extract` happy path — automatic mode — end-to-end
**Category:** integration
**Spec reference:** §3.1, §3.2, §5.1, §5.1.8
**Setup:** Test account with consent grant, mode=automatic, verified tier, mock provider returning 2 valid + 1 sub-threshold learnings.
**Action:** `POST /extract` with valid body.
**Expected:** 200 with `learnings_found=3`, `learnings_published=2`, `learnings_rejected=1`, `audit_ref` and `retraction_window_ends` set (= publish_ts + 7d); catalog contains both new learnings with `retraction_window_active=true`.
**Fail signal:** Any published count mismatch or missing audit_ref.
**Automation:** jest + supertest

### T-032: `/extract` happy path — scheduled mode — parks for review
**Category:** integration
**Spec reference:** §3.3, §5.1.8
**Setup:** Account with mode=scheduled, 2 qualifying learnings extracted by mock provider.
**Action:** `POST /extract` with `mode_hint="scheduled"` (advisory).
**Expected:** 200 with `pending_review_ids[]` of length 2 and `learnings_published` absent; `data/extraction-review.jsonl` gains 2 rows keyed by account_id; **catalog unchanged**.
**Fail signal:** Anything hits `/learn` write path.
**Automation:** jest + supertest

### T-033: `/extract` happy path — manual mode — parks for review
**Category:** integration
**Spec reference:** §3.3, §5.1.8
**Setup:** Account with mode=manual.
**Action:** `POST /extract`.
**Expected:** Same as T-032.
**Fail signal:** Same as T-032.
**Automation:** jest + supertest

### T-034: Mode trust — server ignores `mode_hint` in body, uses account record
**Category:** integration
**Spec reference:** §5.1.8
**Setup:** Account record `autonomous_extraction_mode="scheduled"`; request body `mode_hint="automatic"`.
**Action:** POST.
**Expected:** Behaves as scheduled — parks for review, does not publish.
**Fail signal:** Body override wins.
**Automation:** jest

### T-035: Consent log append-only on grant
**Category:** integration
**Spec reference:** §3.5.3
**Setup:** New account, no consent record.
**Action:** `POST /account/consent/grant`; inspect `data/extraction-consent.jsonl`.
**Expected:** One new row with `action="grant"`, `consent_version="2026-04-14"`, redacted IP (`1.2.*.*` form), user-agent, account_id, ISO timestamp. Previous lines untouched.
**Fail signal:** Row missing, IP not redacted, or rewrite (non-append).
**Automation:** jest

### T-036: Consent log append-only on revoke
**Category:** integration
**Spec reference:** §3.5.3, §3.5.4
**Setup:** Account with active grant.
**Action:** `POST /account/consent/revoke`.
**Expected:** New row `action="revoke"`; previous grant row untouched. Subsequent `/extract` returns `403 consent_required`.
**Fail signal:** Grant row modified, or subsequent extract proceeds.
**Automation:** jest

### T-037: Consent log — "most recent per account" resolution
**Category:** integration
**Spec reference:** §3.5.3
**Setup:** Rows: grant (t0), revoke (t1), grant (t2).
**Action:** `/extract` at t3.
**Expected:** Proceeds (most-recent=grant).
**Fail signal:** Uses first row or count-based logic.
**Automation:** jest

### T-038: Audit log hash chain — 100 consecutive entries
**Category:** integration
**Spec reference:** §9.1, spec §16 audit checklist
**Setup:** Run 100 extractions back-to-back against test server.
**Action:** Read `data/audit-extractions.jsonl`; verify for each row `entry_hash === sha256(prev_hash + canonical(row-without-entry_hash))` and `row[i].prev_hash === row[i-1].entry_hash`.
**Expected:** Chain intact, no gap.
**Fail signal:** Any broken link.
**Automation:** jest

### T-039: Audit log — contains no raw transcript, body, or matched values
**Category:** integration
**Spec reference:** §9.1, spec §16
**Setup:** Extraction that triggers scrubber match (e.g., `sk-ant-...`) and publishes 1 learning.
**Action:** Grep audit row for transcript substrings, learning body substrings, and the raw secret value.
**Expected:** No match. Only `transcript_sha256`, `transcript_length`, pattern NAMES, and `published_learning_ids`.
**Fail signal:** Any raw value present.
**Automation:** jest

### T-039a: Audit row includes `consent_version` on all success paths
**Category:** integration
**Spec reference:** §3.5 step 3, §9.1
**Setup:** Perform a successful extraction that publishes at least one learning against an account with an active consent grant row.
**Action:** Read the latest audit row from `data/audit-extractions.jsonl` (JSONL tail-read).
**Expected:** Row contains field `consent_version` of type string, non-null, matching ISO date format `YYYY-MM-DD`, equal to the currently-active consent grant's version for that account.
**Fail signal:** Field missing, null, or mismatched against the active consent row.
**Automation:** jest (JSONL tail-read + schema assertion)

### T-040: Idempotency-Key dedup — same key within 24h returns cached response
**Category:** integration
**Spec reference:** §3.7
**Setup:** Successful `/extract` call at t0 with key `uuid-1`.
**Action:** Repeat identical POST at t0+5min with same `Idempotency-Key`.
**Expected:** Same response body (same `extraction_id`); provider mock invocation count = 1.
**Fail signal:** Second LLM call fired.
**Automation:** jest

### T-041: Idempotency-Key TTL — same key after 24h is fresh
**Category:** integration
**Spec reference:** §3.7
**Setup:** Call at t0 with key `uuid-1`; clock-advance 24h + 1min.
**Action:** Repeat.
**Expected:** New `extraction_id`, provider invoked again.
**Fail signal:** Cache hit past TTL.
**Automation:** jest (clock-mocked)

### T-042: Content-hash dedup — identical transcript, missing Idempotency-Key
**Category:** integration
**Spec reference:** §3.7
**Setup:** Call at t0 with `(account_id, session_id, transcript_sha256)=X`; cache it.
**Action:** Call again with different `Idempotency-Key` but same tuple.
**Expected:** Cached response returned, provider not re-invoked.
**Fail signal:** Second LLM bill.
**Automation:** jest

### T-043: Content-hash dedup — per-account scope (Q2)
**Category:** integration
**Spec reference:** §3.7, §13 Q2 (RESOLVED)
**Note:** Authoritative per BUILD-1 resolution of §13 Q2 (2026-04-14): idempotency scope is per-account to prevent attribution oracle and preserve earnings on legitimate shared-machine collisions.
**Setup:** Account A and B both upload the same transcript_sha256.
**Action:** Both call `/extract`.
**Expected:** Both pay for extraction (scope is per-account). Document behavior explicitly in test assertions.
**Fail signal:** Cross-account collapse (would silently underbill B and leak attribution).
**Automation:** jest

### T-044: Provider fallback — primary 5xx ×3 falls through to secondary
**Category:** integration
**Spec reference:** §6.3, §6.4
**Setup:** Mock primary model to fail 500×3; secondary model `claude-sonnet-4-5` succeeds.
**Action:** POST `/extract`.
**Expected:** 200, `audit.model === "claude-sonnet-4-5"`, fallback attempted once.
**Fail signal:** 502 or no fallback attempt.
**Automation:** jest

### T-045: Provider exhaustion — all fallbacks fail → 502 with extraction_id
**Category:** integration
**Spec reference:** §6.4
**Setup:** All providers mocked to 500.
**Action:** POST `/extract`.
**Expected:** 502 with body `{error, extraction_id}`; client can retry via idempotency key later.
**Fail signal:** 500 or missing `extraction_id`.
**Automation:** jest

### T-046: Retraction within 7 days removes from catalog, earnings untouched
**Category:** integration
**Spec reference:** §5.2, §11.2(c)
**Setup:** Learning published at t0, 1 unlock completed (earnings recorded in `lib/earnings.js`).
**Action:** `DELETE /learn/:id?reason=retract` at t0+3d.
**Expected:** (a) learning absent from `GET /catalog`, `/search`, `/discover`; (b) `total_contributor`, `total_platform`, `pending_balance` unchanged vs. snapshot; (c) audit row `action="retract"`.
**Fail signal:** Any earnings field changed or catalog still returns the learning.
**Automation:** jest

### T-047: Retraction after 7 days — 409 / fall-through to takedown
**Category:** integration
**Spec reference:** §5.2, §11.2(b)
**Setup:** Learning published at t0, retraction_window closed by sweeper at t0+7d.
**Action:** `DELETE /learn/:id?reason=retract` at t0+8d.
**Expected:** 409 response referencing standard DMCA/takedown path.
**Fail signal:** Silent removal or 200.
**Automation:** jest

### T-048: Retraction request from wrong account — 403
**Category:** integration
**Spec reference:** §5.2
**Setup:** Learning owned by account A.
**Action:** Account B calls `DELETE /learn/:id`.
**Expected:** 403; learning untouched.
**Fail signal:** Cross-account delete.
**Automation:** jest

### T-049: Retraction sweeper flips `retraction_window_active=false` at day 7
**Category:** integration
**Spec reference:** §9.3
**Setup:** 3 learnings published at t0 (active), t0-8d (overdue), t0-6d (still in window).
**Action:** Run `jobs/daily-digest.js` (sweeper section) at t0.
**Expected:** Only the t0-8d learning flips to inactive; audit row `window_closed`; earnings and unlocks not touched.
**Fail signal:** Any other row flipped, or earnings touched.
**Automation:** jest + clock-mock

### T-050: `publishLearnings()` integration — reuses `/learn` write path (server.js:3566)
**Category:** integration
**Spec reference:** §5.1.8
**Setup:** Automatic-mode extraction with 1 valid learning.
**Action:** POST `/extract`; inspect `/learn` write-path invocation.
**Expected:** `/learn` write path at `server.js:3566-3900` is called exactly once per candidate; earnings write at `server.js:725` fires unchanged.
**Fail signal:** Bypass or duplicate earnings write.
**Automation:** jest w/ spy

---

## 3. Security tests (GOV-3 BLOCKERS + HIGHs reproduced)

### T-051: B1 — `/extract` without X-API-Key → 401
**Category:** security
**Spec reference:** §3.5, spec §16
**Resolves:** GOV-3 BLOCKER B1
**Setup:** Valid body, no header.
**Action:** POST.
**Expected:** 401; no audit row; no provider call.
**Fail signal:** Any response other than 401 or any side effect.
**Automation:** jest + supertest

### T-052: B1 — `/extract` with valid key but no consent → 403 consent_required
**Category:** security
**Spec reference:** §3.5.3
**Resolves:** GOV-3 BLOCKER B1
**Setup:** Account with no consent row.
**Action:** POST.
**Expected:** 403 with body `{error:"consent_required", opt_in_url:...}`.
**Fail signal:** 200 or 401.
**Automation:** jest

### T-053: B1 — mode=off → 403 disabled
**Category:** security
**Spec reference:** §3.5.4
**Resolves:** GOV-3 BLOCKER B1, GOV-2 HIGH #1
**Setup:** Account with consent but `autonomous_extraction_mode="off"`.
**Action:** POST.
**Expected:** 403 `disabled`.
**Fail signal:** 200.
**Automation:** jest

### T-054: B1 — `contributor_wallet` in body is ignored
**Category:** security
**Spec reference:** §3.4, spec §16
**Resolves:** BUILD-1 impersonation hole
**Setup:** Account A key; body includes `contributor_wallet: <B's wallet>`.
**Action:** POST.
**Expected:** Learning persisted with A's wallet; B never credited; assertion on any log/DB row.
**Fail signal:** B's wallet appears anywhere.
**Automation:** jest

### T-055: B1 — `disabled_at` account rejected (matches /learn guard at server.js:~3660)
**Category:** security
**Spec reference:** §3.5.5
**Setup:** Account with `disabled_at` set.
**Action:** POST.
**Expected:** 403, no LLM call, no audit append.
**Fail signal:** Suspended account bypasses.
**Automation:** jest

### T-056: B2 — body >256KB via Content-Length → 413
**Category:** security
**Spec reference:** §3.4
**Resolves:** GOV-3 BLOCKER B2
**Setup:** 300KB JSON body, honest Content-Length header.
**Action:** POST.
**Expected:** 413 from middleware before handler runs; zero audit rows.
**Fail signal:** Handler entered.
**Automation:** curl + jest assertion

### T-057: B2 — body >256KB via `Transfer-Encoding: chunked` → 413
**Category:** security
**Spec reference:** §3.4
**Resolves:** GOV-3 BLOCKER B2
**Setup:** Chunked-encoded body with no Content-Length, cumulative bytes > 256KB.
**Action:** POST.
**Expected:** Handler's streaming byte counter aborts at 256KB with 413; partial request not processed.
**Fail signal:** Full body buffered, handler enters.
**Automation:** curl (raw socket) + server log assertion

### T-058: B2 — JSON nested >10 levels → 400
**Category:** security
**Spec reference:** §3.4
**Resolves:** GOV-3 BLOCKER B2
**Setup:** JSON with 12 nested objects.
**Action:** POST.
**Expected:** 400 from zod schema validator; no parser stack-blow.
**Fail signal:** 200 or 500.
**Automation:** jest

### T-059: B2 — JSON with >200 keys per object → 400
**Category:** security
**Spec reference:** §3.4
**Resolves:** GOV-3 BLOCKER B2
**Setup:** Body with 250-key object.
**Action:** POST.
**Expected:** 400.
**Fail signal:** 200.
**Automation:** jest

### T-060: B2 — transcript_sha256 mismatch → 400
**Category:** security
**Spec reference:** §3.4
**Resolves:** GOV-3 BLOCKER B2
**Setup:** Body with wrong hash.
**Action:** POST.
**Expected:** 400 `sha256_mismatch`; no provider call.
**Fail signal:** Pass-through.
**Automation:** jest

### T-061: B2 — source.type outside allowlist → 400
**Category:** security
**Spec reference:** §3.4
**Setup:** `source.type="cursor"` (not yet allowlisted).
**Action:** POST.
**Expected:** 400.
**Fail signal:** Accepted.
**Automation:** jest

### T-062: B2 — transcript <1500 chars → 400
**Category:** security
**Spec reference:** §3.4
**Setup:** 800-char transcript.
**Action:** POST.
**Expected:** 400 `transcript_too_short`.
**Fail signal:** Processed.
**Automation:** jest

### T-063: B2 — transcript >30000 chars → 400
**Category:** security
**Spec reference:** §3.4
**Setup:** 31000-char transcript (body under 256KB).
**Action:** POST.
**Expected:** 400 `transcript_too_long`.
**Fail signal:** Processed.
**Automation:** jest

### T-064: B3 — zero persistence of raw transcript anywhere on server
**Category:** security
**Spec reference:** §9.1
**Resolves:** GOV-3 BLOCKER B3
**Setup:** Successful extraction with a unique sentinel string inside the transcript.
**Action:** After call returns, grep all on-disk files under `data/`, `logs/`, `tmp/`, `~/.auxilo/` server-side for sentinel.
**Expected:** Zero hits.
**Fail signal:** Sentinel appears in any file (audit log, error log, tmp, dumps).
**Automation:** jest post-hook

### T-065: B3 — `onError` handler scrubs `err.stack` on `/extract` path (server.js:106-111)
**Category:** security
**Spec reference:** §19 source notes, GOV-3 B3
**Setup:** Inject a throw inside handler after transcript is bound to a closure variable.
**Action:** POST; capture response and logs.
**Expected:** Response body has no transcript content; stack not echoed; audit row does not include stack.
**Fail signal:** Transcript or stack leaked.
**Automation:** jest + log capture

### T-066: B4 — consent log is append-only (read-only on disk)
**Category:** security
**Spec reference:** §3.5.3, §9.1
**Resolves:** GOV-3 BLOCKER B4
**Setup:** Existing consent rows.
**Action:** Try to modify existing rows via the app code path (there should be none).
**Expected:** No API, no CLI, no code path mutates historical rows; file permission test confirms append-open semantics.
**Fail signal:** Any mutation path.
**Automation:** jest + static grep for `fs.writeFile` on consent path

### T-067: HIGH #1 — server-side revocation kills in-flight extraction (multi-candidate)
**Category:** security
**Spec reference:** §3.5.4 (final-publish recheck — locked-in mechanism), spec §16 last bullet
**Resolves:** GOV-3 HIGH #1, GOV-2 HIGH #1
**Setup:** Extraction produces **2+ candidate learnings** in a single call (mock provider returns two publishable candidates). Slow the per-candidate `/learn` path by inserting a test-only barrier between candidate 1's publish and candidate 2's publish.
**Action:** Let candidate 1's POST to `/learn` complete; during the barrier, issue `PATCH /account/settings {autonomous_extraction_mode:"off"}`; release the barrier; let candidate 2 proceed.
**Expected:**
  (a) Candidate 1 publishes successfully (audit row `action="publish"`);
  (b) Candidate 2 is rejected with audit row `action="reject"` and `reason="revoked_in_flight"`;
  (c) The fresh consent-state read per §3.5.4 (with `forceReload: true`) is what observes the revocation — not a cached mode value from extraction start.
  Additional single-candidate case (legacy): slow provider, revoke mid-call, assert final-publish recheck suppresses publish.
**Fail signal:** Candidate 2 published anyway; or both candidates rejected (over-suppression).
**Automation:** jest + timers + barrier fixture

### T-068: HIGH #2 — new scrubber patterns fail-closed end to end (runner refuses upload)
**Category:** security
**Spec reference:** §7.5, §7.6
**Resolves:** GOV-3 HIGH #2
**Setup:** Transcript fixture containing `sk-ant-...` that escapes the first redaction pass (simulate by breaking the redaction helper).
**Action:** Run runner end-to-end (no server).
**Expected:** Runner logs `scrub_fail`, does NOT POST, queue file not written.
**Fail signal:** Upload attempted.
**Automation:** jest + subprocess

### T-069: HIGH #3 — server rescan catches what client missed → 422
**Category:** security
**Spec reference:** §5.1.1
**Resolves:** GOV-3 HIGH #3
**Setup:** Forge an `/extract` request with a still-present `sk-ant-...` token and a client scrub report claiming clean.
**Action:** POST.
**Expected:** 422 `sensitivity_fail`, response body names pattern (e.g., `anthropic_key`), **never echoes the value**; provider not invoked.
**Fail signal:** 200 or value leaked in response.
**Automation:** jest

### T-070: HIGH #4 — category allowlist rejects out-of-scope extractions
**Category:** security
**Spec reference:** §5.1.4
**Resolves:** GOV-3 HIGH #4
**Setup:** Mock provider returns a learning with `category="medical-advice"` (not in `lib/extractor.js:43-46`).
**Action:** POST.
**Expected:** Learning rejected; `rejections[] = [{reason:"category"}]`; audit row captures reason.
**Fail signal:** Learning published.
**Automation:** jest

### T-071: HIGH #5 — secrets not sourced from `~/.zshrc` (wrapper script hygiene)
**Category:** security
**Spec reference:** §12.2
**Resolves:** GOV-3 HIGH #5
**Setup:** Inspect `auxilo/scripts/auxilo-sweeper-wrapper.sh` after rewrite.
**Action:** Static grep for `.zshrc`.
**Expected:** No match; credentials come only from `~/.auxilo/credentials.json`.
**Fail signal:** `.zshrc` sourcing present.
**Automation:** grep in CI

### T-072: HIGH #7 — OFAC screen pre-provider on sanctioned wallet
**Category:** security
**Spec reference:** §3.8
**Resolves:** GOV-3 HIGH #7
**Setup:** Test account bound to a wallet on the OFAC fixture list; mock `checkOFAC` returns sanctioned.
**Action:** POST.
**Expected:** 403 `ofac_blocked`; provider mock call count = 0; audit row `reject/ofac`.
**Fail signal:** Any LLM invocation.
**Automation:** jest

---

## 4. Rate-limit tests

### T-073: Unverified tier — 50/day cap hit → 429 Retry-After
**Category:** rate-limit
**Spec reference:** §3.6, §10
**Resolves:** GOV-3 HIGH #1, CFO-1 §5
**Setup:** Unverified account; clock-mock to UTC 06:00; pre-load counter at 50 successful extractions.
**Action:** 51st POST.
**Expected:** 429 with `Retry-After` header set to seconds-until-UTC-midnight.
**Fail signal:** Any other code.
**Automation:** jest

### T-074: Unverified tier — 30/hour cap hit → 429
**Category:** rate-limit
**Spec reference:** §3.6, §10
**Setup:** Unverified account; 30 calls in past 60 minutes.
**Action:** 31st POST.
**Expected:** 429 with hour-window retry.
**Fail signal:** Accepted.
**Automation:** jest

### T-075: Verified tier — 200/day cap
**Category:** rate-limit
**Spec reference:** §3.6
**Setup:** Verified account; 200 calls today.
**Action:** 201st POST.
**Expected:** 429 day-window.
**Fail signal:** Accepted.
**Automation:** jest

### T-076: Trusted tier — 1000/day cap
**Category:** rate-limit
**Spec reference:** §3.6
**Setup:** Trusted account via override; 1000 calls today.
**Action:** 1001st POST.
**Expected:** 429 day-window.
**Fail signal:** Accepted.
**Automation:** jest

### T-077: Burst cap — 6 calls in 60s → 6th is 429
**Category:** rate-limit
**Spec reference:** §3.6
**Setup:** Any tier; 5 successful calls in 10s.
**Action:** 6th within the same minute.
**Expected:** 429 with short retry.
**Fail signal:** 6th accepted.
**Automation:** jest + timers

### T-078: UTC midnight resets daily counters
**Category:** rate-limit
**Spec reference:** §3.6
**Setup:** Unverified account at 50/50, clock = 23:59:59 UTC.
**Action:** Clock-advance 2s; POST.
**Expected:** 200 (counter reset).
**Fail signal:** 429 carry-over.
**Automation:** jest + clock-mock

### T-079: Cap override file beats tier lookup
**Category:** rate-limit
**Spec reference:** §3.6 (override config)
**Setup:** Unverified account with override `daily_cap=500`; 60 calls today.
**Action:** 61st POST.
**Expected:** 200 (override wins over base 50/day).
**Fail signal:** 429.
**Automation:** jest

### T-080: $25/day soft alert — email sent, serving continues
**Category:** rate-limit
**Spec reference:** §3.6 global breaker
**Resolves:** CFO-1 §6
**Setup:** Provider mock reporting usage causing spend counter = $24.99; next call's cost = $0.05.
**Action:** POST.
**Expected:** Call succeeds; `ops/extract-spend-report.js` path or in-process hook logs CFO-1 alert exactly once (not on every subsequent call).
**Fail signal:** No alert, or alert repeats.
**Automation:** jest + spy

### T-081: $50/day hard throttle — 503 Retry-After 3600 across all accounts
**Category:** rate-limit
**Spec reference:** §3.6
**Resolves:** CFO-1 §6
**Setup:** Spend counter at $50.00.
**Action:** Any account POSTs.
**Expected:** 503 with `Retry-After: 3600`; ops paged; audit row logged.
**Fail signal:** 200.
**Automation:** jest

### T-082: $100/day kill switch — route disabled, manual reset required
**Category:** rate-limit
**Spec reference:** §3.6, §15.3
**Resolves:** CFO-1 §6
**Setup:** Spend counter at $100.00.
**Action:** POST; clock-advance past UTC midnight; POST again; then run `scripts/admin.js extract:reset-kill-switch --reason "smoke-test" --acknowledged-by tyler`; POST once more.
**Expected:**
  (a) $100 kill-switch persists across UTC midnight without auto-reset — both pre- and post-midnight POSTs return 503 (or feature-flag-off 404) and Tyler page is emitted;
  (b) `scripts/admin.js extract:reset-kill-switch` command successfully re-enables the route;
  (c) an audit row with `action="kill_switch_reset"` is written containing `reason` and `acknowledged_by` fields;
  (d) subsequent POST to `/extract` returns 200 after reset.
**Fail signal:** Any 200 before reset; auto-reset at midnight; missing audit row; 503 after reset.
**Automation:** jest (clock-mocked + subprocess)

---

## 5. Failure tests

### T-083: Provider 429 → retry with header-specified delay, succeed
**Category:** failure
**Spec reference:** §6.4
**Setup:** Mock primary provider to 429+`retry-after:5` once, then 200.
**Action:** POST.
**Expected:** 200; test observes exactly 5s sleep between attempts; provider invoked twice.
**Fail signal:** Fixed-backoff used or failure surfaced.
**Automation:** jest + fake timers

### T-084: Provider 5xx ×3 then secondary model success
**Category:** failure
**Spec reference:** §6.3, §6.4
**Setup:** Primary 500×3, secondary 200.
**Action:** POST.
**Expected:** 200; backoff 1s/4s/15s on primary; secondary invoked once.
**Fail signal:** Skipped fallback or wrong backoff.
**Automation:** jest

### T-085: Provider 401 hard-fail, no retry, ops paged
**Category:** failure
**Spec reference:** §6.4
**Setup:** Primary returns 401.
**Action:** POST.
**Expected:** Caller does not retry; returns 502 to client; logs include `ProviderAuthError`; ops paging hook fires.
**Fail signal:** Retry attempted.
**Automation:** jest + spy

### T-086: Network partition during `/extract` — client sees error, queue file retained
**Category:** failure
**Spec reference:** §7.3, §7.4
**Setup:** Runner POSTs to fake server that closes socket mid-response.
**Action:** Run runner.
**Expected:** Runner logs `upload_failed`, queue file `pending-learnings/NNN-*.json` still on disk, ledger NOT marked, loop continues to next session.
**Fail signal:** Queue file deleted or ledger marked.
**Automation:** jest + net mock

### T-087: Queue file durability across runner crash
**Category:** failure
**Spec reference:** §7.1, §7.4
**Setup:** Runner writes queue file then is `kill -9`'d before POST.
**Action:** Relaunch runner with `--flush-pending`.
**Expected:** Queue file retried; upon success, deleted and ledger updated.
**Fail signal:** Queue file lost on crash, or replayed as duplicate published learning (spec §3.7 idempotency must also prevent double-bill).
**Automation:** jest + subprocess kill

### T-088: Provider pre-check hits minute-quota ceiling → 503 Retry-After 60
**Category:** failure
**Spec reference:** §6.5
**Setup:** `getQuotaState()` reports within 10% of org minute cap.
**Action:** POST.
**Expected:** 503 with `Retry-After: 60`; provider NOT invoked; no cost recorded.
**Fail signal:** Call proceeds and 429s from upstream.
**Automation:** jest

### T-089: Runner `--flush-pending` with invalid JSON queue file — logs and continues
**Category:** failure
**Spec reference:** §16 bullet
**Setup:** Queue dir with one valid file, one corrupt-JSON file.
**Action:** Run `--flush-pending`.
**Expected:** Corrupt file logged, skipped, not deleted; valid file processed; exit 0.
**Fail signal:** Runner crashes or deletes corrupt file silently.
**Automation:** jest

### T-090: Transcript contains sentinel AFTER scrub but server detects → 422 with redacted error body
**Category:** failure
**Spec reference:** §5.1.1
**Setup:** Hand-crafted transcript that bypasses client scrubber (test-only bypass), server-side pattern still matches.
**Action:** POST.
**Expected:** 422; response body names pattern; provider not invoked; no audit row except `reject` entry.
**Fail signal:** Provider called or raw value echoed.
**Automation:** jest

### T-091: `--dry-run` — nothing queued, nothing POSTed, nothing written to ledger
**Category:** failure
**Spec reference:** §7.1, §16
**Setup:** Runner with valid transcripts in adapter discovery.
**Action:** `node scripts/runner.js --sweep --dry-run`.
**Expected:** Zero files under `~/.auxilo/pending-learnings/`, zero POSTs, ledger `extracted-sessions.json` unchanged.
**Fail signal:** Any side effect.
**Automation:** jest + subprocess

### T-092: `AUXILO_EXTRACTING=1` loop guard exits immediately
**Category:** failure
**Spec reference:** §7.4
**Setup:** Environment variable set.
**Action:** Run runner.
**Expected:** Exit 0, no source enumeration, no queue ops.
**Fail signal:** Runner proceeds.
**Automation:** jest

---

## 6. Compliance / promise tests (one per user-facing promise)

### T-093: Consent log exists for every active account with mode != "off"
**Category:** compliance
**Spec reference:** §3.5, §11.1(b)
**Setup:** Seed 10 accounts with various states.
**Action:** Invariant check: every account where `autonomous_extraction_mode != "off"` has a most-recent `grant` row in consent log.
**Expected:** Invariant holds; any violation is a P0 bug.
**Fail signal:** Account processing without grant.
**Automation:** jest + data scan

### T-094: Consent revoke halts all future extractions
**Category:** compliance
**Spec reference:** §11.1(e), GDPR Art. 7 revocation
**Setup:** Account mid-stream.
**Action:** `POST /account/consent/revoke`; attempt 5 further POSTs.
**Expected:** All 5 return 403 consent_required.
**Fail signal:** Any acceptance.
**Automation:** jest

### T-095: Retraction removes from catalog without touching earnings (full invariant)
**Category:** compliance
**Spec reference:** §5.2, §11.2(c)
**Setup:** Learning published, 3 unlocks recorded, `lib/earnings.js` snapshot taken.
**Action:** Retract within 7d.
**Expected:** Snapshot of `total_contributor`, `total_platform`, `pending_balance` unchanged; learning gone from catalog.
**Fail signal:** Any earnings diff.
**Automation:** jest

### T-096: 7-day window sweeper flips state correctly — boundary day 7 vs. day 8
**Category:** compliance
**Spec reference:** §9.3
**Setup:** Learnings at exactly t0-7d (boundary) and t0-6d23h59m.
**Action:** Run sweeper at t0.
**Expected:** Day-7-exact flips; day-6-23h59m remains active.
**Fail signal:** Off-by-one.
**Automation:** jest + clock-mock

### T-097: Daily digest fires at 09:00 UTC
**Category:** compliance
**Spec reference:** §9.2
**Setup:** Test server with cron harness; clock at 08:59:50 UTC.
**Action:** Advance 20s.
**Expected:** `jobs/daily-digest.js` runs exactly once; mailersend spy shows one send per active account with published yesterday OR matches configured cadence.
**Fail signal:** Missed or double-fire.
**Automation:** jest + fake cron

### T-098: Daily digest content — includes retraction-window deadlines, excludes contributor_agent
**Category:** compliance
**Spec reference:** §9.2
**Setup:** Account with 2 published yesterday.
**Action:** Render digest.
**Expected:** Email contains titles + retraction deadlines; grep for `contributor_agent` returns zero matches.
**Fail signal:** Any `contributor_agent` exposed.
**Automation:** jest

### T-099: Continued-use-after-notice — hard consent_version assertion
**Category:** compliance
**Spec reference:** §11.1(b), §9.1, ToS §17
**Setup:** Account on `consent_version=2026-04-14`; publish new ToS with effective date `t_effective` and `consent_version=2026-05-01`; account performs `/extract` calls both before and after `t_effective`.
**Action:** Run extractions at `t_effective - 1h` and `t_effective + 1h`.
**Expected:** **Hard assertion** (not soft check): for extractions performed after `t_effective`, the audit row's `consent_version` field exactly equals `"2026-05-01"`; for extractions performed before `t_effective`, it exactly equals `"2026-04-14"`. String equality, not substring match.
**Fail signal:** Either version missing, null, or mismatched against the grant row in force at extraction time.
**Automation:** jest

### T-100: Subprocessor disclosure page live at `/legal/subprocessors`
**Category:** compliance
**Spec reference:** §11.5, Hard prerequisite #3
**Resolves:** GOV-2 HIGH #2
**Setup:** Test server.
**Action:** `GET /legal/subprocessors`.
**Expected:** 200, renders `docs/SUBPROCESSORS.md` with Anthropic, Stripe, Coinbase entries; link from Privacy Policy §7.5 works.
**Fail signal:** 404 or missing entries.
**Automation:** supertest

### T-101: Supported-clients page live at `/legal/supported-clients`
**Category:** compliance
**Spec reference:** §11.5
**Setup:** Test server.
**Action:** `GET /legal/supported-clients`.
**Expected:** 200; renders `docs/SUPPORTED-CLIENTS.md` with Claude Code + OpenClaw.
**Fail signal:** 404.
**Automation:** supertest

### T-102: `PATCH /account/settings` toggles `autonomous_extraction_mode` — field, not file
**Category:** compliance
**Spec reference:** §3.5.4, Hard prerequisite #2
**Setup:** Account with mode=automatic.
**Action:** PATCH with `mode=off`.
**Expected:** Account record updated; next POST returns 403 disabled; no dependency on local kill-switch sentinel.
**Fail signal:** Server still processes.
**Automation:** jest

### T-103: Audit log retention policy — 18-month op retention, 7y consent chain
**Category:** compliance
**Spec reference:** §9.1
**Setup:** Seed audit rows dated >18 months old.
**Action:** Run retention sweeper.
**Expected:** Op rows >18mo purged; rows tagged as consent-related survive to 7y.
**Fail signal:** Either both purged or neither purged.
**Automation:** jest + clock-mock

### T-104: Kill-switch sentinel — runner bails if `~/.auxilo/autonomous-enabled` missing
**Category:** compliance
**Spec reference:** §7.4, §11.1(e)
**Setup:** No sentinel file.
**Action:** Run runner.
**Expected:** Exit 0, no source enumeration, no POST.
**Fail signal:** Any side effect.
**Automation:** jest + subprocess

---

## 7. End-to-end — Tyler-pilot acceptance (load-bearing)

**These are the gating tests. Until T-109 passes end-to-end on Tyler's machine, autonomous extraction does not open to any other Builder. Operator is Tyler (or Architect acting under Tyler's direction). No test in this section is automatable — each step has an observable side effect that must be manually confirmed.**

### T-105: Tyler-pilot — pre-flight state check
**Category:** e2e
**Spec reference:** §15.2 steps 1–5
**Setup:** Production server freshly deployed with P2.1a code. Tyler's laptop has `~/.auxilo/credentials.json` (no `anthropic_api_key` field).
**Action:**
1. `curl https://auxilo.io/terms` → confirm §5.9.3/§5.9.4 prose matches spec §11.1/§11.2.
2. `curl https://auxilo.io/privacy` → confirm §7.5 LLM-provider subsection.
3. `curl https://auxilo.io/legal/subprocessors` → 200, Anthropic listed.
4. `curl https://auxilo.io/legal/supported-clients` → 200, Claude Code + OpenClaw listed.
5. Tyler's account record shows `autonomous_extraction_mode="off"` initially.
**Expected:** All five conditions met.
**Fail signal:** Any doc missing; any unexpected mode state.
**Automation:** manual checklist

### T-106: Tyler-pilot — enable autonomous mode via `PATCH /account/settings`
**Category:** e2e
**Spec reference:** §15.2 step 7
**Setup:** T-105 passed.
**Action:**
1. Grant consent: `POST /account/consent/grant`.
2. `PATCH /account/settings {"autonomous_extraction_mode":"automatic"}`.
3. Touch sentinel: `touch ~/.auxilo/autonomous-enabled`.
4. Load agent: `launchctl load ~/Library/LaunchAgents/tech.conway.auxilo-sweeper.plist`. *(2026-07-15: label renamed `io.auxilo.sweeper`; the launchd sweeper is currently retired-archived — extraction runs via the SessionEnd hook. See PUNCH-LIST TD-CONWAY-1.)*
**Expected:** Consent row appended; account record flipped; sentinel exists; launchd reports agent loaded.
**Fail signal:** Any step errors or leaves inconsistent state.
**Automation:** manual

### T-107: Tyler-pilot — smoke test with synthetic transcript (automatic mode OFF → ON)
**Category:** e2e
**Spec reference:** §15.2 step 6
**Setup:** T-106 complete.
**Action:**
1. Run `node scripts/runner.js --transcript tests/fixtures/smoke-session.jsonl --verbose`.
2. Confirm client scrubber logs pattern matches (expected: 0 for this clean fixture).
3. Confirm POST `/extract` response 200.
4. Grep `data/audit-extractions.jsonl` for the new `audit_id`.
5. Grep `data/extractions.jsonl` for the idempotency record.
**Expected:** Single round-trip, audit row with hash chain linked to prior tail, idempotency row present, zero queue-file residue.
**Fail signal:** Any missing artifact.
**Automation:** manual + curl helpers

### T-108: Tyler-pilot — real session publish
**Category:** e2e
**Spec reference:** §15.2 step 8
**Setup:** T-107 passed. Tyler runs a real Claude Code session that produces at least one non-trivial learning.
**Action:**
1. End the session (SessionEnd hook fires).
2. Wait ≤60s for runner to POST `/extract`.
3. Confirm a learning appears in `GET /catalog?contributor=<tyler-wallet>` with `retraction_window_active=true`, `retraction_window_ends` = publish_ts + 7d.
4. Verify `data/audit-extractions.jsonl` tail shows `action="publish"` linked to Tyler's account.
5. Verify `lib/earnings.js` row for Tyler matches expected pre-earning state (no unlock yet, nothing paid).
**Expected:** All five observations satisfied.
**Fail signal:** Learning missing, retraction window wrong, audit missing, or earnings perturbed.
**Automation:** manual

### T-109: **Tyler-pilot acceptance test — full sequence (GATING)**
**Category:** e2e
**Spec reference:** §15.2 full sequence; spec §0 Tyler pilot-of-one requirement
**Setup:** T-105 through T-108 passed within same deploy window.
**Action:**
1. **Real transcript in**, real `/extract` POST, real published learning (satisfied by T-108).
2. **Retraction-window state:** `GET /catalog?id=<learning-id>` shows `retraction_window_active=true` and correct `retraction_window_ends`.
3. **Real audit log entry:** audit row hash-chain links correctly; every field populated per §9.1 schema; no raw transcript or body substrings (grep sentinel).
4. **Real daily digest delivery:** wait for next 09:00 UTC (or fire via `node jobs/daily-digest.js --account <tyler> --force`). Tyler receives an actual email via mailersend containing exactly one published learning's title + retraction deadline.
5. **Retraction works:** `DELETE /learn/:id?reason=retract` within 7d. Confirm (a) learning gone from public catalog, (b) earnings snapshot unchanged vs. pre-retraction, (c) new audit row `action="retract"`.
6. **Loop guard:** set `AUXILO_EXTRACTING=1`, re-run runner, confirm exit 0.
7. **Kill switch:** `rm ~/.auxilo/autonomous-enabled`, run runner, confirm exit 0.
8. **Server revocation:** `PATCH /account/settings {mode:"off"}`, run runner manually, confirm 403.
9. **72-hour soak:** observation window — Tyler leaves autonomous mode on for 72h of normal use; at end, confirm zero paged incidents, zero unexpected 429/503/502, spend counter consistent with audit log sum, no queue files stuck in `~/.auxilo/pending-learnings/`.
**Expected:** Every observation in steps 1–9 satisfied. This test being green is the bar for opening the feature to any non-Tyler Builder.
**Fail signal:** Any single observation missed → hold launch, file incident, re-test after fix.
**Automation:** manual; test runner records each step's pass/fail into `tests/p2-1a/e2e/pilot-log.jsonl`.

### T-110: Tyler-pilot — retraction sweeper boundary on Tyler's actual learning
**Category:** e2e
**Spec reference:** §9.3
**Setup:** Tyler has a learning published at some real t0; allow 7 days to elapse (or clock-mock the sweeper with real record).
**Action:** Observe sweeper run at next 09:00 UTC after t0+7d.
**Expected:** `retraction_window_active` flips to `false`; earnings untouched; audit row `window_closed`; Tyler notified in digest.
**Fail signal:** Any earnings field changes, or sweeper silently skips.
**Automation:** manual + 7d wait

---

## 8. Regression corpus — permanent baseline

**Baseline lock:** The 4 legacy learnings in `~/.auxilo/pending-learnings/` (001–004) are the permanent extraction-quality regression corpus. **Every change to the extraction system prompt or `lib/extractor.js` scoring logic must pass this corpus with total >=14/20 and no dimension <3.** Scores can only ratchet up; a future commit that drops any of these below 14/20 is a merge-block and requires Architect + BUILD-4 joint review. Rationale: these four were hand-validated by Tyler and represent the floor of "obviously worth publishing."

Snapshot the initial scores in `tests/p2-1a/regression/baseline.json` on first green run.

### T-111: Regression — `001-mailersend-requires-live-website.json`
**Category:** regression
**Spec reference:** spec §16 regression corpus, §12.2 (`lib/extractor.js` → `scoreLearning` export)
**Setup:** Call `extractor.scoreLearning(legacyLearning)` directly with the legacy learning object loaded from `~/.auxilo/pending-learnings/001-mailersend-requires-live-website.json`. Assert both the returned `total` and the full `dimensions` breakdown exactly match frozen expected values stored in a sibling `.expected.json` fixture. Any drift in either fails the test. (Remove any scaffolding that re-runs the full extraction pipeline.)
**Action:** `scoreLearning(legacy001)` — no LLM, no I/O beyond the JSON loads.
**Expected:** `total >= 14/20`; each of specificity/actionability/novelty/completeness `>= 3`; `total` and `dimensions` object deep-equal the `.expected.json` baseline. Initial baseline captured on first green run.
**Fail signal:** Any drift in `total` or any `dimensions` value vs. the frozen fixture — block merge.
**Automation:** `node tests/p2-1a/regression/run-corpus.js 001`

### T-112: Regression — `002-cloudflare-email-routing-syncing-bounces.json`
**Category:** regression
**Spec reference:** spec §16 regression corpus, §12.2 (`scoreLearning`)
**Setup:** Call `extractor.scoreLearning(legacyLearning)` directly on `~/.auxilo/pending-learnings/002-cloudflare-email-routing-syncing-bounces.json`. Assert `total` and `dimensions` deep-equal sibling `.expected.json` fixture. No pipeline replay.
**Action:** `scoreLearning(legacy002)`.
**Expected:** `total >= 14/20`; each dim `>= 3`; exact match to frozen fixture.
**Fail signal:** Any drift — block merge.
**Automation:** corpus script

### T-113: Regression — `003-cloudflare-pages-instant-landing-page.json`
**Category:** regression
**Spec reference:** spec §16 regression corpus, §12.2 (`scoreLearning`)
**Setup:** Call `extractor.scoreLearning(legacyLearning)` directly on `~/.auxilo/pending-learnings/003-cloudflare-pages-instant-landing-page.json`. Assert `total` and `dimensions` deep-equal sibling `.expected.json` fixture. No pipeline replay.
**Action:** `scoreLearning(legacy003)`.
**Expected:** `total >= 14/20`; each dim `>= 3`; exact match to frozen fixture.
**Fail signal:** Any drift — block merge.
**Automation:** corpus script

### T-114: Regression — `004-private-email-stack-without-workspace-exposure.json`
**Category:** regression
**Spec reference:** spec §16 regression corpus, §12.2 (`scoreLearning`)
**Setup:** Call `extractor.scoreLearning(legacyLearning)` directly on `~/.auxilo/pending-learnings/004-private-email-stack-without-workspace-exposure.json`. Assert `total` and `dimensions` deep-equal sibling `.expected.json` fixture. No pipeline replay.
**Action:** `scoreLearning(legacy004)`.
**Expected:** `total >= 14/20`; each dim `>= 3`; exact match to frozen fixture.
**Fail signal:** Any drift — block merge.
**Automation:** corpus script

---

## 9. Open Questions for Architect

These are genuine gaps I hit while authoring tests — flagged for the Architect, not self-resolved.

1. **OQ-1 (T-111–T-114 methodology).** The regression corpus tests need a deterministic way to score a *stored learning body* against the quality gate without re-running the LLM. The spec does not define whether `passesQualityGate()` can be invoked on an already-materialized candidate object, or whether it only runs inline in `lib/extractor.js` mid-pipeline. Need: either (a) expose `scoreLearning(body) → {dimensions, total}` as a public helper, or (b) document how BUILD-4 should harness the corpus to verify the floor. Otherwise T-111–T-114 become "run the full LLM extraction on a synthetic transcript built from the body," which is nondeterministic and defeats the purpose of a locked regression baseline.

2. **OQ-2 (T-099 continued-use evidence).** The spec says continued use after §17 notice constitutes acceptance, but does not specify whether the audit log row must carry the `consent_version` snapshot at the moment of each extraction. Without that field, T-099 cannot be made into a hard assertion — we'd be checking that "an event happened" rather than "the event was recorded against the correct version." Recommend: add `consent_version` to the audit-row schema in §9.1.

3. **OQ-3 (T-082 $100 kill switch — reset).** §3.6 says the $100/day kill switch pages Tyler and states "reset UTC midnight" for the $50 throttle, but is silent on whether the $100 disable auto-resets at midnight or requires manual re-enable. T-082 currently assumes auto-reset at midnight to match the $50 pattern; if the intent is manual re-enable, the test needs to change and an ops runbook step is missing.

4. **OQ-4 (T-067 in-flight revocation).** The spec says server-side revocation must halt in-flight extraction, but does not define how the handler observes an async account-record change mid-await. Options: (a) handler polls a `latestModeFor(account)` check between pipeline steps, (b) a pub/sub cancellation signal, (c) final publish-time re-check only. The test as written assumes (c) because it's the cheapest to implement, but the spec could reasonably demand (a) or (b). Need clarification.

5. **OQ-5 (T-043 per-account idempotency scope).** Spec §3.7 and Open Question Q2 in the spec itself both leave this officially open; I wrote T-043 to lock per-account behavior as the default so there's a regression anchor. Architect should confirm per-account is the intended answer so this test becomes authoritative rather than provisional.

---

**End of TEST-P2.1a.**
