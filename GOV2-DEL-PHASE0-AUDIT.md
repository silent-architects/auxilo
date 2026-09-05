# GOV2-DEL Phase 0 — Persistent-Store Audit

**Pinned base:** `73f6e7726f7ffa5fcb7b0a382ec7ef06993c4993` (`73f6e77`)

**Scope.** This is an implementation-blocking inventory of every durable `data/`
store written by the server or a server-loaded library at the pinned base. It was
derived from the storage constants and write calls in `server.js`, then expanded
through server-loaded libraries and the retraction/admin paths. It is not a
deletion implementation and makes no store mutation.

**Class key.** A = remove at execution; B = retain under the served §4 exception;
C = the new deletion-completion record. “Ruling” means the row cannot be safely
implemented until the PM resolves the stated disposition.

## Inventory and proposed disposition

| Store | Linkability and data held | Proposed class / execution disposition | Evidence |
|---|---|---|---|
| `data/learnings.json` | `contributor_account_id` and `contributor_wallet`; full titles, bodies, tags, private bodies, status/visibility and metadata. | **A.** Remove every row on either verified axis, regardless of status or visibility. | `server.js:451`, `server.js:5805-5829`, `server.js:6280-6281` |
| `data/accounts.json` | Map keyed by account id; account has email, API-key records, linked wallet, settings, and legacy/current ToS-assent fields. | **A.** Remove the account map entry, including API keys/settings/wallet linkage/ToS fields; legacy grant shapes must tolerate absent `grantor`. | `lib/accounts.js:39`, `lib/accounts.js:245-258`, `lib/accounts.js:296-307` |
| `data/magic_links.json` | Token map contains email-bound magic-link tokens. | **A.** Remove all tokens whose stored email is the deleted account email; deletion-purpose tokens will also be single-use/expired. | `lib/accounts.js:40`, `lib/accounts.js:262-272` |
| `data/verified-wallets.json` | Wallet-keyed verified state. No content body. | **A.** Remove the verified entry for the account’s verified linked wallet. Wallet-only deletion has no account linkage to remove. | `server.js:455`, `server.js:5510-5511` |
| `data/identity.json` | Account-id-keyed AES-GCM envelope; ciphertext contains legal name, country, tax-form type, wallet and capture time. | **A.** Remove the account-id record. This store is a materially sensitive omission from the starter list. | `lib/identity-vault.js:39-40`, `lib/identity-vault.js:120-139`, `server.js:4812-4823` |
| `data/waitlist.json` | Array of `{ email, ts, source }`; standalone email collection, not account-id keyed. | **Ruling required.** It is direct personal data and the policy separately promises removal on request, but the account-delete contract does not say whether matching account email also removes waitlist enrollment. Recommended **A by exact normalized email match** if the PM treats self-serve deletion as the request in §1.7; otherwise leave it outside this route and document why. | `lib/waitlist.js:23-24`, `lib/waitlist.js:106-124`, `docs/PRIVACY-POLICY.md:77-86` |
| `data/credits.json` | Account-id-keyed credit balances, lots, usage and price data. | **B.** Credit-balance history is expressly retained for account duration + 3 years; retain opaque account id as the keyed retention mechanism. Account termination makes the balance unusable. | `lib/credits.js:9-10`, `lib/credits.js:44-59`, `docs/PRIVACY-POLICY.md:193` |
| `data/purchases.jsonl` | Purchase rows include `account_id`, pack, amount and Stripe-session identifiers. | **B.** Transaction record; retain under the three-year exception. | `lib/stripe.js:38-53`, `server.js:4166-4178`, `docs/PRIVACY-POLICY.md:188` |
| `data/purchase-ledger.json` | Map key combines buyer account id and learning id; proof of prior unlock for rating eligibility. | **B.** Financial/unlock-history record; retain opaque key. Do not remove or rating history changes. | `lib/purchase-ledger.js:45-57`, `lib/purchase-ledger.js:74-82`, `server.js:1213-1215` |
| `data/unlock-attribution.json` | Map key combines buyer account id and learning id with last-accrual timestamp. | **B.** Financial accrual-cap/reconciliation metadata; retain the opaque key until its existing short pruning window expires. | `lib/unlock-attribution.js:21-36`, `lib/unlock-attribution.js:56-72` |
| `data/earnings.json` | Account- and legacy wallet-keyed balances, accrued totals and payout state. | **B.** Money-path/earnings record; never mutate under this build. | `server.js:453`, `server.js:699-702`, `docs/PRIVACY-POLICY.md:188`, `docs/PRIVACY-POLICY.md:310` |
| `data/settlements.jsonl` and `data/settlements-archive-*.jsonl` | Wallet, amount, transaction/settlement status and state-machine history. | **B.** Transaction record; never mutate. Archive files must be covered with the live log. | `server.js:457`, `server.js:998-1004`, `server.js:1080-1106` |
| `data/withdrawals.jsonl` | Account id or wallet, amount, rail, payout/settlement identifiers. | **B.** Financial withdrawal history; never mutate. | `server.js:4243`, `server.js:4599-4613`, `server.js:2024-2053` |
| `data/unlock-events.jsonl` | Contributor account/wallet, learning id, paid amount and funding source; intentionally append-only. | **B.** Immutable financial/unlock evidence; retain opaque ids. | `server.js:467`, `server.js:1014-1019`, `server.js:1335-1341` |
| `data/wal/*.wal.json` | Transient crash-recovery entries. Unlock payloads include contributor/purchaser account ids, builder wallet, amounts, redacted IP and UA; withdrawal payloads include wallet/address and amounts. | **B.** Explicit money-path exception: enumerate and report only; never mutate or alter `recoverWalEntries`. | `lib/wal.js:23-40`, `server.js:8712-8736`, `server.js:1910-2025` |
| `data/ratings.jsonl` | `rater_account_id`, learning id, score and optional notes. Notes can be content. | **B.** Existing retraction precedent treats ratings as inert keyed-lookup orphans; retain without mutation. **Ruling:** confirm that free-text `notes` stays under quality-score history rather than needing a content-specific redaction path. | `server.js:452`, `server.js:9059-9069`, `docs/PRIVACY-POLICY.md:194` |
| `data/reports.log` | Report rows contain learning id, free-text reason, reporter wallet and hashed reporter IP; trigger rows contain learning id/count. | **Ruling required.** It is both moderation evidence and potentially account/wallet-linked content. Retaining report rows preserves moderation/audit history, but the file supplies no account id and an account’s linked wallet can only be known before Class-A removal. PM must rule whether linked-wallet reporter rows are **B retained** (recommended for moderation integrity) or whether reporter fields/reasons require a targeted retention transformation. | `server.js:513`, `server.js:11018-11035`, `server.js:11072-11082` |
| `data/referrals.json` | Map keyed by referrer account id; values carry referred account ids, credit amounts/monthly payouts and referral IP hashes. | **B, subject to PM confirmation.** It is credit/anti-fraud history, and deleting either side changes a counterpart’s ledger. Retain opaque ids and hashes; do not delete/reforge the graph. This answers the spec’s required referral-shape question. | `server.js:12005-12010`, `server.js:12050-12059`, `server.js:12142-12172`, `server.js:12215-12221` |
| `data/reservations.json` | Settlement-id keyed (legacy wallet-keyed) temporary withdrawal reservations containing wallet, amount, time and status. | **B.** In-flight money-path control; never mutate. | `server.js:9194-9204`, `server.js:9210-9242` |
| `data/tx-hashes.log` | Accepted x402 transaction hashes only. | **B.** Transaction/replay-prevention record; retain. | `server.js:475-504` |
| `data/ofac-blocks.log` | Compliance-block ledger, including wallet/address context. | **B.** Compliance record; retain under legal exception. | `server.js:2121-2125`, `server.js:2411-2414` |
| `data/geo-blocks.log` | Embargo-screen ledger; request/geographic compliance metadata. | **B.** Compliance record; retain under legal exception. | `server.js:2123-2125`, `server.js:2473-2476` |
| `data/rate-limits.json` | Persisted `challengeRateLimit`, `learnRateStore`, `lastWithdrawalAttempt`; keys include wallet and potentially email/IP-derived keys. | **Ruling required.** It is short-lived security metadata, but the exact email-key population/expiry is not demonstrated by the serializer. PM must rule whether deletion removes entries matching account email/verified wallet (**recommended A where exact match exists**) or retains until natural expiry (**B/security exception**). | `server.js:468`, `server.js:9247-9274`, `server.js:9285-9325` |
| `data/pipelines.json` | Durable pipeline entries; potential pending/content-bearing queue. No account-link field was located in the storage/load path. | **Ruling required.** PM must identify the current row schema and ownership fields before Class A can be applied. If a row carries the deleting account or verified wallet and candidate content, it is **A**; otherwise it is out of this deletion axis. | `server.js:1892-1898`, `server.js:1382-1396` |
| `data/extractions.jsonl` | Idempotency rows contain account id, idempotency/session id, transcript hash and cached response. | **B.** Privacy Policy expressly retains transcript hashes/audit traceability; **ruling:** cached response may contain more than hash-level metadata, so PM must confirm it is acceptable to retain or require a row-level redaction while preserving the idempotency/audit record. | `server.js:6582-6618`, `docs/PRIVACY-POLICY.md:196-198` |
| `data/extraction-review.jsonl` | Account id, extraction id, candidate array and timestamp; candidate array can contain content. | **Ruling required.** This is the required content-bearing-review question. The current policy supports retaining audit/consent/hash evidence, not arbitrary pending candidate bodies. Recommended **A for account-owned rows** unless PM identifies a specific §4 exception. | `server.js:6582-6628` |
| `data/extraction-consent.jsonl` | Account id, action, consent version, timestamp, redacted IP and UA. | **B.** Autonomous-extraction consent log is expressly retained life of account + 3 years. | `lib/extraction-consent-reader.js:24-25`, `lib/extraction-consent-reader.js:90-103`, `docs/PRIVACY-POLICY.md:195` |
| `data/clean-lane-consent.jsonl` | Account id, grant/revoke/freeze state, consent/ToS versions, redacted IP/UA and optional statistics. | **B.** Extraction-consent class; retain as required by the spec amendment and §4. | `lib/clean-lane.js:58-59`, `lib/clean-lane.js:306-337`, `docs/PRIVACY-POLICY.md:195` |
| `data/tos-acceptance.jsonl` | Account id, ToS version, timestamp, redacted IP/UA, assent path/affirmation. | **Ruling required.** §4 says life of account + 30 days after deletion request, while §3’s immediate Class-A wording includes the account entry. Do not delete this log in Phase 1 until PM decides whether the route must schedule its 30-day disposition or whether the policy needs a rider. | `lib/tos-acceptance-log.js:42-43`, `lib/tos-acceptance-log.js:106-125`, `docs/PRIVACY-POLICY.md:191` |
| `data/audit-extractions.YYYY-MM.jsonl` plus legacy `data/audit-extractions.jsonl` | Hash-chained extraction/consent/ToS audit rows; account id, consent/audit metadata and transcript hash. | **B.** ToS §5.9.3(f) / policy require three-year audit retention. Do not break the hash chain by removing rows. Legacy admin writer is a distinct file path and is included. | `lib/extraction-audit-writer.js:48-52`, `lib/extraction-audit-writer.js:159-191`, `scripts/admin.js:20-53`, `docs/PRIVACY-POLICY.md:196` |
| `data/circuit-breaker.json` | Global aggregate circuit-breaker totals/state; no demonstrated account/email/wallet key. | **B / not account-linkable.** Leave untouched. | `server.js:6446-6457` |
| `data/.extract-kill-switch-reset` | Short-lived operator reset sentinel, with reason and operator acknowledgement; no account ownership. | **B / not account-linkable.** Leave untouched; it is consumed and deleted by the server. | `server.js:6540-6559`, `scripts/admin.js:20-84` |
| `data/staged-key.json` and `.failed` derivative | Platform key-rotation material, not account data. | **B / not account-linkable.** Never touch. | `server.js:469`, `server.js:581-607`, `server.js:10009-10012` |
| `data/backups/*` | `safeWrite` writes dated full-file copies for seven days; therefore backups can contain pre-deletion learnings, accounts, identity-adjacent account fields and other Class-A source data. | **Ruling required — critical.** This is a separate persistent copy, not merely an implementation detail. PM must choose: targeted rewrite/removal, encrypted-backup expiry/deletion rule, or an approved policy/rider statement. Phase 1 cannot truthfully claim completed deletion while backup copies remain unaddressed. | `server.js:440-441`, `server.js:952-981`; `scripts/retract-learnings.js:99-107` |
| `data/deletion-log.jsonl` (new) | Planned Class-C row: timestamp, opaque account id/wallet, method, removal counts and SLA deadline; never email/title/body. | **C.** Add in Phase 1 only, using the exact §3.4 shape and rider retention row. | BUILD-SPEC GOV2-DEL §3.4 and Annex (not present at pinned base) |

## Explicit exclusions (not persistent server stores)

- Wallet challenges/nonces and device-code state are process-memory maps, not files
  (`server.js:722-741`, `server.js:4700-4708`).
- `data/extract-cap-overrides.json` was found only as a read fallback in the
  current server path; no server write was found (`server.js:6412`).
- The client installer/runner writes user-machine configuration and capture
  artifacts outside the server data plane. They are not account-data stores
  written by this server process and are outside this API deletion route.

## PM rulings required before Phase 1

1. **Backups:** select the deletion handling for seven-day `data/backups/` copies.
2. **Terms acceptance:** reconcile §4’s “life of account + 30 days after deletion
   request” with immediate account removal; define the exact operational state.
3. **`extraction-review.jsonl` / `extractions.jsonl`:** approve Class-A removal
   for account-owned candidate bodies and decide whether cached idempotency
   responses are retained, redacted, or removed.
4. **`reports.log`:** rule the reporter-wallet axis and free-text reasons.
5. **`rate-limits.json`:** rule exact-match deletion versus natural expiry for
   persisted email/wallet/IP keys.
6. **`pipelines.json`:** provide the row schema/ownership fields before a queue
   disposition can be implemented.
7. **`waitlist.json`:** decide whether authenticated account deletion removes a
   matching standalone waitlist email under §1.7.
8. **Referrals and ratings:** confirm retention of opaque identifiers/free-text
   notes under the financial/quality-history exceptions.

**Phase 0 stop.** No route, OpenAPI, policy, test, money-path, WAL-recovery, or
runtime-store changes are authorized until the PM returns these rulings in a
revised spec.
