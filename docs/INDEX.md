# Auxilo — Documentation Index

> Last updated: 2026-04-17

The entry point for every document in the Auxilo project. 62+ documents across `docs/`, `specs/`, `agents/`, `prompts/`, and the project root. Use this to find what you need fast.

---

## START HERE

| Audience | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| **New engineer** | [SITE-ARCHITECTURE.md](SITE-ARCHITECTURE.md) | [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) | [RUNBOOK.md](RUNBOOK.md) |
| **New builder** | [PRODUCT.md](PRODUCT.md) | [MARKETPLACE.md](MARKETPLACE.md) | [DEVELOPER-GUIDE.md](DEVELOPER-GUIDE.md) |
| **Investor / media** | [PRODUCT.md](PRODUCT.md) | [FINANCIAL-PLAN.md](FINANCIAL-PLAN.md) | [GTM.md](GTM.md) |
| **AI agent** | [AGENT-LEARNING-GUIDE.md](AGENT-LEARNING-GUIDE.md) | [UX-FLOWS.md](UX-FLOWS.md) | [ERROR-CODES.md](ERROR-CODES.md) |

---

## 1. Product & Vision

| Document | Role | Location |
|---|---|---|
| **PRODUCT.md** | Source of Truth — product requirements, personas, success metrics | `docs/` |
| README.md | Supporting — npm/API quickstart | root |
| public/llms.txt | Supporting — LLM-readable service description | `public/` |
| AGENT-LEARNING-GUIDE.md | ⛔ Superseded by docs/AGENT-LEARNING-GUIDE.md | root |
| landing-page-copy.md | Supporting — web copy | root |
| SITE-REVIEW-BRIEF.md | Historical — site review assignment | root |

## 2. Marketplace Mechanics

| Document | Role | Location |
|---|---|---|
| **MARKETPLACE.md** | Source of Truth — every rule, fee, mechanic, policy | `docs/` |
| AGENT-LEARNING-GUIDE.md | ⛔ Superseded by docs/AGENT-LEARNING-GUIDE.md | root |
| ONBOARDING-COPY.md | Supporting — builder onboarding copy for all 6 flow steps | `docs/` |
| lib/pricing.js | Supporting — dynamic pricing implementation | `lib/` |
| lib/credits.js | Supporting — credit system implementation | `lib/` |

## 3. Pricing & Revenue

| Document | Role | Location |
|---|---|---|
| **PRICING-STRATEGY-V2.md** | Source of Truth — canonical pricing strategy | root |
| PRICING-STRATEGY.md | ⛔ Superseded by V2 | root |
| EARNINGS-MODEL.md | Superseded — consolidated into docs/FINANCIAL-PLAN.md | root |

## 4. Financial Model

| Document | Role | Location |
|---|---|---|
| **FINANCIAL-PLAN.md** | Source of Truth — unit economics, projections, funding | `docs/` |
| PRICING-STRATEGY-V2.md | Supporting — builder income + platform-scale tables (sections 4-5) | root |
| EARNINGS-MODEL.md | Historical — pre-consolidation earnings model | root |

## 5. Go-to-Market

| Document | Role | Location |
|---|---|---|
| **GTM.md** | Source of Truth — phased GTM plan, channels, milestones | `docs/` |
| BRAND_GUIDELINES.md | Supporting — production brand reference | root |
| ONBOARDING-COPY.md | Supporting — builder-facing copy | `docs/` |
| VISUAL_IDENTITY.md | Superseded by BRAND_GUIDELINES.md | root |
| BRAND_RESEARCH.md | Historical — brand research (superseded) | root |

## 6. Competitive Intelligence

| Document | Role | Location |
|---|---|---|
| **COMPETITIVE.md** | Source of Truth — competitive analysis (if created) | `docs/` |
| GTM.md §7 | Supporting — competitive response playbook | `docs/` |

## 7. Brand & Voice

| Document | Role | Location |
|---|---|---|
| **BRAND_GUIDELINES.md** | Source of Truth — production brand reference | root |
| VISUAL_IDENTITY.md | ⛔ Superseded by BRAND_GUIDELINES.md | root |
| BRAND_RESEARCH.md | Historical — brand exploration | root |

## 8. User Experience

| Document | Role | Location |
|---|---|---|
| **UX-FLOWS.md** | Source of Truth — all user journey maps | `docs/` |
| ONBOARDING-COPY.md | Supporting — builder onboarding copy | `docs/` |
| public/index.html | Source — landing page | `public/` |
| public/how-it-works.html | Source — how it works page | `public/` |
| public/status.html | Source — status page | `public/` |

## 9. Developer Reference

| Document | Role | Location |
|---|---|---|
| **DEVELOPER-GUIDE.md** | Source of Truth — API quickstart, auth, endpoints | `docs/` |
| openapi.json | Source of Truth — machine-readable API spec (OpenAPI 3.0) | root |
| ERROR-CODES.md | Source of Truth — every error code, cause, resolution | `docs/` |
| SITE-ARCHITECTURE.md | Source of Truth — route map, auth middleware, file inventory | `docs/` |
| .well-known/agent.json | Supporting — A2A agent card | root |
| public/llms.txt | Supporting — LLM-readable summary | `public/` |
| README.md | Supporting — developer quickstart | root |
| prompts/ | Supporting — per-LLM instruction templates | `prompts/` |

## 10. Legal & Compliance

| Document | Role | Location |
|---|---|---|
| **TERMS-OF-SERVICE.md** | Source of Truth — live ToS (served at `/terms`) | `docs/` |
| **PRIVACY-POLICY.md** | Source of Truth — live Privacy Policy (served at `/privacy`) | `docs/` |
| LEGAL-READINESS-REVIEW.md | Supporting — legal gap analysis | `docs/` |
| MONEY-TRANSMISSION-ANALYSIS.md | Supporting — MSB/money transmitter analysis | `docs/` |
| STRIPE-TERMS-REVIEW.md | Supporting — Stripe compliance review | `docs/` |
| TAX-REPORTING.md | Supporting — tax obligations | `docs/` |
| DMCA-REGISTRATION-GUIDE.md | Supporting — DMCA process | `docs/` |
| RISK-REGISTER.md | Supporting — 21 tracked risks | `docs/` |
| **SUBPROCESSORS.md** | Source of Truth — subprocessor list (served at `/legal/subprocessors`) | `docs/` |
| **SUPPORTED-CLIENTS.md** | Source of Truth — supported client integrations (served at `/legal/supported-clients`) | `docs/` |

## 11. Security

| Document | Role | Location |
|---|---|---|
| **SECURITY-READINESS-REVIEW.md** | Source of Truth — security assessment | `docs/` |
| SECURITY-AUDIT.md | Historical — v0.3.0 security audit | root |
| ANTIGRAVITY-REVIEW.md | Historical — build review | root |
| outputs/build_review.md | Historical — pre-ship audit review | `outputs/` |
| public/.well-known/security.txt | Source — RFC 9116 responsible disclosure | `public/` |

## 12. Infrastructure & Deployment

| Document | Role | Location |
|---|---|---|
| **DEPLOY-GUIDE.md** | Source of Truth — Conway VM deployment reference | root |
| **INFRA-READINESS-REVIEW.md** | Supporting — infrastructure assessment | `docs/` |
| ecosystem.config.js | Source — PM2 process configuration | root |
| start.sh | Source — VM startup script | root |

## 13. Operations

| Document | Role | Location |
|---|---|---|
| **RUNBOOK.md** | Source of Truth — operations runbook | `docs/` |
| OPS-READINESS-REVIEW.md | Source of Truth — ops assessment, incident templates | `docs/` |
| SUPPORT-CHANNELS.md | Supporting — support channels and contacts | `docs/` |

## 14. Task Tracking & Governance

| Document | Role | Location |
|---|---|---|
| **PUNCH-LIST.md** | Source of Truth — master task tracker | root |
| TASKS.md | Supporting — phase/ownership assignments | root |
| ORCHESTRATOR.md | Supporting — sprint execution pattern | root |

## 15. Team & Roles

| Document | Role | Location |
|---|---|---|
| **AGENT-TEAM.md** | Source of Truth — 10-role agent team definitions | root |
| agents/ | Source — per-role CLAUDE.md files (10 agents) | `agents/` |
| prompts/ | Supporting — per-LLM setup instructions | `prompts/` |

## 16. Specifications & Build History

| Document | Notes | Location |
|---|---|---|
| specs/SPEC-A0 through SPEC-A4 | A-series feature specs | `specs/` |
| specs/SPEC-P0.1 through SPEC-P1.3 | Phase build specs | `specs/` |
| specs/BUILD-SPEC-P0.3 through P1.3 | Build specs with implementation detail | `specs/` |
| specs/SPRINT-04 through SPRINT-09 | Sprint execution logs | `specs/` |
| specs/SPRINT-08.md | Sprint 08 log | `specs/` |
| specs/AUDIT-POST-S8.md / RESULTS | Sprint 8 post-audit | `specs/` |
| specs/TEST-A-SERIES.md | Test cases for A-series features | `specs/` |
| specs/WAVE1-BUILD-* | Wave 1 build specs (6 files) | `specs/` |
| specs/WAVE1-DOC-* | Wave 1 documentation specs (8 files) | `specs/` |
| specs/WAVE1-FIX-* | Wave 1 bug fix specs (2 files) | `specs/` |
| docs/AUDIT-SPRINT-20.md | Sprint 20 audit | `docs/` |
| docs/AUDIT-SPRINT-21-24.md | Sprint 21-24 audit | `docs/` |
| SPRINT-01.md, SPRINT-02.md, SPRINT-03.md | Early sprint logs | root |
| BUILD-LAUNCH-2026-03-19.md | Site overhaul build spec | root |

## 17. Autonomous Extraction (P2.1a)

| Document | Role | Location |
|---|---|---|
| **specs/REWORK-P2.1a.md** | Source of Truth — shipped rework spec | `specs/` |
| specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md | ⛔ Superseded by REWORK-P2.1a.md | `specs/` |
| docs/CONSENT-LOG-INTEGRITY.md | Supporting — consent log architecture + verification | `docs/` |
| docs/AGENT-LEARNING-GUIDE.md | Supporting — agent cold-read (P2.1a-aware) | `docs/` |
| docs/ONBOARDING-COPY.md §7-9 | Supporting — builder UX copy for extraction | `docs/` |
| specs/TEST-P2.1a.md | Supporting — 114 test cases | `specs/` |

---

## Superseded Documents

| Superseded | Replaced By | Notes |
|---|---|---|
| `PRICING-STRATEGY.md` | `PRICING-STRATEGY-V2.md` | V2 is the canonical pricing strategy |
| `EARNINGS-MODEL.md` | `docs/FINANCIAL-PLAN.md` | Consolidated into financial plan |
| `VISUAL_IDENTITY.md` | `BRAND_GUIDELINES.md` | Exploration superseded by production brand |
| `BRAND_RESEARCH.md` | `BRAND_GUIDELINES.md` | Research superseded by production brand |
| `BUILD-SPEC.md` | Phase build specs in `specs/` | Early spec superseded by phase specs |
| `BUILD-SPEC-P0.2.md` (root) | `specs/BUILD-SPEC-P0.3.md` | Superseded by newer phase spec |
| `public/terms.html` | `docs/TERMS-OF-SERVICE.md` | Removed 2026-03-20; `/terms` now renders markdown |
| `public/privacy.html` | `docs/PRIVACY-POLICY.md` | Removed 2026-03-20; `/privacy` now renders markdown |
| `specs/BUILD-SPEC-P2.1-AUTONOMOUS-EXTRACTION.md` | `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md` | P2.1a supersedes P2.1; server-side pipeline replaces client-side |
| `specs/BUILD-SPEC-P2.1a-AUTONOMOUS-EXTRACTION.md` | `specs/REWORK-P2.1a.md` | Rework spec is the shipped implementation |
| `AGENT-LEARNING-GUIDE.md` (root) | `docs/AGENT-LEARNING-GUIDE.md` | P2.1a-aware version in docs/ is canonical |

---

## File Locations

| Directory | Contents |
|---|---|
| `docs/` | Living references — all canonical docs, legal, readiness reviews |
| `specs/` | Build history — specifications, sprint logs, test cases, audit results |
| `agents/` | 10 per-role agent instruction sets (CLAUDE.md per role) |
| `prompts/` | Per-LLM Auxilo instruction templates (Claude Code, Cursor, Windsurf, etc.) |
| `lib/` | Server library modules (accounts, pricing, credits, earnings, etc.) |
| `public/` | Static web assets served by the API server |
| `data/` | Persistent JSON data files (learnings, earnings, accounts, settlements) |
| `outputs/` | Build review outputs |
| root | Top-level docs, task tracking, deploy scripts, server entry point |

---

*Maintainer policy: When a document is superseded, update this index to reflect the new source of truth. Do not delete superseded documents — mark them here and add a note at the top of the file.*
