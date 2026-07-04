'use strict';

/**
 * test/tos-clickwrap-assent.test.js — R-01 / red-team P0-3 clickwrap assent capture
 *
 * The payee-agency appointment (Terms §5.10) only binds a Builder who has
 * AFFIRMATIVELY accepted the current Terms and whose assent is captured as a
 * durable record. Assent-via-use does not bind. These tests prove the capture
 * layer: the version-of-record + per-account consent artifact + helpers
 * (unit-level, real logic), and that the blocking gates + endpoints exist and are
 * positioned correctly on both the web and MCP/API paths (source-level, the same
 * handler-verification style as security-money-m1-unified-ledger.test.js).
 *
 * Runner: node --test test/tos-clickwrap-assent.test.js
 *
 * accounts.js imports 'jose' at load and warns without SESSION_SECRET; set a dummy.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  CURRENT_TOS_VERSION,
  hasAcceptedCurrentTos,
  getTosStatus,
  recordTosAcceptance,
} = require('../lib/accounts.js');

// ─── 1. Version of record ──────────────────────────────────────────────────────

describe('CURRENT_TOS_VERSION', () => {
  it('is a non-empty string usable as a stable version identifier', () => {
    assert.equal(typeof CURRENT_TOS_VERSION, 'string');
    assert.ok(CURRENT_TOS_VERSION.length > 0);
  });
});

// ─── 2. hasAcceptedCurrentTos — the gate decision (pure) ────────────────────────

describe('hasAcceptedCurrentTos', () => {
  it('false when no consent artifact exists (assent-via-use never binds)', () => {
    assert.equal(hasAcceptedCurrentTos({ email: 'a@example.com' }), false);
  });
  it('false when account is null/undefined', () => {
    assert.equal(hasAcceptedCurrentTos(null), false);
    assert.equal(hasAcceptedCurrentTos(undefined), false);
  });
  it('false when a stale (prior) version was accepted — forces re-prompt on bump', () => {
    assert.equal(hasAcceptedCurrentTos({ tos_version: 'old-version', accepted_at: Date.now() }), false);
  });
  it('false when version matches but no accepted_at timestamp is present', () => {
    assert.equal(hasAcceptedCurrentTos({ tos_version: CURRENT_TOS_VERSION }), false);
  });
  it('true only when the CURRENT version was accepted with a timestamp', () => {
    assert.equal(hasAcceptedCurrentTos({ tos_version: CURRENT_TOS_VERSION, accepted_at: Date.now() }), true);
  });
});

// ─── 3. getTosStatus — machine-readable state for web + MCP ─────────────────────

describe('getTosStatus', () => {
  it('reports needs_acceptance=true for an un-accepted account', () => {
    const s = getTosStatus({ email: 'a@example.com' });
    assert.equal(s.current_tos_version, CURRENT_TOS_VERSION);
    assert.equal(s.accepted, false);
    assert.equal(s.needs_acceptance, true);
    assert.equal(s.accepted_version, null);
    assert.equal(s.accepted_at, null);
  });
  it('reports needs_acceptance=true when a stale version was accepted', () => {
    const s = getTosStatus({ tos_version: 'old', accepted_at: 123 });
    assert.equal(s.accepted, false);
    assert.equal(s.needs_acceptance, true);
    assert.equal(s.accepted_version, 'old');
  });
  it('reports accepted=true for a current-version acceptance', () => {
    const ts = Date.now();
    const s = getTosStatus({ tos_version: CURRENT_TOS_VERSION, accepted_at: ts });
    assert.equal(s.accepted, true);
    assert.equal(s.needs_acceptance, false);
    assert.equal(s.accepted_version, CURRENT_TOS_VERSION);
    assert.equal(s.accepted_at, ts);
  });
});

// ─── 4. recordTosAcceptance — the capture (version-gated, server-stamped) ────────

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const BACKUP_FILE = ACCOUNTS_FILE + '.tos-test-backup';

describe('recordTosAcceptance', () => {
  before(() => {
    if (fs.existsSync(ACCOUNTS_FILE)) fs.copyFileSync(ACCOUNTS_FILE, BACKUP_FILE);
    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({
      acc_tos_test: { email: 'tos@example.com', created_at: Date.now(), api_keys: [] },
      acc_tos_test2: { email: 'tos2@example.com', created_at: Date.now(), api_keys: [] },
    }, null, 2));
  });

  after(() => {
    if (fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, ACCOUNTS_FILE);
      fs.unlinkSync(BACKUP_FILE);
    } else if (fs.existsSync(ACCOUNTS_FILE)) {
      fs.unlinkSync(ACCOUNTS_FILE);
    }
  });

  it('rejects a stale/unknown version with 409 (cannot bind to a non-current version)', () => {
    const r = recordTosAcceptance('acc_tos_test', { version: 'not-the-current-version', ip: '1.2.3.4', ua: 'x' });
    assert.equal(r.success, false);
    assert.equal(r.status_code, 409);
    assert.equal(r.current_tos_version, CURRENT_TOS_VERSION);
  });

  it('rejects an unknown account with 404', () => {
    const r = recordTosAcceptance('acc_does_not_exist', { version: CURRENT_TOS_VERSION });
    assert.equal(r.success, false);
    assert.equal(r.status_code, 404);
  });

  it('records the four artifact fields + append-only log on success, server-stamped', () => {
    const before = Date.now();
    const r = recordTosAcceptance('acc_tos_test', {
      version: CURRENT_TOS_VERSION,
      ip: '203.0.113.9',
      ua: 'Mozilla/5.0 (assent-test)',
    });
    assert.equal(r.success, true);
    assert.equal(r.version, CURRENT_TOS_VERSION);
    assert.ok(r.accepted_at >= before);

    // Persisted to disk
    const acct = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).acc_tos_test;
    assert.equal(acct.tos_version, CURRENT_TOS_VERSION);
    assert.equal(typeof acct.accepted_at, 'number');
    assert.equal(acct.accepted_ip, '203.0.113.9');
    assert.equal(acct.accepted_ua, 'Mozilla/5.0 (assent-test)');
    assert.ok(Array.isArray(acct.tos_acceptance_log));
    assert.equal(acct.tos_acceptance_log.length, 1);
    assert.equal(acct.tos_acceptance_log[0].version, CURRENT_TOS_VERSION);

    // The recorded account now passes the gate decision
    assert.equal(hasAcceptedCurrentTos(acct), true);
  });

  it('truncates an over-long user-agent to a bounded length (first accept on a fresh account)', () => {
    const r = recordTosAcceptance('acc_tos_test2', {
      version: CURRENT_TOS_VERSION,
      ip: '203.0.113.9',
      ua: 'A'.repeat(5000),
    });
    assert.equal(r.success, true);
    const acct = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).acc_tos_test2;
    assert.ok(acct.accepted_ua.length <= 512);
    assert.equal(acct.tos_acceptance_log.length, 1);
  });

  it('is idempotent on the current version — a repeat accept does NOT append or re-stamp (Gate A LOW-2)', () => {
    // acc_tos_test already accepted the current version in the success test above.
    const acctBefore = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).acc_tos_test;
    const firstAcceptedAt = acctBefore.accepted_at;
    const logLenBefore = acctBefore.tos_acceptance_log.length; // 1

    const r = recordTosAcceptance('acc_tos_test', {
      version: CURRENT_TOS_VERSION,
      ip: '9.9.9.9',
      ua: 'a-different-agent',
    });
    assert.equal(r.success, true);
    assert.equal(r.alreadyAccepted, true);            // signals the endpoint to skip the durable-log append
    assert.equal(r.accepted_at, firstAcceptedAt);     // does not re-stamp

    const acctAfter = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')).acc_tos_test;
    assert.equal(acctAfter.tos_acceptance_log.length, logLenBefore); // no duplicate row
    assert.equal(acctAfter.accepted_ip, '203.0.113.9');             // original IP preserved, not overwritten
  });
});

// ─── 5. Server route gates + endpoints (source-level handler verification) ──────
//
// Same approach as security-money-m1-unified-ledger.test.js: assert on the handler
// source so we prove the gate exists and is positioned correctly without booting
// Hono with every production env var. The behavioral logic the gates call
// (hasAcceptedCurrentTos) is unit-tested above.

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

function sliceHandler(marker, span = 3500) {
  const i = SERVER_SRC.indexOf(marker);
  assert.notEqual(i, -1, `handler not found: ${marker}`);
  return SERVER_SRC.slice(i, i + span);
}

describe('server.js: blocking clickwrap gates', () => {
  it('accept-terms + terms-status endpoints exist and accept session OR API key', () => {
    assert.ok(SERVER_SRC.includes("app.post('/account/accept-terms', requireSessionOrApiKey('contribute')"));
    assert.ok(SERVER_SRC.includes("app.get('/account/terms-status', requireSessionOrApiKey('read')"));
  });

  it('the 403 helper is machine-readable (stable code + current version + how-to)', () => {
    const h = sliceHandler('function termsNotAcceptedResponse(c)', 700);
    assert.ok(h.includes("code: 'TERMS_NOT_ACCEPTED'"));
    assert.ok(h.includes('current_tos_version: CURRENT_TOS_VERSION'));
    assert.ok(h.includes('how_to_accept'));
    assert.ok(h.includes('}, 403)'));
  });

  it('link-wallet gates on acceptance BEFORE linking (and before the lock)', () => {
    const h = sliceHandler("app.post('/account/link-wallet'");
    const gateAt = h.indexOf('hasAcceptedCurrentTos');
    const lockAt = h.indexOf('acquireAccountLock');
    const linkAt = h.indexOf('linkWallet(accountId');
    assert.ok(gateAt !== -1, 'link-wallet must check hasAcceptedCurrentTos');
    assert.ok(h.includes('termsNotAcceptedResponse(c)'));
    assert.ok(gateAt < lockAt && gateAt < linkAt, 'gate must precede lock + linkWallet');
  });

  it('stripe withdrawal gates on acceptance', () => {
    const h = sliceHandler("app.post('/withdraw/stripe'");
    assert.ok(h.includes('hasAcceptedCurrentTos(account)'));
    assert.ok(h.includes('termsNotAcceptedResponse(c)'));
  });

  it('custodial USDC withdrawal gates on acceptance (resolves account by wallet, FAILS CLOSED)', () => {
    const h = sliceHandler("app.post('/withdraw'", 4500);
    // Gate A LOW-2 fix: must be the fail-closed form `!hasAcceptedCurrentTos(withdrawAccount)`
    // (an unresolvable/unlinked wallet blocks), NOT `withdrawAccount && !hasAccepted...`
    // which would skip the gate for a wallet-keyed earnings entry with no account.
    assert.ok(h.includes('if (!hasAcceptedCurrentTos(withdrawAccount))'),
      'custodial /withdraw must fail closed on an unresolvable account');
    assert.ok(!/withdrawAccount\s*&&\s*!hasAcceptedCurrentTos/.test(h),
      'must not short-circuit the ToS gate when no account resolves');
    assert.ok(h.includes('termsNotAcceptedResponse(c)'));
  });
});

// ─── 6. MCP acceptance handshake (V-3) ──────────────────────────────────────────

const MCP_SRC = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf-8');

describe('mcp-server.js: acceptance handshake', () => {
  it('exposes auxilo_accept_terms as a tool requiring an explicit agree flag', () => {
    assert.ok(MCP_SRC.includes("name: 'auxilo_accept_terms'"));
    assert.ok(MCP_SRC.includes("required: ['agree']"));
  });
  it('the handler refuses unless agree === true, then binds the current version', () => {
    const i = MCP_SRC.indexOf("case 'auxilo_accept_terms'");
    assert.notEqual(i, -1);
    const h = MCP_SRC.slice(i, i + 1200);
    assert.ok(h.includes('args.agree !== true'));
    assert.ok(h.includes('/account/terms-status'));
    assert.ok(h.includes('/account/accept-terms'));
    assert.ok(h.includes('current_tos_version'));
  });
  it('link-wallet tool description warns acceptance is required', () => {
    assert.ok(MCP_SRC.includes('auxilo_accept_terms') && MCP_SRC.includes('TERMS_NOT_ACCEPTED'));
  });
});
