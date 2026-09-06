'use strict';

/**
 * test/nav-wave.test.js — NAV-WAVE (2026-09-06).
 *
 * Tyler's two notes, verbatim: "Ensure top nav is the same across the site -
 * i.e. home page and dashboard" and "Remove API from top nav" — built per
 * SITE-PM's packet 11 rev 3 (~/.auxilo/handoffs/
 * AD-STRINGS-PACKET-11-AUXILO-NAMING-NAV-2026-09-06.md) §4 and the
 * TECH-PM NAV-WAVE build spec.
 *
 * What changed:
 *   1. One #main-nav component, byte-identical across every served page
 *      except (a) which of the 5 labels carries class="active", (b) the
 *      Sign in / Dashboard auth-state slot (packet 11 §4: "an auth state,
 *      not a label difference; the component is one"), and (c) the
 *      "Connect Your Agent" CTA, which is public-pages-only per packet 11
 *      §4 ("stays as the nav's one CTA on public pages") — dashboard.html
 *      drops it (already connected) the same way it always had.
 *      API left the top nav entirely; it stays in the footer.
 *   2. Packet 11 §2/§2a's twelve site-copy swaps + six openapi.json lines,
 *      plus TECH-PM's Auxilo-naming sweep of server.js (12 hits),
 *      mcp-server.js (the MCP connect instruction + 6 more — named in the
 *      packet's own text but living in mcp-server.js, not server.js; fixed
 *      under the same rule since the packet explicitly calls out that
 *      exact string) and README.md (6 hits).
 *   3. Every footer got an /api link — checked while removing /api from the
 *      nav (item 1's own "confirm the footer already links /api on every
 *      page, else report" instruction) and found only 2 of 12 pages
 *      (index.html, for-builders.html) actually had one, via their
 *      .footer-links pre-footer nav section. Added a plain footer /api
 *      link to the other 10, and to index.html/for-builders.html's own
 *      <footer> (they only had it in .footer-links) so the sitewide
 *      "identical footer link sequence" invariant (test/site-system.test.js
 *      SITE-SYSTEM item 2) still holds with /api included everywhere.
 *
 * This file has three parts:
 *   A. Static per-file nav structure checks (public/*.html + writing/index.html,
 *      enumerated via `git ls-files public/`).
 *   B. Live-server checks for the 5 serveLegalPage routes + /dashboard,
 *      reusing the staged-server harness (test/wave-e3.test.js /
 *      test/legal-shell-footer.test.js convention).
 *   C. The bare-"marketplace" sweep (packet 11 §5 post-deploy check 1/2)
 *      across public/, server.js, mcp-server.js, README.md, openapi.json.
 *
 * Runner: node --test test/nav-wave.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
  BOOT_SANDBOX_SKIP_REASON,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

// ═══════════════════════════════════════════════════════════════════════
// Shared fixtures
// ═══════════════════════════════════════════════════════════════════════

// The ruled label set, packet 11 §4 interim window (Search / How submissions
// work stay out until their routes ship — no dead links, no placeholder
// labels). Title Case throughout, per Tyler's 2026-09-06 night casing
// ruling ("Yes title case for nav menus and headlines that do not end in a
// period"), which supersedes packet 11 §4's sentence-case amendment to IA
// rev 3 §11 for nav labels. Order is unchanged from the interim window
// (NAV-WAVE amendment: casing only, order untouched). This array is the
// single point of change if the label set is ever extended (Search / How
// submissions work / Works with) — everything below derives from it rather
// than re-typing labels.
const NAV_LABELS = ['How It Works', 'For Agents', 'For Builders', 'Pricing', 'Earnings'];

// Enumerate every tracked public HTML page from git itself (not a hand-typed
// list that can drift) — the NAV-WAVE build spec's own instruction.
function gitTrackedPublicHtmlFiles() {
  const out = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO, encoding: 'utf8' });
  return out.split('\n').filter((f) => f.endsWith('.html')).sort();
}

const ALL_PUBLIC_HTML = gitTrackedPublicHtmlFiles();

// Route -> the nav label (or null) that should carry class="active" on that
// page. Pages whose route doesn't correspond to one of the 5 shared labels
// (home, about, api, status, dashboard, the essay, /writing) carry NO active
// label among the 5 — there is nothing in the ruled set to mark current.
// Deliberate call (not named by packet 11 or the build spec, which only
// describe "byte-identical except the active link" for the pages that DO
// map onto one of the 5): reported as a SITE-PM call in the delivery report.
const ACTIVE_LABEL_BY_FILE = {
  'public/how-it-works.html': 'How It Works',
  'public/for-agents.html': 'For Agents',
  'public/for-builders.html': 'For Builders',
  'public/pricing.html': 'Pricing',
  'public/earnings.html': 'Earnings',
};

function readFile(relOrAbs) {
  const p = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO, relOrAbs);
  return fs.readFileSync(p, 'utf8');
}

// Extracts the #main-nav block(s) from an HTML document.
function extractNavBlocks(html) {
  const re = /<nav id="main-nav"[\s\S]*?<\/nav>/g;
  return html.match(re) || [];
}

// Pulls the ordered list of {id, text, active} for every flat <a>...</a>
// inside a nav block's <ul class="nav-links">. The logo link is a nested
// <a><svg>...</svg><span>auxilo</span></a> and never matches (its content
// isn't a bare run of non-"<" text), so it's excluded without special-casing.
function navLinkEntries(navBlock) {
  const entries = [];
  const re = /<a\s+([^>]*)>([^<]*)<\/a>/g;
  let m;
  while ((m = re.exec(navBlock))) {
    const attrs = m[1];
    const text = m[2].trim();
    const idMatch = attrs.match(/id="([^"]+)"/);
    entries.push({
      id: idMatch ? idMatch[1] : null,
      text,
      active: /class="[^"]*\bactive\b[^"]*"/.test(attrs),
      href: (attrs.match(/href="([^"]+)"/) || [, null])[1],
    });
  }
  return entries;
}

// Verifies one page's nav (given its full HTML + a label for error messages)
// against the ruled shared component. `expectedActive` is a label string or
// null. `expectCta` controls whether "Connect Your Agent" must be present
// (true on public pages, false on dashboard.html).
function assertSharedNav(html, pageLabel, expectedActive, expectCta) {
  const blocks = extractNavBlocks(html);
  assert.equal(blocks.length, 1, `${pageLabel}: expected exactly one #main-nav, found ${blocks.length}`);
  const nav = blocks[0];

  assert.equal((nav.match(/id="main-nav"/g) || []).length, 1,
    `${pageLabel}: #main-nav id must appear exactly once`);

  const entries = navLinkEntries(nav);
  const first5 = entries.slice(0, 5).map((e) => e.text);
  assert.deepEqual(first5, NAV_LABELS,
    `${pageLabel}: first 5 nav links must be ${JSON.stringify(NAV_LABELS)} in order, got ${JSON.stringify(first5)}`);

  // No /api link inside the nav at all (Tyler: "Remove API from top nav").
  const apiInNav = entries.some((e) => e.href === '/api');
  assert.equal(apiInNav, false, `${pageLabel}: #main-nav must not link /api`);

  // Exactly one class="active" among the 5 ruled labels, matching
  // expectedActive (or zero when expectedActive is null). The auth slot
  // (Sign in / Dashboard) is checked separately below/elsewhere — it
  // legitimately carries its own active state on dashboard.html per packet
  // 11 §4 ("an auth state, not a label difference"), which is not part of
  // "the five labels" this check is about.
  const labelEntries = entries.slice(0, 5);
  const activeEntries = labelEntries.filter((e) => e.active);
  if (expectedActive === null) {
    assert.equal(activeEntries.length, 0,
      `${pageLabel}: expected no active label among the 5, found ${activeEntries.map((e) => e.text).join(', ')}`);
  } else {
    assert.equal(activeEntries.length, 1,
      `${pageLabel}: expected exactly one active label among the 5, found ${activeEntries.length} (${activeEntries.map((e) => e.text).join(', ')})`);
    assert.equal(activeEntries[0].text, expectedActive,
      `${pageLabel}: active label should be "${expectedActive}", got "${activeEntries[0].text}"`);
  }

  const ctaEntry = entries.find((e) => e.href === '/#install');
  if (expectCta) {
    assert.ok(ctaEntry, `${pageLabel}: public nav must carry the "Connect Your Agent" CTA`);
    assert.equal(ctaEntry.text, 'Connect Your Agent');
  } else {
    assert.equal(ctaEntry, undefined, `${pageLabel}: dashboard nav must not carry the public CTA`);
  }

  // Footer /api link present somewhere OUTSIDE the nav (API "stays in the
  // footer" per packet 11 §4).
  const outsideNav = html.replace(nav, '');
  assert.match(outsideNav, /href="\/api"/, `${pageLabel}: a footer /api link must be present`);
}

// ═══════════════════════════════════════════════════════════════════════
// A. Static checks — every git-tracked public/*.html page
// ═══════════════════════════════════════════════════════════════════════

describe('NAV-WAVE A: every tracked public HTML page carries the shared #main-nav', () => {
  it('git ls-files public/ enumerates all 12 pages this suite expects (no drift)', () => {
    assert.deepEqual(
      ALL_PUBLIC_HTML,
      [
        'public/about.html',
        'public/api.html',
        'public/dashboard.html',
        'public/earnings.html',
        'public/for-agents.html',
        'public/for-builders.html',
        'public/how-it-works.html',
        'public/index.html',
        'public/pricing.html',
        'public/status.html',
        'public/writing-agents-message-board.html',
        'public/writing/index.html',
      ].sort(),
    );
  });

  for (const rel of ALL_PUBLIC_HTML) {
    const isDashboard = rel === 'public/dashboard.html';
    const expectedActive = ACTIVE_LABEL_BY_FILE[rel] || null;

    it(`${rel} carries the shared nav (active: ${expectedActive || 'none'}, CTA: ${!isDashboard})`, () => {
      const html = readFile(rel);
      assertSharedNav(html, rel, expectedActive, !isDashboard);
    });
  }

  it('dashboard.html shows "Dashboard" (not "Sign in") in the auth slot, marked active', () => {
    const html = readFile('public/dashboard.html');
    const nav = extractNavBlocks(html)[0];
    const entries = navLinkEntries(nav);
    const authSlot = entries.find((e) => e.id === 'nav-dashboard');
    assert.ok(authSlot, 'dashboard.html nav must carry the id="nav-dashboard" auth slot');
    assert.equal(authSlot.text, 'Dashboard');
    assert.ok(authSlot.active, 'dashboard.html\'s auth slot must carry class="active"');
  });

  for (const rel of ALL_PUBLIC_HTML.filter((f) => f !== 'public/dashboard.html')) {
    it(`${rel} shows "Sign in" (not "Dashboard") in the auth slot`, () => {
      const html = readFile(rel);
      const nav = extractNavBlocks(html)[0];
      const entries = navLinkEntries(nav);
      const authSlot = entries.find((e) => e.id === 'nav-dashboard');
      assert.ok(authSlot, `${rel} nav must carry the id="nav-dashboard" auth slot`);
      assert.equal(authSlot.text, 'Sign in');
      assert.equal(authSlot.active, false, `${rel}: the public auth slot must not be active`);
    });
  }

  it('the shared nav markup is byte-identical across all 12 pages once normalized to a common indent and the 3 documented variations (active label, auth slot, CTA presence)', () => {
    // Normalizes each nav block's indentation to a fixed baseline and masks
    // the 3 documented per-page variations so what's left can be compared
    // byte-for-byte.
    function normalize(navBlock) {
      return navBlock
        .split('\n')
        .map((line) => line.trimStart())
        .join('\n')
        .replace(/ id="nav-how"(?: class="active")?/, ' id="nav-how"')
        .replace(/ id="nav-agents"(?: class="active")?/, ' id="nav-agents"')
        .replace(/ id="nav-builders"(?: class="active")?/, ' id="nav-builders"')
        .replace(/ id="nav-pricing"(?: class="active")?/, ' id="nav-pricing"')
        .replace(/ id="nav-earnings"(?: class="active")?/, ' id="nav-earnings"')
        // NAV-WAVE amendment (sign-in utility strip): the auth-slot link
        // moved out of a <li> inside .nav-links into <a> inside
        // .nav-strip (no <li> wrapper there — the strip isn't a list).
        .replace(/<a href="\/dashboard" id="nav-dashboard"[^>]*>(Sign in|Dashboard)<\/a>\s*/, '')
        .replace(/<li><a href="\/#install"[^>]*>Connect Your Agent<\/a><\/li>\s*/, '');
    }
    const normalized = ALL_PUBLIC_HTML.map((rel) => normalize(extractNavBlocks(readFile(rel))[0]));
    const [first, ...rest] = normalized;
    for (let i = 0; i < rest.length; i++) {
      assert.equal(rest[i], first,
        `${ALL_PUBLIC_HTML[i + 1]}'s nav (normalized) diverges from ${ALL_PUBLIC_HTML[0]}'s`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B. Live-server checks — the 5 legal routes + /dashboard
// ═══════════════════════════════════════════════════════════════════════

describe('NAV-WAVE B: legal shell routes + /dashboard render the shared nav', { timeout: 180_000 }, () => {
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-nav-wave-'));
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
        SESSION_SECRET: 'nav-wave-test-session-secret-0123456789ab',
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

  const LEGAL_ROUTES = ['/terms', '/privacy', '/legal/subprocessors', '/legal/supported-clients', '/dmca'];

  for (const route of LEGAL_ROUTES) {
    it(`GET ${route} carries the shared nav, no active label, footer /api present`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      const res = await fetch(`${baseUrl}${route}`);
      assert.equal(res.status, 200);
      const body = await res.text();
      assertSharedNav(body, route, null, true);
    });
  }

  it('GET /dashboard carries the shared nav with "Dashboard" active, no CTA, footer /api present', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assertSharedNav(body, '/dashboard', null, false);
    const nav = extractNavBlocks(body)[0];
    const authSlot = navLinkEntries(nav).find((e) => e.id === 'nav-dashboard');
    assert.equal(authSlot.text, 'Dashboard');
    assert.ok(authSlot.active);
  });

  // Packet 11 §5 check 5 (partial — the static half): the dashboard confirm
  // dialog string. The live behavioral half of check 5 (409
  // operator_review_required on an uncleared account's approve, item stays
  // pending_review) is already covered by test/aud19-funnel.test.js and
  // test/r13-close.test.js against lib/self-review.js:229 — not
  // re-implemented here to avoid duplicate live-account coverage.
  it('GET /dashboard carries the packet-11-rev-3 approve confirm dialog text (both gates\' wording)', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    const res = await fetch(`${baseUrl}/dashboard`);
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /Until Auxilo has cleared your account to publish, approval is declined and the item stays in your queue for operator review\./);
    assert.match(body, /Once your account is cleared, approving publishes each one to the public catalog unless a screen has it held\./);
    assert.doesNotMatch(body, /published to the public marketplace immediately/,
      'the retired "immediately" wording (rev 1/2, described a hand-off the code does not perform) must be gone');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// C. Bare "marketplace" sweep — packet 11 §5 checks 1/2
// ═══════════════════════════════════════════════════════════════════════

describe('NAV-WAVE C: no bare "marketplace" outside the ruled/held allow-list', () => {
  // Every remaining bare (no "Auxilo" on the same line) "marketplace"
  // mention across public/, server.js, mcp-server.js, README.md,
  // openapi.json, confirmed by direct sweep during this build. Four are the
  // homepage FAQ category lines held for Tyler (packet 11 §3 item 1); one
  // is the llms.txt tagline (exempt, directly under the "# Auxilo"
  // heading); one is the og-image.svg category sentence split across two
  // <text> nodes (false positive per packet 11 §1 — the wordmark sits in a
  // separate node in the same image).
  const ALLOWED_BARE_LINES = [
    { file: 'public/og-image.svg', text: 'A marketplace for' },
    { file: 'public/llms.txt', text: '> A marketplace for what agents learn' },
    { file: 'public/index.html', text: '"name": "What is a knowledge marketplace for AI agents?",' },
    { file: 'public/index.html', text: '"name": "What makes a shared agent marketplace different from private agent memory?",' },
    { file: 'public/index.html', text: '<span>What is a knowledge marketplace for AI agents?</span>' },
    { file: 'public/index.html', text: '<span>What makes a shared agent marketplace different from private agent memory?</span>' },
  ];

  function allPublicFiles() {
    const out = execFileSync('git', ['ls-files', 'public/'], { cwd: REPO, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  }

  it('every line containing "marketplace" (case-insensitive) also contains "Auxilo" on the same line, or is on the allow-list', () => {
    const scopeFiles = [
      ...allPublicFiles(),
      'server.js',
      'mcp-server.js',
      'README.md',
      'openapi.json',
    ];
    const violations = [];
    for (const rel of scopeFiles) {
      const abs = path.join(REPO, rel);
      if (!fs.existsSync(abs)) continue;
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      lines.forEach((line, idx) => {
        if (!/marketplace/i.test(line)) return;
        if (/auxilo/i.test(line)) return;
        const allowed = ALLOWED_BARE_LINES.some((a) => a.file === rel && line.includes(a.text));
        if (!allowed) violations.push(`${rel}:${idx + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(violations, [],
      `bare "marketplace" found outside the allow-list:\n${violations.join('\n')}`);
  });

  it('every allow-listed line is still actually present (the allow-list itself does not drift silently)', () => {
    for (const { file, text } of ALLOWED_BARE_LINES) {
      const content = fs.readFileSync(path.join(REPO, file), 'utf8');
      assert.ok(content.includes(text), `${file} should still contain ${JSON.stringify(text)}`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// D. The wordmark's triangle stroke is currentColor (AD nav re-rule sheet,
//    2026-09-06 §2/§6): "The wordmark's triangle stroke goes from #C9A84C
//    to currentColor so .nav-logo's ivory carries it and the mark reads as
//    one lockup. The band then paints exactly one gold element, the CTA."
//    Supersedes the earlier Wave E P2.10 post-deploy check that pinned the
//    wordmark stroke itself as the nav's one gold element.
// ═══════════════════════════════════════════════════════════════════════

describe('NAV-WAVE D: the wordmark stroke is currentColor, not a fixed gold — the CTA is the nav band\'s one gold element', () => {
  const WORDMARK_POLYGON = '<polygon points="16,2 30,28 2,28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/>';
  const WORDMARK_LINE = '<line x1="16" y1="17" x2="30" y2="17" stroke="currentColor" stroke-width="1.8"/>';
  const WORDMARK_POLYGON_GOLD = '<polygon points="16,2 30,28 2,28" fill="none" stroke="#C9A84C" stroke-width="2.2" stroke-linejoin="round"/>';
  const WORDMARK_LINE_GOLD = '<line x1="16" y1="17" x2="30" y2="17" stroke="#C9A84C" stroke-width="1.8"/>';

  for (const rel of ALL_PUBLIC_HTML) {
    it(`${rel}: the nav-logo wordmark's triangle stroke is currentColor, never the fixed gold hex`, () => {
      const html = readFile(rel);
      assert.ok(html.includes(WORDMARK_POLYGON), `${rel}: nav-logo polygon stroke must be currentColor`);
      assert.ok(html.includes(WORDMARK_LINE), `${rel}: nav-logo line stroke must be currentColor`);
      assert.doesNotMatch(html, /class="logo-mark"[\s\S]{0,200}?#C9A84C/, `${rel}: no logo-mark SVG may still carry the fixed gold hex`);
    });
  }

  it('server.js legal shell: the nav-logo wordmark\'s triangle stroke is currentColor', () => {
    const src = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
    assert.ok(src.includes(WORDMARK_POLYGON), 'server.js legal-shell nav-logo polygon stroke must be currentColor');
    assert.ok(src.includes(WORDMARK_LINE), 'server.js legal-shell nav-logo line stroke must be currentColor');
  });

  it('dashboard.html: the login-logo (sign-in header) wordmark also moved to currentColor, same shape reused outside the nav', () => {
    const html = readFile('public/dashboard.html');
    const loginLogoStart = html.indexOf('<div class="login-logo">');
    assert.ok(loginLogoStart > 0, 'dashboard.html must carry the .login-logo block');
    const loginLogoSlice = html.slice(loginLogoStart, loginLogoStart + 400);
    assert.ok(loginLogoSlice.includes(WORDMARK_POLYGON), 'login-logo polygon stroke must be currentColor');
    assert.ok(loginLogoSlice.includes(WORDMARK_LINE), 'login-logo line stroke must be currentColor');
  });

  it('no page or the legal shell ships the retired fixed-gold wordmark pair anywhere', () => {
    const scopeFiles = [...ALL_PUBLIC_HTML, 'server.js'];
    for (const rel of scopeFiles) {
      const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
      assert.doesNotMatch(content, new RegExp(WORDMARK_POLYGON_GOLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${rel}: the retired fixed-gold wordmark polygon must be gone`);
      assert.doesNotMatch(content, new RegExp(WORDMARK_LINE_GOLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `${rel}: the retired fixed-gold wordmark line must be gone`);
    }
  });

  it('within the nav band markup, the CTA is the only element carrying a gold-painting class — the wordmark and the five labels carry none', () => {
    for (const rel of ALL_PUBLIC_HTML) {
      const html = readFile(rel);
      const nav = extractNavBlocks(html)[0];
      assert.ok(nav, `${rel}: nav block found`);
      // The wordmark's own SVG no longer hardcodes a gold stroke (checked
      // above); here confirm the nav-links anchors carry no inline gold
      // styling either — the only sanctioned gold element in the band is
      // class="nav-cta", styled entirely from styles.css, never inline.
      assert.doesNotMatch(nav, /style="[^"]*#C9A84C/, `${rel}: no inline gold styling anywhere in #main-nav`);
    }
  });
});
