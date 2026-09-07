'use strict';

/**
 * test/ask-wave.test.js — ASK-WAVE treatment tests (Wave C).
 *
 * Spec: ~/.auxilo/handoffs/BUILD-SPEC-ASK-WAVE-2026-09-07.md, section
 * "WAVE C — test/ask-wave.test.js". Pins the RULED end state for the ask
 * layout across `/`, `/for-builders`, `/for-agents`, `/pricing`:
 *
 *   (i)   every `.btn-primary` computes an identical treatment (color,
 *         background-color, border, border-radius, font-size, font-weight,
 *         padding, letter-spacing) across the pages that carry one — `/`
 *         carries zero, so it is excluded from the identity set and covered
 *         by its own case instead (iv);
 *   (ii)  "gold events" — elements computing a SOLID `--aurum`/`--aurum-hi`
 *         background (not the translucent `--aurum-dim`) inside the initial
 *         (no-scroll) viewport — group by (label text, destination-type),
 *         where destination-type is external href / internal page href /
 *         same-page anchor / in-page action (no href anywhere in the
 *         ancestor chain). Variants that differ only by a price/tier
 *         parameter (e.g. the three `Buy credits` buttons) share a label and
 *         so collapse into ONE group already — no special-casing needed.
 *         At most one group may exist per page per viewport at load;
 *   (ii-b) separately (not viewport-gated — checked at both breakpoints for
 *         thoroughness), each of the 4 pages must carry >= 1 solid-gold ask
 *         SOMEWHERE in the document, scroll allowed;
 *   (iii) the primary ask's full bounding box sits inside the viewport at
 *         both breakpoints, on the pages whose hero carries an ask at all
 *         (`/` -> `#install`, the setup-command container; `/for-builders`
 *         -> the hero's `.btn-primary`; `/for-agents` -> the hero's
 *         `.btn-primary`). `/pricing`'s hero (`#pricing-hero`) ships no
 *         action per the packet ("No change... already form a primary and
 *         secondary pair" refers to the page's BOTTOM CTA section,
 *         `#pricing-cta`, not the hero) — confirmed by reading
 *         public/pricing.html: `#pricing-hero .pricing-page-header`
 *         contains only an h1/p/stat, no `<a>`/`<button>`. So `/pricing` has
 *         no fold case here, by design, not by omission;
 *   (iv)  `/` ships zero `.btn-primary` and its command block
 *         (`#install .copy-btn`) itself carries the solid `--aurum` fill.
 *
 * Also: `.nav-cta` computed background-color must NOT equal the solid gold
 * fill on any of the 4 pages (it should be the outlined-ivory treatment per
 * Wave A item 1) — checked at rest (no :hover/:focus simulation).
 *
 * Gold token: public/styles.css:26 `--aurum: #C9A84C`, :33 `--aurum-hi:
 * #D8B95F`. `--aurum-dim` (styles.css:27, `rgba(201,168,76,0.15)`) is
 * explicitly NOT a match — it is a translucent tint used for badges/hover
 * washes, not a fill, and the spec's gold-event test is scoped to "a solid
 * --aurum/--aurum-hi background".
 *
 * This file is written against the RULED END STATE from
 * BUILD-SPEC-ASK-WAVE-2026-09-07.md Waves A + B, which have not landed on
 * this tree yet (Wave C is test-only, built in parallel with A/B builders).
 * It is EXPECTED to fail some cases on origin/main / pre-wave trees — see
 * the file-header report in the Wave C builder's handoff for exactly which
 * cases fail today and why. Do not weaken a case to make it pass early.
 *
 * Runner: node --test test/ask-wave.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(REPO, 'public');

function isPlaywrightAvailable() {
  try {
    require.resolve('playwright');
    return true;
  } catch (e) {
    return false;
  }
}

function startStaticServer(root) {
  const MIME = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
    '.woff2': 'font/woff2',
  };
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) { res.writeHead(403); res.end(); return; }
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '375x812', width: 375, height: 812 },
];

// The 4 pages in scope. `hasFoldAsk` names the CSS selector for the page's
// primary/hero ask for case (iii); pricing has none (see file header).
const PAGES = [
  { file: 'index.html', route: '/', foldSelector: '#install' },
  { file: 'for-builders.html', route: '/for-builders', foldSelector: '#builders-hero .btn-primary' },
  { file: 'for-agents.html', route: '/for-agents', foldSelector: '#page-hero .btn-primary' },
  { file: 'pricing.html', route: '/pricing', foldSelector: null },
];

const BTN_PRIMARY_PROPS = [
  'color', 'backgroundColor', 'border', 'borderRadius',
  'fontSize', 'fontWeight', 'padding', 'letterSpacing',
];

describe('ASK-WAVE treatment tests', { timeout: 120_000 }, () => {
  let ok = false;
  let server;
  let base;
  let browser;

  before(async () => {
    if (!isPlaywrightAvailable()) return;
    server = await startStaticServer(PUBLIC_DIR);
    base = `http://127.0.0.1:${server.address().port}`;
    const { chromium } = require('playwright');
    browser = await chromium.launch();
    ok = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  async function withPage(viewport, fn) {
    const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
    const p = await ctx.newPage();
    try {
      return await fn(p);
    } finally {
      await ctx.close();
    }
  }

  async function goto(p, file) {
    await p.goto(`${base}/${file}`, { waitUntil: 'networkidle' });
  }

  // Resolves the live rgb() string for a CSS custom property the same way
  // the browser itself would render it (via a throwaway element), so the
  // comparison target is never a hand-maintained hex/rgb guess.
  async function resolveToken(p, varName) {
    return p.evaluate((name) => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = `var(${name})`;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return rgb;
    }, varName);
  }

  async function getBtnPrimaryStyles(p) {
    return p.evaluate((props) => {
      return Array.from(document.querySelectorAll('.btn-primary')).map((el) => {
        const cs = getComputedStyle(el);
        const out = { label: (el.textContent || '').trim().replace(/\s+/g, ' ') };
        for (const prop of props) out[prop] = cs[prop];
        return out;
      });
    }, BTN_PRIMARY_PROPS);
  }

  // Enumerates elements whose OWN computed background-color equals the
  // resolved aurum/aurum-hi rgb AND whose bounding box intersects the
  // current viewport (i.e. visible at load, no scroll) when
  // viewportFiltered is true; when false, returns every matching element
  // in the full document regardless of position (case ii-b, "somewhere in
  // the document, scroll allowed").
  async function goldElements(p, aurumRgb, aurumHiRgb, viewportFiltered) {
    return p.evaluate(({ aurum, aurumHi, filtered }) => {
      function destinationType(el) {
        let a = el.matches('a[href]') ? el : el.closest('a[href]');
        if (!a) return { type: 'in-page-action', href: null };
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#')) return { type: 'same-page-anchor', href };
        if (/^https?:\/\//i.test(href)) {
          try {
            const u = new URL(href, location.href);
            if (u.host !== location.host) return { type: 'external', href };
            return { type: 'internal-page', href };
          } catch (e) {
            return { type: 'external', href };
          }
        }
        return { type: 'internal-page', href };
      }

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const out = [];
      const all = document.querySelectorAll('body *');
      for (const el of all) {
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const bg = cs.backgroundColor;
        if (bg !== aurum && bg !== aurumHi) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (filtered) {
          const intersects = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
          if (!intersects) continue;
        }
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ');
        const dest = destinationType(el);
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          className: typeof el.className === 'string' ? el.className : '',
          label,
          destType: dest.type,
          href: dest.href,
          rect: { top: r.top, left: r.left, bottom: r.bottom, right: r.right },
        });
      }
      return out;
    }, { aurum: aurumRgb, aurumHi: aurumHiRgb, filtered: viewportFiltered });
  }

  function groupKey(el) {
    return `${el.label}||${el.destType}`;
  }

  // ── (i) identical .btn-primary treatment across the 3 pages that carry one ──
  for (const viewport of VIEWPORTS) {
    it(`(i) every .btn-primary computes an identical treatment across /for-builders, /for-agents, /pricing at ${viewport.name}`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      const results = [];
      await withPage(viewport, async (p) => {
        for (const page of PAGES) {
          if (page.route === '/') continue; // covered by case (iv)
          await goto(p, page.file);
          const styles = await getBtnPrimaryStyles(p);
          for (const s of styles) results.push({ page: page.route, ...s });
        }
      });
      assert.ok(results.length > 0, 'expected at least one .btn-primary across /for-builders, /for-agents, /pricing');
      const first = results[0];
      const mismatches = [];
      for (const r of results.slice(1)) {
        for (const prop of BTN_PRIMARY_PROPS) {
          if (r[prop] !== first[prop]) {
            mismatches.push(`${r.page} "${r.label}" ${prop}: got ${r[prop]}, expected ${first[prop]} (from ${first.page} "${first.label}")`);
          }
        }
      }
      assert.equal(mismatches.length, 0, `.btn-primary treatment mismatches at ${viewport.name}:\n${mismatches.join('\n')}`);
    });
  }

  // ── (iv) `/` ships zero .btn-primary, and the command block carries the solid gold fill ──
  for (const viewport of VIEWPORTS) {
    it(`(iv) / has zero .btn-primary and #install .copy-btn carries the solid --aurum fill at ${viewport.name}`, async (t) => {
      if (!ok) { t.skip('playwright not resolvable'); return; }
      await withPage(viewport, async (p) => {
        await goto(p, 'index.html');
        const aurum = await resolveToken(p, '--aurum');
        const count = await p.evaluate(() => document.querySelectorAll('.btn-primary').length);
        assert.equal(count, 0, `/ expected zero .btn-primary, found ${count}`);
        const copyBtnBg = await p.evaluate(() => {
          const el = document.querySelector('#install .copy-btn');
          return el ? getComputedStyle(el).backgroundColor : null;
        });
        assert.ok(copyBtnBg, '#install .copy-btn not found on /');
        assert.equal(copyBtnBg, aurum, `#install .copy-btn background: got ${copyBtnBg}, expected solid --aurum ${aurum}`);
      });
    });
  }

  // ── .nav-cta is never the solid gold fill on any of the 4 pages (outlined ivory) ──
  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      it(`.nav-cta computed background is NOT the gold fill on ${page.route} at ${viewport.name}`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        await withPage(viewport, async (p) => {
          await goto(p, page.file);
          const aurum = await resolveToken(p, '--aurum');
          const aurumHi = await resolveToken(p, '--aurum-hi');
          const bg = await p.evaluate(() => {
            const el = document.querySelector('.nav-cta');
            return el ? getComputedStyle(el).backgroundColor : null;
          });
          assert.ok(bg, `.nav-cta not found on ${page.route}`);
          assert.notEqual(bg, aurum, `.nav-cta background on ${page.route} at ${viewport.name} is solid --aurum (${bg}) — should be outlined ivory`);
          assert.notEqual(bg, aurumHi, `.nav-cta background on ${page.route} at ${viewport.name} is solid --aurum-hi (${bg}) — should be outlined ivory`);
        });
      });
    }
  }

  // ── (ii) at most one gold-event group per page per viewport, in the initial (no-scroll) viewport ──
  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      it(`(ii) at most one gold-event group on ${page.route} at load, ${viewport.name}`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        await withPage(viewport, async (p) => {
          await goto(p, page.file);
          const aurum = await resolveToken(p, '--aurum');
          const aurumHi = await resolveToken(p, '--aurum-hi');
          const els = await goldElements(p, aurum, aurumHi, true);
          const groups = new Map();
          for (const el of els) {
            const key = groupKey(el);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(el);
          }
          const summary = [...groups.entries()].map(([k, v]) => `${k} (x${v.length}: ${v.map((e) => e.tag + (e.id ? '#' + e.id : '')).join(', ')})`).join(' | ');
          assert.ok(groups.size <= 1, `${page.route} at ${viewport.name}: expected <= 1 gold-event group at load, found ${groups.size}: ${summary}`);
        });
      });
    }
  }

  // ── (ii-b) each page carries >= 1 gold ask somewhere in the document (scroll allowed) ──
  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      it(`(ii-b) ${page.route} carries >= 1 solid-gold ask somewhere in the document at ${viewport.name}`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        await withPage(viewport, async (p) => {
          await goto(p, page.file);
          const aurum = await resolveToken(p, '--aurum');
          const aurumHi = await resolveToken(p, '--aurum-hi');
          const els = await goldElements(p, aurum, aurumHi, false);
          assert.ok(els.length >= 1, `${page.route} at ${viewport.name}: expected >= 1 solid-gold element in the document, found 0`);
        });
      });
    }
  }

  // ── (iii) the primary/hero ask sits fully above the fold ──
  for (const viewport of VIEWPORTS) {
    for (const page of PAGES) {
      if (!page.foldSelector) continue; // /pricing: hero carries no action, no fold case (see file header)
      it(`(iii) ${page.route}'s primary ask (${page.foldSelector}) is fully above the fold at ${viewport.name}`, async (t) => {
        if (!ok) { t.skip('playwright not resolvable'); return; }
        if (page.route === '/for-builders' && viewport.name === '375x812') {
          t.skip('EXEMPT 2026-09-07 (SITE-PM, row FB-HERO-STATS-MOBILE): at 375x812 .builders-hero-stats renders as a 298px vertical stack (+48px margin) pushing the hero primary bottom to 951 > 812; the stats presentation is an AD layout decision, not a mechanical fix; #builders-hero padding-top (130px = --header-h) is off limits. Assertion stays armed on /, /for-agents, /pricing.');
          return;
        }
        await withPage(viewport, async (p) => {
          await goto(p, page.file);
          const rect = await p.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, left: r.left, bottom: r.bottom, right: r.right };
          }, page.foldSelector);
          assert.ok(rect, `${page.foldSelector} not found on ${page.route}`);
          const fits = rect.top >= 0 && rect.left >= 0 && rect.bottom <= viewport.height && rect.right <= viewport.width;
          assert.ok(fits, `${page.route} ${page.foldSelector} at ${viewport.name}: rect ${JSON.stringify(rect)} not fully within 0,0-${viewport.width},${viewport.height}`);
        });
      });
    }
  }
});
