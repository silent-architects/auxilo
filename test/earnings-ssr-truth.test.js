'use strict';

/**
 * test/earnings-ssr-truth.test.js — the /earnings server-render takes its
 * unlock count from the SAME derivation as GET /knowledge/stats (no-fork
 * rule: one public number, one derivation).
 *
 *   Before this fix the /earnings SSR summed the retired per-learning
 *   quality.unlocks counter (prod served `6`) while /knowledge/stats served
 *   the ledger-derived `0` (STATS-TRUTH). Both now call server.js
 *   catalogStatsTruth(visibleCatalog()).
 *
 *   staged server, seeded catalog whose quality.unlocks totals 6:
 *     (1) ledger with 0 rows       → /earnings renders ll-unlocks">0<  and
 *                                    /knowledge/stats total_unlocks === 0
 *     (2) ledger with 2 visible rows → both 2
 *     (3) unreadable ledger        → /earnings cell keeps the static "…" and
 *                                    /knowledge/stats omits total_unlocks
 *   ll-learnings and ll-categories stay catalog-derived (checked in (1)).
 *   source pins: both routes call the one helper; /earnings reads no counter.
 *
 * Runner: node --test test/earnings-ssr-truth.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');

const W_ALPHA = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const ACC_ALPHA = 'acc_es_alpha';

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

// Visible quality.unlocks: 4 + 2 = 6 — what the old /earnings SSR served.
// The private row's 50 is invisible to both surfaces either way.
function fixtureCatalog() {
  return [
    row({ id: 'es_a', title: 'row a', category: 'code-execution', contributor_account_id: ACC_ALPHA,
      quality: { unlocks: 4, ratings: 0, avg_helpfulness: 0, score: 0 } }),
    row({ id: 'es_b', title: 'row b', category: 'code-execution', contributor_wallet: W_ALPHA,
      quality: { unlocks: 2, ratings: 0, avg_helpfulness: 0, score: 0 } }),
    row({ id: 'es_c', title: 'row c', category: 'data-processing' }),
    row({ id: 'es_private', title: 'private row', visibility: 'private',
      quality: { unlocks: 50, ratings: 0, avg_helpfulness: 0, score: 0 } }),
  ];
}
const STALE_COUNTER_SUM = 6;
const EXPECTED_VISIBLE = 3;
const EXPECTED_CATEGORIES = 2;

function ledgerLine(id, learning_id) {
  return JSON.stringify({
    id, ts: '2026-09-05T00:00:00.000Z', learning_id, amount_paid_usd: 0.05,
    funding_source: 'credit_pack', contributor_account_id: null, contributor_wallet: null, settled_onchain: false,
  });
}
const TWO_ROW_LEDGER = [ledgerLine('wal_es_1', 'es_a'), ledgerLine('wal_es_2', 'es_b')].join('\n') + '\n';

function unlockCell(html) {
  const m = html.match(/id="ll-unlocks"[^>]*>([^<]*)</);
  assert.ok(m, 'll-unlocks cell present in the rendered /earnings HTML');
  return m[1];
}
function cell(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  assert.ok(m, `${id} cell present`);
  return m[1];
}

// ─── Staged server ────────────────────────────────────────────────────────────

async function withStagedServer(t, { ledger }, body) {
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-earnings-ssr-truth-srv-'));
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
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    const ledgerPath = path.join(dataDir, 'unlock-events.jsonl');
    if (ledger === 'unreadable') fs.mkdirSync(ledgerPath); // EISDIR on read — not ENOENT
    else fs.writeFileSync(ledgerPath, ledger);

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
    const pageRes = await fetch(`${boot.baseUrl}/earnings`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
    const html = await pageRes.text();
    const statsRes = await fetch(`${boot.baseUrl}/knowledge/stats`);
    assert.equal(statsRes.status, 200);
    await body(html, await statsRes.json(), boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('EARNINGS-SSR-TRUTH: GET /earnings unlock cell and GET /knowledge/stats total_unlocks are one number', () => {
  it('(1) stale quality.unlocks totals 6, ledger has 0 rows → /earnings renders ll-unlocks">0< and stats serves 0; learnings/categories stay catalog-derived', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { ledger: '' }, async (html, s) => {
      assert.equal(fixtureCatalog().filter((l) => l.visibility !== 'private').reduce((n, l) => n + l.quality.unlocks, 0), STALE_COUNTER_SUM);
      assert.ok(html.includes('id="ll-unlocks">0<'), `the exact cell the ruling names: ${unlockCell(html)}`);
      assert.equal(s.total_unlocks, 0);
      assert.equal(unlockCell(html), String(s.total_unlocks), 'the two surfaces agree');
      assert.notEqual(unlockCell(html), String(STALE_COUNTER_SUM), 'the retired counter is not on the page');
      assert.equal(cell(html, 'll-learnings'), String(EXPECTED_VISIBLE));
      assert.equal(s.learnings_count, EXPECTED_VISIBLE);
      assert.equal(cell(html, 'll-categories'), String(EXPECTED_CATEGORIES));
      assert.equal(s.categories.length, EXPECTED_CATEGORIES);
    });
  });

  it('(2) ledger has 2 rows for visible ids → /earnings renders 2 and stats serves 2', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { ledger: TWO_ROW_LEDGER }, async (html, s) => {
      assert.ok(html.includes('id="ll-unlocks">2<'), `rendered cell: ${unlockCell(html)}`);
      assert.equal(s.total_unlocks, 2);
      assert.equal(unlockCell(html), String(s.total_unlocks), 'the two surfaces agree');
    });
  });

  it('(3) unreadable ledger → /earnings keeps the static "…" (no digit) and stats OMITS total_unlocks; the other cells still render', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { ledger: 'unreadable' }, async (html, s, boot) => {
      assert.equal(unlockCell(html), '…', 'the static placeholder survives — never a digit from a counter');
      assert.equal(Object.hasOwn(s, 'total_unlocks'), false, 'total_unlocks omitted');
      assert.equal(cell(html, 'll-learnings'), String(EXPECTED_VISIBLE));
      assert.equal(cell(html, 'll-categories'), String(EXPECTED_CATEGORIES));
      await new Promise((r) => setTimeout(r, 200));
      assert.match(boot.getOutput(), /\[STATS-TRUTH\] unlock ledger unreadable/);
    });
  });
});

describe('EARNINGS-SSR-TRUTH: source pins — one derivation, called from both routes', () => {
  it('server.js defines catalogStatsTruth once; /knowledge/stats and /earnings both call it; /earnings reads no quality.unlocks counter', () => {
    const helperDefs = SERVER_SRC.match(/^function catalogStatsTruth\(visibleLearnings\) \{/gm) || [];
    assert.equal(helperDefs.length, 1, 'exactly one shared helper');

    const statsStart = SERVER_SRC.indexOf("app.get('/knowledge/stats'");
    const statsEnd = SERVER_SRC.indexOf("app.get('/knowledge/:id'", statsStart);
    assert.ok(statsStart > 0 && statsEnd > statsStart, 'stats handler located');
    const stats = SERVER_SRC.slice(statsStart, statsEnd);
    assert.ok(stats.includes('const truth = catalogStatsTruth(visibleLearnings);'), '/knowledge/stats calls the shared helper');

    const earnStart = SERVER_SRC.indexOf("app.get('/earnings'");
    const earnEnd = SERVER_SRC.indexOf('app.get(', earnStart + 1);
    assert.ok(earnStart > 0 && earnEnd > earnStart, '/earnings handler located');
    const earn = SERVER_SRC.slice(earnStart, earnEnd);
    assert.ok(earn.includes('const visibleLearnings = visibleCatalog();'), 'same visible-catalog input');
    assert.ok(earn.includes('const truth = catalogStatsTruth(visibleLearnings);'), '/earnings calls the shared helper');
    assert.ok(!earn.includes('quality?.unlocks') && !earn.includes('quality.unlocks'), 'no per-learning counter in the SSR');
    assert.ok(!earn.includes('computeStatsTruth('), 'no duplicated read logic — the helper is the only caller of computeStatsTruth');
    assert.ok(/truth\.unlocks \? truth\.unlocks\.total\.toLocaleString\('en-US'\) : null/.test(earn), 'unreadable ⇒ null ⇒ the "…" cell is left alone');
    assert.ok(/if \(llUnlocks !== null\) \{\s*html = html\.replace\(\/\(id="ll-unlocks"/.test(earn), 'the unlock cell is replaced only when the ledger is readable');
    assert.equal((SERVER_SRC.match(/computeStatsTruth\(\{/g) || []).length, 1, 'computeStatsTruth is invoked from exactly one site in server.js');
  });
});
