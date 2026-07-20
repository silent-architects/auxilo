/**
 * test/pricing-visibility.test.js — public pricing analytics must respect the
 * moderation visibility predicate (CAT-1 catalog-health pass §7, 2026-07-19).
 *
 * Bug: GET /pricing/categories iterated the raw `learnings` array with no
 * status filter, so its public counts/avg_price included pending_review,
 * rejected, and retracted learnings (live prod reported 940 total vs the 58
 * visible learnings /knowledge/stats reports). GET
 * /contributor/:wallet/pricing-insights had the same missing filter — worse,
 * its top_earning_learnings exposes TITLES, so it leaked titles of
 * non-approved learnings for any wallet, unauthenticated.
 *
 * Fix: both endpoints now draw from visibleLearningsList(), the same
 * predicate /knowledge/stats applies (LW-QA fix, server.js ~6783):
 * CONTENT_MODERATION_ENABLED ? (!l.status || l.status === 'approved') : all.
 *
 * CH-2 (SPEC-3 ruling, same pass): GET /contributor/:wallet learnings_submitted
 * joined the same predicate — see the structural guard below for the rationale.
 *
 * Two guards, matching repo convention (test/cold-start-seed.test.js):
 *   1. Structural — source assertions that both route handlers use
 *      visibleLearningsList() and never touch the raw array, and that the
 *      helper + /knowledge/stats share the exact predicate. Enforcing in CI
 *      (where the server's runtime deps aren't installed).
 *   2. Behavioral — boot the real server against a fixture catalog mixing
 *      approved / legacy-no-status / pending_review / rejected / retracted
 *      learnings and assert the three endpoints agree. Self-skips (loudly)
 *      when hono isn't resolvable or port 3000 is contended.
 *
 * DR-5 (2026-07-20, PUNCH-LIST §31): GET /health reported catalog_size:
 * skills.length — the static 27-item skills.json capability catalog — while
 * GET /knowledge/stats reported learnings_count: ~103 from the SAME-LOOKING
 * field name via visibleLearningsList(). public/status.html renders /health's
 * raw JSON on-page, so a visitor could see two disagreeing "catalog" numbers
 * on the same site — same class as the 2026-06-12 inflated-stats blocker,
 * just a different root cause (a genuinely different data source, not a
 * missing moderation filter). GET /api/info and GET /stats had the identical
 * ambiguous field. Fix: catalog_size is now reserved everywhere it appears to
 * mean the canonical visible-catalog count; the static skill catalog moved to
 * skills_catalog_size (+ skills_categories) under an honest name so /discover
 * and /skill/:id are unaffected.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf-8');

const PREDICATE = "l => !l.status || l.status === 'approved'";

function routeSlice(marker) {
  const start = SERVER_SRC.indexOf(marker);
  assert.notEqual(start, -1, `route marker not found: ${marker}`);
  // A route body ends where the next route/section is registered.
  const end = SERVER_SRC.indexOf('app.get(', start + marker.length);
  return SERVER_SRC.slice(start, end === -1 ? undefined : end);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Structural: the enforcing guard
// ─────────────────────────────────────────────────────────────────────────────
describe('structural: pricing analytics use the shared visibility predicate', () => {
  it('visibleCatalog() holds the canonical predicate exactly once; list helper and /knowledge/stats delegate', () => {
    // Wave-2b unification (Gate-A merge guidance): the predicate literal lives in
    // exactly ONE place — visibleCatalog(). Everything else must CALL a helper,
    // never inline the predicate (inline copies are the drift class CH-1 closed).
    const catalogHelper = routeSlice('function visibleCatalog()');
    assert.ok(catalogHelper.includes(PREDICATE), 'visibleCatalog must hold the canonical predicate');
    assert.equal(SERVER_SRC.split(PREDICATE).length - 1, 1,
      'the predicate literal must appear exactly once in server.js (inside visibleCatalog)');
    const listHelper = routeSlice('function visibleLearningsList()');
    assert.ok(listHelper.includes('return visibleCatalog()'),
      'visibleLearningsList must delegate to visibleCatalog');
    const stats = routeSlice("app.get('/knowledge/stats'");
    assert.ok(/visible(Catalog|LearningsList)\(\)/.test(stats),
      '/knowledge/stats must draw from the shared helper, not an inline predicate');
  });

  it('/pricing/categories iterates visibleLearningsList(), not the raw array', () => {
    const slice = routeSlice("app.get('/pricing/categories'");
    assert.ok(/visible(Catalog|LearningsList)\(\)/.test(slice),
      '/pricing/categories must draw from the shared visibility helper');
    assert.ok(!slice.includes('of learnings)'),
      '/pricing/categories must not iterate the raw learnings array — that leaks pending/rejected/retracted counts');
  });

  it('POST /discover knowledge_hint advertises the visible count, not the raw length', () => {
    const i = SERVER_SRC.indexOf('knowledge_hint:');
    assert.notEqual(i, -1, 'knowledge_hint marker must exist');
    const slice = SERVER_SRC.slice(i, SERVER_SRC.indexOf('timestamp', i));
    assert.ok(slice.includes('visibleLearningsList().length'),
      'knowledge_hint must count visibleLearningsList()');
    assert.ok(!slice.includes('learnings.length'),
      'knowledge_hint must not read the raw learnings.length — that advertises pending/rejected/retracted counts');
  });

  it('/contributor/:wallet/pricing-insights filters from visibleLearningsList()', () => {
    const slice = routeSlice("app.get('/contributor/:wallet/pricing-insights'");
    assert.ok(/visible(Catalog|LearningsList)\(\)\.filter/.test(slice),
      'pricing-insights must draw from the shared visibility helper');
    assert.ok(!/\blearnings\.(filter|map|forEach)\(/.test(slice),
      'pricing-insights must not read the raw learnings array — top_earning_learnings would leak non-approved titles');
  });

  // CH-2 ruling (SPEC-3, 2026-07-19): learnings_submitted on the unauthenticated
  // GET /contributor/:wallet dashboard counts VISIBLE learnings — a raw count is
  // a per-wallet oracle for hidden (pending/rejected/retracted) submissions and
  // disagrees with the sibling /pricing-insights predicate. Anchored on the
  // field name so BOTH response branches (no-earnings and earnings) are pinned.
  it('learnings_submitted counts visibleLearningsList() in both branches of GET /contributor/:wallet', () => {
    const lines = SERVER_SRC.split('\n').filter((l) => l.includes('learnings_submitted:'));
    assert.equal(lines.length, 2,
      'expected learnings_submitted in exactly the two branches of GET /contributor/:wallet');
    for (const line of lines) {
      assert.ok(line.includes('visibleLearningsList().filter'),
        `learnings_submitted must count visibleLearningsList(), got: ${line.trim()}`);
      assert.ok(!/\blearnings\.filter\(/.test(line),
        `learnings_submitted must not count the raw learnings array — that reveals hidden submissions per wallet: ${line.trim()}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DR-5: /health, /api/info, /stats must report the canonical catalog_size
// ─────────────────────────────────────────────────────────────────────────────
describe('structural (DR-5): /health, /api/info, /stats report the canonical catalog_size', () => {
  it('/health.catalog_size uses visibleLearningsList(), not the raw skills catalog', () => {
    const slice = routeSlice("app.get('/health'");
    assert.ok(slice.includes('catalog_size: visibleLearningsList().length'),
      '/health.catalog_size must equal visibleLearningsList().length — same predicate as /knowledge/stats.learnings_count');
    assert.ok(!/(?<!skills_)catalog_size:\s*skills\.length/.test(slice),
      '/health.catalog_size must not read the raw skills.length (the static skill-discovery catalog)');
    assert.ok(slice.includes('skills_catalog_size: skills.length'),
      '/health must still expose the static skill-discovery catalog size, under an unambiguous name');
  });

  it('/api/info.catalog_size uses visibleLearningsList(), not the raw skills catalog', () => {
    const slice = routeSlice("app.get('/api/info'");
    assert.ok(slice.includes('catalog_size: visibleLearningsList().length'),
      '/api/info.catalog_size must equal visibleLearningsList().length');
    assert.ok(!/(?<!skills_)catalog_size:\s*skills\.length/.test(slice),
      '/api/info.catalog_size must not read the raw skills.length');
    assert.ok(slice.includes('skills_catalog_size: skills.length'),
      '/api/info must still expose the static skill-discovery catalog size, under an unambiguous name');
  });

  it('/stats.catalog_size uses visibleLearningsList(), not the raw skills catalog', () => {
    const slice = routeSlice("app.get('/stats'");
    assert.ok(/catalog_size:\s*visibleLearnings\.length/.test(slice) || slice.includes('catalog_size: visibleLearningsList().length'),
      '/stats.catalog_size must derive from visibleLearningsList()/visibleCatalog()');
    assert.ok(!/(?<!skills_)catalog_size:\s*skills\.length/.test(slice),
      '/stats.catalog_size must not read the raw skills.length');
    assert.ok(slice.includes('skills_catalog_size: skills.length'),
      '/stats must still expose the static skill-discovery catalog size, under an unambiguous name');
  });

  it('no public JSON route still reports catalog_size: skills.length', () => {
    // Historical bug shape, string form. Only the honest skills_catalog_size
    // alias may still read the raw skills array.
    assert.ok(!/(?<!skills_)catalog_size:\s*skills\.length/.test(SERVER_SRC),
      'catalog_size must never read the raw skills.length anywhere in server.js — use skills_catalog_size instead');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Behavioral: boot the real server against a mixed-status catalog
// ─────────────────────────────────────────────────────────────────────────────
const WALLET_MIXED = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_PENDING_ONLY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function fixtureCatalog() {
  // Clone a real seed record so every field migrations/scoring expect exists.
  const seed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  const mk = (over) => {
    const l = JSON.parse(JSON.stringify(base));
    delete l.status;
    delete l.pricing; // fixture prices live in unlock_price
    l.quality = { unlocks: 0, ratings: 0 };
    l.demand = { unlocks_30d: 0, search_impressions_30d: 0 };
    return Object.assign(l, over);
  };
  return [
    mk({ id: 'viz_a1', title: 'visible one', category: 'data-processing', status: 'approved', unlock_price: 0.10, contributor_wallet: WALLET_MIXED }),
    mk({ id: 'viz_a2', title: 'visible two', category: 'data-processing', status: 'approved', unlock_price: 0.30, contributor_wallet: WALLET_MIXED }),
    // Legacy record with no status field — treated as approved (backward-compat).
    mk({ id: 'viz_legacy', title: 'legacy visible', category: 'web-interaction', unlock_price: 0.50, contributor_wallet: WALLET_MIXED }),
    // Poison prices: if any of these leak into avg_price the assertions fail.
    mk({ id: 'hid_pending', title: 'SECRET pending title', category: 'data-processing', status: 'pending_review', unlock_price: 999, contributor_wallet: WALLET_PENDING_ONLY }),
    mk({ id: 'hid_rejected', title: 'SECRET rejected title', category: 'web-interaction', status: 'rejected', unlock_price: 999, contributor_wallet: WALLET_MIXED }),
    // Sole occupant of its category: the category itself must not appear.
    mk({ id: 'hid_retracted', title: 'SECRET retracted title', category: 'payment-financial', status: 'retracted', unlock_price: 999, contributor_wallet: WALLET_MIXED }),
  ];
}

function bootServer(tmpDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: tmpDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // dummy key so the boot survives the WALLET_PRIVATE_KEY gate
        WALLET_PRIVATE_KEY: '0x' + '11'.repeat(32),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => settle({ child, out, up: false }), 20_000);
    const onData = (buf) => {
      out += buf.toString();
      if (out.includes('Auxilo running at')) settle({ child, out, up: true });
      if (out.includes('EADDRINUSE') || out.includes('UNCAUGHT EXCEPTION')) settle({ child, out, up: false });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => settle({ child, out, up: false }));
  });
}

describe('behavioral: the three public endpoints agree on visibility', () => {
  it('stats, categories, and pricing-insights all exclude non-approved learnings', { timeout: 90_000 }, async (t) => {
    // Resolve the ACTUAL node_modules dir hono lives in — in a git worktree the
    // repo root has no node_modules and resolution walks up to the main checkout,
    // so symlinking REPO_ROOT/node_modules would stage a dead link.
    let nodeModulesDir;
    try {
      const honoEntry = require.resolve('hono', { paths: [REPO_ROOT] });
      nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    } catch {
      t.skip('hono not resolvable from repo root — skipping real boot (structural guard still enforces the predicate)');
      return;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-pricingviz-'));
    let child = null;
    try {
      for (const f of ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json']) {
        const src = path.join(REPO_ROOT, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmpDir, f));
      }
      // The rotation-invariant gate refuses to boot unless the advertised WALLET
      // const matches the WALLET_PRIVATE_KEY-derived address. We run the dummy
      // key 0x11…11, which derives 0x19E7…f2A, so point the STAGED COPY's const
      // at it — a config-only patch; the visibility logic under test is untouched.
      const staged = fs.readFileSync(path.join(tmpDir, 'server.js'), 'utf-8');
      const patched = staged.replace(/^const WALLET = '0x[0-9a-fA-F]{40}';$/m,
        "const WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';");
      assert.notEqual(patched, staged, 'expected exactly one WALLET const line to patch for the boot gate');
      fs.writeFileSync(path.join(tmpDir, 'server.js'), patched);
      for (const d of ['lib', 'public', 'prompts']) {
        const src = path.join(REPO_ROOT, d);
        if (fs.existsSync(src)) fs.symlinkSync(src, path.join(tmpDir, d));
      }
      fs.symlinkSync(nodeModulesDir, path.join(tmpDir, 'node_modules'));
      // Pre-populated data dir: non-empty catalog means no re-seeding (CS-1).
      fs.mkdirSync(path.join(tmpDir, 'data'));
      fs.writeFileSync(path.join(tmpDir, 'data', 'learnings.json'), JSON.stringify(fixtureCatalog(), null, 2));

      // The server listens on a hardcoded port 3000; another test file's boot
      // (cold-start-seed) can hold it briefly under the parallel runner. Retry.
      let boot = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        boot = await bootServer(tmpDir);
        if (boot.up) break;
        boot.child.kill('SIGKILL');
        if (!boot.out.includes('EADDRINUSE')) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
      child = boot.child;
      if (!boot.up) {
        t.skip(`server did not reach listen — skipping behavioral leg (structural guard still enforces the predicate). Output tail: ${boot.out.slice(-400)}`);
        return;
      }

      const get = async (p, expectStatus = 200) => {
        const res = await fetch(`http://127.0.0.1:3000${p}`);
        assert.equal(res.status, expectStatus, `GET ${p} → ${res.status}`);
        return res.json();
      };

      const stats = await get('/knowledge/stats');
      assert.equal(stats.learnings_count, 3, 'stats must count only the 3 visible learnings');

      // DR-5: /health, /api/info, and GET /stats must agree with
      // /knowledge/stats.learnings_count on catalog_size — the exact public
      // contradiction (27 vs 103) this fix closes. The static skill catalog
      // (skills.json, unrelated to this fixture) still surfaces, but under
      // skills_catalog_size so it can never be mistaken for the marketplace
      // catalog again.
      const health = await get('/health');
      assert.equal(health.catalog_size, stats.learnings_count,
        '/health.catalog_size must agree with /knowledge/stats.learnings_count');
      assert.equal(typeof health.skills_catalog_size, 'number');
      assert.ok(health.skills_catalog_size > 0, 'skills_catalog_size must still report the static skill catalog');

      const apiInfo = await get('/api/info');
      assert.equal(apiInfo.catalog_size, stats.learnings_count,
        '/api/info.catalog_size must agree with /knowledge/stats.learnings_count');
      assert.equal(typeof apiInfo.skills_catalog_size, 'number');

      const regStats = await get('/stats');
      assert.equal(regStats.catalog_size, stats.learnings_count,
        '/stats.catalog_size must agree with /knowledge/stats.learnings_count');
      assert.equal(typeof regStats.skills_catalog_size, 'number');

      const cats = await get('/pricing/categories');
      const byCat = Object.fromEntries(cats.categories.map((c) => [c.category, c]));

      // Totals agree with /knowledge/stats visibility.
      const catTotal = cats.categories.reduce((s, c) => s + c.learning_count, 0);
      assert.equal(catTotal, stats.learnings_count, 'category counts must sum to the stats learnings_count');
      assert.deepEqual(
        Object.keys(byCat).sort(), [...stats.categories].sort(),
        'category list must equal the stats categories');

      // The retracted-only category must not exist at all.
      assert.equal(byCat['payment-financial'], undefined, 'a category populated only by non-approved learnings must not appear');

      // Poison-price check: any leak of a 999-priced hidden learning breaks these.
      assert.equal(byCat['data-processing'].learning_count, 2);
      assert.equal(byCat['data-processing'].avg_price, 0.2, 'avg_price must exclude the pending learning');
      assert.equal(byCat['web-interaction'].learning_count, 1);
      assert.equal(byCat['web-interaction'].avg_price, 0.5, 'avg_price must exclude the rejected learning');

      // pricing-insights: visible-only counts, no hidden titles.
      const insights = await get(`/contributor/${WALLET_MIXED}/pricing-insights`);
      assert.equal(insights.total_learnings, 3, 'insights must count only visible learnings for the wallet');
      const titles = insights.top_earning_learnings.map((l) => l.title).join(' | ');
      assert.ok(!titles.includes('SECRET'), `non-approved titles leaked: ${titles}`);

      // A wallet whose only learnings are non-approved reads as not found —
      // same posture as GET /knowledge/:id for a non-approved id.
      await get(`/contributor/${WALLET_PENDING_ONLY}/pricing-insights`, 404);

      // CH-2: the earnings dashboard's learnings_submitted obeys the same
      // predicate (fixture has no earnings file, so this exercises the
      // no-earnings branch; the earnings branch is pinned structurally).
      const dash = await get(`/contributor/${WALLET_MIXED}`);
      assert.equal(dash.learnings_submitted, 3,
        'learnings_submitted must count only the wallet\'s visible learnings');
      const dashHidden = await get(`/contributor/${WALLET_PENDING_ONLY}`);
      assert.equal(dashHidden.learnings_submitted, 0,
        'a wallet with only non-approved submissions must read 0 — no hidden-submission oracle');
    } finally {
      if (child) child.kill('SIGKILL');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
