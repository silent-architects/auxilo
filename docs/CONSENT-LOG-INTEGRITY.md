# Consent Log Integrity — P2.1a

> Technical documentation for the extraction consent log architecture, audit chain integration, and verification procedures.

---

## Source of Truth

The **consent log** is the authoritative source of truth for extraction consent state:

```
data/extraction-consent.jsonl
```

This is an append-only JSONL file. Each line is a JSON object recording a consent action:

```json
{
  "account_id": "acc_...",
  "action": "grant",
  "consent_version": "2026-04-17",
  "ts": "2026-04-17T17:00:00.123Z"
}
```

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `account_id` | string | Account that granted/revoked consent |
| `action` | string | `grant` or `revoke` |
| `consent_version` | string | ISO timestamp — new version created on every state change |
| `ts` | string | When the action was recorded |

### Reading consent state

```js
const { getConsentState } = require('./lib/extraction-consent-reader');

// Normal read (uses in-memory cache)
const state = getConsentState(accountId);

// Force-reload from disk (for in-flight rechecks)
const freshState = getConsentState(accountId, { forceReload: true });
```

`getConsentState` returns the **last** consent row for the account, or `null` if no consent has ever been recorded. The `forceReload` option bypasses the in-memory cache and re-reads the JSONL file — used during the `/extract` handler's Step 15 consent recheck to catch mid-request revocations.

---

## Audit Chain Integration (B19)

Every consent action is also written to the **hash-chained audit log**:

```
data/audit-extractions.YYYY-MM.jsonl
```

When `appendConsent()` writes a consent row to the consent log, it also calls `appendAuditRow()` with:

- `action: 'consent_grant'` or `action: 'consent_revoke'`
- `account_id`: the account
- `consent_version`: the version from the consent row

### Consent exemption

`consent_grant` and `consent_revoke` actions are exempt from the `consent_version` hard assertion in `appendAuditRow`. This prevents a bootstrap paradox — a `consent_grant` row IS the consent stamp; requiring a prior consent version to write it would create a circular dependency.

The exemption list in `lib/extraction-audit-writer.js`:

```js
const CONSENT_VERSION_EXEMPT = ['kill_switch_reset', 'consent_grant', 'consent_revoke'];
```

`retract` is **not** in this list — retraction requires a valid consent version because the user must be authenticated and have an existing consent record.

### Dual-write architecture

```
appendConsent(accountId, action)
  ├── writes to data/extraction-consent.jsonl  (source of truth for reads)
  └── calls appendAuditRow(...)                (immutable history, hash-chained)
```

The consent log is the read path. The audit log is the integrity path. Both must agree — `audit:verify` checks the hash chain, and any consent event missing from the audit log indicates tampering or a write failure.

---

## Verification

### Verify audit chain integrity

```bash
node scripts/admin.js audit:verify
```

This walks all `data/audit-extractions.YYYY-MM.jsonl` files chronologically and verifies:

1. Each row's `prev_hash` matches the `entry_hash` of the previous row.
2. Each row's `entry_hash` is a valid SHA-256 of the row content.
3. The chain is unbroken across monthly file boundaries.

Output:

```
[audit:verify] Checking chain integrity...
[audit:verify] Files checked: 3
[audit:verify] Rows verified: 247
[audit:verify] ✅ Chain is valid. No integrity errors found.
```

Or on failure:

```
[audit:verify] ❌ Chain integrity errors found:
  Row 42 in audit-extractions.2026-04.jsonl: prev_hash mismatch
    Expected: abc123...
    Found:    def456...
```

### Verify consent state for an account

```bash
# Read the last consent row for an account
grep "acc_ACCOUNT_ID" data/extraction-consent.jsonl | tail -1 | jq .
```

### Verify consent events appear in audit chain

```bash
# Find consent events in the audit log
grep '"consent_grant"\|"consent_revoke"' data/audit-extractions.*.jsonl | jq .action
```

---

## File Rotation

Audit log files are rotated monthly:

```
data/audit-extractions.2026-04.jsonl
data/audit-extractions.2026-05.jsonl
```

The hash chain spans across files — the last hash of month N is the `prev_hash` of the first row of month N+1. The `verifyAuditChain()` function walks files in chronological order to verify cross-file continuity.

The consent log (`extraction-consent.jsonl`) is **not** rotated — it is append-only and serves as the permanent source of truth. It is typically small (one row per consent state change per account).
