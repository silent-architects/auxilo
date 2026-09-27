'use strict';

/**
 * test/builders-strip-zeros.test.js — AD sheet 4 item 1 (honest-zeros strip
 * cells), AD strings packet 3 rev 2 §5, superseded by the VISION PASS
 * (SITE-PM, 2026-09-27), REGISTER-V-VISION.md rows V-04/V-05.
 *
 * WHAT THIS FILE USED TO COVER: /for-builders carried a second, honest-zero
 * ledger strip (id="lc-unlocks" / id="lc-paid", server-rendered from
 * catalogStatsTruth, fail-closed to "…" on a ledger-read failure) plus an
 * id="lc-supply-line" sentence ("Supply is ahead of demand."), all inside
 * the same three-cell strip as the id="lc-learnings" / id="lc-asof" count
 * cells.
 *
 * VISION PASS RULING (charter V1, register V-04/V-05): usage numbers leave
 * the sales surfaces. The whole strip — lc-learnings (this copy of the
 * count, not the hero's), lc-asof, lc-unlocks, lc-paid — and the
 * lc-supply-line sentence are CUT from /for-builders, with no replacement.
 * The catalog count stays as the page's lead figure in the hero row
 * (id="lc-learnings-hero", V2 in the charter), untouched by this pass.
 *
 * This file now proves the removal: the static file carries none of the
 * retired ids, server.js's honest-zero fill (still present, unchanged,
 * S-3) no longer has a cell to reach on /for-builders and its ledger read
 * does not run there, and the surviving hero cell keeps rendering the live
 * count. Behavioral, multi-page, non-empty-ledger proof (S-3's specific
 * requirement) lives in test/vision-pass-guard.test.js, which this file
 * does not duplicate.
 *
 * Runner: node --test test/builders-strip-zeros.test.js
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { reservePort, stageServer, bootServer, stopServer } = require('./helpers/staged-server');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
const STATIC_HTML = fs.readFileSync(path.join(REPO_ROOT, 'public', 'for-builders.html'), 'utf8');

function countSupplyLine(html) {
  return (html.match(/Supply is ahead of demand\./g) || []).length;
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
  l.quality = { ...(l.quality || {}), unlocks: 99, ratings: 0, avg_helpfulness: 0 };
  return Object.assign(l, overrides);
}
function fixtureCatalog() {
  return [
    row({ id: 'bsz_a', title: 'row a', category: 'code-execution' }),
    row({ id: 'bsz_b', title: 'row b', category: 'data-processing' }),
  ];
}

// Wave B S2's own spy target: proves catalogStatsTruth (the ledger read) is
// never even invoked for a page whose markup carries no id="lc-unlocks" —
// now true of /for-builders itself, since V-04 removed that cell.
const LEDGER_READ_SPY = {
  name: 'spy on catalogStatsTruth ledger-read gate (S2)',
  search: 'const truth = catalogStatsTruth(visible);',
  replace: "console.error('S2-LEDGER-READ-SPY: catalogStatsTruth invoked'); const truth = catalogStatsTruth(visible);",
};

async function withStagedServer(t, { replacements = [] }, body) {
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-builders-strip-zeros-srv-'));
  let child = null;
  try {
    stageServer({
      repoRoot: REPO_ROOT,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements,
    });
    const dataDir = path.join(tmpDir, 'data');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'unlock-events.jsonl'), '');

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
    const pageRes = await fetch(`${boot.baseUrl}/for-builders`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
    const html = await pageRes.text();
    await body(html, boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('VISION PASS (V-04/V-05): the honest-zero strip is gone from /for-builders — static file', () => {
  it('public/for-builders.html carries none of the retired ids: lc-unlocks, lc-paid, lc-asof, lc-supply-line, and the strip variant of lc-learnings', () => {
    assert.equal((STATIC_HTML.match(/id="lc-unlocks"/g) || []).length, 0, 'id="lc-unlocks" must be gone');
    assert.equal((STATIC_HTML.match(/id="lc-paid"/g) || []).length, 0, 'id="lc-paid" must be gone');
    assert.equal((STATIC_HTML.match(/id="lc-asof"/g) || []).length, 0, 'id="lc-asof" must be gone');
    assert.equal((STATIC_HTML.match(/id="lc-supply-line"/g) || []).length, 0, 'id="lc-supply-line" must be gone');
    // The strip's OWN lc-learnings copy is gone; only the hero's -hero
    // variant survives (negative lookahead excludes it from this count).
    assert.equal((STATIC_HTML.match(/id="lc-learnings"[^-]/g) || []).length, 0, 'the strip copy of id="lc-learnings" must be gone');
    assert.equal(countSupplyLine(STATIC_HTML), 0, '"Supply is ahead of demand." must be gone');
    assert.equal((STATIC_HTML.match(/<!--LC-LEARNINGS-CELL-->/g) || []).length, 0, 'the LC-LEARNINGS-CELL marker pair is gone with the cell it wrapped');
  });

  it('positive control: the hero cell (id="lc-learnings-hero", V2 — the catalog count stays the page\'s lead figure) is still present, gold tier, marker-wrapped', () => {
    assert.equal((STATIC_HTML.match(/id="lc-learnings-hero"/g) || []).length, 1, 'lc-learnings-hero id appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-learnings-hero"><\/span>/, 'hero cell still ships EMPTY for server fill, gold tier');
    assert.match(STATIC_HTML, /<!--LC-LEARNINGS-HERO-CELL-->[\s\S]*?id="lc-learnings-hero">[\s\S]*?<!--\/LC-LEARNINGS-HERO-CELL-->/, 'hero cell still wrapped in its own markers');
  });

  it('no renderer-targeted id attribute for any retired id sits inside an HTML comment', () => {
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-(unlocks|paid|asof|supply-line)"/, 'no retired id text inside an HTML comment');
    }
  });
});

describe('VISION PASS (V-04/V-05): server.js is unchanged — the honest-zero fill still exists (S-3: change server.js only if a fill misbehaves; none does) but has no cell left to reach on /for-builders', () => {
  it('renderLiveCatalogStats still gates the ledger read on html.includes(\'id="lc-unlocks"\'), and /for-builders no longer has that literal', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    assert.match(fn, /if \(html\.includes\('id="lc-unlocks"'\)\)\s*\{/, 'the ledger read still sits behind its existing html.includes(\'id="lc-unlocks"\') gate — unchanged');
    assert.doesNotMatch(fn, /quality\.unlocks/, 'the cell derivation still never reads the retired quality.unlocks counter');
    assert.ok(!STATIC_HTML.includes('id="lc-unlocks"'), 'sanity: /for-builders truly has no id="lc-unlocks" any more, so the gate above now excludes it');
  });

  it('behavioral: with the S2 ledger-read spy installed, requesting /for-builders never fires the ledger read (the gate correctly finds no cell to fill)', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { replacements: [LEDGER_READ_SPY] }, async (html, boot) => {
      assert.ok(!html.includes('id="lc-unlocks"'), 'sanity: served /for-builders has no lc-unlocks cell');
      assert.ok(!html.includes('id="lc-paid"'), 'sanity: served /for-builders has no lc-paid cell');
      assert.equal(countSupplyLine(html), 0, 'sanity: served /for-builders has no supply-line sentence');
      await new Promise((r) => setTimeout(r, 200));
      assert.doesNotMatch(boot.getOutput(), /S2-LEDGER-READ-SPY/, '/for-builders no longer triggers the ledger read — it has no id="lc-unlocks" cell for catalogStatsTruth to feed');
      // Positive control: the hero cell (a DIFFERENT fill, gated on
      // visibleLearningsList succeeding, not on the ledger) still renders.
      assert.match(html, /id="lc-learnings-hero">2</, 'positive control: the surviving hero cell still fills from the live count');
    });
  });

  it('the lc-unlocks/lc-paid substitutions and the sentence removal still sit inside renderLiveCatalogStats\' try, gated on truth.unlocks, and read catalogStatsTruth (never quality.unlocks) — code shape unchanged, this pass made no server.js edit', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    const tryIdx = fn.indexOf('try {');
    const catchIdx = fn.indexOf('} catch (e) {');
    const gateIdx = fn.indexOf('id="lc-unlocks"');
    const truthIdx = fn.indexOf('catalogStatsTruth(');
    const unlocksIdx = fn.indexOf('id="lc-unlocks"', truthIdx);
    const paidIdx = fn.indexOf('id="lc-paid"', truthIdx);
    const supplyIdx = fn.indexOf('lc-supply-line', truthIdx);
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(gateIdx > tryIdx && gateIdx < truthIdx, 'the id="lc-unlocks" gate check precedes the ledger read, inside the try');
    assert.ok(truthIdx > tryIdx && truthIdx < catchIdx, 'catalogStatsTruth is called inside the try');
    assert.ok(unlocksIdx > truthIdx && unlocksIdx < catchIdx, 'the lc-unlocks substitution follows the truth derivation, inside the try');
    assert.ok(paidIdx > truthIdx && paidIdx < catchIdx, 'the lc-paid substitution follows the truth derivation, inside the try');
    assert.ok(supplyIdx > truthIdx && supplyIdx < catchIdx, 'the supply-line removal follows the truth derivation, inside the try');
    assert.match(fn, /if \(truth\.unlocks\)\s*\{/, 'the three substitutions are gated on the ledger being readable (truth.unlocks non-null)');
    assert.doesNotMatch(fn, /quality\.unlocks/, 'the cell derivation never reads the retired quality.unlocks counter');
  });

  it('catalogStatsTruth (the ledger read) is called at most once per render, and never when the page has no lc-unlocks cell — code shape unchanged', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    assert.equal((fn.match(/catalogStatsTruth\(/g) || []).length, 1, 'catalogStatsTruth is called from exactly one call site in this function');
    assert.match(fn, /if \(html\.includes\('id="lc-unlocks"'\)\)\s*\{/, 'the ledger read sits behind an explicit html.includes(\'id="lc-unlocks"\') gate');
  });
});

describe('VISION PASS (V-29/P-3): the surviving hero row — new caption text, no $0.05 cell, and the new setup line above the buttons', () => {
  it('the 70% caption reads the credits-as-cash text ("of the price (60% via search)"), the old "direct share (60% via discovery)" is gone, "under 1 minute" is untouched', () => {
    assert.doesNotMatch(STATIC_HTML, /direct share \(60% via discovery\)/, 'the old caption must be gone');
    assert.match(
      STATIC_HTML,
      /<span class="stat-num pull-stat-caption">70%<\/span>\s*<span class="stat-label pull-stat-caption">of the price \(60% via search\)<\/span>/,
      'C-05: the 70% cell\'s caption is the new text, verbatim'
    );
    assert.match(
      STATIC_HTML,
      /<span class="stat-num pull-stat-caption">under 1 minute<\/span>\s*<span class="stat-label pull-stat-caption">time to connect<\/span>/,
      'the "under 1 minute" cell is untouched by this pass'
    );
    const heroStart = STATIC_HTML.indexOf('<section id="builders-hero"');
    const heroEnd = STATIC_HTML.indexOf('</section>', heroStart);
    const heroSection = STATIC_HTML.slice(heroStart, heroEnd);
    assert.equal((heroSection.match(/class="builders-hero-stat"/g) || []).length, 3, 'still exactly three stat cells in the hero row');
    assert.doesNotMatch(heroSection, /\$0\.05/, 'the $0.05 hero figure is still gone (untouched by this pass)');
  });

  it('P-3: "Run npx auxilo setup in any terminal. Setup is free." sits directly above .hero-ctas, with the command rendered as code', () => {
    const heroStart = STATIC_HTML.indexOf('<section id="builders-hero"');
    const heroEnd = STATIC_HTML.indexOf('</section>', heroStart);
    const heroSection = STATIC_HTML.slice(heroStart, heroEnd);
    const statsEndIdx = heroSection.indexOf('</div>', heroSection.indexOf('class="builders-hero-stats"')) + '</div>'.length;
    const ctasIdx = heroSection.indexOf('<div class="hero-ctas">');
    assert.ok(statsEndIdx > 0 && ctasIdx > statsEndIdx, 'stat row and CTA row located, in order');
    const between = heroSection.slice(statsEndIdx, ctasIdx);
    assert.match(between, /Run\s*<code[^>]*>npx auxilo setup<\/code>\s*in any terminal\. Setup is free\./, 'P-3 text sits between the stat row and the CTA row, command as code');
  });
});
