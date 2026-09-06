'use strict';

/**
 * test/pricing-live-range.test.js — AD sheet 5 (pricing), item 1 + item 2
 * (2026-09-06 build).
 *
 * Item 1: `/pricing` moves onto the `serveHtmlWithLiveData` path (the same
 * one `/how-it-works`, `/for-builders`, `/for-agents` already use), so the
 * old "Max Price" `$50.00` econ tile is replaced by the observed unlock
 * price range, under SITE-PM's gated label `Current unlock price range`
 * (AD build sheet 5 item 1, 2026-09-06). The tile carries the same
 * `id="lc-price-range"` substitution `renderLiveCatalogStats` already
 * performs on /how-it-works, /for-builders, /for-agents. The static fallback
 * baked into public/pricing.html ("$0.05 to $50.00") is the same bound the
 * page ships elsewhere (JSON-LD, the "How Pricing Works" callout) and
 * matches renderLiveCatalogStats' own hardcoded fallback — never a
 * fabricated number.
 *
 * Item 2: the Value Tiers table's persuasive `EXAMPLE` column (four
 * fabricated listings) comes out entirely — narrowing the table to three
 * columns (Tier / What It Covers / Price Range) pending a CAT-1-reviewed
 * live refill. (Landed in an earlier wave; the guards below re-verify it
 * held.)
 *
 * Two guards, matching repo convention (test/pricing-visibility.test.js,
 * test/ad-routes.test.js):
 *   1. Structural — server.js source: GET /pricing calls serveHtmlWithLiveData,
 *      and public/pricing.html carries the lc-price-range element with the
 *      gated label exactly once and zero EXAMPLE-column markup.
 *   2. Behavioral — boot the real server against a fixture catalog with two
 *      distinctly-priced approved learnings and assert GET /pricing renders
 *      the live-computed range (not the static fallback), the label text
 *      once, and no example-text cells / Example header.
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
const pricingEngine = require('../lib/pricing.js');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
const PRICING_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'pricing.html'), 'utf8');
const DEFAULT_UNLOCK_PRICE = 0.08; // server.js's own fallback (mirrored here, not imported)
const OBSERVED_RANGE_LABEL = 'Current unlock price range';

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

  it('public/pricing.html carries id="lc-price-range" under the gated label, with the page\'s own static bound as fallback', () => {
    const m = PRICING_HTML.match(/<p class="econ-value" id="lc-price-range">([^<]*)<\/p>/);
    assert.ok(m, 'the observed-range tile must carry id="lc-price-range" for the SSR regex to fill');
    assert.equal(m[1], '$0.05 to $50.00',
      'the static fallback must be the bound already shipped elsewhere on this page, never a fabricated number');
    assert.ok(!/<p class="econ-value">\$50\.00<\/p>/.test(PRICING_HTML),
      'the old static $50.00 / Max Price tile must be gone — it must not coexist with the live element');
    assert.ok(!PRICING_HTML.includes('Max Price'),
      'the retired "Max Price" label must not remain anywhere on the page');
  });

  it('the gated label "Current unlock price range" appears exactly once, immediately above the lc-price-range tile', () => {
    const occurrences = PRICING_HTML.split(OBSERVED_RANGE_LABEL).length - 1;
    assert.equal(occurrences, 1, 'the label string must appear exactly once on the page');
    const labelIdx = PRICING_HTML.indexOf(OBSERVED_RANGE_LABEL);
    const between = PRICING_HTML.slice(labelIdx, labelIdx + 200);
    assert.ok(between.includes('id="lc-price-range"'),
      'the label must sit directly on the tile that carries the live-filled value');
  });

  it('the "$0.05 to $50.00" fallback matches renderLiveCatalogStats\' own hardcoded default', () => {
    const rlcs = SERVER_SRC.slice(
      SERVER_SRC.indexOf('function renderLiveCatalogStats'),
      SERVER_SRC.indexOf('function serveHtmlWithLiveData')
    );
    assert.ok(rlcs.includes("let range = '$0.05 to $50.00'"),
      'renderLiveCatalogStats default range must still be $0.05 to $50.00 (the value this test pins as the page\'s static fallback)');
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

// Mirrors server.js's displayPrice() exactly (server.js ~11889), so the
// expected range is DERIVED the same way the server derives it, rather than
// hand-computed — the pricing algorithm's demand/freshness multipliers are
// exercised for real, not approximated.
function expectedDisplayPrice(learning, catalog) {
  const p = (learning.pricing && learning.pricing.current_price)
    || pricingEngine.getCurrentPrice(learning, catalog)
    || learning.unlock_price
    || DEFAULT_UNLOCK_PRICE;
  return Math.min(50, Math.max(0.05, Number(p) || DEFAULT_UNLOCK_PRICE));
}

describe('behavioral: GET /pricing renders the live price range, no EXAMPLE column', () => {
  it('renders id="lc-price-range" with the live-computed min/max, the label once, and zero example-text cells', { timeout: 90_000 }, async (t) => {
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

      // Expected range: derived the SAME way displayPrice() derives it,
      // against the exact fixture catalog that was staged.
      const prices = catalog.map((l) => expectedDisplayPrice(l, catalog));
      const expectedRange = `$${Math.min(...prices).toFixed(2)} to $${Math.max(...prices).toFixed(2)}`;

      const m = html.match(/id="lc-price-range"[^>]*>([^<]*)</);
      assert.ok(m, 'lc-price-range element must be present in the rendered HTML');
      assert.equal(m[1], expectedRange,
        `live price range must reflect the fixture catalog (expected ${expectedRange}), not the static fallback`);
      assert.notEqual(m[1], '$0.05 to $50.00',
        'a two-learning fixture at $0.20/$5.00 must not render the untouched static fallback');

      // The gated label rides with the live value, exactly once.
      const labelCount = html.split('Current unlock price range').length - 1;
      assert.equal(labelCount, 1, 'the label text must be present exactly once in the served HTML');

      // Item 2: EXAMPLE column absent from the live-rendered page too.
      assert.ok(!html.includes('example-text'), 'no example-text cells in the served HTML');
      assert.ok(!/<th>\s*Example\s*<\/th>/.test(html), 'no Example header in the served HTML');
    } finally {
      if (child) await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Structural: AD strings packet 5 (SEO, rev 3, 2026-09-06) — /pricing title
// ─────────────────────────────────────────────────────────────────────────────
// Only the /pricing title (title, og:title, twitter:title — "one string per
// page" per the packet) is in scope; /pricing does not appear in the
// packet's descriptions table, so the description/og:description/
// twitter:description strings are untouched, and the Organization JSON-LD
// on this page is explicitly out of scope for this packet (rev 3 note).
describe('AD strings packet 5 (SEO): /pricing title carries the colon-free replacement', () => {
  const OLD_TITLE = 'Dynamic Pricing: $0.05 to $50.00 per Unlock | Auxilo';
  const NEW_TITLE = 'Dynamic pricing for every unlock | Auxilo';

  it('the OLD title string is gone from the page (was in title, og:title, twitter:title)', () => {
    assert.equal(PRICING_HTML.split(OLD_TITLE).length - 1, 0,
      'the OLD packet-5 title string must not remain anywhere on the page');
  });

  it('<title> is the NEW string, with no colon', () => {
    const m = PRICING_HTML.match(/<title>([^<]*)<\/title>/);
    assert.ok(m, '<title> must exist');
    assert.equal(m[1], NEW_TITLE);
    assert.ok(!m[1].includes(':'), 'no <title> may contain a colon (packet 5 post-deploy check)');
  });

  it('og:title and twitter:title both carry the same NEW string', () => {
    const og = PRICING_HTML.match(/<meta property="og:title" content="([^"]*)" \/>/);
    const tw = PRICING_HTML.match(/<meta name="twitter:title" content="([^"]*)" \/>/);
    assert.ok(og, 'og:title must exist');
    assert.ok(tw, 'twitter:title must exist');
    assert.equal(og[1], NEW_TITLE);
    assert.equal(tw[1], NEW_TITLE);
  });

  it('the dollar band "$0.05 to $50.00" is absent from every <title>-family string', () => {
    for (const m of PRICING_HTML.matchAll(/<title>([^<]*)<\/title>|<meta (?:property="og:title"|name="twitter:title") content="([^"]*)" \/>/g)) {
      const text = m[1] || m[2];
      assert.ok(!text.includes('$0.05 to $50.00'), `title-family string must not carry the dollar band: ${text}`);
    }
  });
});
