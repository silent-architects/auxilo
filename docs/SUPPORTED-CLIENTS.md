# Supported clients

*Last updated: 2026-09-05 (EXT-GATE: local extraction opened to every capture source; OpenClaw row qualified)*

This page lists the AI coding assistants and development environments currently supported by Auxilo, including the clients supported by the Autonomous Learning Extraction feature (ToS §5.9.3). Served at `/legal/supported-clients`. Updated in-place when new adapters are added.

Auxilo connects to AI agents two ways:

1. **MCP server** (`auxilo-mcp`): search, unlock, contribute, and earnings tools available inside the client.
2. **Background extraction** (optional, consent-gated; ToS §5.9.3): a local runner reads finished session transcripts, scrubs them on your machine, extracts learnings locally through your own model client, and submits only the finished learning drafts to Auxilo. Disabled by default; enabled only by explicit opt-in during `npx auxilo setup`.

**Capture support tiers** (we use these words precisely):

- **Supported**: the client fires a session-end-class hook that hands the local runner the transcript. Reliable.
- **Best-effort**: Auxilo reads the client's local session files. These locations are not contractual on the client's side; a client update can pause capture until we ship an adapter update (capture degrades silently, never mis-reads).
- **Probabilistic**: no local capture path exists; an optional rules-file note asks the agent itself to contribute learnings via the MCP `auxilo_contribute` tool. Catches what the agent volunteers, not everything.

---

## One-Command Setup

```bash
npx auxilo setup
```

The installer detects your clients, registers the MCP server in each, signs you in with a device code, installs the extraction runner to `~/.auxilo/bin`, wires capture hooks for hook-capable clients, and asks (default **No**) before enabling background extraction. See also: `npx auxilo status`, `npx auxilo disable`.

**One account, all clients.** Every client on a machine shares `~/.auxilo/credentials.json` — all contributions and extractions attribute to the same Auxilo account and earnings balance regardless of which client produced them. On additional machines, run `npx auxilo setup` and sign in with the same email; each device gets its own revocable API key under the same account.

## Client Matrix

| Client | Detection | MCP registration | Background extraction | Notes |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/` | `~/.claude/settings.json` | ✅ **Supported** — SessionEnd hook | |
| **Cursor** | `~/.cursor/` | `~/.cursor/mcp.json` | ✅ **Supported** — `sessionEnd` hook (`~/.cursor/hooks.json`) | |
| **Gemini CLI** | `~/.gemini/tmp/` or `~/.gemini/settings.json` | `~/.gemini/settings.json` | ✅ **Supported** — `SessionEnd` hook | |
| **Antigravity** | `~/.gemini/antigravity/` | `~/.gemini/config/mcp_config.json` | ⚠️ **Supported (early)** — `Stop` hook (`~/.gemini/config/hooks.json`) | hook schema young; verified against live install |
| **Windsurf** | `~/.codeium/windsurf/` | `~/.codeium/windsurf/mcp_config.json` | ✅ **Supported** — per-response transcript hook (deduplicated) | |
| **GitHub Copilot (VS Code agent / CLI)** | `~/.copilot/` | `~/.copilot/mcp-config.json` | ✅ **Supported** — `Stop` hook (`~/.copilot/hooks/auxilo.json`) | hooks are a VS Code Preview feature |
| **Codex (CLI + Desktop)** | `~/.codex/` | `~/.codex/config.toml` | ✅ **Supported** — `Stop` hook (`~/.codex/hooks.json`, CLI; requires one-time `/hooks` trust) **+ poll sweep of `~/.codex/sessions/` rollouts (Desktop + CLI, best-effort)** | Desktop app currently does not execute hooks (upstream openai/codex#21639); sweep covers it. |
| **Factory droid** | `~/.factory/` | `~/.factory/mcp.json` | ✅ **Supported** — `SessionEnd` hook (`~/.factory/hooks.json`) | applies to new sessions after setup |
| **OpenClaw** | `~/.openclaw/` | — (plugin planned) | ✅ **Best-effort** — poll-based source adapter | NOT locally verified; reads the legacy sessions/*.jsonl layout — current OpenClaw builds keep transcripts in a per-agent SQLite store, so capture is paused until the adapter is re-pointed; dedicated plugin + clawhub listing planned |
| **Cline (VS Code)** | VS Code `globalStorage/saoudrizwan.claude-dev/` | — | ✅ **Best-effort** — poll-based source adapter | NOT locally verified; strict format probe fails silent on storage-shape drift |
| **Roo Code (VS Code)** | VS Code `globalStorage/rooveterinaryinc.roo-{cline,code}/` | — | ✅ **Best-effort** — poll-based source adapter | NOT locally verified; strict format probe fails silent on storage-shape drift |
| **Claude Desktop** | `~/Library/Application Support/Claude/` | `claude_desktop_config.json` | **Probabilistic** — rules/MCP contribution only | no extraction surface exists |
| **Continue.dev** | `~/.continue/` | drop-in `~/.continue/mcpServers/auxilo.json` | ✅ **Best-effort** — poll-based source adapter | NOT locally verified; strict format probe fails silent on storage-shape drift |
| **opencode** | `~/.config/opencode/` | `opencode.json` | **Probabilistic** (plugin planned) | |
| **Kiro** | `~/.kiro/` | `~/.kiro/settings/mcp.json` | **Probabilistic** | |
| **JetBrains Junie** | `~/.junie/` | `~/.junie/mcp/mcp.json` | **Probabilistic** | |
| **Amp** | `~/.config/amp/` | `settings.json` (`amp.mcpServers`) | **Probabilistic** | threads are server-side |
| **OpenHands** | `~/.openhands/` | `~/.openhands/mcp.json` | **Probabilistic** (best-effort adapter planned) | |
| Other MCP clients | manual | Add `{ "command": "npx", "args": ["auxilo-mcp"] }` to the client's MCP config | **Probabilistic** | manual |

Web-based assistants (claude.ai, ChatGPT, Gemini web) have no local capture surface; a hosted Auxilo connector for contribution-grade support is planned.

Registration entry written by the installer (JSON-config MCP clients):

```json
{ "mcpServers": { "auxilo": { "command": "npx", "args": ["auxilo-mcp"] } } }
```

---

## How Background Extraction Works

When a Builder enables Autonomous Extraction and has a supported client installed:

Today the runner drafts learnings for every client it captures through the Claude Code CLI signed in on your machine. Without it, captured sessions are held and nothing is submitted. Per-client model paths are being built.

1. **Session completes**: The client fires its session-end hook (Supported tier) or writes session data to local storage (Best-effort tier).
2. **Capture fires**: The hook hands the transcript path to the local capture core, or the runner discovers new sessions via a source adapter.
3. **Client-side scrub**: Sensitive patterns (credentials, PII) are redacted before any data leaves the machine.
4. **Local extraction**: Your own model client (your local claude CLI) drafts learnings from the scrubbed text, the same way your normal sessions run. The transcript, raw or scrubbed, is never sent to Auxilo.
5. **Draft submission**: Only the finished learning drafts (title, body, category, tags, task context, outcome) are sent to Auxilo's `POST /learn` endpoint, tagged with their source client. The server's quality and sensitivity gates screen each draft. Everything your agent extracts lands in your private review queue, and you decide what goes live (`npx auxilo review`).

---

## What Setup Writes, Exactly

| Path | Purpose | Mode |
|---|---|---|
| client config files above | MCP registration (read-modify-write, atomic; malformed JSON is never overwritten) | unchanged |
| `~/.auxilo/credentials.json` | API key from device-code login | `0600` |
| `~/.auxilo/bin/` | extraction runner, capture core, source adapters, sensitivity filter, generated hooks/shims | executables `0755` |
| `~/.claude/settings.json` `hooks.SessionEnd[]` | one structured entry: `~/.auxilo/bin/auxilo-extract.sh` | — |
| per-client hook configs (see matrix) | one Auxilo capture entry per hook-capable client; existing entries preserved | — |
| `~/.auxilo/autonomous-enabled` | kill-switch sentinel — created **only** if you answer Yes to the consent prompt | — |

The executable surface lives in `~/.auxilo/bin` (never under `~/Documents`) because macOS TCC blocks hook/launchd execution from protected folders.

---

## Turning Extraction Off

- **Locally (immediate, all clients):** `npx auxilo disable` — removes the sentinel; every hook and the runner then exit without doing anything. One kill-switch covers every wired client.
- **Server-side:** `auxilo disable` offers to also revoke consent (`POST /extract/consent {"action":"revoke"}`), or use `PATCH /account/settings`.
- MCP server registrations are left in place; remove them manually from the client config files if desired.

---

## Windows Support

Best-effort in v1: Claude Desktop registration via `%APPDATA%\Claude\claude_desktop_config.json` is supported; background extraction hooks are macOS/Linux only.

---

## Requesting New Client Support

If you'd like to see your AI coding assistant supported, reach out at hello@auxilo.io or open an issue. Requirements for adding a new adapter:

- The client must fire a session-end-class hook with the transcript, or write session data to a local file in a stable format.
- The adapter must be implementable without modifying the client's source code.
- The client's license must permit reading its local data files for this purpose.

---

## Trademark Notice

Product names listed above are the trademarks of their respective owners. Auxilo is not affiliated with, endorsed by, or sponsored by any of the listed providers unless otherwise stated. Listing here indicates technical compatibility, not a business relationship.

---

*For questions about supported clients, contact hello@auxilo.io.*
