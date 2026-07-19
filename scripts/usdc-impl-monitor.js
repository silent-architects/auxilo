#!/usr/bin/env node
'use strict';

// scripts/usdc-impl-monitor.js — A1 off-chain USDC implementation monitor.
//
// The ALERTING layer of the A1 circuit-breaker. The fail-closed guard that
// actually protects funds lives inline in lib/x402-router.js (settleWithRouter
// refuses to broadcast if the impl changed); THIS script is the early-warning:
// run it on a cron (one-shot) or as a long-lived --watch process so ops learns
// the moment Circle upgrades the USDC proxy — before or alongside the rail
// tripping.
//
// USAGE:
//   node scripts/usdc-impl-monitor.js                 # one-shot; exit 0 ok, 2 changed, 3 read-error
//   node scripts/usdc-impl-monitor.js --json          # machine-readable
//   node scripts/usdc-impl-monitor.js --watch [--interval 60]   # poll forever, alert on change
//
// CONFIG (env):
//   X402_ROUTER_CHAIN_ID       8453 (default) | 84532
//   X402_ROUTER_USDC           override USDC proxy address (else per-chain pin)
//   X402_ROUTER_RPC_URL        override RPC (else viem default for the chain)
//   X402_USDC_EXPECTED_IMPL    override expected impl (required for unpinned chains)
//   X402_USDC_EXPECTED_CODEHASH optional secondary bytecode-hash pin
//   X402_MONITOR_WEBHOOK_URL   optional; POSTed a JSON alert on change

const { createPublicClient, http } = require('viem');
const { base, baseSepolia } = require('viem/chains');
const monitor = require('../lib/usdc-impl-monitor.js');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const watch = args.includes('--watch');
const intervalSec = (() => {
  const i = args.indexOf('--interval');
  if (i >= 0 && args[i + 1]) return Math.max(5, parseInt(args[i + 1], 10) || 60);
  return 60;
})();

const chainId = Number(process.env.X402_ROUTER_CHAIN_ID || 8453);
const usdcAddress = process.env.X402_ROUTER_USDC
  || (monitor.pinnedFor(chainId) && monitor.pinnedFor(chainId).usdc)
  || null;

function publicClient() {
  const chain = chainId === 84532 ? baseSepolia : base;
  const transport = process.env.X402_ROUTER_RPC_URL ? http(process.env.X402_ROUTER_RPC_URL) : http();
  return createPublicClient({ chain, transport });
}

async function runOnce() {
  if (!usdcAddress) {
    return { ok: false, reason: 'no_usdc_address', chainId, expected: null, actual: null };
  }
  const res = await monitor.checkUsdcImplementation({ publicClient: publicClient(), chainId, usdcAddress });
  return { ...res, chainId, usdc: usdcAddress };
}

async function alertWebhook(res) {
  const url = process.env.X402_MONITOR_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'usdc-impl-monitor', severity: 'critical', ...res }),
    });
  } catch (err) {
    console.error(`[usdc-impl-monitor] webhook POST failed: ${err.message}`);
  }
}

function stamp() { return new Date().toISOString(); }

function report(res) {
  if (asJson) { console.log(JSON.stringify(res)); return; }
  if (res.ok) {
    console.log(`[${stamp()}] ✓ USDC impl OK on chain ${res.chainId}: ${res.actual} (== pinned)`);
  } else if (res.readError || String(res.reason).includes('read_failed')) {
    console.error(`[${stamp()}] ⚠ USDC impl READ ERROR on chain ${res.chainId}: ${res.reason}`);
  } else {
    console.error(`[${stamp()}] ✗✗ USDC IMPL CHANGED on chain ${res.chainId}: reason=${res.reason} expected=${res.expected} actual=${res.actual}`);
    console.error(`[${stamp()}] ✗✗ CIRCUIT-BREAKER CONDITION — the x402 router rail fails closed. Re-verify the new impl and re-pin before re-enabling.`);
  }
}

// Exit codes for cron/CI: 0 ok, 2 changed (critical), 3 read/config error.
function exitCodeFor(res) {
  if (res.ok) return 0;
  if (res.readError || String(res.reason).includes('read_failed') || res.reason === 'no_usdc_address' || res.reason === 'no_pinned_impl') return 3;
  return 2;
}

async function main() {
  if (!watch) {
    const res = await runOnce();
    report(res);
    if (!res.ok && exitCodeFor(res) === 2) await alertWebhook(res);
    process.exit(exitCodeFor(res));
  }

  console.log(`[${stamp()}] usdc-impl-monitor watching chain ${chainId} USDC ${usdcAddress} every ${intervalSec}s`);
  let lastAlertedReason = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try { res = await runOnce(); } catch (err) { res = { ok: false, reason: 'monitor_exception:' + err.message, chainId, usdc: usdcAddress }; }
    report(res);
    if (!res.ok && exitCodeFor(res) === 2 && res.reason !== lastAlertedReason) {
      await alertWebhook(res);
      lastAlertedReason = res.reason; // alert once per distinct change, keep logging
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main().catch((err) => { console.error('[usdc-impl-monitor] fatal:', err); process.exit(3); });
