'use strict';

/**
 * test/geo-embargo.test.js — CP-4 IP-geolocation embargo screen (AML-PROGRAM §4.3 G-2)
 *
 * Two layers, matching the repo's conventions:
 *   A) Behavioral unit tests of the PURE decision engine (lib/geo-embargo.js) —
 *      embargoed country blocked, allowed country passes, missing-signal
 *      fail-open, and the Ukraine region limitation (UA not wholesale-blocked;
 *      only occupied regions, and only when a region signal is present).
 *   B) Structural tests that the two enforcement points named by G-2 — the
 *      builder wallet-link hook (E-1) and the x402 buyer settle path (E-2) — are
 *      actually wired into server.js and run BEFORE the money moves. This mirrors
 *      test/x402-router-server.test.js, which analyzes server.js source rather
 *      than booting the whole app (requiring server.js starts a listener + OFAC).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const geo = require('../lib/geo-embargo.js');

// A minimal Hono-context stand-in. Hono's c.req.header(name) is case-insensitive;
// the lib always queries lowercase header names, so a lowercase map suffices.
function mkCtx(headers = {}) {
  return {
    req: {
      header: (name) => headers[String(name).toLowerCase()],
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. Decision engine — embargoed country BLOCKED at each enforcement point
// ─────────────────────────────────────────────────────────────────────────────
describe('screenGeo — embargoed whole countries are blocked (fail closed)', () => {
  for (const cc of ['CU', 'IR', 'KP', 'SY']) {
    it(`blocks ${cc}`, () => {
      const d = geo.screenGeo(cc);
      assert.equal(d.embargoed, true, `${cc} must be embargoed`);
      assert.equal(d.signal, 'present');
      assert.equal(d.level, 'country');
      assert.equal(d.country, cc);
      assert.equal(d.reason, 'embargoed_country');
    });
  }

  it('normalizes case and surrounding whitespace before matching', () => {
    assert.equal(geo.screenGeo(' ir ').embargoed, true);
    assert.equal(geo.screenGeo('Cu').embargoed, true);
    assert.equal(geo.screenGeo('kp').embargoed, true);
  });

  it('every embargoed country is enforced at BOTH enforcement points (same pure decision)', () => {
    // The wallet-link gate and the x402 buyer gate both funnel through screenGeo,
    // so a country that screenGeo blocks is blocked at both points by construction.
    for (const cc of ['CU', 'IR', 'KP', 'SY']) {
      const linkCtx = mkCtx({ 'cf-ipcountry': cc });   // builder wallet-link (E-1)
      const buyerCtx = mkCtx({ 'cf-ipcountry': cc });  // x402 buyer settle (E-2)
      assert.equal(geo.screenGeo(geo.getRequestCountry(linkCtx)).embargoed, true);
      assert.equal(geo.screenGeo(geo.getRequestCountry(buyerCtx)).embargoed, true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Decision engine — allowed country PASSES
// ─────────────────────────────────────────────────────────────────────────────
describe('screenGeo — non-embargoed countries pass (inert)', () => {
  for (const cc of ['US', 'GB', 'DE', 'CA', 'JP', 'NG', 'BR', 'IN']) {
    it(`allows ${cc}`, () => {
      const d = geo.screenGeo(cc);
      assert.equal(d.embargoed, false, `${cc} must pass`);
      assert.equal(d.signal, 'present');
      assert.equal(d.level, null);
      assert.equal(d.reason, 'allowed');
    });
  }

  it('a look-alike but non-embargoed code is not accidentally caught', () => {
    // CY (Cyprus) / SS (South Sudan) / IN (India) must not be confused with CU/SY/IR.
    assert.equal(geo.screenGeo('CY').embargoed, false);
    assert.equal(geo.screenGeo('SS').embargoed, false);
    assert.equal(geo.screenGeo('IN').embargoed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Decision engine — MISSING signal fail-mode (advisory, FAIL OPEN)
// ─────────────────────────────────────────────────────────────────────────────
describe('screenGeo — missing/unusable geo signal fails OPEN (advisory, not blocked)', () => {
  // AML-PROGRAM §4.3 G-2: fail-open on geo-lookup failure is acceptable only if
  // logged; geo is advisory, not the primary SDN control.
  const missing = [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace', '   '],
    ['Cloudflare XX (unknown)', 'XX'],
    ['Cloudflare T1 (Tor)', 'T1'],
    ['non-string number', 12],
    ['object', {}],
    ['3-letter code', 'USA'],
    ['single letter', 'X'],
    ['digits', '11'],
  ];
  for (const [label, val] of missing) {
    it(`does NOT block on ${label} — returns advisory missing signal`, () => {
      const d = geo.screenGeo(val);
      assert.equal(d.embargoed, false, `${label} must not hard-block`);
      assert.equal(d.signal, 'missing');
      assert.equal(d.reason, 'geo_signal_missing');
      assert.equal(d.country, null);
    });
  }

  it('a missing country signal is not rescued by a region signal (no country = advisory)', () => {
    const d = geo.screenGeo(null, 'UA-43');
    assert.equal(d.embargoed, false);
    assert.equal(d.signal, 'missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Decision engine — Ukraine REGION limitation
// ─────────────────────────────────────────────────────────────────────────────
describe('screenGeo — Ukraine region limitation (UA not wholesale-blocked)', () => {
  it('does NOT block Ukraine wholesale when only the country signal is present', () => {
    // The core limitation: cf-ipcountry gives UA for the whole country. We must
    // NOT block all of Ukraine — only the occupied regions.
    const d = geo.screenGeo('UA');
    assert.equal(d.embargoed, false, 'UA as a whole must NOT be blocked');
    assert.equal(d.signal, 'present');
    assert.equal(d.reason, 'allowed');
  });

  it('UA is deliberately absent from the whole-country embargo set', () => {
    assert.equal(geo.EMBARGO.countries.has('UA'), false);
    for (const cc of ['CU', 'IR', 'KP', 'SY']) {
      assert.equal(geo.EMBARGO.countries.has(cc), true);
    }
  });

  it('blocks occupied UA regions ONLY when a region signal is also present (best-effort)', () => {
    for (const region of ['UA-43', '43', 'CRIMEA', 'UA-14', 'DNR', 'UA-09', 'LNR', 'SEVASTOPOL']) {
      const d = geo.screenGeo('UA', region);
      assert.equal(d.embargoed, true, `UA + ${region} should be blocked`);
      assert.equal(d.level, 'region');
      assert.equal(d.reason, 'embargoed_region');
    }
  });

  it('does NOT block non-occupied UA regions (e.g. Kyiv)', () => {
    for (const region of ['UA-30', '30', 'KYIV', 'UA-46', 'LVIV']) {
      const d = geo.screenGeo('UA', region);
      assert.equal(d.embargoed, false, `UA + ${region} must pass`);
    }
  });

  it('a non-embargoed country with a region signal is unaffected', () => {
    assert.equal(geo.screenGeo('US', 'US-CA').embargoed, false);
    assert.equal(geo.screenGeo('DE', 'DE-BE').embargoed, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Header extraction from the Hono context
// ─────────────────────────────────────────────────────────────────────────────
describe('getRequestCountry / getRequestRegion — header extraction', () => {
  it('reads and normalizes cf-ipcountry', () => {
    assert.equal(geo.getRequestCountry(mkCtx({ 'cf-ipcountry': 'ir' })), 'IR');
    assert.equal(geo.getRequestCountry(mkCtx({ 'cf-ipcountry': ' US ' })), 'US');
  });

  it('returns null when the country header is absent or a sentinel', () => {
    assert.equal(geo.getRequestCountry(mkCtx({})), null);
    assert.equal(geo.getRequestCountry(mkCtx({ 'cf-ipcountry': 'XX' })), null);
    assert.equal(geo.getRequestCountry(mkCtx({ 'cf-ipcountry': 'T1' })), null);
  });

  it('reads the optional cf-region-code header', () => {
    assert.equal(geo.getRequestRegion(mkCtx({ 'cf-region-code': 'UA-43' })), 'UA-43');
    assert.equal(geo.getRequestRegion(mkCtx({})), null);
  });

  it('never throws even if the context/header accessor is broken', () => {
    const brokenCtx = { req: { header: () => { throw new Error('boom'); } } };
    assert.equal(geo.getRequestCountry(brokenCtx), null);
    assert.equal(geo.getRequestRegion(brokenCtx), null);
    assert.equal(geo.getRequestCountry(null), null);
    assert.equal(geo.getRequestCountry({}), null);
  });

  it('end-to-end: an embargoed header context resolves to a block decision', () => {
    const d = geo.screenGeo(
      geo.getRequestCountry(mkCtx({ 'cf-ipcountry': 'KP' })),
      geo.getRequestRegion(mkCtx({ 'cf-ipcountry': 'KP' })),
    );
    assert.equal(d.embargoed, true);
    assert.equal(d.country, 'KP');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Immutability of the COUNSEL-CONFIRM constant
// ─────────────────────────────────────────────────────────────────────────────
describe('EMBARGO constant shape', () => {
  it('is frozen at the top level and exposes countries + regions', () => {
    assert.equal(Object.isFrozen(geo.EMBARGO), true);
    assert.ok(geo.EMBARGO.countries instanceof Set);
    assert.ok(geo.EMBARGO.regions && geo.EMBARGO.regions.UA instanceof Set);
  });

  it('contains exactly the four documented whole-country embargoes', () => {
    assert.deepEqual([...geo.EMBARGO.countries].sort(), ['CU', 'IR', 'KP', 'SY']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Structural — enforcement points are wired into server.js
// ─────────────────────────────────────────────────────────────────────────────
describe('server.js wiring — CP-4 enforcement points (structural)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  it('requires the geo-embargo module', () => {
    assert.match(src, /require\('\.\/lib\/geo-embargo\.js'\)/);
  });

  it('E-1: screens geo at the wallet-link hook', () => {
    assert.ok(
      src.includes("geoEmbargoGate(c, '/account/link-wallet')"),
      'wallet-link route must call geoEmbargoGate',
    );
  });

  it('E-1: the wallet-link geo screen runs BEFORE the wallet is linked', () => {
    const gateIdx = src.indexOf("geoEmbargoGate(c, '/account/link-wallet')");
    // AUD19 MED-2: linkWallet gained a platformWallets refusal arg.
    const linkIdx = src.indexOf('linkWallet(accountId, wallet, verifiedWallets, PLATFORM_WALLETS)');
    assert.ok(gateIdx > 0 && linkIdx > 0, 'both markers must exist');
    assert.ok(gateIdx < linkIdx, 'geo screen must precede linkWallet()');
  });

  it('E-2: screens the buyer geo on every LIVE x402 settle site', () => {
    // Wave-1 AUD19-13: the dead x402Gate middleware (zero callers) carried the
    // second buyer gate; deleting it leaves verifyPaymentOrReject as the ONE
    // live settle path. The invariant is coverage, not a count: every
    // _verifyPayment CALL site must carry the buyer geo gate in its function.
    const gates = src.match(/geoEmbargoGate\(c, `\$\{new URL\(c\.req\.url\)\.pathname\} \(x402 buyer\)`\)/g) || [];
    const settleCalls = (src.match(/await _verifyPayment\(/g) || []).length;
    assert.equal(settleCalls, 1, 'exactly one live x402 settle call site (verifyPaymentOrReject)');
    assert.equal(gates.length, settleCalls,
      `every live settle site must be geo-gated (gates=${gates.length}, settle sites=${settleCalls})`);
  });

  it('E-2: each x402 buyer geo screen runs BEFORE _verifyPayment (before settling)', () => {
    // Every occurrence of the buyer gate must be followed by a _verifyPayment call
    // — i.e. gate then settle, in order — at every live settle site.
    const gateRe = /geoEmbargoGate\(c, `\$\{new URL\(c\.req\.url\)\.pathname\} \(x402 buyer\)`\)/g;
    let m;
    let checked = 0;
    while ((m = gateRe.exec(src)) !== null) {
      const settleIdx = src.indexOf('_verifyPayment(', m.index);
      assert.ok(settleIdx > m.index, 'a _verifyPayment must follow each buyer geo gate');
      checked++;
    }
    assert.equal(checked, (src.match(/await _verifyPayment\(/g) || []).length,
      'ordering verified at every live settle site');
  });

  it('returns a clear GEO_EMBARGOED error with HTTP 403 on a positive match', () => {
    assert.ok(src.includes("code: 'GEO_EMBARGOED'"), 'must return GEO_EMBARGOED code');
    // The gate helper returns the error object with a 403 status argument.
    assert.match(src, /GEO_EMBARGOED'[\s\S]{0,80}?403/);
  });

  it('fail-open + logging: gate advisory-logs a missing signal and does NOT block it', () => {
    // The helper only returns a block when decision.embargoed is truthy; a missing
    // signal takes the advisory-log branch and returns null (proceed).
    assert.ok(src.includes('ADVISORY-NO-GEO'), 'missing-signal advisory log marker present');
    assert.ok(src.includes('logGeoBlock('), 'geo block ledger writer present');
  });

  it('emits an ops alert consistent with the CP-1 fire-and-forget pattern', () => {
    // sendOpsAlert(...).catch(() => {}) — never awaited, never surfaces to request.
    assert.match(src, /sendOpsAlert\([\s\S]*?Embargoed-jurisdiction[\s\S]*?\)\s*\.catch\(\(\)\s*=>\s*\{\}\)/);
  });
});
