'use strict';

/**
 * test/ask-wave-a.test.js — ASK-WAVE builder A regression
 * (~/.auxilo/handoffs/BUILD-SPEC-ASK-WAVE-2026-09-07.md Wave A,
 * strings source ~/.auxilo/handoffs/THE-ASK-PACKET-2026-09-06.md).
 *
 * Scope: public/styles.css + public/index.html + public/connect.html only
 * (builder B owns for-agents/for-builders; builder C owns the shared
 * test/ask-wave.test.js Playwright suite). This file is the static,
 * source-level positive-control layer for Wave A's own items:
 *
 *   1. .nav-cta demotes from a gold fill to an outlined-ivory ghost button,
 *      sitewide, in styles.css only — no page-scoped fork survives (the old
 *      index.html #nav-cta-access.nav-cta ash-outline override is gone).
 *   2. The hero command block (#install) is promoted/framed as the fold's
 *      one gold event; no new button is added (zero .btn-primary on /).
 *   3. Copy-button label -> "Copy the Setup Command" on the hero button
 *      (index.html) and the /connect button (connect.html). The two OTHER
 *      same-affordance footer copy buttons (index.html's own footer,
 *      for-builders.html's footer) were originally out of the packet's
 *      scope, flagged for a ruling; SITE-PM's ruling has since landed
 *      (label follows the copy target, sitewide) and is already applied
 *      to both footers -- so they now carry "Copy the Setup Command" too,
 *      not the old lowercase "copy".
 *   4. Hero secondary reduces to one: "How builders earn" is gone, "See How
 *      It Works" survives as a plain text link (no .btn-secondary chrome).
 *   5. New hero microcopy beneath the command block.
 *   6. Hero trust bullet 2 rewords to drop the sentence that now duplicates
 *      the new microcopy.
 *   7. #main-nav markup (label, href, id, position — everything but CSS) is
 *      byte-identical to origin/main on both edited pages, since only
 *      .nav-cta's fill/border changed, never the nav's own markup.
 *
 * Runner: node --test test/ask-wave-a.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

const indexHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
const connectHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'connect.html'), 'utf8');
const forBuildersHtml = fs.readFileSync(path.join(PUBLIC_DIR, 'for-builders.html'), 'utf8');
const stylesCss = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    idx = haystack.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += needle.length;
  }
  return count;
}

function navBlock(html) {
  const start = html.indexOf('<nav');
  const end = html.indexOf('</nav>');
  assert.notEqual(start, -1, 'no <nav> found');
  assert.notEqual(end, -1, 'no </nav> found');
  return html.slice(start, end + '</nav>'.length);
}

function originMainFile(relPath) {
  return execFileSync('git', ['show', `origin/main:${relPath}`], { cwd: REPO, encoding: 'utf8' });
}

// ═══════════════════════════════════════════════════════════════════════
// Old strings retired (count 0)
// ═══════════════════════════════════════════════════════════════════════

describe('ASK-WAVE A: old strings retired', () => {
  it('hero copy button no longer says lowercase "copy" (index.html)', () => {
    const snippetStart = indexHtml.indexOf('id="hero-setup-snippet"');
    const snippetEnd = indexHtml.indexOf('</div>', snippetStart);
    const snippet = indexHtml.slice(snippetStart, snippetEnd);
    assert.equal(countOccurrences(snippet, '>copy<'), 0);
  });

  it('/connect copy button no longer says lowercase "copy"', () => {
    assert.equal(countOccurrences(connectHtml, '>copy<'), 0);
  });

  it('"How builders earn" is gone sitewide from the two edited pages', () => {
    assert.equal(countOccurrences(indexHtml, 'How builders earn'), 0);
    assert.equal(countOccurrences(connectHtml, 'How builders earn'), 0);
  });

  it('the old trust-bullet sentence ("Extraction defaults to off...") is gone', () => {
    assert.equal(countOccurrences(indexHtml, 'Extraction defaults to off'), 0);
  });

  it('the page-scoped #nav-cta-access.nav-cta ash-outline override is gone', () => {
    assert.equal(countOccurrences(indexHtml, '#nav-cta-access.nav-cta'), 0);
    // the nav CTA's own markup id must still exist -- only the CSS fork is removed
    assert.equal(countOccurrences(indexHtml, 'id="nav-cta-access"'), 1);
  });

  it('.nav-cta no longer fills with --aurum/--aurum-hi in styles.css', () => {
    const ruleStart = stylesCss.indexOf('.nav-cta {');
    const ruleEnd = stylesCss.indexOf('}', ruleStart);
    const hoverStart = stylesCss.indexOf('.nav-cta:hover {');
    const hoverEnd = stylesCss.indexOf('}', hoverStart);
    const rule = stylesCss.slice(ruleStart, ruleEnd) + stylesCss.slice(hoverStart, hoverEnd);
    assert.equal(/var\(--aurum\)|var\(--aurum-hi\)/.test(rule), false, 'a gold token still fills .nav-cta');
    assert.match(rule, /background:\s*transparent/);
    assert.match(rule, /var\(--ivory\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// New strings land exactly once
// ═══════════════════════════════════════════════════════════════════════

describe('ASK-WAVE A: new strings land exactly once', () => {
  it('hero copy button reads "Copy the Setup Command" (count 2, index.html: hero + footer)', () => {
    // SITE-PM ruling landed since this count was first pinned: the label
    // follows the copy target, not the page position, so index.html's
    // footer setup-snippet button (id="footer-setup-snippet") now carries
    // the same "Copy the Setup Command" label as the hero button
    // (already applied by micro-2) -- pushing the whole-file count from
    // 1 to 2. See the re-pinned footer assertion below.
    assert.equal(countOccurrences(indexHtml, 'Copy the Setup Command'), 2);
  });

  it('/connect copy button reads "Copy the Setup Command" (count 1, connect.html)', () => {
    assert.equal(countOccurrences(connectHtml, 'Copy the Setup Command'), 1);
  });

  it('the footer copy buttons follow the SITE-PM label ruling ("Copy the Setup Command", not lowercase "copy")', () => {
    // index.html's own footer setup snippet + for-builders.html's footer setup
    // snippet share the same affordance as the hero/connect buttons. The
    // packet was originally silent on them ("flagged for a ruling"); the
    // ruling has since landed -- label follows the copy target, so both
    // footer buttons read "Copy the Setup Command" like every other copy
    // button on the site (already applied by micro-2). Re-pinned here.
    const footerStart = indexHtml.indexOf('id="footer-setup-snippet"');
    assert.notEqual(footerStart, -1);
    const footerButtonMatch = indexHtml.slice(footerStart, footerStart + 400).match(/aria-label="Copy command">([^<]*)</);
    assert.ok(footerButtonMatch, 'footer setup button not found');
    assert.equal(footerButtonMatch[1], 'Copy the Setup Command');

    const fbFooterStart = forBuildersHtml.indexOf('id="footer-setup-snippet"');
    assert.notEqual(fbFooterStart, -1);
    const fbFooterButtonMatch = forBuildersHtml.slice(fbFooterStart, fbFooterStart + 400).match(/aria-label="Copy command">([^<]*)</);
    assert.ok(fbFooterButtonMatch, 'for-builders footer setup button not found');
    assert.equal(fbFooterButtonMatch[1], 'Copy the Setup Command');
  });

  it('new hero microcopy lands exactly once, verbatim', () => {
    assert.equal(
      countOccurrences(
        indexHtml,
        'Setup is free and takes one command. Extraction stays off until you turn it on.'
      ),
      1
    );
  });

  it('trust bullet 2 reads the amended sentence exactly once, verbatim', () => {
    assert.equal(
      countOccurrences(indexHtml, 'Decline extraction and every Auxilo tool still works.'),
      1
    );
  });

  it('"One command. Any terminal." survives unchanged in the hero', () => {
    const snippetStart = indexHtml.indexOf('id="hero-setup-snippet"');
    const snippetEnd = indexHtml.indexOf('</div>', snippetStart);
    const snippet = indexHtml.slice(snippetStart, snippetEnd);
    assert.equal(countOccurrences(snippet, 'One command. Any terminal.'), 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Homepage carries zero .btn-primary; hero secondary reduces to one
// ═══════════════════════════════════════════════════════════════════════

describe('ASK-WAVE A: homepage gold-event + hero-secondary invariants', () => {
  it('index.html ships zero .btn-primary', () => {
    assert.equal(/class="[^"]*\bbtn-primary\b[^"]*"/.test(indexHtml), false);
  });

  it('the hero carries exactly one .btn-secondary/text-link element, not two', () => {
    // Old markup had 2x .btn-secondary in .hero-ctas; new markup has 0
    // .btn-secondary anywhere on the page and exactly 1 .hero-cta-link.
    assert.equal(countOccurrences(indexHtml, 'class="btn-secondary"'), 0);
    const heroCtaLinkMatches = indexHtml.match(/class="hero-cta-link"/g) || [];
    assert.equal(heroCtaLinkMatches.length, 1);
  });

  it('the removed hero-cta-builders link ("How builders earn") no longer exists by id', () => {
    assert.equal(countOccurrences(indexHtml, 'id="hero-cta-builders"'), 0);
  });

  it('the surviving hero secondary link keeps its id and destination', () => {
    assert.match(indexHtml, /<a href="\/how-it-works" id="hero-cta-secondary" class="hero-cta-link">See How It Works<\/a>/);
  });

  it('#install .copy-btn still carries its gold fill, unchanged, in index.html', () => {
    assert.match(indexHtml, /#install \.copy-btn\s*\{[^}]*background:\s*var\(--aurum\)/);
  });

  it("connect.html's own #install .copy-btn gold fill is untouched", () => {
    assert.match(connectHtml, /#install \.copy-btn\s*\{[^}]*background:\s*var\(--aurum\)/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Nav markup: byte-identical to origin/main (only .nav-cta's CSS changed)
// ═══════════════════════════════════════════════════════════════════════

describe('ASK-WAVE A: nav markup unchanged vs origin/main', { timeout: 30_000 }, () => {
  it('index.html <nav> block is byte-identical to origin/main', () => {
    const origin = originMainFile('public/index.html');
    assert.equal(navBlock(indexHtml), navBlock(origin));
  });

  it('connect.html <nav> block is byte-identical to origin/main', () => {
    const origin = originMainFile('public/connect.html');
    assert.equal(navBlock(connectHtml), navBlock(origin));
  });
});
