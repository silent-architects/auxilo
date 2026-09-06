'use strict';

/**
 * test/strip-date-hook.test.js — the /for-builders ledger strip's as-of line
 * (AD strings packet 3 §4) is server-rendered from the same catalog-stats
 * computation that fills id="lc-learnings", and the fail path emits NO date.
 *
 *   `as of <Month> <D>, <YYYY> UTC` — English month name, day without a
 *   leading zero, four-digit year, literal UTC. The date is the same
 *   construction GET /knowledge/stats carries (`new Date()` at computation
 *   time; the renderer holds no stored timestamp), so a page cached for up
 *   to an hour still states the true as-of of its own data.
 *
 *   staged server, seeded catalog:
 *     (1) healthy renderer → rendered /for-builders carries EXACTLY ONE
 *         `as of <current UTC month> <d>, <yyyy> UTC`, inside id="lc-asof"
 *     (2) renderer's catch forced (visibleLearningsList throws) → rendered
 *         page contains ZERO `as of`; the span is present and EMPTY; the
 *         count falls open to the static value; the fail is logged
 *   static file: `<span id="lc-asof"></span>` present once and EMPTY; the
 *     file contains no `as of` (never a baked placeholder date).
 *   source pins: the lc-asof substitution lives INSIDE renderLiveCatalogStats'
 *     try (so the catch's untouched-html return is the only fail path), and
 *     the formatter throws on an invalid date rather than defaulting.
 *
 * Runner: node --test test/strip-date-hook.test.js
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

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const AS_OF_RE = /as of (January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4}) UTC/g;

function expectedAsOf(date) {
  return `as of ${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()} UTC`;
}
function asOfSpan(html) {
  const m = html.match(/id="lc-asof"[^>]*>([^<]*)</);
  assert.ok(m, 'id="lc-asof" span present in the rendered HTML');
  return m[1];
}
function countAsOf(html) {
  return (html.match(/as of /g) || []).length;
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
function fixtureCatalog() {
  return [
    row({ id: 'sdh_a', title: 'row a', category: 'code-execution' }),
    row({ id: 'sdh_b', title: 'row b', category: 'data-processing' }),
  ];
}

// Forces renderLiveCatalogStats' catch: the renderer's first derivation step
// throws, so the whole substitution set is skipped and the html is returned
// untouched. This is the exact line the renderer opens with (pinned below).
const RENDERER_THROW = {
  name: 'force renderLiveCatalogStats catch',
  search: 'const visible = visibleLearningsList();',
  replace: "const visible = (() => { throw new Error('STRIP-DATE-HOOK forced renderer failure'); })();",
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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-strip-date-hook-srv-'));
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
    const before = new Date();
    const pageRes = await fetch(`${boot.baseUrl}/for-builders`);
    const after = new Date();
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
    const html = await pageRes.text();
    await body(html, { before, after }, boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('STRIP-DATE-HOOK: /for-builders strip as-of line is server-rendered from the stats computation', () => {
  it('(1) healthy renderer → exactly one `as of <current month> <d>, <yyyy> UTC`, inside id="lc-asof", derived at render time', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, {}, async (html, { before, after }) => {
      const matches = [...html.matchAll(AS_OF_RE)];
      assert.equal(matches.length, 1, `exactly one as-of line on the page, got ${matches.length}`);
      assert.equal(countAsOf(html), 1, 'no other `as of ` text anywhere on the rendered page');
      const rendered = matches[0][0];
      // The fetch may straddle a UTC midnight/month boundary: accept the date
      // as computed either side of the request, and nothing else.
      const accepted = new Set([expectedAsOf(before), expectedAsOf(after)]);
      assert.ok(accepted.has(rendered), `rendered "${rendered}" must be the current UTC date (${[...accepted].join(' | ')})`);
      assert.equal(asOfSpan(html), rendered, 'the as-of line lives inside the lc-asof span');
      assert.doesNotMatch(rendered, /as of \w+ 0\d,/, 'day carries no leading zero');
      assert.ok(html.includes('id="lc-learnings">2<'), 'the count from the same computation rendered alongside it');
    });
  });

  it('(2) renderer catch forced → ZERO `as of` on the page, lc-asof span present and EMPTY, count falls open to the static value, failure logged', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, { replacements: [RENDERER_THROW] }, async (html, _dates, boot) => {
      assert.equal(countAsOf(html), 0, 'the fail path emits no date at all');
      assert.equal(asOfSpan(html), '', 'the span is present and empty — never a stale or default date');
      assert.ok(html.includes('id="lc-learnings">226<'), 'count fails open to the static value, as before');
      await new Promise((r) => setTimeout(r, 200));
      assert.match(boot.getOutput(), /\[live-stats\] render failed, serving static values: STRIP-DATE-HOOK forced renderer failure/);
    });
  });
});

describe('STRIP-DATE-HOOK: static file and source pins', () => {
  it('public/for-builders.html ships `<span id="lc-asof"></span>` once, empty, directly after the strip caption, and contains no `as of`', () => {
    const spans = STATIC_HTML.match(/<span id="lc-asof"><\/span>/g) || [];
    assert.equal(spans.length, 1, 'exactly one empty lc-asof span');
    assert.equal((STATIC_HTML.match(/id="lc-asof"/g) || []).length, 1, 'the id appears exactly once');
    assert.equal(countAsOf(STATIC_HTML), 0, 'no baked as-of text in the static file');
    assert.match(STATIC_HTML,
      /<span class="stat-label pull-stat-caption">learnings in the catalog<\/span>\s*<span id="lc-asof"><\/span>/,
      'the span sits directly after the strip caption line');
    // The renderer's substitution regexes are `id="lc-<name>"[^>]*>[^<]*<` —
    // a literal id="lc-…" attribute inside an HTML comment matches too and
    // injects the live value as stray page text after the `-->`. (The
    // pre-existing strip comment did exactly that with lc-learnings; fixed
    // alongside this hook.) Keep every lc- id out of comments.
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-(learnings|categories|price-range|asof)"/,
        'no renderer-targeted id attribute inside an HTML comment');
    }
  });

  it('server.js: lc-asof substitution sits inside renderLiveCatalogStats\' try (the catch returns html untouched); the formatter throws on an invalid date', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    const tryIdx = fn.indexOf('try {');
    const catchIdx = fn.indexOf('} catch (e) {');
    const asofIdx = fn.indexOf('id="lc-asof"');
    const derivIdx = fn.indexOf(RENDERER_THROW.search);
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(derivIdx > tryIdx && derivIdx < catchIdx, 'the stats derivation the forced-catch test targets is inside the try');
    assert.ok(asofIdx > derivIdx && asofIdx < catchIdx, 'the lc-asof substitution is inside the try, after the stats derivation');
    assert.ok(fn.includes('formatAsOfUtc(new Date())'), 'the as-of is derived at render time (same construction as /knowledge/stats timestamp)');
    assert.equal((SERVER_SRC.match(/const visible = visibleLearningsList\(\);/g) || []).length, 1,
      'the forced-catch replacement target is unique in server.js');
    const catchBody = fn.slice(catchIdx);
    assert.match(catchBody, /return html;/, 'the catch returns the html untouched — the span stays empty');
    assert.doesNotMatch(catchBody, /lc-asof|as of/, 'the catch writes no date');

    const fmtStart = SERVER_SRC.indexOf('function formatAsOfUtc(date) {');
    assert.ok(fmtStart > 0, 'formatter located');
    const fmt = SERVER_SRC.slice(fmtStart, SERVER_SRC.indexOf('\n}\n', fmtStart));
    assert.match(fmt, /Number\.isNaN\(date\.getTime\(\)\)\) throw new Error/, 'invalid date throws (no default date)');
    assert.match(fmt, /getUTCMonth\(\)\]\} \$\{date\.getUTCDate\(\)\}, \$\{date\.getUTCFullYear\(\)\} UTC/, 'Month D, YYYY UTC shape from UTC getters');
  });
});
