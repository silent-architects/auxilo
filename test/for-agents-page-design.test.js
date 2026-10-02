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
  const track = (MAIN.match(/<div class="flow-track">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/) || [, ''])[1];
  const steps = [...track.matchAll(/<div class="flow-step">([\s\S]*?)<\/div>\s*(?=<!--|<div class="flow-step">|$)/g)].map((m) => m[1]);

  it('positive control: five cards, in order Search, Preview, Unlock, Use, Share', () => {
    assert.equal(steps.length, 5);
    assert.deepEqual(steps.map((s) => (s.match(/<h3>([^<]+)<\/h3>/) || [])[1]), ['Search', 'Preview', 'Unlock', 'Use', 'Share']);
  });

  it('each card ends in its tag, and the step numbers stay in the text but are taken out of the picture', () => {
    assert.deepEqual(steps.map((s) => (s.match(/<span class="flow-step-tag (free|paid)">([^<]+)<\/span>\s*$/) || [])[2]), ['free', 'free', 'paid', 'immediate', 'free']);
    const hide = STYLE.match(/\.flow-step-num\s*\{([^}]*)\}/);
    assert.ok(hide, 'the step number rule is in the page block');
    assert.match(hide[1], /position:\s*absolute/);
    assert.match(hide[1], /clip:\s*rect\(0,\s*0,\s*0,\s*0\)/);
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

  it('the featured payment card is marked by an ink top edge, not a gold one', () => {
    const rule = STYLE.match(/\.auth-compare-card\.featured\s*\{([^}]*)\}/);
    assert.ok(rule);
    assert.match(rule[1], /border-top-color:\s*var\(--fg-1\)/);
    assert.doesNotMatch(STYLE, /aurum|accent-text[^;]*;[^}]*auth-compare/);
  });

  it('motion lives only inside the drawing, inside the reduced-motion guard', () => {
    const animated = [...STYLE.matchAll(/animation:[^;]+;/g)];
    assert.ok(animated.length > 0, 'positive control: the drawing does animate');
    const guarded = STYLE.match(/@media \(prefers-reduced-motion: no-preference\) \{([\s\S]*?)\n    \}\n/)[1];
    for (const [rule] of animated) assert.ok(guarded.includes(rule), `animation sits inside the guard: ${rule}`);
    assert.doesNotMatch(STYLE, /transition:/, 'no hover or scroll transition on a card');
  });
});
