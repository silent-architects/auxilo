'use strict';

/**
 * test/trust-page.test.js — Trust page (/how-submissions-work): engineering
 * half of TRUST-PAGE-BUILD-SPEC-2026-09-02.md (rev 3g) / PUNCH-LIST
 * TRUST-PAGE + TRUST-REDIRECTS rows.
 *
 *   1. GET /how-submissions-work → 200 text/html containing the page <title>.
 *   2. Four redirects → 301 to /how-submissions-work: /trust, /governance,
 *      /for-platforms, /platforms.
 *   3. Head tags (title, description, canonical, og:*, twitter:*) present
 *      and byte-equal to the spec's SEO strings.
 *   4. h1 = the spec's h1 (`What stands between a submission and the public
 *      catalog`).
 *   5. The page never contains "Claude Code" as a requirement phrase —
 *      Tyler's ruling 2026-09-06 ("approved - build the trust page without
 *      the mention of a specific Claude Code requirement"). Asserted as: the
 *      literal string "Claude Code" does not appear anywhere in the served
 *      page at all (the strictest reading — the approved §2b/§3b copy names
 *      no client by name, so a clean page has zero occurrences).
 *   6. sitemap.xml lists the route; llms.txt carries the spec's Quick-start
 *      line.
 *   7. Structural: server.js registers the route and all four redirects.
 *
 * Staged-server pattern: test/ad-routes.test.js / test/clean-lane-phase-a2.test.js.
 *
 * Runner: node --test test/trust-page.test.js
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

const REPO = path.join(__dirname, '..');
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');
const LLMS_TXT = fs.readFileSync(path.join(REPO, 'public', 'llms.txt'), 'utf8');
const TRUST_HTML = fs.readFileSync(path.join(REPO, 'public', 'how-submissions-work.html'), 'utf8');

const TITLE = 'What Stands Between a Submission and the Public Catalog | Auxilo';
const DESCRIPTION = "Auxilo is a marketplace for what coding agents learn. What every new submission passes before it reaches the public catalog, what Auxilo does not claim, and where the catalog stands today.";
const CANONICAL = 'https://auxilo.io/how-submissions-work';
const H1 = 'What stands between a submission and the public catalog';
const LLMS_LINE = '- How submissions reach the catalog: https://auxilo.io/how-submissions-work';
const REDIRECT_SOURCES = ['/trust', '/governance', '/for-platforms', '/platforms'];

describe('Trust page: route, redirects, head tags, h1, forbidden strings', { timeout: 180_000 }, () => {
  let tmpDir;
  let child;
  let baseUrl;
  let bootSkipReason = null;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(
      0,
      honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length
    );
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      assert.equal(reservation.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-trust-page-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });

    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'trust-page-test-session-secret-0123456789',
        AUXILO_DATA_DIR: path.join(tmpDir, 'data'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      assert.equal(boot.skipReason, BOOT_SANDBOX_SKIP_REASON);
      bootSkipReason = BOOT_SANDBOX_SKIP_REASON;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /how-submissions-work → 200 text/html containing the page <title>', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/how-submissions-work`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes(`<title>${TITLE}</title>`), 'body carries the title tag');
  });

  for (const src of REDIRECT_SOURCES) {
    it(`GET ${src} → 301 to /how-submissions-work`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${src}`, { redirect: 'manual' });
      assert.equal(res.status, 301);
      assert.equal(res.headers.get('location'), '/how-submissions-work');
    });
  }

  it('head tags present and byte-equal to the spec strings', () => {
    assert.ok(TRUST_HTML.includes(`<title>${TITLE}</title>`), 'title');
    assert.ok(TRUST_HTML.includes(`<meta name="description" content="${DESCRIPTION}">`), 'description');
    assert.ok(TRUST_HTML.includes(`<link rel="canonical" href="${CANONICAL}" />`), 'canonical');
    assert.ok(TRUST_HTML.includes(`<meta property="og:type" content="website" />`), 'og:type');
    assert.ok(TRUST_HTML.includes(`<meta property="og:site_name" content="Auxilo" />`), 'og:site_name');
    assert.ok(TRUST_HTML.includes(`<meta property="og:url" content="${CANONICAL}" />`), 'og:url');
    assert.ok(TRUST_HTML.includes(`<meta property="og:title" content="${TITLE}" />`), 'og:title');
    assert.ok(TRUST_HTML.includes(`<meta property="og:description" content="${DESCRIPTION}" />`), 'og:description');
    assert.ok(TRUST_HTML.includes(`<meta property="og:image" content="https://auxilo.io/og-image.png" />`), 'og:image');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:card" content="summary_large_image" />`), 'twitter:card');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:title" content="${TITLE}" />`), 'twitter:title');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:description" content="${DESCRIPTION}" />`), 'twitter:description');
    assert.ok(TRUST_HTML.includes(`<meta name="twitter:image" content="https://auxilo.io/og-image.png" />`), 'twitter:image');
  });

  it('h1 = the spec\'s h1, and exactly one h1 on the page', () => {
    const h1Matches = TRUST_HTML.match(/<h1[^>]*>([\s\S]*?)<\/h1>/g) || [];
    assert.equal(h1Matches.length, 1, 'exactly one <h1>');
    assert.ok(h1Matches[0].includes(H1), `h1 reads "${H1}"`);
  });

  it('no "Claude Code" requirement phrase anywhere in the served page (Tyler\'s ruling 2026-09-06)', () => {
    assert.ok(!TRUST_HTML.includes('Claude Code'), 'the string "Claude Code" does not appear on the page');
  });

  it('sitemap.xml lists /how-submissions-work; llms.txt carries the spec\'s Quick-start line', () => {
    assert.ok(SITEMAP.includes(`<loc>${CANONICAL}</loc>`), 'sitemap has /how-submissions-work');
    assert.ok(LLMS_TXT.includes(LLMS_LINE), 'llms.txt carries the spec line verbatim');
  });

  it('structural: server.js registers the route and all four redirects', () => {
    assert.ok(SERVER_SRC.includes(`app.get('/how-submissions-work', (c) => {`), 'route handler present');
    for (const src of REDIRECT_SOURCES) {
      assert.ok(
        SERVER_SRC.includes(`app.get('${src}', (c) => c.redirect('/how-submissions-work', 301));`),
        `redirect handler present for ${src}`
      );
    }
  });

  it('§1b: the /status anchor is present in the withdrawals-sentence slot template', () => {
    const s1bStart = TRUST_HTML.indexOf('id="earnings-heading"');
    const s1bEnd = TRUST_HTML.indexOf('id="limits-heading"');
    assert.ok(s1bStart > 0 && s1bEnd > s1bStart, '§1b section located');
    const s1b = TRUST_HTML.slice(s1bStart, s1bEnd);
    assert.ok(
      /<a id="s1b-withdrawals-link" href="\/status">/.test(s1b),
      '§1b carries the /status anchor (precondition 2)'
    );
  });
});

// ─── TRUST-PAGE-SSR fixtures (module scope — CH-7 guard: no assert-bearing
// helper may be defined or called inside a describe() body) ────────────────
//
// §4's conditional accountability block and §7's live catalog count, spec
// rev 3g findings 5/13, preconditions 3/6/7/8/11. Same fixture-catalog +
// controllable-ledger staged-server pattern as test/earnings-ssr-truth.test.js
// (whose withStagedServer is likewise module-scope, not describe-scope).

// The staged-server harness rewrites the WALLET const to this fixed
// test-derived address (helpers/staged-server.js WALLET_STAGED, matching
// the boot's WALLET_PRIVATE_KEY) — NOT the literal in server.js source.
// Using the source literal here would make a legitimately-platform row
// read as external under test.
const TP_PLATFORM_WALLET = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A';
const TP_EXTERNAL_WALLET = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf02';
const TP_EXTERNAL_ACCOUNT = 'acc_trust_ext_1';

function tpSeedBase() {
  const seed = JSON.parse(fs.readFileSync(path.join(REPO, 'seed-knowledge.json'), 'utf-8'));
  const base = Array.isArray(seed) ? seed[0] : seed.learnings[0];
  assert.ok(base, 'seed-knowledge.json must contain at least one learning');
  return base;
}

function tpRow(overrides) {
  const l = JSON.parse(JSON.stringify(tpSeedBase()));
  l.status = 'approved';
  delete l.visibility;
  l.contributor_account_id = null;
  l.contributor_wallet = null;
  l.quality = { ...(l.quality || {}), unlocks: 0, ratings: 0, avg_helpfulness: 0 };
  return Object.assign(l, overrides);
}

// ALL-INTERNAL catalog: one null/null (platform default) row plus one row
// explicitly on the platform wallet — both must resolve internal, so §4's
// partition state is "a" (no outside builder has published).
function tpAllInternalCatalog() {
  return [
    tpRow({ id: 'tp_int_a', title: 'internal a', category: 'code-execution' }),
    tpRow({ id: 'tp_int_b', title: 'internal b', category: 'code-execution', contributor_wallet: TP_PLATFORM_WALLET }),
  ];
}

// Adds one row with an unregistered external account id and an unregistered
// external wallet — neither isPlatformContributor nor the (empty, this
// build) operator register recognizes it, so it must resolve external and
// flip §4 to state "b".
function tpWithExternalCatalog() {
  return [
    ...tpAllInternalCatalog(),
    tpRow({ id: 'tp_ext_1', title: 'external', category: 'web-interaction',
      contributor_account_id: TP_EXTERNAL_ACCOUNT, contributor_wallet: TP_EXTERNAL_WALLET }),
  ];
}

function tpLedgerLine(id, learning_id) {
  return JSON.stringify({
    id, ts: '2026-09-06T00:00:00.000Z', learning_id, amount_paid_usd: 0.05,
    funding_source: 'credit_pack', contributor_account_id: null, contributor_wallet: null, settled_onchain: false,
  });
}

function tpPartitionState(html) {
  const m = html.match(/id="s4-partition-state" data-partition-state="([^"]*)"/);
  assert.ok(m, 's4-partition-state marker present in the served HTML');
  return m[1];
}
function tpCell(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
  assert.ok(m, `${id} cell present`);
  return m[1];
}

async function withTrustPageStagedServer(t, { catalog, ledger }, body) {
  let nodeModulesDir;
  try {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
  } catch {
    t.skip('hono not resolvable from repo root — skipping real boot');
    return;
  }
  const reservation = await reservePort();
  if (reservation.skipReason) { t.skip(reservation.skipReason); return; }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-trust-page-ssr-'));
  let child = null;
  try {
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port: reservation.port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const dataDir = path.join(tmpDir, 'data');
    fs.writeFileSync(path.join(dataDir, 'learnings.json'), JSON.stringify(catalog, null, 2));
    fs.writeFileSync(path.join(dataDir, 'earnings.json'), JSON.stringify({}, null, 2));
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({}, null, 2));
    const ledgerPath = path.join(dataDir, 'unlock-events.jsonl');
    if (ledger === 'unreadable') fs.mkdirSync(ledgerPath); // EISDIR on read — not ENOENT
    else fs.writeFileSync(ledgerPath, ledger || '');

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
    const pageRes = await fetch(`${boot.baseUrl}/how-submissions-work`);
    assert.equal(pageRes.status, 200);
    assert.match(pageRes.headers.get('content-type') || '', /text\/html/);
    const html = await pageRes.text();
    const statsRes = await fetch(`${boot.baseUrl}/knowledge/stats`);
    assert.equal(statsRes.status, 200);
    await body(html, pageRes, await statsRes.json(), boot);
  } finally {
    if (child) await stopServer(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('TRUST-PAGE-SSR: §4 partition render + §7 live counts + no-store', { timeout: 300_000 }, () => {
  it('§4: all-internal catalog (null/null row + platform-wallet row) → data-partition-state="a"', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionState(html), 'a', 'state a when the external count is zero');
    });
  });

  it('§4: catalog with one unregistered external row → data-partition-state="b"', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      assert.equal(tpPartitionState(html), 'b', 'state b once an external contributor is present');
    });
  });

  it('§4: the served page never carries both branch states — the marker is a single attribute value', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpWithExternalCatalog(), ledger: '' }, async (html) => {
      const matches = html.match(/data-partition-state="[^"]*"/g) || [];
      assert.equal(matches.length, 1, 'exactly one data-partition-state marker on the page');
    });
  });

  it('§7: counts are SSR\'d and equal GET /knowledge/stats (catalogStatsTruth)', { timeout: 240_000 }, async (t) => {
    const twoRowLedger = [tpLedgerLine('wal_tp_1', 'tp_int_a'), tpLedgerLine('wal_tp_2', 'tp_int_b')].join('\n') + '\n';
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: twoRowLedger }, async (html, _res, stats) => {
      assert.equal(tpCell(html, 's7-learnings-count'), String(stats.learnings_count), 'learnings count matches /knowledge/stats');
      assert.equal(tpCell(html, 's7-unlocks-count'), String(stats.total_unlocks), 'unlocks count matches /knowledge/stats (catalogStatsTruth)');
      assert.equal(stats.total_unlocks, 2);
    });
  });

  it('§7: unreadable ledger → unlocks cell keeps the static "…" placeholder (fail-closed), learnings count still renders', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: 'unreadable' }, async (html, _res, stats) => {
      assert.equal(tpCell(html, 's7-unlocks-count'), '…', 'fail-closed placeholder, never a digit');
      assert.equal(Object.hasOwn(stats, 'total_unlocks'), false, 'stats also omits total_unlocks — one derivation, one failure mode');
      assert.equal(tpCell(html, 's7-learnings-count'), String(stats.learnings_count), 'learnings count is unaffected by the ledger failure');
    });
  });

  it('GET /how-submissions-work sends Cache-Control: no-store', { timeout: 240_000 }, async (t) => {
    await withTrustPageStagedServer(t, { catalog: tpAllInternalCatalog(), ledger: '' }, async (_html, res) => {
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });
  });
});
