/**
 * tests/test-mobile-nav-overlay.js
 *
 * DR-1 regression test (PUNCH-LIST §31) -- the mobile hamburger nav overlay
 * must size itself to the viewport, not collapse to #main-nav's own bar.
 *
 * Root cause: #main-nav (public/styles.css) declared `backdrop-filter`.
 * backdrop-filter establishes a CSS containing block for position:fixed
 * descendants. .nav-links -- the mobile menu overlay, `position: fixed;
 * inset: 0` under the 900px breakpoint -- is a DOM child of #main-nav, so its
 * containing block collapsed to #main-nav's own ~84px bar instead of the
 * viewport. Result at 375x812 with `nav-open` applied: the overlay rendered
 * 84px tall, its 8 flex-centered links spilled from roughly y=-276 to
 * y=+360, and three links (For Builders, For Agents, How It Works) were
 * untappable (elementFromPoint returned null for their centers).
 *
 * Fix: the glass background + backdrop-filter moved onto a #main-nav::before
 * pseudo-element (public/styles.css). A pseudo-element has no descendants,
 * so it renders the same visual blur without ever becoming a containing-
 * block trap for .nav-links. No HTML or JS changed -- #main-nav still has
 * the border-bottom + flex layout, .nav-links/.hamburger/nav-open/
 * aria-expanded are all untouched.
 *
 * This file runs two tiers of checks:
 *
 *   1. STATIC (always runs, zero extra dependencies): parses
 *      public/styles.css and asserts no real ancestor of .nav-links
 *      (html, body, main, #main-nav, or a universal selector) carries
 *      backdrop-filter / filter / transform / perspective / contain /
 *      will-change -- the property family that creates a fixed-position
 *      containing block. Also confirms, for every HTML page that shares the
 *      nav block, that `.nav-links` is still structurally nested inside
 *      `<nav id="main-nav">`, so the CSS check's premise holds.
 *
 *   2. DYNAMIC (runs only if the `playwright` package is resolvable --
 *      it is a devDependency, not a runtime dependency, so a plain
 *      `npm install` in dev gets it but the published package does not):
 *      serves public/ over a throwaway static server, opens the hamburger
 *      at 375x812 on all 8 shared-nav pages, and asserts the containing-
 *      block geometry directly -- .nav-links fills the viewport and every
 *      nav link on the page is hit-testable via elementFromPoint. Also
 *      confirms at 1280x800 that the hamburger stays hidden, .nav-links
 *      keeps its normal desktop layout (display:flex, position:static),
 *      and the nav still resolves a real backdrop-filter (via #main-nav or
 *      its ::before).
 *
 *      CI installs playwright + Chromium and sets CI_REQUIRE_TIER2=1 so a
 *      broken install fails the build loudly instead of silently falling
 *      back to Tier-1-only coverage (see .github/workflows/ci.yml).
 *
 * Run: node tests/test-mobile-nav-overlay.js (invoked automatically by
 * `npm test`, alongside the test/*.test.js suite -- not via a tests/*.js
 * glob; see tests/README.md).
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'public', 'styles.css');
const PUBLIC_DIR = path.join(ROOT, 'public');

// The pages documented as sharing #main-nav.
// Wave C.3 (SITE-PM sheet 7 / build sheet C.3 item 3): the essay
// (writing-agents-message-board.html) gained the shared #main-nav +
// hamburger, so it joins the enumerated set here too.
const NAV_PAGES = [
    'index.html', 'how-it-works.html', 'for-agents.html', 'for-builders.html',
    'pricing.html', 'earnings.html', 'api.html', 'dashboard.html',
    'writing-agents-message-board.html',
    // Wave E3 item 3: about.html and writing/index.html moved off the
    // legacy .status-nav (zero height at 375, no hamburger) onto the shared
    // #main-nav, same as the rest of this list.
    'about.html', 'writing/index.html',
    // NAV-WAVE (2026-09-06): status.html also carries the shared #main-nav
    // component -- confirmed structurally, so it belongs in this enumerated
    // set alongside the rest rather than being carved out.
    'status.html',
];

// All 8 shared-nav pages are driven through the browser for the dynamic
// tier too (runtime stays under CI's budget -- see BUILD-4 follow-up,
// PUNCH-LIST §31 DR-1).
const DYNAMIC_PAGES = NAV_PAGES;

// Expected .nav-links link count per dynamic page. NAV-WAVE (2026-09-06):
// the shared nav carries 5 labels (How It Works / For Agents / For Builders
// / Pricing / Earnings -- API removed to the footer) + the "Connect Your
// Agent" CTA = 6 links on the public marketing pages; dashboard.html is a
// distinct authenticated shell that drops the CTA (already connected) = 5
// links -- confirmed against the real DOM, not a guess.
//
// NAV-WAVE amendment (2026-09-06, AD nav re-rule sheet §1): the sign-in
// utility strip moved the Sign in/Dashboard auth slot OUT of .nav-links
// entirely, into its own always-visible <div class="nav-strip"> above the
// hamburger-collapsible nav row -- "it does not collapse and it does not
// merge into the menu." So the auth slot no longer counts toward
// .nav-links' link total on either page type; the counts above (6 / 5) are
// one lower than the pre-amendment 7 / 6.
const EXPECTED_LINK_COUNT = { 'dashboard.html': 5 };
function expectedLinkCount(page) {
    return EXPECTED_LINK_COUNT[page] || 6;
}

let passed = 0;
let failed = 0;
const failures = [];

function runTest(name, fn) {
    try {
        fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, error: err.message });
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

async function runAsyncTest(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`✅ ${name}`);
    } catch (err) {
        failed++;
        failures.push({ name, error: err.message });
        console.error(`❌ ${name}`);
        console.error(`   ${err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Tier 1: STATIC CSS + DOM-structure assertions
// ═══════════════════════════════════════════════════════════════════════

// Properties that establish a containing block for position:fixed
// descendants when set to a non-'none' value on an ancestor.
const TRIGGER_PROPS = [
    'backdrop-filter', '-webkit-backdrop-filter', 'filter',
    'transform', 'perspective', 'contain', 'will-change',
];

// Selectors that would match a real DOM ancestor of .nav-links per the
// shared markup (html > body > nav#main-nav > ul.nav-links). #main-nav's
// OWN ::before/::after are deliberately not in this set: a pseudo-element
// has no descendants, so it cannot trap .nav-links even if it carries
// backdrop-filter (that's exactly what the fix relies on).
const ANCESTOR_SELECTORS = new Set(['html', 'body', 'main', '#main', '#main-nav', '*']);

/**
 * Minimal CSS block parser: flattens top-level rules and one level of
 * @media/@supports nesting into { selector, body } pairs. Good enough for
 * this file's hand-written, non-preprocessed stylesheet -- not a general
 * CSS parser.
 */
function parseCssRules(css) {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [];

    function parseBlock(source) {
        let i = 0;
        while (i < source.length) {
            const openBrace = source.indexOf('{', i);
            if (openBrace === -1) break;
            const selectorText = source.slice(i, openBrace).trim();
            let depth = 1;
            let j = openBrace + 1;
            while (j < source.length && depth > 0) {
                if (source[j] === '{') depth++;
                else if (source[j] === '}') depth--;
                j++;
            }
            const body = source.slice(openBrace + 1, j - 1);
            i = j;
            if (selectorText.startsWith('@media') || selectorText.startsWith('@supports')) {
                parseBlock(body);
            } else if (selectorText.startsWith('@')) {
                // other at-rules (@keyframes, @font-face, ...) -- not ancestor-relevant
            } else if (selectorText) {
                rules.push({ selector: selectorText, body });
            }
        }
    }

    parseBlock(stripped);
    return rules;
}

function findAncestorTriggerViolations(css) {
    const rules = parseCssRules(css);
    const violations = [];
    for (const rule of rules) {
        const selectors = rule.selector.split(',').map((s) => s.trim());
        for (const sel of selectors) {
            if (!ANCESTOR_SELECTORS.has(sel)) continue;
            for (const prop of TRIGGER_PROPS) {
                const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`(^|[^-\\w])${escaped}\\s*:\\s*([^;]+);`, 'i');
                const m = rule.body.match(re);
                if (m) {
                    const value = m[2].trim();
                    if (value && value.toLowerCase() !== 'none') {
                        violations.push({ selector: sel, prop, value });
                    }
                }
            }
        }
    }
    return violations;
}

function runStaticTests() {
    console.log('--- Tier 1: static CSS + DOM-structure assertions ---');

    const css = fs.readFileSync(CSS_PATH, 'utf8');

    runTest('T-DR1-STATIC-001: no real ancestor of .nav-links sets a containing-block-trigger property', () => {
        const violations = findAncestorTriggerViolations(css);
        assert.strictEqual(
            violations.length, 0,
            `Found ancestor selector(s) with a fixed-position containing-block trigger: ${JSON.stringify(violations)}`
        );
    });

    runTest('T-DR1-STATIC-002: #main-nav itself does not declare backdrop-filter', () => {
        const rules = parseCssRules(css).filter((r) => r.selector.split(',').map((s) => s.trim()).includes('#main-nav'));
        assert.ok(rules.length > 0, '#main-nav rule should exist');
        for (const rule of rules) {
            assert.ok(
                !/backdrop-filter\s*:/i.test(rule.body),
                '#main-nav must not declare backdrop-filter directly -- it must live on a pseudo-element instead'
            );
        }
    });

    runTest('T-DR1-STATIC-003: the glass blur still exists, scoped to #main-nav::before', () => {
        const rules = parseCssRules(css).filter((r) => r.selector.split(',').map((s) => s.trim()).includes('#main-nav::before'));
        assert.ok(rules.length > 0, '#main-nav::before rule should exist and carry the glass background');
        const body = rules.map((r) => r.body).join('\n');
        assert.ok(/backdrop-filter\s*:\s*blur\(/i.test(body), '#main-nav::before should apply backdrop-filter: blur(...)');
        assert.ok(/background\s*:/i.test(body), '#main-nav::before should carry the glass background color');
    });

    runTest('T-DR1-STATIC-004: .nav-links mobile overlay still spans the full viewport', () => {
        const rules = parseCssRules(css).filter((r) => r.selector.split(',').map((s) => s.trim()).includes('.nav-links'));
        const body = rules.map((r) => r.body).join('\n');
        assert.ok(/position\s*:\s*fixed/i.test(body), '.nav-links should still be position:fixed on mobile');
        for (const edge of ['top', 'left', 'right', 'bottom']) {
            const re = new RegExp(`(^|[^-\\w])${edge}\\s*:\\s*0`, 'i');
            assert.ok(re.test(body), `.nav-links should pin ${edge}:0 so it fills the viewport`);
        }
    });

    for (const page of NAV_PAGES) {
        runTest(`T-DR1-STATIC-DOM-${page}: .nav-links is nested inside <nav id="main-nav">`, () => {
            const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
            const navOpen = html.indexOf('<nav id="main-nav"');
            assert.ok(navOpen !== -1, `${page} should have <nav id="main-nav">`);
            const navClose = html.indexOf('</nav>', navOpen);
            assert.ok(navClose !== -1, `${page} should close </nav>`);
            const navLinksIdx = html.indexOf('class="nav-links"', navOpen);
            assert.ok(navLinksIdx !== -1, `${page} should have .nav-links`);
            assert.ok(
                navLinksIdx > navOpen && navLinksIdx < navClose,
                `${page}: .nav-links must be a descendant of #main-nav (structural premise the CSS fix relies on)`
            );
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Tier 2: DYNAMIC browser-driven assertions (optional -- needs playwright)
// ═══════════════════════════════════════════════════════════════════════

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

async function runDynamicTests() {
    console.log('--- Tier 2: dynamic Playwright assertions ---');
    // eslint-disable-next-line import/no-extraneous-dependencies
    const { chromium } = require('playwright');
    const server = await startStaticServer(PUBLIC_DIR);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch();

    try {
        for (const page of DYNAMIC_PAGES) {
            await runAsyncTest(`T-DR1-DYNAMIC-MOBILE-${page}: overlay fills viewport, all nav links hit-testable`, async () => {
                const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
                const p = await ctx.newPage();
                try {
                    await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
                    await p.click('#hamburger');

                    const rect = await p.evaluate(() => document.querySelector('.nav-links').getBoundingClientRect().toJSON());
                    assert.ok(
                        Math.abs(rect.height - 812) <= 40,
                        `.nav-links height should be within 40px of the 812px viewport, got ${rect.height}`
                    );

                    const links = await p.evaluate(() => {
                        return Array.from(document.querySelectorAll('.nav-links a')).map((a) => {
                            const r = a.getBoundingClientRect();
                            const cx = r.left + r.width / 2;
                            const cy = r.top + r.height / 2;
                            const hit = document.elementFromPoint(cx, cy);
                            return { text: a.textContent.trim(), hitOk: !!hit && (hit === a || a.contains(hit) || hit.contains(a)) };
                        });
                    });
                    const expected = expectedLinkCount(page);
                    assert.strictEqual(links.length, expected, `expected ${expected} nav links, found ${links.length}`);
                    for (const link of links) {
                        assert.ok(link.hitOk, `link "${link.text}" should be hit-testable at its own center`);
                    }
                } finally {
                    await ctx.close();
                }
            });
        }

        for (const page of DYNAMIC_PAGES) {
            await runAsyncTest(`T-DR1-DYNAMIC-DESKTOP-${page}: nav layout + backdrop-filter unchanged at 1280x800`, async () => {
                const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
                const p = await ctx.newPage();
                try {
                    await p.goto(`${base}/${page}`, { waitUntil: 'networkidle' });
                    const computed = await p.evaluate(() => {
                        const nav = document.getElementById('main-nav');
                        const links = document.querySelector('.nav-links');
                        const hamburger = document.getElementById('hamburger');
                        const navBefore = getComputedStyle(nav, '::before');
                        return {
                            beforeBackdrop: navBefore.backdropFilter || navBefore.webkitBackdropFilter,
                            linksDisplay: getComputedStyle(links).display,
                            linksPosition: getComputedStyle(links).position,
                            hamburgerDisplay: getComputedStyle(hamburger).display,
                        };
                    });
                    assert.ok(
                        computed.beforeBackdrop && computed.beforeBackdrop !== 'none',
                        'nav should still resolve a real backdrop-filter via ::before at desktop width'
                    );
                    assert.strictEqual(computed.linksDisplay, 'flex', '.nav-links should keep its normal desktop flex layout');
                    assert.strictEqual(computed.linksPosition, 'static', '.nav-links should not be position:fixed at desktop width');
                    assert.strictEqual(computed.hamburgerDisplay, 'none', 'hamburger should stay hidden at desktop width');
                } finally {
                    await ctx.close();
                }
            });
        }
    } finally {
        await browser.close();
        server.close();
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════════

async function main() {
    console.log('=== DR-1 Mobile Nav Overlay Regression Test ===\n');

    runStaticTests();

    // CI sets CI_REQUIRE_TIER2=1 after installing playwright + chromium, so a
    // broken install (missing devDependency, `playwright install` step
    // skipped, etc.) fails the build instead of silently downgrading to
    // Tier-1-only coverage.
    const ciRequireTier2 = process.env.CI_REQUIRE_TIER2 === '1';

    if (isPlaywrightAvailable()) {
        await runDynamicTests();
    } else if (ciRequireTier2) {
        failed++;
        const error = 'CI_REQUIRE_TIER2=1 but playwright is not resolvable -- Tier 2 would silently ' +
            'skip. Fix the CI workflow (playwright devDependency + `npx playwright install chromium ' +
            '--with-deps` before `npm test`) rather than removing this guard.';
        failures.push({ name: 'T-DR1-TIER2-REQUIRED', error });
        console.error('❌ T-DR1-TIER2-REQUIRED');
        console.error(`   ${error}`);
    } else {
        console.log('\n--- Tier 2: SKIPPED (playwright devDependency not installed on this machine) ---');
        console.log('    Run `npm install` (it is in devDependencies) then `npx playwright install chromium` to enable it locally.');
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`DR-1 mobile nav overlay: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
        console.log('\nFailures:');
        for (const f of failures) {
            console.log(`  ❌ ${f.name}: ${f.error}`);
        }
    }
    console.log('='.repeat(60));
    process.exit(failed > 0 ? 1 : 0);
}

main();
