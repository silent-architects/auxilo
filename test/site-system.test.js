'use strict';

/**
 * test/site-system.test.js — AD sheet 9 (system pass, 2026-09-06).
 *
 * Structural, file-level guards for the sheet-9 build: no live server is
 * needed since every assertion is checkable from the served bytes on disk
 * (matching the convention in test/pricing-live-range.test.js's structural
 * describe block and test/ad-routes.test.js).
 *
 *   1. Every public page that carries a styles.css <link> carries the SAME
 *      `?v=` cache-bust string (item 7: the bump rides in the same commit
 *      as the CSS changes that need it).
 *   2. The footer link set (packet 3 rev 2's nine-minus-slot links) is
 *      byte-identical, in order, across every page that ships a footer
 *      (whitespace normalised — about.html/writing/index.html reproduce the
 *      same link sequence inside their own self-contained footer markup,
 *      not the shared .footer-inner DOM, so the check is on the <a> sequence
 *      itself, which IS byte-identical, not on the wrapping markup).
 *   3. No page's JSON-LD (Organization block specifically) carries the
 *      retired "$0.05 to $50.00" dollar band (item 5); the band may still
 *      appear in ordinary visible copy (FAQ answers, etc.) — this test only
 *      scopes the machine-readable JSON-LD script content.
 *   4. No <h2> on any page carries an inline style with a font-size
 *      declaration — the five inline h2 overrides audited pre-build
 *      (for-agents #mcp-heading, for-builders x3) are gone, folded into the
 *      shared section-h2 / closing-CTA-h2 tokens in styles.css.
 *   5. The four assets deleted this sheet (growth-flywheel.svg,
 *      section-divider.svg, geometric-pattern.svg — logo-square.svg is kept,
 *      it is the build source for logo-square.png, referenced from every
 *      page's Organization JSON-LD logo field) no longer exist on disk and
 *      are not referenced from any shipped page or stylesheet.
 *
 * Runner: node --test test/site-system.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

function readPublic(relPath) {
  return fs.readFileSync(path.join(PUBLIC_DIR, relPath), 'utf8');
}

// Pages that link the shared stylesheet (about.html and writing/index.html
// are self-contained by design — out of this sheet's named scope, item 0 —
// and carry no styles.css <link> at all).
const STYLESHEET_PAGES = [
  'index.html',
  'how-it-works.html',
  'for-agents.html',
  'for-builders.html',
  'pricing.html',
  'api.html',
  'status.html',
  'dashboard.html',
  'earnings.html',
  'writing-agents-message-board.html',
  'how-submissions-work.html',
];

// Pages that ship the packet-3-rev-2 footer link set.
const FOOTER_PAGES = [
  'index.html',
  'how-it-works.html',
  'for-agents.html',
  'for-builders.html',
  'pricing.html',
  'api.html',
  'earnings.html',
  'status.html',
  'about.html',
  path.join('writing', 'index.html'),
  'how-submissions-work.html',
];

// Pages carrying an Organization JSON-LD block.
const ORG_JSONLD_PAGES = [
  'index.html',
  'how-it-works.html',
  'for-agents.html',
  'for-builders.html',
  'pricing.html',
  'api.html',
  'earnings.html',
  'status.html',
  'how-submissions-work.html',
];

const ALL_PUBLIC_HTML_FILES = [
  'index.html',
  'how-it-works.html',
  'for-agents.html',
  'for-builders.html',
  'pricing.html',
  'api.html',
  'status.html',
  'about.html',
  'dashboard.html',
  'earnings.html',
  'writing-agents-message-board.html',
  path.join('writing', 'index.html'),
];

const DELETED_ASSETS = ['growth-flywheel.svg', 'section-divider.svg', 'geometric-pattern.svg'];

describe('SITE-SYSTEM item 7: every page links styles.css with the same ?v=', () => {
  it('all stylesheet-linking pages carry the identical ?v= query string', () => {
    const versions = new Map();
    for (const page of STYLESHEET_PAGES) {
      const html = readPublic(page);
      const m = html.match(/href="\/styles\.css\?v=(\d+)"/);
      assert.ok(m, `${page} carries a /styles.css?v=N link`);
      versions.set(page, m[1]);
    }
    const distinct = new Set(versions.values());
    assert.equal(distinct.size, 1,
      `all pages must share one ?v= value, got: ${JSON.stringify([...versions.entries()])}`);
  });
});

// Extract the ordered sequence of <a href="...">Text</a> pairs out of the
// page's footer, independent of the surrounding wrapper markup (which
// differs between the shared .footer-inner pages and the two self-contained
// pages, about.html and writing/index.html). Module scope (not inside any
// describe()) so the CH-7 describe-body-guard doesn't need to reason about
// where it's called from; each call site still asserts on its own result.
function footerLinkSequence(html) {
  const footerMatch = html.match(/<footer>[\s\S]*?<\/footer>/);
  if (!footerMatch) return null;
  return [...footerMatch[0].matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)]
    .map(([, href, text]) => `${href}::${text.trim()}`);
}

describe('SITE-SYSTEM item 2: the footer link set is byte-identical across every page', () => {
  it('every footer-bearing page renders the identical, ordered link sequence', () => {
    const sequences = new Map();
    for (const page of FOOTER_PAGES) {
      const html = readPublic(page);
      const seq = footerLinkSequence(html);
      assert.ok(seq, `${page} has a <footer> element`);
      sequences.set(page, seq);
    }
    const [firstPage, firstSeq] = [...sequences.entries()][0];
    assert.ok(firstSeq.length > 0, `${firstPage} footer has at least one link`);
    for (const [page, seq] of sequences) {
      assert.deepEqual(seq, firstSeq,
        `${page} footer link sequence must match ${firstPage}: ${JSON.stringify(seq)} vs ${JSON.stringify(firstSeq)}`);
    }
  });

  it('the footer set is exactly packet 3 rev 2\'s links (the trust-page slot still omitted: TRUST-PAGE shipped the route 2026-09-06, but the footer nav slot for it is a later, separate build — PUNCH-LIST TRUST-PAGE row)', () => {
    const expected = [
      '/about::About',
      '/writing::Writing',
      '/status::Status',
      '/.well-known/security.txt::Security',
      '/.well-known/agent.json::Agent card',
      '/terms::Terms',
      '/privacy::Privacy',
      'https://github.com/silent-architects/auxilo::GitHub',
    ];
    const html = readPublic('index.html');
    assert.deepEqual(footerLinkSequence(html), expected);
  });

  it('no EXISTING page\'s footer contains a /how-submissions-work link (TRUST-PAGE shipped the route itself 2026-09-06 in server.js and on its own page; the footer nav slot on the other pages is a separate, later build)', () => {
    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'server.js'), 'utf8');
    assert.ok(serverSrc.includes(`app.get('/how-submissions-work'`),
      'server.js now carries the how-submissions-work route (TRUST-PAGE, 2026-09-06)');
    for (const page of FOOTER_PAGES) {
      if (page === 'how-submissions-work.html') continue; // the page's own footer legitimately links itself via the wordmark, not this string
      const html = readPublic(page);
      assert.ok(!html.includes('how-submissions-work'), `${page} footer must not link the not-yet-navigated route`);
    }
  });

  it('the wordmark/home link in every footer points at /', () => {
    for (const page of FOOTER_PAGES) {
      const html = readPublic(page);
      const footerMatch = html.match(/<footer>[\s\S]*?<\/footer>/);
      assert.match(footerMatch[0], /<a href="\/" class="footer-logo"/, `${page} footer wordmark links home`);
    }
  });
});

describe('SITE-SYSTEM item 5: no Organization JSON-LD carries the retired dollar band', () => {
  it('"$0.05 to $50.00" is absent from every Organization JSON-LD block', () => {
    for (const page of ORG_JSONLD_PAGES) {
      const html = readPublic(page);
      const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      assert.ok(scripts.length > 0, `${page} carries at least one JSON-LD block`);
      let sawOrg = false;
      for (const [, jsonText] of scripts) {
        const data = JSON.parse(jsonText);
        const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
        for (const node of nodes) {
          if (node['@type'] === 'Organization') {
            sawOrg = true;
            assert.ok(!node.description.includes('$0.05 to $50.00'),
              `${page} Organization JSON-LD description must not carry the dollar band`);
            assert.ok(!node.description.includes('70%'),
              `${page} Organization JSON-LD description must not carry the 70/60 split clause`);
          }
        }
      }
      assert.ok(sawOrg, `${page} carries an Organization node in its JSON-LD`);
    }
  });
});

describe('SITE-SYSTEM item 1: no <h2> carries an inline font-size override', () => {
  it('zero <h2> elements have an inline style with a font-size declaration', () => {
    for (const page of ALL_PUBLIC_HTML_FILES) {
      const html = readPublic(page);
      const h2Tags = html.match(/<h2\b[^>]*>/g) || [];
      for (const tag of h2Tags) {
        const styleMatch = tag.match(/style="([^"]*)"/);
        if (styleMatch) {
          assert.ok(!/font-size\s*:/.test(styleMatch[1]),
            `${page} has an <h2> with an inline font-size override: ${tag}`);
        }
      }
    }
  });
});

describe('SITE-SYSTEM item 4: deleted assets are gone and unreferenced', () => {
  it('growth-flywheel.svg, section-divider.svg, geometric-pattern.svg no longer exist on disk', () => {
    for (const asset of DELETED_ASSETS) {
      assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, asset)), `${asset} must not exist under public/`);
    }
  });

  it('no shipped page or the shared stylesheet references a deleted asset', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    for (const asset of DELETED_ASSETS) {
      assert.ok(!styles.includes(asset), `styles.css must not reference ${asset}`);
    }
    for (const page of ALL_PUBLIC_HTML_FILES) {
      const html = readPublic(page);
      for (const asset of DELETED_ASSETS) {
        assert.ok(!html.includes(asset), `${page} must not reference ${asset}`);
      }
    }
  });

  it('logo-square.svg is KEPT (it is the build source for logo-square.png, referenced from every Organization JSON-LD logo field)', () => {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, 'logo-square.svg')), 'logo-square.svg still exists');
    const genScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'generate-og-assets.sh'), 'utf8');
    assert.ok(genScript.includes('logo-square.svg'), 'generate-og-assets.sh still converts logo-square.svg -> logo-square.png');
  });
});

describe('SITE-SYSTEM item 2: one FAQ accordion component, everywhere the FAQ markup exists', () => {
  const FAQ_PAGES = ['index.html', 'how-it-works.html', 'for-agents.html', 'for-builders.html', 'pricing.html', 'api.html'];

  it('every FAQ page uses the accordion markup (.faq-question/.faq-answer), not the old static .faq-q/.faq-a pair', () => {
    for (const page of FAQ_PAGES) {
      const html = readPublic(page);
      assert.ok(!/class="faq-q"/.test(html), `${page} must not carry the old static .faq-q markup`);
      assert.ok(!/class="faq-a"/.test(html), `${page} must not carry the old static .faq-a markup`);
      assert.ok(/class="faq-question"/.test(html), `${page} must carry the shared .faq-question button`);
      assert.ok(/onclick="toggleFaq\(this\)"/.test(html), `${page} wires the shared toggleFaq() handler`);
      assert.match(html, /function toggleFaq\(btn\)/, `${page} defines toggleFaq()`);
    }
  });

  it('the accordion component CSS is defined exactly once, in the shared stylesheet', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const defs = styles.match(/^\.faq-question\s*\{/gm) || [];
    assert.equal(defs.length, 1, 'exactly one .faq-question rule in styles.css');
    for (const page of FAQ_PAGES) {
      const html = readPublic(page);
      const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
      assert.ok(!/\.faq-question\s*\{/.test(styleBlock), `${page} must not duplicate .faq-question locally`);
    }
  });
});

describe('SITE-SYSTEM item 3: copy-btn is a 44px tap target at 13px type', () => {
  it('styles.css .copy-btn carries min-height 44px and font-size 13px', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const m = styles.match(/^\.copy-btn\s*\{([^}]*)\}/m);
    assert.ok(m, '.copy-btn rule found');
    assert.match(m[1], /min-height:\s*44px/, '.copy-btn min-height is 44px');
    assert.match(m[1], /font-size:\s*13px/, '.copy-btn font-size is 13px');
  });

  it('nav CTA is at least 36px tall', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const m = styles.match(/^\.nav-cta\s*\{([^}]*)\}/m);
    assert.ok(m, '.nav-cta rule found');
    assert.match(m[1], /min-height:\s*36px/, '.nav-cta min-height is >= 36px');
  });
});

describe('SITE-SYSTEM item 1: one section-h2 and one closing-CTA-h2 token', () => {
  it('styles.css defines --h2-section and --h2-cta exactly once each, in :root', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    assert.equal((styles.match(/--h2-section:/g) || []).length, 1);
    assert.equal((styles.match(/--h2-cta:/g) || []).length, 1);
  });

  it('every closing-CTA section selector shares the one --h2-cta rule', () => {
    const styles = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
    const ctaBlock = styles.match(/#footer-cta h2,\s*\n\.hiw-cta-section h2,\s*\n\.agent-cta-section h2,\s*\n\.pricing-cta-section h2,\s*\n\.api-cta-section h2\s*\{([^}]*)\}/);
    assert.ok(ctaBlock, 'the consolidated closing-CTA selector list exists');
    assert.match(ctaBlock[1], /var\(--h2-cta\)/, 'the consolidated rule uses the --h2-cta token');
  });
});
