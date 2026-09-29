'use strict';

/**
 * test/mobile-header-offset.test.js — MOBILE-HEADER-OFFSET regression
 * (PUNCH-LIST, SITE-PM v102 find, TECH-PM fix -> v103).
 *
 * #main-nav is `position: fixed` at every width (public/styles.css). At
 * v101 a sign-in strip (.nav-strip) was added above the existing nav row,
 * growing the header's rendered height, but the first section's mobile
 * top-offset on `/` and `/pricing` (and, once every tracked page was swept
 * rather than just the two the original defect report named, also /about,
 * /connect, /works-with, and /writing/index) was never re-derived from the
 * new header height -- their h1 rendered partly underneath the fixed bar.
 *
 * Fix (public/styles.css): a single source-of-truth custom property,
 * `--header-h`, derived from #main-nav's own declared box values (nav-row
 * padding + content min-height, nav-strip's explicit height, the border)
 * plus a documented buffer covering the gap between that declared-box sum
 * and live-Chrome's rendered height (see the --header-h comment in
 * styles.css for the full derivation) and the required 8px minimum
 * clearance. `--hero-pad-mobile` (already the shared mobile hero-padding
 * token for six pages: api/for-agents/for-builders/how-it-works/pricing/
 * status) now derives its top value from --header-h instead of a bare
 * 100px. index.html's `.hero-content` and the four pages whose first
 * section is a plain `main`/`.ww-main` wrapper (about/connect/writing-index/
 * works-with) each pick up a new `@media (max-width: 900px)` padding-top
 * rule referencing the same token — see each file's own MOBILE-HEADER-OFFSET
 * comment for why 900px (the nav's own hamburger breakpoint) rather than
 * the narrower phone-only breakpoints those pages already had.
 * `html { scroll-padding-top: var(--header-h); }` (same 900px query, added
 * to styles.css) keeps in-page anchor jumps clear of the header too.
 * /terms, /how-submissions-work, and writing-agents-message-board.html were
 * measured and already clear (unconditional padding well past the
 * threshold) -- left untouched, verified below rather than assumed.
 *
 * This suite runs two tiers:
 *
 *   Tier 1 (static server over public/, no server.js): every page from
 *   `git ls-files public/` that isn't served through server.js templating,
 *   at 375/390/430/768px -- the invariant this fix exists to hold: the
 *   first visible <h1>'s top edge is at or below the fixed header's own
 *   bottom edge plus an 8px minimum gap. Also asserts no horizontal
 *   overflow at any of those widths, and that 1440px is unchanged from the
 *   pre-fix value (a hardcoded expectation per page, so a future edit that
 *   silently changes desktop hero spacing fails loudly here).
 *
 *   Tier 2 (staged real server.js, test/helpers/staged-server.js): the two
 *   routes the static tier can't serve faithfully -- /terms (server-
 *   rendered markdown, serveLegalPage) and /how-submissions-work (server-
 *   templated). Same clearance invariant, plus a live anchor-jump check on
 *   /terms confirming scroll-padding-top actually lands the target below
 *   the fixed header.
 *
 * Both tiers skip gracefully (t.skip()) if playwright is not resolvable,
 * same convention as tests/test-mobile-nav-overlay.js and
 * test/sheet9-fixups.test.js. Tier 2 additionally skips if the sandbox
 * denies a loopback bind (BOOT_SANDBOX_SKIP_REASON).
 *
 * Runner: node --test test/mobile-header-offset.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

// google<hex>.html (e.g. public/google319f7b1ffb42b07d.html, cc04063) is a
// Google Search Console verification token: a bare one-line file with no
// <html>, no nav, no h1 — it is not a "page" this suite's header-clearance
// invariant applies to. Excluded by an explicit, documented name pattern
// (not a one-off hardcoded skip) so any future verification-token file
// (Bing, etc.) added the same way is excluded the same way. Real pages are
// never named this way, so the pattern can't accidentally swallow one.
const GSC_VERIFICATION_FILE_RE = /^google[0-9a-f]+\.html$/;

function gitTrackedPublicHtmlFiles() {
  const out = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO, encoding: 'utf8' });
  return out
    .split('\n')
    .filter((f) => f.endsWith('.html'))
    .filter((f) => !GSC_VERIFICATION_FILE_RE.test(path.basename(f)))
    .sort();
}

// Enumerated from git, not hand-typed, so a page added or removed from
// public/ can't silently fall out of this suite's coverage.
const ALL_PUBLIC_HTML = gitTrackedPublicHtmlFiles();

const WIDTHS = [375, 390, 430, 768];
const MIN_CLEARANCE = 8;

// SPACING-0927 Round 3 (FIX-UNIT-SPACING-3.md M-5): this used to be a
// per-page table of literal pixel numbers (219 on twelve pages, 208.8,
// 177.4, 48 on the other three) asserted against h1.top -- a rendered
// position, which CI (Linux) can draw a pixel differently than this
// machine does. No pin here may depend on how text is drawn; a position
// is compared against another measurement taken in the same run instead.
// Two cases, both resolved with a live sibling/ancestor measurement rather
// than a literal number: if h1 has a preceding visible sibling (e.g.
// dashboard's .login-logo, or a legal/writing page's "back" link that sits
// outside h1's own wrapper -- reached through that wrapper's own live
// rect.top, not by walking the DOM further), h1 sits right after that
// sibling's own bottom edge, margin-collapsed; otherwise h1 is the first
// visible thing in its parent, so it sits exactly at the parent's own
// content edge (the parent's own rect.top -- a live value that already
// bakes in everything above it -- plus the parent's own padding-top/
// border-top). Comparing the two live, in the same run, proves the same
// invariant the old table asserted (h1 sits exactly where CSS box flow
// puts it, not shifted by a stray margin) without hard-coding what that
// position happens to equal on any one page.
function measureExpectedH1Top(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('h1');
    if (!h1) return null;
    function isVisible(node) {
      if (!(node instanceof Element)) return false;
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
      const r = node.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    const h1s = getComputedStyle(h1);
    const h1MarginTop = parseFloat(h1s.marginTop) || 0;
    const h1Top = h1.getBoundingClientRect().top;

    // A real preceding sibling (e.g. dashboard's .login-logo above its
    // h1) places h1 right after its own bottom edge, margin-collapsed --
    // not at the containing block's padding edge at all. Walk siblings
    // first; only fall through to the ancestor-padding case (below) when
    // h1 is effectively the first visible thing in its block.
    let sib = h1.previousElementSibling;
    while (sib && !isVisible(sib)) sib = sib.previousElementSibling;
    if (sib) {
      const sr = sib.getBoundingClientRect();
      const sibMarginBottom = parseFloat(getComputedStyle(sib).marginBottom) || 0;
      return {
        h1Top,
        h1MarginTop,
        expected: sr.bottom + Math.max(sibMarginBottom, h1MarginTop),
        ancestorSelector: 'preceding sibling ' + sib.tagName.toLowerCase() + (sib.className && typeof sib.className === 'string' ? '.' + sib.className.trim().split(/\s+/)[0] : ''),
      };
    }

    // No preceding sibling: h1 is the first visible content of its direct
    // parent, so it sits exactly at that parent's own content edge -- the
    // parent's OWN rect.top (a live measurement that already bakes in
    // every ancestor's margin and padding above it, from nav-clearance
    // down to whatever sits before the parent itself) plus the parent's
    // own padding-top/border-top (0 for a pass-through wrapper, which
    // still gives the right answer: h1 flush with the wrapper's own box).
    // No need to walk further up the tree -- the parent's rect.top is
    // already the finished answer for everything above it.
    const el = h1.parentElement;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      h1Top,
      h1MarginTop,
      expected: r.top + (parseFloat(s.paddingTop) || 0) + (parseFloat(s.borderTopWidth) || 0),
      ancestorSelector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''),
    };
  });
}

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

function startStaticServer(root) {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function measure(page) {
  return page.evaluate(() => {
    const nav = document.getElementById('main-nav');
    const h1 = document.querySelector('h1');
    const navRect = nav ? nav.getBoundingClientRect() : null;
    const h1Rect = h1 ? h1.getBoundingClientRect() : null;
    return {
      navBottom: navRect ? navRect.bottom : null,
      h1Top: h1Rect ? h1Rect.top : null,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

describe('MOBILE-HEADER-OFFSET Tier 1 (static server): h1 clears the fixed header on every tracked page', { timeout: 180_000 }, () => {
  let tier1ok = false;
  let server;
  let base;
  let browser;

  before(async () => {
    assert.ok(ALL_PUBLIC_HTML.length >= 14, `expected at least 14 tracked HTML pages under public/, found ${ALL_PUBLIC_HTML.length}: ${ALL_PUBLIC_HTML.join(', ')}`);
    if (!isPlaywrightAvailable()) return;
    server = await startStaticServer(PUBLIC_DIR);
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    tier1ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  it('git ls-files public/ enumerates the pages this suite iterates (no drift)', () => {
    assert.ok(ALL_PUBLIC_HTML.includes('public/index.html'));
    assert.ok(ALL_PUBLIC_HTML.includes('public/pricing.html'));
    console.log(`MOBILE-HEADER-OFFSET: enumerated ${ALL_PUBLIC_HTML.length} tracked pages from git ls-files public/`);
  });

  for (const relPath of ALL_PUBLIC_HTML) {
    const urlPath = relPath.replace(/^public\//, '');
    for (const width of WIDTHS) {
      it(`${relPath} at ${width}px: h1.top >= header.bottom + ${MIN_CLEARANCE}, no horizontal overflow`, async (t) => {
        if (!tier1ok) { t.skip('playwright not resolvable'); return; }
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const p = await ctx.newPage();
        try {
          await p.goto(`${base}/${urlPath}`, { waitUntil: 'networkidle' });
          const m = await measure(p);
          assert.ok(m.navBottom !== null, `${relPath}: #main-nav not found`);
          assert.ok(m.h1Top !== null, `${relPath}: no <h1> found`);
          const required = m.navBottom + MIN_CLEARANCE;
          assert.ok(
            m.h1Top >= required,
            `${relPath} at ${width}px: h1.top=${m.h1Top} should be >= header.bottom(${m.navBottom}) + ${MIN_CLEARANCE} = ${required}`
          );
          assert.ok(
            m.scrollWidth <= m.clientWidth + 1,
            `${relPath} at ${width}px: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} (horizontal overflow)`
          );
        } finally {
          await ctx.close();
        }
      });
    }
  }

  for (const relPath of ALL_PUBLIC_HTML) {
    const urlPath = relPath.replace(/^public\//, '');
    it(`${relPath} at 1440px: h1.top sits exactly at its containing block's own content edge (no stray margin)`, async (t) => {
      if (!tier1ok) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      try {
        await p.goto(`${base}/${urlPath}`, { waitUntil: 'networkidle' });
        const m = await measureExpectedH1Top(p);
        assert.ok(m, `${relPath}: no <h1> found`);
        assert.ok(
          Math.abs(m.h1MarginTop) < 0.5,
          `${relPath}: h1 margin-top should be 0, got ${m.h1MarginTop}`
        );
        assert.ok(
          Math.abs(m.h1Top - m.expected) < 0.5,
          `${relPath} at 1440px: h1.top=${m.h1Top}, expected ${m.expected} (its own containing block ${m.ancestorSelector}'s content edge, measured live in the same run)`
        );
      } finally {
        await ctx.close();
      }
    });
  }
});

describe('MOBILE-HEADER-OFFSET Tier 2 (staged real server.js): /terms + /how-submissions-work clear the header, anchors land below it', { timeout: 180_000 }, () => {
  let tier2ok = false;
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;

  before(async () => {
    if (!isPlaywrightAvailable()) return;

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-mobile-header-offset-'));
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
        SESSION_SECRET: 'mobile-header-offset-test-session-secret-0123456789',
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

    const { chromium } = require('playwright');
    browser = await chromium.launch();
    tier2ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const ROUTES = ['/terms', '/how-submissions-work'];

  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      it(`${route} at ${width}px: h1.top >= header.bottom + ${MIN_CLEARANCE}, no horizontal overflow`, async (t) => {
        if (bootSkipReason) { t.skip(bootSkipReason); return; }
        if (!tier2ok) { t.skip('playwright not resolvable'); return; }
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const p = await ctx.newPage();
        try {
          await p.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
          const m = await measure(p);
          assert.ok(m.navBottom !== null, `${route}: #main-nav not found`);
          assert.ok(m.h1Top !== null, `${route}: no <h1> found`);
          const required = m.navBottom + MIN_CLEARANCE;
          assert.ok(
            m.h1Top >= required,
            `${route} at ${width}px: h1.top=${m.h1Top} should be >= header.bottom(${m.navBottom}) + ${MIN_CLEARANCE} = ${required}`
          );
          assert.ok(
            m.scrollWidth <= m.clientWidth + 1,
            `${route} at ${width}px: scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} (horizontal overflow)`
          );
        } finally {
          await ctx.close();
        }
      });
    }
  }

  it('/terms at 375px: jumping to an in-page anchor (#section-7) lands the target below the fixed header', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!tier2ok) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const p = await ctx.newPage();
    try {
      await p.goto(`${baseUrl}/terms`, { waitUntil: 'networkidle' });
      const hasTarget = await p.evaluate(() => !!document.getElementById('section-7'));
      assert.ok(hasTarget, '/terms should have an element with id="section-7" (serveLegalPage numbers ## headings section-N)');
      await p.evaluate(() => { window.location.hash = '#section-7'; });
      await p.waitForTimeout(150);
      const result = await p.evaluate(() => {
        const nav = document.getElementById('main-nav');
        const target = document.getElementById('section-7');
        return {
          navBottom: nav.getBoundingClientRect().bottom,
          targetTop: target.getBoundingClientRect().top,
          scrollPaddingTop: getComputedStyle(document.documentElement).scrollPaddingTop,
        };
      });
      assert.ok(
        result.targetTop >= result.navBottom,
        `#section-7 top (${result.targetTop}) should land at or below the fixed header's bottom (${result.navBottom}) after the anchor jump`
      );
      assert.notEqual(result.scrollPaddingTop, '0px', 'html should carry a non-zero scroll-padding-top at 375px (the --header-h token)');
    } finally {
      await ctx.close();
    }
  });
});
