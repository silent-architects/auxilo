'use strict';

/**
 * test/stats-truth.test.js — STATS-TRUTH: GET /knowledge/stats fails closed.
 *
 *   contributorIdentity / total_contributors
 *     (b) wallet-cased duplicates → one identity
 *     (c) account-only + wallet-only + account+wallet + null/null → correct
 *         distinct count (null/null = the single platform identity)
 *   total_earnings_usd
 *     (a) an earnings entry owning no visible learning → excluded
 *         (the four prod fixture entries that summed to the served 4.5)
 *   total_unlocks / top_learnings[].unlocks
 *     (d) ledger-derived counts vs stale quality.unlocks → ledger wins
 *     (e) unreadable ledger → fields omitted, no throw
 *   staged server: seeded fixture store → the four numbers on the wire, and a
 *   second boot with the ledger unreadable → the unlock fields are absent.
 *
 * Runner: node --test test/stats-truth.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const st = require('../lib/stats-truth.js');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

// Valid-shape wallets in deliberately different casings.
const W_ALPHA_MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const W_BETA_UPPER = '0xDEF0DEF0DEF0DEF0DEF0DEF0DEF0DEF0DEF0DEF0';
const W_BETA_LOWER = W_BETA_UPPER.toLowerCase();
const W_BARE_FIXTURE = '0x41da1bbd20ab41da1bbd20ab41da1bbd20ab41da';
const ACC_ALPHA = 'acc_st_alpha';
const ACC_GHOST = 'acc_st_ghost'; // owns only a PRIVATE learning

function scratchDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Clone a real seed record so every field migrations/scoring expect exists. */
function seedBase() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  return base;
}

function row(overrides) {
  const l = JSON.parse(JSON.stringify(seedBase()));
  l.status = 'approved';
  delete l.visibility;
  l.contributor_account_id = null;
  l.contributor_wallet = null;
  l.quality = { ...(l.quality || {}), unlocks: 0, ratings: 0, avg_helpfulness: 0 };
  return Object.assign(l, overrides);
}

/** The fixture catalog every layer of this file shares. */
function fixtureCatalog() {
  return [
    row({ id: 'st_acc_only', title: 'account-only row', contributor_account_id: ACC_ALPHA,
      quality: { unlocks: 6, ratings: 0, avg_helpfulness: 0, score: 0 } }),
    row({ id: 'st_acc_wallet', title: 'account+wallet row', contributor_account_id: ACC_ALPHA,
      contributor_wallet: W_ALPHA_MIXED,
      quality: { unlocks: 3, ratings: 0, avg_helpfulness: 0, score: 0 } }),
    row({ id: 'st_wallet_up', title: 'wallet-only row (upper)', contributor_wallet: W_BETA_UPPER }),
    row({ id: 'st_wallet_low', title: 'wallet-only row (lower)', contributor_wallet: W_BETA_LOWER }),
    row({ id: 'st_null_null', title: 'null/null platform row' }),
    row({ id: 'st_private', title: 'private row', visibility: 'private', contributor_account_id: ACC_GHOST,
      quality: { unlocks: 50, ratings: 0, avg_helpfulness: 0, score: 0 } }),
  ];
}

function visibleOf(catalog) {
  return catalog.filter((l) => l.visibility !== 'private' && (!l.status || l.status === 'approved'));
}

// Visible identities: ACC_ALPHA, W_BETA (lowercased), acc_platform → 3.
const EXPECTED_CONTRIBUTORS = 3;

function fixtureEarnings() {
  return {
    __wallet_index: { [W_ALPHA_MIXED.toLowerCase()]: ACC_ALPHA },
    [ACC_ALPHA]: { account_id: ACC_ALPHA, wallet: W_ALPHA_MIXED.toLowerCase(), total_gross: 1.25, pending_balance: 0.875 },
    [W_BETA_UPPER]: { wallet: W_BETA_UPPER, total_gross: 0.755, pending_balance: 0.5 }, // key cased differently from the lowercased visible wallet
    acc_fixture_nobody: { account_id: 'acc_fixture_nobody', total_gross: 2, pending_balance: 1.4 },
    [W_BARE_FIXTURE]: { wallet: W_BARE_FIXTURE, total_gross: 0.5, pending_balance: 0.35 },
    [ACC_GHOST]: { account_id: ACC_GHOST, total_gross: 9, pending_balance: 6.3 },
  };
}
// Only ACC_ALPHA ($1.25) and the W_BETA wallet key ($0.755) own visible rows.
// The 3-dp fixture value exercises the 2-dp rounding; the expectation is the
// same arithmetic the helper performs (sum, then toFixed(2)).
const EXPECTED_EARNINGS = Number((1.25 + 0.755).toFixed(2));

function fixtureLedgerLines() {
  const ev = (id, learning_id) => JSON.stringify({
    id, ts: '2026-09-05T00:00:00.000Z', learning_id, amount_paid_usd: 0.05,
    funding_source: 'credit_pack', contributor_account_id: null, contributor_wallet: null, settled_onchain: false,
  });
  return [
    ev('wal_evt_1', 'st_acc_only'),
    ev('wal_evt_2', 'st_acc_only'),
    ev('wal_evt_3', 'st_acc_wallet'),
    ev('wal_evt_1', 'st_acc_only'),          // replay duplicate — same WAL id, counted once
    ev('wal_evt_4', 'st_private'),           // invisible learning — excluded
    ev('wal_evt_5', 'learn_missing'),        // no such learning — excluded
    '{"this is": not json',                  // malformed line — skipped, never throws
    JSON.stringify({ id: 'wal_evt_6', ts: 'x' }), // no learning_id — skipped
    ev('wal_evt_7', 'st_null_null'),
  ].join('\n') + '\n';
}
const EXPECTED_UNLOCKS_BY_ID = { st_acc_only: 2, st_acc_wallet: 1, st_wallet_up: 0, st_wallet_low: 0, st_null_null: 1 };
const EXPECTED_TOTAL_UNLOCKS = 4;
const STALE_COUNTER_SUM = 9; // 6 + 3 on the visible rows — what the old handler served

describe('STATS-TRUTH: contributorIdentity (the shared CONTRIB-STAT / PARTITION-GUARD helper)', () => {
  it('account id wins over wallet and is trimmed; wallet is lowercased when there is no account', () => {
    assert.equal(st.contributorIdentity({ contributor_account_id: ' acc_x ', contributor_wallet: W_ALPHA_MIXED }), 'acc_x');
    assert.equal(st.contributorIdentity({ contributor_account_id: null, contributor_wallet: W_BETA_UPPER }), W_BETA_LOWER);
    assert.equal(st.contributorIdentity({ contributor_account_id: '', contributor_wallet: W_BETA_UPPER }), W_BETA_LOWER,
      'an empty-string account id is "absent"');
  });

  it('a null-account / null-wallet row is the single platform identity — the same identity as an explicit acc_platform row', () => {
    assert.equal(st.contributorIdentity({ contributor_account_id: null, contributor_wallet: null }), st.PLATFORM_IDENTITY);
    assert.equal(st.contributorIdentity({}), st.PLATFORM_IDENTITY);
    assert.equal(st.contributorIdentity(null), st.PLATFORM_IDENTITY);
    assert.equal(st.contributorIdentity({ contributor_account_id: 'acc_platform' }), st.PLATFORM_IDENTITY);
    assert.equal(st.countDistinctContributors([
      { contributor_account_id: null, contributor_wallet: null },
      { contributor_account_id: 'acc_platform', contributor_wallet: null },
    ]), 1);
  });

  it('(b) wallet-cased duplicates count as ONE identity (the :8110 case-sensitive Set class)', () => {
    const rows = [
      { contributor_wallet: W_BETA_UPPER },
      { contributor_wallet: W_BETA_LOWER },
      { contributor_wallet: W_BETA_UPPER.slice(0, 6).toLowerCase() + W_BETA_UPPER.slice(6) },
    ];
    assert.equal(st.countDistinctContributors(rows), 1);
    assert.equal(new Set(rows.map((r) => r.contributor_wallet)).size, 3, 'the old Set double-counted');
  });

  it('(c) account-only + wallet-only + account+wallet + null/null rows → the correct distinct count; account-holding wallet-less rows are COUNTED', () => {
    assert.equal(st.countDistinctContributors(visibleOf(fixtureCatalog())), EXPECTED_CONTRIBUTORS);
    // The second CONTRIB-STAT defect: an outside contributor with an account
    // and no wallet moved the old wallet-keyed count by exactly zero.
    const before = st.countDistinctContributors([{ contributor_wallet: W_BETA_LOWER }]);
    const after = st.countDistinctContributors([{ contributor_wallet: W_BETA_LOWER }, { contributor_account_id: 'acc_outsider' }]);
    assert.equal(after, before + 1);
  });
});

describe('STATS-TRUTH: total_earnings_usd from attributable ledger entries', () => {
  it('(a) an earnings entry owning no visible learning contributes nothing — the prod fixture set (4.5 served) sums to 0', () => {
    // The 2026-09-05 prod shape: four fixture entries, none owning a visible row.
    const prodFixtures = {
      acc_aaa11111: { account_id: 'acc_aaa11111', total_gross: 1 },
      acc_bbb22222: { account_id: 'acc_bbb22222', total_gross: 2 },
      [W_BARE_FIXTURE]: { total_gross: 0.5 },
      acc_767650d6: { account_id: 'acc_767650d6', total_gross: 1 },
    };
    const visible = [
      { id: 'a', contributor_account_id: 'acc_647b846b', contributor_wallet: null },
      { id: 'b', contributor_account_id: 'acc_platform', contributor_wallet: '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6' },
    ];
    const naive = Object.values(prodFixtures).reduce((s, e) => s + e.total_gross, 0);
    assert.equal(naive, 4.5, 'the old derivation served the fixture sum');
    assert.equal(st.attributableEarningsUsd(prodFixtures, visible), 0);
  });

  it('account-id keys and case-insensitive wallet keys match visible rows; __ keys and unattributable entries are ignored; 2 dp', () => {
    const total = st.attributableEarningsUsd(fixtureEarnings(), visibleOf(fixtureCatalog()));
    assert.equal(total, EXPECTED_EARNINGS);
    assert.equal(total, Number(total.toFixed(2)), 'rounded to 2 dp');
    // The private-only account's $9 and the two fixture entries never leak in.
    assert.ok(total < 9);
    // Garbage entries never throw or count.
    assert.equal(st.attributableEarningsUsd({ [ACC_ALPHA]: null, __x: { total_gross: 100 } }, [{ contributor_account_id: ACC_ALPHA }]), 0);
    assert.equal(st.attributableEarningsUsd({ [ACC_ALPHA]: { total_gross: 'NaN?' } }, [{ contributor_account_id: ACC_ALPHA }]), 0);
  });
});

describe('STATS-TRUTH: unlock counts from the per-unlock ledger', () => {
  it('(d) ledger-derived counts win over a stale quality.unlocks; dedupe on WAL id; invisible/unknown ids and malformed rows excluded', () => {
    const dir = scratchDir('auxilo-stats-truth-ledger-');
    const file = path.join(dir, 'unlock-events.jsonl');
    fs.writeFileSync(file, fixtureLedgerLines());
    const visible = visibleOf(fixtureCatalog());
    const truth = st.computeStatsTruth({ visibleRows: visible, earnings: fixtureEarnings(), unlockEventsFile: file });
    assert.equal(truth.ledger_readable, true);
    assert.ok(truth.unlocks, 'unlocks present when the ledger is readable');
    assert.equal(truth.unlocks.total, EXPECTED_TOTAL_UNLOCKS);
    for (const [id, n] of Object.entries(EXPECTED_UNLOCKS_BY_ID)) {
      assert.equal(truth.unlocks.byId.get(id) || 0, n, `ledger unlocks for ${id}`);
    }
    assert.equal(visible.reduce((s, l) => s + (l.quality.unlocks || 0), 0), STALE_COUNTER_SUM, 'the stale counter disagrees');
    assert.notEqual(truth.unlocks.total, STALE_COUNTER_SUM);
    // The store is untouched.
    assert.equal(visible.find((l) => l.id === 'st_acc_only').quality.unlocks, 6);
    const ledger = st.readUnlockLedger(file);
    assert.equal(ledger.malformed, 2, 'the non-JSON line and the id-less row are counted, not thrown');
    assert.equal(ledger.events.length, 6, '7 well-formed rows minus the WAL-id duplicate');
    // The other truths ride along in the same call.
    assert.equal(truth.total_contributors, EXPECTED_CONTRIBUTORS);
    assert.equal(truth.total_earnings_usd, EXPECTED_EARNINGS);
  });

  it('(e) an unreadable ledger (a directory at the path) → readable:false, unlocks:null, no throw; contributors and money still derive', () => {
    const dir = scratchDir('auxilo-stats-truth-unreadable-');
    const file = path.join(dir, 'unlock-events.jsonl');
    fs.mkdirSync(file); // EISDIR on read — readable-but-broken, not ENOENT
    let truth;
    assert.doesNotThrow(() => {
      truth = st.computeStatsTruth({ visibleRows: visibleOf(fixtureCatalog()), earnings: fixtureEarnings(), unlockEventsFile: file });
    });
    assert.equal(truth.ledger_readable, false);
    assert.equal(truth.unlocks, null);
    assert.equal(typeof truth.ledger_error, 'string');
    assert.equal(truth.total_contributors, EXPECTED_CONTRIBUTORS);
    assert.equal(truth.total_earnings_usd, EXPECTED_EARNINGS);
    assert.equal(st.ledgerUnlockCounts(st.readUnlockLedger(file), new Set(['st_acc_only'])), null);
  });

  it('an ABSENT ledger file is an empty ledger (the writer creates it on first append): readable, zero unlocks', () => {
    const dir = scratchDir('auxilo-stats-truth-absent-');
    const ledger = st.readUnlockLedger(path.join(dir, 'unlock-events.jsonl'));
    assert.deepEqual({ readable: ledger.readable, absent: ledger.absent, events: ledger.events }, { readable: true, absent: true, events: [] });
    const counts = st.ledgerUnlockCounts(ledger, new Set(['st_acc_only']));
    assert.deepEqual({ total: counts.total, size: counts.byId.size }, { total: 0, size: 0 });
  });
});

describe('STATS-TRUTH: source pins', () => {
  const start = SERVER_SRC.indexOf("app.get('/knowledge/stats'");
  const end = SERVER_SRC.indexOf("app.get('/knowledge/:id'", start);
  const stats = SERVER_SRC.slice(start, end);

  it('the /knowledge/stats handler derives through computeStatsTruth over visibleCatalog() + UNLOCK_EVENTS_FILE and reads no counter or raw ledger sum itself', () => {
    assert.ok(start > 0 && end > start, 'handler located');
    assert.ok(stats.includes('computeStatsTruth({'), 'delegates to lib/stats-truth.js');
    assert.ok(stats.includes('visibleRows: visibleLearnings') && stats.includes('const visibleLearnings = visibleCatalog();'));
    assert.ok(stats.includes('unlockEventsFile: UNLOCK_EVENTS_FILE'), 'the unlock ledger is the server\'s own per-unlock event file');
    assert.ok(!stats.includes('w.total_gross') && !stats.includes('Object.entries(earnings)'), 'no whole-ledger money sum');
    assert.ok(!stats.includes('new Set(visibleLearnings.map(l => l.contributor_wallet)'), 'no wallet-keyed contributor Set');
    assert.ok(!stats.includes('l.quality.unlocks') && !stats.includes('unlocks_total'), 'no stored unlock counter on the wire');
    assert.ok(/\.\.\.\(ledgerUnlocks \? \{ total_unlocks: ledgerUnlocks\.total \} : \{\}\)/.test(stats), 'total_unlocks is conditional on a readable ledger');
    assert.ok(/\.\.\.\(ledgerUnlocks \? \{ unlocks: ledgerUnlocks\.byId\.get\(l\.id\) \|\| 0 \} : \{\}\)/.test(stats), 'per-item unlocks are conditional too');
    assert.ok(SERVER_SRC.includes("require('./lib/stats-truth.js')"));
  });

  it('openapi.json states the derivation of the four /knowledge/stats fields', () => {
    const api = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'openapi.json'), 'utf8'));
    const props = api.paths['/knowledge/stats'].get.responses['200'].content['application/json'].schema.properties;
    assert.match(props.total_unlocks.description, /unlock-events\.jsonl/);
    assert.match(props.total_unlocks.description, /OMITTED when the ledger is unreadable/);
    assert.match(props.total_earnings_usd.description, /identity present in the visible catalog/);
    assert.match(props.total_contributors.description, /distinct contributor identities/);
    assert.match(props.top_learnings.items.properties.unlocks.description, /OMITTED when the ledger is unreadable/);
  });
});

// ─── Staged server ────────────────────────────────────────────────────────────

async function withStagedServer(t, { ledgerUnreadable = false }, body) {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
    nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
  } catch {
    t.skip('hono not resolvable from repo root — skipping real boot');
    return;
  }
  const reservation = await reservePort();
  if (reservation.skipReason) { t.skip(reservation.skipReason); return; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-stats-truth-srv-'));
  let child = null;
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
    const dataDir = path.join(tmpDir, 'data');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify(fixtureEarnings(), null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    const ledgerPath = path.join(dataDir, 'unlock-events.jsonl');
    if (ledgerUnreadable) fs.mkdirSync(ledgerPath);
    else fs.writeFileSync(ledgerPath, fixtureLedgerLines());

    const boot = await bootServer({
      tmpDir,
      port: reservation.port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        LLM_SENSITIVITY_ENABLED: 'false',
        AUXILO_DATA_DIR: dataDir,
        AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if (boot.skipReason) { t.skip(boot.skipReason); return; }
    child = boot.child;
    const res = await fetch(`${boot.baseUrl}/knowledge/stats`);
    assert.equal(res.status, 200);
    await body(await res.json(), boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('STATS-TRUTH: GET /knowledge/stats on a staged server', () => {
  it('seeded fixture store → contributors as identities, money from attributable entries, unlocks from the ledger (per item too)', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, {}, async (s) => {
      assert.equal(s.learnings_count, 5, 'the private row is invisible');
      assert.equal(s.total_contributors, EXPECTED_CONTRIBUTORS);
      assert.equal(s.total_earnings_usd, EXPECTED_EARNINGS);
      assert.equal(s.total_unlocks, EXPECTED_TOTAL_UNLOCKS);
      assert.notEqual(s.total_unlocks, STALE_COUNTER_SUM);
      assert.equal(s.top_learnings.length, 5);
      for (const item of s.top_learnings) {
        assert.equal(item.unlocks, EXPECTED_UNLOCKS_BY_ID[item.id], `top_learnings unlocks for ${item.id}`);
        assert.equal(typeof item.score, 'number');
      }
      assert.equal(typeof s.total_ratings, 'number');
      assert.equal(typeof s.timestamp, 'string');
    });
  });

  it('unreadable ledger → total_unlocks and top_learnings[].unlocks are OMITTED (never a counter); the other numbers still serve', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { ledgerUnreadable: true }, async (s, boot) => {
      assert.equal(Object.hasOwn(s, 'total_unlocks'), false, 'total_unlocks omitted');
      assert.equal(s.top_learnings.length, 5);
      for (const item of s.top_learnings) assert.equal(Object.hasOwn(item, 'unlocks'), false, `no per-item unlocks for ${item.id}`);
      assert.equal(s.total_contributors, EXPECTED_CONTRIBUTORS);
      assert.equal(s.total_earnings_usd, EXPECTED_EARNINGS);
      assert.equal(s.learnings_count, 5);
      // Logged once, on the seat.
      await new Promise((r) => setTimeout(r, 200));
      assert.match(boot.getOutput(), /\[STATS-TRUTH\] unlock ledger unreadable/);
    });
  });
});
