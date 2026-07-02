'use strict';

// S-6 FIX: redirect-target validation for the OFAC sanctions-list downloader.
//
// _fetchWithRedirects (server.js) follows the upstream Location header. The OFAC
// origin URLs are hardcoded HTTPS gov constants, but the redirect follower
// previously honored ANY Location (any scheme/host) with only a hop-count guard —
// a MITM-injected or compromised-upstream 30x to an internal address (e.g.
// http://169.254.169.254/) would be fetched on the server's behalf. This module
// enforces, on EVERY hop: https only, and a hostname under an allowlisted
// treasury apex (treas.gov / treasury.gov).
//
// Extracted into its own pure, dependency-free module so it can be unit-tested
// without booting the HTTP server (server.js has no require-main guard).

const OFAC_ALLOWED_HOST_SUFFIXES = ['.treas.gov', '.treasury.gov'];

/**
 * Validate a redirect Location (resolved against the previous URL).
 * @param {string} location - the raw Location header value (may be relative)
 * @param {string} baseUrl  - the URL the redirect was received from
 * @returns {string|null} the absolute href if https + allowlisted treasury host, else null
 */
function validateOfacRedirect(location, baseUrl) {
  // An empty/whitespace Location resolves to the base URL itself (a same-document
  // reference) — reject it as malformed rather than silently re-fetching.
  if (typeof location !== 'string' || location.trim() === '') return null;
  let next;
  try {
    next = new URL(location, baseUrl);
  } catch {
    return null;
  }
  if (next.protocol !== 'https:') return null;
  const host = next.hostname.toLowerCase().replace(/\.$/, ''); // strip trailing dot
  const ok =
    host === 'treas.gov' ||
    host === 'treasury.gov' ||
    OFAC_ALLOWED_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx));
  return ok ? next.href : null;
}

module.exports = { validateOfacRedirect, OFAC_ALLOWED_HOST_SUFFIXES };
