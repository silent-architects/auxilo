'use strict';

/**
 * test/ofac-redirect.test.js — S-6 OFAC redirect allowlist (lib/ofac-redirect.js)
 *
 * 2026-07 launch-day incident: Treasury's sanctionslistservice began 302-ing the
 * SDN/alt CSV downloads to pre-signed S3 objects in AWS GovCloud
 * (<bucket>.s3.us-gov-west-1.amazonaws.com). The treasury-apex-only allowlist
 * blocked the hop ("redirect to disallowed host blocked"), the sanctions list
 * could not load after a restart, and money movement correctly failed CLOSED —
 * which also meant no buyer settlement could complete. The fix admits HTTPS
 * redirects to GovCloud S3 bucket hosts ONLY. These tests pin both directions:
 * the real delivery host works, and the SSRF posture (no commercial-region S3,
 * no suffix spoof, no http, no internal IPs) holds.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateOfacRedirect } = require('../lib/ofac-redirect.js');

const BASE = 'https://sanctionslistservice.ofac.treas.gov/api/publicationpreview/exports/sdn.csv';

describe('OFAC redirect allowlist — accepts the real delivery hosts', () => {
  it('accepts the observed GovCloud pre-signed S3 redirect (virtual-hosted style)', () => {
    const loc = 'https://wc2h-sls-prod-public-published.s3.us-gov-west-1.amazonaws.com/Published/x/SDN.CSV?X-Amz-Expires=3600&X-Amz-Signature=abc';
    assert.notEqual(validateOfacRedirect(loc, BASE), null);
  });
  it('accepts gov-east and the legacy dash region form', () => {
    assert.notEqual(validateOfacRedirect('https://b.s3-us-gov-east-1.amazonaws.com/f.csv', BASE), null);
    assert.notEqual(validateOfacRedirect('https://b.s3.us-gov-east-1.amazonaws.com/f.csv', BASE), null);
  });
  it('still accepts treasury apex + subdomain hosts', () => {
    assert.notEqual(validateOfacRedirect('https://www.treasury.gov/ofac/downloads/sdn.csv', BASE), null);
    assert.notEqual(validateOfacRedirect('https://sanctionslist.ofac.treas.gov/x.csv', BASE), null);
    assert.notEqual(validateOfacRedirect('https://treas.gov/x.csv', BASE), null);
  });
  it('resolves relative Locations against the base', () => {
    assert.notEqual(validateOfacRedirect('/api/exports/alt.csv', BASE), null);
  });
});

describe('OFAC redirect allowlist — SSRF posture holds', () => {
  const rejected = [
    ['commercial-region S3', 'https://evil.s3.us-west-2.amazonaws.com/x'],
    ['suffix-spoof apex', 'https://x.s3.us-gov-west-1.amazonaws.com.evil.com/x'],
    ['treasury-lookalike apex', 'https://treas.gov.evil.com/x'],
    ['http downgrade to GovCloud', 'http://b.s3.us-gov-west-1.amazonaws.com/x'],
    ['bare region host (path-style, no bucket)', 'https://s3.us-gov-west-1.amazonaws.com/bucket/x'],
    ['internal metadata IP', 'https://169.254.169.254/latest/meta-data/'],
    ['arbitrary host', 'https://example.com/sdn.csv'],
    ['empty Location', ''],
  ];
  for (const [name, loc] of rejected) {
    it(`rejects: ${name}`, () => {
      assert.equal(validateOfacRedirect(loc, BASE), null);
    });
  }
});
