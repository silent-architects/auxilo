# Auxilo → Fly.io Migration Runbook

Move the Auxilo HTTP server from the Conway sandbox VM to Fly.io.
Scope: `server.js` (Hono) only. `mcp-server.js` runs on agents' machines
via `npx auxilo-mcp` and is NOT deployed here.

Written for a single-operator cut-over. Estimated wall time: 60–90 min.

---

## 0. Preflight

- [ ] Conway VM is healthy and serving traffic — you want a clean source.
- [ ] You have the current values of these secrets on hand (or in 1Password):
  `SESSION_SECRET`, `ANTHROPIC_API_KEY`, `WALLET_PRIVATE_KEY`, and
  (optional) `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `MAILERSEND_API_KEY`.
- [ ] `X_PAYMENT` (Conway API key) exported in your shell for data export.
- [ ] DNS registrar login ready (Cloudflare, Namecheap, whatever hosts
  auxilo.io). You'll add records in §9.

---

## 1. Install flyctl

```bash
curl -L https://fly.io/install.sh | sh
# Add to PATH as the installer instructs (usually ~/.fly/bin)
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
flyctl version
```

On macOS with Homebrew: `brew install flyctl` also works.

---

## 2. Authenticate

```bash
flyctl auth signup   # first time — opens browser
# or
flyctl auth login    # returning
flyctl auth whoami
```

---

## 3. Create the app

The name `auxilo` is globally unique across Fly. Try the primary first;
if taken, fall back.

```bash
# Primary
flyctl apps create auxilo

# Fallback if the name is claimed
flyctl apps create auxilo-prod
# Then edit fly.toml and change `app = "auxilo"` → `app = "auxilo-prod"`
```

`flyctl launch` also works if you want the interactive wizard, but we
already ship a `fly.toml` so `apps create` + manual deploy is cleaner.

---

## 4. Create the persistent volume

The audit chain, consent log, learnings catalog, and circuit-breaker
state live under `/app/data`. Must persist across deploys.

```bash
flyctl volumes create auxilo_data \
  --region iad \
  --size 3 \
  --app auxilo
```

`--size 3` = 3 GB. Match the `initial_size` in `fly.toml`. Grow later
with `flyctl volumes extend <vol_id> --size 5`.

Gotcha: Fly volumes are single-AZ. Daily snapshots are on by default
(5-day retention). To list/restore:

```bash
flyctl volumes list --app auxilo
flyctl volumes snapshots list <volume-id>
flyctl volumes snapshots create <volume-id>  # on-demand before risky ops
```

---

## 5. Set secrets

`flyctl secrets set` writes encrypted secrets to the app. They are
injected as env vars at machine start. Setting secrets does NOT trigger
a deploy as long as the app has no running machines yet (which is the
case pre-first-deploy).

```bash
# Required — server FATALs without these
flyctl secrets set \
  SESSION_SECRET="$(openssl rand -hex 32)" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  WALLET_PRIVATE_KEY="0x..." \
  --app auxilo

# Optional — only needed if the corresponding feature is in use
flyctl secrets set \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  MAILERSEND_API_KEY="mlsn...." \
  --app auxilo
```

Known FATAL startup checks in `server.js`:
- `SESSION_SECRET` missing in production → refuses to start
  (server.js:38-44).
- `WALLET_PRIVATE_KEY` missing → tx-manager init throws, server exits.

Reuse the EXISTING `SESSION_SECRET` from Conway if you want live
sessions/JWTs to survive the cut-over. Generating a new one invalidates
every outstanding JWT and forces all agents to re-auth.

---

## 6. Migrate the data/ directory

Two approaches. Pick one.

### 6a. Recommended: `scripts/migrate-data.sh`

Scripted round-trip: tar on Conway → download → upload to Fly → extract
into the volume. Handles mtime preservation and has a dry-run.

```bash
# Dry run — lists files, transfers nothing
X_PAYMENT="your-conway-key" FLY_APP=auxilo \
  ./scripts/migrate-data.sh --dry-run

# Real run — first deploy the app once (see §7) so there is a machine
# with the volume mounted and SSH available, then:
X_PAYMENT="your-conway-key" FLY_APP=auxilo \
  ./scripts/migrate-data.sh
```

The script needs the Fly machine to exist with the volume mounted
before it can SFTP into it. Order of operations:
  1. §7 deploy (with an empty data volume)
  2. §6a migrate script (populates the volume)
  3. `flyctl machine restart` to ensure server.js re-reads the imported
     audit chain / catalog on startup.

### 6b. Manual scp-equivalent via Conway API

If the script misbehaves, do it by hand:

```bash
# 1. On Conway, tar up /app/data
curl -sS -X POST "https://api.conway.tech/v1/sandboxes/$SANDBOX_ID/exec" \
  -H "X-API-Key: $X_PAYMENT" -H "Content-Type: application/json" \
  -d '{"command":"cd /app && tar czf /tmp/auxilo-data.tgz data"}'

# 2. Pull it down via Conway's files API
curl -sS "https://api.conway.tech/v1/sandboxes/$SANDBOX_ID/files?path=/tmp/auxilo-data.tgz" \
  -H "X-API-Key: $X_PAYMENT" -o auxilo-data.tgz

# 3. Push into the Fly machine
flyctl ssh sftp shell --app auxilo
  # at the sftp prompt:
  put auxilo-data.tgz /data/auxilo-data.tgz
  quit

# 4. Extract on Fly
flyctl ssh console --app auxilo \
  -C "cd /app && tar xzf /data/auxilo-data.tgz && rm /data/auxilo-data.tgz && chown -R node:node /app/data"

# 5. Restart so the server re-opens the audit chain cleanly
flyctl machine restart --app auxilo
```

---

## 7. First deploy

```bash
flyctl deploy --app auxilo
```

What this does: builds the Dockerfile locally (or remotely if you pass
`--remote-only`), pushes to Fly's registry, starts a machine, mounts
`auxilo_data` at `/app/data`, injects the secrets, runs `node server.js`.

Watch the logs:

```bash
flyctl logs --app auxilo
```

Look for:
- `[start] Auxilo server listening on :3000`
- No `[FATAL]` lines.
- Health checks going green within 20s.

---

## 8. Verify endpoints

```bash
APP=auxilo   # or auxilo-prod
curl -fsS https://$APP.fly.dev/health
curl -fsS https://$APP.fly.dev/openapi.json | head -c 200
curl -fsS https://$APP.fly.dev/.well-known/agent.json | head -c 200
curl -fsS https://$APP.fly.dev/api | head -c 200
curl -fsS https://$APP.fly.dev/stats | head -c 200
```

All five should return 200 with plausible bodies. If `/stats` shows
zero learnings after data migration, something went wrong in §6 —
the catalog didn't import.

---

## 9. Custom domain (auxilo.io)

```bash
flyctl certs add auxilo.io --app auxilo
flyctl certs add www.auxilo.io --app auxilo
flyctl certs show auxilo.io --app auxilo
```

The `certs show` output prints the required DNS records. Typical layout
for an apex domain:

- `auxilo.io`      A     → <Fly shared-v4 IP from certs show>
- `auxilo.io`      AAAA  → <Fly shared-v6 IP from certs show>
- `_acme-challenge.auxilo.io` CNAME → <value from certs show>
- `www.auxilo.io`  CNAME → auxilo.fly.dev

Apex A/AAAA vs ALIAS: if your registrar supports CNAME flattening or
ALIAS records (Cloudflare, DNSimple, Route53), prefer that for the apex.

Re-run `flyctl certs show` every couple of minutes until both "DNS
Validated" and "Certificate Issued" flip to green. Usually <5 min.

Once issued, test:
```bash
curl -fsS https://auxilo.io/health
curl -fsS https://www.auxilo.io/health
```

---

## 10. Post-cut verification

- [ ] `/health` green on both `*.fly.dev` and `auxilo.io`.
- [ ] A known agent can call `/extract` end-to-end and the audit chain
  line lands on the Fly volume (`flyctl ssh console -C "tail -n 2 /app/data/audit-extractions.jsonl"`).
- [ ] A known builder can hit `/account/earnings` and see the migrated
  totals.
- [ ] `/stats` learning count matches pre-migration.
- [ ] Stripe webhooks (if enabled) — update the Stripe dashboard
  endpoint URL from the Conway URL to `https://auxilo.io/stripe/webhook`
  and rotate `STRIPE_WEBHOOK_SECRET` via `flyctl secrets set`.
- [ ] Update any hard-coded Conway URLs in client tooling:
  `mcp-server.js` default base URL, `.well-known/agent.json` entries,
  `openapi.json` `servers[]`.

---

## 11. Decommission Conway (AFTER 72h soak)

Do not tear down Conway until you've had at least 72h of clean traffic
on Fly AND a verified snapshot of the Fly volume.

```bash
flyctl volumes snapshots create <volume-id>
```

Then on Conway: stop the node process, archive `/app/data` to your
long-term backup store, and release the sandbox.

---

## 12. Rollback

If Fly breaks in a way you can't fix forward inside ~15 min, roll back.

### 12a. Roll back to a previous Fly release

```bash
flyctl releases --app auxilo
# Find the last known-good release version
flyctl deploy --app auxilo --image <registry.fly.io/auxilo:deployment-NNN>
```

`flyctl releases` prints the image ref for each past release; pass it
to `flyctl deploy --image` to redeploy that exact image. Secrets and
volume contents are unaffected.

### 12b. Full rollback to Conway (nuclear)

1. Update DNS: point `auxilo.io` A/AAAA back to the Conway sandbox URL
   (or revert to the CNAME you had before cut-over). TTL permitting,
   traffic shifts in minutes.
2. On Conway: `nohup node server.js &` if not already running.
3. On Fly: `flyctl scale count 0 --app auxilo` to stop accepting
   traffic (but preserve the volume for forensics).

The Conway `/app/data` is unchanged by Fly — you are rolling back to a
snapshot, not re-syncing. Any writes that happened on Fly during the
attempted cut-over are isolated on the Fly volume; export them via
§6b-style tar if you need to reconcile.

---

## Known gotchas

- **Fly volumes are single-AZ.** A region outage = downtime for the
  stateful machine. Snapshots are your DR. Tyler has accepted this for
  the pilot; multi-AZ requires moving state off local disk (SQLite on
  Litefs, Postgres, S3) which is a separate build spec.
- **Rotating `SESSION_SECRET` invalidates every JWT.** If that's the
  intent (say, after a suspected leak), fine. Otherwise preserve the
  Conway value in §5.
- **`WALLET_PRIVATE_KEY` must be set or server FATALs.** Same goes for
  `SESSION_SECRET` when `NODE_ENV=production`. No partial-start mode.
- **Single-writer audit chain.** Never scale `min_machines_running` or
  `flyctl scale count` above 1 without first migrating the audit
  writer off local disk. Two machines writing to the same JSONL over a
  shared volume will corrupt the hash chain.
- **`auto_stop_machines = false` is intentional.** Idle-stop would
  interrupt the processing-unresolved daemon and the OpenClaw memory
  daemon that run in-process.
- **Build context size.** `.dockerignore` already excludes `data/` and
  `node_modules/`. If you add large fixtures, add them there too —
  Fly's builder is slow past ~200MB of context.
- **Local `npm ci` drift.** If `package-lock.json` has packages not
  declared in `package.json` (Hono, jose, etc. are in the lockfile but
  not the top-level `dependencies`), `npm ci` still installs them. Do
  NOT run `npm install` at build time — it would rewrite the lockfile
  and potentially remove those packages.
