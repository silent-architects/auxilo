# SPEC3-G1 Phase 0 — raw `learnings` read-path audit

Audit base: `270fd9f55289dc43a31b15fca51e01cff087ff31`

This is the Phase 0 deliverable required by BUILD-SPEC SPEC3-G1 rev 1. It is
an audit of code already present at the pinned base, not a runtime change and
not a copy of the private BUILD-SPEC.

## Method and count

Commands used:

```sh
rg -a -n '\blearnings\b' server.js
rg -n -C 4 'function calculateLearningPrice|function getCurrentPrice|isMarketVisible|catalog' lib/pricing.js
nl -ba lib/similarity.js | sed -n '180,285p'
rg -n -C 4 'function applySelfDecision|applyBulkDecisions' lib/self-review.js
```

Definition: a **raw read path** is one semantic handler, startup task, or
helper that iterates, indexes, searches, counts, or passes the module-level
`learnings` array to another reader without first going through
`visibleCatalog()`. Multiple raw expressions inside one handler are one path
but remain individually count-pinned.

Result at the pinned base:

- **32 semantic raw read paths**
- **47 raw read call sites**
- `visibleCatalog()` itself (`server.js:3211-3214`) is the canonical source
  read and is not counted as a bypass.
- Writes (`learnings.push`, `safeWrite(LEARNINGS_FILE, learnings)`) are not
  read call sites and are not counted.

## Complete inventory

Disposition keys:

- **KEEP-RAW** — startup, operator, or authenticated-owner work that must see
  non-public records; retain on an explicit allowlist.
- **PUBLIC** — must read only the public catalog.
- **ACCOUNT-SCOPED** — may read public records plus non-public records owned by
  the authenticated contributor, never another account's non-public record.
- **EXISTENCE-HIDE** — an ID lookup may use raw storage internally only if the
  route returns the same 404 shape for a private non-owner as for a missing ID.
- **NO-ECON** — private records must neither be priced nor influence another
  record's pricing/demand/ranking inputs.

| # | Semantic path | Raw call site(s) at `270fd9f` | Current audience / result | G1 disposition |
|---:|---|---|---|---|
| 1 | AC-1 pipeline-owner boot migration | `server.js:732` | Startup migration passes the full store to `migratePipelineOwners`. | **KEEP-RAW**; migration must preserve private records. |
| 2 | M-B earnings/catalog boot reconciliation | `server.js:778` | Startup-only ID/price map used to diagnose phantom earnings. | **KEEP-RAW**; private records have no earnings, but full-store existence is the correct reconciliation input. |
| 3 | Empty-store seed decision and seed count log | `server.js:835`, `server.js:841` | Startup-only length reads. | **KEEP-RAW**. |
| 4 | CI-5 retired-category boot migration | `server.js:857` | Startup migration mutates historical records. | **KEEP-RAW**; private `non-technical` must be exempted from public-category migration logic by explicit Phase 1 tests. |
| 5 | Pending-review ops alert totals | `server.js:4312` | Internal count of pending items; exposes no body. | **KEEP-RAW** on the operator-only allowlist. Private-destined pending rows will be counted unless PM rules otherwise. |
| 6 | Link-wallet orphan adoption | `server.js:4828` | Signature-verified account action; helper binds only matching wallet orphans. | **KEEP-RAW / ACCOUNT-SCOPED**; ownership tests remain load-bearing. |
| 7 | `/learn` submission-time pricing | `server.js:5777` | Passes the full store into `calculateLearningPrice`. | **PUBLIC + NO-ECON**; pass the public catalog. |
| 8 | `/learn` exact-duplicate gate | `server.js:5848` | Full-store body-hash/title comparison; response is generic and strips predecessor ID/title. | **PM RULING REQUIRED**: either keep the current generic full-store collision gate or scope non-public predecessors to the same account. It currently creates a cross-account private existence oracle, though not a content/ID disclosure. |
| 9 | `/learn` near-duplicate screen | `server.js:5870` | Full corpus goes to account-blind `findNearDuplicate`; predecessor ID/status/category are persisted in hold evidence. | **ACCOUNT-SCOPED** per §2.6a: public predecessors for all callers; non-public predecessors only for `contributorAccountId`. |
| 10 | `/learn` clean-lane retraction-rate guard | `server.js:6013` | Internal account-specific clean-lane history. | **KEEP-RAW / ACCOUNT-SCOPED**; helper already filters by account and `published_via`. Pin that private rows never count. |
| 11 | Extraction-tier activation | `server.js:6271` | `learnings.some` treats any row owned by the account as a “published learning,” without checking status or visibility. | **PUBLIC**; an approved-private item must not activate verified extraction tier. |
| 12 | Feature-gated `/extract` exact + near dedup pool | `server.js:6780` | Full store plus same-batch candidates. Exact-match detail includes predecessor ID internally; response strips detail, but cross-account private rows can still suppress a candidate. Near-dup persists predecessor evidence. | **ACCOUNT-SCOPED** for non-public rows; pass `contributorAccountId` to `findNearDuplicate`. The route is 410 by default but remains executable when `SERVER_SIDE_EXTRACTION_ENABLED=true`. |
| 13 | Owner retraction lookup and clean-lane recount | `server.js:7066`, `server.js:7158` | Contribute-scoped API key; ownership checked before mutation. | **KEEP-RAW / ACCOUNT-SCOPED**. Phase 1 must implement private → `rejected` without making private rows public or counting them as clean-lane publishes. |
| 14 | `GET /account/learnings` owner metadata listing | `server.js:7534` | Read-scoped, strict `contributor_account_id` filter, six metadata fields. | **KEEP-RAW / ACCOUNT-SCOPED**; add `visibility` projection + validated visibility filter; body prohibition stays pinned. |
| 15 | `POST /knowledge` demand mutation and price fallback | `server.js:7752`, `server.js:7772` | Search results currently originate in `visibleCatalog`; each result gets demand counters and raw-catalog pricing. | Public results: **PUBLIC + NO-ECON**. Owner-private results: **ACCOUNT-SCOPED**, mark `visibility:'private'`, do not mutate demand, and do not compute or expose a price/value signal. |
| 16 | `GET /knowledge/:id` lookup and price fallback | `server.js:7860`, `server.js:7864`, `server.js:7875` | Raw ID lookup; non-approved rows 404, approved rows are priced before the DR-8 owner check. | **EXISTENCE-HIDE + NO-ECON**. A private item must branch to verified-owner pure read before price lock/engine/payment; every non-owner gets the missing-ID 404. |
| 17 | `POST /knowledge/:id/rate` lookup and locked re-read | `server.js:8614`, `server.js:8669` | Any existing ID reaches purchase check; missing ID is 404, an unpurchased private ID would be 403. | **EXISTENCE-HIDE**; private items are never rateable and private non-owners must receive the missing-ID 404. |
| 18 | Daily pricing/demand cron | `server.js:9084` | Snapshots the entire store, reprices every row with `pricing`, and decays every row with `demand`. | **PUBLIC + NO-ECON**; private rows must not be repriced, mutated, or included in comparison inputs. |
| 19 | Admin moderation queue | `server.js:9685` | Admin-read surface filters `pending_review` and deliberately includes reviewer evidence. | **KEEP-RAW** on the privileged-reviewer allowlist. Pin that an already-approved private item is not in the pending queue. |
| 20 | Admin single approve | `server.js:9729`, `server.js:9733` | Admin-only ID lookup/mutation. | **KEEP-RAW**; visibility must survive decisions. Public approval must enforce CI-5; a private `non-technical` row may never become public through this route. |
| 21 | Admin single reject | `server.js:9767`, `server.js:9784` | Admin-only ID lookup/mutation. | **KEEP-RAW**; rejection remains recoverable. |
| 22 | Shared orphan-adoption helper | `server.js:9845` | Called after verified linked-wallet ownership. | **KEEP-RAW / ACCOUNT-SCOPED**. |
| 23 | `GET /account/pending` owner queue | `server.js:9873` | Authenticated owner helper; full body is intentionally available to that owner. | **KEEP-RAW / ACCOUNT-SCOPED**. |
| 24 | Owner single approve | `server.js:9896` | Contribute-scoped, ownership-enforced helper. | **KEEP-RAW / ACCOUNT-SCOPED**; Phase 1 adds the separate public `approve` versus private `keep_private` outcomes. |
| 25 | Owner single reject | `server.js:9925` | Contribute-scoped, ownership-enforced helper. | **KEEP-RAW / ACCOUNT-SCOPED**. |
| 26 | Owner pending summary | `server.js:10001` | Read-scoped owner projection; E1 review-time vocabulary analysis consumes the corpus inside the pure helper. | **ACCOUNT-SCOPED**. Cross-account public rows may remain comparison evidence; another account's private rows must not enter vocabulary/dedup evidence. |
| 27 | Owner bulk decisions | `server.js:10026` | Contribute-scoped, counted, ownership-enforced helper. | **KEEP-RAW / ACCOUNT-SCOPED**; add `keep_private` while preserving count confirmation and visibility-aware idempotency. |
| 28 | Owner reject-by-signal selection + chunk decisions | `server.js:10092`, `server.js:10111` | Contribute-scoped, live-count-confirmed, owner selection. | **KEEP-RAW / ACCOUNT-SCOPED**; private records outside pending status are not selectable. |
| 29 | Sanitize/resubmit route | `server.js:10178`, `server.js:10214`, `server.js:10257`, `server.js:10344`, `server.js:10406`, `server.js:10419`, `server.js:10435` | Owner source lookup; full-store lineage, exact/near dedup, pricing, concurrency recheck, and disposition. | Source/lineage: **ACCOUNT-SCOPED**. Comparison set: §2.6a scoping. Pricing: **PUBLIC + NO-ECON**. See blocking finding F5 below: current accepted source statuses and immutable category make the specified private → public promotion impossible. |
| 30 | Public `POST /report` ID validation | `server.js:10497` | Unauthenticated route distinguishes missing ID (404) from any existing ID (report accepted after validation). | **PUBLIC / EXISTENCE-HIDE**; only public-visible IDs may be reported. A private ID must be indistinguishable from missing. |
| 31 | Public-site recent-band price fallback | `server.js:10718` | Rows originate in `visibleCatalog`, but price fallback receives the raw store. | **PUBLIC + NO-ECON**; pass the public catalog so private demand/density cannot affect displayed prices. |
| 32 | Feature-gated chat-pipeline dedup | `server.js:11174` | Authenticated pipeline compares candidate titles against the full store and exposes the number removed. | **ACCOUNT-SCOPED**; public predecessors for all, non-public predecessors only for the pipeline account. The route is 410 by default but executable when server extraction is enabled. |

Call-site checksum:

```text
1+1+2+1+1+1+1+1+1+1+1+1+2+1+2+3+2+1+1+2+2+1+1+1+1+1+1+2+7+1+1+1 = 47
```

## Findings that change the Phase 1 implementation

### F1 — `visibleCatalog()` exclusion is necessary but not sufficient

`lib/pricing.js:91-92` defines its own market predicate as approved/legacy only.
Therefore an approved private record would pass `isMarketVisible()` whenever a
server call site supplies raw `learnings`. `calculateLearningPrice` then uses it
for market size, tag neighbors, and similarity (`lib/pricing.js:240-247`);
`calculateDemandMultiplier` uses the supplied catalog without a visibility
filter (`lib/pricing.js:264-275`).

Phase 1 must both:

1. add `l.visibility !== 'private'` to `visibleCatalog()` regardless of the
   moderation flag; and
2. remove raw-catalog pricing inputs at rows 7, 15, 16, 18, 29, and 31 above
   (plus add the same private exclusion to `isMarketVisible` as defense in
   depth).

Otherwise private items affect price, demand baselines, and ranking despite
§2.6.

### F2 — private ownership currently activates a public extraction tier

`getAccountTier` calls `learnings.some` at `server.js:6271` without checking
status or visibility, despite naming the result `hasPublishedLearning`. A
private row must not satisfy this public-market activation test.

### F3 — two public ID routes are private-existence oracles

- Rating: missing ID → 404 at `server.js:8616`; an existing private ID with no
  purchase → 403 at `server.js:8625-8629`.
- Reporting: missing ID → 404 at `server.js:10498-10500`; an existing private
  ID can proceed to a 201 report at `server.js:10540-10553`.

Both need the same private-as-missing rule as `GET /knowledge/:id`.

### F4 — disabled-by-default routes still require private scoping

`/extract` and `/pipeline/upload` return 410 while
`SERVER_SIDE_EXTRACTION_ENABLED` is false (`server.js:6483-6485`,
`server.js:11037-11039`). The code remains executable behind the flag, so the
GOV-3 pin cannot treat it as dead. Both currently let another account's
non-public row change a contributor-visible dedup result.

### F5 — the specified private → public promotion cannot be implemented by the existing sanitize contract

The existing sanitize route:

- accepts only source status `pending_review` or `rejected`
  (`server.js:10178-10186`), not an approved private item; and
- inherits `original.category` everywhere (`server.js:10226`,
  `server.js:10257-10270`, `server.js:10339-10356`) rather than accepting a
  rewritten category.

That makes the stamped scenario impossible: a private
`category:'non-technical'` item cannot be sanitized into a CI-5 category and
resubmitted through the public screening chain.

**Blocking PM ruling for Phase 1:** authorize the sanitize request to accept a
new `category`, limited to `TECH_LEARNING_CATEGORIES`, and authorize
`status:'approved', visibility:'private'` as a source state. Without that
ruling, promotion is not buildable without inventing an API contract.

### F6 — exact-duplicate privacy behavior is unspecified

The spec expressly scopes `findNearDuplicate`, but the exact body/title gates
at `/learn`, `/extract`, and sanitize are separate implementations. The
`/learn` response strips predecessor metadata, but a cross-account private row
can still cause a 409. `/extract` and pipeline candidates can also be
suppressed.

**PM ruling requested:** keep generic full-store exact collision detection, or
apply the same public-for-all/non-public-for-owner comparison set. The safer
and internally consistent recommendation is the latter.

### F7 — “no price” requires projection behavior, not only cron exclusion

The owner DR-8 response currently calculates price before ownership and returns
`_revenue.unlock_price_usd` (`server.js:7871-7878`,
`server.js:7952-7975`). Search also always returns
`unlock_price_usd`, `current_price`, and `value_signal`
(`server.js:7761-7800`).

For a private item, §2.6 says “no price.” The recommended implementation is:

- owner-private search result: omit both price fields and `value_signal`;
- owner-private `GET /knowledge/:id`: take the pure-read branch before price
  resolution and omit `_revenue.unlock_price_usd` (retain
  `amount_paid_usd:0` and `owner_recall_free:true` if the common DR-8 envelope
  is required).

This projection choice needs PM confirmation because the stamped spec states
the invariant but not the exact additive/omissive JSON shape.

## Proposed Phase 1 GOV-3 count-pinned test set

Create one structural test file, recommended
`test/spec3-g1-private-visibility.test.js`, with these pins:

1. **Raw-read inventory pin:** scan `server.js` and assert the audited bypass
   manifest has exactly 32 semantic paths and the expected post-change raw
   call-site count. Every retained bypass must carry one stable marker:
   `G1_RAW_READ_ALLOW:<id>` matching the table row. Any new unmarked direct
   `learnings` iteration/search/index/helper pass fails.
2. **Canonical predicate pin:** exactly one `visibleCatalog` definition; its
   private exclusion is unconditional, outside the moderation-enabled branch.
   Legacy absence still means public.
3. **Public projection pin:** public catalog/stat/category/hint/recent-band/
   contributor-pricing routes continue to delegate to the canonical predicate.
4. **Pricing-input pin:** zero server pricing-engine calls receive raw
   `learnings`; the daily cron iterates only public-visible rows; the
   `lib/pricing.js` defense predicate excludes private.
5. **Near-duplicate caller pin:** exactly three server
   `findNearDuplicate` call sites (`/learn`, feature-gated `/extract`,
   sanitize); every call supplies `opts.contributorAccountId`.
6. **Comparison-set behavioral pins:**
   - cross-account near-verbatim of rejected/private predecessor → no hold
     naming it;
   - same-account private predecessor → hold with the correct `why`;
   - shipped public predecessor fixture remains unchanged.
7. **Existence-hiding pins:** private non-owner gets the identical 404 shape
   as missing on GET, rate, and report; no 402/403/201 distinction.
8. **Owner-search pins:** authenticated owner sees own private match marked
   private; anonymous and another API-key account do not; owner-private search
   does not increment demand or emit price/value fields.
9. **Catalog coherence pins:** private rows do not change search-public count,
   `/knowledge/stats`, categories, pricing insights, health/info/stats
   `catalog_size`, discover hint, contributor public counts, or recent-band
   HTML.
10. **Owner recall pins:** private owner gets the existing DR-8 pure-read
    guarantees—no payment, counter, price lock, demand/ranking, WAL, purchase
    ledger, or kill-switch dependency; linked-wallet ownership remains valid.
11. **Economics/activation pins:** private rows have no price/earnings/demand
    effects, are skipped by the daily cron, do not satisfy extraction-tier
    activation, and can never enter `ready_to_publish` auto-publish.
12. **Owner listing pins:** `/account/learnings` adds `visibility`, filters by
    `public|private`, retains the metadata-only/no-body field-count pin, and
    defaults missing visibility to public.
13. **Decision pins:** single and bulk `keep_private` set
    `status:'approved', visibility:'private'`; counted confirmation remains
    exact; idempotency distinguishes public approve from private keep; private
    → rejected remains recoverable.
14. **Category pins:** `non-technical` is accepted only for
    private-destined submission, the safety screen still runs, public
    submission names CI-5 in its 400, and no approval path can publish
    `non-technical`.
15. **Promotion pins (after F5 ruling):** only owner-private sources can enter
    promote/sanitize; replacement category must be public-valid; the full
    screen chain runs; replacement is `pending_review` and public-destined;
    original remains private/recoverable; explicit approval is required.
16. **Buyer-strip pin:** visibility-private content and contributor-only
    evidence/body fields are absent at every buyer projection; extend the
    existing exact-four buyer-strip count rather than creating a parallel
    projection list.
17. **Deletion pin:** the existing account data-deletion path removes private
    rows by the same owner axes; test both account-ID and verified-linked-wallet
    cases before claiming GOV-2 coverage.

Any added or removed tests must bump `scripts/check-test-count.sh` in the same
Phase 1 commit.

## Phase 0 verdict

**STOP — Phase 1 is not authorized yet.**

The raw-read inventory is complete at 32 paths / 47 call sites. Phase 1 needs
PM rulings on F5 (required to make promotion possible), F6 (exact-duplicate
comparison scope), and F7 (the concrete no-price response shape). No runtime
file has been changed in Phase 0.
