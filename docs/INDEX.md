# Auxilo — Documentation Index (Public Repo)

> Last updated: 2026-07-15

The entry point for documentation that ships in the **public** repository (`github.com/silent-architects/auxilo`).

> ⚠️ **This is the public index — it is intentionally partial.** The full Auxilo documentation index (62+ documents spanning product, marketplace, pricing, financial model, go-to-market, competitive, security, infrastructure, and operations) lives in the **private canon** and is deliberately **not published** here. The business-sensitive docs it maps were removed from this public repo during a sensitivity scrub — see `PUNCH-LIST.md` §20 / DG-1. If you are working in a private-canon checkout, use the complete `docs/INDEX.md` there instead. This stub restores the `CLAUDE.md` / PUNCH-LIST §15 Rule 2 entry point for public checkouts without republishing the internal map.

---

## Published documents (`docs/`)

| Document | Role | Served at |
|---|---|---|
| **TERMS-OF-SERVICE.md** | Source of Truth — live Terms of Service | `/terms` |
| **PRIVACY-POLICY.md** | Source of Truth — live Privacy Policy | `/privacy` |
| **SUBPROCESSORS.md** | Source of Truth — subprocessor list | `/legal/subprocessors` |
| **SUPPORTED-CLIENTS.md** | Source of Truth — supported client integrations | `/legal/supported-clients` |
| **DMCA-POLICY.md** | Source of Truth — DMCA copyright / takedown policy | `/dmca` |
| **AGENT-LEARNING-GUIDE.md** | Source of Truth — agent cold-read / learning guide (P2.1a-aware; supersedes the root copy) | reference |
| **CONSENT-LOG-INTEGRITY.md** | Supporting — autonomous-extraction consent-log architecture + verification | reference |
| **ONBOARDING-COPY.md** | Supporting — builder onboarding copy (all 6 flow steps) | reference |

---

## Other public-repo artifacts

Documentation and source that also ship publicly, by location:

| Location | Contents |
|---|---|
| root | `README.md` (quickstart), `CLAUDE.md` (repo governance), `AGENTS.md` / `AGENT-TEAM.md` (agent roles + instructions), `ORCHESTRATOR.md` (sprint pattern), `TASKS.md` + `PUNCH-LIST.md` (task tracking), `MIGRATION-FLY.md` (fly.io migration), `openapi.json` (API spec) |
| `public/` | Static site + assets served by the API (`index.html`, `how-it-works.html`, `.well-known/`, `llms.txt`, `security.txt`) |
| `specs/` | Public build/test specs — the P2.1a autonomous-extraction series (`REWORK-P2.1a.md`, `TEST-P2.1a.md`, `BUILD-SPEC-P2.1a-*.md`) |
| `lib/`, `scripts/`, `jobs/`, `config/` | Server library modules, install/runner scripts, scheduled jobs, config |
| `test/`, `tests/` | Test suites |

---

*Maintainer policy: this public index maps only what ships in the public repo. Business-sensitive docs are maintained in the private canon's `docs/INDEX.md` — do not republish them here. When a published doc is added or superseded, update this table.*
