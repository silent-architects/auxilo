'use strict';

/**
 * test/pricing-live-range.test.js — AD sheet 5 (pricing), item 1 + item 2
 * (2026-09-06 build).
 *
 * Item 1: `/pricing` moves onto the `serveHtmlWithLiveData` path (the same
 * one `/how-it-works`, `/for-builders`, `/for-agents` already use). The
 * Gate-A B1 ruling (2026-09-06) reverted the "Max Price" econ tile back to
 * its static `$50.00` form — the `id="lc-price-range"` observed-range
 * promotion on this tile waits on SITE-PM's label — so this file no longer
 * asserts anything about `lc-price-range` on /pricing. It still asserts the
 * page renders through the live-data route (the route itself was not
 * reverted).
 *
 * Item 2: the Value Tiers table's persuasive `EXAMPLE` column (four
 * fabricated listings) comes out entirely — narrowing the table to three
 * columns (Tier / What It Covers / Price Range) pending a CAT-1-reviewed
 * live refill.
 *
 * Two guards, matching repo convention (test/pricing-visibility.test.js,
 * test/ad-routes.test.js):
 *   1. Structural — server.js source: GET /pricing calls serveHtmlWithLiveData,
 *      and public/pricing.html carries zero EXAMPLE-column markup.
 *   2. Behavioral — boot the real server and assert GET /pricing renders
 *      successfully off the live-data path with no example-text cells /
 *      Example header.
 *
 * Runner: node --test test/pricing-live-range.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
const PRICING_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'pricing.html'), 'utf8');

function routeSlice(marker) {
  const start = SERVER_SRC.indexOf(marker);
  assert.notEqual(start, -1, `route marker not found: ${marker}`);
  const end = SERVER_SRC.indexOf('app.get(', start + marker.length);
  return SERVER_SRC.slice(start, end === -1 ? undefined : end);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Structural
// ─────────────────────────────────────────────────────────────────────────────
describe('structural: /pricing on the live-data path; EXAMPLE column gone from the source', () => {
  it('GET /pricing calls serveHtmlWithLiveData(c, \'pricing.html\'), same as /how-it-works, /for-builders, /for-agents', () => {
    const slice = routeSlice("app.get('/pricing'");
    assert.ok(slice.includes("serveHtmlWithLiveData(c, 'pricing.html')"),
      '/pricing must render through serveHtmlWithLiveData, not serveStatic alone');
    assert.ok(slice.includes("serveStatic(c, 'pricing.html')"),
      '/pricing must still fall back to serveStatic on a failed live render');
  });

  it('public/pricing.html carries the reverted Max Price tile ($50.00, no lc-price-range id, econ-desc present)', () => {
    assert.ok(PRICING_HTML.includes('<p class="econ-value">$50.00</p>'),
      'the Max Price tile must be the static $50.00 value (B1 revert, pending SITE-PM label)');
    assert.ok(!PRICING_HTML.includes('id="lc-price-range"'),
      'lc-price-range must not appear on /pricing — the observed-range promotion waits on SITE-PM\'s label');
  });

  it('the Value Tiers EXAMPLE column is gone: no <th>Example</th>, no example-text cells, tier rows kept byte-identical otherwise', () => {
    const tableStart = PRICING_HTML.indexOf('<table class="value-tiers-table">');
    const tableEnd = PRICING_HTML.indexOf('</table>', tableStart);
    assert.notEqual(tableStart, -1, 'value-tiers-table must exist');
    const table = PRICING_HTML.slice(tableStart, tableEnd);
    assert.ok(!/<th>\s*Example\s*<\/th>/.test(table), 'no Example header');
    assert.ok(!table.includes('example-text'), 'no example-text cells');
    assert.ok(!table.includes('Sheets batchUpdate silently drops ops past 100'), 'fabricated Micro example gone');
    assert.ok(!table.includes('Stripe webhook retry is linear, not exponential'), 'fabricated Standard example gone');
    assert.ok(!table.includes('KV has 128KB limit after base64 encoding, not before'), 'fabricated Premium example gone');
    assert.ok(!table.includes('Optimal Stripe + Workers + D1 payment pipeline'), 'fabricated Expert example gone');
    // Arithmetic/tier text stays byte-identical.
    assert.ok(table.includes('<td class="tier-name">Micro</td>'));
    assert.ok(table.includes('<td class="price-range">$0.05 to $0.10</td>'));
    assert.ok(table.includes('<td class="tier-name">Standard</td>'));
    assert.ok(table.includes('<td class="price-range">$0.10 to $1.00</td>'));
    assert.ok(table.includes('<td class="tier-name">Premium</td>'));
    assert.ok(table.includes('<td class="price-range">$1.00 to $10.00</td>'));
    assert.ok(table.includes('<td class="tier-name">Expert</td>'));
    assert.ok(table.includes('<td class="price-range">$10.00 to $50.00</td>'));
    // Every remaining row now has exactly 3 <td>s.
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].filter(r => r[1].includes('<td'));
    assert.equal(rows.length, 4, 'four tier rows remain');
    for (const row of rows) {
      const tdCount = (row[1].match(/<td/g) || []).length;
      assert.equal(tdCount, 3, `row must have 3 <td> after the EXAMPLE column is removed: ${row[1].slice(0, 40)}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Behavioral: boot the real server against a two-learning fixture
// ─────────────────────────────────────────────────────────────────────────────
function fixtureCatalog() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  const mk = (over) => {
    const l = JSON.parse(JSON.stringify(base));
    delete l.status;
    delete l.pricing;
    delete l.created_at; // calculateFreshnessMultiplier returns 1.0 with no created_at — deterministic
    l.quality = { unlocks: 0, ratings: 0 };
    l.demand = {}; // unlocks_7d absent → 0, deterministic demand multiplier
    return Object.assign(l, over);
  };
  return [
    mk({ id: 'range_low', title: 'the cheap one', category: 'data-processing', status: 'approved', unlock_price: 0.20, contributor_wallet: '0xcccccccccccccccccccccccccccccccccccccc' }),
    mk({ id: 'range_high', title: 'the expensive one', category: 'code-execution', status: 'approved', unlock_price: 5.00, contributor_wallet: '0xcccccccccccccccccccccccccccccccccccccc' }),
  ];
}

describe('behavioral: GET /pricing renders through the live-data path, no EXAMPLE column', () => {
  it('renders 200 off serveHtmlWithLiveData, with zero example-text cells', { timeout: 90_000 }, async (t) => {
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(
        0,
        honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
      );
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (structural guard still enforces the fix)');
      return;
    }
    const reservation = await reservePort();
    if (reservation.skipReason) {
      t.skip(reservation.skipReason);
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-pricing-live-range-'));
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
      const catalog = fixtureCatalog();
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(catalog, null, 2));

      const boot = await bootServer({
        tmpDir,
        port: reservation.port,
        env: {
          NODE_ENV: 'test',
          WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
        },
        timeoutMs: 60_000,
        maxAttempts: 3,
      });
      if (boot.skipReason) {
        t.skip(boot.skipReason);
        return;
      }
      child = boot.child;
      const baseUrl = boot.baseUrl;

      const res = await fetch(`${baseUrl}/pricing`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /^text\/html/);
      const html = await res.text();

      // Item 2: EXAMPLE column absent from the live-rendered page too.
      assert.ok(!html.includes('example-text'), 'no example-text cells in the served HTML');
      assert.ok(!/<th>\s*Example\s*<\/th>/.test(html), 'no Example header in the served HTML');
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
