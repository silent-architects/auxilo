'use strict';

/**
 * test/hero-0927.test.js — HERO-0927: homepage headline (H-1) and lede (H-2)
 * replacement (BUILD-BRIEF-HERO.md, 2026-09-27).
 *
 * The owner rejected the live headline ("Redo"), was shown five finalists,
 * and ruled F1. The lede went through two rounds (a first draft was
 * withdrawn as "convoluted"; the ruled replacement below is final). Two
 * strings on public/index.html change; nothing else does.
 *
 *   H-1  h1#hero-heading   -> NEW_H1
 *   H-2  p.hero-sub        -> NEW_LEDE
 *
 * Every expected string lives in exactly one constant below (single point of
 * edit, per the coordinator's instruction while H-2 was still in flight).
 *
 * This suite:
 *   - asserts both strings render, read from the staged real server.js
 *     (matches the live template path, not a static-file read)
 *   - sweeps every tracked file under the brief's named surfaces
 *     (public/, .well-known/, server.js, lib/, openapi.json, README.md,
 *     docs/, test/, scripts/) for the old headline and every sentence of the
 *     old lede, with a positive control per absence check
 *   - H-10: the earnings-not-guaranteed sentence and a withdrawals-paused
 *     statement still present, unchanged
 *   - H-11: "AI" appears in exactly two homepage strings (the h1, the title)
 *   - H-13: the new headline's rendered line count and no single-word line,
 *     at 375/768/1280
 *   - H-14: the lede's CSS measure (.hero-sub max-width) at 1280 is
 *     unchanged (600px) — no layout rule was touched
 *   - H-15: no horizontal scroll at 375
 *
 * Runner: node --test test/hero-0927.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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
const THIS_FILE = path.relative(REPO, __filename).split(path.sep).join('/');
// test/launch-wave-fixes-frontend.test.js's D4/HERO-0927 describe block
// legitimately holds the old lede (and its sentences) as absence-check
// literals -- it asserts they are NOT in index.html, the same role THIS_FILE
// plays for itself. Holding the string to search for it is not the same as
// presenting it as content, so both are excluded from the sweep below.
const SELF_REFERENTIAL_FILES = new Set([THIS_FILE, 'test/launch-wave-fixes-frontend.test.js']);

// ─── H-1 ──────────────────────────────────────────────────────────────────
const OLD_H1 = 'You have watched your AI work out the same fix before.';
const NEW_H1 = 'Earn from the work your AI already does.';

// ─── H-2 (ruled 2026-09-27, second and final round) ────────────────────────
const NEW_LEDE = 'Your agent finds a fix. You approve it. You earn a share when another agent pays to unlock it.';
const OLD_LEDE = 'Next time, your agent can ask Auxilo instead. Signed in to your account, it gets the fix you published back for free. When another agent unlocks that fix, you earn a share.';
const OLD_LEDE_SENTENCES = [
  'Next time, your agent can ask Auxilo instead.',
  'Signed in to your account, it gets the fix you published back for free.',
  'When another agent unlocks that fix, you earn a share.',
];

// H-10
const EARNINGS_NOT_GUARANTEED = 'Earnings depend on whether other agents unlock your learnings and are not guaranteed.';

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

// Every tracked file under the brief's named search surfaces (mirrors
// BUILD-BRIEF-HERO.md's "Find every copy of the old strings" scope exactly),
// so this sweep can't miss a machine surface merely because nobody thought
// to hardcode its path. Excludes this file itself (which must legitimately
// hold the old strings as literals to search for them).
function namedSurfaceFiles() {
  const roots = ['public', '.well-known', 'server.js', 'lib', 'openapi.json', 'README.md', 'docs', 'test', 'scripts'];
  const out = execFileSync('git', ['ls-files', ...roots], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !SELF_REFERENTIAL_FILES.has(f));
  return out;
}

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff2', '.woff', '.ttf']);

function readTextFiles(files) {
  return files
    .filter((f) => !BINARY_EXT.has(path.extname(f)))
    .map((f) => ({ file: f, text: fs.readFileSync(path.join(REPO, f), 'utf8') }));
}

describe('HERO-0927 sweep: old headline and old lede appear in no named surface', () => {
  const files = readTextFiles(namedSurfaceFiles());

  it('sanity: the sweep actually enumerated files (not vacuously empty)', () => {
    assert.ok(files.length > 50, `expected a substantial file set, got ${files.length}`);
    assert.ok(files.some((f) => f.file === 'public/index.html'), 'public/index.html must be in the swept set');
  });

  it('positive control: a known-present string ("Auxilo") is found by the same scan (proves the detector matches real text)', () => {
    const hits = files.filter((f) => f.text.includes('Auxilo'));
    assert.ok(hits.length > 5, 'expected many files to mention "Auxilo"; the scan mechanism looks broken');
  });

  it('positive control: the new headline IS present on public/index.html (proves absence checks below are not vacuous)', () => {
    const idx = files.find((f) => f.file === 'public/index.html');
    assert.ok(idx, 'public/index.html must be in the swept set');
    assert.ok(idx.text.includes(NEW_H1), 'new headline must be present on public/index.html');
  });

  it('the old headline appears in no swept file', () => {
    const hits = files.filter((f) => f.text.includes(OLD_H1)).map((f) => f.file);
    assert.deepEqual(hits, [], `old headline must be gone; still found in: ${hits.join(', ')}`);
  });

  it('positive control: the new lede IS present on public/index.html', () => {
    const idx = files.find((f) => f.file === 'public/index.html');
    assert.ok(idx.text.includes(NEW_LEDE), 'new lede must be present on public/index.html');
  });

  it('the old full lede appears in no swept file', () => {
    const hits = files.filter((f) => f.text.includes(OLD_LEDE)).map((f) => f.file);
    assert.deepEqual(hits, [], `old lede must be gone; still found in: ${hits.join(', ')}`);
  });

  for (const sentence of OLD_LEDE_SENTENCES) {
    it(`the old lede's sentence "${sentence}" appears in no swept file`, () => {
      const hits = files.filter((f) => f.text.includes(sentence)).map((f) => f.file);
      assert.deepEqual(hits, [], `sentence must be gone; still found in: ${hits.join(', ')}`);
    });
  }
});

describe('HERO-0927: H-1/H-2 render from the staged server; H-10/H-11 checks', { timeout: 120_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let html;

  before(async () => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-hero-0927-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs', '.well-known'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'hero-0927-test-session-secret-0123456789ab',
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const res = await fetch(`${baseUrl}/`);
    html = await res.text();
  });

  after(async () => {
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('H-1: h1#hero-heading reads the new ruled headline, exactly once', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const m = html.match(/<h1 id="hero-heading">([\s\S]*?)<\/h1>/);
    assert.ok(m, 'hero-heading h1 found on the staged homepage');
    assert.equal(m[1], NEW_H1);
  });

  it('H-2: p.hero-sub reads the new ruled lede, exactly once', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const m = html.match(/<p class="hero-sub">([\s\S]*?)<\/p>/);
    assert.ok(m, 'hero-sub p found on the staged homepage');
    assert.equal(m[1], NEW_LEDE);
  });

  it('title tag, meta description, social tags, command block, its two notes, and "See How It Works" are untouched', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    assert.ok(html.includes('<title>Marketplace for what AI agents learn | Auxilo</title>'), 'title tag unchanged');
    assert.ok(html.includes('npx auxilo setup'), 'command block unchanged');
    assert.ok(html.includes('Setup is free and takes one command. Extraction stays off until you turn it on.'), 'setup note 1 unchanged');
    assert.ok(html.includes("Extraction reads your finished sessions on your machine, and anything it pulls out publishes only after you approve it."), 'setup note 2 unchanged');
    assert.ok(html.includes('<a href="/how-it-works" id="hero-cta-secondary" class="hero-cta-link">See How It Works</a>'), '"See How It Works" link unchanged');
  });

  it('H-10: the earnings-not-guaranteed sentence appears once, verbatim, unchanged', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const count = html.split(EARNINGS_NOT_GUARANTEED).length - 1;
    assert.equal(count, 1, `expected the exact sentence exactly once, found ${count}`);
  });

  it('H-10: a statement that withdrawals are paused is present', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    assert.ok(html.includes('withdrawals open soon'), 'withdrawals-paused statement present');
  });

  it('H-11: outside the standing FAQ-question carve-out (test/launch-wave-fixes-frontend.test.js D5), "AI" appears on the homepage in exactly two strings — the headline and the title tag', (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    let stripped = html
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ');
    // FAQ questions render as <span>QUESTION TEXT</span> directly inside a
    // <button class="faq-question">, a pre-existing standing carve-out (a
    // search-query mirror) this build does not touch or narrow — same
    // detection as test/launch-wave-fixes-frontend.test.js's D5 suite.
    const faqSpans = [...stripped.matchAll(/<button class="faq-question"[^>]*>\s*<span>([^<]*)<\/span>/g)].map((m) => m[0]);
    assert.ok(faqSpans.length > 0, 'sanity: at least one FAQ question span found on the homepage');
    for (const span of faqSpans) stripped = stripped.split(span).join(' ');
    // Pull out the two allowed carriers before scanning the rest.
    const titleMatch = stripped.match(/<title>[\s\S]*?<\/title>/);
    const h1Match = stripped.match(/<h1 id="hero-heading">[\s\S]*?<\/h1>/);
    assert.ok(titleMatch, 'title tag found');
    assert.ok(h1Match, 'hero-heading h1 found');
    assert.match(titleMatch[0], /\bAI\b/, 'positive control: title tag carries "AI"');
    assert.match(h1Match[0], /\bAI\b/, 'positive control: h1 carries "AI"');
    stripped = stripped.split(titleMatch[0]).join(' ').split(h1Match[0]).join(' ');
    const text = stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    assert.doesNotMatch(
      text,
      /\bAI\b/,
      `"AI" must appear nowhere else on the homepage (outside the FAQ-question carve-out); context: ${JSON.stringify((text.match(/.{0,60}\bAI\b.{0,60}/) || [''])[0])}`
    );
  });
});

describe('HERO-0927: H-13/H-14/H-15 rendered checks at 375/768/1280', { timeout: 120_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-hero-0927-render-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: ['lib', 'public', 'prompts', 'config', 'docs', '.well-known'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        LLM_SENSITIVITY_ENABLED: 'false',
        SESSION_SECRET: 'hero-0927-render-test-session-secret-01234',
      },
      timeoutMs: 60_000,
      maxAttempts: 4,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    playwrightOk = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function measureAt(width, height) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.addStyleTag({ content: '.reveal { opacity: 1 !important; transform: none !important; }' });
      const result = await page.evaluate(() => {
        const el = document.getElementById('hero-heading');
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const lines = [];
        let lastTop = null;
        let cur = '';
        let n;
        while ((n = walker.nextNode())) {
          const t = n.textContent;
          for (let i = 0; i < t.length; i++) {
            const rg = document.createRange();
            rg.setStart(n, i);
            rg.setEnd(n, i + 1);
            const rc = rg.getClientRects()[0];
            if (!rc) { cur += t[i]; continue; }
            const top = Math.round(rc.top);
            if (lastTop !== null && Math.abs(top - lastTop) > 4) {
              lines.push(cur.trim());
              cur = '';
            }
            lastTop = top;
            cur += t[i];
          }
        }
        if (cur.trim()) lines.push(cur.trim());
        const heroSub = document.querySelector('.hero-sub');
        const heroSubMaxWidth = heroSub ? getComputedStyle(heroSub).maxWidth : null;
        const heroCS = getComputedStyle(el);
        return {
          lines: lines.filter(Boolean),
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          heroSubMaxWidth,
          heroTextWrap: heroCS.textWrap || heroCS.getPropertyValue('text-wrap') || null,
          heroTextWrapStyle: heroCS.textWrapStyle || heroCS.getPropertyValue('text-wrap-style') || null,
        };
      });
      return result;
    } finally {
      await ctx.close();
    }
  }

  // R2-2 (coordinator, 2026-09-27): 1440 added alongside the brief's original
  // three widths after R2-1's text-wrap:balance change.
  const WIDTHS = [
    { w: 375, h: 812, maxLines: 3 },
    { w: 768, h: 1024, maxLines: 2 },
    { w: 1280, h: 800, maxLines: 2 },
    { w: 1440, h: 900, maxLines: 2 },
  ];

  for (const { w, h, maxLines } of WIDTHS) {
    it(`H-13: headline at ${w}px wraps to ${maxLines} lines or fewer, no single-word line`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const { lines } = await measureAt(w, h);
      console.log(`HERO-0927 H-13 headline lines at ${w}px:`, JSON.stringify(lines));
      assert.ok(lines.length >= 1, `${w}px: no rendered lines found for the headline`);
      assert.ok(lines.length <= maxLines, `${w}px: headline wrapped to ${lines.length} lines, expected <= ${maxLines}: ${JSON.stringify(lines)}`);
      for (const line of lines) {
        const words = line.trim().split(/\s+/).filter(Boolean);
        assert.ok(words.length !== 1, `${w}px: a line holds a single word ("${line}"): ${JSON.stringify(lines)}`);
      }
    });

    it(`H-15: no horizontal scroll at ${w}px`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const { scrollWidth, clientWidth } = await measureAt(w, h);
      assert.ok(scrollWidth <= clientWidth + 1, `${w}px: scrollWidth ${scrollWidth} > clientWidth ${clientWidth} (horizontal overflow)`);
    });
  }

  it('H-14: the lede\'s measure (.hero-sub max-width) at 1280 is unchanged (600px) — no layout rule was touched', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const { heroSubMaxWidth } = await measureAt(1280, 800);
    assert.equal(heroSubMaxWidth, '600px', `.hero-sub max-width should be unchanged at 600px, got ${heroSubMaxWidth}`);
  });

  // R2-3 (coordinator, 2026-09-27): the computed text-wrap of the headline is
  // balance. NOTE ON SCOPE, surfaced rather than hidden: four OTHER
  // homepage headings (#footer-cta-heading, #recall-heading, #how-heading,
  // #setup-detail-heading) already carried text-wrap:balance in the clean
  // starting commit (5b4fbf4), from an earlier, unrelated same-day fix pass
  // for their own single-word-orphan problems -- confirmed via
  // `git show 5b4fbf4:public/index.html`, not introduced by this build. "No
  // other heading on the homepage has it" is therefore not literally true of
  // the page as shipped; what IS true, and what this test asserts, is that
  // this build's own R2-1 change added the property to #hero-heading only
  // and to no other element -- the pre-existing four are read and reported,
  // not asserted absent, since removing them is out of this build's scope
  // (only #hero-heading is authorized to change).
  it('R2-3: #hero-heading computed text-wrap is balance; this build added it nowhere else', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      const result = await page.evaluate(() => {
        const el = document.getElementById('hero-heading');
        const cs = getComputedStyle(el);
        const heroValue = cs.textWrapStyle || cs.textWrap || cs.getPropertyValue('text-wrap-style') || cs.getPropertyValue('text-wrap');
        const others = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
          .filter((h) => h.id !== 'hero-heading')
          .map((h) => {
            const ocs = getComputedStyle(h);
            const v = ocs.textWrapStyle || ocs.textWrap || ocs.getPropertyValue('text-wrap-style') || ocs.getPropertyValue('text-wrap');
            return { id: h.id || null, tag: h.tagName, value: v };
          });
        return { heroValue, others };
      });
      assert.match(result.heroValue, /balance/, `#hero-heading computed text-wrap should be "balance", got ${JSON.stringify(result.heroValue)}`);
      const othersWithBalance = result.others.filter((o) => /balance/.test(o.value || ''));
      const knownPreExisting = new Set(['footer-cta-heading', 'recall-heading', 'how-heading', 'setup-detail-heading']);
      const unexpected = othersWithBalance.filter((o) => !knownPreExisting.has(o.id));
      console.log('R2-3 headings with computed text-wrap:balance other than #hero-heading:', JSON.stringify(othersWithBalance));
      assert.deepEqual(unexpected, [], `this build must not add text-wrap:balance to any heading besides #hero-heading; unexpected: ${JSON.stringify(unexpected)}`);
    } finally {
      await ctx.close();
    }
  });
});
