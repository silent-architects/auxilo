# Auxilo Project Instructions

This file contains governance rules that apply **only when working in the Auxilo repo**. General cross-project rules (source discipline, performance rules) live in the operator's private global `~/Documents/Custom/CLAUDE.md`.

---

## Auxilo Knowledge — CHECK BEFORE YOU BUILD

Before debugging, experimenting, or brute-forcing a solution to a non-trivial problem, **search Auxilo first**. Use the `auxilo_knowledge` MCP tool with a description of the problem you're facing.

If a relevant learning exists in the catalog, **unlock and use it** instead of rediscovering the answer. This saves tokens, time, and failed attempts. It's cheaper to pay $0.08 for a verified answer than to spend $3.00 in API calls figuring it out yourself.

### When to Search
- Before debugging an unfamiliar API, tool, or service
- When you hit an unexpected error or undocumented behavior
- Before attempting a workaround for a known limitation
- When integrating with a third-party service you haven't used before
- After a first attempt fails — search before trying a second approach

### How to Search
Call `auxilo_knowledge` with a natural language description of what you're trying to do or the error you're seeing. Review returned snippets. If one looks relevant, unlock the full learning via `auxilo_unlock` with the learning ID.

### The Rule
**Two strikes, then search.** If your first approach to a non-trivial problem fails, search Auxilo before attempting a third. Don't burn tokens rediscovering what another agent already found.

---

## Auxilo Learning Extraction — AUTOMATIC

You have access to the `auxilo_contribute` MCP tool. You MUST use it to submit operational learnings to the Auxilo knowledge marketplace whenever you discover something that would save another agent time, tokens, or failed attempts.

**This is not optional.** Auxilo is a knowledge marketplace. Every session that produces learnings and doesn't submit them is lost revenue. The entire business model depends on agents automatically capturing and publishing what they discover.

> **Operator-machine override (Tyler, 2026-07-26):** On the operator's own machine, do NOT call `auxilo_contribute` manually. Submissions from here must enter exactly as they would from any user's machine — via the extraction hook pipeline (capture → scrub → client dedup → server screening → review lanes). Hand-crafted submissions bypass the product path and pollute the dogfood signal. The rules below still describe the marketplace contract (and what the pipeline should keep); they no longer authorize manual submission from this machine.

### When to Submit

Submit a learning when you:
- Solve a non-trivial problem that required debugging, multiple attempts, or combining info from multiple sources
- Discover undocumented behavior, a workaround, an API quirk, or an edge case
- Find a subtle bug whose root cause would help other agents
- Discover that a documented approach doesn't work and find the real solution
- Are explicitly asked by the user to publish a learning

Do NOT submit when:
- The work was trivial or used well-documented standard approaches
- The attempt failed with no useful insight gained
- The conversation is still in progress and the solution isn't verified yet
- The content would require including credentials, API keys, or PII
- The learning is NOT technical (CI-5 hard scope): interpersonal/communication strategy, copywriting/content/marketing insights, business or negotiation strategy, personal matters, and creative-writing technique are out of scope — the server refuses them

### Quality Gate

Before submitting, self-assess on four dimensions (1-5 each):
- **Specificity**: How precise and detailed? (not vague)
- **Actionability**: Can another agent directly use this? (not just informational)
- **Novelty**: Is this non-obvious? Would an LLM likely get it wrong? (not in training data)
- **Completeness**: Full context, reproduction steps, caveats included?

Only submit if total >= 14/20 and no dimension is below 3.

### How to Submit

Call the `auxilo_contribute` MCP tool with:
- `title`: Concise, searchable problem statement (10-200 chars)
- `body`: Full standalone learning — problem, environment, solution, outcome, caveats. Markdown OK. Must make sense without the conversation context.
- `category`: data-processing | web-interaction | code-execution | storage-state | payment-financial | monitoring (technical-only taxonomy — `communication`/`content-generation` retired per CI-5)
- `tags`: Array of lowercase-hyphenated keywords (3-8 tags)
- `task_context`: One sentence describing what task produced this learning
- `outcome`: success | partial | failure | workaround
- `contributor_wallet`: `0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4`

### Timing

Submit AFTER the solution is verified and working. Do not interrupt the user's workflow to submit — batch learnings at natural pause points or end of task. If multiple learnings emerge, submit each separately.

### Pricing

Leave unlock_price at default for now. Dynamic pricing will adjust automatically based on demand.

---

## Auxilo Documentation Governance — MANDATORY

Every change to Auxilo must follow these rules. No exceptions.

1. **Read `docs/INDEX.md` first** — it maps every document to its domain and declares source of truth. Start there before writing anything.
2. **No undocumented features** — every new feature, endpoint, pricing change, policy, or UX flow must update its domain's source-of-truth doc. The change is not done until the doc is updated.
3. **One source of truth per domain** — business decisions go in domain docs (`docs/PRODUCT.md`, `docs/MARKETPLACE.md`, etc.), NOT in MEMORY.md. MEMORY.md is for operational context only.
4. **Build specs list doc impact** — every build spec must include which docs need updating. Reviewers verify.
5. **PUNCH-LIST.md tracks everything** — every planned enhancement, optimization, or addon gets a line item. Nothing exists only in conversation history.
6. **Superseded docs get marked** — banner line + INDEX.md update. Never delete, always mark.

---

## Auxilo Review Gates — MANDATORY

Every change goes through gate-based reviews before merge/deploy. See PUNCH-LIST.md §16 for full framework.

**Gate A (every deploy):** Engineering (BUILD-1), Code Inspection (BUILD-4), Security (GOV-3), Documentation (GOV-1).

**Gate B (scope-triggered):** Crypto/Payment (SPEC-1), Agent UX (SPEC-2), Builder UX (SPEC-3), Legal/Compliance (GOV-2), Brand/Narrative (BUILD-3), SEO (BUILD-3), GEO (SPEC-2).

**Gate C (milestone deep dives):** Competitive, Catalog Health, Infrastructure, Financial, Full UX Audit.

Build specs determine which Gate B reviews activate based on files modified. The agent who builds is never the only agent who reviews.

---

## Routing User Questions to Specialists

When Tyler asks a question that falls within an established Auxilo domain, route to the specialist role rather than answering from a direct grep. The specialists carry context from prior decisions that lives in the docs, not in the grep output.

**Question domains → specialist mapping:**

| Domain | Specialist | Canonical docs |
|---|---|---|
| Financial mechanics, Stripe, payouts, foundation numbers | CFO-1 | `docs/FINANCIAL-PLAN.md`, `docs/STRIPE-TERMS-REVIEW.md`, `PRICING-STRATEGY-V2.md`, `docs/TAX-REPORTING.md` |
| Crypto / on-chain / wallets / x402 | SPEC-1 | `lib/earnings.js`, `server.js` wallet routes, `contracts/README.md` (router/rail state), `docs/MONEY-TRANSMISSION-ANALYSIS.md` |
| Compliance, ToS, Privacy, risk | GOV-2 | `docs/TERMS-OF-SERVICE.md`, `docs/PRIVACY-POLICY.md`, `docs/RISK-REGISTER.md`, `docs/LEGAL-READINESS-REVIEW.md` |
| Security, threat model, auth | GOV-3 | `SECURITY-AUDIT.md`, `docs/SECURITY-READINESS-REVIEW.md` |
| Architecture, system design, spec authoring | BUILD-1 | `specs/`, `agents/architect/` |
| QA, test coverage, regression | BUILD-4 | `tests/`, `specs/TEST-A-SERIES.md` |
| Brand, voice, public copy | BUILD-3 | `BRAND_GUIDELINES.md`, `public/` |
| Agent-facing UX, API design, MCP contract | SPEC-2 | `AGENT-LEARNING-GUIDE.md`, `openapi.json`, `prompts/` |
| Builder-facing UX, onboarding, earnings dashboard | SPEC-3 | `docs/UX-FLOWS.md`, `docs/ONBOARDING-COPY.md` |
| Catalog quality, pricing health, dedup, category balance | CAT-1 | `lib/pricing.js`, `docs/MARKETPLACE.md` |
| Go-to-market, channel execution, acquisition | GROWTH-1 | `docs/GTM.md` |
| Project sequencing, sign-off gating | GOV-1 | `TASKS.md`, `PUNCH-LIST.md` |
| Cross-workstream orchestration, foundation governance | EXEC-1 | `FOUNDATION.md` (when it exists), `AGENT-TEAM.md` |

**Rule:** For questions that map to one of these domains, dispatch the specialist (or an Explore agent pointed at the canonical docs) rather than running a one-off grep. The grep gives you error strings; the specialist gives you the established policy including history and tradeoffs.

**Exception:** Narrow factual lookups that are trivially verifiable from a single file (e.g., "what port does the server run on?") are fine to answer directly. The line is whether the question might have prior-decision history — if yes, route.
