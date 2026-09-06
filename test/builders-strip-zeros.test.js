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
 *         render "…" (the static fail-path placeholder, Wave B S1 — never a
 *         static digit), "Supply is ahead of demand." is still on the page,
 *         the failure is logged
 *   static file: `<span ... id="lc-unlocks">…</span>` and
 *     `<span ... id="lc-paid">…</span>` present once each, ellipsis-only, no
 *     digits or "$" anywhere in those spans; "Supply is ahead of demand."
 *     present exactly once (the fail-path baseline). Both spans carry class
 *     `stat-num pull-stat-secondary` (Wave B B2, the ivory tier) — the
 *     lc-learnings count cell keeps the gold `pull-stat-num` tier so exactly
 *     one figure per strip reads gold.
 *   source pins: both substitutions and the sentence removal live INSIDE
 *     renderLiveCatalogStats' try, gated on truth.unlocks (not on the count
 *     or as-of derivations, which can succeed independently), so a ledger
 *     read failure cannot leave a static digit behind. Wave B S2: the
 *     catalogStatsTruth ledger read itself is additionally gated on
 *     `html` containing `id="lc-unlocks"` — the only page that renders those
 *     cells (/for-builders) — so /how-it-works, /for-agents, and /pricing
 *     pay no ledger-read cost for a page section they don't have.
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

// Wave B S2: a console spy on the ONE catalogStatsTruth call site, so the
// staged-server log proves whether the (synchronous, ledger-reading) call
// actually ran for a given request — without mocking fs at the process level.
const LEDGER_READ_SPY = {
  name: 'spy on catalogStatsTruth ledger-read gate (S2)',
  search: 'const truth = catalogStatsTruth(visible);',
  replace: "console.error('S2-LEDGER-READ-SPY: catalogStatsTruth invoked'); const truth = catalogStatsTruth(visible);",
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

  it('(2) renderer catch forced → lc-unlocks/lc-paid stay at the static "…" placeholder, LEDGER-FAIL-OPEN-FB: the learnings-count cells hide entirely (fail-closed, not fail-open to "226"), "Supply is ahead of demand." still present, failure logged', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { replacements: [RENDERER_THROW] }, async (html, boot) => {
      assert.equal(cellText(html, 'lc-unlocks'), '…', 'lc-unlocks stays at the static "…" placeholder on the fail path — never a static digit');
      assert.equal(cellText(html, 'lc-paid'), '…', 'lc-paid stays at the static "…" placeholder on the fail path — never a static digit');
      assert.equal(countSupplyLine(html), 1, 'the fail path leaves the sentence in place — an asserted zero is worse than the vaguer line');
      // LEDGER-FAIL-OPEN-FB (2026-09-06): the hero and strip learnings-count
      // cells used to fall open to a static "226" here — a stale claim
      // surviving a render failure. They are now marker-wrapped and
      // fail-closed like lc-price-range: the whole cell (count span +
      // caption, and on the strip cell the as-of span too) is stripped on
      // this path, never just the digit.
      assert.doesNotMatch(html, /id="lc-learnings-hero"/, 'the hero cell is gone entirely on the fail path, not just emptied');
      assert.doesNotMatch(html, /id="lc-learnings"[^-]/, 'the strip learnings-count cell is gone entirely on the fail path (negative lookahead excludes lc-learnings-hero)');
      assert.doesNotMatch(html, /226/, 'no stale "226" literal survives the fail path anywhere on the page');
      // "no stranded caption": the cell's OWN "learnings in the catalog"
      // caption must not survive without its value — count how many times
      // it appears versus the known-surviving non-stripped constants (70%,
      // under 1 minute) to confirm the whole cell, caption included, is gone.
      assert.doesNotMatch(html, /learnings in the catalog/, 'the "learnings in the catalog" caption does not strand without its value cell');
      await new Promise((r) => setTimeout(r, 200));
      assert.match(boot.getOutput(), /\[live-stats\] render failed, serving static values: BUILDERS-STRIP-ZEROS forced renderer failure/);
    });
  });

  it('(3) S2: the ledger read runs for /for-builders (which has id="lc-unlocks") and is skipped entirely for /how-it-works (which does not) — /for-builders still renders both cells', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { replacements: [LEDGER_READ_SPY] }, async (html, boot) => {
      // withStagedServer's own request already hit /for-builders — the spy
      // must have fired there, and the cells must still render correctly
      // with the gate in place.
      assert.match(boot.getOutput(), /S2-LEDGER-READ-SPY: catalogStatsTruth invoked/, 'the ledger read runs for /for-builders, the one page with id="lc-unlocks"');
      assert.equal(cellText(html, 'lc-unlocks'), '0', '/for-builders still renders the unlocks cell with the S2 gate in place');
      assert.equal(cellText(html, 'lc-paid'), '$0.00', '/for-builders still renders the paid cell with the S2 gate in place');

      // Now hit a live-data page with NO id="lc-unlocks" cell and confirm the
      // ledger-read spy does not fire a second time.
      const before = boot.getOutput();
      const res = await fetch(`${boot.baseUrl}/how-it-works`);
      assert.equal(res.status, 200);
      const howItWorksHtml = await res.text();
      assert.doesNotMatch(howItWorksHtml, /id="lc-unlocks"/, 'sanity: /how-it-works really has no lc-unlocks cell to gate on');
      await new Promise((r) => setTimeout(r, 200));
      const grew = boot.getOutput().slice(before.length);
      assert.doesNotMatch(grew, /S2-LEDGER-READ-SPY/, '/how-it-works triggers no ledger read — it has no id="lc-unlocks" cell for catalogStatsTruth to feed');
    });
  });
});

describe('BUILDERS-STRIP-ZEROS: static file and source pins', () => {
  it('public/for-builders.html ships the lc-unlocks and lc-paid spans once each, ellipsis-only, ivory tier, with the supply sentence present (the fail-path baseline)', () => {
    assert.equal((STATIC_HTML.match(/id="lc-unlocks"/g) || []).length, 1, 'lc-unlocks id appears exactly once');
    assert.equal((STATIC_HTML.match(/id="lc-paid"/g) || []).length, 1, 'lc-paid id appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-secondary" id="lc-unlocks">…<\/span>/, 'lc-unlocks ships "…" in the static file, ivory (pull-stat-secondary) tier — not the gold count tier');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-secondary" id="lc-paid">…<\/span>/, 'lc-paid ships "…" in the static file, ivory (pull-stat-secondary) tier — not the gold count tier');
    assert.doesNotMatch(STATIC_HTML, /class="stat-num pull-stat-num" id="lc-unlocks"/, 'lc-unlocks no longer carries the gold pull-stat-num class');
    assert.doesNotMatch(STATIC_HTML, /class="stat-num pull-stat-num" id="lc-paid"/, 'lc-paid no longer carries the gold pull-stat-num class');
    assert.equal(countSupplyLine(STATIC_HTML), 1, 'the static file (the fail-path baseline) still carries the sentence');
    // Wave E3 item 7 removed the dead scroll-reveal system (and every
    // class="reveal" attribute) from for-builders.html, so this <p> no
    // longer carries a class -- server.js's removal regex
    // (<p[^>]*\bid="lc-supply-line"[^>]*>...) is attribute-order/-presence
    // agnostic and still matches it either way.
    assert.match(STATIC_HTML, /<p id="lc-supply-line"[^>]*>Supply is ahead of demand\.<\/p>/, 'the sentence is wrapped for the renderer\'s removal regex to target');

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
    // Wave B S2: the ledger read itself is gated on `html.includes('id="lc-unlocks"')`,
    // so that literal now appears TWICE in the function — once in the gate
    // check (before the truth derivation) and once in the substitution
    // itself (after it). Locate the gate first, then search for the
    // substitution occurrence starting from the truth derivation onward.
    const gateIdx = fn.indexOf('id="lc-unlocks"');
    const truthIdx = fn.indexOf('catalogStatsTruth(');
    const unlocksIdx = fn.indexOf('id="lc-unlocks"', truthIdx);
    const paidIdx = fn.indexOf('id="lc-paid"', truthIdx);
    const supplyIdx = fn.indexOf('lc-supply-line', truthIdx);
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(gateIdx > tryIdx && gateIdx < truthIdx, 'S2: the id="lc-unlocks" gate check precedes the ledger read, inside the try — /how-it-works, /for-agents, /pricing never reach catalogStatsTruth');
    assert.ok(truthIdx > tryIdx && truthIdx < catchIdx, 'catalogStatsTruth is called inside the try');
    assert.ok(unlocksIdx > truthIdx && unlocksIdx < catchIdx, 'the lc-unlocks substitution follows the truth derivation, inside the try');
    assert.ok(paidIdx > truthIdx && paidIdx < catchIdx, 'the lc-paid substitution follows the truth derivation, inside the try');
    assert.ok(supplyIdx > truthIdx && supplyIdx < catchIdx, 'the supply-line removal follows the truth derivation, inside the try');
    assert.match(fn, /if \(truth\.unlocks\)\s*\{/, 'the three substitutions are gated on the ledger being readable (truth.unlocks non-null)');
    assert.doesNotMatch(fn, /quality\.unlocks/, 'the cell derivation never reads the retired quality.unlocks counter');
    const catchBody = fn.slice(catchIdx);
    // LEDGER-FAIL-OPEN-FB (2026-09-06): the catch no longer returns `html`
    // bare — it now also strips the LC-LEARNINGS-CELL/LC-LEARNINGS-HERO-CELL
    // marker blocks (see the dedicated builders-strip-zeros test below), so
    // this is `return html\n  .replace(...)...;` rather than a standalone
    // `return html;` statement. lc-unlocks/lc-paid/Supply are untouched
    // either way — neither of those two new .replace() calls references
    // them, which is what this assertion actually needs to hold.
    assert.match(catchBody, /return html\s*\n?\s*(?:\.replace\([\s\S]*?\)\s*)*;/, 'the catch still returns (a transform of) html — no cell/sentence value is computed or written');
    assert.doesNotMatch(catchBody, /lc-unlocks|lc-paid|Supply is ahead/, 'the catch writes no lc-unlocks/lc-paid cell value and does not touch the sentence');
  });

  it('server.js S2: catalogStatsTruth (the ledger read) is called at most once per render, and never when the page has no lc-unlocks cell', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    assert.equal((fn.match(/catalogStatsTruth\(/g) || []).length, 1, 'catalogStatsTruth is called from exactly one call site in this function');
    assert.match(fn, /if \(html\.includes\('id="lc-unlocks"'\)\)\s*\{/, 'the ledger read sits behind an explicit html.includes(\'id="lc-unlocks"\') gate');
  });

  it('public/for-builders.html: hero stat row ships the live-count cell EMPTY and marker-wrapped (LEDGER-FAIL-OPEN-FB, fail-closed — no static 226), the two constants at caption tier, and no $0.05 / minimum-unlock-price cell', () => {
    assert.equal((STATIC_HTML.match(/id="lc-learnings-hero"/g) || []).length, 1, 'lc-learnings-hero id appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-learnings-hero"><\/span>/, 'hero cell ships EMPTY, gold tier (pull-stat-num) — no static 226 literal');
    assert.doesNotMatch(STATIC_HTML, /id="lc-learnings-hero">226/, 'the retired static 226 literal must not survive in the static file');
    assert.match(STATIC_HTML, /<!--LC-LEARNINGS-HERO-CELL-->[\s\S]*?id="lc-learnings-hero">[\s\S]*?<!--\/LC-LEARNINGS-HERO-CELL-->/, 'the hero cell is wrapped in LC-LEARNINGS-HERO-CELL markers, same fail-closed pattern as lc-price-range');
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
    assert.equal((heroSection.match(/class="builders-hero-stat"/g) || []).length, 3, 'exactly three stat cells in the hero row (the live-count cell / 70% / under 1 minute — the $0.05 cell is gone, not just re-tiered)');
    assert.doesNotMatch(heroSection, /\$0\.05/, 'the $0.05 hero figure is gone');
    assert.doesNotMatch(heroSection, /minimum unlock price/, 'the "minimum unlock price" caption is gone from the hero — the whole cell was removed');
    assert.doesNotMatch(heroSection, /pull-stat-secondary/, 'no cell in the hero row is left at the old $0.05/<1 min secondary tier');
    assert.doesNotMatch(heroSection, /&lt;1 min/, 'the old "<1 min" digit-form text is gone, replaced by the words "under 1 minute"');

    // Same regex-injection hazard the other live-stat suites guard against.
    // The marker comments themselves (LC-LEARNINGS-HERO-CELL) carry no
    // "id=" attribute text at all, so they're inert against the renderer's
    // substitution regex the same way LC-PRICE-RANGE-CELL is.
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-learnings-hero"/,
        'no renderer-targeted id attribute inside an HTML comment');
    }
  });

  it('public/for-builders.html: the strip live-count cell (id="lc-learnings") also ships EMPTY and marker-wrapped, no static 226, no stranded caption', () => {
    assert.equal((STATIC_HTML.match(/id="lc-learnings"[^-]/g) || []).length, 1, 'lc-learnings id (excluding the -hero variant) appears exactly once');
    assert.match(STATIC_HTML, /<span class="stat-num pull-stat-num" id="lc-learnings"><\/span>/, 'strip cell ships EMPTY — no static 226 literal');
    assert.match(STATIC_HTML, /<!--LC-LEARNINGS-CELL-->[\s\S]*?id="lc-learnings">[\s\S]*?learnings in the catalog[\s\S]*?<!--\/LC-LEARNINGS-CELL-->/, 'the count span + its OWN caption are wrapped in LC-LEARNINGS-CELL markers — no stranded caption for that pair on the fail path');
    // id="lc-asof" is DELIBERATELY outside the LC-LEARNINGS-CELL markers —
    // it's a separate, already-correct fail-closed cell (test/strip-date-
    // hook.test.js owns it): ships empty, stays empty on the fail path,
    // independent of the count. Bundling it into this marker pair would
    // regress that suite's "span present and EMPTY" fail-path assertion
    // into "span absent entirely".
    const learningsCellMatch = STATIC_HTML.match(/<!--LC-LEARNINGS-CELL-->[\s\S]*?<!--\/LC-LEARNINGS-CELL-->/);
    assert.ok(learningsCellMatch, 'LC-LEARNINGS-CELL marker pair found');
    assert.doesNotMatch(learningsCellMatch[0], /id="lc-asof"/, 'id="lc-asof" is not inside the LC-LEARNINGS-CELL markers');
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-learnings"[^-]/,
        'no renderer-targeted id="lc-learnings" attribute text inside an HTML comment (the LC-LEARNINGS-CELL marker itself carries no id= text)');
    }
  });

  it('server.js: the lc-learnings-hero substitution reuses the SAME `count` as lc-learnings, inside renderLiveCatalogStats\' try, immediately after the strip substitution — markers strip on both success and the catch (LEDGER-FAIL-OPEN-FB, fail-closed)', () => {
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
    // LEDGER-FAIL-OPEN-FB (2026-09-06): the success path unconditionally
    // strips both marker pairs before filling (reaching this point means
    // `visible` derived without throwing); the marker removal must precede
    // the id-based fill lines for each cell.
    const heroMarkerStripIdx = fn.indexOf('LC-LEARNINGS-HERO-CELL');
    const stripMarkerStripIdx = fn.indexOf('LC-LEARNINGS-CELL', tryIdx);
    assert.ok(heroMarkerStripIdx > tryIdx && heroMarkerStripIdx < heroIdx, 'the LC-LEARNINGS-HERO-CELL markers are stripped before the hero cell is filled, inside the try');
    assert.ok(stripMarkerStripIdx > tryIdx && stripMarkerStripIdx < learningsIdx, 'the LC-LEARNINGS-CELL markers are stripped before the strip cell is filled, inside the try');
    const catchBody = fn.slice(catchIdx);
    assert.match(catchBody, /LC-LEARNINGS-HERO-CELL/, 'the catch ALSO strips the hero cell\'s marker-wrapped block — fail-closed on every route into this catch, not only when `visible` derives successfully');
    assert.match(catchBody, /LC-LEARNINGS-CELL/, 'the catch ALSO strips the strip cell\'s marker-wrapped block');
    assert.doesNotMatch(catchBody, /226/, 'the catch never writes or references the retired static 226 value');
  });
});
