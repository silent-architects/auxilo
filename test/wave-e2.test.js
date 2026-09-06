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
    assert.equal(ctaM[1].trim(), sectionM[1].trim(), '--h2-cta now matches --h2-section (both clamp(28px, 3.5vw, 42px))');
    assert.equal(ctaM[1].trim(), 'clamp(28px, 3.5vw, 42px)');
  });
});

describe('Wave E2 item 10 (partially reverted by the AD nav re-rule sheet, 2026-09-06 §2/§4/§6): the CTA is the band\'s one gold element', () => {
  it('.nav-links a.active is still ash, not aurum (unchanged by the NAV-WAVE amendment)', () => {
    const m = STYLES.match(/\.nav-links a\.active\s*\{([^}]*)\}/);
    assert.ok(m, '.nav-links a.active rule found');
    assert.match(m[1], /color:\s*var\(--ash\)/, '.nav-links a.active color is var(--ash)');
    assert.doesNotMatch(m[1], /var\(--aurum\)/, '.nav-links a.active no longer references --aurum');
  });

  it('.nav-cta is a FILLED gold button — background var(--aurum), text var(--obsidian), border recolored to var(--aurum) (and still 44px tall, item 12)', () => {
    const m = STYLES.match(/^\.nav-cta\s*\{([^}]*)\}/m);
    assert.ok(m, '.nav-cta rule found');
    assert.match(m[1], /background:\s*var\(--aurum\)/, '.nav-cta background is the gold token — the AD sheet\'s filled button, superseding Wave E2 item 10\'s ash ghost button');
    assert.match(m[1], /color:\s*var\(--obsidian\)\s*!important/, '.nav-cta text color is obsidian (on a gold ground)');
    assert.match(m[1], /border:\s*1px solid var\(--aurum\)/, '.nav-cta border recolors to aurum so the 1px box math stays unchanged');
    assert.match(m[1], /min-height:\s*44px/, '.nav-cta is 44px tall');
    assert.doesNotMatch(m[1], /var\(--ash\b/, '.nav-cta base rule no longer references any --ash token');
  });

  it('.nav-cta:hover raises the ground to --aurum-hi, a new token, text stays obsidian', () => {
    const m = STYLES.match(/\.nav-cta:hover\s*\{([^}]*)\}/);
    assert.ok(m, '.nav-cta:hover rule found');
    assert.match(m[1], /background:\s*var\(--aurum-hi\)/, '.nav-cta:hover raises the ground to --aurum-hi');
    assert.match(m[1], /color:\s*var\(--obsidian\)/, '.nav-cta:hover text stays obsidian');
    assert.doesNotMatch(m[1], /var\(--ash\b/, '.nav-cta:hover no longer references any --ash token');
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

  it('.dive-arrow is shown at any coarse pointer', () => {
    const m = STYLES.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/);
    assert.ok(m, '@media (pointer: coarse) block found');
    assert.match(m[1], /\.dive-arrow\s*\{[^}]*opacity:\s*1\s*!important/);
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

  it('.legal-wrap h1/h2 and .writing-wrap h1 carry 1.1 leading + site tracking', () => {
    const legalM = STYLES.match(/\.legal-wrap h1,\s*\n\.legal-wrap h2\s*\{([^}]*)\}/);
    assert.ok(legalM, '.legal-wrap h1, h2 rule found');
    assert.match(legalM[1], /line-height:\s*1\.1/);
    assert.match(legalM[1], /letter-spacing:\s*-0\.02em/);

    // Anchor to line start so this matches the actual rule, not the
    // preceding comment's own inline-quoted `.writing-wrap h1 { ... }`
    // example (documenting the OLD 1.25 value it's replacing).
    const writingM = STYLES.match(/^\.writing-wrap h1\s*\{([^}]*)\}/m);
    assert.ok(writingM, '.writing-wrap h1 override found');
    assert.match(writingM[1], /line-height:\s*1\.1\s*!important/);
  });
});

describe('Wave E2 item 14: about.html and writing/index.html inline <style> shrank (dead-CSS removal)', () => {
  it('about.html no longer defines the dead status/badge/health/contact component CSS', () => {
    const about = fs.readFileSync(path.join(PUBLIC_DIR, 'about.html'), 'utf8');
    for (const dead of ['.overall-status {', '.status-dot {', '.badge {', '.links-grid {', '.health-block {', '.contact-block {']) {
      assert.ok(!about.includes(dead), `about.html should no longer declare ${dead}`);
    }
    assert.match(about, /\.page-title\s*\{[^}]*line-height:\s*1\.1/, 'about.html .page-title carries the 1.1 leading fix');
  });

  it('writing/index.html no longer defines the dead status/badge/waitlist/health/contact component CSS', () => {
    const writing = fs.readFileSync(path.join(PUBLIC_DIR, 'writing', 'index.html'), 'utf8');
    for (const dead of ['.overall-status {', '.status-dot {', '.badge {', '.waitlist-row {', '.links-grid {', '.health-block {', '.contact-block {']) {
      assert.ok(!writing.includes(dead), `writing/index.html should no longer declare ${dead}`);
    }
    assert.match(writing, /\.page-title\s*\{[^}]*line-height:\s*1\.1/, 'writing/index.html .page-title carries the 1.1 leading fix');
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
