// lib/x402-facilitator.js
// x402 facilitator verify + settle exchange (money-critical).
//
// Per the x402 spec, the facilitator exposes two endpoints:
//   POST /verify  — validates + SIMULATES the signed EIP-3009 authorization.
//                   Moves NO funds. Returns { isValid, invalidReason?, payer? }.
//   POST /settle  — broadcasts transferWithAuthorization ON-CHAIN. This is what
//                   actually captures the USDC. Returns
//                   { success, transaction (tx hash), network, errorReason? }.
//
// A resource server MUST settle before delivering paid content. The prior
// Auxilo code called only /verify and treated valid===true as "paid", so every
// facilitator-path sale settled $0 (content served, seller credited, zero USDC
// moved) and could be triggered from an empty wallet. This module performs the
// correct verify -> settle exchange and reports whether the payment actually
// settled on-chain, so the caller can gate delivery on settlement and fail
// CLOSED on any failure.
//
// `fetchImpl` is injectable so the exchange is unit-testable without a live
// facilitator or real funds.

'use strict';

/**
 * Verify then settle an x402 payment with the facilitator.
 *
 * @param {object} p
 * @param {object} p.paymentPayload        Decoded PaymentPayload (from X-Payment).
 * @param {object} p.paymentRequirements   The requirements advertised in the 402.
 * @param {string} p.facilitatorUrl        Base URL, e.g. https://facilitator.openx402.ai
 * @param {Function} [p.fetchImpl]         fetch override (tests).
 * @returns {Promise<{verifyValid:boolean, settled:boolean, settleFailed:boolean, txHash:string|null, reason:string}>}
 *   - verifyValid:false, settleFailed:false  → not a valid authorization (caller may try local fallback)
 *   - verifyValid:true,  settled:true        → captured on-chain; txHash set (DELIVER)
 *   - verifyValid:true,  settleFailed:true   → settlement failed (DO NOT DELIVER, fail closed)
 *   Throws only on network/transport error (caller treats as facilitator-down).
 */
async function verifyAndSettle({ paymentPayload, paymentRequirements, facilitatorUrl, fetchImpl }) {
  const doFetch = fetchImpl || fetch;
  const headers = { 'Content-Type': 'application/json' };
  const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements });

  // 1. VERIFY — validate the signed authorization. No funds move.
  const verifyResp = await doFetch(facilitatorUrl + '/verify', { method: 'POST', headers, body });
  if (!verifyResp.ok) {
    return { verifyValid: false, settled: false, settleFailed: false, txHash: null, reason: `verify_http_${verifyResp.status}` };
  }
  const vr = await verifyResp.json();
  if (!(vr && (vr.isValid === true || vr.valid === true))) {
    return { verifyValid: false, settled: false, settleFailed: false, txHash: null, reason: (vr && (vr.invalidReason || vr.error)) || 'invalid' };
  }

  // 2. SETTLE — broadcast on-chain. THIS captures the USDC.
  const settleResp = await doFetch(facilitatorUrl + '/settle', { method: 'POST', headers, body });
  if (!settleResp.ok) {
    return { verifyValid: true, settled: false, settleFailed: true, txHash: null, reason: `settle_http_${settleResp.status}` };
  }
  const sr = await settleResp.json();
  if (sr && sr.success === true && sr.transaction) {
    return { verifyValid: true, settled: true, settleFailed: false, txHash: String(sr.transaction), reason: 'settled' };
  }
  return { verifyValid: true, settled: false, settleFailed: true, txHash: null, reason: (sr && (sr.errorReason || sr.error)) || 'settle_rejected' };
}

module.exports = { verifyAndSettle };
