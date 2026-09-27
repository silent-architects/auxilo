'use strict';

/**
 * test/launch-wave-email-font.test.js — PM-found regression: every rendered
 * email's heading and body text falls back to the mail client's serif
 * default (Times in Apple Mail and Outlook), because `renderEmail()`
 * (lib/email.js) only ever set `font-family` on the wordmark cell and the
 * button -- never on <body>, the content cell, the heading <p>, or the
 * footer cell (which sits in its own nested table and cannot reliably
 * inherit from an ancestor in Outlook/Apple Mail). origin/main wrapped
 * everything in one `font-family` div; this wave's rebuild dropped it.
 *
 * Fix (lib/email.js, renderEmail): `font-family:${FONT_STACK}` added to
 * <body>, the content <td> (padding:40px 32px), the heading <p>, and the
 * footer <td> -- the four spots that either hold text directly or start a
 * new nested table a descendant text node cannot inherit through. No word,
 * color, size, or spacing changed. The one deliberate exception (the
 * `npx auxilo setup` line in the welcome email) keeps its monospace family,
 * untouched.
 *
 * Two tiers:
 *   1. Static (string-level): every font-family declaration in each of the
 *      five rendered HTML bodies is exactly the sans stack or exactly the
 *      monospace stack -- nothing else, i.e. no serif name (or bare generic
 *      "serif") can appear.
 *   2. Rendered (Playwright, network fully blocked via page.route abort on
 *      every request): for every element carrying its own visible text, the
 *      computed font-family starts with the sans stack's first token,
 *      except the one monospace command line. A positive control (family
 *      stripped from a copy of the content cell) proves the rendered check
 *      can actually fail.
 *
 * Tests never touch the real HOME directory or the network -- page.setContent
 * loads a literal string, and every request the page could still attempt
 * (the hosted logo image) is aborted by the route handler, never sent.
 *
 * Runner: node --test test/launch-wave-email-font.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const email = require('../lib/email.js');

const FONT_STACK = email.FONT_STACK;
const MONO_STACK = "ui-monospace,'JetBrains Mono',monospace";
const SANS_FIRST_TOKEN = '-apple-system';
const SAMPLE_URL = 'https://auxilo.io/auth/verify?token=SAMPLE';
const PREFS_URL = 'https://auxilo.io/account/email-prefs/unsubscribe?token=abc123';

function isPlaywrightAvailable() {
  try { require.resolve('playwright'); return true; } catch { return false; }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// --- shared fetch/env save-restore helper, same pattern as test/email-template.test.js ---
let saved = null;
function stashEnvAndFetch() {
  saved = { key: process.env.RESEND_API_KEY, fetch: global.fetch };
}
function restoreEnvAndFetch() {
  if (!saved) return;
  if (saved.key === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = saved.key;
  global.fetch = saved.fetch;
  saved = null;
}
async function captureSend(sendFn) {
  stashEnvAndFetch();
  process.env.RESEND_API_KEY = 'test-key';
  let captured = null;
  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return { ok: true, status: 202 };
  };
  await sendFn();
  restoreEnvAndFetch();
  return captured;
}

async function getAllFiveBodies() {
  const signIn = await captureSend(() => email.sendMagicLink('user@example.com', SAMPLE_URL));
  const deletion = await captureSend(() => email.sendDeletionConfirmation('user@example.com', SAMPLE_URL));
  const welcome = email.buildWelcomeEmailBodies('https://auxilo.io/connect');
  const unlockSingle = email.buildEarningSingleBodies({
    title: 'Rate limit workaround for the Widgets API',
    amountUsd: 0.987,
    totalAccrued: 12.34,
    prefsUrl: PREFS_URL,
  });
  const unlockDigest = email.buildEarningDigestBodies({
    items: [
      { learningId: 'lrn_a', title: 'Learning A', amountUsd: 0.5, ts: Date.parse('2026-09-10T00:00:00.000Z') },
      { learningId: 'lrn_b', title: 'Learning B', amountUsd: 0.7, ts: Date.parse('2026-09-12T00:00:00.000Z') },
    ],
    totalAccrued: 5,
    prefsUrl: PREFS_URL,
  });
  return {
    'sign-in': signIn.html,
    'deletion': deletion.html,
    'welcome': welcome.html,
    'unlock-single': unlockSingle.html,
    'unlock-digest': unlockDigest.html,
  };
}

// ─── Tier 1: static, string-level ──────────────────────────────────────────

describe('FIX-EMAIL-FONT: static -- every font-family declaration is the sans stack or the mono exception', () => {
  it('the five rendered bodies each carry font-family on <body>, the content cell, the heading <p>, and the footer cell', async () => {
    const bodies = await getAllFiveBodies();
    for (const [name, html] of Object.entries(bodies)) {
      assert.match(html, new RegExp(`<body style="[^"]*font-family:${escapeRe(FONT_STACK)}[^"]*">`), `${name}: <body> carries the sans stack`);
      assert.match(html, new RegExp(`<td style="padding:40px 32px;font-family:${escapeRe(FONT_STACK)};">`), `${name}: content cell carries the sans stack`);
      assert.match(html, new RegExp(`<p style="font-family:${escapeRe(FONT_STACK)};font-size:24px[^"]*">`), `${name}: heading <p> carries the sans stack`);
      assert.match(html, new RegExp(`<td style="font-family:${escapeRe(FONT_STACK)};font-size:12px;color:[^;]+;line-height:1\\.6;">`), `${name}: footer cell carries the sans stack`);
    }
  });

  it('no font-family declaration anywhere in any of the five bodies names a serif face (every declared value is exactly the sans stack or exactly the mono stack)', async () => {
    const bodies = await getAllFiveBodies();
    for (const [name, html] of Object.entries(bodies)) {
      const declarations = [...html.matchAll(/font-family:([^;"]+)[;"]/g)].map((m) => m[1]);
      assert.ok(declarations.length > 0, `${name}: sanity -- at least one font-family declaration exists to check`);
      for (const value of declarations) {
        assert.ok(
          value === FONT_STACK || value === MONO_STACK,
          `${name}: unexpected font-family value "${value}" -- must be exactly the sans stack or exactly the mono stack, never a serif name or a bare generic like "serif"`
        );
      }
    }
  });
});

// ─── Tier 2: rendered, Playwright, network fully blocked ──────────────────

describe('FIX-EMAIL-FONT: rendered -- computed font-family is the sans stack for every visible text element, except the one mono command line', { timeout: 120_000 }, () => {
  async function computedFontReport(html) {
    const { chromium } = require('playwright');
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      // Network fully blocked -- nothing is fetched, including the hosted
      // logo <img src="https://auxilo.io/logo-square.png">.
      await page.route('**/*', (route) => route.abort());
      await page.setContent(html, { waitUntil: 'load' });
      const report = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('body *').forEach((el) => {
          if (el.children.length > 0) return; // only leaf elements carry their own text
          const text = el.textContent.trim();
          if (!text) return;
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') return; // not visible text
          out.push({ tag: el.tagName, text: text.slice(0, 40), fontFamily: cs.fontFamily });
        });
        return out;
      });
      await ctx.close();
      return report;
    } finally {
      await browser.close();
    }
  }

  it('every rendered email: all visible-text elements compute the sans stack, except the monospace setup-command line', async (t) => {
    if (!isPlaywrightAvailable()) { t.skip('playwright not resolvable'); return; }
    const bodies = await getAllFiveBodies();
    for (const [name, html] of Object.entries(bodies)) {
      const report = await computedFontReport(html);
      assert.ok(report.length > 0, `${name}: sanity -- at least one visible-text element found`);
      for (const el of report) {
        const isMonoException = el.text === 'npx auxilo setup';
        if (isMonoException) {
          assert.ok(el.fontFamily.toLowerCase().includes('monospace'), `${name}: the setup-command line must compute a monospace family, got "${el.fontFamily}"`);
        } else {
          assert.ok(
            el.fontFamily.startsWith(SANS_FIRST_TOKEN),
            `${name}: <${el.tag}> "${el.text}" computed font-family "${el.fontFamily}" must start with "${SANS_FIRST_TOKEN}" (the sans stack)`
          );
        }
      }
    }
  });

  it('positive control: with the sans family stripped from <body> AND the content cell, the same check reports a failure (proves the check has teeth)', async (t) => {
    if (!isPlaywrightAvailable()) { t.skip('playwright not resolvable'); return; }
    const bodies = await getAllFiveBodies();
    const html = bodies['welcome'];
    // Chromium is a standards-compliant browser: font-family inherits
    // through table cells normally (unlike the real Outlook/Apple Mail bug
    // this fix addresses), so stripping ONLY the content cell's own
    // declaration is not enough to reproduce a rendered failure here --
    // the heading/body text would still correctly inherit from <body>'s
    // declaration one level up. To prove this check can fail, strip BOTH
    // the proximate source (the content cell) and the next ancestor that
    // would otherwise cover for it (<body>), leaving the heading and body
    // paragraphs with no font-family anywhere in their inheritance chain --
    // the exact pre-fix bug shape for that text. The wordmark/button/footer
    // cells keep their own independent declarations and still pass.
    let stripped = html.replace(
      `<td style="padding:40px 32px;font-family:${FONT_STACK};">`,
      '<td style="padding:40px 32px;">'
    );
    stripped = stripped.replace(
      /(<body style="[^"]*?);?font-family:[^;"]+;([^"]*")/,
      '$1$2'
    );
    assert.notEqual(stripped, html, 'sanity: the stripped copy actually differs from the real one');
    assert.doesNotMatch(stripped, /<body[^>]*font-family/, 'sanity: <body> no longer declares a font-family');

    const report = await computedFontReport(stripped);
    const failures = report.filter((el) => el.text !== 'npx auxilo setup' && !el.fontFamily.startsWith(SANS_FIRST_TOKEN));
    assert.ok(failures.length > 0, 'positive control: stripping the content cell\'s font-family must produce at least one element whose computed font-family is no longer the sans stack');
  });
});
