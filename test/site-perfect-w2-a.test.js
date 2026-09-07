'use strict';

/**
 * test/site-perfect-w2-a.test.js — SITE-PERFECT-W2 item A (2026-09-06,
 * Tyler-approved): cut the homepage "market" section.
 *
 * Homepage section #the-market (h2#market-heading "The agents are already
 * working. What they learn still vanishes.") duplicated the pricing/how-it-
 * works pitch with no claim unique to it and zero inbound links (confirmed
 * by a site-wide `the-market|market-heading` grep before removal). Cut per
 * Tyler's approval, along with its scoped CSS (#the-market h2, .market-copy,
 * .market-copy p, .market-copy p:last-child, and #the-market's entry in the
 * section-raised/explore-section/for-builders/pricing A/B/A/B selector
 * list) — each removed selector's class/id was confirmed to have zero other
 * consumers across public/ before the CSS was deleted.
 *
 * This suite pins the four load-bearing invariants of that cut:
 *   1. the retired heading text is gone from the homepage
 *   2. both ids (#the-market, #market-heading) are gone site-wide (public/,
 *      sitemap.xml, llms.txt — no orphaned anchor/inbound reference)
 *   3. the "Auxilo is a marketplace for what agents learn" sentence still
 *      appears elsewhere on the homepage (the section carried one of
 *      several instances, not the only one)
 *   4. the homepage's top-level <main id="main"> section count is exactly
 *      8 (was 9 before this cut)
 *
 * Mirrors test/nav-wave.test.js's static-check pattern (Part A): plain
 * file reads + regex/DOM-light parsing, no server boot needed since "/"
 * serves public/index.html directly (server.js: app.get('/', ...) ->
 * serveStatic(c, 'index.html')).
 *
 * Runner: node --test test/site-perfect-w2-a.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const INDEX_HTML_PATH = path.join(REPO, 'public', 'index.html');

function readIndexHtml() {
  return fs.readFileSync(INDEX_HTML_PATH, 'utf8');
}

// Counts top-level <section> elements directly inside <main id="main">
// (depth-0 relative to main), the same way the removed section was counted
// as one of the original 9.
function countTopLevelMainSections(html) {
  const mainMatch = html.match(/<main id="main">([\s\S]*?)<\/main>/);
  assert.ok(mainMatch, 'index.html must contain <main id="main">...</main>');
  const body = mainMatch[1];
  let depth = 0;
  let count = 0;
  const tagRe = /<(\/?)section\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(body))) {
    const closing = m[1] === '/';
    if (!closing) {
      if (depth === 0) count++;
      depth++;
    } else {
      depth--;
    }
  }
  return count;
}

describe('SITE-PERFECT-W2 A: homepage "market" section cut', () => {
  it('the retired heading text is absent from public/index.html', () => {
    const html = readIndexHtml();
    // Normalize whitespace/tags the way a rendered heading would read:
    // "The agents are already working.<br>What they learn still vanishes."
    const collapsed = html.replace(/<br\s*\/?>/gi, '').replace(/\s+/g, ' ');
    assert.doesNotMatch(
      collapsed,
      /The agents are already working\.\s*What they learn still vanishes\./,
      'the retired "The agents are already working. What they learn still vanishes." heading must be gone'
    );
  });

  it('both retired ids (#the-market, #market-heading) are absent site-wide (public/, sitemap.xml, llms.txt)', () => {
    let out;
    try {
      out = execFileSync(
        'git',
        ['grep', '-n', '-e', 'the-market', '-e', 'market-heading', '--', 'public', 'sitemap.xml', 'llms.txt'],
        { cwd: REPO, encoding: 'utf8' }
      );
    } catch (err) {
      // git grep exits 1 when there are zero matches -- that's the pass case.
      if (err.status === 1) {
        out = '';
      } else {
        throw err;
      }
    }
    assert.equal(out.trim(), '', `expected zero the-market/market-heading hits, found:\n${out}`);
  });

  it('"Auxilo is a marketplace for what agents learn" still appears at least once on the homepage', () => {
    const html = readIndexHtml();
    const count = (html.match(/Auxilo is a marketplace for what agents learn/g) || []).length;
    assert.ok(count >= 1, `expected >= 1 occurrence of the marketplace sentence, found ${count}`);
  });

  it('the homepage <main id="main"> now has exactly 8 top-level sections (was 9 before the cut)', () => {
    const html = readIndexHtml();
    assert.equal(countTopLevelMainSections(html), 8);
  });
});
