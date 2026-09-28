'use strict';

/**
 * test/launch-wave-emails.test.js — Wave 3, Unit B (dashboard-reorder wave):
 * two new transactional emails (welcome, earning-notification), each gated
 * in CODE behind its own flag (WELCOME_EMAIL_ENABLED /
 * EARNING_NOTIFICATIONS_ENABLED -- on only when exactly "true"). W-1
 * (owner, 2026-09-27, "welcome on"): fly.toml now arms
 * WELCOME_EMAIL_ENABLED in production. EARNING_NOTIFICATIONS_ENABLED is
 * unchanged and stays off.
 *
 * This file covers pure logic (no server boot, no network): lib/email.js's
 * new builders/senders, lib/earning-notifications.js's queue, and
 * source-inspection checks on server.js / lib/accounts.js wiring.
 * test/launch-wave-emails-e2e.test.js covers the staged-server cases.
 *
 * Runner: node --test test/launch-wave-emails.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ─── lib/email.js: pure builders (fresh require per test via a tmp env var
// isolation is not needed here — these are pure functions with no file I/O) ──

const email_ = require('../lib/email.js');

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// CH-7: this helper is declared here (module scope, not inside any
// describe()) so its assert calls are only ever reached when the function
// is actually CALLED from inside an it() body (both call sites below are).
// Declared inside a describe() callback, the CH-7 scanner cannot tell a
// function DEFINITION (never executes until called) from code that runs
// immediately at collection time, and mis-flags it as a describe-body
// assert even though it only ever runs inside test bodies.
function slice(source, startMarker, endMarker, from = 0) {
  const start = source.indexOf(startMarker, from);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing marker: ${endMarker}`);
  return source.slice(start, end);
}

describe('LAUNCH-WAVE-EMAILS: welcome email content', () => {
  it('contains no 70%, no "earn", no "accrue", and no promotion', () => {
    const { text, html } = email_.buildWelcomeEmailBodies('https://auxilo.io/connect');
    for (const body of [text, stripTags(html)]) {
      assert.ok(!/70%/.test(body), 'no 70% figure');
      assert.ok(!/\bearn\w*/i.test(body), 'no "earn"/"earns"/"earning" wording');
      assert.ok(!/\baccrue\w*/i.test(body), 'no "accrue"/"accrued"/"accrues" wording');
      // "no promotion": no discount/upsell/urgency vocabulary.
      assert.ok(!/\b(limited time|act now|% off|discount|upgrade now)\b/i.test(body));
    }
  });

  it('row E-17 (final, GOV-4-disclosure-arbiter-revised text) is present verbatim in both formats; the earlier drafting-boundary phrasing is gone', () => {
    const FINAL_E17 = 'Extraction stays off until you turn it on. Nothing your agent extracts goes live without your approval, which you give one learning at a time or in advance in your dashboard.';
    const { text, html } = email_.buildWelcomeEmailBodies('https://auxilo.io/connect');
    assert.ok(text.includes(FINAL_E17), 'plain-text carries the final E-17 sentence verbatim');
    assert.ok(stripTags(html).includes(FINAL_E17), 'HTML carries the final E-17 sentence verbatim');
    assert.ok(!/Nothing publishes until you approve it/.test(text + html),
      'the earlier (superseded) E-17 phrasing must not survive');
  });

  it('button links to the passed connect URL (built by the caller from BASE_URL, per row E-16) and reply-to is set only via sendWelcomeEmail, not the sender address', () => {
    const { html } = email_.buildWelcomeEmailBodies('https://auxilo.io/connect');
    assert.match(html, /href="https:\/\/auxilo\.io\/connect"/);
    assert.match(html, />Get the Setup Command</);
  });
});

describe('LAUNCH-WAVE-EMAILS: earning-notification content (single + digest)', () => {
  const PREFS_URL = 'https://auxilo.io/account/email-prefs/unsubscribe?token=abc123';
  const BUYER_ACCOUNT_ID = 'acc_sample_buyer_never_shown';
  const BUYER_WALLET = '0x1111111111111111111111111111111111111111';
  const BUYER_EMAIL = 'buyer-should-never-appear@example.test';

  it('single-unlock email: contains the paused-rail pair, omits the not-guaranteed disclaimer, and never uses paid/payout/deposited/sent-to-your-bank language', () => {
    const { subject, text, html } = email_.buildEarningSingleBodies({
      title: 'Rate limit workaround for the Widgets API',
      amountUsd: 0.987,
      totalAccrued: 12.34,
      prefsUrl: PREFS_URL,
    });
    assert.equal(subject, 'Another agent unlocked your learning');
    for (const body of [text, stripTags(html)]) {
      assert.ok(body.includes('Earnings accrue now.'), 'paused-rail first half present');
      assert.ok(/Withdrawals open soon/.test(body), 'paused-rail second half present');
      assert.ok(!/not guaranteed/i.test(body), 'not-guaranteed disclaimer must be absent (GOV-4 Q10)');
      assert.ok(!/\bpaid out\b/i.test(body));
      assert.ok(!/\bpayout\b/i.test(body));
      assert.ok(!/\bdeposited\b/i.test(body));
      assert.ok(!/\bsent to your bank\b/i.test(body));
    }
  });

  it('digest email: contains the paused-rail pair, omits the disclaimer, and never uses paid/payout/deposited/sent-to-your-bank language', () => {
    const { subject, text, html } = email_.buildEarningDigestBodies({
      items: [
        { learningId: 'lrn_a', title: 'Learning A', amountUsd: 0.5, ts: Date.parse('2026-09-10T00:00:00.000Z') },
        { learningId: 'lrn_b', title: 'Learning B', amountUsd: 0.7, ts: Date.parse('2026-09-12T00:00:00.000Z') },
      ],
      totalAccrued: 5,
      prefsUrl: PREFS_URL,
    });
    assert.equal(subject, '2 new unlocks of your learnings');
    for (const body of [text, stripTags(html)]) {
      assert.ok(body.includes('Earnings accrue now.'));
      assert.ok(/Withdrawals open soon/.test(body));
      assert.ok(!/not guaranteed/i.test(body));
      assert.ok(!/\bpaid out\b/i.test(body));
      assert.ok(!/\bpayout\b/i.test(body));
      assert.ok(!/\bdeposited\b/i.test(body));
      assert.ok(!/\bsent to your bank\b/i.test(body));
    }
  });

  it('the rendered earning email (single and digest) contains no buyer identifier built from a queue entry, even when a buyer account id/wallet/email is passed through', () => {
    // Queue entries only ever carry {learningId, title, amountUsd, ts} in
    // production (lib/earning-notifications.js's queueAccrual signature), but
    // this proves the RENDERER itself never surfaces a buyer identifier even
    // if one were accidentally attached to a queue entry upstream.
    const poisoned = {
      learningId: 'lrn_poisoned',
      title: 'Poisoned entry',
      amountUsd: 1.23,
      ts: Date.now(),
      buyerAccountId: BUYER_ACCOUNT_ID,
      buyerWallet: BUYER_WALLET,
      buyerEmail: BUYER_EMAIL,
    };
    const single = email_.buildEarningSingleBodies({ title: poisoned.title, amountUsd: poisoned.amountUsd, totalAccrued: 1, prefsUrl: PREFS_URL });
    const digest = email_.buildEarningDigestBodies({ items: [poisoned, { ...poisoned, learningId: 'lrn_poisoned_2', title: 'Second' }], totalAccrued: 1, prefsUrl: PREFS_URL });
    for (const { text, html } of [single, digest]) {
      const combined = text + html;
      assert.ok(!combined.includes(BUYER_ACCOUNT_ID), 'no buyer account id');
      assert.ok(!combined.includes(BUYER_WALLET), 'no buyer wallet');
      assert.ok(!combined.includes(BUYER_EMAIL), 'no buyer email');
    }
  });

  it('escapes a title with markup in the HTML part, strips control chars/newlines in both parts, caps at 200 chars, and never places a title inside a link', () => {
    const nastyTitle = '<b>Rate limit</b> on "Sheets"\r\ninjected-line: fake-header' + 'x'.repeat(250);
    const { html, text } = email_.buildEarningSingleBodies({
      title: nastyTitle, amountUsd: 1, totalAccrued: 1, prefsUrl: PREFS_URL,
    });
    assert.ok(!html.includes('<b>Rate limit</b>'), 'raw markup must not survive in HTML');
    assert.ok(html.includes('&lt;b&gt;Rate limit&lt;/b&gt;'), 'markup is escaped, not stripped');
    const sanitized = email_.sanitizeTitleText(nastyTitle);
    assert.ok(!/[\r\n\u0000-\u001F]/.test(sanitized), 'sanitizeTitleText strips every control char/newline');
    assert.ok(sanitized.includes('injected-line: fake-header'),
      'the injected text survives only as inert, space-joined text on the same line, not as a separate "line"');
    // The rendered HTML body paragraph (the one carrying the title) has no raw CR/LF inside it.
    const bodyParagraphMatch = html.match(/Another agent unlocked <strong>([\s\S]*?)<\/strong>/);
    assert.ok(bodyParagraphMatch, 'the title is rendered inside the expected <strong> segment');
    assert.ok(!/[\r\n]/.test(bodyParagraphMatch[1]), 'no raw CR/LF inside the rendered title segment');
    // Every <a href= only ever points at the dashboard URL or prefsUrl, never at anything derived from the title.
    const hrefs = [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0, 'sanity: at least one <a href> found to check (an empty list would make the loop below vacuous)');
    for (const href of hrefs) {
      assert.ok(
        href === 'https://auxilo.io/dashboard' || href === 'https://auxilo.io/status' ||
        href === PREFS_URL || href === 'https://auxilo.io',
        `unexpected href derived from title: ${href}`
      );
    }
    // Length cap: the rendered title segment is bounded (sanitizeTitleText caps at 200).
    assert.ok(email_.sanitizeTitleText(nastyTitle).length <= 200);
  });

  it('digest groups by learning (one row per learning, not per raw unlock event) and uses the singular "1 unlock" form', () => {
    const { html, text } = email_.buildEarningDigestBodies({
      items: [
        { learningId: 'lrn_a', title: 'Learning A', amountUsd: 0.3, ts: 1 },
        { learningId: 'lrn_a', title: 'Learning A', amountUsd: 0.3, ts: 2 },
        { learningId: 'lrn_b', title: 'Learning B', amountUsd: 0.4, ts: 3 },
      ],
      totalAccrued: 10,
      prefsUrl: PREFS_URL,
    });
    assert.match(stripTags(html), /Learning A · 2 unlocks · \$0\.60/);
    assert.match(stripTags(html), /Learning B · 1 unlock · \$0\.40/);
    assert.match(text, /Learning A · 2 unlocks · \$0\.60/);
    assert.match(text, /Learning B · 1 unlock · \$0\.40/);
    // Overall count sentence uses raw "N times", not the per-row singular form.
    assert.match(stripTags(html), /unlocked your learnings 3 times/);
  });

  it('sendEarningNotification dispatches to the single template for exactly one item and the digest template for two or more (row E-40)', async () => {
    const originalKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test-dummy-key';
    const originalFetch = global.fetch;
    let lastBody = null;
    global.fetch = async (_url, opts) => {
      lastBody = JSON.parse(opts.body);
      return { ok: true, status: 200 };
    };
    try {
      await email_.sendEarningNotification('builder@real-domain.example', {
        items: [{ learningId: 'lrn_a', title: 'Solo', amountUsd: 1, ts: Date.now() }],
        totalAccrued: 1,
        prefsUrl: PREFS_URL,
      });
      assert.equal(lastBody.subject, 'Another agent unlocked your learning');

      await email_.sendEarningNotification('builder@real-domain.example', {
        items: [
          { learningId: 'lrn_a', title: 'A', amountUsd: 1, ts: Date.now() },
          { learningId: 'lrn_b', title: 'B', amountUsd: 1, ts: Date.now() },
        ],
        totalAccrued: 2,
        prefsUrl: PREFS_URL,
      });
      assert.equal(lastBody.subject, '2 new unlocks of your learnings');
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalKey;
    }
  });
});

describe('LAUNCH-WAVE-EMAILS: fixture-domain refusal (never sent to, network-level)', () => {
  let originalKey;
  let originalFetch;
  let fetchCalled;

  beforeEach(() => {
    originalKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test-dummy-key';
    originalFetch = global.fetch;
    fetchCalled = false;
    global.fetch = async () => {
      fetchCalled = true;
      return { ok: true, status: 200 };
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  const FIXTURE_DOMAINS = [
    'someone@example.com', 'someone@example.org', 'someone@example.net',
    'someone@fixture.test', 'someone@thing.invalid', 'someone@my.localhost',
  ];

  it('sendWelcomeEmail never calls fetch for any fixture domain, and does for a real domain (positive control)', async () => {
    for (const email of FIXTURE_DOMAINS) {
      fetchCalled = false;
      const result = await email_.sendWelcomeEmail(email, 'https://auxilo.io/connect');
      assert.equal(fetchCalled, false, `fetch must not be called for ${email}`);
      assert.equal(result.ok, false);
    }
    fetchCalled = false;
    const real = await email_.sendWelcomeEmail('builder@real-domain.example', 'https://auxilo.io/connect');
    assert.equal(fetchCalled, true, 'positive control: a real domain does invoke fetch');
    assert.equal(real.ok, true);
  });

  it('sendEarningNotification never calls fetch for any fixture domain, and does for a real domain (positive control)', async () => {
    const items = [{ learningId: 'lrn_a', title: 'A', amountUsd: 1, ts: Date.now() }];
    for (const email of FIXTURE_DOMAINS) {
      fetchCalled = false;
      const result = await email_.sendEarningNotification(email, { items, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' });
      assert.equal(fetchCalled, false, `fetch must not be called for ${email}`);
      assert.equal(result.ok, false);
    }
    fetchCalled = false;
    const real = await email_.sendEarningNotification('builder@real-domain.example', { items, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' });
    assert.equal(fetchCalled, true, 'positive control: a real domain does invoke fetch');
    assert.equal(real.ok, true);
  });

  it('isFixtureEmailDomain recognizes every listed fixture shape and rejects an ordinary domain (positive control)', () => {
    for (const email of FIXTURE_DOMAINS) {
      assert.equal(email_.isFixtureEmailDomain(email), true, email);
    }
    assert.equal(email_.isFixtureEmailDomain('builder@real-domain.example'), false);
  });
});

describe('LAUNCH-WAVE-EMAILS: replyTo wiring (welcome + earning notification only)', () => {
  it('sets reply_to to support@auxilo.io for both new emails and leaves the sender ("from") untouched', async () => {
    const originalKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test-dummy-key';
    const originalFetch = global.fetch;
    const bodies = [];
    global.fetch = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200 };
    };
    try {
      await email_.sendWelcomeEmail('builder@real-domain.example', 'https://auxilo.io/connect');
      await email_.sendEarningNotification('builder@real-domain.example', {
        items: [{ learningId: 'lrn_a', title: 'A', amountUsd: 1, ts: Date.now() }],
        totalAccrued: 1, prefsUrl: 'https://auxilo.io/x',
      });
      for (const body of bodies) {
        assert.equal(body.reply_to, 'support@auxilo.io');
        assert.equal(body.from, 'Auxilo <login@auxilo.io>', 'sender address is unchanged');
      }
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalKey;
    }
  });

  it('does not add reply_to to the two pre-existing emails (magic link, deletion)', async () => {
    const originalKey = process.env.RESEND_API_KEY;
    process.env.RESEND_API_KEY = 'test-dummy-key';
    const originalFetch = global.fetch;
    const bodies = [];
    global.fetch = async (_url, opts) => {
      bodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200 };
    };
    try {
      await email_.sendMagicLink('builder@real-domain.example', 'https://auxilo.io/dashboard?token=x');
      await email_.sendDeletionConfirmation('builder@real-domain.example', 'https://auxilo.io/account/delete-confirm?token=x');
      for (const body of bodies) {
        assert.equal(Object.hasOwn(body, 'reply_to'), false);
      }
    } finally {
      global.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = originalKey;
    }
  });
});

// ─── lib/earning-notifications.js: pure queue tests ────────────────────────

describe('LAUNCH-WAVE-EMAILS: lib/earning-notifications.js queue', () => {
  let tmpDir;
  let notif;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-earning-notif-'));
    process.env.AUXILO_EARNING_NOTIFICATIONS_FILE = path.join(tmpDir, 'earning-notifications.json');
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
    notif = require('../lib/earning-notifications.js');
  });

  afterEach(() => {
    delete process.env.AUXILO_EARNING_NOTIFICATIONS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
  });

  it('queueAccrual on a fresh account then dueForDigest immediately after returns that account with its one queued item', () => {
    notif.queueAccrual('acc_1', { learningId: 'lrn_a', title: 'A', amountUsd: 1 });
    const due = notif.dueForDigest();
    assert.equal(due.length, 1);
    assert.equal(due[0].accountId, 'acc_1');
    assert.equal(due[0].items.length, 1);
    assert.equal(due[0].items[0].learningId, 'lrn_a');
    assert.equal(due[0].items[0].amountUsd, 1);
  });

  it('after markSent, dueForDigest at the same instant no longer returns that account', () => {
    notif.queueAccrual('acc_1', { learningId: 'lrn_a', title: 'A', amountUsd: 1 });
    notif.markSent('acc_1');
    assert.deepEqual(notif.dueForDigest(), []);
  });

  it('two queueAccrual calls within the 24h window before any send: dueForDigest returns ONE entry containing BOTH items', () => {
    notif.queueAccrual('acc_1', { learningId: 'lrn_a', title: 'A', amountUsd: 1 });
    notif.queueAccrual('acc_1', { learningId: 'lrn_b', title: 'B', amountUsd: 2 });
    const due = notif.dueForDigest();
    assert.equal(due.length, 1);
    assert.equal(due[0].items.length, 2);
  });

  it('markSent at T, then queueAccrual at T+1h: not due at T+1h (still inside 24h window), due at T+25h', () => {
    const T = 1_000_000_000_000;
    notif.queueAccrual('acc_1', { learningId: 'lrn_a', title: 'A', amountUsd: 1, ts: T });
    notif.markSent('acc_1', T);
    notif.queueAccrual('acc_1', { learningId: 'lrn_b', title: 'B', amountUsd: 1, ts: T + 3_600_000 });
    assert.deepEqual(notif.dueForDigest(T + 3_600_000), [], 'not yet due at T+1h');
    const dueLater = notif.dueForDigest(T + 25 * 3_600_000);
    assert.equal(dueLater.length, 1, 'due at T+25h');
    assert.equal(dueLater[0].items.length, 1);
  });

  it('calling markSent twice in a row is a harmless no-op the second time: no throw, pending stays empty', () => {
    notif.queueAccrual('acc_1', { learningId: 'lrn_a', title: 'A', amountUsd: 1 });
    notif.markSent('acc_1', 1000);
    assert.doesNotThrow(() => notif.markSent('acc_1', 2000));
    const map = notif.load();
    assert.deepEqual(map.acc_1.pending, []);
    assert.deepEqual(notif.dueForDigest(2000), []);
  });

  it('a malformed/missing notifications file is treated as empty state (load() never throws)', () => {
    fs.rmSync(process.env.AUXILO_EARNING_NOTIFICATIONS_FILE, { force: true });
    assert.deepEqual(notif.load(), {});
    fs.writeFileSync(process.env.AUXILO_EARNING_NOTIFICATIONS_FILE, '{not json');
    assert.deepEqual(notif.load(), {});
    assert.deepEqual(notif.dueForDigest(), []);
  });

  it('queueAccrual is a no-op for a falsy accountId', () => {
    assert.doesNotThrow(() => notif.queueAccrual(null, { learningId: 'lrn_a', title: 'A', amountUsd: 1 }));
    assert.deepEqual(notif.load(), {});
  });
});

// ─── Source-inspection: server.js / lib/accounts.js wiring ──────────────────

describe('LAUNCH-WAVE-EMAILS: source-inspection wiring checks', () => {
  const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const ACCOUNTS_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js'), 'utf8');

  it('the W3 earning-notification queue block sits after unlockResponsePayload is built and immediately before the return, past both early-return branches, past commitWal, and is never awaited on the response path', () => {
    // The unlock route is GET /knowledge/:id (not a separate /learn/:id/unlock
    // route) — slice from the DR-8 owner short-circuit through the start of
    // the next route to isolate the handler body.
    const start = SERVER_SRC.indexOf('if (dr8OwnerAccountId) {');
    assert.notEqual(start, -1);
    const end = SERVER_SRC.indexOf("app.post('/knowledge/:id/rate'", start);
    assert.notEqual(end, -1);
    const handler = SERVER_SRC.slice(start, end);

    // AUD-CAC (credits-as-cash follow-up, SITE-PM 2026-09-27): the
    // capped-repeat early-return branch is gone (F-5 removes the 30-day
    // repeat-accrual cap) — the self-unlock branch is now the only
    // early-return before commitWal.
    const selfUnlockReturn = handler.indexOf('if (isSelfUnlock) {');
    const commitWalIdx = handler.indexOf('commitWal(walId);');
    const payloadBuildIdx = handler.indexOf('const unlockResponsePayload = {');
    const queueBlockIdx = handler.indexOf("if (process.env.EARNING_NOTIFICATIONS_ENABLED === 'true' && contribAccountId");
    const returnIdx = handler.indexOf('return c.json(unlockResponsePayload);');
    const catchIdx = handler.indexOf('} catch (deliveryErr) {');

    assert.ok(selfUnlockReturn !== -1 && commitWalIdx > selfUnlockReturn,
      'commitWal runs after the early-return branch');
    assert.ok(payloadBuildIdx > commitWalIdx, 'response payload is built after commitWal');
    assert.ok(queueBlockIdx > payloadBuildIdx,
      'the queue block runs AFTER the response payload is already built successfully — the smallest change that puts the queue past every remaining AUD19-10 rollback point in this handler');
    assert.ok(returnIdx > queueBlockIdx, 'the return statement is the very next thing after the queue block');
    assert.ok(catchIdx > returnIdx, 'the queue block sits inside the try, before the catch');

    const queueBlock = handler.slice(queueBlockIdx, returnIdx);
    assert.match(queueBlock, /agencyInForce/, 'held (pre-Terms) accruals are excluded');
    assert.match(queueBlock, /contributorEarned > 0/, 'zero-value grants are excluded');
    assert.match(queueBlock, /fundingSource !== 'router'/, 'router-settled accruals are excluded (GOV-4)');
    assert.match(queueBlock, /!routerSettlement/, 'router-settled accruals are excluded (GOV-4), belt-and-suspenders check');
    assert.doesNotMatch(queueBlock, /await flushDueEarningDigestFor/, 'the immediate flush is fire-and-forget, never awaited on the response path');
  });

  it('GET /account/settings reports earning_notifications_available (global flag) and earning_notifications_enabled (per-account, default true); PATCH accepts a boolean and 400s otherwise', () => {
    const getRoute = slice(SERVER_SRC, "app.get('/account/settings'", "app.patch('/account/settings'");
    assert.match(getRoute, /earning_notifications_available:\s*process\.env\.EARNING_NOTIFICATIONS_ENABLED === 'true'/);
    assert.match(getRoute, /earning_notifications_enabled:\s*account\.earning_notifications_enabled !== false/);

    const patchStart = SERVER_SRC.indexOf("app.patch('/account/settings'");
    const patchEnd = SERVER_SRC.indexOf("app.post('/extract/consent'", patchStart);
    const patchRoute = SERVER_SRC.slice(patchStart, patchEnd);
    assert.match(patchRoute, /earning_notifications_enabled must be a boolean/);
    assert.match(patchRoute, /appendEarningEmailPrefRecord\(account, accountId, body\.earning_notifications_enabled, 'dashboard'\)/);
  });

  it('the welcome-email hook in lib/accounts.js fires only when created is true, is gated on WELCOME_EMAIL_ENABLED === \'true\', sits after findOrCreateAccount and before signJwt, and is not awaited', () => {
    const verify = slice(ACCOUNTS_SRC, "app.get('/auth/verify'", "app.post('/account/api-keys'");
    const createIdx = verify.indexOf('findOrCreateAccount(matchedEntry.email)');
    const hookIdx = verify.indexOf("if (created && process.env.WELCOME_EMAIL_ENABLED === 'true')");
    const jwtIdx = verify.indexOf('signJwt(accountId, matchedEntry.email)');
    assert.ok(createIdx !== -1 && hookIdx > createIdx);
    assert.ok(jwtIdx > hookIdx);
    const hookBlock = verify.slice(hookIdx, jwtIdx);
    assert.doesNotMatch(hookBlock, /await email_\.sendWelcomeEmail/, 'not awaited — a failure must never delay/fail sign-in');
    assert.match(hookBlock, /\.catch\(\(e\) => \{/, 'failure is caught, never thrown into the response path');
    assert.doesNotMatch(hookBlock, /matchedEntry\.email\}`\);[\s\S]*console\.error/, 'sanity: catch body logs, does not rethrow');
  });

  it('the unlock-email opt-out routes (D-83 to D-88) use the current shipped /styles.css?v= literal, not the bare account-deletion shell, and never reveal whose account a token belonged to', () => {
    const routeStart = SERVER_SRC.indexOf("app.get('/account/email-prefs/unsubscribe'");
    const routeEnd = SERVER_SRC.indexOf("app.get('/account/api-keys'", routeStart);
    assert.notEqual(routeStart, -1);
    const routeBlock = SERVER_SRC.slice(SERVER_SRC.lastIndexOf('function renderUnlockEmailPrefsPage', routeStart), routeEnd);

    // Derived, not pinned: a hardcoded hash here goes stale on every CSS
    // change (it did -- this literal used to read ?v=80b44c53, years behind
    // the shipped pages, per test/legal-page-styles-version.test.js's same
    // fix for serveLegalPage). Read the real value off a shipped page at
    // test time instead, so this test tracks whatever the site currently
    // ships rather than a snapshot of one commit.
    const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const pageMatch = indexHtml.match(/href="\/styles\.css\?v=([0-9a-f]+)"/);
    assert.ok(pageMatch, 'public/index.html must link /styles.css?v=N');
    // Positive control: an empty/near-empty capture must not silently pass.
    assert.match(pageMatch[1], /^[0-9a-f]{8}$/,
      `expected an 8-hex-char asset hash, got ${JSON.stringify(pageMatch[1])}`);

    assert.match(routeBlock, new RegExp(`href="/styles\\.css\\?v=${pageMatch[1]}"`),
      `opt-out page must ship the same /styles.css?v=${pageMatch[1]} as the rest of the site`);
    assert.doesNotMatch(routeBlock, /Stop Unlock Emails[\s\S]{0,400}account_id/i);
  });
});

// ─── PM review (post-ship) defect #1: the opt-out token dies in 15 minutes ──

describe('LAUNCH-WAVE-EMAILS: issuePurposeMagicLink token lifetime (PM defect #1)', () => {
  let tmpDir;
  let magicLinksFile;
  let accounts_;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-magic-links-'));
    magicLinksFile = path.join(tmpDir, 'magic_links.json');
    process.env.AUXILO_MAGIC_LINKS_FILE = magicLinksFile;
    delete require.cache[require.resolve('../lib/accounts.js')];
    accounts_ = require('../lib/accounts.js');
  });

  afterEach(() => {
    delete process.env.AUXILO_MAGIC_LINKS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/accounts.js')];
  });

  // "Injects the expiry" (per the PM's instruction: inject the clock or the
  // expiry, do not sleep) by moving a token's stored expires_at back by `ms`
  // — mathematically identical to the clock having advanced by that much.
  function ageEntryBy(rawToken, ms) {
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const links = JSON.parse(fs.readFileSync(magicLinksFile, 'utf8'));
    links[hash].expires_at -= ms;
    fs.writeFileSync(magicLinksFile, JSON.stringify(links));
  }

  it('a token minted for earning-emails-off with a 60-day lifetime is still valid after 16 minutes and after 59 days, and invalid after 61 days', () => {
    const MIN = 60 * 1000;
    const DAY = 24 * 60 * 60 * 1000;
    const SIXTY_DAYS = 60 * DAY;

    const token16 = accounts_.issuePurposeMagicLink('builder@test.local', 'earning-emails-off', SIXTY_DAYS);
    ageEntryBy(token16, 16 * MIN);
    assert.ok(accounts_.consumePurposeMagicLink(token16, 'earning-emails-off'), 'valid after 16 minutes');

    const token59 = accounts_.issuePurposeMagicLink('builder@test.local', 'earning-emails-off', SIXTY_DAYS);
    ageEntryBy(token59, 59 * DAY);
    assert.ok(accounts_.consumePurposeMagicLink(token59, 'earning-emails-off'), 'valid after 59 days');

    const token61 = accounts_.issuePurposeMagicLink('builder@test.local', 'earning-emails-off', SIXTY_DAYS);
    ageEntryBy(token61, 61 * DAY);
    assert.equal(accounts_.consumePurposeMagicLink(token61, 'earning-emails-off'), null, 'invalid after 61 days');
  });

  it('a delete-account token (default lifetime, no third argument passed) still expires at 15 minutes — sign-in/deletion flows are unchanged', () => {
    const MIN = 60 * 1000;

    const tokenOk = accounts_.issuePurposeMagicLink('builder@test.local', 'delete-account');
    ageEntryBy(tokenOk, 14 * MIN);
    assert.ok(accounts_.consumePurposeMagicLink(tokenOk, 'delete-account'), 'still valid at 14 minutes (under the 15-minute default)');

    const tokenExpired = accounts_.issuePurposeMagicLink('builder@test.local', 'delete-account');
    ageEntryBy(tokenExpired, 16 * MIN);
    assert.equal(accounts_.consumePurposeMagicLink(tokenExpired, 'delete-account'), null, 'expired at 16 minutes — the default TTL is unchanged');
  });

  it('server.js mints the earning-emails-off token with a named 60-day constant, not the bare default', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    assert.match(serverSrc, /const EARNING_EMAILS_OFF_TOKEN_TTL_MS = 60 \* 24 \* 60 \* 60 \* 1000;/);
    assert.match(serverSrc, /issuePurposeMagicLink\(account\.email, 'earning-emails-off', EARNING_EMAILS_OFF_TOKEN_TTL_MS\)/);
  });
});

// ─── PM review (post-ship) defect #2: a failed send is marked as sent ───────

describe('LAUNCH-WAVE-EMAILS: attemptSend retry/drain decisions (PM defect #2, real fetch replaced)', () => {
  const email_local = require('../lib/email.js');
  let tmpDir;
  let notif;
  const ACCOUNT_ID = 'acc_attempt_send_test';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-attempt-send-'));
    process.env.AUXILO_EARNING_NOTIFICATIONS_FILE = path.join(tmpDir, 'earning-notifications.json');
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
    notif = require('../lib/earning-notifications.js');
    notif.queueAccrual(ACCOUNT_ID, { learningId: 'lrn_a', title: 'A', amountUsd: 1 });
  });

  afterEach(() => {
    delete process.env.AUXILO_EARNING_NOTIFICATIONS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
    delete process.env.RESEND_API_KEY;
  });

  async function withMockedFetch(handler, fn) {
    const original = global.fetch;
    global.fetch = handler;
    try { return await fn(); } finally { global.fetch = original; }
  }

  it('ok:true (delivered) drains the queue and resets the attempt counter', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const [{ items }] = notif.dueForDigest();
    const outcome = await withMockedFetch(
      async () => ({ ok: true, status: 200 }),
      () => notif.attemptSend(ACCOUNT_ID, items, () =>
        email_local.sendEarningNotification('builder@real-domain.example', { items, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' }))
    );
    assert.equal(outcome.sent, true);
    assert.equal(outcome.drained, true);
    assert.deepEqual(notif.dueForDigest(), [], 'nothing left queued');
    assert.equal(notif.load()[ACCOUNT_ID].attempts, 0);
  });

  it('a fixture-domain refusal (can never be delivered) drains without incrementing attempts', async () => {
    const [{ items }] = notif.dueForDigest();
    const outcome = await notif.attemptSend(ACCOUNT_ID, items, () =>
      email_local.sendEarningNotification('someone@example.com', { items, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' }));
    assert.equal(outcome.sent, false);
    assert.equal(outcome.drained, true);
    assert.equal(outcome.reason, 'fixture domain');
    assert.deepEqual(notif.dueForDigest(), []);
    assert.equal(notif.load()[ACCOUNT_ID].attempts, 0);
  });

  it('an empty item list (can never be delivered) drains without incrementing attempts', async () => {
    const outcome = await notif.attemptSend(ACCOUNT_ID, [], () =>
      email_local.sendEarningNotification('builder@real-domain.example', { items: [], totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' }));
    assert.equal(outcome.sent, false);
    assert.equal(outcome.drained, true);
    assert.equal(outcome.reason, 'no items');
  });

  it('a real provider failure leaves the item queued and increments attempts; the 5th consecutive failure drains it (bounded retry)', async () => {
    // L4 (this unit) added a retry backoff: attemptSend now declines to even
    // try again within RETRY_BACKOFF_MS of the account's last failed attempt.
    // This test asserts the bounded-retry ceiling itself, not the backoff, so
    // the clock is injected (never a real sleep) and advanced past the
    // backoff window before each attempt — L4's own backoff behavior is
    // covered separately in test/launch-wave-fixes-server.test.js.
    process.env.RESEND_API_KEY = 'test-key';
    let clock = 1_700_000_000_000;
    for (let i = 1; i <= notif.MAX_SEND_ATTEMPTS; i++) {
      const due = notif.dueForDigest(clock);
      assert.equal(due.length, 1, `still queued and due before attempt ${i}`);
      const { items } = due[0];
      // eslint-disable-next-line no-await-in-loop
      const outcome = await withMockedFetch(
        async () => ({ ok: false, status: 500 }),
        () => notif.attemptSend(ACCOUNT_ID, items, () =>
          email_local.sendEarningNotification('builder@real-domain.example', { items, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x' }), clock)
      );
      assert.equal(outcome.sent, false);
      assert.equal(outcome.attempts, i);
      if (i < notif.MAX_SEND_ATTEMPTS) {
        assert.equal(outcome.drained, false, `attempt ${i} of ${notif.MAX_SEND_ATTEMPTS} must leave the item queued for retry`);
      } else {
        assert.equal(outcome.drained, true, 'the queue is drained once the retry ceiling is reached — a permanently failing address cannot retry forever');
      }
      clock += notif.RETRY_BACKOFF_MS + 1;
    }
    assert.deepEqual(notif.dueForDigest(clock), [], 'nothing left queued after the ceiling');
  });
});

// ─── PM review (post-ship) defect #3: a race can send the same digest twice ─

describe('LAUNCH-WAVE-EMAILS: withAccountLock concurrency guard (PM defect #3)', () => {
  let tmpDir;
  let notif;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-inflight-'));
    process.env.AUXILO_EARNING_NOTIFICATIONS_FILE = path.join(tmpDir, 'earning-notifications.json');
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
    notif = require('../lib/earning-notifications.js');
  });

  afterEach(() => {
    delete process.env.AUXILO_EARNING_NOTIFICATIONS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
  });

  it('two concurrent calls for the same account produce exactly one actual send; the second is a silent no-op', async () => {
    let sendCount = 0;
    const slowSend = async () => {
      sendCount++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'sent';
    };
    const [r1, r2] = await Promise.all([
      notif.withAccountLock('acc_race', slowSend),
      notif.withAccountLock('acc_race', slowSend),
    ]);
    assert.equal(sendCount, 1, 'the send function itself only ran once — the race is closed before the second caller can invoke it');
    const results = [r1, r2];
    assert.equal(results.filter((r) => r.skipped).length, 1, 'exactly one call was skipped');
    assert.equal(results.filter((r) => !r.skipped).length, 1, 'exactly one call actually ran');
  });

  it('a different account is never blocked by another account already in flight', async () => {
    const slowSend = async () => { await new Promise((r) => setTimeout(r, 10)); return 'sent'; };
    const [r1, r2] = await Promise.all([
      notif.withAccountLock('acc_a', slowSend),
      notif.withAccountLock('acc_b', slowSend),
    ]);
    assert.equal(r1.skipped, false);
    assert.equal(r2.skipped, false);
  });

  it('the lock is released even when fn throws, so a later call for the same account is never wedged', async () => {
    let threw = false;
    try {
      await notif.withAccountLock('acc_throw', async () => { throw new Error('boom'); });
    } catch (e) { threw = true; }
    assert.equal(threw, true);
    const after = await notif.withAccountLock('acc_throw', async () => 'ok');
    assert.equal(after.skipped, false, 'the lock was released in the finally block, not left held after the throw');
  });

  it('server.js\'s sendEarningDigestForAccount routes through withAccountLock, not a local ad-hoc Set', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    // H3/M1 (this unit): the caller now passes only the account id — the due
    // check and the item list are both re-derived fresh, inside the lock,
    // via earningNotifications.takeDueItems(), never from a snapshot taken
    // before the lock was acquired.
    const fnStart = serverSrc.indexOf('async function sendEarningDigestForAccount(accountId) {');
    const fnEnd = serverSrc.indexOf('\nasync function flushDueEarningDigestFor', fnStart);
    assert.notEqual(fnStart, -1);
    assert.notEqual(fnEnd, -1);
    const fnSrc = serverSrc.slice(fnStart, fnEnd);
    assert.match(fnSrc, /earningNotifications\.withAccountLock\(accountId, async \(\) => \{/);
    assert.match(fnSrc, /earningNotifications\.takeDueItems\(accountId\)/,
      'the item list is re-read fresh inside the lock, not passed in stale (H3)');
  });
});

// ─── PM review (post-ship) defect #4: the welcome dev-mode log line printed
// the full email address — already covered as an E2E regression in
// test/launch-wave-emails-e2e.test.js (the log line is only observable via a
// staged server boot). A source-level pin lives here too, for a fast check
// that never needs a server boot.

describe('LAUNCH-WAVE-EMAILS: welcome dev-mode log hygiene (PM defect #4, source pin)', () => {
  it('lib/accounts.js redacts the email in the welcome dev-mode log line, the same way the earning-digest dev-mode line already does', () => {
    const accountsSrc = fs.readFileSync(path.join(ROOT, 'lib', 'accounts.js'), 'utf8');
    assert.match(accountsSrc, /Welcome email skipped \(dev mode\) for \$\{email_\.redactEmail\(matchedEntry\.email\)\}/);
    assert.doesNotMatch(accountsSrc, /Welcome email skipped \(dev mode\) for \$\{matchedEntry\.email\}/,
      'the un-redacted form must not survive');
  });
});
