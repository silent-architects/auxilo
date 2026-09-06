'use strict';

/**
 * lib/analytics.js: quiet-phase privacy-light analytics readiness.
 *
 * INERT BY DEFAULT. Mirrors the X402_ROUTER_ADDRESS flag pattern: everything
 * here is a no-op unless the ANALYTICS_DOMAIN env var is set (e.g.
 * "auxilo.io"). With it unset, the exported helpers return their inputs
 * byte-for-byte unchanged, so served HTML bodies and the CSP header are
 * identical to the pre-analytics build (test/analytics-gating.test.js pins
 * this).
 *
 * When set:
 *   1. Served HTML pages gain the Plausible script tag before </head>
 *      (script defer, data-domain from env, src plausible.io).
 *   2. The CSP gains ONLY two source additions: script-src and connect-src
 *      each allow https://plausible.io. Nothing else widens.
 *
 * Plausible is cookieless and stores no personal data in the browser, so no
 * consent banner is required and Privacy Policy 6.1 (no cookies) still holds.
 * Activation is an operator decision: Tyler creates the Plausible account and
 * sets the env var; nothing in this module phones home while unset. Before
 * activating in production, docs/SUBPROCESSORS.md and the Privacy Policy
 * tracking sections must be updated (see the activation checklist in the
 * quiet-phase build report).
 */

const ANALYTICS_HOST = 'https://plausible.io';

// The domain must look like a bare hostname: letters, digits, dots, hyphens,
// at least one dot. Anything else (quotes, slashes, spaces, ports) is refused
// so a malformed env var cannot break out of the script-tag attribute or
// widen the CSP. Refusal fails INERT, never open.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Resolve the raw ANALYTICS_DOMAIN env value to a safe hostname, or '' when
 * unset or malformed ('' keeps every helper below inert).
 */
function resolveAnalyticsDomain(raw) {
  const domain = String(raw == null ? '' : raw).trim();
  if (!domain) return '';
  if (!DOMAIN_RE.test(domain)) {
    console.warn(`[analytics] ANALYTICS_DOMAIN ${JSON.stringify(domain)} is not a bare hostname; analytics stays inert.`);
    return '';
  }
  return domain.toLowerCase();
}

/** The exact script tag Plausible documents, or '' when inert. */
function analyticsScriptTag(domain) {
  if (!domain) return '';
  return `<script defer data-domain="${domain}" src="${ANALYTICS_HOST}/js/script.js"></script>`;
}

/**
 * Inject the Plausible script into an HTML document just before </head>.
 * Returns the input UNCHANGED (same string) when the domain is unset, and
 * also when the document has no </head> to anchor on (fail inert).
 */
function injectAnalytics(html, domain) {
  if (!domain) return html;
  const idx = html.indexOf('</head>');
  if (idx === -1) return html;
  return html.slice(0, idx) + `  ${analyticsScriptTag(domain)}\n` + html.slice(idx);
}

/**
 * Build the Content-Security-Policy header value.
 *
 * With the domain unset this returns the exact pre-analytics policy string
 * (the security rationale for each directive is documented at the call site
 * in server.js). With it set, script-src and connect-src each gain ONLY the
 * plausible.io host; every other directive is untouched.
 */
function buildContentSecurityPolicy(domain) {
  const plausible = domain ? ` ${ANALYTICS_HOST}` : '';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${plausible}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self'${plausible}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
}

module.exports = {
  ANALYTICS_HOST,
  resolveAnalyticsDomain,
  analyticsScriptTag,
  injectAnalytics,
  buildContentSecurityPolicy,
};
