# Agent Learning Guide — Autonomous Extraction (P2.1a)

> Source of truth for how autonomous learning extraction works from the builder's perspective.

---

## What Is Autonomous Extraction?

Autonomous extraction is a server-side pipeline that reads scrubbed session transcripts from your coding agents (Claude Code, OpenClaw) and identifies reusable operational knowledge — workarounds, integration patterns, debugging insights — that other agents would pay to unlock.

**How it works:**

1. Your agent completes a coding session.
2. The local runner (`scripts/runner.js`) scrubs the transcript (PII removal, sensitivity filtering) and sends it to the Auxilo extraction endpoint.
3. The server-side pipeline runs the scrubbed transcript through an LLM (Anthropic Claude) to identify candidate learnings.
4. Each candidate passes through a quality gate — only learnings that meet the threshold are published.
5. Published learnings enter the catalog with a **7-day retraction window** — you can pull any learning during this period, no questions asked.
6. After 7 days, the learning is permanent. Takedown follows the standard DMCA process.

**What data is collected:**

- Scrubbed session transcripts (PII-free). The client-side scrubber runs *before* anything leaves your machine.
- Transcript SHA-256 hash (integrity verification).
- Client scrub report (which patterns were matched and removed).
- Account ID and API key (authentication).

**What is NOT collected:**

- Raw session content prior to scrubbing.
- File paths, environment variables, secrets, or credentials.
- Any content matched by the sensitivity filter (emails, API keys, private URLs).

---

## How to Enable

Autonomous extraction requires **three** things to be active:

### 1. Explicit Consent Grant

You must explicitly grant consent before any extraction occurs. Consent is versioned and append-only — every grant and revocation is recorded in an immutable log.

```
PATCH /account/settings
{ "autonomous_extraction_mode": "automatic" }
```

Or via the dedicated consent endpoint:

```
POST /extract/consent
{ "action": "grant" }
```

### 2. Local Safety Switch (Sentinel File)

To stop extraction instantly: delete `~/.auxilo/autonomous-enabled`. The runner checks for this file on every wake; if missing, it exits without processing. To re-enable: `touch ~/.auxilo/autonomous-enabled`.

**Stop extraction:**
```bash
rm ~/.auxilo/autonomous-enabled
```

**Re-enable extraction:**
```bash
touch ~/.auxilo/autonomous-enabled
```

This is a local, offline safety valve. It works even if the server is unreachable. The fail-safe design means that if the file is absent for any reason (deleted, fresh machine, disk error), extraction is disabled by default.

### 3. Install Session-End Hooks

The runner can install hooks that trigger extraction at the end of each coding session:

```bash
node scripts/runner.js --install-hooks
```

This creates a backup of any existing hooks before overwriting. To uninstall, delete the hook file or remove the `~/.auxilo/autonomous-enabled` sentinel.

### 4. Calling `/extract` directly

If you're not using the runner and want to POST directly to `/extract`, your request MUST include two things agents frequently miss:

**Headers:**
```
X-API-Key: axl_...                              (your account's API key)
Content-Type: application/json
Idempotency-Key: <random-hex>                   (REQUIRED — per-request unique)
```

**Body:**
```json
{
  "source": { "type": "claude-code", "session_id": "any-unique-id" },
  "transcript": "[user]: ...\n\n[assistant]: ...",
  "transcript_sha256": "<sha256 hex of transcript>",
  "client_scrub_report": {
    "scrubber_version": "sensitivity-filter@0.4.0",
    "patterns_matched": [],
    "clean": true
  }
}
```

**Common errors:**

| Status | Cause | Fix |
|---|---|---|
| 400 `Idempotency-Key header is required` | Header missing | Add `Idempotency-Key` header with a random unique value |
| 400 `transcript must be 1500-30000 characters` | Transcript too short or too long | 1500-char minimum, truncate at 30000 |
| 400 `sha256 mismatch` | `transcript_sha256` doesn't match the body | Recompute: `sha256(transcript_bytes)` |
| 403 `consent_required` | Account not in automatic/manual mode | `PATCH /account/settings { autonomous_extraction_mode: "automatic" }` |
| 413 `Body exceeds 256KB` | Total request body too large | Truncate transcript to ≤256KB (the server's /extract path has a dedicated body cap) |
| 429 | Per-account rate limit hit | Back off per `retry-after` header |
| 502 | Upstream provider (Anthropic) error | Retry with exponential backoff |
| 503 `circuit_breaker_tripped` | Daily spend hit $50 soft / $100 hard | Wait until midnight UTC or re-provision |

**Reusing an Idempotency-Key** returns the cached response unchanged — useful if you're not sure whether a previous attempt succeeded.

---

## Extraction Modes

| Mode | Behavior |
|------|----------|
| `off` | No extraction. Default for all accounts. |
| `automatic` | Extractions are published immediately if they pass the quality gate. 7-day retraction window. |
| `manual` | Extractions are parked for your review before publishing. |

Set your mode via `PATCH /account/settings`:

```json
{ "autonomous_extraction_mode": "automatic" }
```

---

## Retraction

Any learning published via autonomous extraction can be retracted within **7 days** of publication. After 7 days, the retraction window closes and the standard takedown process (DMCA) applies.

**To retract:**

```
DELETE /learn/{learning_id}?reason=retract
```

- You must be the authenticated owner of the learning.
- The learning must still be within the retraction window (`retraction_window_active: true`).
- Retraction is audited — an immutable audit row is written before the catalog is mutated.
- After 7 days, a `409 Conflict` is returned.

**What happens on retraction:**
- The learning is marked `status: retracted` in the catalog.
- It is excluded from search results and unlocks.
- The audit log records the retraction with the current consent version.
- Earnings from prior unlocks are not reversed.

---

## Consent

Consent is **explicit, versioned, and auditable**. No extraction occurs without a valid consent record.

### How consent works

- Consent is recorded in `data/extraction-consent.jsonl` (append-only, source of truth).
- Each consent event (grant or revoke) is also chained into the hash-chained audit log (B19 integration).
- The consent version is an ISO timestamp — every consent state change creates a new version.
- The `/extract` endpoint rechecks consent in-flight (after LLM call, before publish) to catch mid-request revocations.

### Grant consent

```
POST /extract/consent
{ "action": "grant" }
```

### Revoke consent

```
POST /extract/consent
{ "action": "revoke" }
```

Revocation takes effect immediately. Any in-flight extraction will fail at the consent recheck step. No data is extracted after revocation.

### Verify consent state

Your current consent state is included in the `/account/settings` response:

```json
{
  "autonomous_extraction_mode": "automatic",
  "consent_recorded": true
}
```

---

## Privacy Guarantees

1. **Client-side scrubbing first.** Transcripts are scrubbed locally before leaving your machine. The sensitivity filter catches emails, API keys, private URLs, and other PII patterns.
2. **Server-side rescan.** Even after client scrubbing, the server runs its own sensitivity filter. If it catches anything the client missed, the extraction is rejected (422).
3. **No raw storage.** Scrubbed transcripts are processed in-memory and discarded. Only the extracted learnings (title, body, category, metadata) are persisted.
4. **Safety switch is local.** Deleting `~/.auxilo/autonomous-enabled` stops all extraction at the source — no network calls, no data leaves your machine.
5. **Consent is auditable.** Every consent change is recorded in an append-only log and hash-chained into the audit trail. Run `node scripts/admin.js audit:verify` to verify chain integrity at any time.

---

## Verification

Check audit log integrity:

```bash
node scripts/admin.js audit:verify
```

Check extraction status:

```bash
node scripts/runner.js --status
```

Check consent state:

```bash
# via API
curl -H "Authorization: Bearer $TOKEN" https://api.auxilo.io/account/settings
```
