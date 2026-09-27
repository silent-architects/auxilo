'use strict';

/**
 * test/launch-wave-home.test.js — LAUNCH-WAVE-0926 homepage + about-page
 * regression (advertising-copywriter build, 2026-09-26).
 *
 * Source: REGISTER-A-HOMEPAGE-REV2.md (rows A-01..A-18), REGISTER-M-
 * MECHANICAL.md (rows M-30, M-42, M-43), LAYOUT-SHEET.md (items 1-2).
 *
 * Static, source-level checks only — no live server, no Playwright. Pins:
 *   1. #hero carries no .hero-trust and no .hero-figure (both moved out).
 *   2. #setup-detail is the next <section> after #hero and carries the h2,
 *      the ratified control block + kill switch line verbatim, the link to
 *      /how-submissions-work, and the moved exchange figure.
 *   3. The works-with band holds exactly the six ruled client names, in
 *      order, excludes Cline/Roo Code/Continue.dev, and its link cell
 *      still points at /works-with.
 *   4. Step 03 carries the earnings disclaimer verbatim (scoped to step 03,
 *      not a whole-page occurrence count — a later unit may add the same
 *      sentence to a homepage FAQ answer too).
 *   5. The homepage (body + JSON-LD share one source file) carries none of
 *      the retired accrual-universal/paused-rail strings.
 *   6. Each FAQ answer's visible text equals its JSON-LD mirror, name for
 *      name, after stripping tags and collapsing whitespace/space-before-
 *      punctuation.
 *   7. The homepage's visible (rendered) text carries no em dash and no en
 *      dash.
 *   8. about.html carries the new A-17 purpose paragraph verbatim, between
 *      the h1 and the pre-existing "Auxilo is run by Tyler Kelley." intro,
 *      which itself survives byte-identical.
 *
 * Every assertion that checks a string's ABSENCE also asserts a positive
 * control (a string known to be present) in the same test, so a broken
 * helper can't produce a false pass.
 *
 * Runner: node --test test/launch-wave-home.test.js
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const INDEX_PATH = path.join(REPO, 'public', 'index.html');
const ABOUT_PATH = path.join(REPO, 'public', 'about.html');

const html = fs.readFileSync(INDEX_PATH, 'utf8');

function stripTags(fragment) {
  return fragment
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'");
}

function normalize(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?])/g, '$1')
    .trim();
}

function visibleTextOf(fragment) {
  return normalize(stripTags(fragment));
}

describe('LAUNCH-WAVE-0926: homepage hero + #setup-detail section', () => {
  // CH-7: shared by both it() blocks below; a before() hook is a real
  // test-harness frame (fails loud) whereas the same assert directly in the
  // describe body would silently swallow a failure.
  let hero;

  before(() => {
    const heroMatch = html.match(/<section id="hero"[\s\S]*?<\/section>/);
    assert.ok(heroMatch, '#hero section must exist');
    hero = heroMatch[0];
  });

  it('#hero contains no element with class "hero-trust" and no element with class "hero-figure"', () => {
    assert.ok(!/class="hero-trust"/.test(hero), 'hero-trust must be gone from #hero (moved to #setup-detail as a plain paragraph)');
    assert.ok(!/class="hero-figure"/.test(hero), 'hero-figure must be gone from #hero (moved to #setup-detail)');
    // Positive control: a class we know IS still inside #hero, proving the
    // regex/extraction itself works and isn't just matching nothing.
    assert.ok(/class="hero-sub"/.test(hero), 'positive control: hero-sub is still found inside #hero');
  });

  it('#setup-detail is the next <section> after #hero, and carries the h2 + ratified block + kill switch + link + the moved figure', () => {
    const heroStart = html.indexOf('<section id="hero"');
    const heroClose = html.indexOf('</section>', heroStart) + '</section>'.length;
    const nextSectionIdx = html.indexOf('<section', heroClose);
    assert.notEqual(nextSectionIdx, -1, 'a <section> follows #hero');
    const nextSectionOpenTag = html.slice(nextSectionIdx, html.indexOf('>', nextSectionIdx) + 1);
    assert.match(nextSectionOpenTag, /id="setup-detail"/, 'the section directly following #hero has id="setup-detail"');

    const setupMatch = html.match(/<section id="setup-detail"[\s\S]*?<\/section>/);
    assert.ok(setupMatch, '#setup-detail section body found');
    const setupDetail = setupMatch[0];

    assert.match(setupDetail, /<h2 id="setup-detail-heading">You Control What Publishes<\/h2>/, 'h2 exact text');

    const copyMatch = setupDetail.match(/<div class="setup-detail-copy">([\s\S]*?)<\/div>\s*<div class="hero-figure">/);
    assert.ok(copyMatch, 'setup-detail-copy block found ahead of the moved hero-figure');
    const visibleCopy = visibleTextOf(copyMatch[1]);
    const expectedCopy = normalize(
      'Raw transcripts never leave your machine. A local filter scans for credentials, secrets, and private data. ' +
      'It fails closed. How each screen works, and what it can miss, is on the submissions page. Nothing publishes ' +
      'until you approve it, one learning at a time or in advance in your dashboard. You can retract anything for ' +
      '7 days. npx auxilo disable is the kill switch.'
    );
    assert.equal(visibleCopy, expectedCopy, 'the ratified block + kill switch line read verbatim, tags stripped');

    assert.match(setupDetail, /<a href="\/how-submissions-work">the submissions page<\/a>/, 'link to /how-submissions-work present');
    assert.match(setupDetail, /<code>npx auxilo disable<\/code> is the kill switch\./, 'kill switch sentence with <code> on the command');
    assert.match(setupDetail, /<div class="hero-figure">/, 'the moved exchange figure wrapper is present');
    assert.match(setupDetail, /class="hero-exchange"/, 'the exchange SVG itself is present');
  });
});

describe('LAUNCH-WAVE-0926: works-with client band (register M-30)', () => {
  it('holds exactly the six ruled names in order, excludes Cline/Roo Code/Continue.dev, and the link cell still points at /works-with', () => {
    const bandMatch = html.match(/<section id="works-with-band"[\s\S]*?<\/section>/);
    assert.ok(bandMatch, '#works-with-band section found');
    const band = bandMatch[0];

    const names = [...band.matchAll(/<span class="ww-band-name">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepEqual(names, ['Claude Code', 'Cursor', 'GitHub Copilot CLI', 'Codex', 'Antigravity', 'Devin Desktop']);

    assert.ok(!band.includes('Cline'), 'Cline excluded');
    assert.ok(!band.includes('Roo Code'), 'Roo Code excluded');
    assert.ok(!band.includes('Continue.dev'), 'Continue.dev excluded');
    // Positive control for the three exclusion checks above.
    assert.ok(band.includes('Claude Code'), 'positive control: Claude Code is present, proving the substring search works');

    assert.match(band, /<a href="\/works-with" class="ww-band-link">/, 'link cell still points at /works-with');
  });
});

// ─── FIX-UNIT A6+L8 (homepage half): 44px touch targets ────────────────────
//
// REVIEW-ACCESSIBILITY.md #6/L8: the hero "See How It Works" link (116x24)
// and the works-with-band link cell (335x24) were under the site's own
// 44px intent. Fix: min-height:44px + inline-flex alignment on each, so
// the text does not move; raising the hero link's height pushes its
// bottom edge down at 375px, so the mobile hero row's own gap is zeroed
// (page-scoped) to give the fold margin back.

describe('FIX-UNIT A6+L8: homepage 44px touch targets', () => {
  it('the shared .hero-cta-link rule (styles.css) reaches 44px via inline-flex + align-items:center, and index.html still consumes it', () => {
    const stylesCss = fs.readFileSync(path.join(REPO, 'public', 'styles.css'), 'utf8');
    const rule = (/\.hero-cta-link\s*\{[^}]*\}/.exec(stylesCss) || [''])[0];
    assert.ok(rule, '.hero-cta-link rule found in styles.css');
    assert.match(rule, /display:\s*inline-flex;/);
    assert.match(rule, /align-items:\s*center;/);
    assert.match(rule, /min-height:\s*44px;/);
    assert.match(html, /<a href="\/how-it-works" id="hero-cta-secondary" class="hero-cta-link">See How It Works<\/a>/);
  });

  it('#works-with-band .ww-band-link (page-scoped) reaches 44px via inline-flex + align-items:center, spanning its own full-width row', () => {
    const rule = (/#works-with-band \.ww-band-link\s*\{[^}]*\}/.exec(html) || [''])[0];
    assert.ok(rule, '#works-with-band .ww-band-link rule found');
    assert.match(rule, /grid-column:\s*1 \/ -1;/, 'still spans the full row (LAYOUT-SHEET item 2), unaffected by the touch-target change');
    assert.match(rule, /display:\s*inline-flex;/);
    assert.match(rule, /align-items:\s*center;/);
    assert.match(rule, /min-height:\s*44px;/);
  });

  it('the <=600px hero override zeroes .hero-install-row\'s gap, giving back the 20px the taller CTA link added, so the fold measurement still holds', () => {
    const mobileBlock = (/@media \(max-width: 600px\) \{[\s\S]*?\n {4}\}\n/.exec(html) || [''])[0];
    assert.ok(mobileBlock.includes('#install.hero-install'), 'sanity: this is the right mobile hero block');
    assert.match(mobileBlock, /#hero \.hero-install-row\s*\{\s*gap:\s*0;\s*\}/, 'the row gap must be zeroed at this tier to compensate for the taller CTA link');
  });
});

describe('LAUNCH-WAVE-0926: earnings disclaimer (register M-04, amended scope)', () => {
  it('step 03 ("You Earn When Agents Unlock") carries the earnings disclaimer verbatim', () => {
    const stepMatch = html.match(/<h3>You Earn When Agents Unlock<\/h3>\s*<p>([\s\S]*?)<\/p>/);
    assert.ok(stepMatch, 'step 03 body found');
    assert.ok(
      stepMatch[1].includes('Earnings depend on whether other agents unlock your learnings and are not guaranteed.'),
      'step 03 carries the disclaimer verbatim'
    );
    // NOTE: this is deliberately scoped to step 03, not a whole-page count —
    // a later unit in this wave adds the same sentence to a homepage FAQ
    // answer too, per the coordinator's mid-build correction.
  });
});

describe('LAUNCH-WAVE-0926: retired accrual-universal / paused-rail strings are gone', () => {
  it('index.html (body and JSON-LD share one source file) carries none of: "every unlock", "every direct unlock", "Agents pay.", "One command:"', () => {
    const banned = ['every unlock', 'every direct unlock', 'Agents pay.', 'One command:'];
    for (const needle of banned) {
      assert.ok(!html.includes(needle), `retired string "${needle}" must be gone from index.html`);
    }
    // Positive control: a string we know IS present, proving .includes() works.
    assert.ok(html.includes('Your Agents Learn. You Earn.'), 'positive control: known-present string found');
  });
});

describe('LAUNCH-WAVE-0926: FAQ visible text equals its JSON-LD mirror', () => {
  it('each of the three homepage FAQ answers reads identically in the DOM and in FAQPage JSON-LD', () => {
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert.ok(ldMatch, 'JSON-LD script block found');
    const data = JSON.parse(ldMatch[1]);
    const faqNode = (data['@graph'] || []).find((n) => n['@type'] === 'FAQPage');
    assert.ok(faqNode, 'FAQPage node found in @graph');

    const answerInnerMatches = [...html.matchAll(/<div class="faq-answer-inner">([\s\S]*?)<\/div>/g)];
    assert.ok(faqNode.mainEntity.length > 0, 'sanity: at least one FAQ answer to check (both being empty would make the count check below vacuous)');
    assert.equal(answerInnerMatches.length, faqNode.mainEntity.length, 'same number of rendered answers as JSON-LD answers');

    faqNode.mainEntity.forEach((q, i) => {
      const visible = visibleTextOf(answerInnerMatches[i][1]);
      const jsonld = normalize(q.acceptedAnswer.text);
      assert.equal(visible, jsonld, `FAQ answer ${i + 1} ("${q.name}") visible text must equal its JSON-LD mirror`);
    });
  });
});

describe('LAUNCH-WAVE-0926 register P: homepage FAQ rate-answer disclosure (P-01)', () => {
  const NOT_GUARANTEED_THIRD = "Earnings depend on whether other agents unlock the builder's learnings and are not guaranteed.";

  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  const data = JSON.parse(ldMatch[1]);
  const faqNode = (data['@graph'] || []).find((n) => n['@type'] === 'FAQPage');
  const answerInnerMatches = [...html.matchAll(/<div class="faq-answer-inner">([\s\S]*?)<\/div>/g)];
  const entries = faqNode.mainEntity
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.acceptedAnswer.text.includes('70%') || q.acceptedAnswer.text.includes('60%'));

  it('at least one homepage FAQ answer states the rate (positive control)', () => {
    assert.ok(entries.length > 0, 'index.html must carry at least one 70%/60% FAQ answer to test');
  });

  for (const { q, i } of entries) {
    it(`FAQ "${q.name}" carries the disclaimer, "open soon", the rate basis, is not disclaimer-terminal, and equals its rendered twin`, () => {
      const jsonText = normalize(q.acceptedAnswer.text);
      assert.ok(jsonText.includes('not guaranteed'), 'JSON-LD answer must state earnings are not guaranteed');
      assert.ok(/open soon/i.test(jsonText), 'JSON-LD answer must carry "open soon"');
      assert.ok(
        jsonText.includes('of what the buyer paid') || jsonText.includes('of what they paid') || jsonText.includes('of its listed price'),
        'JSON-LD answer must state the earnings basis (credits-as-cash C-01 restates it as "of its listed price")'
      );
      assert.equal(
        jsonText.endsWith(NOT_GUARANTEED_THIRD),
        false,
        'the disclaimer must not be the last sentence of the answer'
      );

      const rendered = visibleTextOf(answerInnerMatches[i][1]);
      assert.equal(rendered, jsonText, 'rendered answer must equal its JSON-LD twin after normalization');
    });
  }
});

describe('LAUNCH-WAVE-0926: no em dash / en dash in homepage visible text', () => {
  it('the rendered <body> text contains no U+2014 (em dash) and no U+2013 (en dash)', () => {
    const bodyMatch = html.match(/<body>([\s\S]*)<\/body>/);
    assert.ok(bodyMatch, '<body> found');
    const bodyNoScriptsOrStyles = bodyMatch[1]
      .replace(/<script[\s\S]*?<\/script>/g, ' ')
      .replace(/<style[\s\S]*?<\/style>/g, ' ');
    const visible = stripTags(bodyNoScriptsOrStyles);
    assert.ok(!visible.includes('—'), 'no em dash in visible text');
    assert.ok(!visible.includes('–'), 'no en dash in visible text');
    // Positive control: known-present text, proving the extraction isn't empty.
    assert.ok(visible.includes('Auxilo'), 'positive control: known-present text found');
  });
});

describe('LAUNCH-WAVE-0926: about.html purpose paragraph (register A-17)', () => {
  it('carries the new purpose paragraph verbatim, after the h1 and before the pre-existing "Auxilo is run by Tyler Kelley." intro, which survives byte-identical', () => {
    const aboutHtml = fs.readFileSync(ABOUT_PATH, 'utf8');
    const newParagraph =
      'You pay time and tokens while your agent works out a fix, and most of what it finds disappears when the ' +
      'session ends. Auxilo is a marketplace for what agents learn, built so that fix can be found again instead ' +
      'of rediscovered. Agents search it free and pay to unlock a learning.';
    const originalIntro =
      'Auxilo is run by Tyler Kelley. The code is public at <a href="https://github.com/silent-architects/auxilo" rel="noopener">github.com/silent-architects/auxilo</a>, ' +
      'under his GitHub account, Silent Architects. Security reports go to <a href="mailto:security@auxilo.io">security@auxilo.io</a> and the response target is one day. ' +
      'General questions go to <a href="mailto:support@auxilo.io">support@auxilo.io</a>, where the target is three days. Both targets are stated on the <a href="/status">status page</a>. ' +
      'The responsible disclosure contact is at <a href="/.well-known/security.txt">auxilo.io/.well-known/security.txt</a>.';

    assert.ok(aboutHtml.includes(newParagraph), 'new purpose paragraph present verbatim');
    assert.ok(aboutHtml.includes(originalIntro), 'the pre-existing intro paragraph survives byte-identical');

    const h1Idx = aboutHtml.indexOf('<h1 class="page-title">About Auxilo</h1>');
    const newParaIdx = aboutHtml.indexOf(newParagraph);
    const originalIntroIdx = aboutHtml.indexOf(originalIntro);
    assert.notEqual(h1Idx, -1, 'h1 found');
    assert.notEqual(newParaIdx, -1, 'new paragraph found');
    assert.notEqual(originalIntroIdx, -1, 'original intro found');
    assert.ok(h1Idx < newParaIdx, 'new paragraph sits after the h1');
    assert.ok(newParaIdx < originalIntroIdx, 'new paragraph sits before the pre-existing intro');
  });
});
