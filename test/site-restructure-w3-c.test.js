'use strict';

/**
 * test/site-restructure-w3-c.test.js — SITE-RESTRUCTURE-W3 item C
 * (2026-09-07, Tyler-approved: "pricing 9→6 sections: tiers into
 * pricing-works, packs into for-agents, The Numbers cut").
 *
 * ~/.auxilo/handoffs/SITE-RESTRUCTURE-W3-SPEC-2026-09-07.md, section C.
 * Builds on top of SITE-RESTRUCTURE-W3 item A (FAQ consolidation, agent/w3-a
 * / test/faq-consolidation.test.js), which this branch forked from.
 *
 * Three merges on /pricing only:
 *   C1. #value-tiers (its own h2/section) folds into #how-pricing-works as
 *       an h3 sub-heading ("Value Tiers"), reusing this page's existing
 *       sub-block label pattern (same inline style as "Payment Methods").
 *       Table and its surrounding paragraphs carried byte-identical.
 *   C2. #credit-packs (its own h2/section) folds into #for-agents-pricing,
 *       below Payment Methods, demoted to an h3. The three "Buy credits"
 *       buttons — real money — keep identical markup, ids, hrefs/handlers,
 *       and labels. The intro paragraph's trailing "Credits never expire."
 *       is cut (a deletion per spec, not composed copy — the free-tier
 *       note directly below still states it).
 *   C3. #platform-economics ("The Numbers") is cut entirely. Its 3
 *       static/gated econ cards (price range, builder cut, search cost)
 *       are pure repetition and cut with no replacement. Its 3 live-ledger
 *       cards (Learnings Live, Unlocks, Categories) plus the as-of span
 *       and disclaimer paragraphs move to the hero, markup/ids/marker-
 *       comments unchanged so renderLiveCatalogStats' SSR fill still
 *       resolves (see test/pricing-live-range.test.js's behavioral guard
 *       for a live-boot proof of that binding).
 *
 * Net: 9 top-level sections -> 6 (hero, how-pricing-works, for-agents-
 * pricing, for-builders-pricing, faq, pricing-cta). 7 h2s -> 5 (credits-
 * heading and economics-heading are gone; how-pricing-heading, agents-
 * pricing-heading, builders-pricing-heading, faq-heading, pricing-cta-
 * heading remain).
 *
 * BACKGROUND ALTERNATION: folding #value-tiers (was section-ground) into
 * #how-pricing-works (section-raised) and #credit-packs (was
 * section-ground) into #for-agents-pricing (was section-raised), plus
 * cutting #platform-economics (was section-ground) entirely, would have
 * left 5 straight section-raised sections in a row (how-pricing-works,
 * for-agents-pricing, for-builders-pricing, faq, pricing-cta all started
 * raised) — breaking the sitewide "strict A/B/A/B" rhythm rule
 * (public/styles.css "Section Rhythm" comment). Re-alternated here:
 * for-agents-pricing and faq flip to section-ground; how-pricing-works,
 * for-builders-pricing, and pricing-cta stay section-raised. Computed
 * backgrounds (public/styles.css): section-raised = rgba(255,255,255,
 * 0.065) tint + rgba(229,229,227,0.13) hairline borders; section-ground =
 * var(--obsidian) (plain, no border).
 *
 * COMPOSE NOTHING: every surviving text node from agent/w3-a's
 * pricing.html is carried byte-identical into this version except the one
 * authorized deletion (the "Credits never expire." clause cut per C2) and
 * the wholesale removal of "The Numbers" section's own text (cut per C3,
 * no replacement). No transitional or new copy was composed for this
 * item's structural moves.
 *
 * Runner: node --test test/site-restructure-w3-c.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PRICING_PATH = path.join(REPO, 'public', 'pricing.html');
const pricing = fs.readFileSync(PRICING_PATH, 'utf8');

describe('SITE-RESTRUCTURE-W3 item C — /pricing 9 -> 6 sections', () => {
  it('the page has exactly five h2 elements', () => {
    const h2Count = (pricing.match(/<h2\b/g) || []).length;
    assert.equal(h2Count, 5, 'pricing.html should have 5 h2s after item C');
  });

  it('the five h2s are the expected ones, in order', () => {
    const ids = [...pricing.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, [
      'how-pricing-heading',
      'agents-pricing-heading',
      'builders-pricing-heading',
      'faq-heading',
      'pricing-cta-heading',
    ]);
  });

  it('"Value Tiers" and "Credit Packs" survive as h3s, not h2s', () => {
    assert.equal(pricing.match(/<h2[^>]*>Value Tiers<\/h2>/), null);
    assert.equal(pricing.match(/<h2[^>]*>Credit Packs<\/h2>/), null);
    assert.match(pricing, /<h3[^>]*id="tiers-heading"[^>]*>Value Tiers<\/h3>/);
    assert.match(pricing, /<h3[^>]*id="credits-heading"[^>]*>Credit Packs<\/h3>/);
  });

  it('"The Numbers" heading and section element are gone entirely (build comments may still name the retired id in prose)', () => {
    assert.equal(pricing.match(/<h2[^>]*>The Numbers<\/h2>/), null);
    assert.equal(pricing.match(/<section id="platform-economics"/), null);
    assert.equal(pricing.match(/<h2[^>]*id="economics-heading"/), null);
  });

  it('the standalone #value-tiers and #credit-packs section elements are gone (folded, not just relabeled — build comments may still name the retired ids in prose)', () => {
    assert.equal(pricing.match(/<section id="value-tiers"/), null);
    assert.equal(pricing.match(/<section id="credit-packs"/), null);
  });

  // Design rebuild: the hero is a dark <section> of its own, so six <section id> elements remain.
  it('exactly six top-level sections remain: the dark hero section plus 5 body <section id> elements', () => {
    assert.match(pricing, /<section id="pricing-hero" class="pricing-page-header on-dark"/);
    const sectionIds = [...pricing.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sectionIds, [
      'pricing-hero',
      'how-pricing-works',
      'for-agents-pricing',
      'for-builders-pricing',
      'faq',
      'pricing-cta',
    ]);
  });

  it('"Value Tiers" now lives inside #how-pricing-works', () => {
    const section = pricing.match(/<section id="how-pricing-works"[\s\S]*?<\/section>/);
    assert.ok(section, 'expected #how-pricing-works section');
    assert.match(section[0], /<h3[^>]*id="tiers-heading"[^>]*>Value Tiers<\/h3>/);
    assert.match(section[0], /<table class="value-tiers-table">/);
  });

  it('"Credit Packs" now lives inside #for-agents-pricing, below Payment Methods', () => {
    const section = pricing.match(/<section id="for-agents-pricing"[\s\S]*?<\/section>/);
    assert.ok(section, 'expected #for-agents-pricing section');
    assert.match(section[0], /<h3[^>]*id="credits-heading"[^>]*>Credit Packs<\/h3>/);
    const paymentIdx = section[0].indexOf('Payment Methods');
    const packsIdx = section[0].indexOf('Credit Packs');
    assert.ok(paymentIdx !== -1 && packsIdx !== -1 && paymentIdx < packsIdx,
      'Credit Packs must sit below Payment Methods within the section');
  });

  // Design rebuild: the grounds are the design system's classes. The dark hero opens the page,
  // the body alternates paper and tint, and the closing ask is dark again.
  it('the grounds run dark, paper, tint, paper, tint, dark down the page and no two neighbours share one', () => {
    const expected = [
      ['pricing-hero', 'dark'],
      ['how-pricing-works', 'paper'],
      ['for-agents-pricing', 'tint'],
      ['for-builders-pricing', 'paper'],
      ['faq', 'tint'],
      ['pricing-cta', 'dark'],
    ];
    const groundOf = (id) => {
      const tag = pricing.match(new RegExp(`<section id="${id}"[^>]*>`));
      assert.ok(tag, `expected <section id="${id}">`);
      const cls = (tag[0].match(/class="([^"]*)"/) || [null, ''])[1].split(/\s+/);
      assert.ok(!cls.includes('section-raised') && !cls.includes('section-ground'), `#${id} carries a retired ground class`);
      if (cls.includes('on-dark')) return 'dark';
      if (cls.includes('on-tint')) return 'tint';
      return 'paper';
    };
    for (const [id, ground] of expected) {
      assert.equal(groundOf(id), ground, `#${id} must sit on ${ground}`);
    }
    // No two adjacent sections share a ground.
    const grounds = expected.map(([id]) => groundOf(id));
    for (let i = 1; i < grounds.length; i++) {
      assert.notEqual(grounds[i], grounds[i - 1], `sections at index ${i - 1} and ${i} must alternate`);
    }
  });

  it('the three "Buy pack" pack buttons are present, byte-identical to their pre-move markup except the credits-as-cash C-30 label (real money — same assertion agent/w3-a\'s ASK-WAVE-B guard made before item C)', () => {
    const buttons = [
      '<button type="button" class="btn-primary pack-buy-btn" data-pack="starter" style="display:none" onclick="auxiloBuyCredits(\'starter\')">Buy pack</button>',
      '<button type="button" class="btn-primary pack-buy-btn" data-pack="growth" style="display:none" onclick="auxiloBuyCredits(\'growth\')">Buy pack</button>',
      '<button type="button" class="btn-primary pack-buy-btn" data-pack="pro" style="display:none" onclick="auxiloBuyCredits(\'pro\')">Buy pack</button>',
    ];
    for (const btn of buttons) {
      assert.equal(pricing.split(btn).length - 1, 1, `expected exactly one occurrence of: ${btn}`);
    }
    assert.equal((pricing.match(/class="btn-primary pack-buy-btn"/g) || []).length, 3);
  });

  it('the credits intro paragraph lost only its trailing "Credits never expire." clause (a cut, not composed copy) — the free-tier note below still states it', () => {
    const OLD = "For builders and agents who'd rather authenticate with an API key than use x402. Fund your account once and unlock as you go. Credits never expire.";
    const NEW = "For builders and agents who'd rather authenticate with an API key than use x402. Fund your account once and unlock as you go.";
    assert.equal(pricing.includes(OLD), false, 'the old, un-cut sentence must not remain');
    assert.equal(pricing.split(NEW).length - 1, 1, 'the cut sentence must appear exactly once');
    assert.match(pricing, /Your balance pays only for unlocks, and it never expires\./,
      'the free-tier note below the pack cards still states the balance never expires (credits-as-cash C-35 rewords it)');
  });

  it('VISION PASS (V-20/V-21): the live-ledger stat strip and its marker comments are gone from the hero entirely, no <a>/<button> (ask-wave.test.js\'s existing "pricing hero ships no action" invariant still holds)', () => {
    const heroStart = pricing.indexOf('<section id="pricing-hero" class="pricing-page-header on-dark"');
    const firstSectionStart = pricing.indexOf('<section id="how-pricing-works"');
    assert.ok(heroStart !== -1 && firstSectionStart !== -1 && heroStart < firstSectionStart,
      'expected the pricing hero block before the first <section>');
    const hero = pricing.slice(heroStart, firstSectionStart);
    assert.ok(!hero.includes('LC-PRICING-LEDGER-TILE'), 'the ledger tile and its marker comments are gone, not just emptied');
    assert.ok(!hero.includes('id="lc-learnings"'), 'no lc-learnings element in the hero');
    assert.ok(!hero.includes('id="lc-unlocks"'), 'no lc-unlocks element in the hero');
    assert.ok(!hero.includes('id="lc-categories"'), 'no lc-categories element in the hero');
    assert.ok(!hero.includes('id="lc-asof"'), 'no lc-asof element in the hero (V-21 cut its whole cell with the tile)');
    assert.ok(!hero.includes('chart-disclaimer'), 'V-21: "Live from the Auxilo ledger, updates automatically." and its wrapper class are gone');
    assert.equal(hero.includes('id="hero-ledger"'), false, 'the old single-stat hero-ledger widget stays retired');
    assert.equal(/<a\s/.test(hero), false, 'the pricing hero must carry no <a> element');
    assert.equal(/<button\s/.test(hero), false, 'the pricing hero must carry no <button> element');
    // Positive control: the hero's own h1/sub text is still there, proving
    // this slice is not accidentally empty.
    assert.ok(hero.includes('Search free. Pay only when you unlock, from $0.05.'), 'positive control: hero h1 text present');
  });
});

// Design rebuild, cold-reader fix: /pricing was the one centred hero on the site. It is left aligned, like every
// other page. Round 3: the copy sits beside the tier drawing (the shared hero-grid), flush left in its column.
describe('/pricing hero is left aligned like every other hero', { timeout: 120_000 }, () => {
  const http = require('node:http');
  const STYLES = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
  const heroStart = pricing.indexOf('<section id="pricing-hero"');
  const hero = pricing.slice(heroStart, pricing.indexOf('<section id="how-pricing-works"'));
  const styleBlock = pricing.slice(pricing.indexOf('<style>'), pricing.indexOf('</style>'));

  it('the hero container is the shared hero-grid with the copy in its own column and no centring class, and the page block sets no hero width or alignment of its own', () => {
    assert.match(hero, /<div class="container hero-grid">\s*<div class="pricing-hero-copy">/, 'the hero uses the shared hero-grid layout, the copy first');
    assert.doesNotMatch(hero, /hero-one/, 'the copy-alone layout is gone from the hero');
    assert.doesNotMatch(hero, /hero-centred/, 'no centring class on the hero');
    assert.doesNotMatch(styleBlock, /hero-centred/, 'the page block does not centre the hero');
    const heroRules = styleBlock.match(/\.pricing-page-header[^{]*\{[^}]*\}/g) || [];
    assert.ok(heroRules.length > 0, 'positive control: the page block still styles the hero paragraphs');
    for (const rule of heroRules) {
      assert.doesNotMatch(rule, /max-width|text-align|margin-(left|right)|text-wrap:\s*balance/, `the hero rule leaves width and alignment to the shared sheet: ${rule}`);
    }
    assert.match(STYLES, /^\.hero-grid\s*\{/m, 'positive control: the shared sheet defines .hero-grid');
  });

  it('the hero drawing lists the four tiers and ranges exactly as the table names them, in the same order, and is hidden from assistive technology', () => {
    const panel = hero.match(/<div class="dw-panel dw-dark pricing-tier-panel" aria-hidden="true">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/);
    assert.ok(panel, 'the hero carries a dark panel marked aria-hidden="true"');
    const drawn = [...panel[1].matchAll(/<span class="pt-name">([^<]+)<\/span><span class="pt-range">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    const tableAt = pricing.indexOf('<table class="value-tiers-table">');
    const table = pricing.slice(tableAt, pricing.indexOf('</table>', tableAt));
    const real = [...table.matchAll(/<td class="tier-name">([^<]+)<\/td>\s*<td>[^<]*<\/td>\s*<td class="price-range">([^<]+)<\/td>/g)].map((m) => [m[1], m[2]]);
    assert.equal(real.length, 4, 'positive control: the table holds the four tiers');
    assert.deepEqual(drawn, real, 'the drawing repeats the table\'s tier names and ranges exactly');
    assert.doesNotMatch(panel[1], /<(a|button|h[1-6]|p)[\s>]/, 'the drawing is spans and divs only: no link, button, heading or paragraph');
  });

  it('rendered at 1280 and 375, the h1 and both paragraphs start at the same left edge, are left aligned, and fit the 720 copy width', async (t) => {
    let chromium;
    try { ({ chromium } = require(require.resolve('playwright', { paths: [REPO] }))); } catch (e) { t.skip('playwright not resolvable'); return; }
    const publicDir = path.join(REPO, 'public');
    const MIME = { '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.js': 'application/javascript' };
    const server = http.createServer((req, res) => {
      const filePath = path.join(publicDir, decodeURIComponent(req.url.split('?')[0]));
      if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await chromium.launch();
      for (const width of [1280, 375]) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 } });
        const page = await ctx.newPage();
        await page.goto(`http://127.0.0.1:${server.address().port}/pricing.html`, { waitUntil: 'networkidle' });
        const m = await page.evaluate(() => {
          const box = document.querySelector('#pricing-hero .container');
          const cs = getComputedStyle(box);
          const edge = box.getBoundingClientRect().left + parseFloat(cs.paddingLeft);
          const els = [...document.querySelectorAll('#pricing-hero h1, #pricing-hero p')];
          return {
            edge,
            els: els.map((el) => ({ tag: el.tagName, left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width, align: getComputedStyle(el).textAlign })),
          };
        });
        await ctx.close();
        assert.equal(m.els.length, 3, `${width}: positive control: the h1 and two paragraphs`);
        for (const el of m.els) {
          assert.ok(['start', 'left'].includes(el.align), `${width}: ${el.tag} is left aligned, got ${el.align}`);
          assert.ok(Math.abs(el.left - m.edge) <= 0.5, `${width}: ${el.tag} starts at the container's left edge (${el.left} vs ${m.edge})`);
          assert.ok(el.width <= 720 + 0.5, `${width}: ${el.tag} fits the shared 720 copy width, got ${el.width}`);
        }
      }
    } finally {
      if (browser) await browser.close();
      server.close();
    }
  });
});
