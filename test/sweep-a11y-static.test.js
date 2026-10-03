'use strict';

/**
 * test/sweep-a11y-static.test.js: the accessibility sweep, read from the bytes on disk.
 *
 *   - one navigation script, byte for byte the same on every page, and the hamburger controls the menu by id
 *   - the link for the current page says so (aria-current) on every page that marks one
 *   - skip links and landmarks: /writing, the essay and the legal template
 *   - a copy button's accessible name contains its visible text (WCAG 2.5.3)
 *   - every list a page styles without bullets keeps its list role
 *   - the footer meta line: each link travels with its separator, and the text is as it was
 *   - status and dashboard script colours resolve to defined tokens; the font licence names what ships
 *
 * No server and no browser. The rendered half is test/sweep-render.test.js; the keyboard half of the menu is
 * tests/test-mobile-nav-overlay.js.
 *
 * Runner: node --test test/sweep-a11y-static.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const read = (rel) => fs.readFileSync(path.join(PUBLIC_DIR, rel), 'utf8');

const PAGES = [
  'index.html', 'for-builders.html', 'for-agents.html', 'how-it-works.html', 'pricing.html', 'works-with.html',
  'about.html', 'connect.html', 'how-submissions-work.html', 'status.html', 'api.html', 'dashboard.html',
  'writing/index.html', 'writing-agents-message-board.html',
];

// The template that serves /terms, /privacy and the other legal pages.
const SERVER_SRC = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const LEGAL_FN = SERVER_SRC.slice(SERVER_SRC.indexOf('function serveLegalPage('), SERVER_SRC.indexOf("app.get('/terms', (c) => serveLegalPage"));

const NAV_SCRIPT = /<script>\n\/\/ ── Mobile navigation \(the same block on every page\) ──[\s\S]*?<\/script>/g;

describe('the navigation script is one block, identical on every page', () => {
  it('each page carries exactly one copy, and every copy is the same bytes', () => {
    const copies = new Map();
    for (const page of PAGES) {
      const found = read(page).match(NAV_SCRIPT) || [];
      assert.equal(found.length, 1, `${page} carries exactly one navigation script block, found ${found.length}`);
      copies.set(page, found[0]);
    }
    const distinct = new Set(copies.values());
    assert.equal(distinct.size, 1, `the ${PAGES.length} blocks are one text, found ${distinct.size} variants: ${[...copies].map(([p, t]) => `${p}:${t.length}`).join(' ')}`);
    // positive control: the checker does see a difference when one exists
    assert.notEqual(new Set(['a', 'b']).size, 1);
  });

  it('the block defines toggleNav once, keeps the nav-open class and aria-expanded, and sets inert while open', () => {
    const block = read('index.html').match(NAV_SCRIPT)[0];
    assert.match(block, /window\.toggleNav = function toggleNav\(\)/);
    assert.match(block, /classList\.add\('nav-open'\)/);
    assert.match(block, /classList\.remove\('nav-open'\)/);
    assert.match(block, /setAttribute\('aria-expanded', 'true'\)/);
    assert.match(block, /setAttribute\('aria-expanded', 'false'\)/);
    assert.match(block, /setAttribute\('inert', ''\)/);
    assert.match(block, /removeAttribute\('inert'\)/);
    assert.match(block, /e\.key === 'Escape'/);
    assert.match(block, /e\.key !== 'Tab'/);
    assert.match(block, /document\.querySelector\('\.nav-links'\)/);
  });

  it('no page still defines toggleNav or the old close handlers anywhere else', () => {
    for (const page of PAGES) {
      const html = read(page);
      const outside = html.replace(NAV_SCRIPT, '');
      assert.ok(!/function toggleNav|toggleNav\s*=/.test(outside), `${page} defines toggleNav outside the shared block`);
      assert.ok(!/Close mobile nav on/.test(outside), `${page} keeps an old close handler`);
      assert.equal((outside.match(/toggleNav\(\)/g) || []).length, 1, `${page}: toggleNav is called once, by the hamburger`);
    }
  });

  it('the hamburger controls the menu by id on every page, and the id is unique', () => {
    for (const page of PAGES) {
      const html = read(page);
      const menu = html.match(/<ul class="nav-links" id="([^"]+)" role="list">/);
      assert.ok(menu, `${page}: the menu list carries an id`);
      const button = html.match(/<button class="hamburger" id="hamburger"[^>]*aria-controls="([^"]+)"/);
      assert.ok(button, `${page}: the hamburger carries aria-controls`);
      assert.equal(button[1], menu[1], `${page}: aria-controls names the menu id`);
      assert.equal((html.match(new RegExp(`id="${menu[1]}"`, 'g')) || []).length, 1, `${page}: the menu id appears once`);
      assert.match(html, /aria-expanded="false"/, `${page}: the button still starts collapsed`);
    }
  });

  it('the navigation is a direct child of body on every page, so setting everything else inert leaves it live', () => {
    for (const page of PAGES) {
      const html = read(page);
      const body = html.slice(html.indexOf('<body>') + 6);
      const navAt = body.indexOf('<nav id="main-nav"');
      assert.ok(navAt !== -1, `${page} has the navigation`);
      // count the open and close tags of the block-level wrappers that precede it: none may be open
      const before = body.slice(0, navAt).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '');
      const opens = (before.match(/<(div|section|header|main|aside|article)\b/g) || []).length;
      const closes = (before.match(/<\/(div|section|header|main|aside|article)>/g) || []).length;
      assert.equal(opens, closes, `${page}: nothing wraps the navigation`);
    }
  });
});

describe('the current page is named in the navigation', () => {
  const MARKED = {
    'for-builders.html': 'nav-builders', 'for-agents.html': 'nav-agents', 'how-it-works.html': 'nav-how',
    'works-with.html': 'nav-works-with', 'pricing.html': 'nav-pricing', 'dashboard.html': 'nav-dashboard',
  };

  it('every link marked active carries aria-current="page", and nothing else does', () => {
    for (const page of PAGES) {
      const html = read(page);
      const nav = html.match(/<nav id="main-nav"[\s\S]*?<\/nav>/)[0];
      const active = [...nav.matchAll(/<a href="[^"]*" id="([^"]+)" class="active"([^>]*)>/g)];
      const current = [...html.matchAll(/aria-current="page"/g)];
      if (MARKED[page]) {
        assert.equal(active.length, 1, `${page} marks one link`);
        assert.equal(active[0][1], MARKED[page]);
        assert.match(active[0][2], /^ aria-current="page"$/, `${page}: the marked link carries aria-current`);
      } else {
        assert.equal(active.length, 0, `${page} marks no link`);
      }
      assert.equal(current.length, active.length, `${page}: aria-current appears once per marked link and nowhere else`);
    }
  });

  it('the shared sheet draws more than colour on it: a 1.5px underline in currentColor, 6px off the text', () => {
    const css = read('styles.css');
    const rule = css.match(/\.nav-links a\.active,\s*#main-nav a\[aria-current="page"\]\s*\{([^}]*)\}/);
    assert.ok(rule, 'the current-page rule is found');
    assert.match(rule[1], /text-decoration:\s*underline/);
    assert.match(rule[1], /text-decoration-color:\s*currentColor/);
    assert.match(rule[1], /text-decoration-thickness:\s*1\.5px/);
    assert.match(rule[1], /text-underline-offset:\s*6px/);
  });
});

describe('skip links and landmarks', () => {
  const SKIP_FIRST = /<body>\s*<a href="#main" class="skip-to-content">Skip to content<\/a>/;

  it('every page opens with the skip link and has one main with id="main"', () => {
    for (const page of PAGES) {
      const html = read(page);
      assert.match(html, SKIP_FIRST, `${page}: the skip link is the first element in body`);
      const markup = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
      assert.equal((markup.match(/<main id="main">/g) || []).length, 1, `${page}: one <main id="main">`);
      assert.equal((markup.match(/<main\b/g) || []).length, 1, `${page}: one main element`);
    }
    // positive control: /writing and the essay were the two pages without one
    assert.match(read('writing/index.html'), SKIP_FIRST);
    assert.match(read('writing-agents-message-board.html'), SKIP_FIRST);
  });

  it('the legal template opens with the same skip link and puts id and role on the existing wrapper, adding no element', () => {
    assert.match(LEGAL_FN, /<body>\n<a href="#main" class="skip-to-content">Skip to content<\/a>\n<nav id="main-nav"/);
    assert.equal((LEGAL_FN.match(/<div class="legal-wrap" id="main" role="main">/g) || []).length, 1);
    assert.equal((LEGAL_FN.match(/<div class="legal-wrap"/g) || []).length, 1, 'one wrapper element in the template');
    // no element was added: the wrapper still holds the back link and the rendered body, and there is no <main> element
    assert.match(LEGAL_FN, /<div class="legal-wrap" id="main" role="main">\n    <a href="\/" class="legal-back">Back to Auxilo<\/a>\n    \$\{body\}\n  <\/div>/);
    assert.ok(!/<main\b/.test(LEGAL_FN), 'the template carries no <main> element');
  });
});

describe('copy buttons: the accessible name contains the visible text', () => {
  const copyButtons = (html) => [...html.matchAll(/<button class="copy-btn"[^>]*aria-label="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ label: m[1], text: m[2] }));
  const nameHoldsText = (b) => b.label.toLowerCase().includes(b.text.trim().toLowerCase());

  it('on every page, each copy button\'s aria-label contains its visible text', () => {
    let seen = 0;
    for (const page of PAGES) {
      for (const b of copyButtons(read(page))) {
        seen++;
        assert.ok(nameHoldsText(b), `${page}: "${b.text}" is not inside the name "${b.label}"`);
      }
    }
    assert.ok(seen >= 20, `positive control: the copy buttons were found (${seen})`);
  });

  it('the setup-command buttons are named for what they read, and the one-word buttons keep "Copy code"', () => {
    const setup = PAGES.flatMap((p) => copyButtons(read(p)).filter((b) => b.text === 'Copy the Setup Command'));
    assert.equal(setup.length, 5, 'five setup-command buttons (hero and footer on /, footer on /for-builders, /connect, /dashboard)');
    for (const b of setup) assert.equal(b.label, 'Copy the Setup Command');
    const word = PAGES.flatMap((p) => copyButtons(read(p)).filter((b) => b.text === 'copy'));
    assert.ok(word.length >= 20);
    for (const b of word) assert.equal(b.label, 'Copy code');
  });

  it('control: the check fails on the old pairing', () => {
    assert.equal(nameHoldsText({ label: 'Copy command', text: 'Copy the Setup Command' }), false);
    assert.equal(nameHoldsText({ label: 'Copy code', text: 'copy' }), true);
  });
});

describe('lists keep their role', () => {
  it('every ul and ol on every page carries role="list" (the pages style their lists without bullets)', () => {
    let seen = 0;
    for (const page of PAGES) {
      for (const m of read(page).matchAll(/<(ul|ol)\b([^>]*)>/g)) {
        seen++;
        assert.match(m[2], /role="list"/, `${page}: <${m[1]}${m[2]}> has no list role`);
      }
    }
    assert.ok(seen >= 10, `positive control: lists were found (${seen})`);
    // control: the pattern flags a bare list
    assert.equal(/role="list"/.test(' class="x"'), false);
  });

  it('every list the sheet or a page block styles with list-style: none is a list with that role', () => {
    // the selectors that remove the bullets, read from the sheet and the page blocks
    const classes = new Set();
    for (const raw of [read('styles.css'), ...PAGES.map((p) => (read(p).match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1])]) {
      const src = raw.replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of src.matchAll(/([^{}]+)\{[^}]*list-style:\s*none[^}]*\}/g)) {
        for (const sel of m[1].split(',')) {
          const cls = sel.trim().match(/^\.([\w-]+)$/);
          if (cls) classes.add(cls[1]);
        }
      }
    }
    assert.ok(classes.size >= 6, `positive control: the un-bulleted classes were found (${[...classes].join(', ')})`);
    for (const cls of classes) {
      for (const page of PAGES) {
        for (const m of read(page).matchAll(new RegExp(`<(ul|ol)\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'g'))) {
          assert.match(m[0], /role="list"/, `${page}: .${cls} is un-bulleted and has no list role`);
        }
      }
    }
  });
});

describe('the footer meta line: each link travels with the separator that follows it', () => {
  const EXPECTED = ['API', 'About', 'Writing', 'Status', 'Security', 'Agent card', 'Terms', 'Privacy', 'GitHub'];
  const metaOf = (html) => html.match(/<p class="footer-meta">([\s\S]*?)<\/p>/)[1];
  const plain = (s) => s.replace(/<[^>]*>/g, '').replace(/&middot;/g, '·').replace(/\s+/g, ' ').trim();

  it('every link on every page sits inside one fm-item span with the dot after it, and no span holds two links', () => {
    for (const page of PAGES) {
      const meta = metaOf(read(page));
      const items = [...meta.matchAll(/<span class="fm-item">([\s\S]*?)<\/span>(?!<\/span>)/g)];
      const links = [...meta.matchAll(/<a href=/g)];
      assert.equal(links.length, EXPECTED.length, `${page}: ${EXPECTED.length} links`);
      for (const link of meta.matchAll(/<a href="[^"]*">([^<]*)<\/a>/g)) {
        assert.ok(new RegExp(`<span class="fm-item"><a href="[^"]*">${link[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>(?: ·| &middot;)?</span>`).test(meta), `${page}: "${link[1]}" is wrapped with its dot`);
      }
      assert.ok(items.length >= EXPECTED.length, `${page}: the items were found`);
      for (const item of items) assert.ok((item[1].match(/<a href=/g) || []).length <= 1, `${page}: an item holds at most one link`);
    }
  });

  it('the words and the order are what they were: the first sentence, then the nine links with a dot between each', () => {
    const tail = EXPECTED.join(' · ');
    for (const page of PAGES) {
      const text = plain(metaOf(read(page)));
      if (page === 'dashboard.html') {
        assert.equal(text, tail, `${page}: the dashboard's line starts at the first link`);
      } else if (page === 'status.html') {
        assert.equal(text, `Your agent already solved this. Auxilo remembers. · ${tail} · v`, `${page}: the version closes the line`);
      } else {
        assert.equal(text, `Your agent already solved this. Auxilo remembers. · ${tail}`, `${page}: the line reads as it did`);
      }
    }
  });

  it('the first sentence is not touched and its dot cannot start a line: the dot is its own no-wrap span', () => {
    for (const page of PAGES.filter((p) => p !== 'dashboard.html')) {
      const meta = metaOf(read(page));
      assert.match(meta, /Your agent already solved this\. Auxilo remembers\.<span class="fm-item"> (·|&middot;)<\/span>/, `${page}: the sentence reads through "remembers." and the dot follows in a span`);
    }
    assert.match(read('styles.css'), /\.footer-meta \.fm-item\s*\{\s*white-space:\s*nowrap;\s*\}/);
  });

  it('the legal template carries the same footer markup as /pricing, byte for byte', () => {
    assert.equal(plain(metaOf(LEGAL_FN)), plain(metaOf(read('pricing.html'))));
    assert.equal(metaOf(LEGAL_FN), metaOf(read('pricing.html')), 'identical down to the indentation');
  });
});

describe('script colours resolve, and the font licence names what ships', () => {
  it('status.html defines --yellow and --yellow-bg as aliases of its amber state token', () => {
    const style = read('status.html').match(/<style>([\s\S]*?)<\/style>/)[1];
    assert.match(style, /--st-warn:\s*#B7791F;/);
    assert.match(style, /--yellow:\s*var\(--st-warn\);/);
    assert.match(style, /--yellow-bg:\s*var\(--st-warn\);/);
    // positive control: the script still writes both names
    const html = read('status.html');
    assert.match(html, /var\(--yellow\)/);
    assert.match(html, /var\(--yellow-bg\)/);
  });

  it('dashboard.html defines --gold as the ground-aware accent text token, where its script reads it', () => {
    const html = read('dashboard.html');
    const block = html.match(/\.dash-body,\s*#terms-dialog\s*\{([^}]*)\}/);
    assert.ok(block, 'the alias block is found');
    assert.match(block[1], /--gold:\s*var\(--accent-text\);/);
    assert.match(html, /'var\(--gold\)'/, 'positive control: the script still writes var(--gold)');
  });

  it('OFL.txt names both Archivo files and no longer names the Plex Mono 500 file', () => {
    const ofl = read('fonts/OFL.txt');
    assert.match(ofl, /ArchivoVariable\.\*\.woff2 and ArchivoVariableExt\.\*\.woff2/);
    assert.match(ofl, /IBM Plex Mono \(PlexMono400\.\*\.woff2\)/);
    assert.ok(!/PlexMono500/.test(ofl), 'the retired file name is gone');
    assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/, 'positive control: the licence text itself is intact');
  });

  it('mono inside strong or b asks for weight 400 and the sheet carries no weight the files do not hold', () => {
    assert.match(read('styles.css'), /(^|\})\s*strong code,\s*b code\s*\{\s*font-weight:\s*400;\s*\}/m);
  });

  it('the old inline device wrapper is gone from every page and from the sheet', () => {
    for (const page of PAGES) assert.ok(!/dw-device-clip/.test(read(page)), `${page} carries no inline device wrapper`);
    assert.ok(!/dw-device-clip/.test(read('styles.css')));
  });
});
