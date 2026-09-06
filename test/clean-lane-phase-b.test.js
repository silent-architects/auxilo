'use strict';

/**
 * test/clean-lane-phase-b.test.js — CLEAN-LANE-FLIP Phase B (server/contract):
 * activation e2e on a staged server with EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED
 * set explicitly to 'true' (the value fly.toml ships at the flip).
 *
 *   (a) GET /account/clean-lane → 200, clean_lane_active:false before any grant
 *   (b) grant with the exact affirmation → 200; status shows active + min quality
 *   (c) wrong affirmation → 400 AFFIRMATION_TEXT_MISMATCH; stale version → 409
 *       CONSENT_VERSION_MISMATCH; agree!==true → 400 AFFIRMATION_REQUIRED;
 *       out-of-range threshold → 400
 *   (d) a clean, ≥16 extraction-channel submission from a TRUSTED account
 *       (publication_trust stamped) auto-publishes: approved + published_via +
 *       retractable_until + standing_consent_version + notice
 *   (e) the same submission from an account WITHOUT publication trust holds
 *       with review_reason containing untrusted_account — the first-learning
 *       hold survives enrollment
 *   (g) quality below the account's threshold holds below_auto_publish_threshold
 *   (f) revoke → 200; the next extraction item holds standing_consent_off
 *
 * Screens fixture (STOP-gate compliant): LLM_SENSITIVITY_ENABLED=false turns
 * the LLM layer off (it fails CLOSED without a provider key and would hold
 * everything, masking the lane); the regex sensitivity screen, the injection
 * screen, the near-duplicate screen and the quality floor all stay LIVE. No
 * screen is stubbed to pass. Bodies are deliberately boring tech prose.
 *
 * Runner: node --test test/clean-lane-phase-b.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const cleanLane = require('../lib/clean-lane.js');

// Gate-A 2026-09-06 (N1): fly.toml ships the flip armed and moderation never
// disabled. A source pin, not a staged server: the deploy config is the fact.
describe('CLEAN-LANE-FLIP Phase B: fly.toml deploy config pins', () => {
  it('fly.toml [env] sets EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED = "true" exactly and never sets CONTENT_MODERATION_ENABLED to "false"', () => {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'fly.toml'), 'utf8');
    const lines = toml.split('\n');
    const envStart = lines.findIndex((l) => /^\[env\]\s*$/.test(l));
    assert.ok(envStart >= 0, 'fly.toml has an [env] block');
    let envEnd = lines.findIndex((l, i) => i > envStart && /^\[/.test(l));
    if (envEnd < 0) envEnd = lines.length;
    const envBlock = lines.slice(envStart + 1, envEnd).map((l) => l.trim());
    const armed = envBlock.filter((l) => /^EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED = "true"$/.test(l));
    assert.equal(armed.length, 1, 'exactly one exact-"true" flag line inside [env]');
    assert.equal(lines.filter((l) => /^\s*EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED\s*=/.test(l)).length, 1,
      'the flag is set once in the whole file (no later override)');
    assert.ok(!/^\s*CONTENT_MODERATION_ENABLED\s*=\s*"false"/m.test(toml),
      'CONTENT_MODERATION_ENABLED is never set to "false" anywhere in fly.toml');
  });
});

const REPO_ROOT = path.join(__dirname, '..');

const TRUSTED_KEY = 'axl_' + 'b'.repeat(40);
const UNTRUSTED_KEY = 'axl_' + 'c'.repeat(40);
const TRUSTED = 'acc_phaseb_trusted';
const UNTRUSTED = 'acc_phaseb_untrusted';

function fixtureCatalog() {
  // Clone a real seed record so every field migrations/scoring expect exists.
  // Non-empty catalog = no CS-1 re-seeding.
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  const l = JSON.parse(JSON.stringify(base));
  l.id = 'phaseb_seed_1';
  l.status = 'approved';
  return [l];
}

function apiKey(id, raw, label) {
  return {
    id,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    label,
    scope: 'contribute',
    scope_version: 2,
    created_at: new Date().toISOString(),
    active: true,
  };
}

function fixtureAccounts() {
  const now = new Date().toISOString();
  return {
    [TRUSTED]: {
      id: TRUSTED,
      email: 'phaseb-trusted@test.local',
      created_at: now,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: now,
      // The operator approve of a first learning stamps this; a fixture stamp
      // is the same shape (spec3-b1 boot pattern).
      publication_trust: { source: 'operator_grant', granted_at: now, ref: 'operator:phase-b-fixture' },
      api_keys: [apiKey('key_phaseb_trusted', TRUSTED_KEY, 'phaseb-trusted')],
    },
    [UNTRUSTED]: {
      id: UNTRUSTED,
      email: 'phaseb-untrusted@test.local',
      created_at: now,
      tos_version: '2026-07-04-payee-agency-a1',
      accepted_at: now,
      // NO publication_trust: a fresh account whose first public learning
      // must still hold for operator review, enrolled or not.
      api_keys: [apiKey('key_phaseb_untrusted', UNTRUSTED_KEY, 'phaseb-untrusted')],
    },
  };
}

/** Clean, floor-passing extraction-channel /learn payloads. Distinct topics so
 *  the near-duplicate screen never fires between them. */
const TOPICS = {
  publish: {
    title: 'Flush stdout before process exit in piped node scripts',
    body: 'When a node script writes a large buffer to stdout and the output is piped, calling process.exit immediately truncates the tail; wait for the write callback or set the exit code and let the event loop drain so the consumer receives every byte.',
    tags: ['node', 'stdout', 'pipes'],
  },
  untrusted: {
    title: 'Set explicit content-length on chunked uploads to object storage',
    body: 'Some object storage gateways reject streamed uploads that omit a content-length header even when transfer-encoding chunked is set; compute the size up front or use the multipart upload api so each part carries its own length.',
    tags: ['object-storage', 'upload', 'http'],
  },
  threshold: {
    title: 'Increase the default header size limit for long bearer tokens',
    body: 'Reverse proxies reject requests whose combined header size exceeds the default eight kilobyte limit; long bearer tokens plus tracing headers cross it silently, so raise the large-header buffer setting and log the rejection code where the proxy exposes it.',
    tags: ['proxy', 'headers', 'limits'],
  },
  revoked: {
    title: 'Disable keepalive when load testing behind a layer four balancer',
    body: 'A layer four balancer pins each persistent connection to one backend, so a load test with keepalive enabled hammers a single instance and under-reports capacity; disable keepalive or open many connections to spread load across the pool.',
    tags: ['load-testing', 'keepalive', 'balancer'],
  },
};

function extractionPayload(key, total = 16) {
  const per = Math.floor(total / 4);
  const rem = total - per * 4;
  return {
    ...TOPICS[key],
    category: 'code-execution',
    task_context: 'clean-lane phase b activation e2e',
    outcome: 'success',
    contributor_agent: 'auxilo-hook/claude-code',
    submission_channel: 'extraction',
    quality_self_assessment: {
      specificity: per + (rem > 0 ? 1 : 0),
      actionability: per + (rem > 1 ? 1 : 0),
      novelty: per + (rem > 2 ? 1 : 0),
      completeness: per,
      total,
    },
  };
}

describe('CLEAN-LANE-FLIP Phase B: activation e2e (flag explicitly on)', () => {
  it('status → grant → auto-publish (trusted) / hold (untrusted, below-threshold, revoked)', { timeout: 240_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
      );
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot');
      return;
    }
    const reservation = await reservePort();
    if (reservation.skipReason) {
      t.skip(reservation.skipReason);
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-clean-lane-b-'));
    let child = null;
    let baseUrl;
    const headers = (key) => ({ 'X-API-Key': key, 'Content-Type': 'application/json' });
    const get = async (p, key, expectStatus = 200) => {
      const res = await fetch(`${baseUrl}${p}`, { headers: headers(key) });
      assert.equal(res.status, expectStatus, `GET ${p} → ${res.status}`);
      return res.json();
    };
    const post = async (p, body, key, expectStatus) => {
      const res = await fetch(`${baseUrl}${p}`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
      assert.equal(res.status, expectStatus, `POST ${p} → ${res.status}: ${JSON.stringify(await res.clone().json().catch(() => ({})))}`);
      return res.json();
    };
    const grantBody = {
      consent_version: cleanLane.CLEAN_LANE_CONSENT_VERSION,
      agree: true,
      affirmation: cleanLane.CLEAN_LANE_AFFIRMATION,
    };

    try {
      stageServer({
        repoRoot: REPO_ROOT,
        tmpDir,
        nodeModulesDir,
        port: reservation.port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['lib', 'public', 'prompts', 'config'],
        replacements: [],
      });
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
      fs.writeFileSync(path.join(tmpDir, 'data', 'accounts.json'), JSON.stringify(fixtureAccounts(), null, 2));

      const boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: {
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
          // Regex-only sensitivity: the LLM layer fails CLOSED without a
          // provider key and would hold every submission, masking the lane.
          // The regex screen, injection screen, near-dup and quality floor
          // stay live — nothing is stubbed to pass.
          LLM_SENSITIVITY_ENABLED: 'false',
          AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
          AUXILO_ACCOUNTS_FILE: path.join(tmpDir, 'data', 'accounts.json'),
          // The Phase B flip value, set EXPLICITLY (never the process default).
          EXTRACTION_AUTOPUBLISH_CONSENT_ENABLED: 'true',
        },
        timeoutMs: 60_000,
        maxAttempts: 4,
      });
      if (boot.skipReason) {
        t.skip(boot.skipReason);
        return;
      }
      child = boot.child;
      baseUrl = boot.baseUrl;

      // (a) status before any grant: 200 (not 404), inactive, current version.
      const s0 = await get('/account/clean-lane', TRUSTED_KEY);
      assert.equal(s0.account_id, TRUSTED);
      assert.equal(s0.clean_lane_active, false);
      assert.equal(s0.consent_version_current, cleanLane.CLEAN_LANE_CONSENT_VERSION);
      assert.equal(s0.last_action, undefined, 'no consent row yet');

      // (c) refusals BEFORE any grant, so a refused call provably records nothing.
      const wrong = await post('/account/clean-lane/grant',
        { ...grantBody, affirmation: cleanLane.CLEAN_LANE_AFFIRMATION.replace(/\.$/, '') }, TRUSTED_KEY, 400);
      assert.equal(wrong.code, 'AFFIRMATION_TEXT_MISMATCH');
      assert.ok(!wrong.error.includes(cleanLane.CLEAN_LANE_AFFIRMATION), 'the 400 must not echo the sentence');
      const stale = await post('/account/clean-lane/grant',
        { ...grantBody, consent_version: '2025-01-01-clean-lane-a0' }, TRUSTED_KEY, 409);
      assert.equal(stale.code, 'CONSENT_VERSION_MISMATCH');
      assert.equal(stale.current_consent_version, cleanLane.CLEAN_LANE_CONSENT_VERSION);
      const notAgreed = await post('/account/clean-lane/grant', { ...grantBody, agree: 'true' }, TRUSTED_KEY, 400);
      assert.equal(notAgreed.code, 'AFFIRMATION_REQUIRED');
      await post('/account/clean-lane/grant', { ...grantBody, min_auto_publish_quality: 21 }, TRUSTED_KEY, 400);
      await post('/account/clean-lane/grant', { ...grantBody, min_auto_publish_quality: 13 }, TRUSTED_KEY, 400);
      const sAfterRefusals = await get('/account/clean-lane', TRUSTED_KEY);
      assert.equal(sAfterRefusals.clean_lane_active, false, 'refused grants must record nothing');
      assert.equal(sAfterRefusals.last_action, undefined);

      // (b) grant with the exact affirmation → active at the default threshold.
      const g1 = await post('/account/clean-lane/grant', grantBody, TRUSTED_KEY, 200);
      assert.equal(g1.clean_lane_active, true);
      assert.equal(g1.consent_version, cleanLane.CLEAN_LANE_CONSENT_VERSION);
      assert.equal(g1.min_auto_publish_quality, 16);
      assert.equal(g1.tos_version_at_grant, '2026-07-04-payee-agency-a1');
      assert.ok(g1.granted_at);
      const s1 = await get('/account/clean-lane', TRUSTED_KEY);
      assert.equal(s1.clean_lane_active, true);
      assert.equal(s1.last_action, 'grant');
      assert.equal(s1.min_auto_publish_quality, 16);
      assert.equal(s1.consent_version_recorded, cleanLane.CLEAN_LANE_CONSENT_VERSION);
      // Gate-A 2026-09-06 (S2): the persisted grant row records the affirmation
      // as sha256(exact text received) — here byte-equal to CLEAN_LANE_AFFIRMATION.
      const grantRows = fs.readFileSync(path.join(tmpDir, 'data', 'clean-lane-consent.jsonl'), 'utf8')
        .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.action === 'grant');
      assert.equal(grantRows.length, 1);
      assert.equal(grantRows[0].affirmed, true);
      assert.equal(grantRows[0].affirmation_sha256,
        crypto.createHash('sha256').update(cleanLane.CLEAN_LANE_AFFIRMATION, 'utf8').digest('hex'));

      // (d) trusted account, clean, 16/20, extraction channel → AUTO-PUBLISHES.
      const r1 = await post('/learn', extractionPayload('publish', 16), TRUSTED_KEY, 201);
      assert.equal(r1.status, 'approved', `expected auto-publish, got ${r1.status} (${JSON.stringify(r1.review_reason || [])})`);
      assert.equal(r1.published_via, cleanLane.PUBLISHED_VIA_CLEAN_LANE);
      assert.equal(r1.standing_consent_version, cleanLane.CLEAN_LANE_CONSENT_VERSION);
      assert.ok(r1.retractable_until, 'retractable_until must be stamped');
      const windowMs = new Date(r1.retractable_until).getTime() - Date.now();
      assert.ok(windowMs > 6.9 * 86400000 && windowMs <= 7 * 86400000 + 5000, `7-day window, got ${windowMs}ms`);
      assert.ok(typeof r1.standing_consent_notice === 'string' && r1.standing_consent_notice.includes('Retractable until'));
      assert.equal(r1.review_reason, undefined);

      // (e) SAME shape from an account WITHOUT publication trust: enrolling
      // does not skip the first-learning operator hold.
      const gU = await post('/account/clean-lane/grant', grantBody, UNTRUSTED_KEY, 200);
      assert.equal(gU.clean_lane_active, true);
      assert.equal((await get('/account/clean-lane', UNTRUSTED_KEY)).clean_lane_active, true);
      const rU = await post('/learn', extractionPayload('untrusted', 16), UNTRUSTED_KEY, 201);
      assert.equal(rU.status, 'pending_review', 'an untrusted account must never auto-publish, enrolled or not');
      assert.ok(rU.review_reason.includes('untrusted_account'), `expected untrusted_account, got ${JSON.stringify(rU.review_reason)}`);
      assert.equal(rU.published_via, undefined);
      assert.equal(rU.retractable_until, undefined);
      assert.match(rU.how_to_review, /operator review/);

      // (g) trusted account re-grants at threshold 18 → a 16/20 item holds.
      const g2 = await post('/account/clean-lane/grant', { ...grantBody, min_auto_publish_quality: 18 }, TRUSTED_KEY, 200);
      assert.equal(g2.min_auto_publish_quality, 18);
      assert.equal((await get('/account/clean-lane', TRUSTED_KEY)).min_auto_publish_quality, 18);
      const rT = await post('/learn', extractionPayload('threshold', 16), TRUSTED_KEY, 201);
      assert.equal(rT.status, 'pending_review');
      assert.ok(rT.review_reason.includes(cleanLane.HOLD_BELOW_AUTO_PUBLISH_THRESHOLD),
        `expected below_auto_publish_threshold, got ${JSON.stringify(rT.review_reason)}`);
      assert.equal(rT.published_via, undefined);

      // (f) revoke → inactive; the next clean extraction item holds standing_consent_off.
      const rv = await post('/account/clean-lane/revoke', {}, TRUSTED_KEY, 200);
      assert.equal(rv.clean_lane_active, false);
      assert.ok(rv.revoked_at);
      const s2 = await get('/account/clean-lane', TRUSTED_KEY);
      assert.equal(s2.clean_lane_active, false);
      assert.equal(s2.last_action, 'revoke');
      assert.equal(s2.min_auto_publish_quality, undefined, 'threshold is a grant-only field');
      const rR = await post('/learn', extractionPayload('revoked', 18), TRUSTED_KEY, 201);
      assert.equal(rR.status, 'pending_review');
      assert.ok(rR.review_reason.includes(cleanLane.HOLD_STANDING_CONSENT_OFF),
        `expected standing_consent_off, got ${JSON.stringify(rR.review_reason)}`);
      assert.equal(rR.published_via, undefined);

      // The auto-published item is the ONLY approved one from this run, and the
      // listing carries its stamps (Phase A2 notice surface).
      const listing = await get('/account/learnings?status=approved', TRUSTED_KEY);
      const mine = (listing.learnings || listing.items || []).filter((l) => l.id === r1.id);
      assert.equal(mine.length, 1, `auto-published item must appear in the owner listing: ${JSON.stringify(Object.keys(listing))}`);
      assert.equal(mine[0].published_via, cleanLane.PUBLISHED_VIA_CLEAN_LANE);
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
