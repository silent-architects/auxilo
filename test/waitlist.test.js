'use strict';

/**
 * test/waitlist.test.js: quiet-phase payout-notification waitlist.
 *
 * WAITLIST-DEAD-CODE (2026-09-06): POST /waitlist (the join route) is
 * removed from server.js — after W2 cut the Notify-me form
 * (public/for-builders.html), it had zero callers anywhere in the repo.
 * lib/waitlist.js and its data (data/waitlist.json) are UNTOUCHED: the
 * write functions (addToWaitlist, isWaitlistRateLimited) remain exported
 * and still directly unit-tested below (section A), and the two storage
 * readers/consumers that remain wired into server.js — GET /waitlist/count
 * (aggregate reporting) and the GOV2-DEL account-deletion purge
 * (removeWaitlistEmail) — are untouched and still covered.
 *
 * Three layers, matching the repo's conventions:
 *   A) Behavioral unit tests of the pure logic in lib/waitlist.js
 *      (validation, normalization, dedupe, storage shape, capacity ceiling,
 *      per-IP rate limiter) against a private temp data dir via
 *      AUXILO_DATA_DIR, mirroring test/p2-1a-audit-chain.test.js isolation.
 *   B) Structural tests that server.js wires the surviving routes
 *      correctly: the count endpoint exists and stays email-free, and
 *      data/ stays gitignored so emails never enter git. This mirrors
 *      test/r01-launch-blockers.test.js, which analyzes server.js source
 *      rather than booting the whole app.
 *   C) Staged-server proof that POST /waitlist is actually gone (404, not
 *      just absent from a source-string check) and that no "waitlist"
 *      string survives anywhere under public/. Staged-server pattern:
 *      test/ad-routes.test.js.
 *
 * Runner: node --test test/waitlist.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

// Route this file's writes into a private temp dir. lib/waitlist.js reads
// AUXILO_DATA_DIR at require() time, so this must be set before the require.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-waitlist-'));
process.env.AUXILO_DATA_DIR = DATA_DIR;

const waitlist = require('../lib/waitlist.js');
const WAITLIST_FILE = path.join(DATA_DIR, 'waitlist.json');

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf-8');

function sliceHandler(marker, span = 2500) {
  const i = SERVER_SRC.indexOf(marker);
  assert.notEqual(i, -1, `handler not found: ${marker}`);
  return SERVER_SRC.slice(i, i + span);
}

function readStored() {
  return JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
}

function resetStore() {
  try { fs.unlinkSync(WAITLIST_FILE); } catch { /* not written yet */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Unit: validation
// ─────────────────────────────────────────────────────────────────────────────
describe('addToWaitlist: email validation', () => {
  beforeEach(resetStore);

  for (const bad of [undefined, null, '', '   ', 'not-an-email', 'a@b', 'no at sign.com', 'two@@x.io', 'spaced name@x.io', 42, {}]) {
    it(`rejects ${JSON.stringify(bad)} with a 400-shaped error`, () => {
      const r = waitlist.addToWaitlist(bad, 'status');
      assert.equal(r.ok, false);
      assert.equal(r.status, 400);
      assert.ok(r.error);
      assert.ok(!fs.existsSync(WAITLIST_FILE), 'nothing may be written for invalid input');
    });
  }

  it('rejects an address longer than the RFC ceiling', () => {
    const long = 'a'.repeat(waitlist.EMAIL_MAX) + '@x.io';
    const r = waitlist.addToWaitlist(long, 'status');
    assert.equal(r.ok, false);
    assert.equal(r.status, 400);
  });

  it('accepts a well-formed address and persists it', () => {
    const r = waitlist.addToWaitlist('builder@example.com', 'status');
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, false);
    const stored = readStored();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].email, 'builder@example.com');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Unit: normalization + dedupe
// ─────────────────────────────────────────────────────────────────────────────
describe('addToWaitlist: normalization and dedupe', () => {
  beforeEach(resetStore);

  it('normalizes case and whitespace, then dedupes on the normalized form', () => {
    const first = waitlist.addToWaitlist('  Builder@Example.COM ', 'status');
    assert.equal(first.ok, true);
    assert.equal(first.duplicate, false);

    const second = waitlist.addToWaitlist('builder@example.com', 'for-builders');
    assert.equal(second.ok, true, 'a duplicate is still ok (silent success)');
    assert.equal(second.duplicate, true);

    const stored = readStored();
    assert.equal(stored.length, 1, 'the list must hold exactly one entry');
    assert.equal(stored[0].email, 'builder@example.com');
    assert.equal(stored[0].source, 'status', 'the original entry is untouched by the duplicate');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Unit: storage shape (PII-minimal contract)
// ─────────────────────────────────────────────────────────────────────────────
describe('waitlist storage shape', () => {
  beforeEach(resetStore);

  it('stores exactly { email, ts, source } and nothing else', () => {
    waitlist.addToWaitlist('shape@example.com', 'status');
    const [entry] = readStored();
    assert.deepEqual(Object.keys(entry).sort(), ['email', 'source', 'ts']);
    assert.equal(entry.email, 'shape@example.com');
    assert.equal(entry.source, 'status');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'ts must be a parseable ISO timestamp');
    const raw = fs.readFileSync(WAITLIST_FILE, 'utf8');
    assert.ok(!/"ip"/.test(raw), 'no IP field may ever be persisted');
  });

  it('stores source as null when omitted or not a string', () => {
    waitlist.addToWaitlist('nosource@example.com');
    waitlist.addToWaitlist('numsource@example.com', 42);
    const stored = readStored();
    assert.equal(stored[0].source, null);
    assert.equal(stored[1].source, null);
  });

  it('caps an oversized source label', () => {
    waitlist.addToWaitlist('capped@example.com', 'x'.repeat(500));
    const [entry] = readStored();
    assert.equal(entry.source.length, waitlist.SOURCE_MAX);
  });

  it('recovers cleanly from a corrupt store file', () => {
    fs.writeFileSync(WAITLIST_FILE, '{not json');
    assert.equal(waitlist.waitlistCount(), 0);
    const r = waitlist.addToWaitlist('after-corruption@example.com', 'status');
    assert.equal(r.ok, true);
    assert.equal(readStored().length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Unit: capacity ceiling + count
// ─────────────────────────────────────────────────────────────────────────────
describe('waitlist capacity and count', () => {
  beforeEach(resetStore);

  it('waitlistCount tracks stored entries', () => {
    assert.equal(waitlist.waitlistCount(), 0);
    waitlist.addToWaitlist('one@example.com', 'status');
    waitlist.addToWaitlist('two@example.com', 'status');
    assert.equal(waitlist.waitlistCount(), 2);
  });

  it('refuses new signups past WAITLIST_MAX with a 503-shaped error', () => {
    const ts = new Date().toISOString();
    const full = Array.from({ length: waitlist.WAITLIST_MAX }, (_, i) => ({
      email: `u${i}@example.com`, ts, source: null,
    }));
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify(full));
    const r = waitlist.addToWaitlist('overflow@example.com', 'status');
    assert.equal(r.ok, false);
    assert.equal(r.status, 503);
    assert.equal(waitlist.waitlistCount(), waitlist.WAITLIST_MAX, 'nothing added past the ceiling');
  });

  it('a duplicate still succeeds at capacity (no membership leak via 503)', () => {
    const ts = new Date().toISOString();
    const full = Array.from({ length: waitlist.WAITLIST_MAX }, (_, i) => ({
      email: `u${i}@example.com`, ts, source: null,
    }));
    fs.writeFileSync(WAITLIST_FILE, JSON.stringify(full));
    const r = waitlist.addToWaitlist('u0@example.com', 'status');
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Unit: per-IP rate limiter
// ─────────────────────────────────────────────────────────────────────────────
describe('isWaitlistRateLimited', () => {
  it(`allows ${waitlist.WAITLIST_RATE_LIMIT} requests then blocks, per IP`, () => {
    const ip = '203.0.113.7';
    for (let i = 0; i < waitlist.WAITLIST_RATE_LIMIT; i++) {
      assert.equal(waitlist.isWaitlistRateLimited(ip), false, `request ${i + 1} must pass`);
    }
    assert.equal(waitlist.isWaitlistRateLimited(ip), true, 'the next request must be limited');
    assert.equal(waitlist.isWaitlistRateLimited('203.0.113.8'), false, 'a different IP is unaffected');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural: server.js route wiring (surviving routes only)
// ─────────────────────────────────────────────────────────────────────────────
describe('server.js waitlist route wiring', () => {
  it('POST /waitlist no longer exists in server.js source', () => {
    assert.ok(!SERVER_SRC.includes("app.post('/waitlist'"), 'the POST /waitlist route must be removed (WAITLIST-DEAD-CODE)');
    assert.ok(!SERVER_SRC.includes('addToWaitlist('), 'the write path must no longer be called from server.js');
    assert.ok(!SERVER_SRC.includes('isWaitlistRateLimited('), 'the per-IP limiter must no longer be called from server.js');
  });

  it('GET /waitlist/count returns only an aggregate count (storage reader survives, untouched)', () => {
    const h = sliceHandler("app.get('/waitlist/count'", 400);
    assert.ok(h.includes('waitlistCount()'));
    assert.ok(!h.includes('email'), 'the count endpoint must not touch email fields');
    assert.ok(SERVER_SRC.includes("require('./lib/waitlist.js')"), 'server.js must still import the lib for the surviving readers');
  });

  it('removeWaitlistEmail still wired into the GOV2-DEL account-deletion purge', () => {
    assert.ok(SERVER_SRC.includes('removeWaitlistEmail('), 'the deletion-purge storage consumer must remain untouched');
  });

  it('data/ is gitignored so waitlist emails can never enter git', () => {
    const gitignore = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf-8');
    assert.ok(gitignore.split('\n').some(line => line.trim() === 'data/'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Staged-server proof: POST /waitlist is actually gone; no "waitlist"
//    string survives anywhere under public/.
// ─────────────────────────────────────────────────────────────────────────────
describe('WAITLIST-DEAD-CODE: staged-server removal proof', { timeout: 180_000 }, () => {
  it('no "waitlist" string remains anywhere under public/', () => {
    function walk(dir, out) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else out.push(full);
      }
      return out;
    }
    const files = walk(path.join(REPO, 'public'), []);
    assert.ok(files.length > 0, 'sanity: public/ must contain files to check');
    const offenders = files.filter((f) => fs.readFileSync(f, 'utf8').toLowerCase().includes('waitlist'));
    assert.deepEqual(offenders, [], 'no file under public/ may contain the string "waitlist"');
  });

  describe('served route (staged server)', () => {
    let tmpDir;
    let child;
    let baseUrl;
    let bootSkipReason = null;

    before(async () => {
      const honoEntry = require.resolve('hono', { paths: [REPO] });
      const nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
      );
      const reservation = await reservePort();
      if ('skipReason' in reservation) {
        assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
        bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
        return;
      }
      const { port } = reservation;
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-waitlist-dead-code-'));
      stageServer({
        repoRoot: REPO,
        tmpDir,
        nodeModulesDir,
        port,
        rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
        linkDirs: ['lib', 'public', 'prompts', 'config'],
        replacements: [],
      });

      const boot = await bootServer({
        tmpDir,
        port,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          LLM_SENSITIVITY_ENABLED: 'false',
          SESSION_SECRET: 'waitlist-dead-code-test-session-secret-0123456789',
          AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
        },
        timeoutMs: 60_000,
        maxAttempts: 3,
      });
      if ('skipReason' in boot) {
        assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
        bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
        return;
      }
      child = boot.child;
      baseUrl = boot.baseUrl;
    });

    after(async () => {
      if (child) await stopServer(child);
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('POST /waitlist -> 404 on the staged server', async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'gone@example.com', source: 'test' }),
      });
      assert.equal(res.status, 404, 'the removed join route must answer 404');
    });

    it('GET /waitlist/count still 200s (surviving storage reader)', async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}/waitlist/count`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(typeof body.count, 'number');
    });
  });
});
