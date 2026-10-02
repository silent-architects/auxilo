'use strict';

/**
 * test/reading-pages-design.test.js
 *
 * Static guards for the three reading pages after the design pass: /about,
 * /writing and the essay at /writing/agents-message-board. Every assertion is
 * checkable from the bytes on disk, so no server and no browser is needed.
 *
 *   1. The first section is dark and holds the h1; after it the light sections
 *      alternate paper and tint, and no two neighbours share a ground.
 *   2. The head preloads the Newsreader display face once and no longer names
 *      the retired Plex Mono 500 face.
 *   3. The page's own style block uses the ground-aware tokens only (no hex
 *      colour, none of the dark-era colour names) and asks for no weight above 500.
 *   4. The essay's paragraphs are untouched: same count, same bytes (pinned by
 *      hash). An edit to the essay text on purpose updates the hash here.
 *
 * Runner: node --test test/reading-pages-design.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PAGES = [
  'about.html',
  path.join('writing', 'index.html'),
  'writing-agents-message-board.html',
];

function read(rel) {
  return fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
}

function styleBlocks(html) {
  return [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
}

// The ground of each <section> inside <main>, in document order.
function sectionGrounds(html) {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  return [...main.matchAll(/<section\b([^>]*)>/g)].map((m) => {
    const cls = (m[1].match(/class="([^"]*)"/) || [null, ''])[1].split(/\s+/);
    if (cls.includes('on-dark')) return 'dark';
    if (cls.includes('on-tint')) return 'tint';
    return 'paper';
  });
}

describe('Reading pages: dark first screen, light body in alternating grounds', () => {
  for (const page of PAGES) {
    it(`${page}: the first section is dark and holds the h1`, () => {
      const html = read(page);
      const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
      const first = main.match(/<section\b[^>]*>[\s\S]*?<\/section>/);
      assert.ok(first, 'a first section exists');
      assert.match(first[0], /^<section\b[^>]*class="[^"]*\bon-dark\b/, 'the first section is on-dark');
      assert.match(first[0], /<h1[\s>]/, 'the h1 is inside the first section');
      // Positive control for the "one h1" half: there is exactly one in the page.
      assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
    });

    it(`${page}: after the dark first screen the grounds never repeat back to back`, () => {
      const grounds = sectionGrounds(read(page));
      assert.ok(grounds.length >= 2, 'at least a hero and a body section');
      assert.equal(grounds[0], 'dark');
      for (let i = 1; i < grounds.length; i++) {
        assert.notEqual(grounds[i], grounds[i - 1], `section ${i} repeats the ground of section ${i - 1} (${grounds[i]})`);
      }
      assert.notEqual(grounds[1], 'dark', 'the body is light');
    });

    it(`${page}: preloads the Newsreader display face once, and not the retired Plex Mono 500`, () => {
      const html = read(page);
      const link = '<link rel="preload" href="/fonts/NewsreaderDisplay300.a07d3c5c.woff2" as="font" type="font/woff2" crossorigin />';
      assert.equal(html.split(link).length - 1, 1, 'one Newsreader preload');
      assert.ok(!/PlexMono500/.test(html), 'no Plex Mono 500 reference');
      // Positive control: the faces the page still uses stay preloaded.
      assert.match(html, /ArchivoVariable\.[0-9a-f]{8}\.woff2/);
    });

    it(`${page}: the page style block uses ground-aware tokens only and no weight above 500`, () => {
      const css = styleBlocks(read(page));
      assert.ok(css.length > 0, 'the page has a style block');
      // Positive control: the block does use the tokens.
      assert.match(css, /var\(--fg-[123]\)/);
      assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no hex colour in the page block');
      assert.doesNotMatch(css, /var\(--(ivory|slate|ash|obsidian|aurum)\)/, 'no dark-era colour names');
      for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) {
        assert.ok(Number(m[1]) <= 500, `font-weight ${m[1]} is above 500`);
      }
    });

    it(`${page}: no inline style attribute sets a colour`, () => {
      const html = read(page);
      const body = html.slice(html.lastIndexOf('</head>'));
      for (const m of body.matchAll(/\sstyle="([^"]*)"/g)) {
        assert.doesNotMatch(m[1], /color|background/i, `inline style sets a colour: ${m[1]}`);
      }
    });
  }
});

describe('The essay: set differently, worded the same', () => {
  const ESSAY = 'writing-agents-message-board.html';

  it('keeps its thirteen paragraphs byte for byte', () => {
    const html = read(ESSAY);
    const article = html.match(/<article[^>]*>([\s\S]*?)<\/article>/)[1];
    const paragraphs = [...article.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1]);
    assert.equal(paragraphs.length, 13);
    const hash = crypto.createHash('sha256').update(paragraphs.join('\n')).digest('hex');
    assert.equal(hash, '4900b5091f143c85921d51ef7f919f5b5ef77183a20222ee0b09cddc08c2b385');
  });

  it('sets the headline at the section-heading size, never wider than 22em', () => {
    const css = styleBlocks(read(ESSAY));
    const rule = css.match(/#essay-hero h1\s*\{([^}]*)\}/);
    assert.ok(rule, 'the headline rule exists');
    assert.match(rule[1], /max-width:\s*22em/);
    assert.match(rule[1], /font-size:\s*var\(--h2-section\)/);
  });

  it('keeps its reading column at 680 wide and its body type at 18px on a 1.7 line', () => {
    const css = styleBlocks(read(ESSAY));
    assert.match(css, /\.essay-body > \*\s*\{\s*max-width:\s*680px;\s*\}/);
    assert.match(css, /\.essay-body p\s*\{[^}]*font-size:\s*18px;[^}]*line-height:\s*1\.7;/);
  });
});
