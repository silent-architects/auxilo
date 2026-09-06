'use strict';

/**
 * test/seo-baseline.test.js — SEO baseline (markup half), per
 * ~/.auxilo/handoffs/SEO-BASELINE-2026-09-06.md:
 *
 *   1. GET /terms  → 200, carries exactly one <link rel="canonical"> and an
 *      og:url matching the request path (https://auxilo.io/terms).
 *   2. GET /privacy → 200, carries exactly one <link rel="canonical"> and an
 *      og:url matching the request path (https://auxilo.io/privacy).
 *   3. public/sitemap.xml lists /status and /legal/supported-clients.
 *   4. public/sitemap.xml carries no <lastmod> anywhere (dropped per the
 *      baseline's "automated or dropped" ruling — this build drops).
 *
 * /earnings was HELD by the baseline at the time this suite was written (no
 * 301, no sitemap/nav removal) — it has since been retired under AD strings
 * packet 15 rev 3a (folded into /pricing, v97 assembly, 2026-09-06); this
 * suite still makes no assertion about it and earnings.html is gone.
 *
 * Wave E1 (AD-STRINGS-PACKET-10-SEO-FINAL-2026-09-06) adds:
 *   5. No meta description on any tracked public/*.html page contains a colon.
 *   6. og:site_name = "Auxilo", exactly once, on every tracked public/*.html page.
 *   7. /api's og:description and twitter:description equal its meta description.
 *   8. GET /legal/supported-clients → 200, full head (one canonical, one
 *      description, og/twitter title+description+image, twitter:card
 *      summary_large_image), title/og:title/twitter:title "Supported clients |
 *      Auxilo", h1 "Supported clients" (no em dash).
 *   9. GET /terms and /privacy still 200, title unchanged, now carry exactly
 *      one og:site_name = "Auxilo" each.
 *
 * Staged-server pattern: test/ad-routes.test.js.
 *
 * Runner: node --test test/seo-baseline.test.js
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
const SITEMAP = fs.readFileSync(path.join(REPO, 'public', 'sitemap.xml'), 'utf8');

function canonicalLinks(html) {
  return html.match(/<link rel="canonical"[^>]*>/g) || [];
}

function metaContent(html, property) {
  const re = new RegExp(
    `<meta (?:property|name)="${property}" content="([^"]*)"`
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

function countMeta(html, property) {
  const re = new RegExp(`<meta (?:property|name)="${property}" content="[^"]*"`, 'g');
  return (html.match(re) || []).length;
}

// AD-STRINGS-PACKET-10-SEO-FINAL-2026-09-06: every tracked public page's meta
// description, checked statically (no server needed). Excludes public/dashboard.html
// (noindex/nofollow, carries no description or any og: tags at all — out of the
// packet's og:site_name/description scope, see wave-e1 build report).
const TRACKED_HTML_PAGES = [
  'about.html', 'api.html', 'for-agents.html', 'for-builders.html',
  'how-it-works.html', 'index.html', 'pricing.html', 'status.html',
  'writing-agents-message-board.html', path.join('writing', 'index.html'),
];

describe('SEO baseline (markup): /terms + /privacy canonical/og, sitemap /status + /legal/supported-clients, lastmod dropped', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-seo-baseline-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
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
        SESSION_SECRET: 'seo-baseline-test-session-secret-0123456789',
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

  it('GET /terms → 200, exactly one canonical, og:url matches request path', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/terms`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const canonicals = canonicalLinks(body);
    assert.equal(canonicals.length, 1, `exactly one canonical, found ${canonicals.length}`);
    assert.ok(canonicals[0].includes('href="https://auxilo.io/terms"'), canonicals[0]);
    assert.equal(metaContent(body, 'og:url'), 'https://auxilo.io/terms');
    assert.equal(metaContent(body, 'og:type'), 'website');
    assert.equal(metaContent(body, 'twitter:card'), 'summary');
  });

  it('GET /privacy → 200, exactly one canonical, og:url matches request path', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/privacy`);
    assert.equal(res.status, 200);
    const body = await res.text();
    const canonicals = canonicalLinks(body);
    assert.equal(canonicals.length, 1, `exactly one canonical, found ${canonicals.length}`);
    assert.ok(canonicals[0].includes('href="https://auxilo.io/privacy"'), canonicals[0]);
    assert.equal(metaContent(body, 'og:url'), 'https://auxilo.io/privacy');
    assert.equal(metaContent(body, 'og:type'), 'website');
    assert.equal(metaContent(body, 'twitter:card'), 'summary');
  });

  it('public/sitemap.xml lists /status and /legal/supported-clients', () => {
    assert.ok(SITEMAP.includes('<loc>https://auxilo.io/status</loc>'), 'sitemap has /status');
    assert.ok(
      SITEMAP.includes('<loc>https://auxilo.io/legal/supported-clients</loc>'),
      'sitemap has /legal/supported-clients'
    );
  });

  it('public/sitemap.xml carries no <lastmod> anywhere (dropped, not automated, per this build)', () => {
    assert.ok(!/<lastmod>/.test(SITEMAP), 'no <lastmod> tag present in sitemap.xml');
  });

  // ─── AD-STRINGS-PACKET-10-SEO-FINAL-2026-09-06 (wave E1) ──────────────────

  it('no meta description on any tracked public/*.html page contains a colon', () => {
    for (const rel of TRACKED_HTML_PAGES) {
      const html = fs.readFileSync(path.join(REPO, 'public', rel), 'utf8');
      const desc = metaContent(html, 'description');
      assert.ok(desc, `${rel} has a meta description`);
      assert.ok(!desc.includes(':'), `${rel} description has no colon: "${desc}"`);
    }
  });

  it('og:site_name = 1 on every tracked public/*.html page', () => {
    for (const rel of TRACKED_HTML_PAGES) {
      const html = fs.readFileSync(path.join(REPO, 'public', rel), 'utf8');
      assert.equal(countMeta(html, 'og:site_name'), 1, `${rel} has exactly one og:site_name`);
      assert.ok(html.includes('<meta property="og:site_name" content="Auxilo" />'), `${rel} og:site_name is "Auxilo"`);
    }
  });

  it('/api og:description and twitter:description equal the meta description', () => {
    const html = fs.readFileSync(path.join(REPO, 'public', 'api.html'), 'utf8');
    const desc = metaContent(html, 'description');
    assert.ok(desc, 'api.html has a meta description');
    assert.equal(metaContent(html, 'og:description'), desc);
    assert.equal(metaContent(html, 'twitter:description'), desc);
  });

  it('GET /legal/supported-clients → 200, full head (one canonical, one description, og/twitter set)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/legal/supported-clients`);
    assert.equal(res.status, 200);
    const body = await res.text();

    const canonicals = canonicalLinks(body);
    assert.equal(canonicals.length, 1, `exactly one canonical, found ${canonicals.length}`);
    assert.ok(canonicals[0].includes('href="https://auxilo.io/legal/supported-clients"'), canonicals[0]);

    assert.equal(countMeta(body, 'description'), 1);
    const desc = metaContent(body, 'description');
    assert.ok(!desc.includes(':'), `description has no colon: "${desc}"`);
    assert.equal(
      desc,
      'Which coding clients the local runner can capture learnings from once you opt in, by tier, with the caveat for each.'
    );

    assert.equal(metaContent(body, 'og:type'), 'website');
    assert.equal(countMeta(body, 'og:site_name'), 1);
    assert.equal(metaContent(body, 'og:site_name'), 'Auxilo');
    assert.equal(metaContent(body, 'og:url'), 'https://auxilo.io/legal/supported-clients');
    assert.equal(metaContent(body, 'og:title'), 'Supported clients | Auxilo');
    assert.equal(metaContent(body, 'og:description'), desc);
    assert.ok(body.includes('<meta property="og:image" content="https://auxilo.io/og-image.png"/>'));

    assert.equal(metaContent(body, 'twitter:card'), 'summary_large_image');
    assert.equal(metaContent(body, 'twitter:title'), 'Supported clients | Auxilo');
    assert.equal(metaContent(body, 'twitter:description'), desc);
    assert.ok(body.includes('<meta name="twitter:image" content="https://auxilo.io/og-image.png"/>'));

    assert.ok(body.includes('<title>Supported clients | Auxilo</title>'), 'title tag');
    assert.ok(/<h1>Supported clients<\/h1>/.test(body), 'h1 is "Supported clients", no em dash');
  });

  it('GET /terms and /privacy still 200, unchanged title, now carry exactly one og:site_name = Auxilo', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const termsRes = await fetch(`${baseUrl}/terms`);
    assert.equal(termsRes.status, 200);
    const termsBody = await termsRes.text();
    assert.ok(termsBody.includes('<title>Terms of Service | Auxilo</title>'), 'terms title unchanged');
    assert.equal(countMeta(termsBody, 'og:site_name'), 1);
    assert.equal(metaContent(termsBody, 'og:site_name'), 'Auxilo');

    const privacyRes = await fetch(`${baseUrl}/privacy`);
    assert.equal(privacyRes.status, 200);
    const privacyBody = await privacyRes.text();
    assert.ok(privacyBody.includes('<title>Privacy Policy | Auxilo</title>'), 'privacy title unchanged');
    assert.equal(countMeta(privacyBody, 'og:site_name'), 1);
    assert.equal(metaContent(privacyBody, 'og:site_name'), 'Auxilo');
  });
});

// ─── AD-STRINGS-PACKET-12 rev 3a (hero wave, 2026-09-06): H1 B + sub B + the
// "what a learning is" block + Tyler's title variant. Static file checks
// only, no server boot — matches the packet's own §7 post-deploy checks.
describe('Hero wave (AD-STRINGS-PACKET-12 rev 3a): H1 B, title/og/twitter, meta description, recall account condition, "your AI" scarcity', () => {
  const INDEX_HTML = fs.readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  const HERO_TITLE = 'Marketplace for what AI agents learn | Auxilo';
  const HERO_DESC =
    'Auxilo is a marketplace for what agents learn. Agents search free and pay to unlock what other agents already figured out rather than solve it twice.';
  const HERO_H1 = 'You have watched your AI work out the same fix before.';

  // All public/**/*.html files actually shipped (excludes node_modules).
  function allPublicHtmlFiles() {
    const out = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.html')) out.push(full);
      }
    })(path.join(REPO, 'public'));
    return out;
  }

  it('title, og:title, twitter:title on index.html equal Tyler\'s ruled variant', () => {
    assert.ok(INDEX_HTML.includes(`<title>${HERO_TITLE}</title>`), 'title tag');
    assert.equal(metaContent(INDEX_HTML, 'og:title'), HERO_TITLE);
    assert.equal(metaContent(INDEX_HTML, 'twitter:title'), HERO_TITLE);
  });

  it('meta description on index.html is verbatim (and og:description/twitter:description match it)', () => {
    assert.equal(metaContent(INDEX_HTML, 'description'), HERO_DESC);
    assert.equal(metaContent(INDEX_HTML, 'og:description'), HERO_DESC);
    assert.equal(metaContent(INDEX_HTML, 'twitter:description'), HERO_DESC);
  });

  it('H1 = candidate B, ending in a period (not Title Case)', () => {
    const m = INDEX_HTML.match(/<h1 id="hero-heading">([\s\S]*?)<\/h1>/);
    assert.ok(m, 'hero-heading H1 found');
    assert.equal(m[1], HERO_H1);
    assert.ok(HERO_H1.endsWith('.'), 'H1 ends in a period');
  });

  it('#hero-heading contains no "remembers" (packet §7.1)', () => {
    const m = INDEX_HTML.match(/<h1 id="hero-heading">([\s\S]*?)<\/h1>/);
    assert.ok(m);
    assert.ok(!/remembers/i.test(m[1]), 'no "remembers" in the H1');
  });

  it('hero sub carries "asks Auxilo", "signed in to your account", "the answer you published"; the new block carries "ask Auxilo" (packet §7.2)', () => {
    const subMatch = INDEX_HTML.match(/<p class="hero-sub">([\s\S]*?)<\/p>/);
    assert.ok(subMatch, 'hero-sub paragraph found');
    const sub = subMatch[1];
    assert.ok(sub.includes('asks Auxilo'), 'sub has "asks Auxilo"');
    assert.ok(sub.includes('signed in to your account'), 'sub has the account condition');
    assert.ok(sub.includes('the answer you published'), 'sub has "the answer you published"');

    const blockMatch = INDEX_HTML.match(/<h2 id="learning-explainer-heading">[\s\S]*?<\/section>/);
    assert.ok(blockMatch, 'learning-explainer block found');
    assert.ok(blockMatch[0].includes('ask Auxilo'), 'new block has "ask Auxilo"');
  });

  it('fixed-string "your AI" (case-insensitive) across every served public/**/*.html page returns exactly 1, inside #hero-heading (packet §7.3)', () => {
    const files = allPublicHtmlFiles();
    let total = 0;
    let hits = [];
    for (const file of files) {
      const html = fs.readFileSync(file, 'utf8');
      const matches = html.match(/your ai/gi) || [];
      total += matches.length;
      if (matches.length) hits.push(path.relative(REPO, file));
    }
    assert.equal(total, 1, `"your AI" should appear exactly once across public/**/*.html, found ${total} in ${hits.join(', ')}`);
    const m = INDEX_HTML.match(/<h1 id="hero-heading">([\s\S]*?)<\/h1>/);
    assert.ok(m && /your ai/i.test(m[1]), 'the one "your AI" occurrence is inside #hero-heading');
  });

  it('the single-player recall paragraph carries the account condition (packet §7.4, "index:394")', () => {
    assert.ok(
      INDEX_HTML.includes(
        'When your agent asks Auxilo the same question in a later session, signed in to your account, the answer you published comes back at no cost.'
      ),
      'recall paragraph carries "signed in to your account"'
    );
  });

  it('the new "what a learning is" h2 has no eyebrow immediately above it and no inline size override (section h2 size, packet §7.5)', () => {
    const sectionMatch = INDEX_HTML.match(
      /<section id="learning-explainer"[\s\S]*?<\/section>/
    );
    assert.ok(sectionMatch, 'learning-explainer section found');
    const section = sectionMatch[0];
    assert.ok(!/class="[^"]*eyebrow[^"]*"/.test(section), 'no eyebrow-classed element in the section');
    const h2Match = section.match(/<h2[^>]*>/);
    assert.ok(h2Match, 'h2 found');
    assert.ok(!/style=/.test(h2Match[0]), 'h2 carries no inline style (uses the default section h2 size)');
    assert.ok(
      section.includes('<h2 id="learning-explainer-heading">What a learning is, and why another agent would use it</h2>'),
      'h2 text verbatim'
    );
  });

  it('bullet 351 (packet 11): hero-trust bullet reads "every Auxilo tool still works"', () => {
    assert.ok(
      INDEX_HTML.includes('Extraction defaults to off. Decline it and every Auxilo tool still works.'),
      'naming-sweep fix for the hero-trust bullet is applied'
    );
  });

  it('step 01 already reads "On the clients that support capture"', () => {
    assert.ok(
      INDEX_HTML.includes('On the clients that support capture it can also extract learnings in the background'),
      'step 01 capture-clients line present'
    );
  });

  it('the footer signature still carries the retired H1 line (packet: "it stays as the footer line")', () => {
    const count = (INDEX_HTML.match(/Your agent already solved this\. Auxilo remembers\./g) || []).length;
    assert.equal(count, 1, 'retired H1 line survives exactly once, in the footer');
  });
});
