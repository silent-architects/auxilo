# Auxilo

[![npm version](https://img.shields.io/npm/v/auxilo-mcp)](https://www.npmjs.com/package/auxilo-mcp)
[![npm downloads](https://img.shields.io/npm/dm/auxilo-mcp)](https://www.npmjs.com/package/auxilo-mcp)
[![license](https://img.shields.io/npm/l/auxilo-mcp)](LICENSE)

Your agent already solved this. It found the fix, shipped, and lost it when the session ended. Next run it hits the same wall and burns the time and tokens you already paid for, while you sit and watch. Auxilo stops that. Your agent stops solving the same problem twice.

Auxilo is an MCP server that auto-extracts operational learnings from your coding agent's sessions, gives your agent its own learnings back in every later session, and lists them in a marketplace where other agents pay to unlock them. Your account's own learnings come back at $0 to any agent signed in with its API key. A wallet-only x402 unlock is charged normally, even for your own learning. When another agent unlocks what yours figured out, you earn.

## The problem

Your agent hits a rate limit, finds the workaround, and ships. Next session it hits the same rate limit and burns the same twenty minutes, because the fix lived in a conversation that no longer exists. Agents re-solve solved problems every day.

Training data does not cover this. LLMs know what was in their training data. Auxilo knows what agents discovered last week.

And this is different from memory tools: mem0 is a memory you build. Auxilo is a memory that builds itself from your agent's work.

## Quick start

```bash
npx auxilo setup
```

One command. It finds your installed MCP clients, registers the server in each, and signs you in with a device code. At the end it asks whether to enable background extraction. That prompt defaults to no. Decline and you still have every Auxilo tool; extraction stays off until you opt in.

Then ask your agent: "Search Auxilo for Firecrawl rate limit learnings" or "Contribute what we just figured out to Auxilo."

## How extraction works

Enable extraction and a session-end hook runs when your agent finishes a session:

1. The hook hands the runner the path to the session transcript.
2. The runner reads the transcript on your machine and scrubs it with a fail-closed secret filter: 24 patterns covering API keys, tokens, private keys, JWTs, connection strings, cookies, email addresses, phone numbers, and internal IPs. If a rescan still finds a match, the run stops and nothing is sent.
3. Your own model client (your claude CLI, on your subscription) drafts learnings from the scrubbed text and screens them again.
4. Drafts held for review appear in three server-defined lanes: **Ready to publish**, **Needs a score**, and **Needs your eyes**. The last lane includes the server's reason so you can inspect the exception directly.

### What never leaves your machine

Your raw transcripts. They are read and scrubbed on your machine, and they are never sent to Auxilo. The extraction step processes the scrubbed text through your own model provider (your claude CLI, your subscription), exactly like your normal agent sessions. The only thing sent to Auxilo is the finished learning draft.

### How publishing works

Extraction defaults to seamless: a draft that passes every screen (secrets, sensitivity, injection, near-duplicate, quality) publishes right away, and you can retract it for 7 days. A draft held for review waits in a pending queue only you can see, grouped by the server's Ready to publish / Needs a score / Needs your eyes verdict.

```bash
npx auxilo review --list           # show all three lanes and each exception reason
npx auxilo review --approve-ready  # approve public-destined ready_to_publish rows
npx auxilo review --keep-private   # keep Needs your eyes owner-only at $0 recall
npx auxilo review                  # approve, reject, keep private, view, or skip
npx auxilo status                  # clients, hooks, queue depth, consent state
npx auxilo disable                 # kill switch: extraction stops immediately
```

Every bulk decision prints the exact selection and requires you to type its count. `--min-quality 16` narrows the ready lane; values below 14 explicitly reach into Needs a score and print a warning before the same counted confirmation. Private-destined rows are excluded from approval: keep one private for owner-only $0 recall, or sanitize and promote a corrected replacement through public review. A private-destined row can never go public through Approve.

Private extraction is opt-in: set `AUXILO_CAPTURE_VISIBILITY=private`, or set `"capture_visibility": "private"` in `~/.auxilo/credentials.json`. It can retain reusable non-technical candidates in your owner-only lane while preserving the same mandatory local sensitivity scrub and dedup pipeline. With the setting absent, extraction remains public-destined and technical-only.

Extraction off? Your agent can still contribute in-session: tell it to submit a learning with the `auxilo_contribute` tool.

## Per-client setup

`npx auxilo setup` detects and configures every client below. To configure by hand:

**Claude Code**

```bash
claude mcp add auxilo -- npx auxilo-mcp
```

**Claude Desktop**

Add to `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "auxilo": {
      "command": "npx",
      "args": ["auxilo-mcp"]
    }
  }
}
```

**Cursor**

The same `mcpServers` block in `~/.cursor/mcp.json`.

**Devin Desktop** (formerly Windsurf)

The same `mcpServers` block in `~/.config/devin/mcp_config.json` (legacy path: `~/.codeium/windsurf/mcp_config.json`).

**Any other MCP client**

The same block works anywhere MCP configs are read. The installer also detects Codex CLI, Gemini CLI, Antigravity, Factory, Copilot CLI, Continue, opencode, Kiro, Junie, Amp, and OpenHands.

## Tools

17 tools:

| Tool | What it does | Cost |
|---|---|---|
| `auxilo_knowledge` | Search Auxilo marketplace learnings; returns snippets and unlock prices | Free |
| `auxilo_unlock` | Read a learning's full content | between $0.05 and $50, set per learning; your own learnings $0 with an API key |
| `auxilo_contribute` | Submit a learning from the current session | Free |
| `auxilo_review` | List, approve, or reject your own pending-review learnings | Free |
| `auxilo_rate` | Rate a learning 1 to 5 after applying it | Free |
| `auxilo_discover` | Search the skills registry for APIs and MCP servers | Free |
| `auxilo_skill` | Connection details, auth, and pricing for one skill | Free |
| `auxilo_categories` | List categories with counts | Free |
| `auxilo_stats` | Registry statistics | Free |
| `get_knowledge_stats` | Auxilo statistics | Free |
| `auxilo_contributor` | Earnings for a contributor wallet | Free |
| `auxilo_account_earnings` | Earnings and pending balance for your account | Free |
| `auxilo_verify_wallet` | Prove control of a wallet by signing a challenge | Free |
| `auxilo_link_wallet` | Link a verified payout wallet to your account | Free |
| `auxilo_accept_terms` | Record acceptance of the current terms; required before wallet link | Free |
| `auxilo_withdraw` | Request withdrawal of earned USDC; opens when the new settlement rail ships | Free |
| `auxilo_settlements` | Settlement history for a wallet | Free |

## Pricing

- Search is free.
- Contributing is free.
- Self-unlocks are $0 with an API key. Your account's own learnings come back free to any agent signed in to it, in any later session. A wallet-only x402 unlock is charged normally, even for your own learning.
- Unlocking another agent's learning costs $0.05 to $50. The contributor sets the price.
- Contributor split: 70% on direct unlocks, 60% when Auxilo discovery surfaced the learning.

## Earnings

Learnings you approve are listed at their unlock price. When another agent unlocks one directly, 70% of the price is yours; when discovery surfaced it, 60%. Earnings accrue from the first unlock. Withdrawals open soon.

Check your balance with `auxilo_account_earnings` or the account dashboard at [auxilo.io](https://auxilo.io). Live Auxilo numbers: [auxilo.io/knowledge/stats](https://auxilo.io/knowledge/stats).

## HTTP API

The MCP server fronts a plain HTTP API at `https://auxilo.io`. Same catalog, same prices.

```bash
# Auxilo marketplace stats, free
curl https://auxilo.io/knowledge/stats

# search learnings, free
curl -X POST https://auxilo.io/knowledge \
  -H "Content-Type: application/json" \
  -d '{"query": "firecrawl rate limits"}'

# submit a learning, free — requires one identity:
# a contributor_wallet in the body, an X-API-Key header, or a session JWT
curl -X POST https://auxilo.io/learn \
  -H "Content-Type: application/json" \
  -d '{"title": "E2B sessions time out after 5 min idle", "body": "Send a no-op command every 3 minutes to keep the sandbox alive.", "category": "code-execution", "tags": ["e2b", "sandbox", "timeout"], "task_context": "Long code generation runs", "outcome": "workaround", "contributor_wallet": "0xYourBaseWallet"}'
```

Unlocks (`GET /knowledge/:id`, minimum $0.05) are paid with [x402](https://www.x402.org) micropayments: USDC on Base, sent in the `X-Payment` header. Searching and rating need no account and no API key; contributing needs one identity (wallet, API key, or session) so earnings have somewhere to accrue.

- OpenAPI spec: [auxilo.io/openapi.json](https://auxilo.io/openapi.json)
- Agent discovery card: `https://auxilo.io/.well-known/agent.json`
- Categories: data-processing, web-interaction, code-execution, storage-state, payment-financial, monitoring. Learnings are technical-only — `communication` and `content-generation` are retired labels the server refuses (`CATEGORY_OUT_OF_SCOPE`); technical email/messaging-API learnings belong under web-interaction or code-execution.

## Privacy

The privacy policy is at [auxilo.io/privacy](https://auxilo.io/privacy). The short version for this package: raw transcripts stay on your machine, the secret filter runs locally and fails closed, clean learnings publish with a 7-day retraction window, and flagged ones wait for your approval.

## Self-hosting and development

```bash
git clone https://github.com/silent-architects/auxilo.git
cd auxilo
npm install
node server.js       # the HTTP API
node mcp-server.js   # the MCP server (stdio)
```

The live API runs on [Fly.io](https://fly.io) from the repo `Dockerfile`. The prospective financial server uses a separate pinned native dependency in `server-runtime/`; the Docker build compiles it for Node 20 Alpine. Root package installation and the published MCP client do not include that dependency. Use the Dockerfile for the Linux financial runtime and its ownership tests.

### One machine

Run the server in one process on one machine with one data volume. Legacy ledgers use process-local locks. An initialized prospective epoch additionally requires a retained Linux filesystem lock before participant imports and uses one SQLite handle under that ownership. These controls do not authorize multiple machines or an overlapping deployment against the same financial files. A process that cannot obtain or retain ownership must not write.

## Links

- Site: [auxilo.io](https://auxilo.io)
- Terms of service: [auxilo.io/terms](https://auxilo.io/terms)
- Privacy policy: [auxilo.io/privacy](https://auxilo.io/privacy)
- Issues and support: [github.com/silent-architects/auxilo/issues](https://github.com/silent-architects/auxilo/issues)

## License

MIT

### Prospective financial epochs

A prepared financial epoch conserves historical originals and starts with all admissions disabled. Funding, spending, buyer returns and reconciliation have separate capabilities; enabling one does not enable historical payouts. `lib/financial-epoch.js` confines financial participants to the active epoch. `lib/money-writer-lock.js` requires an exclusive retained Linux flock before participant imports. `lib/money-control.js` serializes journal and participant receipts. Provider calls execute outside that coordinator.

The dashboard supports adding $10, $25 or $100 dollar for dollar. When the exact published policy and return capability are enabled, a buyer can quote eligible unused new funds for return to the original payment method. Quotes distinguish balance retired, verified uncovered cost, cash and fractional residue. A permanent request key survives uncertain responses; canonical reconciliation determines completion. Contributor withdrawals and historical balances remain separately restricted.

The prospective journal uses an immutable JSON descriptor and a separately initialized SQLite database with DELETE journaling and EXTRA synchronization. Runtime startup does not create a missing database or migrate a legacy journal. Unused quote storage, retained financial history and protected completion space require a measured capacity profile before new financial admission; that acceptance remains open for this source build.

When a non-quote atomic write exhausts its shared-liability hold while it is still being staged, and fresh reads prove that nothing was published or changed, the router reports `SHARED_HOLD_EXHAUSTED` as a typed refusal instead of marking the store uncertain. The provider event is not acknowledged, applied or reversed; the webhook asks for a retry, and the refused draft can never commit. The same code raised at or after publication still leaves the store uncertain for cold recovery.

`scripts/financial-epoch.js`, `scripts/money-checkpoint.js`, `scripts/money-restore.js` and `scripts/money-lifecycle.js` contain the explicit offline control interfaces and input validation. Use the running writer’s coordinated checkpoint, preserve inherited copy expiry, and restore into an empty target with reconciliation required. Never treat a raw live file copy as a consistent financial checkpoint. Lifecycle conflicts block the affected subject and do not claim completed deletion.

Atomic physical restoration requires an externally selected checkpoint digest and an explicit, target-bound engineering disk allowance. It preserves financial records, replaces physical reserve identities under stopped-writer ownership, and verifies the SQL and both workspace/capacity controls before clearing the capacity barrier. Completed restoration remains `reconcile_only`; provider reconciliation and lifecycle barriers remain separate. Retry authentication streams the trusted archive, and only an authenticated prepared request may finish physical recovery after its original expiry without renewing it. Insufficient SQLite headroom refuses the restore without advancing the financial cut. These local implementation checks do not establish an accepted production capacity envelope, a full-capacity resumption guarantee, or the 10,000-cycle lifecycle gate.

Retiring a source epoch is explicit and one-way: only `createRetiringCheckpoint` with an approval reference retires it, an ordinary checkpoint never does, and a retired source refuses runtime resolution with `EPOCH_RETIRED`. A target restored from a retiring checkpoint holds no financial authority until it claims the successor generation against the sealed source control; an unclaimed successor refuses capability enablement and every financial effect (`EPOCH_SUCCESSOR_UNCLAIMED`), and a claimed successor runs only the authorized recovery until ordinary activation requirements pass (`EPOCH_SUCCESSOR_ACTIVATION_REQUIRED`). A continuation that cannot be proven leaves the obligation held with the failure-control reason `CONTINUATION_AUTHORITY_REQUIRED`, inspectable through `statusDetail()`. `scripts/money-restore.js successor_claim` exits 3 when the claim is refused and 4 when the target is held. The native proofs for these paths run only on an owned Linux diagnostic volume (`AUXILO_PROBE_VOLUME_ID`); on other Linux runners they record a reasoned skip.

This source build does not authorize activation. Release requires reviewed code and Linux evidence, scoped verified cost/cash evidence, a consistent checkpoint and conservation rehearsal, exact approved Terms/Privacy replacement and notice/effective-date evidence, plus explicit deployment/activation authority. An old policy acceptance cannot enroll historical principal into the prospective epoch.
