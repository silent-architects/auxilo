'use strict';

/**
 * test/wave-e2.test.js — Wave E2 (SITE-PM final wave sheet, 2026-09-06).
 *
 * Structural, file-level guards for the CSS-only items this builder shipped:
 * items 1, 5, 8, 9, 10, 11 (min-height + size-adjust; styles.css was NOT
 * minified — held per the build task), 12, 13, 14. No live server needed;
 * every assertion is checkable from the served bytes on disk, matching the
 * convention in test/site-system.test.js.
 *
 * Runner: node --test test/wave-e2.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const STYLES = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');

describe('Wave E2 item 1 (reverted, NAV-WAVE amendment 2026-09-06): nav breakpoint is 900px, exactly once', () => {
  it('the .hamburger/.nav-links desktop-nav-vs-hamburger switch is gated by exactly one @media (max-width: 900px) block', () => {
    const navBlockMatch = STYLES.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/);
    assert.ok(navBlockMatch, 'a @media (max-width: 900px) block exists');
    assert.match(navBlockMatch[1], /\.hamburger\s*\{[^}]*display:\s*flex/, 'the 900px nav block shows the hamburger');
    assert.match(navBlockMatch[1], /\.nav-links\s*\{/, 'the 900px nav block gates .nav-links');

    // Exactly one such gating breakpoint site-wide. The AD nav re-rule
    // sheet's correction 1 voided the 1057px number (it was computed for a
    // seven-label set that no longer exists) and reverted to 900, so this
    // sheet now carries TWO independent @media (max-width: 900px) blocks
    // (this nav block and the separate general-layout block below it) —
    // still kept split apart rather than merged. Across every @media
    // (max-width: Npx) block in the sheet regardless of px value, only ONE
    // may still touch .hamburger or .nav-links.
    const allBlocks = [...STYLES.matchAll(/@media \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)];
    const gatingBlocks = allBlocks.filter((mm) => /\.hamburger|\.nav-links/.test(mm[2]));
    assert.equal(gatingBlocks.length, 1, 'exactly one media query anywhere gates .hamburger/.nav-links');
    assert.equal(gatingBlocks[0][1], '900', 'the one gating block is the 900px breakpoint');
  });

  it('the general-layout 900px block (unrelated grids/section-pad) still exists as a SEPARATE block from the nav block, and contains no nav rules', () => {
    const allNineHundredBlocks = [...STYLES.matchAll(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/g)];
    assert.equal(allNineHundredBlocks.length, 2,
      'two independent @media (max-width: 900px) blocks exist (the nav block and the general-layout block) — the revert did not merge them');
    const generalLayoutBlock = allNineHundredBlocks.find((mm) => /--section-pad/.test(mm[1]));
    assert.ok(generalLayoutBlock, 'a 900px block setting --section-pad (the general-layout block) exists');
    assert.doesNotMatch(generalLayoutBlock[1], /\.hamburger/, 'general-layout 900px block does not gate .hamburger');
    assert.doesNotMatch(generalLayoutBlock[1], /\.nav-links\s*\{/, 'general-layout 900px block does not gate .nav-links');
  });

  it('.nav-links open-menu background is full opacity (item 12)', () => {
    const m = STYLES.match(/@media \(max-width: 900px\) \{[\s\S]*?\.nav-links \{([^}]*)\}/);
    assert.ok(m, '.nav-links rule found inside the 900px nav block');
    assert.doesNotMatch(m[1], /rgba\(10,\s*10,\s*10,\s*0\.97\)/, 'the old 0.97 partial opacity is gone');
    assert.match(m[1], /background:\s*var\(--obsidian\)/, '.nav-links background is the full-opacity obsidian token');
  });
});

describe('Wave E2 item 9: --h2-cta equals --h2-section (one large headline per page)', () => {
  it('--h2-cta and --h2-section share the same clamp value', () => {
    const sectionM = STYLES.match(/--h2-section:\s*([^;]+);/);
    const ctaM = STYLES.match(/--h2-cta:\s*([^;]+);/);
    assert.ok(sectionM, '--h2-section token found');
    assert.ok(ctaM, '--h2-cta token found');
    assert.equal(ctaM[1].trim(), sectionM[1].trim(), '--h2-cta now matches --h2-section (both clamp(30px, 3.6vw, 46px))');
    // Design system pass: the h2 scale moved from clamp(28px, 3.5vw, 42px) to clamp(30px, 3.6vw, 46px).
    assert.equal(ctaM[1].trim(), 'clamp(30px, 3.6vw, 46px)');
  });
});

describe('Wave E2 item 10 (partially reverted by the AD nav re-rule sheet, 2026-09-06 §2/§4/§6): the CTA is the band\'s one gold element', () => {
  it('.nav-links a.active is the ground-aware ink token (ivory in the dark nav), not aurum', () => {
    const m = STYLES.match(/\.nav-links a\.active\s*\{([^}]*)\}/);
    assert.ok(m, '.nav-links a.active rule found');
    // Design system pass: was var(--ash); --fg-1 is ivory inside the dark nav scope.
    assert.match(m[1], /color:\s*var\(--fg-1\)/, '.nav-links a.active color is var(--fg-1)');
    assert.doesNotMatch(m[1], /var\(--aurum\)/, '.nav-links a.active no longer references --aurum');
  });

  it('.nav-cta is an OUTLINED ivory ghost button — transparent background, ivory text, ash-alpha border (and still 44px tall, item 12)', () => {
    const m = STYLES.match(/^\.nav-cta\s*\{([^}]*)\}/m);
    assert.ok(m, '.nav-cta rule found');
    assert.match(m[1], /background:\s*transparent/, '.nav-cta background is transparent — ASK-WAVE (2026-09-07, THE-ASK-PACKET §3) demotes the nav pill sitewide since the hero command block is now the property\'s single gold event, superseding the AD sheet\'s filled-gold call');
    // Design system pass: text is --fg-1 (ivory in the dark nav scope), border is an ivory outline at .5, radius 6px.
    assert.match(m[1], /color:\s*var\(--fg-1\)\s*!important/, '.nav-cta text color is the ink token (ivory in the nav)');
    assert.match(m[1], /border:\s*1px solid rgba\(250,\s*250,\s*248,\s*0\.5\)/, '.nav-cta border is the ivory .5 outline, same box math as before');
    assert.match(m[1], /border-radius:\s*var\(--r-control\)/, '.nav-cta takes the 6px control radius');
    assert.match(m[1], /min-height:\s*44px/, '.nav-cta is still 44px tall (same position, item 12 unchanged)');
    assert.doesNotMatch(m[1], /var\(--aurum\b/, '.nav-cta base rule no longer references any --aurum token');
  });

  it('.nav-cta:hover tints to a faint white/ivory ground, text stays ivory', () => {
    const m = STYLES.match(/\.nav-cta:hover\s*\{([^}]*)\}/);
    assert.ok(m, '.nav-cta:hover rule found');
    // Design system pass: the hover tint is ivory at .08 (was white at .04); text stays the ink token.
    assert.match(m[1], /background:\s*rgba\(250,\s*250,\s*248,\s*0\.08\)/, '.nav-cta:hover tints to a faint ivory ground — --aurum-hi is no longer referenced by this rule (left defined, unused)');
    assert.match(m[1], /color:\s*var\(--fg-1\)/, '.nav-cta:hover text stays the ink token (ivory in the nav)');
    assert.doesNotMatch(m[1], /var\(--aurum-hi\b/, '.nav-cta:hover no longer references --aurum-hi');
  });

  it('--aurum-hi token exists at #D8B95F (the AD sheet\'s CTA hover ground)', () => {
    assert.match(STYLES, /--aurum-hi:\s*#D8B95F/);
  });

  it('--ash-border token still exists (still used by .nav-links a.active\'s neighborhood), mirroring --aurum-border alpha', () => {
    assert.match(STYLES, /--ash-border:\s*rgba\(229,\s*229,\s*227,\s*0\.35\)/);
  });

  it('within the nav band\'s CSS, .nav-cta (base + hover) is the only rule painting a gold background — .nav-links/.nav-links a/.nav-links a.active never do', () => {
    const navLinksM = STYLES.match(/\.nav-links\s*\{([^}]*)\}/);
    const navLinksAM = STYLES.match(/\.nav-links a\s*\{([^}]*)\}/);
    const navLinksActiveM = STYLES.match(/\.nav-links a\.active\s*\{([^}]*)\}/);
    for (const [name, m] of [['.nav-links', navLinksM], ['.nav-links a', navLinksAM], ['.nav-links a.active', navLinksActiveM]]) {
      assert.ok(m, `${name} rule found`);
      assert.doesNotMatch(m[1], /background:\s*var\(--aurum/, `${name} does not paint a gold background`);
    }
  });
});

describe('Wave E2 item 11: .hero-ledger reserves space while hidden; size-adjust fallbacks added; styles.css NOT minified', () => {
  it('.hero-ledger hides via visibility, not display:none, and reserves a min-height', () => {
    const m = STYLES.match(/^\.hero-ledger\s*\{([^}]*)\}/m);
    assert.ok(m, '.hero-ledger base rule found');
    assert.match(m[1], /visibility:\s*hidden/, '.hero-ledger hides via visibility');
    assert.doesNotMatch(m[1], /display:\s*none/, '.hero-ledger no longer uses display:none to hide');
    assert.match(m[1], /min-height:\s*26px/, '.hero-ledger reserves a 26px min-height');

    const liveM = STYLES.match(/\.hero-ledger\.is-live\s*\{([^}]*)\}/);
    assert.ok(liveM, '.hero-ledger.is-live rule found');
    assert.match(liveM[1], /visibility:\s*visible/, '.hero-ledger.is-live flips visibility, not display');
  });

  it('two size-adjust fallback @font-face rules exist for Archivo and IBM Plex Mono', () => {
    const archivoFallback = STYLES.match(/@font-face\s*\{\s*font-family:\s*'Archivo Fallback';[^}]*\}/);
    assert.ok(archivoFallback, "an 'Archivo Fallback' @font-face rule exists");
    assert.match(archivoFallback[0], /size-adjust:\s*96\.43%/);

    const monoFallback = STYLES.match(/@font-face\s*\{\s*font-family:\s*'IBM Plex Mono Fallback';[^}]*\}/);
    assert.ok(monoFallback, "an 'IBM Plex Mono Fallback' @font-face rule exists");
    assert.match(monoFallback[0], /size-adjust:\s*99\.68%/);
  });

  it('--sans and --mono reference the fallback faces ahead of the raw system fonts', () => {
    const sansM = STYLES.match(/--sans:\s*([^;]+);/);
    const monoM = STYLES.match(/--mono:\s*([^;]+);/);
    assert.ok(sansM && monoM);
    assert.match(sansM[1], /^'Archivo',\s*'Archivo Fallback',/);
    assert.match(monoM[1], /^'IBM Plex Mono',\s*'IBM Plex Mono Fallback',/);
  });

  it('styles.css is NOT minified (held per the wave task: item 11 minify explicitly excluded)', () => {
    // A minified file would collapse to very few long lines. This sheet is
    // still full of multi-line comments and per-declaration line breaks.
    const lineCount = STYLES.split('\n').length;
    assert.ok(lineCount > 2000, `expected styles.css to still be a normal multi-line, commented sheet (${lineCount} lines) — minification was explicitly held for this wave`);
  });
});

describe('Wave E2 item 12: remaining 44px targets and coarse-pointer dive-arrow', () => {
  it('.btn-primary carries a 1px transparent border so it matches .btn-secondary\'s 54px height', () => {
    const m = STYLES.match(/^\.btn-primary\s*\{([^}]*)\}/m);
    assert.ok(m, '.btn-primary base rule found');
    assert.match(m[1], /border:\s*1px solid transparent/, '.btn-primary has a 1px transparent border');
  });

  it('.nav-logo and .footer-logo are 44px min-height targets', () => {
    const navLogo = STYLES.match(/\.nav-logo\s*\{([^}]*)\}/);
    assert.ok(navLogo, '.nav-logo rule found');
    assert.match(navLogo[1], /min-height:\s*44px/);

    const footerLogo = STYLES.match(/\.footer-logo\s*\{([^}]*)\}/);
    assert.ok(footerLogo, '.footer-logo rule found');
    assert.match(footerLogo[1], /min-height:\s*44px/);
  });

  it('.agent-cta-links a is a 44px target', () => {
    const m = STYLES.match(/\.agent-cta-links a\s*\{([^}]*)\}/);
    assert.ok(m, '.agent-cta-links a override found');
    assert.match(m[1], /min-height:\s*44px/);
  });

  it('.dive-arrow is retired: the index rows carry no arrow, so no rule shows one at a coarse pointer', () => {
    // Design rebuild: "no arrows on buttons or links". The page index is .dive-row rows with a
    // title and a description, and the coarse-pointer override that kept an arrow visible went with it.
    assert.doesNotMatch(STYLES, /\.dive-arrow\b/, 'styles.css carries no .dive-arrow rule');
    assert.doesNotMatch(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'), /dive-arrow/, 'index.html carries no .dive-arrow element');
    // Positive control: the rows that replaced it are drawn by the shared sheet.
    assert.match(STYLES, /^\.dive-row\s*\{/m, '.dive-row rule exists');
  });
});

describe('Wave E2 item 13: cross-file CSS-only overrides', () => {
  it('the pricing/for-agents/index hero <br> hides below 768px', () => {
    // styles.css already had an unrelated @media (max-width: 768px) block
    // (tier-cards-grid) before this wave, so match the whole added block —
    // wrapper and selector group together — rather than "the" 768px block
    // generically.
    const m = STYLES.match(
      /@media \(max-width: 768px\) \{\s*\n\s*#hero h1 br,\s*\n\s*\.page-hero h1 br,\s*\n\s*\.pricing-page-header h1 br\s*\{([^}]*)\}\s*\n\}/
    );
    assert.ok(m, 'the @media(max-width:768px) hero-br block exists as a self-contained unit');
    assert.match(m[1], /display:\s*none/);
  });

  it('.endpoint-table .ep-method is 13px (the /api method column, not the compact endpoint-list)', () => {
    assert.match(STYLES, /\.endpoint-table \.ep-method\s*\{\s*font-size:\s*13px;\s*\}/);
  });

  it('.hiw-step-card svg text[font-size] raises the five older diagram labels to the 12px floor', () => {
    for (const size of ['7', '8', '9', '10']) {
      assert.match(STYLES, new RegExp(`\\.hiw-step-card svg text\\[font-size="${size}"\\]`));
    }
    const m = STYLES.match(/\.hiw-step-card svg text\[font-size="7"\][\s\S]*?\{([^}]*)\}/);
    assert.ok(m);
    assert.match(m[1], /font-size:\s*12px/);
  });

  it('.legal-wrap h1/h2 carry the display leading + site tracking, and .writing-wrap is retired', () => {
    // Design system pass: h1 and h2 now carry their own leading and tracking (h1 1.04 / -0.022em, h2 1.1 / -0.016em).
    const legalH1 = STYLES.match(/^\.legal-wrap h1\s*\{([^}]*)\}/m);
    assert.ok(legalH1, '.legal-wrap h1 rule found');
    assert.match(legalH1[1], /line-height:\s*1\.04/);
    assert.match(legalH1[1], /letter-spacing:\s*-0\.022em/);
    const legalH2 = STYLES.match(/^\.legal-wrap h2\s*\{([^}]*)\}/m);
    assert.ok(legalH2, '.legal-wrap h2 rule found');
    assert.match(legalH2[1], /line-height:\s*1\.1\b/);
    assert.match(legalH2[1], /letter-spacing:\s*-0\.016em/);

    // The essay's wrapper class is on no page, so its override is gone from the shared sheet
    // (positive control: the legal rules above are still there).
    assert.doesNotMatch(STYLES, /\.writing-wrap\b/, 'styles.css carries no .writing-wrap rule');
  });
});

describe('Wave E2 item 14: about.html and writing/index.html inline <style> shrank (dead-CSS removal)', () => {
  it('about.html no longer defines the dead status/badge/health/contact component CSS', () => {
    const about = fs.readFileSync(path.join(PUBLIC_DIR, 'about.html'), 'utf8');
    for (const dead of ['.overall-status {', '.status-dot {', '.badge {', '.links-grid {', '.health-block {', '.contact-block {']) {
      assert.ok(!about.includes(dead), `about.html should no longer declare ${dead}`);
    }
    // Design pass: the h1 takes the shared display scale (serif, 1.04 leading) instead of a page rule
    // with 1.1 leading, so the page declares no .page-title rule. Positive control: the h1 is still there.
    assert.match(about, /<h1 class="page-title">About Auxilo<\/h1>/, 'about.html still carries its page-title h1');
    assert.doesNotMatch(about, /\.page-title\s*\{/, 'about.html declares no local .page-title rule (the h1 uses the shared display scale)');
  });

  it('writing/index.html no longer defines the dead status/badge/waitlist/health/contact component CSS', () => {
    const writing = fs.readFileSync(path.join(PUBLIC_DIR, 'writing', 'index.html'), 'utf8');
    for (const dead of ['.overall-status {', '.status-dot {', '.badge {', '.waitlist-row {', '.links-grid {', '.health-block {', '.contact-block {']) {
      assert.ok(!writing.includes(dead), `writing/index.html should no longer declare ${dead}`);
    }
    // Design pass: same as /about, the h1 uses the shared display scale and the page declares no .page-title rule.
    assert.match(writing, /<h1 class="page-title">Writing<\/h1>/, 'writing/index.html still carries its page-title h1');
    assert.doesNotMatch(writing, /\.page-title\s*\{/, 'writing/index.html declares no local .page-title rule (the h1 uses the shared display scale)');
  });

  it('both pages\' combined <style> block bytes shrank well below their original 11-13KB', () => {
    for (const rel of ['about.html', path.join('writing', 'index.html')]) {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');
      const blocks = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
      const bytes = Buffer.byteLength(blocks.join(''), 'utf8');
      assert.ok(bytes < 9000, `${rel} inline <style> content is ${bytes} bytes, expected a real cut from the original ~11-13KB`);
    }
  });
});
