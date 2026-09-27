'use strict';

/**
 * test/fix-unit-money-4-route.test.js — MONEYFIX4, ruling N19, proved
 * through the REAL server.js boot sequence on a staged live server
 * (test/helpers/staged-server.js). A local staged server only, on a free
 * reserved port, never port 3000, never the live site, never a real Stripe
 * call, never a real purchase.
 *
 * This replicates the reviewer's own Walk F2 (REVIEW-MONEY-PATH.md): a
 * pack funds two unlocks, the second commits but its funding record is
 * never written (a live recordLotFunding failure -- the WAL entry survives,
 * kept pending exactly as server.js leaves it), then a FULL refund lands
 * while the process is still up. The refund can only reverse the FIRST
 * unlock's already-recorded share (the second has no funded_unlocks entry
 * yet to find) -- the second unlock's builder is left holding a share of a
 * pack Auxilo no longer holds a cent of. The process then restarts. WAL
 * recovery records the second unlock's funding (finding the lot's
 * uncovered amount already there, marking the entry pending_reversal) --
 * ruling N19 is that a SEPARATE boot-time pass then completes it, so the
 * builder ends at exactly $0.000000 without needing a further Stripe event
 * for this payment to ever arrive.
 *
 * Runner: node --test test/fix-unit-money-4-route.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  bootServer,
  reservePort,
  stageServer,
  stopServer,
} = require('./helpers/staged-server');

const REPO = path.join(__dirname, '..');
const { CURRENT_TOS_VERSION } = require('../lib/accounts.js');

function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

describe('MONEYFIX4 ruling N19: boot-time recovery completes a pending reversal a live crash left behind (staged live server)', { timeout: 180_000 }, () => {
  it("Walk F2: the second unlock's builder ends at exactly $0.000000 after the restart, and a second restart changes nothing", async (t) => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { t.skip(reservation.skipReason); return; }
    const { port } = reservation;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum4-n19-'));
    let child = null;
    t.after(async () => {
      await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const { dataDir, walDir } = staged;

    const BUYER = 'acc_n19_buyer';
    const G1 = 'acc_n19_g1';
    const G2 = 'acc_n19_g2';
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    writeJson(path.join(dataDir, 'accounts.json'), {
      [BUYER]: { id: BUYER, email: 'n19-buyer@test.local', created_at: nowIso, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true },
      [G1]: { id: G1, email: 'n19-g1@test.local', created_at: nowIso, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true },
      [G2]: { id: G2, email: 'n19-g2@test.local', created_at: nowIso, tos_version: CURRENT_TOS_VERSION, accepted_at: now, accepted_affirmed: true },
    });
    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'verified-wallets.json'), {});

    // The pack: $20 paid, g1's $10 unlock fully recorded and already
    // reversed live (the refund found and reversed it before the crash),
    // g2's $10 unlock debited (remaining_usd already down to 0, inflight_usd
    // still showing it as not yet recorded) but with NO funded_unlocks
    // entry -- recordLotFunding for it never ran. uncovered_usd carries the
    // $10 the live refund could not find anything to reverse against yet
    // (Terms 7.6 item 3 / ruling N1).
    const LOT_ID = 'lot_pi_n19_walk_f2';
    writeJson(path.join(dataDir, 'credits.json'), {
      [BUYER]: {
        queries_used: 0, unlocks_used: 0, purchased_queries: 0, purchased_unlocks: 0,
        period_start: '2026-09-01T00:00:00.000Z', period_end: '2099-01-01T00:00:00.000Z',
        created_at: now, last_deducted_at: null,
        dollar_lots: [{
          lot_id: LOT_ID, kind: 'dollar_paid', purchase_id: 'pur_pi_n19_walk_f2',
          stripe_payment_intent: 'pi_n19_walk_f2', purchased_at: nowIso, last_activity_at: nowIso,
          frozen: false, frozen_at: null, frozen_reason: null,
          original_usd: 20, remaining_usd: 0,
          funded_unlocks: [{
            id: 'fu_n19_g1', learning_id: 'L_G1', contributor_account_id: G1, contributor_wallet: null,
            contributor_amount: 7, platform_amount: 3, reversed: true, pending_reversal: false, ts: nowIso,
          }],
          uncovered_usd: 10, inflight_usd: 10,
          refunded_usd: 20, dispute_lost_by_id: {},
        }],
      },
    });

    // g1 was already reversed live (pending_balance 0). g2 was credited
    // live when its unlock happened and was NEVER touched by the refund --
    // this is the broken pre-restart state Walk F2 names ("$7 owed on $0").
    writeJson(path.join(dataDir, 'earnings.json'), {
      [G1]: {
        account_id: G1, wallet: null, total_gross: 0, total_contributor: 0, total_platform: 0,
        by_learning: {}, last_updated: nowIso, pending_balance: 0, unassented_pending: 0,
        total_withdrawn: 0, withdrawal_count: 0, processed_settlements: [],
        reversals: [{ id: 'fu_n19_g1', amount: 7, platform_amount: 3, learning_id: 'L_G1', reason: 'dollar_lot_reversal', ts: nowIso }],
      },
      [G2]: {
        account_id: G2, wallet: null, total_gross: 10, total_contributor: 7, total_platform: 3,
        by_learning: { L_G2: { gross: 10, contributor: 7, platform: 3, unlocks: 1 } },
        last_updated: nowIso, pending_balance: 7, unassented_pending: 0,
        total_withdrawn: 0, withdrawal_count: 0, processed_settlements: [],
      },
    });

    // g2's WAL entry: crashed before its funding record (recordLotFunding
    // never landed live), left pending exactly as server.js's own unlock
    // handler leaves it (steps_completed missing 'lot_funding_recorded').
    const walId = crypto.randomUUID();
    writeJson(path.join(walDir, `${walId}.wal.json`), {
      id: walId, operation: 'unlock', created_at: now,
      steps_completed: ['update_learnings', 'update_earnings', 'unlock_event_appended'],
      payload: {
        learning_id: 'L_G2', builder_wallet: null, contributor_account_id: G2,
        unlock_price: 10, unlocked_at: nowIso, amount_paid_usd: 10,
        funding_source: 'credit_pack', contributor_earned: 7, platform_earned: 3,
        purchaser_account_id: BUYER, agency_in_force: true,
        dollar_draws: [{ lot_id: LOT_ID, kind: 'dollar_paid', amount: 10 }],
      },
    });

    const env = {
      ...process.env, NODE_ENV: 'test',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      SESSION_SECRET: 'fum4-n19-route-test-session-secret-0000',
      CONTENT_MODERATION_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'not_a_real_stripe_key_format_placeholder_00000000',
      STRIPE_WEBHOOK_SECRET: 'whsec_' + 'e'.repeat(32),
      AUXILO_DATA_DIR: dataDir,
      AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
      AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
    };
    delete env.RESEND_API_KEY;
    delete env.OPS_ALERT_EMAIL;

    // Boot 1: WAL recovery records g2's funding (finds the lot's uncovered
    // amount already there, marks the fresh entry pending_reversal), then
    // completePendingReversalsAtBoot (N19) completes it -- in the SAME boot,
    // before the server is done starting.
    let boot = await bootServer({ tmpDir, port, env, timeoutMs: 60_000, maxAttempts: 3 });
    if ('skipReason' in boot) { t.skip(boot.skipReason); return; }
    child = boot.child;

    const health1 = await fetch(`${boot.baseUrl}/health`);
    assert.equal(health1.status, 200, 'boot 1 must complete and serve /health despite the pending-reversal recovery work');

    const earningsAfterBoot1 = readJson(path.join(dataDir, 'earnings.json'));
    assert.equal(earningsAfterBoot1[G1].pending_balance, 0, 'g1 stays at zero (already reversed before the crash)');
    assert.equal(earningsAfterBoot1[G2].pending_balance, 0, 'N19: g2 ends at exactly $0.000000 -- the pending reversal WAL recovery left behind is completed at boot, with no further Stripe event ever needed');

    const creditsAfterBoot1 = readJson(path.join(dataDir, 'credits.json'));
    const lotAfterBoot1 = creditsAfterBoot1[BUYER].dollar_lots.find((l) => l.lot_id === LOT_ID);
    assert.equal(lotAfterBoot1.funded_unlocks.length, 2, "g2's funding record now exists on the lot");
    const g2Entry = lotAfterBoot1.funded_unlocks.find((f) => f.contributor_account_id === G2);
    assert.equal(g2Entry.reversed, true, "g2's entry is durably finalized as reversed");
    assert.equal(g2Entry.pending_reversal, false, 'no pending_reversal marker left dangling');
    assert.equal(lotAfterBoot1.uncovered_usd, 0, "the lot's uncovered amount is fully consumed");

    await stopServer(child);

    // Boot 2: idempotent. Nothing left pending, nothing changes, no
    // duplicate reversal, no negative balance.
    boot = await bootServer({ tmpDir, port, env, timeoutMs: 60_000, maxAttempts: 3 });
    if ('skipReason' in boot) { t.skip(boot.skipReason); return; }
    child = boot.child;
    const health2 = await fetch(`${boot.baseUrl}/health`);
    assert.equal(health2.status, 200);

    const earningsAfterBoot2 = readJson(path.join(dataDir, 'earnings.json'));
    assert.equal(earningsAfterBoot2[G1].pending_balance, 0);
    assert.equal(earningsAfterBoot2[G2].pending_balance, 0, 'a second restart changes nothing');
    assert.equal((earningsAfterBoot2[G2].reversals || []).length, 1, 'the reversal was recorded exactly once, never twice');

    const creditsAfterBoot2 = readJson(path.join(dataDir, 'credits.json'));
    const lotAfterBoot2 = creditsAfterBoot2[BUYER].dollar_lots.find((l) => l.lot_id === LOT_ID);
    assert.equal(lotAfterBoot2.funded_unlocks.length, 2, 'no duplicate funding record from the second boot');
  });

  it('an idle boot with nothing pending does no work and changes nothing', async (t) => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { t.skip(reservation.skipReason); return; }
    const { port } = reservation;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum4-n19-idle-'));
    let child = null;
    t.after(async () => {
      await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const { dataDir } = staged;
    writeJson(path.join(dataDir, 'accounts.json'), {});
    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    writeJson(path.join(dataDir, 'credits.json'), {});
    writeJson(path.join(dataDir, 'earnings.json'), {});

    const env = {
      ...process.env, NODE_ENV: 'test',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      SESSION_SECRET: 'fum4-n19-idle-test-session-secret-00000',
      CONTENT_MODERATION_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'not_a_real_stripe_key_format_placeholder_00000000',
      STRIPE_WEBHOOK_SECRET: 'whsec_' + 'f'.repeat(32),
      AUXILO_DATA_DIR: dataDir,
      AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
      AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
    };
    delete env.RESEND_API_KEY;
    delete env.OPS_ALERT_EMAIL;

    const before = fs.readFileSync(path.join(dataDir, 'earnings.json'), 'utf8');
    const boot = await bootServer({ tmpDir, port, env, timeoutMs: 60_000, maxAttempts: 3 });
    if ('skipReason' in boot) { t.skip(boot.skipReason); return; }
    child = boot.child;
    const health = await fetch(`${boot.baseUrl}/health`);
    assert.equal(health.status, 200, 'an idle scan (findAllLotsWithPendingReversal on an empty ledger) must never block startup');
    assert.equal(fs.readFileSync(path.join(dataDir, 'earnings.json'), 'utf8'), before, 'nothing pending -- nothing written');
  });

  it('a corrupt credits.json at boot never stops the server from starting -- the pending-reversal scan logs once and carries on', async (t) => {
    const honoEntry = require.resolve('hono', { paths: [REPO] });
    const nodeModulesDir = honoEntry.slice(0, honoEntry.lastIndexOf(`${path.sep}node_modules${path.sep}`) + '/node_modules'.length);
    const reservation = await reservePort();
    if ('skipReason' in reservation) { t.skip(reservation.skipReason); return; }
    const { port } = reservation;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fum4-n19-corrupt-'));
    let child = null;
    t.after(async () => {
      await stopServer(child);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const staged = stageServer({
      repoRoot: REPO, tmpDir, nodeModulesDir, port,
      rootFiles: ['server.js', 'seed-knowledge.json', 'skills.json', 'openapi.json', 'package.json', 'model_config.json'],
      linkDirs: [],
      copyDirs: ['lib', 'public', 'prompts', 'config'],
      replacements: [],
    });
    const { dataDir } = staged;
    writeJson(path.join(dataDir, 'accounts.json'), {});
    writeJson(path.join(dataDir, 'learnings.json'), []);
    writeJson(path.join(dataDir, 'purchase-ledger.json'), {});
    fs.writeFileSync(path.join(dataDir, 'credits.json'), '{"acc_corrupt": {"dollar_lots": [');
    writeJson(path.join(dataDir, 'earnings.json'), {});

    const env = {
      ...process.env, NODE_ENV: 'test',
      WALLET_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      SESSION_SECRET: 'fum4-n19-corrupt-test-session-secret-000',
      CONTENT_MODERATION_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'not_a_real_stripe_key_format_placeholder_00000000',
      STRIPE_WEBHOOK_SECRET: 'whsec_' + 'a'.repeat(32),
      AUXILO_DATA_DIR: dataDir,
      AUXILO_ACCOUNTS_FILE: path.join(dataDir, 'accounts.json'),
      AUXILO_CREDITS_FILE: path.join(dataDir, 'credits.json'),
      AUXILO_PURCHASE_LEDGER_FILE: path.join(dataDir, 'purchase-ledger.json'),
    };
    delete env.RESEND_API_KEY;
    delete env.OPS_ALERT_EMAIL;

    const beforeCredits = fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8');
    const boot = await bootServer({ tmpDir, port, env, timeoutMs: 60_000, maxAttempts: 3 });
    if ('skipReason' in boot) { t.skip(boot.skipReason); return; }
    child = boot.child;
    const health = await fetch(`${boot.baseUrl}/health`);
    assert.equal(health.status, 200, 'a corrupt credits.json must never stop the server from starting');
    assert.equal(fs.readFileSync(path.join(dataDir, 'credits.json'), 'utf8'), beforeCredits, 'the corrupt file is left exactly as it was -- the scan refuses to guess, never writes over it');
  });
});
