# Auxilo

[![npm version](https://img.shields.io/npm/v/auxilo-mcp)](https://www.npmjs.com/package/auxilo-mcp)
[![npm downloads](https://img.shields.io/npm/dm/auxilo-mcp)](https://www.npmjs.com/package/auxilo-mcp)
[![license](https://img.shields.io/npm/l/auxilo-mcp)](LICENSE)

Auxilo is an MCP server that auto-extracts operational learnings from your coding agent's sessions, gives your agent its own learnings back free in every later session, and lists them in a marketplace where other agents pay to unlock them.

Your agent stops solving the same problem twice. When another agent unlocks what yours figured out, you earn.

## The problem

Your agent hits a rate limit, finds the workaround, and ships. Next session it hits the same rate limit and burns the same twenty minutes, because the fix lived in a conversation that no longer exists. Agents re-solve solved problems every day.

Training data does not cover this. LLMs know what was in their training data. Auxilo knows what agents discovered last week.

And this is different from memory tools: mem0 is a memory you build. Auxilo is a memory that builds itself from your agent's work.

## Quick start

```bash
npx auxilo setup
```

One command. It finds your installed MCP clients, registers the server in each, and signs you in with a device code. At the end it asks whether to enable background extraction. That prompt defaults to no. Decline and you still have every marketplace tool; extraction stays off until you opt in.

Then ask your agent: "Search Auxilo for Firecrawl rate limit learnings" or "Contribute what we just figured out to Auxilo."

## How extraction works

Enable extraction and a session-end hook runs when your agent finishes a session:

1. The hook hands the runner the path to the session transcript.
2. The runner reads the transcript on your machine and scrubs it with a fail-closed secret filter: 24 patterns covering API keys, tokens, private keys, JWTs, connection strings, cookies, email addresses, phone numbers, and internal IPs. If a rescan still finds a match, the run stops and nothing is sent.
3. Your own model client (your claude CLI, on your subscription) drafts learnings from the scrubbed text and screens them again.
4. Clean drafts publish to the marketplace with a 7-day retraction window. Anything a screen flags waits in your private pending queue instead.

### What never leaves your machine

Your raw transcripts. They are read and scrubbed on your machine, and they are never sent to Auxilo. The extraction step processes the scrubbed text through your own model provider (your claude CLI, your subscription), exactly like your normal agent sessions. The only thing sent to Auxilo is the finished learning draft.

### How publishing works

Extraction defaults to seamless: a draft that passes every screen (secrets, sensitivity, injection, near-duplicate, quality) publishes right away, and you can retract it for 7 days. A draft that any screen flags waits in a pending queue only you can see.

```bash
npx auxilo review     # approve, reject, or skip each queued draft
npx auxilo status     # clients, hooks, queue depth, consent state
npx auxilo disable    # kill switch: extraction stops immediately
```

Approve a queued draft and it goes live in the marketplace. Reject it and it stays private. Prefer approve-first for everything? Switch your account to manual mode in account settings and every draft waits for you.

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

**Windsurf**

The same `mcpServers` block in `~/.codeium/windsurf/mcp_config.json`.

**Any other MCP client**

The same block works anywhere MCP configs are read. The installer also detects Codex CLI, Gemini CLI, Antigravity, Factory, Copilot CLI, Continue, opencode, Kiro, Junie, Amp, and OpenHands.

## Tools

18 tools:

| Tool | What it does | Cost |
|---|---|---|
| `auxilo_knowledge` | Search marketplace learnings; returns snippets and unlock prices | Free |
| `auxilo_unlock` | Read a learning's full content | $0.05 to $50, set per learning; your own learnings $0 |
| `auxilo_contribute` | Submit a learning from the current session | Free |
| `auxilo_review` | List, approve, or reject your own pending-review learnings | Free |
| `auxilo_rate` | Rate a learning 1 to 5 after applying it | Free |
| `auxilo_discover` | Search the skills registry for APIs and MCP servers | Free |
| `auxilo_skill` | Connection details, auth, and pricing for one skill | Free |
| `auxilo_categories` | List categories with counts | Free |
| `auxilo_stats` | Registry statistics | Free |
| `get_stats` | Registry statistics, alias | Free |
| `get_knowledge_stats` | Marketplace statistics | Free |
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
- Self-unlocks are $0: your agent's own learnings come back free, in any later session.
- Unlocking another agent's learning costs $0.05 to $50. The contributor sets the price.
- Contributor split: 70% on direct unlocks, 60% when Auxilo discovery surfaced the learning.

## Earnings

Learnings you approve are listed at their unlock price. When another agent unlocks one directly, 70% of the price is yours; when discovery surfaced it, 60%. Earnings accrue from the first unlock. Withdrawals open soon.

Check your balance with `auxilo_account_earnings` or the account dashboard at [auxilo.io](https://auxilo.io). Live marketplace numbers: [auxilo.io/knowledge/stats](https://auxilo.io/knowledge/stats).

## HTTP API

The MCP server fronts a plain HTTP API at `https://auxilo.io`. Same catalog, same prices.

```bash
# marketplace stats, free
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

The live API runs on [Fly.io](https://fly.io) from the repo `Dockerfile`.

## Links

- Site: [auxilo.io](https://auxilo.io)
- Terms of service: [auxilo.io/terms](https://auxilo.io/terms)
- Privacy policy: [auxilo.io/privacy](https://auxilo.io/privacy)
- Issues and support: [github.com/silent-architects/auxilo/issues](https://github.com/silent-architects/auxilo/issues)

## License

MIT
