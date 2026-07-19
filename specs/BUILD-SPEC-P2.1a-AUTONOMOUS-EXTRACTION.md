> ⚠️ **SUPERSEDED** by `specs/REWORK-P2.1a.md` — this is the original spec. The rework spec is the source of truth for the shipped implementation.

# BUILD-SPEC-P2.1a — Autonomous Learning Extraction (Server-Side)

**Status:** Architect blueprint. Ready for Antigravity implementation on Tyler's GO.
**Supersedes:** `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md` (apply superseded banner when this spec is signed off).
**Owner build:** Main context (Architect). Implementation: Antigravity (Builder).
**Created:** 2026-04-14
**Gate A reviewers required (pre-merge):** BUILD-1 Architect (self-review against delivered code), BUILD-4 QA, GOV-3 Security, GOV-1 Docs/PM.
**Gate B reviewers triggered (scope):** GOV-2 Compliance (ToS/PP/subprocessor), SPEC-2 Agent UX (runner API + OpenClaw adapter), SPEC-3 Builder UX (mode settings + daily digest), CFO-1 (live COGS review at N=500).

---

## 0. Reviewer Inputs Synthesized Into This Spec

This spec is the synthesis of five specialist briefs plus Tyler's locked decisions:

| Input | Role | Contribution |
|---|---|---|
| BUILD-1 Architect | Architecture | `/extract` shape, transcript-source interface, provider seam, runner rewrite guidance, OpenClaw adapter plan |
| GOV-3 Security | Security | Threat model, 4 blockers + 7 high, scrubber pattern gaps, credential hygiene |
| GOV-2 Compliance | Legal | §5.9.3/§5.9.4 drop-in prose, Privacy Policy amendments, subprocessor disclosure, GDPR Art. 7 revocation mechanism, §230 posture, R-21 |
| CFO-1 Financial | Unit economics | Per-extraction cost, tiered per-account caps, $-denominated global circuit breaker, accounting treatment, Anthropic tier-upgrade action |
| GOV-1 Docs/PM | Project sequencing | Legacy 4-learning backlog disposition (manual out-of-band, not handled by this spec) |

---

## 1. Problem & Locked Decisions

### 1.1 Problem

P2.1 wired a SessionEnd hook + launchd sweeper to a client-side Node runner that called Anthropic directly from the user's machine using a BYO `anthropic_api_key`. Architecturally wrong: the user became Anthropic's customer, Auxilo had no audit/PII/rate/policy control over catalog ingestion, and BYO-key was a hard launch requirement for every future Builder.

### 1.2 Locked decisions (do not re-litigate)

1. **Autonomous publication IS the product.** "Your agents learn. You earn." is non-negotiable. Automatic mode is the default.
2. **Server-side extraction.** The client uploads a PII-scrubbed transcript to a new Auxilo `POST /extract` endpoint. Auxilo (not the user) calls the LLM subprocessor. Auxilo is the LLM customer. BYO-key eliminated.
3. **Three trigger modes:** Automatic (default) / Scheduled / Manual. User-selectable per account.
4. **Continued-use-after-notice** consent model for ToS updates. Initial consent captured once on activation; subsequent updates take effect via §17 notice without re-affirmation.
5. **No writeoff, no dual-clock, earnings flow unchanged.** `lib/earnings.js:35-49` and `server.js:725` instant-credit path are not modified. Retraction is a catalog-only operation with no clawback on already-completed unlocks.
6. **7-day retraction window** on all autonomously-published learnings.
7. **Day-one clients:** Claude Code AND OpenClaw. Transcript-source interface is pluggable.
8. **Kill-switch sentinel** `~/.auxilo/autonomous-enabled` preserved (client-side convenience). Server-side consent record is the authoritative gate.
9. **Stripe payout coexists with crypto** — no impact on this spec; flagged only because extraction COGS math is Auxilo-eats regardless of Builder payout method.
10. **Source discipline.** Every load-bearing technical claim in this spec cites file:line or an authoritative URL. No inference.

---

## 2. Architecture Overview

```
┌────────────── USER MACHINE ──────────────┐         ┌─────────── AUXILO SERVER ────────────┐
│                                          │         │                                      │
│  Claude Code / OpenClaw / (future)        │         │                                      │
│         │                                │         │                                      │
│    SessionEnd hook (CC)                  │         │                                      │
│    polling sweeper (OpenClaw v1)         │         │                                      │
│         │                                │         │                                      │
│         ▼                                │         │                                      │
│   scripts/runner.js                      │         │                                      │
│    • kill-switch gate                    │         │                                      │
│    • enumerate active TranscriptSources  │         │                                      │
│    • source.readSession() → transcript   │         │                                      │
│    • sensitivityFilter.scanText()        │         │                                      │
│    • redact + second-pass scan (fail-    │         │                                      │
│      closed if any match remains)        │         │                                      │
│    • write pending-learnings/NNN.json    │         │                                      │
│         │                                │         │                                      │
│         └── POST /extract ──────────────────────→  POST /extract                          │
│               Headers:                    │         │  1. API-key auth → account          │
│                 X-API-Key                 │         │  2. Consent-log check               │
│                 Idempotency-Key           │         │  3. Rate limit (tier + $-breaker)   │
│               Body:                       │         │  4. Idempotency short-circuit       │
│                 {source, transcript,      │         │  5. Server-side rescan              │
│                  transcript_sha256,       │         │     (lib/sensitivity-filter)        │
│                  scrub_report,            │         │  6. OFAC on bound wallet            │
│                  mode_hint}               │         │  7. provider.extract()              │
│                                          │         │     Anthropic primary; fallbacks     │
│                                          │         │  8. Quality gate (14/20)             │
│                                          │         │  9. Category allowlist               │
│                                          │         │ 10. Dedup vs. catalog                │
│                                          │         │ 11. Branch: mode === "automatic"     │
│                                          │         │     ? publishLearnings()  (→ /learn  │
│                                          │         │        write path @ server.js:3566) │
│                                          │         │     : parkForReview()                │
│                                          │         │ 12. Audit log append                 │
│                                          │         │ 13. Retraction window timer          │
│                                          │         │ 14. Enqueue daily-digest row         │
│         ←──────────────────────────── 200 { extraction_id, published, rejections, … }    │
│    • delete pending-learnings/NNN         │         │                                      │
│    • update ledger                        │         │                                      │
└──────────────────────────────────────────┘         │  Daily 09:00 UTC:                    │
                                                     │   digestWorker() → email             │
                                                     │   retractionSweeper() → expire       │
                                                     │     windows past 7d                  │
                                                     └──────────────────────────────────────┘
```

**Invariants held:**
- Earnings lifecycle untouched — `server.js:725` writes exactly as today.
- Retraction is catalog-only; settled unlocks never clawed back.
- Kill-switch is first check in the runner; absent → exit 0.
- `AUXILO_EXTRACTING=1` loop guard preserved.
- `scanLearning` runs both client-side (pre-upload) AND server-side (receipt).

---

## 3. `/extract` Endpoint — Target Design

The endpoint exists today at `server.js:3909-3982` but is gated `adminAuth('admin')`. **This spec rewires it.** The existing inline Anthropic call at `server.js:3939-3959` becomes the first implementation of the provider seam (§6).

### 3.1 Request

```
POST /extract
Headers:
  Content-Type: application/json
  X-API-Key: <per-account api key>       # primary auth, matches /learn at server.js:1776-1847
  Idempotency-Key: <client uuid>         # required

Body:
{
  "source": {
    "type": "claude-code" | "openclaw" | "cursor" | ...,
    "session_id": "stable id from source",
    "source_version": "0.2.0"
  },
  "transcript": "<string, cleaned + PII-scrubbed>",
  "transcript_sha256": "<hex>",
  "mode_hint": "automatic" | "scheduled" | "manual",
  "client_scrub_report": {
    "patterns_matched": ["api_token", "jwt_token", ...],
    "redactions": 7,
    "filter_version": "sensitivity-filter@X.Y.Z"
  }
}
```

### 3.2 Response (Automatic mode, happy path)

```
200 OK
{
  "extraction_id": "ext_01HW...",
  "learnings_found": 3,
  "learnings_published": 2,
  "learnings_rejected": 1,
  "rejections": [{ "reason": "sensitivity_filter" | "quality_gate" | "dedup" | "category", ... }],
  "audit_ref": "audit_01HW...",
  "retraction_window_ends": "2026-04-21T..."
}
```

### 3.3 Response (Scheduled / Manual)

Same shape minus `learnings_published`, plus `pending_review_ids[]`. Server parks candidates in `data/extraction-review.jsonl` keyed by account_id.

### 3.4 Validation rules (RESOLVES GOV-3 B2)

- **Content-Length pre-check** at middleware: hard 256 KB cap. Reject `413` if exceeded before handler runs.
- **Streaming length guard** inside handler: re-measure actual bytes consumed (do NOT trust `Content-Length` alone — Transfer-Encoding: chunked bypass). Enforce same 256 KB.
- **JSON depth cap:** max 10 levels, max 200 keys per object. Use `zod` (or equivalent) typed schema validator. Rejects algorithmic-complexity DoS.
- **Transcript char range:** `cleanedTranscript.length` between `MIN=1500` and `MAX=30_000`. (Hard-fail outside range; server enforces, client's char count is advisory.)
- **`transcript_sha256` verification:** server recomputes and compares. Mismatch → `400`.
- **`source.type` allowlist:** `{"claude-code", "openclaw"}` at launch. Future sources require code change.
- **`contributor_wallet` NEVER accepted from body** — always resolved server-side from the account record bound to the X-API-Key. Closes the pre-existing impersonation hole BUILD-1 identified.

### 3.5 Auth & consent (RESOLVES GOV-3 B1, B4; GOV-2 HIGH #1)

Auth flow (reuses `/learn` pattern at `server.js:1776-1847`):

1. Resolve `X-API-Key` → `account_id`.
2. Resolve `account_id` → `contributor_wallet`, `extraction_tier` (`unverified` | `verified` | `trusted`).
3. **Check consent record.** New table/file `data/extraction-consent.jsonl`, append-only JSONL (AdapterState pattern at `lib/openclaw-adapter.js:62-187`). Schema:
   ```json
   {"account_id": "...", "action": "grant"|"revoke", "consent_version": "2026-04-14", "timestamp": "...", "ip_redacted": "1.2.*.*", "user_agent": "..."}
   ```
   Current consent state = most recent action per account_id. No active `grant` → **`403 consent_required`** with a pointer to the opt-in flow. Capture the matched grant row's `consent_version` field and pass it to the audit-row writer so every audit row records which consent version was in force at extraction time.
4. **Check mode.** Account record field `autonomous_extraction_mode` ∈ `{"off", "automatic", "scheduled", "manual"}`. `"off"` → `403 disabled`. This is the server-side revocation switch GOV-2 flagged as HIGH #1: disabling here halts `/extract` server-side even if the local kill-switch is bypassed.
5. **Check account `disabled_at`** — existing guard in `/learn` path at `server.js:~3660`. Reject if account is suspended.

### 3.5.4 In-flight cancellation (server-side revocation)

**Cancellation mechanism:** server-side revocation is observed via a fresh consent-state read performed immediately before *each candidate* learning's POST to `/learn` (not once per extraction). The same `data/extraction-consent.jsonl` loader is reused with `forceReload: true`. If the latest action for the account is `revoke` (or mode is `off`) at that instant, suppress the publish, mark the audit row `action="reject"` with `reason="revoked_in_flight"`, and continue with remaining candidates only if consent is still active. LLM cost incurred before the recheck is borne (bounded by the §3.6 $-breaker).

### 3.6 Rate limiting (RESOLVES GOV-3 HIGH #1; adopts CFO-1 tiered numbers)

Tiered per-account caps from CFO-1 §5:

| Tier | Daily | Hourly | Burst (per min) | Worst-case $/day @ $0.05/call |
|---|---|---|---|---|
| `unverified` (default) | 50 | 30 | 5 | $2.50 |
| `verified` (email + wallet + ≥1 published learning) | 200 | 60 | 5 | $10.00 |
| `trusted` (manual allowlist via override config) | 1,000 | tier×2 | 5 | $50.00 |

**Override config:** new file `data/extract-cap-overrides.json`, schema:
```json
{
  "<account_id>": {
    "daily_cap": 500,
    "hourly_cap": 80,
    "burst_per_min": 5,
    "note": "CI integration — partner onboarded 2026-XX-XX",
    "reviewer": "CFO-1",
    "expires_at": "2026-07-14T00:00:00Z"
  }
}
```
Override lookup precedes tier lookup. CFO-1 is sole approver; quarterly review; expiry mandatory.

**Global $-denominated circuit breaker (CFO-1 §6):**
- **$25/day** → soft alert: log + email CFO-1, keep serving
- **$50/day** → hard throttle: `/extract` returns `503 Service Unavailable` with `Retry-After: 3600`, page ops, reset UTC midnight
- **$100/day** → kill switch: disable route entirely, page Tyler. **Requires manual re-enable via `scripts/admin.js extract:reset-kill-switch --reason <incident-summary> --acknowledged-by <operator>`; does NOT auto-reset at UTC midnight.** Writes audit row `action="kill_switch_reset"` with reason and acknowledger. The $50/day throttle continues to auto-reset at UTC midnight unchanged.

Implementation: process-local counter keyed on UTC date, incremented by actual `(input_tokens × $3 + output_tokens × $15) / 1_000_000` per call. New cron `ops/extract-spend-report.js` emails CFO-1 the prior day's actuals.

### 3.7 Idempotency

Two-layer dedup (BUILD-1 §2.4):

1. **Client-supplied `Idempotency-Key` header** — stored in `data/extractions.jsonl` keyed by `(account_id, idempotency_key)`, TTL 24h. Retry from a flaky network gets the cached response.
2. **Server-computed content hash** — `(account_id, source.session_id, transcript_sha256)` dedup key, TTL 24h. Catches "client forgot Idempotency-Key" and "runner reprocessed a session post-crash" cases. No second LLM bill. **Idempotency scope is per-account.** A global hash would create an attribution oracle and silently deny earnings on legitimate shared-machine collisions (see §13 Q2 rationale).

Both layers in the same `data/extractions.jsonl` append-only ledger (AdapterState pattern). Compacts past 10,000 lines.

### 3.8 OFAC screening (RESOLVES GOV-3 HIGH #7)

Before the provider call, invoke `checkOFAC(bound_wallet)` — already implemented and used at `server.js:~3648` on `/learn`. Sanctioned wallets must not consume LLM cycles. If sanctioned, return `403 ofac_blocked` immediately.

---

## 4. Transcript-Source Interface (Client-Side)

### 4.1 Interface contract

```js
// scripts/sources/source.interface.js
class TranscriptSource {
  static id;                          // "claude-code" | "openclaw" | ...
  static displayName;
  static version;                     // semver

  async detect();                     // → boolean (installed on host?)
  async discoverSessions({ since });  // → [{ sessionId, path, mtime, bytes }]
  async readSession(sessionRef);      // → { transcript: string, metadata: {...} }
  async registerSessionEndHook(cb);   // → unregister fn | null (null = poll-only)
}
```

### 4.2 Claude Code adapter (`scripts/sources/claude-code.js`)

- **`detect()`:** `fs.existsSync(~/.claude/projects)` AND readable `~/.claude/settings.json`.
- **`discoverSessions({ since })`:** walk `~/.claude/projects/**/*.jsonl`, filter `mtime > since`. Logic extracted from P2.1 `findRecentTranscripts()` at `scripts/extract-learnings.js:404-423`.
- **`readSession()`:** JSONL parsing loop from P2.1 `parseTranscript()` at `scripts/extract-learnings.js:120-142`. Produces plain `ROLE: text` blocks.
- **`registerSessionEndHook(cb)`:** writes `~/.claude/hooks/auxilo-extract.sh` and patches `~/.claude/settings.json` SessionEnd hooks array. Hook is a 5-line bash script that POSTs to the runner's local control socket; runner does the actual upload.

### 4.3 OpenClaw adapter (`scripts/sources/openclaw.js`)

**Storage (from BUILD-1 research):** `~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl`, with `sessions.json` index in that same directory. First line of each JSONL = session metadata; subsequent lines = messages/events.

- **`detect()`:** `fs.existsSync(~/.openclaw/agents)` AND ≥1 agent directory.
- **`discoverSessions({ since })`:** read `~/.openclaw/agents/*/sessions/sessions.json`, filter `updatedAt > since`, return session file paths.
- **`readSession()`:** skip first (metadata) line, convert messages into the same `ROLE: text` format used for Claude Code.
- **`registerSessionEndHook()`:** **returns `null` at launch** — poll-only. BUILD-1 flagged OpenClaw plugin API stability as unverified (Open Question §12.2). V1 uses the launchd sweeper polling path; live hooks deferred pending SPEC-2 confirmation of the plugin manifest.

### 4.4 Registration pattern

```js
// scripts/runner.js
const SOURCES = [
  require('./sources/claude-code'),
  require('./sources/openclaw'),
];

async function enumerateActiveSources() {
  const active = [];
  for (const S of SOURCES) {
    if (await S.detect()) active.push(S);
  }
  return active;
}
```

Adding a new source = drop a file in `scripts/sources/`, add one line to the array. No other surgery.

---

## 5. Server-Side Extraction Pipeline

Lives in `lib/extractor.js` (already exists, already implements chunking → LLM → quality gate → sensitivity check → dedup with `llmCall` injected at `lib/extractor.js:1-14`). **This spec reuses it verbatim** — the server-side `/extract` handler calls it with the provider abstraction (§6) as `llmCall`.

### 5.1 Pipeline steps (in handler order)

1. **Server-side scrubber rescan** — `scanText(body.transcript)` using `lib/sensitivity-filter.js`. Any match = `422 sensitivity_fail` with matched pattern NAMES only (never values, per existing redaction pattern at `lib/sensitivity-filter.js:181-184`). This is the server-side belt-and-suspenders defense in depth.
2. **Provider call** — `provider.extract({ prompt, maxTokens, signal })` via the seam (§6).
3. **Quality gate** — `passesQualityGate()` as already implemented: total ≥14/20, no dimension <3 across specificity/actionability/novelty/completeness.
4. **Category allowlist** — enforce against `lib/extractor.js:43-46` `VALID_CATEGORIES`. Reject anything outside.
5. **Post-extraction scrub** — `scanLearning(candidate)` (already at `lib/extractor.js:386`). Catches any PII the LLM introduced itself.
6. **URL allowlist + HTML strip** (RESOLVES GOV-3 HIGH #6) — new helper `sanitizeLearningBody(body)`:
   - Parse markdown, strip any raw HTML tags.
   - Allowlist URLs to a domain list (initial: `docs.*`, `*.dev`, `github.com/*`, `stackoverflow.com/*`, major cloud vendor docs). Non-allowlist URLs converted to plain text.
   - Strip markdown image syntax entirely (defense against tracker pixels).
   - Reject if body contains base64-looking blobs >200 chars.
7. **Dedup vs. catalog** — reuse existing dedup from `lib/extractor.js`.
8. **Mode branch:**
   ```js
   if (account.autonomous_extraction_mode === "automatic") {
     publishLearnings(candidates);   // → /learn write path at server.js:3566-3900
   } else {
     parkForReview(candidates, account_id);  // → data/extraction-review.jsonl
   }
   auditLog(candidates, mode, extraction_id);
   ```
   The mode the server trusts is the account record, NOT `mode_hint` in the request body. `mode_hint` is advisory only (for client UI).

### 5.2 Retraction (7-day window)

- New endpoint `DELETE /learn/:id?reason=retract`
- Gated on `account_id` matching the original `contributor_wallet`
- Within 7 days of publish → removes from discovery, search, catalog API
- After 7 days → falls through to standard DMCA / takedown process
- **No earnings clawback** under any circumstances. `total_contributor`, `total_platform`, and `pending_balance` on `lib/earnings.js` are not touched. Consumers who unlocked pre-retraction retain the perpetual license per ToS §6.4.
- Implementation note: set a `retracted_at` column on the learning record; all read paths filter `WHERE retracted_at IS NULL` (or equivalent for JSON-backed storage).

---

## 6. Extraction Provider Seam

### 6.1 Interface

```js
// lib/providers/provider.interface.js
class ExtractionProvider {
  static id;                      // "anthropic" | "openai" | ...
  static defaultModel;

  async extract({ prompt, maxTokens, signal })
    // → { text, usage: {input_tokens, output_tokens}, model }

  async getQuotaState()
    // → { tokens_used_this_minute, tokens_remaining_this_minute }
}

class ProviderRateLimitError extends Error { retryAfterMs }
class ProviderUnavailableError extends Error {}
class ProviderAuthError extends Error {}
```

### 6.2 Anthropic implementation (`lib/providers/anthropic.js`)

**First refactor step:** extract the inline `fetch('https://api.anthropic.com/v1/messages', ...)` closure from `server.js:3939-3959` into this file as the full Anthropic implementation. Add:

- 429 handling: honor `retry-after` header, throw `ProviderRateLimitError`
- 5xx: throw `ProviderUnavailableError`
- 401/403: throw `ProviderAuthError`
- 404 with model name: fallback from `claude-sonnet-4-5-20250929` to `claude-sonnet-4-5`
- Timeout: respect `signal.abort()`, default 45s
- `getQuotaState()`: internal counter tracking input tokens consumed in the current UTC minute (client-side approximation of the org's 10k tok/min limit)

### 6.3 Selection config

New `model_config.json` entry:

```json
{
  "extraction": {
    "primary":   { "provider": "anthropic", "model": "claude-haiku-4-5" },
    "fallbacks": [
      { "provider": "anthropic", "model": "claude-sonnet-4-5" }
    ],
    "timeout_ms": 45000,
    "max_attempts_per_provider": 3,
    "cache_control": {
      "enabled": false,
      "blocks": ["system_prompt", "extraction_schema"]
    }
  }
}
```

**Default model: `claude-haiku-4-5`** ($1/$5 per MTok, 50k ITPM Tier 1 direct). Rationale: structured-extraction workload benefits more from schema-conformance than reasoning depth; cost is ~$13 per 1k extractions vs ~$39 on Sonnet 4.5; Tier 1 ITPM is 1.67× Sonnet. **Fallback model: `claude-sonnet-4-5`** — available automatically once Tyler files the Tier 2 upgrade (see §18); 450k ITPM provides 15× headroom insurance if Haiku quality degrades on edge-case transcripts. Model is a config value (`extraction.provider.model`) swappable without code change.

`cache_control.enabled = false` at launch; flagged for P2.1b optimization (CFO-1 noted 10-15% cost reduction opportunity).

### 6.4 Retry policy per attempt

- `ProviderRateLimitError` → sleep `retryAfterMs` (or 15s × attempt if header absent), retry up to 3
- `ProviderUnavailableError` → backoff 1s/4s/15s, retry up to 3
- `ProviderAuthError` → fail immediately, log, page ops (operational failure)
- All attempts exhausted on `primary` → fall through to `fallbacks[0]`, same retry budget
- All fallbacks exhausted → `502` to client with `extraction_id` for later retry via idempotency key

### 6.5 Provider quota pre-check

Before calling `provider.extract()`, invoke `provider.getQuotaState()`. If within 10% of org minute cap, return `503` with `Retry-After: 60` instead of queueing. This is the fix for P2.1's 30k-char cap workaround — the cap was a client-side hack for a missing server-side quota check.

---

## 7. Runner Rewrite (`scripts/runner.js`)

Replaces `scripts/extract-learnings.js`. Line count: ~200 (down from 492).

### 7.1 What survives

- Durable queue on disk (`~/.auxilo/pending-learnings/NNN-slug.json`) — write-before-POST, delete-on-success
- Session ledger (`~/.auxilo/extracted-sessions.json`), now keyed by `(source.id, session_id, transcript_sha256)`
- `--dry-run` / `--verbose` / `--force` flags
- Kill-switch sentinel `~/.auxilo/autonomous-enabled` check FIRST
- `--sweep` (polls all active sources for sessions since ledger high-water mark)
- `--flush-pending` (retries queue files)
- `--transcript <path>` (single-session mode, used by hooks)

### 7.2 What dies

- `callAnthropic()` at `extract-learnings.js:186-252` — LLM moves server-side
- `EXTRACTION_SYSTEM_PROMPT` at `:146-184` — belongs next to the extractor server-side
- `anthropic_api_key` field in `~/.auxilo/credentials.json`
- `passesQualityGate` / `validateLearning` duplicates — server enforces
- `submitLearning` POST to `/learn` — runner only talks to `/extract`
- `findRecentTranscripts` hardcoded to `~/.claude/projects` — replaced by adapter enumeration

### 7.3 What becomes thinner

Runner is now a **transport layer** with three responsibilities:

1. Enumerate active sources on host
2. For each new session: `source.readSession()` → client-side scrub → write queue file → POST `/extract`
3. On success: update ledger, delete queue file. On failure: leave queue file, bail.

### 7.4 Pseudocode

```js
async function main(opts) {
  if (!existsSync(`${HOME}/.auxilo/autonomous-enabled`)) return exit(0);
  if (process.env.AUXILO_EXTRACTING === "1") return exit(0);

  const creds = loadCredentials();  // no more anthropic_api_key field
  const ledger = loadLedger();
  const sources = await enumerateActiveSources();

  const sessions = [];
  if (opts.transcript) {
    // hook-fired single-session mode
    const source = detectSourceForPath(opts.transcript, sources);
    sessions.push({ source, ref: { path: opts.transcript } });
  } else {
    // sweeper mode
    for (const s of sources) {
      const discovered = await s.discoverSessions({ since: ledger.highWater(s.id) });
      sessions.push(...discovered.map(ref => ({ source: s, ref })));
    }
  }

  for (const { source, ref } of sessions) {
    const { transcript, metadata } = await source.readSession(ref);
    const { cleaned, report } = scrubAndVerify(transcript);  // fail-closed
    if (!cleaned) { log("scrub_fail"); continue; }

    const sha = sha256(cleaned);
    if (ledger.has(source.id, metadata.sessionId, sha)) continue;  // local dedup

    const queueFile = writeQueueFile({ source: source.id, sessionId: metadata.sessionId, transcript: cleaned, sha, report });

    if (opts.dryRun) { continue; }

    try {
      const res = await postExtract({ queueFile, creds, idempotencyKey: uuid() });
      ledger.mark(source.id, metadata.sessionId, sha);
      deleteQueueFile(queueFile);
      log(`published=${res.learnings_published} rejected=${res.learnings_rejected}`);
    } catch (err) {
      log(`upload_failed: ${err.message} — queue file retained`);
      // do not exit loop; try next session
    }
  }

  if (opts.flushPending) {
    for (const qf of listPending()) {
      try { await retryQueueFile(qf); } catch (_) { /* keep for next flush */ }
    }
  }
}
```

### 7.5 Client-side scrubber upgrade

Add `scanText(text) → { matches, redacted }` helper to `lib/sensitivity-filter.js`. Cleaner seam than abusing `scanLearning({body})`. The runner:

1. Reads raw transcript
2. Runs `scanText()`
3. If matches found, redact in-place using `getRedactionHint(pattern)` and re-scan
4. **Refuse to upload** if second pass still finds anything (fail-closed)
5. Attaches the scrub report (pattern NAMES + counts, never values) to `/extract` request

### 7.6 New scrubber patterns (RESOLVES GOV-3 HIGH #2)

Add to `lib/sensitivity-filter.js`:

1. Email regex — `[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}` — flag non-allowlisted domains
2. Phone numbers (E.164 + common US formats)
3. HTTP cookie headers — `Cookie:\s*\S+`, `Set-Cookie:\s*\S+`
4. `Authorization:` header any case
5. GCP service-account JSON — `"type":\s*"service_account"`
6. Azure storage SAS — `sig=[A-Za-z0-9%]{20,}`
7. GitHub fine-grained PATs — `github_pat_[A-Za-z0-9_]{80,}`
8. OpenAI project keys — `sk-proj-[A-Za-z0-9]{20,}`
9. **Anthropic keys** — `sk-ant-[A-Za-z0-9_\-]{20,}` (we host the marketplace; leaking these is a reputational nuke)
10. Discord bot tokens — `[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}`

Add normalization pass (URL-decode, strip whitespace inside likely-token windows) before regex match. Versioned via `SENSITIVITY_FILTER_VERSION` constant; server rejects extractions from clients older than N-1.

---

## 8. Compensating Controls Bundle (Cross-References)

| Control | Implementation | Source requirement |
|---|---|---|
| Client-side PII scrub pre-upload | `scripts/runner.js` + `lib/sensitivity-filter.js` `scanText()` | §7.5 |
| Server-side PII rescan | `/extract` handler step 1 | §5.1.1 |
| Category allowlist | `lib/extractor.js:43-46` VALID_CATEGORIES | §5.1.4 |
| URL allowlist + HTML strip | `sanitizeLearningBody()` | §5.1.6 |
| Durable versioned consent log | `data/extraction-consent.jsonl` | §3.5.3 |
| Audit log of every extraction | `data/audit-extractions.jsonl` | §9 |
| Daily digest email | New cron `jobs/daily-digest.js` | §9 |
| 7-day retraction right | `DELETE /learn/:id?reason=retract` | §5.2 |
| Kill-switch sentinel | `~/.auxilo/autonomous-enabled` | §7.4 |
| Server-side revocation switch | `account.autonomous_extraction_mode = "off"` | §3.5.4 |
| OFAC screen on /extract | Pre-provider `checkOFAC(wallet)` | §3.8 |
| Global $-breaker | Middleware daily spend counter | §3.6 |

---

## 9. Audit Log, Daily Digest, Retraction Sweeper

### 9.1 Audit log (`data/audit-extractions.jsonl`)

Append-only, hash-chained (GOV-3 §6 recommendation). Each entry:

```json
{
  "audit_id": "audit_01HW...",
  "prev_hash": "sha256:...",
  "entry_hash": "sha256:...",
  "ts": "2026-04-14T...",
  "account_id": "...",
  "consent_version": "2026-04-14",
  "action": "extract_attempt"|"publish"|"reject"|"retract",
  "source": {"type": "claude-code", "session_id": "..."},
  "transcript_sha256": "...",
  "transcript_length": 28447,
  "scrubber_version": "sensitivity-filter@0.3.1",
  "client_scrub_matches": ["api_token", "jwt_token"],
  "server_scrub_matches": [],
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "usage": {"input_tokens": 8041, "output_tokens": 1232},
  "cost_usd": 0.0426,
  "quality_pass_count": 2,
  "quality_fail_count": 1,
  "published_learning_ids": ["lrn_...", "lrn_..."],
  "mode": "automatic"
}
```

**Schema notes:** `consent_version: string | null` — ISO date of the consent grant row in force at extraction time; null only for rows where consent check failed before grant lookup.

**Never:** raw transcript, raw learning body, raw matched values. Metadata + hashes only.

**Retention:** 18 months operational; consent-version chain 7 years (per GOV-2).

**Read access:** admin scope only, never exposed via public API.

**Daily anchoring:** tail entry hash committed to a signed daily log (e.g., a private repo or Cloudflare KV) for tamper evidence. **Deferred to post-launch — not a blocker.**

### 9.2 Daily digest (`jobs/daily-digest.js`)

Runs daily at 09:00 UTC (configurable per account in the future). Emails the user:

- Count of extractions yesterday (attempted / published / rejected)
- Titles of published learnings with retraction-window deadlines
- Summary of rejections (count by reason, no content)
- Link to `/catalog/my-learnings` for review
- One-click unsubscribe (Scheduled/Manual mode users can disable digest)

Uses existing `mailersend` integration. Does NOT expose any `contributor_agent` metadata to recipients.

**Scheduled-mode users** see the digest as their primary review surface. Manual-mode users see per-item prompts via the MCP / builder dashboard separately.

### 9.3 Retraction window sweeper

Runs daily at 09:00 UTC alongside the digest:

- Finds all learnings with `published_at < now - 7d AND retraction_window_active = true`
- Flips `retraction_window_active = false`
- Emits audit-log entry `window_closed`
- Does NOT touch earnings, unlocks, or publication state

---

## 10. Rate Limits, Caps, and Circuit Breaker (Summary)

Cross-reference §3.6 for full detail. TL;DR:

| Guard | Value | Source |
|---|---|---|
| Per-account unverified daily | 50 | CFO-1 |
| Per-account verified daily | 200 | CFO-1 |
| Per-account trusted daily | 1,000 | CFO-1 |
| Burst all tiers | 5/min | CFO-1 |
| Hourly unverified | 30 | GOV-3 |
| Hourly verified | 60 | CFO-1 |
| Global soft alert | $25/day | CFO-1 |
| Global hard throttle | $50/day | CFO-1 |
| Global kill switch | $100/day | CFO-1 |
| Body size | 256 KB | GOV-3 |
| Transcript chars | 1,500–30,000 | existing + GOV-3 |
| Idempotency TTL | 24h | BUILD-1 |
| Max attempts per provider | 3 | BUILD-1 |

---

## 11. Drop-In Legal Prose (GOV-2 Deliverable)

### 11.1 ToS §5.9.3 — Autonomous Learning Extraction

**Drop-in replacement for current §5.9 restructure at `docs/TERMS-OF-SERVICE.md:160-167`.** Restructure as: existing §5.9 intro → existing bullets become §5.9.1 → third-party AI bullet promoted to §5.9.2 → new §5.9.3 and §5.9.4 below.

> ### 5.9.3 Autonomous Learning Extraction
>
> The Platform offers an autonomous extraction feature ("Autonomous Extraction") that allows Builders to enable continuous, hands-off generation of Learnings from their AI session transcripts. When enabled, supported client integrations transmit redacted session transcripts to Auxilo's `/extract` endpoint, where Auxilo's extraction pipeline analyzes the transcript and publishes qualifying Learnings to the catalog under the Builder's account. A current list of supported client integrations is maintained at https://auxilo.io/legal/supported-clients.
>
> **(a) Default behavior and trigger modes.** Autonomous Extraction is the Platform's default contribution mechanism for users who activate it. Builders may select among three trigger modes:
>
> - **Automatic** (default): transcripts are processed at the conclusion of each qualifying session.
> - **Scheduled**: transcripts are processed in batches on a recurring schedule selected by the Builder.
> - **Manual**: extraction runs only when the Builder explicitly invokes it.
>
> A Builder may change trigger modes or disable Autonomous Extraction at any time through the kill-switch mechanism described in subsection (e).
>
> **(b) Initial consent and continued use.** Autonomous Extraction is disabled by default and is activated only by an affirmative Builder action. At the moment of activation, the Builder's consent to the terms of this Section 5.9.3 is recorded in a durable, versioned consent log retained by Auxilo for the life of the account plus three (3) years. Subsequent updates to these Terms governing Autonomous Extraction take effect under the change-of-terms mechanism in Section 17, and the Builder's continued use of the feature after the effective date of any update constitutes acceptance of the updated terms. Auxilo will provide notice of material changes in the manner described in Section 17.
>
> **(c) Builder responsibility for transcript content; Auxilo compensating controls.** The Builder is solely responsible for the contents of any session transcript submitted under Autonomous Extraction, including any personally identifiable information, credentials, third-party data, or confidential information contained therein. The representations and warranties in Sections 5.7 and 5.8 apply to all transcripts submitted via Autonomous Extraction with the same force as if the Builder had manually uploaded them. As a compensating control and not as a substitute for Builder responsibility, Auxilo applies (i) a client-side redaction pass before transmission, (ii) a server-side sensitivity rescan on receipt, and (iii) a Platform-defined category allowlist constraining the topics on which Learnings may be autonomously published. These controls are reasonable precautions and not a guarantee.
>
> **(d) AI subprocessor.** Auxilo processes Autonomous Extraction transcripts using one or more third-party large language model providers acting as Auxilo's subprocessors. At the effective date of these Terms, the sole such subprocessor is **Anthropic, PBC**, accessed via the Claude API. Auxilo may add, replace, or remove subprocessors over time and will maintain a current list in the Privacy Policy and at https://auxilo.io/legal/subprocessors. By enabling Autonomous Extraction, the Builder authorizes Auxilo to transmit redacted transcript content to its current subprocessor(s) for the sole purpose of Learning extraction.
>
> **(e) Kill-switch and revocation.** A Builder may disable Autonomous Extraction at any time, by either (1) removing the local activation sentinel on the machine running the Builder's client, or (2) toggling Autonomous Extraction off in the Builder's account settings on auxilo.io. Either action halts further transmission of new transcripts and revokes Auxilo's authorization to process additional transcripts under this subsection. Disablement does not affect Learnings already published, the validity of Consumer unlocks already completed, or earnings already accrued. The retraction right in Section 5.9.4 governs removal of already-published Learnings.
>
> **(f) Audit log.** Auxilo retains an audit log of each Autonomous Extraction event — including session identifier hash, trigger mode, timestamp, subprocessor invoked, quality-gate result, and publication or rejection outcome — for a period of three (3) years.

### 11.2 ToS §5.9.4 — Retraction Right and Earnings Finality

> ### 5.9.4 Retraction Right; No Clawback of Completed Unlocks
>
> **(a) Seven-day retraction window.** A Builder may retract any Learning published via Autonomous Extraction for a period of seven (7) calendar days following its publication date. Retraction is effected by request through the Platform's catalog management interface or by email to hello@auxilo.io identifying the Learning. Upon a valid retraction request, Auxilo will remove the Learning from public discovery, search results, and the catalog API within a commercially reasonable time.
>
> **(b) After the retraction window.** Following the seven-day window, autonomously-published Learnings are subject to the same removal mechanisms as any other published Learning, including the DMCA/notice-and-takedown processes referenced in Section 5 and Section 9.
>
> **(c) No clawback; no refund.** Retraction removes a Learning from the catalog on a forward-going basis only. It does **not** reverse, refund, or unwind any unlock transaction completed prior to retraction. Consumers who unlocked the Learning before retraction retain the perpetual license described in Section 5.3 and Section 6.4. Builder earnings already accrued from pre-retraction unlocks remain payable on the normal settlement schedule and are not subject to clawback.
>
> **(d) Relationship to transaction finality.** This subsection is consistent with, and does not alter, the transaction-finality rule in Section 7.3.

### 11.3 Tyler's ratified changes to GOV-2's draft

Per Tyler's 2026-04-14 review:
- **§5.9.3 opening paragraph** — specific client names ("Claude Code and OpenClaw") STRIPPED from ToS, replaced with reference to `https://auxilo.io/legal/supported-clients`. Names can still be used in public marketing/blog as "use cases, not logos." Rationale: avoid ToS churn every time a new client is added, avoid trademark-caveat pollution.
- **§5.9.3(b) continued-use sentence** — RATIFIED as drafted.
- **§5.9.3(c) "reasonable precautions and not a guarantee"** — RATIFIED as drafted (implicit approval, no pushback).

### 11.4 Privacy Policy amendments

Apply GOV-2's drafted edits to:
- `docs/PRIVACY-POLICY.md` §1.2 — add autonomous extraction transcripts bullet
- `docs/PRIVACY-POLICY.md` §3.8 — replace Anthropic row, add subprocessor-page reference
- `docs/PRIVACY-POLICY.md` §4 — add 3 rows to retention table
- `docs/PRIVACY-POLICY.md` §7 — add new §7.5 LLM providers
- `docs/PRIVACY-POLICY.md` §8.3 — add disablement-clarification bullet

Full drop-in prose is in the GOV-2 brief; reproduced here by reference to avoid duplication.

### 11.5 New files

- `docs/SUBPROCESSORS.md` — rendered at `/legal/subprocessors`, matches `/terms` and `/privacy` markdown-rendering pattern per `docs/INDEX.md:192-193`. Initial entries: Anthropic, Stripe, Coinbase. Include forward-looking multi-LLM note.
- `docs/SUPPORTED-CLIENTS.md` — rendered at `/legal/supported-clients`. Initial entries: Claude Code (Anthropic), OpenClaw (open-source, Peter Steinberger). Trademark footnote. Update-in-place on each new adapter.
- Both added to `docs/INDEX.md` §10 Legal & Compliance.

### 11.6 R-21 drop-in for `docs/RISK-REGISTER.md`

Append to risks table (`docs/RISK-REGISTER.md:24-45`):

> | R-21 | **Autonomous Extraction residual compliance risk** — Despite the client-side scrub, server-side rescan, category allowlist, and 7-day retraction window, an autonomously-published Learning could (a) leak PII or third-party confidential content that defeated both scrubbers, (b) be poisoned by an adversarial transcript designed to publish defamatory or malicious content under the Builder's identity, or (c) attract regulatory scrutiny over the lawful basis for forwarding session transcripts to third-party LLM subprocessors, particularly in EEA/UK jurisdictions where consent must be unambiguous and revocable | Legal/Regulatory | M | M | **MEDIUM** | Defense in depth: client-side PII scrubber pre-upload + server-side PII rescan + category allowlist + durable versioned consent log + audit log + daily digest email + 7-day Builder retraction right (ToS §5.9.4). Subprocessor disclosure in PP §3.8 / §7.5 and at /legal/subprocessors. Continued-use-after-notice consent posture per ToS §17 backed by an explicit revocation mechanism (kill-switch + account setting). Quarterly review of false-negative rate on PII rescan; if rate exceeds 0.5% of published autonomous Learnings, escalate. | 🟡 In Progress | Legal/Engineering |

Change-log entry:
> | 2026-04-14 | R-21 added: Autonomous Extraction residual compliance risk. Added concurrent with P2.1a sign-off per GOV-2 re-review. | GOV-2 |

Summary-table math: Legal/Regulatory count 5→6, Medium count for Legal/Regulatory 3→4, totals 20→21 and 8→9.

---

## 12. File Inventory

### 12.1 New files

| Path | Role |
|---|---|
| `scripts/runner.js` | Replaces `scripts/extract-learnings.js` — thin transport layer (~200 lines) |
| `scripts/sources/source.interface.js` | TranscriptSource base/docs |
| `scripts/sources/claude-code.js` | Claude Code adapter |
| `scripts/sources/openclaw.js` | OpenClaw adapter (poll-only v1) |
| `lib/providers/provider.interface.js` | ExtractionProvider base + error classes |
| `lib/providers/anthropic.js` | Anthropic implementation (extracted from server.js:3939-3959) |
| `data/extractions.jsonl` | Idempotency ledger (AdapterState pattern) |
| `data/extraction-consent.jsonl` | Versioned consent log |
| `data/extraction-review.jsonl` | Scheduled/Manual review queue |
| `data/audit-extractions.jsonl` | Hash-chained audit log |
| `data/extract-cap-overrides.json` | Per-account override config (CFO-1 reviewed) |
| `jobs/daily-digest.js` | Daily digest + retraction sweeper cron |
| `ops/extract-spend-report.js` | CFO-1 daily spend email cron |
| `docs/SUBPROCESSORS.md` | Public subprocessor list |
| `docs/SUPPORTED-CLIENTS.md` | Public supported-clients list |

### 12.2 Modified files

| Path | Change |
|---|---|
| `server.js` | Rewire `/extract` handler (lines ~3909-3982); add `DELETE /learn/:id?reason=retract`; add `PATCH /account/settings` for mode + revocation; add middleware hooks for dollar-breaker, idempotency, consent-check |
| `lib/sensitivity-filter.js` | Add `scanText()` helper; add 10 new patterns; add normalization pass; bump `SENSITIVITY_FILTER_VERSION` |
| `lib/extractor.js` | Add `sanitizeLearningBody()` URL allowlist + HTML strip. Export pure `scoreLearning(learning, config)` helper for regression corpus. Signature: `scoreLearning(learning, config = {}) → { total, dimensions: {specificity, actionability, novelty, completeness}, passed, failed_reason: null \| 'below_total' \| 'below_dimension:<name>', threshold, min_dimension }`. Thin wrapper over existing quality-gate logic; no LLM call, no I/O. ~15 LOC. |
| `model_config.json` | Add `extraction` section |
| `docs/TERMS-OF-SERVICE.md` | §5.9 restructure + new §5.9.3 / §5.9.4 |
| `docs/PRIVACY-POLICY.md` | §1.2, §3.8, §4, §7.5, §8.3 amendments |
| `docs/RISK-REGISTER.md` | R-21 + change log + summary table |
| `docs/INDEX.md` | Add SUBPROCESSORS.md, SUPPORTED-CLIENTS.md; mark P2.1 superseded |
| `docs/RUNBOOK.md` | Kill-switch ops, daily-digest worker, retraction CLI, tier-upgrade runbook |
| `AGENT-LEARNING-GUIDE.md` | §3 rewrite for three-mode architecture |
| `PUNCH-LIST.md` | Add P2.1a line; add legacy-backlog line; add FOUNDATION.md prereq |
| `TASKS.md` | P2.1a phase entry + legacy-backlog task |
| `openapi.json` | `/extract` shape, `/extract/review/*`, `DELETE /learn/:id`, `PATCH /account/settings` |
| `~/.claude/hooks/auxilo-extract.sh` | Replace nohup spawn with local curl to runner's control socket |
| `~/.claude/settings.json` | No change (existing hook registration is correct) |
| `~/Library/LaunchAgents/io.auxilo.sweeper.plist` | No change (wrapper still correct) |
| `auxilo/scripts/auxilo-sweeper-wrapper.sh` | Remove `~/.zshrc` sourcing (credentials via `credentials.json` only, per GOV-3) |

### 12.3 Deprecated files

| Path | Disposition |
|---|---|
| `scripts/extract-learnings.js` | Replaced by `scripts/runner.js` — delete after GO |
| `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md` | Mark superseded, banner line + INDEX update, keep for history |
| `anthropic_api_key` field in `~/.auxilo/credentials.json` | Ignored by runner; cleanup optional |

---

## 13. Open Questions / Deferred

| # | Question | Route | Blocking? |
|---|---|---|---|
| Q1 | OpenClaw plugin API stability for live `session_end` hooks | SPEC-2 follow-up after launch | No — v1 uses polling |
| Q2 | **RESOLVED: per-account.** Cross-account dedup creates an attribution oracle (attacker can infer "Builder X processed session Y" by watching dedup responses → privacy leak) and silently strips earnings from legitimate shared-machine collisions. Storage cost is identical since the ledger is already keyed by `(account_id, session_id, transcript_sha256)`. Inline note added to §3.7 step 2. | BUILD-1 2026-04-14 | Closed |
| Q3 | Audit log retention >18 months — legal requirement vs. cost | GOV-2 + GOV-3 joint | No — 18mo set, revisit |
| Q4 | Anthropic key → secrets manager migration | GOV-3, pre-second-provider | No — env var OK for launch |
| Q5 | Daily digest content + CASL posture | SPEC-3 + GOV-2 | No — soft-launch email, iterate |
| Q6 | Hash-chain daily anchoring implementation | GOV-3 post-launch | No — deferred |
| Q7 | Prompt-caching for extraction system prompt (10-15% cost) | CFO-1 / BUILD-1, P2.1b | No — optimization |
| Q8 | N=500 re-calibration review | CFO-1 + BUILD-4 joint | No — post-launch trigger |

---

## 14. Dependencies & Prerequisites

**Hard prerequisites (block merge):**

1. **Anthropic org tier upgrade** — current 10k tok/min Sonnet 4.5 cap → ~900 extractions/day ceiling. Insufficient for real launch traffic. **Tyler action required before merge.** See §18.
2. **Server-side revocation switch** (GOV-2 HIGH #1) — `PATCH /account/settings` + `autonomous_extraction_mode` field. Built as part of this spec.
3. **`/legal/subprocessors` page live** (GOV-2 HIGH #2) — `docs/SUBPROCESSORS.md` + routing. Built as part of this spec.
4. **GOV-3 BLOCKERS B1–B4 resolved** — all addressed in §3 (auth, body-size, zero persistence, consent record).

**Soft prerequisites (block GA, not merge):**

5. `docs/CONSENT-POLICY.md` — per GOV-2 NEW CONCERN A, document scope-expansion re-consent rule for future changes.
6. FOUNDATION.md creation — P0 governance defect independent of P2.1a, tracked separately.
7. Public-copy Stripe minimums fix — BUILD-3 side task, post-launch.
8. Legacy 4-learning backlog flush — per GOV-1, manual out-of-band, not blocked on P2.1a.

---

## 15. Deployment Gate & Sequence

### 15.1 Review gates required

**Gate A (every deploy):** BUILD-1 self-review against delivered code, BUILD-4 QA sign-off, GOV-3 security sign-off against delivered code (verify B1-B4 resolved), GOV-1 doc-governance sign-off.

**Gate B (scope-triggered):** GOV-2 Compliance (ToS/PP/subprocessor pages live), SPEC-2 Agent UX (runner API + OpenClaw adapter review), SPEC-3 Builder UX (mode settings + daily digest review).

**Gate C (post-launch):** CFO-1 + BUILD-4 N=500 re-calibration review; CAT-1 catalog-health review at 30d.

### 15.2 Deploy sequence (after all gates pass)

```bash
# 1. Anthropic tier upgrade confirmed (Tyler action, §18)
# 2. Merge Antigravity's implementation to main
# 3. Deploy server.js (new /extract handler, middleware, consent table)
# 4. Publish docs: TOS, PP, SUBPROCESSORS.md, SUPPORTED-CLIENTS.md, INDEX.md
# 5. Verify legal pages render at /terms, /privacy, /legal/subprocessors, /legal/supported-clients
# 6. Smoke test /extract with a verified account and a tiny transcript (automatic mode OFF)
# 7. Enable autonomous mode for Tyler's account only via PATCH /account/settings
# 8. Touch ~/.auxilo/autonomous-enabled on Tyler's machine
# 9. Load launchd agent
launchctl load ~/Library/LaunchAgents/io.auxilo.sweeper.plist
# 10. Watch logs
tail -f ~/.auxilo/extract.log
# 11. After 24h green: enable for 3 additional pilot Builders
# 12. After 72h green: publish for all verified accounts (GA)
# 13. Start 30-day GA monitoring window; CFO-1 N=500 trigger fires automatically
```

**Legacy 4-learning backlog is NOT handled by this spec.** Per GOV-1 decision, Tyler manually flushes them out-of-band under `contributor_agent: auxilo-extract-slash/1` before or after this deploy — independent timeline.

### 15.3 Runbook additions

Appended to `docs/RUNBOOK.md` as part of this spec's doc-impact bundle:

- **Reset $100/day kill switch** (after Tyler acknowledges an incident): `node scripts/admin.js extract:reset-kill-switch --reason "<incident-summary>" --acknowledged-by tyler`. Writes audit row `action="kill_switch_reset"`. Verify route returns 200 after: `curl -X POST https://auxilo.io/extract -H "X-API-Key: $KEY" -d '{"ping":true}'`.

---

## 16. QA Checklist Seeds (for BUILD-4)

BUILD-4 will author the full test suite; these are the load-bearing cases Antigravity must not break:

- [ ] `/extract` with no `X-API-Key` → `401`
- [ ] `/extract` with key for account lacking consent record → `403 consent_required`
- [ ] `/extract` with `autonomous_extraction_mode="off"` → `403 disabled`
- [ ] `/extract` with sanctioned wallet → `403 ofac_blocked`, no LLM call
- [ ] `/extract` with body > 256 KB → `413`
- [ ] `/extract` with body using `Transfer-Encoding: chunked` to exceed 256 KB → still `413`
- [ ] `/extract` with JSON nested >10 levels → `400`
- [ ] `/extract` with `transcript_sha256` mismatch → `400`
- [ ] `/extract` with `source.type` outside allowlist → `400`
- [ ] `/extract` with `contributor_wallet` in body → field ignored, wallet resolved from account
- [ ] Duplicate `Idempotency-Key` within 24h → returns cached response, no LLM call
- [ ] Duplicate `(account_id, session_id, transcript_sha256)` within 24h → same
- [ ] Transcript containing `sk-ant-...` → client refuses to upload (fail-closed)
- [ ] Transcript containing email address → redacted client-side
- [ ] Transcript containing GCP service-account JSON → redacted
- [ ] Server receives transcript that passed client scrub but still contains pattern → `422 sensitivity_fail`
- [ ] Verified account hits hourly cap → `429 Retry-After`
- [ ] Verified account hits daily cap → `429 Retry-After`
- [ ] Burst cap (5/min) hit → `429`
- [ ] Global $25/day threshold → CFO-1 email sent, serving continues
- [ ] Global $50/day threshold → `503 Retry-After: 3600`, page emitted
- [ ] Global $100/day threshold → route disabled, page to Tyler
- [ ] Provider 429 → retry with header-specified delay, succeed
- [ ] Provider 5xx ×3 → fallback to secondary model, succeed
- [ ] Provider 401 → fail immediately, page ops
- [ ] Automatic mode → learning appears in catalog, `retraction_window_active=true`
- [ ] Scheduled mode → learning appears in `extraction-review.jsonl`, NOT in catalog
- [ ] Manual mode → same as Scheduled
- [ ] `DELETE /learn/:id?reason=retract` within 7d → removed from catalog, earnings untouched
- [ ] `DELETE /learn/:id?reason=retract` day 8 → returns 409 / falls through to standard takedown
- [ ] Retraction sweeper flips `retraction_window_active=false` at day 7
- [ ] Runner with no kill-switch sentinel → exits 0, no side effects
- [ ] Runner with `AUXILO_EXTRACTING=1` → exits 0 (loop guard)
- [ ] Runner `--dry-run` → nothing queued, nothing POSTed, nothing logged to ledger
- [ ] Runner queue file survives POST failure, retries on next `--flush-pending`
- [ ] Runner `--flush-pending` with invalid JSON → logs, continues
- [ ] Audit log: no raw transcript, no raw body, no raw matched values
- [ ] Audit log: `prev_hash` chain intact across 100 consecutive entries
- [ ] Consent revocation via `PATCH /account/settings` halts in-flight extraction (result suppressed, not published)

---

## 17. NOT Built (Deliberate)

- **No live OpenClaw hook** — poll-only v1 pending SPEC-2 plugin API confirmation (§4.3)
- **No prompt caching** — flagged for P2.1b (§6.3)
- **No hash-chain daily anchoring** — deferred post-launch (§9.1)
- **No ML-based PII classifier** — regex-only sufficient for launch bar (GOV-3 §5)
- **No per-builder extraction microfee** — violates earnings-flow lock (CFO-1 §7)
- **No clawback on retraction** — violates earnings-flow lock (§5.2)
- **No UI for review queue beyond daily digest** — SPEC-3 post-launch scope
- **No 30-day consent re-affirmation** — overruled per continued-use-after-notice lock (§1.2.4)
- **No secrets manager migration** — deferred to pre-second-provider milestone (GOV-3 HIGH #5)

---

## 18. Tyler Action: Anthropic Tier Upgrade

**Primary path: Haiku 4.5 direct** (default per §6). ~$13 per 1k extractions, 50k ITPM Tier 1, one-line model config. No tier upgrade strictly required for launch at Tyler's pilot volume.

**Insurance: File Tier 2 upgrade** ($40 credit purchase + form at [anthropic tier form URL]). Yields 450k ITPM on Sonnet 4.5 — a 15× headroom insurance policy. If Haiku quality degrades on edge-case transcripts, the Sonnet fallback is already provisioned and swappable via config. Zero code change, zero subprocessor addition, zero DPA. Filing the form is cheaper in hours-of-Tyler-time than any multi-provider alternative.

**Alternatives considered and rejected:** Bedrock (new-account 0-TPM provisioning risk, +DPA burden), Vertex (no published baseline quota), GPT-5/Gemini fallbacks (new subprocessor disclosure each, schema-conformance unverified), Batch API (24h async latency breaks real-time /extract contract). Full rate-limit brief: see session 2026-04-14 research agent output.

---

## 19. Sources

**Repo evidence cited:**
- `scripts/extract-learnings.js:186-252` — direct Anthropic call being removed
- `scripts/extract-learnings.js:120-142` — JSONL parsing to reuse in Claude Code adapter
- `scripts/extract-learnings.js:404-423` — transcript discovery logic
- `scripts/extract-learnings.js:43-46` — old 30k-char cap rationale
- `server.js:725` — instant-credit earnings write (UNCHANGED)
- `server.js:1776-1847` — X-API-Key auth pattern (canonical)
- `server.js:3566-3900` — `/learn` write path (reused via publishLearnings)
- `server.js:3909-3982` — existing `/extract` handler (to be rewired)
- `server.js:3939-3959` — inline Anthropic fetch closure (to be extracted into provider)
- `server.js:~3648` — `checkOFAC` call site in `/learn`
- `server.js:93` — global 100KB MAX_BODY_SIZE (to be reconciled)
- `server.js:106-111` — onError handler (must scrub err.stack on /extract path)
- `lib/earnings.js:35-49` — earnings schema (UNCHANGED)
- `lib/extractor.js:1-14` — pipeline interface with injected llmCall
- `lib/extractor.js:43-46` — VALID_CATEGORIES allowlist
- `lib/extractor.js:386` — scanLearning integration
- `lib/sensitivity-filter.js:21-103` — 14 existing patterns
- `lib/sensitivity-filter.js:107-109` — fail-closed /g invariant
- `lib/sensitivity-filter.js:181-184` — redactMatch
- `lib/openclaw-adapter.js:62-187` — AdapterState JSONL append-only ledger pattern
- `docs/INDEX.md:192-193` — markdown-rendering pattern for /terms /privacy
- `docs/TERMS-OF-SERVICE.md:160-167` — existing §5.9 to restructure
- `docs/PRIVACY-POLICY.md:30, :154, :166-176, :247-249, :268-272` — PP sections to amend
- `docs/RISK-REGISTER.md:24-45, :51-58, :88-93` — R-21 drop-in target
- `docs/FINANCIAL-PLAN.md:22, :36-37, :145, :177, :188` — COGS context
- `PRICING-STRATEGY-V2.md:122-124, :286-291, :406-430` — launch pricing assumptions
- `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md` — superseded predecessor

**External sources cited:**
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing (Sonnet 4.5 $3/$15 per MTok)
- Anthropic commercial terms: https://www.anthropic.com/legal/commercial-terms (no training on API content)
- OpenClaw session storage: https://deepwiki.com/openclaw/openclaw/2.4-session-and-state-management
- OpenClaw repo: https://github.com/openclaw/openclaw
- Fair Housing Council v. Roommates.com, LLC, 521 F.3d 1157 (9th Cir. 2008) (en banc)
- Jones v. Dirty World, 755 F.3d 398 (6th Cir. 2014)
- GDPR Art. 7 (consent), Art. 13(1)(e) (processor disclosure)
- CCPA §1798.100(b)
- §230(c)(1), §230(c)(2) Communications Decency Act

---

**End of BUILD-SPEC-P2.1a. Ready for Tyler GO → Antigravity implementation → Gate A + B review → merge → publish docs → Tyler pilot → 72h soak → GA.**
