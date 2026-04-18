# Hosting Strategy SWOT — Auxilo Infrastructure

> **Date:** 2026-04-18
> **Authored by:** two parallel research agents, dispatched after Conway Cloud demonstrated multiple structural failures during the P2.1a Fly.io migration attempt.
> **Status:** Reference artifact. Fly.io migration shipped 2026-04-18; Conway is on 48h standby pending decommission.
> **Source of the "don't build an autonomous business on infra I don't trust" thesis:** Tyler (operator), 2026-04-18.

---

## 0. Context

On 2026-04-18 Auxilo was running on Conway Cloud (sandbox `725fa3fea...` rotating silently to `dc034f2b...`, `/files` endpoint deprecated without migration path, deploy scripts silently reporting success while doing nothing). Tyler flagged that this wasn't a platform to build an autonomous knowledge marketplace on. Two agents were dispatched: one for managed alternatives, one for self-hosted paths. Both converged.

---

## 1. Workload Profile (shared input)

- Single Node.js 20 / Hono HTTP server (`server.js`) plus MCP server (`mcp-server.js`) client-side
- State: append-only JSONL/JSON under `data/` (audit chain, consent log, learnings catalog, circuit breaker, accounts). Single-writer.
- No managed database today. Migration to Postgres / SQLite-Litestream / D1 is a P2 item (pre-GA).
- Secrets: `SESSION_SECRET`, `WALLET_PRIVATE_KEY` (FATAL-on-missing), `ANTHROPIC_API_KEY`, Stripe, MailerSend
- External egress: api.anthropic.com, api.mailersend.com, api.stripe.com, Base USDC RPC
- Public surface: `auxilo.io` (custom domain) + `api.auxilo.io` + `www.auxilo.io`
- Pilot-of-one traffic today. Marketplace target: thousands of agents, 99.9%+ SLA
- Deploy model: overwrite files via API, `pkill + nohup` restart on current Conway; `flyctl deploy` via Docker on Fly post-2026-04-18

---

## 2. Managed Platforms — SWOT Table

> Workload-fit pre-filter: pure-serverless/edge platforms (Cloudflare Workers alone, Vercel Functions, AWS Lambda, Deno Deploy) **break the append-only JSONL model**. They are viable only after a managed-DB migration. Noted inline.

| Platform | Strengths | Weaknesses | Opportunities vs Conway | Threats |
|---|---|---|---|---|
| **Fly.io** | Full VM semantics, persistent volumes, global anycast, `flyctl deploy` from git, health checks + autoscale, private networking for MCP↔server | Volume is single-AZ (needs snapshot discipline), occasional platform incidents, docs lag features | Stable app IDs (no sandbox-rotation class of bug), predictable restarts, real observability, custom domains + TLS in 1 command | Independent startup (~100 employees); not AWS-scale balance sheet. Pricing tweaked materially in 2024. |
| **Render** | Git-push deploy, managed disk, managed Postgres in same VPC, free TLS + custom domains, simple dashboard, zero-config Node | Cold starts on free tier, disk resize is painful, US/EU regions only, build queue slow at peak | Removes deploy.js entirely (auto-deploy on push). Disk semantics match current JSONL model with zero code change | Smaller independent. Acquired-or-pivot risk in 3yr horizon. Pricing has crept up. |
| **Railway** | Best-in-class DX, one-command deploy, templates, integrated Postgres/Redis, usage-based billing, volumes supported | Pricing opacity (usage-based spikes), smaller ops team, had a notable free-tier removal that burned trust, fewer regions | Lowest friction migration path. `railway up` replaces deploy.js in one line. Trialist-scale costs trivial | Startup funding sensitivity; pricing-model changes have happened twice. Not appropriate for 99.9% SLA claims. |
| **Vercel** | Best Node DX for HTTP, instant global, preview deploys, huge ecosystem | **No persistent disk** on serverless functions; long-running MCP process doesn't fit; 10s–300s function timeouts; egress pricing punishing at growth | Only relevant if Auxilo refactors to stateless + managed DB. Then: excellent. | Pricing overages famous (Cara.app, etc). Bandwidth tax at marketplace scale would be brutal. |
| **Cloudflare Workers / Containers** | Cloudflare Containers (GA 2025) gives Node container runtime with global deploy; Workers+D1+R2+KV stack is world-class; near-zero cold start; DDoS/WAF included | Containers still maturing; D1 (SQLite) requires schema migration from JSONL; Workers has CPU/memory limits unsuitable for `/extract` LLM calls with long tail | Free tier is absurdly generous at pilot scale. Post-DB-migration, this is the **cheapest 99.99% option on the market**. Native queue + KV replaces several internal primitives. | Heavy lock-in (D1, Durable Objects, bindings API). Migrating OFF Cloudflare is painful. Pricing can change per-product. |
| **DigitalOcean App Platform** | Simple, predictable flat pricing, managed Postgres cheap, persistent volumes, Docker or buildpack deploy, good uptime history | Less flexible than Fly for networking, slower to ship new features, scaling less granular | Flat-fee predictability (no usage-based surprise bills). Stable 10+ year company. | Feature velocity lags competitors. Not the platform to bet on for cutting-edge needs (e.g., GPU-backed extraction later). |
| **AWS (App Runner / Fargate / Beanstalk)** | Infinite scale, every adjacent service (SQS, RDS, Secrets Manager, CloudWatch), real 99.95%+ SLA, enterprise trust signal for B2B sales | Steep learning curve, IAM complexity, 3x the ops surface area, App Runner has quirky cold-starts, Beanstalk is legacy-feeling | Marketplace-scale credibility ("we run on AWS"). Unmatched for audit/compliance story to enterprise customers. EventBridge for per-learning billing events. | Bill-shock class of risk (NAT egress, CloudWatch logs). Lock-in is real but escapable. Lowest "surprise deprecation" risk of any option. |
| **Google Cloud Run** | Container-based, scale-to-zero, 60-minute request timeout (!), excellent for `/extract` LLM tail-latency, pay-per-request granularity, GCP auth primitives clean | No built-in persistent disk (need GCS or Cloud SQL), requires containerization, GCP console is its own learning curve | Scale-to-zero means pilot cost is ~$0/month. 60min timeout handles long LLM extractions that would break on Vercel/App Runner. | Requires stateless refactor (JSONL → GCS or Cloud SQL). Google's product discontinuation reputation (even if Cloud Run is safe). |
| **Deno Deploy** | Instant deploy, edge runtime, Node-compat layer works for pure JS | Node-compat is partial; `fs` writes to local disk won't persist; many npm packages still hit edge cases; pricing model changed in 2024 | Only compelling if rewriting to Deno-native + Deno KV. Not a sensible migration target from current codebase. | Smallest team of listed options. Node compat is best-effort, not contractual. |

### Managed cost table (pilot scale 1 rps / 1 GB ↔ growth scale 100 rps / 50 GB)

| Platform | Pilot | Growth | Notes |
|---|---|---|---|
| **Fly.io** | ~$5–10/mo | ~$80–150/mo | Predictable; chosen 2026-04-18 |
| Render | $7/mo + $7 disk = ~$14 | ~$85–120/mo | Flat tier pricing |
| Railway | ~$5–10/mo | ~$100–180/mo | Opaque at growth |
| Vercel | $20/mo Pro | **$300–800/mo** | Bandwidth is the killer |
| Cloudflare Workers + Containers + D1 | **~$0–5/mo** | ~$40–80/mo | Cheapest post-DB-migration |
| DO App Platform | $12/mo | ~$90–140/mo | Flat, predictable |
| AWS (App Runner + EFS) | ~$30–50/mo | ~$200–350/mo | Hidden costs real |
| GCP Cloud Run + Cloud SQL | ~$10–15/mo | ~$120–200/mo | Requires refactor |
| Deno Deploy | ~$0–10/mo | Not viable without rewrite | N/A |

---

## 3. Self-Hosted / Owned-Infrastructure — SWOT Table

| Option | Strengths | Weaknesses | Opportunities | Threats |
|---|---|---|---|---|
| **1. Hetzner Cloud VPS** (Ashburn/EU) | Cheapest serious VPS. CX22 (2 vCPU/4GB/40GB) ~$4–5/mo. 20TB bandwidth. Root access, snapshots, Terraform provider. EU data residency option. | Ashburn/Hillsboro are the only US regions; no edge. Reputation for aggressive abuse-desk response. No managed services beyond VM + volumes + LB. | Full OS control. Attach block storage for WAL durability. Horizontal scale behind $6/mo LB. | Solo account lock-out risk (no phone support). You own patching cadence. |
| **2. DigitalOcean Droplet** | US billing, clean UX, mature ecosystem, managed Postgres/Spaces available, SOC 2. | ~2× Hetzner for equivalent specs ($6 basic, $12 realistic). Lower bandwidth caps. Noisier neighbor reports on shared tiers. | Graduation path inside one vendor — Droplet → App Platform → Managed DB. | Account-suspension stories exist (less frequent than Hetzner). Same patching/on-call burden. |
| **3. Dedicated / Colocated (OVH or Hetzner Dedicated)** | Massive compute for the money. Hetzner AX42 (Ryzen 7 / 64GB / 2×512 NVMe) ~$45/mo. No noisy neighbor. Predictable IOPS. | One machine = one failure domain. Hardware-failure recovery takes hours. Setup fee. Not horizontally scalable without second box. | Real CPU headroom for `/extract` under load. Host Auxilo + Renderly + jobs + Postgres on one box. | **Hardware failure is your problem.** Solo founder on-call for a single physical box = highest variance on this list. |
| **4. Home Lab** (under the desk) | Zero marginal cost after hardware. Absolute physical sovereignty. | Residential ISPs block inbound 80/443 on many plans. Dynamic IP. Power outages. Home IP geolocation = bad look for marketplace. | Dev/staging mirror for free. Great for batch jobs that don't need 99.9%. | **Not a production option for a knowledge marketplace.** Residential SLA ≈ zero. Fire/theft/flood wipes the company. |
| **5. Equinix Metal** (bare metal cloud) | True bare metal + cloud-style API. Global regions. Enterprise-grade network. | Priced for enterprise. c3.small.x86 ~$0.50/hr = ~$365/mo minimum. Overbuilt for single Node process. | Matters only at growth scale where dedicated NIC/NVMe perf is measurable. | Cost burn. Equinix shrinking metal footprint since 2024. Vendor-trajectory risk. |
| **6. Oracle Cloud Free Tier** (Ampere ARM) | Forever-free 4 ARM vCPU + 24GB RAM + 200GB block + 10TB egress. Most compute per dollar on earth ($0). | **Oracle reclaims idle instances and has suspended accounts without warning.** ARM64 compatibility must be verified. Console UX hostile. | Run pilot and early growth for $0 indefinitely. Move savings into marketing. | Single-vendor lock with vendor known for free-tier suspension. No support channel. |
| **7. AWS Lightsail** | AWS reliability at commodity pricing. $5/mo 1GB, $10/mo 2GB. Static IP. Graduation path to full EC2/RDS. | Undersized vs Hetzner at same price. Bandwidth caps lower. Lightsail is AWS's "forgotten product" — slow feature velocity. | AWS SDK proximity helps if integrating SES/S3 later. Enterprise-procurement friendly invoice. | AWS account suspension is rare but catastrophic. Billing surprises. |
| **8. On-prem + Cloudflare Tunnel / Tailscale Funnel** | Solves home-lab inbound-port and dynamic-IP problem. CF Tunnel is free + adds DDoS/WAF. No public IP surface on origin. | Still residential power/ISP/cooling. Tunnel adds latency + hard dependency on Cloudflare. | Hybrid: origin in datacenter, CF Tunnel in front. Best-of-both. | CF ToS prohibits non-HTML proxying on free tier (uneven enforcement). Replaced Conway with Cloudflare — same lock-in shape. |

### Self-hosted cost + labor table

| Option | Pilot | Growth | Labor (hrs/mo) | Setup (hrs) |
|---|---|---|---|---|
| Hetzner Cloud | $5/mo | $40–80/mo | ~3 | ~8 |
| DigitalOcean Droplet | $6/mo | $60–120/mo | ~3 | ~6 |
| Dedicated (Hetzner AX42) | $45/mo | $45–90/mo | ~6 | ~15 |
| Home lab | ~$10/mo power | untenable | ~10 | ~20 |
| Equinix Metal | $365/mo | $700–1500/mo | ~4 | ~12 |
| Oracle Free | $0 | $0 (until caps) | ~4 | ~8 |
| AWS Lightsail | $5/mo | $40–80/mo | ~3 | ~5 |
| Home + CF Tunnel | $0–10/mo | $20/mo | ~8 | ~6 |

### Operational risks every self-hosted option shares (solo founder)

- **Backups:** WAL + JSON state must ship off-box nightly. None of the above does this for you.
- **Patching:** `unattended-upgrades` on Debian/Ubuntu is table stakes. Reboot window = downtime window.
- **SSH key rotation:** Nobody does this. You should. Use Tailscale SSH or a bastion.
- **Monitoring:** UptimeRobot/Betterstack free tier minimum. Without it you learn about outages from users.
- **On-call:** You are always on-call. Plan for 1–2 outages/yr at 2–6 hrs each on any single-box option.
- **Hardware failure:** Matters for options 3 and 4 only. Cloud options auto-migrate.
- **Account suspension:** Real on Oracle, Hetzner, Cloudflare free. Keep a second provider warm.

### Self-hosted recommendation matrix

| Optimize for | Winner | Tradeoff |
|---|---|---|
| **Control** | Hetzner Dedicated (option 3) | You own the kernel, disk, clock. Hardware-failure recovery on you; budget 6 hrs/mo ops. |
| **Solo-founder labor** | DigitalOcean Droplet (option 2) | Managed ecosystem, clean graduation to managed DB. ~2× Hetzner cost but saves 3–5 hrs/mo toil. |
| **Cost** | Oracle Free Tier (option 6) as prod + Hetzner CX22 (option 1) as warm failover ≈ $5/mo total | Oracle may reclaim; failover must be scripted and tested monthly. |
| **Sovereignty (no vendor lock)** | Hetzner Cloud (option 1) + IaC (Terraform) + nightly B2 backups | Any VPS on earth restores image in 30 min. Real portability, real independence. |

---

## 4. Synthesized Recommendation

### Today (2026-04-18) — SHIPPED
**Fly.io**, app name `auxilo`, region `iad`, 3GB persistent volume `auxilo_data`. 2–4 hour migration. Solves the Conway trust issue with minimum refactor. Stable app IDs eliminate the "sandbox rotated" class of outage. Real 99.9% posture for production pilot.

### Hedge (if Fly becomes untenable) — STANDBY
**DigitalOcean App Platform** is the "boring and stable" fallback. DO's balance sheet + flat pricing beat every independent startup on the list. Same Docker artifact ports directly.

### Endgame (V2 architecture, triggered by catalog scale forcing DB migration) — ROADMAP
**Cloudflare Workers + Containers + D1 + R2.** Once Auxilo hits 100+ req/sec and JSONL breaks anyway, Cloudflare is structurally cheapest, fastest, most DDoS-resilient. Non-trivial migration (JSONL → D1 schema, Workers + Containers for long-running extract). 1–2 week milestone. Do this same week as the DB migration — don't pay the refactor cost twice.

### Never (for this workload, this year)
- **Vercel** — bandwidth tax at marketplace scale would be brutal
- **Deno Deploy** — Node compat is best-effort, not contractual
- **AWS today** — 10× ops surface area vs. benefit at current scale
- **Home lab production** — residential SLA ≈ zero, reputation cost

---

## 5. Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-04-18 | Migrate from Conway → Fly.io (iad, single-machine, 3GB volume) | Conway flakiness + sandbox-ID rotation + silent deploy failures demonstrated unsuitability for autonomous marketplace |
| 2026-04-18 | Keep Conway running 48h as standby | Rollback insurance during initial Fly soak |
| TBD | Revisit CF Workers + D1 migration | Post-DB-schema-migration milestone; target ~100 learnings/day sustained |
| TBD | Hetzner failover | If Fly experiences its own trust failure |

---

## 6. Review Triggers

Revisit this doc if any of the following:

- Fly.io has a pricing change that materially shifts costs > 2×
- Catalog size > 1000 learnings or req/sec > 50 sustained (DB migration pressure)
- A competing platform materially changes the lock-in or sovereignty tradeoff
- Auxilo signs its first enterprise B2B customer (AWS credibility story becomes relevant)
- Any 72h-soak-breaking incident on Fly

**Owner:** EXEC-1 (infrastructure strategy), reviewed quarterly.
