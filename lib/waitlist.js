'use strict';

/**
 * lib/waitlist.js: payout-notification waitlist (quiet-phase capture).
 *
 * Stores the accrue-only-window email list at data/waitlist.json as an array
 * of { email, ts, source } records ONLY. No IP addresses, no user agents,
 * nothing else (PII-minimal by design; data/ is gitignored so the list never
 * enters git).
 *
 * Pure logic lives here (validation, normalization, dedupe, atomic write,
 * per-IP rate limit) so it unit-tests without booting the server, matching
 * the lib/accounts.js and lib/geo-embargo.js convention. server.js owns the
 * transport: JSON parsing, getClientIp, and HTTP status mapping.
 */

const fs = require('fs');
const path = require('path');

// AUXILO_DATA_DIR override matches lib/tos-acceptance-log.js and
// lib/extraction-consent-reader.js: lets tests route writes into a private
// temp dir. Read at require() time, so tests must set it before require.
const DATA_DIR = process.env.AUXILO_DATA_DIR || path.join(__dirname, '..', 'data');
const WAITLIST_FILE = path.join(DATA_DIR, 'waitlist.json');

// Same email shape check as lib/accounts.js registration.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX = 254;      // RFC 5321 practical ceiling
const SOURCE_MAX = 100;     // cap on the free-text source label
const WAITLIST_MAX = 50000; // growth ceiling, mirrors REPORT_MAX_TOTAL (D-5 pattern)

// Per-IP rate limit, mirroring server.js isReportRateLimited (S21-3):
// sliding window, in-memory only. The IP is used for throttling and is
// never written to disk.
const WAITLIST_RATE_LIMIT = 10;                 // signups per IP per hour
const WAITLIST_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const waitlistRateStore = new Map();            // ip -> number[] (timestamps)

function isWaitlistRateLimited(ip) {
  const now = Date.now();
  if (!waitlistRateStore.has(ip)) {
    waitlistRateStore.set(ip, [now]);
    return false;
  }
  const timestamps = waitlistRateStore.get(ip).filter(ts => now - ts < WAITLIST_RATE_WINDOW_MS);
  if (timestamps.length >= WAITLIST_RATE_LIMIT) {
    waitlistRateStore.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  waitlistRateStore.set(ip, timestamps);
  return false;
}

function loadWaitlist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(WAITLIST_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // missing, empty, or corrupt file: start clean, never throw
  }
}

// Atomic tmp-then-rename write, matching lib/credits.js saveCredits().
function saveWaitlist(list) {
  const tmp = WAITLIST_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, WAITLIST_FILE);
}

function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function isValidEmail(email) {
  return typeof email === 'string'
    && email.length > 0
    && email.length <= EMAIL_MAX
    && EMAIL_REGEX.test(email);
}

/**
 * Add an email to the waitlist.
 *
 * Returns:
 *   { ok: true,  duplicate: boolean }   stored, or silently already present
 *   { ok: false, error, status }        invalid input or capacity reached
 *
 * The duplicate flag is reported to the CALLER only (so tests can assert
 * dedupe); the HTTP route returns the same body either way, so the endpoint
 * cannot be used to probe whether an email is on the list.
 */
function addToWaitlist(rawEmail, rawSource) {
  const email = normalizeEmail(rawEmail);
  if (!isValidEmail(email)) {
    return { ok: false, error: 'A valid email address is required', status: 400 };
  }
  const source = (typeof rawSource === 'string' && rawSource.trim())
    ? rawSource.trim().slice(0, SOURCE_MAX)
    : null;

  const list = loadWaitlist();
  if (list.some(entry => entry && entry.email === email)) {
    return { ok: true, duplicate: true };
  }
  if (list.length >= WAITLIST_MAX) {
    return { ok: false, error: 'Waitlist capacity reached. Please contact support.', status: 503 };
  }
  list.push({ email, ts: new Date().toISOString(), source });
  saveWaitlist(list);
  return { ok: true, duplicate: false };
}

function waitlistCount() {
  return loadWaitlist().length;
}

module.exports = {
  addToWaitlist,
  waitlistCount,
  isWaitlistRateLimited,
  // exported for tests
  WAITLIST_FILE,
  EMAIL_REGEX,
  EMAIL_MAX,
  SOURCE_MAX,
  WAITLIST_MAX,
  WAITLIST_RATE_LIMIT,
  WAITLIST_RATE_WINDOW_MS,
};
