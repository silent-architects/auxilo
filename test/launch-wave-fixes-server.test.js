'use strict';

/**
 * test/launch-wave-fixes-server.test.js — SERVER SIDE BUILDER fix unit,
 * site/launch-wave-0926. Covers the findings not already exercised by
 * test/launch-wave-emails.test.js, test/launch-wave-emails-e2e.test.js or
 * test/email-template.test.js:
 *
 *   H3 + M1  the notification queue race (stale-snapshot duplicate send,
 *            lost item during an in-flight send)
 *   L1       digest total via resolveEarningsEntry, not a direct lookup
 *            (source-inspection — see the note on that test for why)
 *   L4       no retry inside the backoff window of a failed attempt
 *   L5       title sanitizing strips line-separator/bidi-override chars
 *   B1       the two openapi.json unlock_price / accrual sentences
 *
 * H3/M1/L4 exercise lib/earning-notifications.js's real exported functions
 * (server.js itself cannot be required as a module — it boots an HTTP server
 * on load — so its actual sendEarningDigestForAccount is instead pinned by
 * source-inspection in test/launch-wave-emails.test.js: it must call
 * earningNotifications.takeDueItems(accountId) from inside
 * earningNotifications.withAccountLock). Every clock here is injected
 * (a plain integer passed as `now`); nothing sleeps and nothing waits on a
 * real timer.
 *
 * Runner: node --test test/launch-wave-fixes-server.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ─── H3 + M1: the notification queue race ──────────────────────────────────

describe('LAUNCH-WAVE-FIXES-SERVER: H3 + M1 notification queue race', () => {
  let tmpDir;
  let notif;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-queue-race-'));
    process.env.AUXILO_EARNING_NOTIFICATIONS_FILE = path.join(tmpDir, 'earning-notifications.json');
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
    notif = require('../lib/earning-notifications.js');
  });

  afterEach(() => {
    delete process.env.AUXILO_EARNING_NOTIFICATIONS_FILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/earning-notifications.js')];
  });

  // The FIXED composition: exactly what server.js's sendEarningDigestForAccount
  // now does (verified by source-inspection in test/launch-wave-emails.test.js:
  // "server.js's sendEarningDigestForAccount routes through withAccountLock,
  // not a local ad-hoc Set"). Re-derives due-ness and the item list fresh,
  // from inside the per-account lock, immediately before sending.
  async function fixedFlush(accountId, sendFn, now) {
    const locked = await notif.withAccountLock(accountId, async () => {
      const due = notif.takeDueItems(accountId, now);
      if (!due) return { attempted: false };
      const outcome = await notif.attemptSend(accountId, due.items, sendFn, now);
      return { attempted: true, outcome };
    });
    // withAccountLock itself returns { skipped, result } — unwrap to the
    // callback's own return value (or the "skipped" shape) for callers here.
    return locked.skipped ? { attempted: false, skippedByLock: true } : locked.result;
  }

  it('H3: a sweep that trusted a snapshot taken before another flush completed would send twice; re-checking due-ness inside the lock closes it', async () => {
    const t0 = 1_726_000_000_000;
    notif.queueAccrual('acc_b', { learningId: 'L_B0', title: 'B0', amountUsd: 0.7, ts: t0 });

    // The sweep's outer loop enumerates candidate account ids up front —
    // dueForDigest() is a snapshot, and it is ONLY ever safe to use for
    // enumeration (see the doc comment on dueForDigest in
    // lib/earning-notifications.js). Capture what a naive caller would have
    // reused here.
    const staleSnapshot = notif.dueForDigest(t0);
    assert.equal(staleSnapshot.length, 1, 'sanity: one account is due at t0');
    const staleItems = staleSnapshot[0].items;

    // Before the sweep's turn reaches this account, a near-simultaneous
    // unlock's opportunistic flush runs the FIXED composition and completes
    // first — sending and marking the account sent.
    let sendCount = 0;
    const sendFn = async () => { sendCount += 1; return { ok: true }; };
    const opportunistic = await fixedFlush('acc_b', sendFn, t0 + 10);
    assert.equal(opportunistic.attempted, true);
    assert.equal(opportunistic.outcome.sent, true);
    assert.equal(sendCount, 1, 'the opportunistic flush sent exactly once');

    // Demonstrates the bug this finding describes: a caller that trusts the
    // pre-lock snapshot instead of re-deriving it sends again, unconditionally.
    await sendFn(staleItems);
    assert.equal(sendCount, 2, 'the stale-snapshot approach (the bug) sends a duplicate email');

    // The fix, exercised for real: the sweep reaches this account and runs
    // the SAME fixedFlush a second time. Because the opportunistic flush
    // already stamped lastSentAt a moment ago, takeDueItems now correctly
    // reports "not due", so nothing is attempted.
    const sweepTurn = await fixedFlush('acc_b', sendFn, t0 + 20);
    assert.equal(sweepTurn.attempted, false, 'the fixed sweep is a no-op for an account already sent moments ago');
    assert.equal(sendCount, 2, 'no further send happens once the fix is in place');
  });

  it('M1: an accrual queued while a send is in flight is preserved, not erased, once that send completes', async () => {
    notif.queueAccrual('acc_c', { learningId: 'L_C1', title: 'C1', amountUsd: 0.7 });
    const t0 = 1_726_000_100_000;

    let sendCount = 0;
    // Mirrors the real composition (server.js's sendEarningDigestForAccount):
    // the whole take-then-send sequence runs inside withAccountLock, so a
    // concurrent flush attempt for the SAME account during the send is a
    // no-op, exactly as it would be for a real opportunistic flush landing
    // mid-send.
    const locked = await notif.withAccountLock('acc_c', async () => {
      const due = notif.takeDueItems('acc_c', t0);
      assert.equal(due.items.length, 1, 'sanity: exactly the one queued item is due');
      return notif.attemptSend('acc_c', due.items, async () => {
        sendCount += 1;
        // While the provider call for the FIRST item is "in flight", a
        // second unlock for the same contributor queues a new accrual.
        notif.queueAccrual('acc_c', { learningId: 'L_C2', title: 'C2', amountUsd: 0.7 });
        // Its own opportunistic flush attempt is a silent no-op, because
        // this send already holds the per-account lock.
        const concurrentFlush = await notif.withAccountLock('acc_c', async () => 'unreachable');
        assert.equal(concurrentFlush.skipped, true, 'the concurrent flush for the same account is skipped while this send holds the lock');
        return { ok: true };
      }, t0);
    });
    assert.equal(locked.skipped, false);
    const outcome = locked.result;

    assert.equal(sendCount, 1);
    assert.equal(outcome.sent, true);
    assert.equal(outcome.drained, true);
    const row = notif.load().acc_c;
    assert.ok(row, 'sanity: the queue row still exists');
    assert.deepEqual(row.pending.map((i) => i.learningId), ['L_C2'], 'L_C2, queued during the send, is not lost — L_C1, which WAS sent, is drained');
  });

  it('L4: no retry inside the backoff window of the last failed attempt; the retry proceeds once the window has passed', async () => {
    notif.queueAccrual('acc_d', { learningId: 'L_D1', title: 'D1', amountUsd: 0.7 });
    const t0 = 1_726_000_200_000;
    const due = notif.takeDueItems('acc_d', t0);
    assert.equal(due.items.length, 1);

    let sendCalls = 0;
    const failingSend = async () => { sendCalls += 1; return { ok: false, error: 'boom' }; };

    const first = await notif.attemptSend('acc_d', due.items, failingSend, t0);
    assert.equal(first.attempts, 1);
    assert.equal(first.drained, false);
    assert.equal(sendCalls, 1);

    // A burst of unlocks seconds later must not burn through the retry
    // budget — attemptSend itself declines to even call sendFn.
    const t1 = t0 + 5_000;
    const second = await notif.attemptSend('acc_d', due.items, failingSend, t1);
    assert.equal(second.reason, 'backoff');
    assert.equal(second.attempts, 1, 'the attempt counter does not move inside the backoff window');
    assert.equal(sendCalls, 1, 'sendFn itself is never invoked again inside the backoff window');

    // Once RETRY_BACKOFF_MS has elapsed, the retry proceeds normally.
    const t2 = t0 + notif.RETRY_BACKOFF_MS + 1;
    const third = await notif.attemptSend('acc_d', due.items, failingSend, t2);
    assert.equal(third.reason, 'boom');
    assert.equal(third.attempts, 2);
    assert.equal(sendCalls, 2);
  });
});

// ─── L1: digest total via resolveEarningsEntry (source-inspection) ─────────
//
// Not behaviorally observable without a staged server + a stubbed Resend
// call to inspect the rendered email body (the dev-mode log line the e2e
// suite can already see does not include the total). Pinned here at the
// source level instead: the direct-lookup pattern the finding names must be
// gone, and the shared resolver the unlock path itself uses must be in place.

describe('LAUNCH-WAVE-FIXES-SERVER: L1 digest total resolution (source-inspection)', () => {
  it('sendEarningDigestForAccount resolves the running total via resolveEarningsEntry, not a bare earnings[accountId] lookup', () => {
    const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const fnStart = serverSrc.indexOf('async function sendEarningDigestForAccount(accountId) {');
    const fnEnd = serverSrc.indexOf('\nasync function flushDueEarningDigestFor', fnStart);
    assert.notEqual(fnStart, -1);
    assert.notEqual(fnEnd, -1);
    const fnSrc = serverSrc.slice(fnStart, fnEnd);
    assert.match(fnSrc, /resolveEarningsEntry\(earnings, \{ account_id: accountId, wallet: account\.wallet \}\)/);
    assert.doesNotMatch(fnSrc, /earnings\[accountId\]\s*&&\s*earnings\[accountId\]\.pending_balance/,
      'the old direct-lookup pattern (which misses a legacy wallet-keyed entry) must not survive');
  });
});

// ─── L5: title sanitizing strips line-separator/bidi-override chars ───────

describe('LAUNCH-WAVE-FIXES-SERVER: L5 sanitizeTitleText strips line-separator/bidi chars', () => {
  const email_ = require('../lib/email.js');

  it('strips NEL, LINE/PARAGRAPH SEPARATOR, and the bidirectional-override/isolate characters, same as it already strips CR/LF', () => {
    // Built from code points (never a literal escape or raw character in
    // source) so the test file itself never carries one of these characters.
    const badCodePoints = [0x0085, 0x2028, 0x2029, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069];
    assert.ok(badCodePoints.length > 0, 'sanity: the list of characters under test is non-empty');
    for (const cp of badCodePoints) {
      const ch = String.fromCharCode(cp);
      const title = `left${ch}right`;
      const out = email_.sanitizeTitleText(title);
      assert.ok(!out.includes(ch), `U+${cp.toString(16).toUpperCase()} must be stripped`);
      assert.ok(out.includes('left') && out.includes('right'), `U+${cp.toString(16).toUpperCase()}: surrounding text survives`);
    }
  });

  it('a title carrying one of these characters renders with no trace of it in either the HTML or plain-text part of the single-unlock email', () => {
    const ch = String.fromCharCode(0x202E); // RIGHT-TO-LEFT OVERRIDE
    const nastyTitle = `Reverse${ch}this`;
    const { html, text } = email_.buildEarningSingleBodies({
      title: nastyTitle, amountUsd: 1, totalAccrued: 1, prefsUrl: 'https://auxilo.io/x',
    });
    assert.ok(!html.includes(ch));
    assert.ok(!text.includes(ch));
  });
});

// ─── B1: the two openapi.json unlock_price / accrual sentences ────────────

describe('LAUNCH-WAVE-FIXES-SERVER: B1 openapi.json unlock_price + /learn accrual sentences', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'openapi.json'), 'utf8'));

  it('is still valid JSON with the schema shapes this unit did not touch intact', () => {
    assert.equal(typeof spec, 'object');
    assert.ok(spec.paths && spec.paths['/learn'] && spec.paths['/learn'].post, 'sanity: /learn POST is still present');
  });

  it('unlock_price description states one price on both payment paths and the 60% discovery rate (credits-as-cash C-74), and drops the flat "70% of the unlock price" overclaim', () => {
    const unlockPriceSchema = spec.paths['/learn'].post.requestBody.content['application/json'].schema.properties.unlock_price;
    assert.equal(
      unlockPriceSchema.description,
      'Price in USD to unlock this learning, kept between $0.05 and $50. A buyer pays this price with x402 or from an Auxilo balance. The builder behind a learning earns 70% of its listed price when another agent unlocks it, or 60% when Auxilo search surfaced it.'
    );
    assert.doesNotMatch(unlockPriceSchema.description, /Contributors earn 70% of the unlock price/);
  });

  it('/learn description states the builder accrues a share of what the buyer paid (not the list price), with the 60% discovery rate', () => {
    const learnDescription = spec.paths['/learn'].post.description;
    assert.match(
      learnDescription,
      /When another agent unlocks a public submission, the builder accrues 70% of what that agent paid, or 60% when Auxilo search surfaced it\./
    );
    assert.doesNotMatch(learnDescription, /Public submissions earn 70% when others unlock them/);
    // Untouched neighboring sentences survive verbatim.
    assert.match(learnDescription, /Public is the default destination on Auxilo\./);
    assert.match(learnDescription, /Requires at least one identity; private specifically requires an authenticated contributor account\./);
  });
});
