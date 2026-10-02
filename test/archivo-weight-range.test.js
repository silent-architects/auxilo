'use strict';

/**
 * test/archivo-weight-range.test.js
 *
 * The Archivo file the site ships is the variable font instanced to weights 400
 * to 600 and subset to Latin plus Latin Extended-A. Nothing may ask the sans for a
 * weight outside that range: the browser would clamp a request for 700 to 600 and
 * a request for 300 to 400, and the page would not be drawn as written. The one
 * place a weight below 400 is correct is the display serif (Newsreader 300, the
 * headings and the large figures set in var(--serif)).
 *
 * Two layers:
 *   1. Static: every font-weight declared in the shared sheet, in a page's style
 *      blocks and inline style attributes, and in the dashboard scripts is 400,
 *      500 or 600, unless the same rule sets the serif (or targets only h1 and h2,
 *      which the shared sheet sets in the serif). The Archivo @font-face declares
 *      exactly 400 600, and the shared sheet gives strong and b their weight.
 *   2. Live: every element holding text that is drawn in Archivo, on every page,
 *      computes to a weight from 400 to 600 (this catches a browser default such
 *      as the bold of strong, th and h4, which no declaration names).
 * Both layers have a positive control: the same checker is run on input that
 * breaks the rule and must report it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  reservePort,
  stageServer,
  bootServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const PUBLIC = path.join(REPO, 'public');
const MIN_WEIGHT = 400;
const MAX_WEIGHT = 600;

// ── Static layer ────────────────────────────────────────────────────────────

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// The weight a declaration asks for, as a number, or null when it cannot be a number
// (var(), inherit, initial, unset, and so on are not a new request).
function weightValue(raw) {
  const v = raw.trim().replace(/\s*!important\s*$/i, '').toLowerCase();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  if (v === 'bolder') return 700; // from a 400 parent, the case that matters here
  if (v === 'lighter') return 100;
  return null;
}

// A rule sets text in the display serif when it names the serif family itself, or
// when every selector in its list ends in an h1 or an h2 (the shared sheet sets both
// in the serif).
function isSerifRule(selector, body) {
  if (/font-family\s*:[^;}]*(var\(--serif\)|Newsreader)/i.test(body)) return true;
  const selectors = selector.split(',').map((s) => s.trim()).filter(Boolean);
  if (selectors.length === 0) return false;
  return selectors.every((sel) => {
    const lastCompound = sel.split(/[\s>+~]+/).filter(Boolean).pop() || '';
    return /^h[12](?![\w-])/.test(lastCompound);
  });
}

// Every weight request in a block of CSS that is not in range and not drawn in the serif.
function outOfRangeWeights(css, where) {
  const found = [];
  const clean = stripComments(css);
  for (const m of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (/^@font-face/i.test(selector)) continue; // the face's own range is asserted separately
    for (const d of body.matchAll(/(?:^|;|\s)font-weight\s*:\s*([^;}]+)/gi)) {
      const weight = weightValue(d[1]);
      if (weight === null) continue;
      if (weight >= MIN_WEIGHT && weight <= MAX_WEIGHT) continue;
      if (isSerifRule(selector, body)) continue;
      found.push(`${where}: ${selector.replace(/\s+/g, ' ').slice(0, 80)} { font-weight: ${d[1].trim()} }`);
    }
  }
  return found;
}

// Inline style="..." attributes and SVG font-weight="..." attributes in a page.
function outOfRangeInline(html, where) {
  const found = [];
  for (const m of html.matchAll(/style="([^"]*)"/gi)) {
    const body = m[1];
    for (const d of body.matchAll(/font-weight\s*:\s*([^;"]+)/gi)) {
      const weight = weightValue(d[1]);
      if (weight === null || (weight >= MIN_WEIGHT && weight <= MAX_WEIGHT)) continue;
      if (/font-family\s*:[^;"]*(var\(--serif\)|Newsreader)/i.test(body)) continue;
      found.push(`${where}: style="${body.slice(0, 80)}"`);
    }
  }
  for (const m of html.matchAll(/<[a-z][^>]*\sfont-weight="([^"]+)"[^>]*>/gi)) {
    const weight = weightValue(m[1]);
    if (weight === null || (weight >= MIN_WEIGHT && weight <= MAX_WEIGHT)) continue;
    if (/font-family="[^"]*(Newsreader)/i.test(m[0])) continue;
    found.push(`${where}: ${m[0].slice(0, 100)}`);
  }
  return found;
}

// Script text that sets a weight (the three dashboard scripts build markup and styles).
function outOfRangeInScript(js, where) {
  const found = [];
  for (const m of js.matchAll(/font-weight\s*:\s*([^;"'`}]+)/gi)) {
    const weight = weightValue(m[1]);
    if (weight !== null && (weight < MIN_WEIGHT || weight > MAX_WEIGHT)) found.push(`${where}: font-weight: ${m[1].trim()}`);
  }
  for (const m of js.matchAll(/fontWeight\s*=\s*['"]?([a-z0-9.]+)/gi)) {
    const weight = weightValue(m[1]);
    if (weight !== null && (weight < MIN_WEIGHT || weight > MAX_WEIGHT)) found.push(`${where}: fontWeight = ${m[1]}`);
  }
  return found;
}

function styleBlocks(html) {
  return [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

function listFiles(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'fonts') continue;
      listFiles(full, ext, out);
    } else if (entry.name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

describe('Archivo weight range, static: nothing declares a sans weight outside 400 to 600', () => {
  const sheet = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
  const pages = listFiles(PUBLIC, '.html').map((file) => ({ rel: path.relative(PUBLIC, file), html: fs.readFileSync(file, 'utf8') }));
  const scripts = listFiles(PUBLIC, '.js').map((file) => ({ rel: path.relative(PUBLIC, file), js: fs.readFileSync(file, 'utf8') }));

  it('the checker sees the site: the shared sheet, every page, and the dashboard scripts are all read', () => {
    assert.ok(sheet.length > 10_000, 'the shared sheet is read');
    const names = pages.map((p) => p.rel);
    for (const required of ['index.html', 'dashboard.html', 'works-with.html', 'for-agents.html', 'writing/index.html']) {
      assert.ok(names.includes(required), `${required} is read (${names.join(', ')})`);
    }
    assert.ok(pages.some((p) => styleBlocks(p.html).length > 0), 'at least one page carries a style block');
    assert.ok(scripts.length >= 2, `the dashboard scripts are read (${scripts.map((s) => s.rel).join(', ')})`);
    const declared = [...stripComments(sheet).matchAll(/font-weight\s*:\s*([^;}]+)/gi)].length;
    assert.ok(declared > 30, `the shared sheet declares weights the checker can see (${declared})`);
  });

  it('public/styles.css declares no sans weight outside 400 to 600', () => {
    const found = outOfRangeWeights(sheet, 'styles.css');
    assert.deepEqual(found, [], `weights outside ${MIN_WEIGHT} to ${MAX_WEIGHT} on sans text:\n  ${found.join('\n  ')}`);
  });

  it('no page style block, inline style or SVG attribute declares a sans weight outside 400 to 600', () => {
    const found = [];
    for (const { rel, html } of pages) {
      for (const block of styleBlocks(html)) found.push(...outOfRangeWeights(block, rel));
      found.push(...outOfRangeInline(html, rel));
    }
    assert.deepEqual(found, [], `weights outside ${MIN_WEIGHT} to ${MAX_WEIGHT} on sans text:\n  ${found.join('\n  ')}`);
  });

  it('no dashboard script sets a weight outside 400 to 600', () => {
    const found = [];
    for (const { rel, js } of scripts) found.push(...outOfRangeInScript(js, rel));
    assert.deepEqual(found, [], `weights outside ${MIN_WEIGHT} to ${MAX_WEIGHT}:\n  ${found.join('\n  ')}`);
  });

  it('the Archivo @font-face declares exactly the weights the file holds, 400 to 600', () => {
    const faces = [...stripComments(sheet).matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /font-family:\s*'Archivo'/.test(b));
    assert.ok(faces.length >= 1, 'an Archivo @font-face exists');
    // Archivo ships as a core file and an Ext file (split by unicode-range), both instanced to 400 to 600.
    for (const face of faces) assert.match(face, /font-weight:\s*400 600\s*;/);
  });

  it('strong and b take weight 600 from the shared sheet, so the browser default (700) is never requested', () => {
    assert.match(stripComments(sheet), /(^|\})\s*strong\s*,\s*b\s*\{[^}]*font-weight:\s*600\s*;/m);
  });

  it('mono inside strong or b takes weight 400, the only mono weight that ships', () => {
    const css = stripComments(sheet);
    assert.match(css, /(^|\})\s*strong code\s*,\s*b code\s*\{[^}]*font-weight:\s*400\s*;/m);
    // Positive control: the mono face is declared at 400 and no 500 mono face exists.
    const mono = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /font-family:\s*'IBM Plex Mono'\s*;/.test(b));
    assert.equal(mono.length, 1);
    assert.match(mono[0], /font-weight:\s*400\s*;/);
  });

  // ── Positive controls: the checker reports input that breaks the rule ──
  it('control: the checker reports 700, bold, bolder, 300 on a sans class, 100 and lighter, in a rule, an inline style and a script', () => {
    const css = [
      '.a { font-weight: 700; }',
      '.b { font-weight: bold; }',
      'p strong { font-weight: bolder; }',
      '.c { font-weight: 300; font-family: var(--sans); }',
      '.d { font-weight: 100 }',
      '@media (max-width: 480px) { .e { font-weight: lighter; } }',
    ].join('\n');
    const found = outOfRangeWeights(css, 'control');
    assert.equal(found.length, 6, `all six are reported, got ${JSON.stringify(found)}`);
    assert.equal(outOfRangeInline('<p style="font-weight:700;color:red">x</p>', 'control').length, 1, 'an inline 700 is reported');
    assert.equal(outOfRangeInline('<text font-family="Archivo" font-weight="800">x</text>', 'control').length, 1, 'an SVG 800 is reported');
    assert.equal(outOfRangeInScript("el.style.cssText = 'font-weight:700'; el.style.fontWeight = '900';", 'control').length, 2, 'script weights are reported');
  });

  it('control: the checker lets through the in-range weights, var(), the serif at 300, and an h1 or h2 at 300', () => {
    const css = [
      '.a { font-weight: 400; }',
      '.b { font-weight: 500; }',
      '.c { font-weight: 600 !important; }',
      '.d { font-weight: var(--w); }',
      '.e { font-weight: inherit; }',
      '.f { font-family: var(--serif); font-weight: 300; }',
      "#hero h1 { font-weight: 300; }",
      '.g h2, h2.x { font-weight: 300; }',
      '@font-face { font-family: "Newsreader"; font-weight: 300; }',
    ].join('\n');
    assert.deepEqual(outOfRangeWeights(css, 'control'), []);
    assert.deepEqual(outOfRangeInline('<p style="font-weight:500">x</p><text font-family="Newsreader, Georgia" font-weight="300">y</text>', 'control'), []);
  });
});

// ── Live layer ──────────────────────────────────────────────────────────────

const PAGES = [
  '/', '/for-builders', '/for-agents', '/how-it-works', '/pricing', '/works-with',
  '/about', '/connect', '/how-submissions-work', '/status', '/api', '/terms',
  '/privacy', '/legal/subprocessors', '/legal/supported-clients', '/dashboard',
  '/writing', '/writing/agents-message-board', '/account/email-prefs/unsubscribe',
];

// Every element holding text of its own that is drawn in Archivo, with its computed weight.
function measureArchivoWeights() {
  const out = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName)) continue;
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim()) { hasText = true; break; }
    }
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    const family = cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim();
    if (family !== 'Archivo') continue;
    out.push({
      tag: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).join('.')}` : ''),
      weight: parseFloat(cs.fontWeight),
      text: el.textContent.trim().slice(0, 40),
    });
  }
  return out;
}

describe('Archivo weight range, live: every element drawn in Archivo computes to 400 to 600', { timeout: 300_000 }, () => {
  let bootSkipReason = null;
  let tmpDir;
  let child;
  let baseUrl;
  let browser;
  let playwrightOk = false;

  before(async () => {
    try {
      require.resolve('playwright', { paths: [REPO] });
    } catch (e) {
      return;
    }
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) {
      bootSkipReason = reservation.skipReason;
      return;
    }
    const { port } = reservation;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-archivo-weights-'));
    stageServer({
      repoRoot: REPO,
      tmpDir,
      nodeModulesDir,
      port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config', 'docs'],
    });
    const boot = await bootServer({
      tmpDir,
      port,
      env: {
        NODE_ENV: 'test',
        SESSION_SECRET: 'archivo-weights-test-session-secret-0123456789',
        RESEND_API_KEY: '',
        LLM_SENSITIVITY_ENABLED: 'false',
        WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
        HOME: tmpDir,
        AUXILO_HOME: path.join(tmpDir, 'auxilo-home'),
      },
      timeoutMs: 60_000,
      maxAttempts: 3,
    });
    if ('skipReason' in boot) {
      bootSkipReason = boot.skipReason;
      return;
    }
    child = boot.child;
    baseUrl = boot.baseUrl;
    const { chromium } = require(path.join(nodeModulesDir, 'playwright'));
    browser = await chromium.launch();
    playwrightOk = true;
  });

  after(async () => {
    if (browser) await browser.close();
    if (child) await stopServer(child);
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const route of PAGES) {
    it(`${route}: every element drawn in Archivo computes to a weight from ${MIN_WEIGHT} to ${MAX_WEIGHT}`, async (t) => {
      if (bootSkipReason) { t.skip(bootSkipReason); return; }
      if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      try {
        await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle' });
        const measured = await page.evaluate(measureArchivoWeights);
        assert.ok(measured.length > 0, 'the page holds text drawn in Archivo to measure');
        const bad = measured.filter((m) => m.weight < MIN_WEIGHT || m.weight > MAX_WEIGHT);
        assert.deepEqual(bad, [], `Archivo asked for a weight it does not have on ${route}:\n  ${bad.map((b) => `${b.tag} weight ${b.weight} "${b.text}"`).join('\n  ')}`);
      } finally {
        await ctx.close();
      }
    });
  }

  it('control: the live measurement reports Archivo text set at 700, 300 and bold, and passes it at 600', async (t) => {
    if (bootSkipReason) { t.skip(bootSkipReason); return; }
    if (!playwrightOk) { t.skip('playwright not resolvable'); return; }
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    try {
      await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
      await page.evaluate(() => {
        const add = (id, style) => {
          const p = document.createElement('p');
          p.id = id;
          p.textContent = `control ${id}`;
          p.style.cssText = `font-family: var(--sans); ${style}`;
          document.body.appendChild(p);
        };
        add('w700', 'font-weight: 700');
        add('w300', 'font-weight: 300');
        add('wbold', 'font-weight: bold');
        add('w600', 'font-weight: 600');
        const s = document.createElement('p');
        s.id = 'wdefault';
        s.innerHTML = '<span style="font-family: var(--sans)"><b id="bare-b">control bare b</b></span>';
        document.body.appendChild(s);
      });
      const measured = await page.evaluate(measureArchivoWeights);
      const byText = Object.fromEntries(measured.map((m) => [m.text, m.weight]));
      assert.equal(byText['control w700'], 700, 'a 700 request is measured as 700');
      assert.equal(byText['control w300'], 300, 'a 300 request is measured as 300');
      assert.equal(byText['control wbold'], 700, 'bold is measured as 700');
      assert.equal(byText['control w600'], 600, 'a 600 request passes');
      assert.equal(byText['control bare b'], 600, 'a bare b takes the shared sheet\'s 600');
      const bad = measured.filter((m) => m.weight < MIN_WEIGHT || m.weight > MAX_WEIGHT).map((m) => m.text);
      assert.deepEqual(bad.sort(), ['control w300', 'control w700', 'control wbold']);
    } finally {
      await ctx.close();
    }
  });
});
