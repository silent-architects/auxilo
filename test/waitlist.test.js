'use strict';

/**
 * test/waitlist.test.js: quiet-phase payout-notification waitlist.
 *
 * Two layers, matching the repo's conventions:
 *   A) Behavioral unit tests of the pure logic in lib/waitlist.js
 *      (validation, normalization, dedupe, storage shape, capacity ceiling,
 *      per-IP rate limiter) against a private temp data dir via
 *      AUXILO_DATA_DIR, mirroring test/p2-1a-audit-chain.test.js isolation.
 *   B) Structural tests that server.js wires the routes correctly: the rate
 *      limit runs before body parsing, duplicates get the same response as
 *      first-time signups (no membership leak), the count endpoint exists,
 *      and data/ stays gitignored so emails never enter git. This mirrors
 *      test/r01-launch-blockers.test.js, which analyzes server.js source
 *      rather than booting the whole app.
 *
 * Runner: node --test test/waitlist.test.js
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Route this file's writes into a private temp dir. lib/waitlist.js reads
// AUXILO_DATA_DIR at require() time, so this must be set before the require.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-waitlist-'));
process.env.AUXILO_DATA_DIR = DATA_DIR;

const waitlist = require('../lib/waitlist.js');
const WAITLIST_FILE = path.join(DATA_DIR, 'waitlist.json');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

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
// B. Structural: server.js route wiring
// ─────────────────────────────────────────────────────────────────────────────
describe('server.js POST /waitlist wiring', () => {
  it('the route exists and delegates to lib/waitlist.js', () => {
    const h = sliceHandler("app.post('/waitlist'");
    assert.ok(h.includes('addToWaitlist('), 'must delegate validation/storage to the lib');
    assert.ok(SERVER_SRC.includes("require('./lib/waitlist.js')"), 'server.js must import the lib');
  });

  it('rate-limits by client IP BEFORE parsing the body (mirrors /report)', () => {
    const h = sliceHandler("app.post('/waitlist'");
    const ipAt   = h.indexOf('getClientIp(c)');
    const rlAt   = h.indexOf('isWaitlistRateLimited(');
    const bodyAt = h.indexOf('c.req.json()');
    assert.ok(ipAt !== -1 && rlAt !== -1 && bodyAt !== -1);
    assert.ok(rlAt < bodyAt, 'the limiter must run before body parsing');
    assert.ok(/\}, 429\)/.test(h), 'must return HTTP 429 when limited');
  });

  it('returns the SAME success body for new and duplicate emails (no membership probe)', () => {
    const h = sliceHandler("app.post('/waitlist'");
    assert.ok(h.includes('c.json({ ok: true })'), 'must return the uniform success body');
    assert.ok(!h.includes('result.duplicate'), 'the response must not branch on duplicate status');
    assert.ok(!/already/i.test(h), 'no already-on-the-list wording may reach the client');
  });

  it('GET /waitlist/count returns only an aggregate count', () => {
    const h = sliceHandler("app.get('/waitlist/count'", 400);
    assert.ok(h.includes('waitlistCount()'));
    assert.ok(!h.includes('email'), 'the count endpoint must not touch email fields');
  });

  it('data/ is gitignored so waitlist emails can never enter git', () => {
    const gitignore = fs.readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf-8');
    assert.ok(gitignore.split('\n').some(line => line.trim() === 'data/'));
  });
});
