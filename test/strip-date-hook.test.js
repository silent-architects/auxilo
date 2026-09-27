'use strict';

/**
 * test/strip-date-hook.test.js — the /for-builders ledger strip's as-of line
 * (AD strings packet 3 §4), superseded by the VISION PASS (SITE-PM,
 * 2026-09-27), REGISTER-V-VISION.md row V-04.
 *
 * WHAT THIS FILE USED TO COVER: the as-of line (`as of <Month> <D>, <YYYY>
 * UTC`), server-rendered into id="lc-asof" from the same catalog-stats
 * computation that filled id="lc-learnings" on the strip, fail-closed to an
 * empty span on a render failure.
 *
 * VISION PASS RULING (charter V1, register V-04): the whole three-cell
 * ledger strip on /for-builders — including its own id="lc-learnings" copy
 * and the id="lc-asof" span beside it — is CUT, with no replacement. The
 * catalog count stays the page's lead figure in the hero row
 * (id="lc-learnings-hero", untouched), which carries no as-of line and
 * never did.
 *
 * This file now proves the removal: the static file carries no id="lc-asof"
 * anywhere, the served page (healthy render) carries no `as of ` text and
 * no id="lc-asof" element, and server.js's as-of formatter/substitution
 * code (still present, unchanged — S-3: no server.js edit was needed) is
 * simply never reached for /for-builders any more because its target cell
 * is gone.
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

describe('VISION PASS (V-04): /for-builders no longer carries an as-of line — served route', () => {
  it('healthy renderer → zero `as of` text, no id="lc-asof" element; the surviving hero cell (id="lc-learnings-hero") still renders live', { timeout: 240_000 }, async (t) => {
    await withStagedServer(t, {}, async (html) => {
      assert.equal(countAsOf(html), 0, 'no `as of ` text anywhere on the rendered page');
      assert.ok(!html.includes('id="lc-asof"'), 'no id="lc-asof" element in the rendered page — the whole strip it belonged to is gone');
      assert.ok(!html.includes('id="lc-learnings"[^-]'), 'sanity pattern check only; the real assertion is the exact-string one below');
      assert.ok(!/id="lc-learnings"[^-]/.test(html), 'the strip\'s own lc-learnings copy is also gone (V-04 cut the whole cell)');
      // Positive control: the hero cell is a DIFFERENT, surviving fill.
      assert.ok(html.includes('id="lc-learnings-hero">2<'), 'positive control: the hero cell still renders the live count from the same computation');
    });
  });
});

describe('VISION PASS (V-04): static file and source pins', () => {
  it('public/for-builders.html ships no id="lc-asof" anywhere, no baked `as of` text', () => {
    assert.equal((STATIC_HTML.match(/id="lc-asof"/g) || []).length, 0, 'the id must be gone entirely');
    assert.equal(countAsOf(STATIC_HTML), 0, 'no `as of` text in the static file');
    for (const m of STATIC_HTML.matchAll(/<!--[\s\S]*?-->/g)) {
      assert.doesNotMatch(m[0], /id="lc-(learnings|categories|price-range|asof)"/,
        'no renderer-targeted id attribute inside an HTML comment');
    }
  });

  it('server.js: the lc-asof substitution still sits inside renderLiveCatalogStats\' try (the catch returns html untouched); the formatter still throws on an invalid date — code shape unchanged, this pass made no server.js edit (S-3: no fill misbehaved)', () => {
    const start = SERVER_SRC.indexOf('function renderLiveCatalogStats(html) {');
    assert.ok(start > 0, 'renderer located');
    const end = SERVER_SRC.indexOf('\n}\n', start);
    const fn = SERVER_SRC.slice(start, end);
    const tryIdx = fn.indexOf('try {');
    const catchIdx = fn.indexOf('} catch (e) {');
    const asofIdx = fn.indexOf('id="lc-asof"');
    const derivIdx = fn.indexOf('const visible = visibleLearningsList();');
    assert.ok(tryIdx > 0 && catchIdx > tryIdx, 'try/catch shape intact');
    assert.ok(derivIdx > tryIdx && derivIdx < catchIdx, 'the stats derivation is inside the try');
    assert.ok(asofIdx > derivIdx && asofIdx < catchIdx, 'the lc-asof substitution is inside the try, after the stats derivation — still present, still harmless on a page with no matching cell');
    assert.ok(fn.includes('formatAsOfUtc(new Date())'), 'the as-of is still derived at render time');
    const catchBody = fn.slice(catchIdx);
    assert.doesNotMatch(catchBody, /lc-asof|as of/, 'the catch still writes no date');

    const fmtStart = SERVER_SRC.indexOf('function formatAsOfUtc(date) {');
    assert.ok(fmtStart > 0, 'formatter located');
    const fmt = SERVER_SRC.slice(fmtStart, SERVER_SRC.indexOf('\n}\n', fmtStart));
    assert.match(fmt, /Number\.isNaN\(date\.getTime\(\)\)\) throw new Error/, 'invalid date still throws (no default date)');
    assert.match(fmt, /getUTCMonth\(\)\]\} \$\{date\.getUTCDate\(\)\}, \$\{date\.getUTCFullYear\(\)\} UTC/, 'Month D, YYYY UTC shape from UTC getters, unchanged');
  });
});
