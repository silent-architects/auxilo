'use strict';

/**
 * test/for-agents-page-design.test.js
 *
 * Guards the design pass on public/for-agents.html (the /for-agents page):
 *   - a dark hero beside the exchange drawing, a dark figures band, then light sections that
 *     alternate paper and tint, then a dark close;
 *   - the live figures strip and the server-rendered catalog band keep every hook the server
 *     and the scripts read (ids, comment markers, the SSR placeholder inside its element);
 *   - the five discovery cards carry no visible numeral, and each ends in its tag;
 *   - no inline colour or layout style in the body, no raw brand-constant colour tokens and no
 *     weight above 400 on a mono rule in the page's own style block.
 * Strings, ids and scripts are pinned by the older suites (launch-wave-for-agents, ask-wave-b,
 * seo-baseline, faq-consolidation, title-case-sweep); this file only pins the structure.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'for-agents.html'), 'utf8');
const STYLE = (HTML.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1];
const MAIN = (HTML.match(/<main id="main">([\s\S]*?)<\/main>/) || [, ''])[1];

function sectionClasses() {
  const out = [];
  const re = /<section\b([^>]*)>/g;
  let m;
  while ((m = re.exec(MAIN))) {
    out.push((m[1].match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/).filter(Boolean));
  }
  return out;
}

describe('for-agents.html design pass: grounds and the hero', () => {
  it('positive control: the page has eight sections inside main', () => {
    assert.equal(sectionClasses().length, 8);
  });

  it('opens dark with the figures band, alternates paper and tint, and closes dark', () => {
    const grounds = sectionClasses().map((cls) => (cls.includes('on-dark') ? 'dark' : cls.includes('on-tint') ? 'tint' : 'paper'));
    assert.deepEqual(grounds, ['dark', 'dark', 'paper', 'tint', 'paper', 'tint', 'paper', 'dark']);
  });

  it('no dark-era ground class or raised/ground section class remains', () => {
    assert.doesNotMatch(MAIN, /section-raised|section-ground/);
    assert.doesNotMatch(STYLE, /section-raised|section-ground/);
  });

  it('the hero is the shared hero grid: copy first, then the exchange drawing', () => {
    const hero = MAIN.match(/<section class="page-hero on-dark" id="page-hero"[\s\S]*?<\/section>/)[0];
    assert.match(hero, /<div class="container hero-grid page-hero-content">/);
    assert.ok(hero.indexOf('<h1 id="page-hero-heading">') < hero.indexOf('<div class="hx"'), 'copy column comes before the drawing in the source');
    assert.match(hero, /<a href="\/connect" class="btn-primary">Install the MCP Server<\/a>\s*<a href="\/how-it-works" class="btn-secondary">See How It Works<\/a>/);
  });

  it('the exchange drawing keeps its accessible name and its three labels, and holds only ruled content', () => {
    const open = '<div class="hx" role="img" aria-label="How your agent gets a learning another agent published">';
    const at = MAIN.indexOf(open);
    assert.notEqual(at, -1);
    const drawing = MAIN.slice(at, MAIN.indexOf('</section>', at));
    for (const label of ['Another agent already solved it', 'Your agent asks Auxilo', 'Your agent sees a preview free and pays to unlock it']) {
      assert.ok(drawing.includes(`</svg>${label}</div>`), `label present: ${label}`);
    }
    const text = drawing.replace(/<[^>]+>/g, ' ');
    assert.ok(!/\d/.test(text), 'no digit inside the drawing (no number, price or date)');
    assert.ok(text.includes('auxilo_knowledge') && text.includes('auxilo_unlock'), 'the real tool names are there');
    assert.ok(text.includes('Pinecone upsert requires vectors array not a single vector object'), 'the one catalog title is a ruled real title');
    assert.ok(!/<text\b/.test(drawing), 'no SVG text in the drawing');
  });
});

describe('for-agents.html design pass: live figures and the catalog band keep their server hooks', () => {
  it('the figures band is a dark section directly after the hero, holding the four ids and the price-range comment pair around its own cell', () => {
    const band = MAIN.match(/<section id="catalog-stats" class="on-dark"[\s\S]*?<\/section>/)[0];
    assert.match(band, /<span class="stats-strip-num pull-stat-num" id="lc-learnings"><\/span>/);
    assert.match(band, /<span class="stats-strip-num pull-stat-secondary" id="lc-categories">6<\/span>/);
    assert.match(band, /<!--LC-PRICE-RANGE-CELL-->\s*<div class="cat-stat">\s*<span class="stats-strip-num pull-stat-secondary" id="lc-price-range"><\/span>\s*<span class="stats-strip-label pull-stat-caption">Current unlock price range<\/span>\s*<\/div>\s*<!--\/LC-PRICE-RANGE-CELL-->/);
    assert.equal(sectionClasses()[1].join(' '), 'on-dark', 'the band is the second section, right under the hero');
  });

  it('the catalog band keeps the SSR placeholder alone inside its own element, ahead of its note', () => {
    assert.match(MAIN, /<div class="discovery-band" aria-label="Recent learnings from the live catalog">\s*<!-- SSR:RECENT_LEARNINGS -->\s*<\/div>\s*<p class="discovery-band-note">/);
    assert.equal((HTML.match(/<!-- SSR:RECENT_LEARNINGS -->/g) || []).length, 1);
  });

  it('every server-filled id occurs once, in a real opening tag', () => {
    for (const id of ['lc-learnings', 'lc-categories', 'lc-price-range']) {
      assert.equal((HTML.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `${id} appears exactly once`);
    }
  });
});

describe('for-agents.html design pass: the five discovery cards', () => {
  // Round 3: the list is a role="list" and each card a role="listitem"; each card is a dark drawing
  // (.step-art) over its text (.step-body), and the text ends in the tag.
  const track = (MAIN.match(/<div class="flow-track"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/) || [, ''])[1];
  const steps = [...track.matchAll(/<div class="flow-step"[^>]*>([\s\S]*?)<\/div>\s*(?=<!--|<div class="flow-step"|$)/g)].map((m) => m[1]);

  it('positive control: five cards, in order Search, Preview, Unlock, Use, Share', () => {
    assert.equal(steps.length, 5);
    assert.deepEqual(steps.map((s) => (s.match(/<h3>([^<]+)<\/h3>/) || [])[1]), ['Search', 'Preview', 'Unlock', 'Use', 'Share']);
  });

  it('the cards are a list: role="list" on the track and role="listitem" on each of the five cards', () => {
    assert.match(MAIN, /<div class="flow-track" role="list">/);
    assert.equal((MAIN.match(/<div class="flow-step" role="listitem">/g) || []).length, 5);
    // positive control: the count of plain cards is the same, so the regex above counts real cards
    assert.equal((MAIN.match(/<div class="flow-step"/g) || []).length, 5);
  });

  it('each card ends in its tag, and the ornamental step numbers are gone from the markup and from the page block', () => {
    assert.deepEqual(steps.map((s) => (s.match(/<span class="flow-step-tag (free|paid)">([^<]+)<\/span>\s*(?:<\/div>\s*)?$/) || [])[2]), ['free', 'free', 'paid', 'immediate', 'free']);
    // positive control: each card opens on its drawing, its text opens on the h3, and the tag rule is still in the page block
    assert.equal(steps.filter((s) => /^\s*<div class="step-art" aria-hidden="true">/.test(s)).length, 5, 'every card opens on its drawing');
    assert.equal(steps.filter((s) => /<div class="step-body">\s*<h3>/.test(s)).length, 5, 'every card text opens on its h3');
    assert.match(STYLE, /\.flow-step-tag\s*\{/, 'positive control: the tag rule is still in the page block');
    assert.doesNotMatch(HTML, /flow-step-num/, 'no step number element or rule remains');
    assert.doesNotMatch(track, />\s*0[1-5]\s*</, 'no 01 to 05 numeral remains in the cards');
  });

  it('each drawing holds only its own card\'s tool and path names and skeleton bars', () => {
    const art = (s) => (s.match(/<div class="step-art"[\s\S]*?<\/div><\/div>\s*(?=<div class="step-body">)/) || [''])[0];
    const names = (html) => [...html.replace(/<[^>]+>/g, ' ').matchAll(/[\w/:.-]+/g)].map((m) => m[0]).filter((w) => /^(auxilo_\w+|\/[\w/:]+)$/.test(w));
    const body = (s) => (s.match(/<p>([\s\S]*?)<\/p>/) || [, ''])[1];
    steps.forEach((s, i) => {
      const drawn = names(art(s));
      const own = names(body(s));
      for (const n of drawn) assert.ok(own.includes(n), `card ${i + 1} draws ${n}, which is not named in its own text`);
      assert.ok(!/\d/.test(art(s).replace(/<[^>]+>/g, '')), `card ${i + 1} drawing carries no digit`);
      assert.ok(/class="dw-sk/.test(art(s)), `card ${i + 1} drawing has skeleton bars`);
    });
    // positive control: the search, unlock and share drawings do name their tools and paths
    assert.deepEqual(names(art(steps[0])), ['auxilo_knowledge', '/knowledge']);
    assert.deepEqual(names(art(steps[2])), ['auxilo_unlock', '/knowledge/:id']);
    assert.deepEqual(names(art(steps[4])), ['auxilo_contribute', '/learn']);
  });

  it('the grid is three over two: six columns, two columns each for the first three cards and three each for the last two', () => {
    assert.match(STYLE, /\.flow-track\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(STYLE, /\.flow-step\s*\{[^}]*grid-column:\s*span 2/);
    assert.match(STYLE, /\.flow-step:nth-child\(n\+4\)\s*\{\s*grid-column:\s*span 3;\s*\}/);
  });

  it('inline code inside a card is plain code (no inline colour), styled as a chip by the page block', () => {
    assert.doesNotMatch(track, /<code[^>]*style=/);
    assert.match(STYLE, /\.flow-step code[\s\S]*?background:\s*var\(--tint\)/);
  });
});

describe('for-agents.html design pass: no decoration carried over from the dark era', () => {
  it('the only inline style left on the page is the footer mark outside main', () => {
    assert.doesNotMatch(MAIN, /\sstyle="/);
    assert.match(HTML, /<svg style="width:20px;height:20px"/, 'positive control: the footer mark keeps its own sizing');
  });

  it('the page style block uses no raw brand-constant colour tokens and no old component classes', () => {
    assert.doesNotMatch(STYLE, /var\(--(ivory|slate|slate-text|ash|obsidian|aurum|aurum-dim|aurum-border|code-bg)\)/);
    assert.doesNotMatch(STYLE, /\.stats-strip(?!-num|-label)|\.ledger-strip|\.auth-trait-list li\s*\{[^}]*border-left/);
    assert.match(STYLE, /var\(--fg-1\)/, 'positive control: the ground-aware tokens are what it does use');
    assert.match(STYLE, /var\(--line\)/);
  });

  it('no mono or serif rule asks for a weight above 400, and no heading rule asks for one above 500', () => {
    const rules = [...STYLE.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    assert.ok(rules.length > 40, 'positive control: the block parses into rules');
    for (const [, selector, body] of rules) {
      if (/var\(--mono\)|var\(--serif\)/.test(body)) {
        assert.doesNotMatch(body, /font-weight:\s*(5|6|7|8|9)00/, `weight on ${selector.trim()}`);
      }
      if (/(^|[\s,])h[1-3]\b/.test(selector)) {
        assert.doesNotMatch(body, /font-weight:\s*(6|7|8|9)00/, `weight on ${selector.trim()}`);
      }
    }
  });

  it('the featured payment card is marked by a full 1px ink border (no tapering 2px top edge), not a gold one', () => {
    const rule = STYLE.match(/\.auth-compare-card\.featured\s*\{([^}]*)\}/);
    assert.ok(rule);
    assert.match(rule[1], /border-color:\s*var\(--fg-1\)/);
    const card = STYLE.match(/\.auth-compare-card\s*\{([^}]*)\}/);
    assert.ok(card, 'positive control: the base card rule is in the page block');
    assert.match(card[1], /border:\s*1px solid var\(--line\)/);
    assert.doesNotMatch(card[1], /border-top/, 'no separate top edge on the card');
    assert.doesNotMatch(STYLE, /aurum|accent-text[^;]*;[^}]*auth-compare/);
  });

  it('the lists styled without markers are lists to assistive technology', () => {
    assert.equal((MAIN.match(/<ul class="auth-trait-list" role="list">/g) || []).length, 2);
    assert.match(MAIN, /<ul class="endpoint-list" aria-label="Core API endpoints" role="list">/);
    // positive control: the page holds exactly these three unordered lists inside main
    assert.equal((MAIN.match(/<ul\b/g) || []).length, 3);
  });

  it('the figures band numerals scale from 30 to 44 and no figure beside the gold button is gold', () => {
    const rule = STYLE.match(/#catalog-stats \.stats-strip-num\s*\{([^}]*)\}/);
    assert.ok(rule);
    assert.match(rule[1], /font-size:\s*clamp\(30px,\s*3\.4vw,\s*44px\)/);
    assert.doesNotMatch(STYLE, /#catalog-stats #lc-learnings\s*\{[^}]*accent-text/);
    // positive control: the figure is still the one the server fills
    assert.match(MAIN, /id="lc-learnings"/);
  });

  it('motion lives only inside the drawing, inside the reduced-motion guard', () => {
    const animated = [...STYLE.matchAll(/animation:[^;]+;/g)];
    assert.ok(animated.length > 0, 'positive control: the drawing does animate');
    const guarded = STYLE.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n    \}\n/)[1];
    for (const [rule] of animated) assert.ok(guarded.includes(rule), `animation sits inside the guard: ${rule}`);
    assert.doesNotMatch(STYLE, /transition:/, 'no hover or scroll transition on a card');
  });
});
