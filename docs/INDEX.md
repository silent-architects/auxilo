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
| root | `README.md` (quickstart), `CLAUDE.md` (repo governance), `AGENTS.md` / `AGENT-TEAM.md` (agent roles + instructions), `ORCHESTRATOR.md` (sprint pattern), `TASKS.md` + `PUNCH-LIST.md` (task tracking), `openapi.json` (API spec). The one-off fly.io migration runbook was retired 2026-07 (migration complete, source environment decommissioned). |
| `public/` | Static site + assets served by the API (`index.html`, `how-it-works.html`, `.well-known/`, `llms.txt`, `security.txt`) |
| `specs/` | Public build/test specs — the P2.1a autonomous-extraction series (`REWORK-P2.1a.md`, `TEST-P2.1a.md`, `BUILD-SPEC-P2.1a-*.md`) |
| `lib/`, `scripts/`, `jobs/`, `config/` | Server library modules, install/runner scripts, scheduled jobs, config |
| `test/`, `tests/` | Test suites |

**Asset cache-busting (ASSET-CACHE-BUST, 2026-09-06).** `public/styles.css` and the other locally-hosted assets referenced from tracked `public/` HTML (and from `server.js`'s `serveLegalPage()` shell) via a `?v=` query string are served with `Cache-Control: public, max-age=31536000, immutable` (see `server.js`'s static routes) — the route match is on the path only, so a stale `?v=` value means a returning visitor's browser never re-fetches the file, for up to a year, no matter how many times the underlying bytes change. `scripts/asset-versions.js` closes that gap: it enumerates every `?v=`-referenced local asset (discovered from `git ls-files public` plus the one known non-public reference site, `server.js`), computes an 8-hex sha256 prefix of each asset's current bytes, and keeps every reference in sync. Run `node scripts/asset-versions.js` to report the current asset/hash/reference map, `--check` to fail (exit 1) on any reference whose asset has changed without a matching bump, and `--write` to rewrite every stale reference to the current hash. `--check` is wired into `scripts/predeploy-check.sh`, so a `styles.css` (or `dashboard-review.js` / `dashboard-clean-lane.js`) change that ships without also running `--write` now blocks predeploy instead of shipping a silently stale asset. Coverage lives in `test/asset-cache-bust.test.js`.

---

*Maintainer policy: this public index maps only what ships in the public repo. Business-sensitive docs are maintained in the private canon's `docs/INDEX.md` — do not republish them here. When a published doc is added or superseded, update this table.*
