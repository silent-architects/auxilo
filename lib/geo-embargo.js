/**
 * lib/geo-embargo.js — CP-4: IP-geolocation embargo screen (AML-PROGRAM §4.3 G-2).
 *
 * Purpose: screen the request's origin country against comprehensively
 * OFAC-embargoed jurisdictions at Auxilo's two money-movement points — the
 * builder wallet-link hook (AML-PROGRAM E-1) and the x402 buyer settle path
 * (AML-PROGRAM E-2). This closes gap G-2 ("zero country/geo handling in
 * server.js"). It is a SECONDARY, defense-in-depth control that sits alongside
 * the PRIMARY, fail-closed OFAC SDN wallet screen (server.js checkOFAC) — it
 * does NOT replace it.
 *
 * ── Signal source (no network calls) ────────────────────────────────────────
 * Production is behind Cloudflare, which stamps the visitor country onto the
 * `cf-ipcountry` request header at its edge. Reading a header is O(1) and
 * involves NO outbound lookup at request time — this module makes zero network
 * calls. When Cloudflare is not in front (local dev, CI, a direct-to-origin
 * hit) the header is simply absent, which is handled as a MISSING signal below.
 *
 * ── Fail-mode (specified verbatim by AML-PROGRAM.md §4.3 G-2) ────────────────
 *   • POSITIVE embargo match at a money-movement point → the caller FAILS
 *     CLOSED (block + log + ops-alert). This is the whole point of the control.
 *   • MISSING geo signal (no/unknown country) → FAIL OPEN (advisory-log only,
 *     do NOT hard-block). Rationale, quoting the program: "Fail-open on
 *     geo-lookup failure is acceptable *only* if logged (geo is advisory, not
 *     the primary SDN control)." The strict-liability control is the OFAC wallet
 *     screen, which runs fail-closed regardless of geo. Hard-blocking every
 *     request that lacks a `cf-ipcountry` header would take the entire service
 *     down anywhere Cloudflare is not in front — an unacceptable availability
 *     cost for a SECONDARY advisory screen. The tradeoff (a determined party can
 *     strip/spoof geo, or route around Cloudflare) is the documented,
 *     accepted limitation of IP-geo as an advisory layer; the SDN wallet screen
 *     is what actually discharges strict liability.
 *
 * This module is deliberately PURE (no fs, no env, no Hono coupling beyond a
 * thin header getter) so the decision engine is fully unit-testable. The
 * side effects — appending to the block log, emitting the ops alert, returning
 * the 403 — live at the call sites in server.js, mirroring how logOFACBlock and
 * the OFAC screen are wired there.
 */

'use strict';

// ─── EMBARGO LIST — ONE constant, COUNSEL-CONFIRM ────────────────────────────
//
// COUNSEL-CONFIRM: The membership of this list is a legal determination and MUST
// be reviewed and ratified by licensed money-transmission / sanctions counsel
// before it is represented as Auxilo's adopted control (see AML-PROGRAM.md
// §11 ratification route). Sanctions programs change; this snapshot reflects the
// comprehensively-embargoed jurisdictions named in AML-PROGRAM.md §4.3 G-2 as of
// the drafting date. Counsel must confirm (a) the country set, (b) the
// fail-open-on-missing-signal posture, and (c) the Ukraine region limitation
// documented below.
//
// `countries` — WHOLE-country comprehensive embargoes. These are reliably
//   enforceable from `cf-ipcountry` alone (country-level granularity is exactly
//   what the header provides). ISO 3166-1 alpha-2 codes:
//     CU Cuba · IR Iran · KP North Korea · SY Syria
//
// `regions` — REGION-level embargoes that apply to occupied territories WITHIN a
//   country that is otherwise NOT embargoed. Ukraine is the live case: the
//   Crimea, Donetsk (DNR) and Luhansk (LNR) regions are embargoed, but UKRAINE
//   AS A WHOLE MUST NOT BE BLOCKED. UA is therefore deliberately ABSENT from
//   `countries`. See the region-limitation note below for why this can only be
//   BEST-EFFORT via header signals.
const EMBARGO = Object.freeze({
  // COUNSEL-CONFIRM — comprehensively OFAC-embargoed whole countries.
  countries: new Set(['CU', 'IR', 'KP', 'SY']),

  // COUNSEL-CONFIRM — region-level embargoes. Key = ISO 3166-1 country code that
  // is itself NOT embargoed; value = set of accepted sub-division tokens for the
  // embargoed regions within it. Tokens are matched liberally (full ISO 3166-2
  // code, bare sub-division code, and common alias) because the exact region
  // token an edge provider emits is not standardized — see limitation note.
  regions: Object.freeze({
    // Ukraine — occupied regions only; UA as a whole is NOT embargoed.
    //   Crimea      ISO 3166-2 UA-43  (Aut. Rep. of Crimea)
    //   Sevastopol  ISO 3166-2 UA-40
    //   Donetsk/DNR ISO 3166-2 UA-14
    //   Luhansk/LNR ISO 3166-2 UA-09
    UA: new Set([
      'UA-43', '43', 'CRIMEA',
      'UA-40', '40', 'SEVASTOPOL',
      'UA-14', '14', 'DONETSK', 'DNR',
      'UA-09', '09', '9', 'LUHANSK', 'LNR',
    ]),
  }),
});

// ── REGION-LIMITATION NOTE (COUNSEL-CONFIRM) ─────────────────────────────────
// `cf-ipcountry` resolves COUNTRY only — it cannot distinguish the Crimea/DNR/LNR
// regions from the rest of Ukraine. We therefore CANNOT enforce the Ukraine
// region embargo from the country header, and we MUST NOT block all of UA to
// compensate. Region enforcement below is BEST-EFFORT: it fires only when a
// separate region signal (`cf-region-code`, from Cloudflare's optional "visitor
// location headers" managed transform) happens to be present AND matches an
// occupied-region token. That header is frequently absent, its token format is
// provider-specific, and IP-geolocation of occupied territory is itself
// unreliable (traffic often routes through RU or neutral IPs). CONSEQUENCE: the
// Ukraine region embargo is NOT reliably discharged by this control. A
// region-capable geo provider (e.g. MaxMind at sub-division granularity) is the
// documented follow-up; until then this region check is advisory and the gap is
// flagged for counsel. The four whole-country embargoes ARE reliably enforced.

const CF_COUNTRY_HEADER = 'cf-ipcountry';
const CF_REGION_HEADER = 'cf-region-code';

// Cloudflare sentinel values that are NOT real countries and must be treated as
// a MISSING signal (fail open), not as a country to compare:
//   'XX' — country could not be determined.
//   'T1' — request came from the Tor network (no meaningful country).
const NON_COUNTRY_SENTINELS = new Set(['XX', 'T1']);

/**
 * Normalize a raw country header value to an upper-case ISO-3166 alpha-2 code,
 * or null when there is no usable signal.
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeCountry(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (!code) return null;
  if (NON_COUNTRY_SENTINELS.has(code)) return null;
  // A well-formed country code is two ASCII letters. Anything else is treated as
  // no-signal rather than risk a bogus comparison.
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code;
}

/**
 * Normalize a raw region/sub-division header value, or null when absent.
 * @param {*} raw
 * @returns {string|null}
 */
function normalizeRegion(raw) {
  if (raw == null || typeof raw !== 'string') return null;
  const r = raw.trim().toUpperCase();
  return r || null;
}

/**
 * Read the Cloudflare-resolved country from a Hono context. Never throws.
 * @param {object} c - Hono context (only c.req.header is used)
 * @returns {string|null} normalized country code, or null if no signal
 */
function getRequestCountry(c) {
  try {
    return normalizeCountry(c && c.req && c.req.header(CF_COUNTRY_HEADER));
  } catch {
    return null;
  }
}

/**
 * Read the (optional) Cloudflare region code from a Hono context. Never throws.
 * @param {object} c - Hono context
 * @returns {string|null} normalized region token, or null if absent
 */
function getRequestRegion(c) {
  try {
    return normalizeRegion(c && c.req && c.req.header(CF_REGION_HEADER));
  } catch {
    return null;
  }
}

/**
 * Core decision engine — PURE. Given a country (and optional region) signal,
 * decide whether the origin is embargoed.
 *
 * @param {string|null} country - ISO 3166-1 alpha-2, or null/absent
 * @param {string|null} [region] - optional sub-division token (best-effort)
 * @returns {{
 *   embargoed: boolean,
 *   signal: 'present'|'missing',
 *   country: string|null,
 *   region: string|null,
 *   level: 'country'|'region'|null,
 *   reason: string
 * }}
 */
function screenGeo(country, region = null) {
  const normCountry = normalizeCountry(country);
  const normRegion = normalizeRegion(region);

  // MISSING signal → advisory, fail OPEN (AML-PROGRAM §4.3 G-2). The caller
  // logs this but must NOT block on it.
  if (!normCountry) {
    return {
      embargoed: false,
      signal: 'missing',
      country: null,
      region: normRegion,
      level: null,
      reason: 'geo_signal_missing',
    };
  }

  // Whole-country comprehensive embargo — reliably enforceable. FAIL CLOSED.
  if (EMBARGO.countries.has(normCountry)) {
    return {
      embargoed: true,
      signal: 'present',
      country: normCountry,
      region: normRegion,
      level: 'country',
      reason: 'embargoed_country',
    };
  }

  // Region-level embargo — BEST-EFFORT, only when a region signal is present.
  // UA and any future region-keyed country is NOT wholesale-blocked; we only
  // match the specific occupied-region tokens. See the region-limitation note.
  const regionSet = EMBARGO.regions[normCountry];
  if (regionSet && normRegion && regionSet.has(normRegion)) {
    return {
      embargoed: true,
      signal: 'present',
      country: normCountry,
      region: normRegion,
      level: 'region',
      reason: 'embargoed_region',
    };
  }

  // Present signal, not embargoed → allow (the hot path).
  return {
    embargoed: false,
    signal: 'present',
    country: normCountry,
    region: normRegion,
    level: null,
    reason: 'allowed',
  };
}

module.exports = {
  EMBARGO,
  CF_COUNTRY_HEADER,
  CF_REGION_HEADER,
  normalizeCountry,
  normalizeRegion,
  getRequestCountry,
  getRequestRegion,
  screenGeo,
};
