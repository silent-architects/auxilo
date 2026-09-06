'use strict';

/**
 * test/builders-strip-zeros.test.js — AD sheet 4 item 1 (honest-zeros strip
 * cells), AD strings packet 3 rev 2 §5: the /for-builders ledger strip gets
 * two more server-rendered cells, fail-closed from the SAME ledger truth the
 * strip's count and as-of cells already use (catalogStatsTruth — shared with
 * GET /knowledge/stats and the /earnings SSR, never the retired
 * quality.unlocks counter):
 *
 *   id="lc-unlocks"  ← truth.unlocks.total            (integer)
 *   id="lc-paid"     ← truth.total_earnings_usd        ($ to cents, gross)
 *
 *   staged server, seeded catalog with an EMPTY unlock-event ledger (0 rows)
 *   and an empty earnings map:
 *     (1) healthy renderer → served page shows "0" in lc-unlocks and "$0.00"
 *         in lc-paid, and "Supply is ahead of demand." does NOT appear
 *     (2) renderer's catch forced (visibleLearningsList throws) → both cells
 *         render EMPTY, "Supply is ahead of demand." is still on the page,
 *         the failure is logged
 *   static file: `<span ... id="lc-unlocks"></span>` and
 *     `<span ... id="lc-paid"></span>` present once each, EMPTY, no digits
 *     or "$" anywhere in those spans; "Supply is ahead of demand." present
 *     exactly once (the fail-path baseline).
 *   source pins: both substitutions and the sentence removal live INSIDE
 *     renderLiveCatalogStats' try, gated on truth.unlocks (not on the count
 *     or as-of derivations, which can succeed independently), so a ledger
 *     read failure cannot leave a static digit behind.
 *
 * Also covers the SITE-PM hero-stat-row ruling: the /for-builders hero row's
 * id="lc-learnings-hero" cell is filled by the SAME `count` derivation as the
 * strip's id="lc-learnings" (one live number leads the hero, in gold), the
 * former 70%/$0.05/<1 min trio drops to two constants at caption tier
 * (70% and "under 1 minute"), and the $0.05 / "minimum unlock price" cell is
 * gone entirely.
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

const SUPPLY_SENTENCE = 'Supply is ahead of demand.';

function cellText(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  assert.ok(m, `id="${id}" present in the HTML`);
  return m[1];
}
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
  // quality.unlocks seeded non-zero (99) on purpose: if the renderer ever
  // regressed to the retired per-learning counter instead of the ledger,
  // these tests would catch it (expected cell value is "0", the ledger
  // truth, not "198", the stored-counter sum).
  return [
    row({ id: 'bsz_a', title: 'row a', category: 'code-execution' }),
    row({ id: 'bsz_b', title: 'row b', category: 'data-processing' }),
  ];
}

// Forces renderLiveCatalogStats' catch: the same forced-failure target the
// strip-date-hook suite uses, so the fail path exercised here is identical.
const RENDERER_THROW = {
  name: 'force renderLiveCatalogStats catch',
  search: 'const visible = visibleLearningsList();',
  replace: "const visible = (() => { throw new Error('BUILDERS-STRIP-ZEROS forced renderer failure'); })();",
};

// ─── Staged server ────────────────────────────────────────────────────────────

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
    // Empty earnings map + a ZERO-ROW (but READABLE) unlock-event ledger:
    // the honest-zero case the spec asks for, distinct from an unreadable
    // ledger (which the forced-throw test below covers instead).
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

describe('BUILDERS-STRIP-ZEROS: /for-builders honest-zero cells are server-rendered from the ledger truth', () => {
  it('(1) healthy renderer, 0-row ledger → lc-unlocks "0", lc-paid "$0.00", "Supply is ahead of demand." removed', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, {}, async (html) => {
      assert.equal(cellText(html, 'lc-unlocks'), '0', 'lc-unlocks renders the ledger total, not the stored quality.unlocks counter');
      assert.equal(cellText(html, 'lc-paid'), '$0.00', 'lc-paid renders the attributable ledger money, formatted to cents');
      assert.equal(countSupplyLine(html), 0, 'the abstraction comes out once the zeros actually render');
      assert.ok(html.includes('id="lc-learnings">2<'), 'the count from the same computation rendered alongside it');
      assert.equal(cellText(html, 'lc-learnings-hero'), '2', 'the hero cell renders from the same live count as the strip');
      assert.equal(cellText(html, 'lc-learnings-hero'), cellText(html, 'lc-learnings'), 'hero and strip counts are the SAME derivation, never independently computed');
    });
  });

  it('(2) renderer catch forced → both cells EMPTY, "Supply is ahead of demand." still present, failure logged', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { replacements: [RENDERER_THROW] }, async (html, boot) => {
      assert.equal(cellText(html, 'lc-unlocks'), '', 'lc-unlocks stays empty on the fail path — never a static digit');
      assert.equal(cellText(html, 'lc-paid'), '', 'lc-paid stays empty on the fail path — never a static digit');
      assert.equal(countSupplyLine(html), 1, 'the fail path leaves the sentence in place — an asserted zero is worse than the vaguer line');
      assert.equal(cellText(html, 'lc-learnings-hero'), '226', 'the hero cell falls open to the static value, same as the strip cell');
      await new Promise((r) => setTimeout(r, 200));
      assert.match(boot.getOutput(), /\[live-stats\] render failed, serving static values: BUILDERS-STRIP-ZEROS forced renderer failure/);
    });
  });
});

describe('BUILDERS-STRIP-ZEROS: static file and source pins', () => {
  it('public/for-builders.html ships the lc-unlocks and lc-paid spans once each, EMPTY, with the supply sentence present (the fail-path baseline)', () => {
    assert.equal((STATIC_HTML.match(/id="lc-unlocks"/g) || []).length, 1, 'lc-unlocks id appears exactly once');
    assert.equal((STATIC_HTML.match(/id="lc-paid"/g) || []).length, 1, 'lc-paid id appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-unlocks"><\/span>/, 'lc-unlocks ships empty in the static file');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-paid"><\/span>/, 'lc-paid ships empty in the static file');
    assert.equal(countSupplyLine(STATIC_HTML), 1, 'the static file (the fail-path baseline) still carries the sentence');
    assert.match(STATIC_HTML, /<p class="reveal" id="lc-supply-line"[^>]*>Supply is ahead of demand\.<\/p>/, 'the sentence is wrapped for the renderer\'s removal regex to target');

    // Same regex-injection hazard the strip-date-hook suite guards against:
    // a literal id="lc-…" inside an HTML comment would be matched by the
    // renderer's substitution regex and injected as stray page text.
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-(unlocks|paid|supply-line)"/,
        'no renderer-targeted id attribute inside an HTML comment');
    }
  });

  it('server.js: the lc-unlocks/lc-paid substitutions and the sentence removal sit inside renderLiveCatalogStats\' try, gated on truth.unlocks, and read catalogStatsTruth (never quality.unlocks)', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    const tryIdx = fn.indexOf('try {');
    const catchIdx = fn.indexOf('} catch (e) {');
    const truthIdx = fn.indexOf('catalogStatsTruth(');
    const unlocksIdx = fn.indexOf('id="lc-unlocks"');
    const paidIdx = fn.indexOf('id="lc-paid"');
    const supplyIdx = fn.indexOf('lc-supply-line');
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(truthIdx > tryIdx && truthIdx < catchIdx, 'catalogStatsTruth is called inside the try');
    assert.ok(unlocksIdx > truthIdx && unlocksIdx < catchIdx, 'the lc-unlocks substitution follows the truth derivation, inside the try');
    assert.ok(paidIdx > truthIdx && paidIdx < catchIdx, 'the lc-paid substitution follows the truth derivation, inside the try');
    assert.ok(supplyIdx > truthIdx && supplyIdx < catchIdx, 'the supply-line removal follows the truth derivation, inside the try');
    assert.match(fn, /if \(truth\.unlocks\)\s*\{/, 'the three substitutions are gated on the ledger being readable (truth.unlocks non-null)');
    assert.doesNotMatch(fn, /quality\.unlocks/, 'the cell derivation never reads the retired quality.unlocks counter');
    const catchBody = fn.slice(catchIdx);
    assert.match(catchBody, /return html;/, 'the catch returns the html untouched — both cells stay empty and the sentence stays');
    assert.doesNotMatch(catchBody, /lc-unlocks|lc-paid|Supply is ahead/, 'the catch writes no cell value and does not touch the sentence');
  });

  it('public/for-builders.html: hero stat row ships the live-count cell in gold, the two constants at caption tier, and no $0.05 / minimum-unlock-price cell', () => {
    assert.equal((STATIC_HTML.match(/id="lc-learnings-hero"/g) || []).length, 1, 'lc-learnings-hero id appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-learnings-hero">226<\/span>/, 'hero cell ships the static 226, gold tier (pull-stat-num)');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-caption">70%<\/span>\s*<span class="stat-label pull-stat-caption">direct share \(60% via discovery\)<\/span>/, '70% drops to caption tier, existing caption unchanged');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-caption">under 1 minute<\/span>\s*<span class="stat-label pull-stat-caption">time to connect<\/span>/, '<1 min becomes the words "under 1 minute", also caption tier');

    // Scope the "$0.05 cell is gone" checks to the hero section itself — the
    // string "$0.05" and the phrase "minimum unlock price" legitimately
    // remain elsewhere on the page (body copy, JSON-LD); only the HERO cell
    // is ruled out.
    const heroStart = STATIC_HTML.indexOf('<section id="builders-hero"');
    const heroEnd = STATIC_HTML.indexOf('</section>', heroStart);
    assert.ok(heroStart > 0 && heroEnd > heroStart, 'the builders-hero section is located');
    const heroSection = STATIC_HTML.slice(heroStart, heroEnd);
    assert.equal((heroSection.match(/class="builders-hero-stat"/g) || []).length, 3, 'exactly three stat cells in the hero row (226 / 70% / under 1 minute — the $0.05 cell is gone, not just re-tiered)');
    assert.doesNotMatch(heroSection, /\$0\.05/, 'the $0.05 hero figure is gone');
    assert.doesNotMatch(heroSection, /minimum unlock price/, 'the "minimum unlock price" caption is gone from the hero — the whole cell was removed');
    assert.doesNotMatch(heroSection, /pull-stat-secondary/, 'no cell in the hero row is left at the old $0.05/<1 min secondary tier');
    assert.doesNotMatch(heroSection, /&lt;1 min/, 'the old "<1 min" digit-form text is gone, replaced by the words "under 1 minute"');

    // Same regex-injection hazard the other live-stat suites guard against.
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-learnings-hero"/,
        'no renderer-targeted id attribute inside an HTML comment');
    }
  });

  it('server.js: the lc-learnings-hero substitution reuses the SAME `count` as lc-learnings, inside renderLiveCatalogStats\' try, immediately after the strip substitution', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    const tryIdx = fn.indexOf('try {');
    const catchIdx = fn.indexOf('} catch (e) {');
    const learningsIdx = fn.indexOf('id="lc-learnings"');
    const heroIdx = fn.indexOf('id="lc-learnings-hero"');
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(learningsIdx > tryIdx && learningsIdx < catchIdx, 'the lc-learnings substitution is inside the try');
    assert.ok(heroIdx > learningsIdx && heroIdx < catchIdx, 'the lc-learnings-hero substitution follows it, still inside the try');
    // Isolate the two replace() calls and confirm both interpolate the
    // exact same `${count}` local, never a second/independent derivation.
    const learningsCall = fn.slice(learningsIdx - 40, learningsIdx + 80);
    const heroCall = fn.slice(heroIdx - 40, heroIdx + 80);
    assert.match(learningsCall, /\$\{count\}/, 'lc-learnings interpolates the `count` local');
    assert.match(heroCall, /\$\{count\}/, 'lc-learnings-hero interpolates the SAME `count` local, not a new one');
    assert.equal((fn.match(/const count = /g) || []).length, 1, 'only one `count` is ever derived in this function');
    const catchBody = fn.slice(catchIdx);
    assert.doesNotMatch(catchBody, /lc-learnings-hero/, 'the catch writes no hero-cell value — it stays at the static 226 shipped in the file');
  });
});
