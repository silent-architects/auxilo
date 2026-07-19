// lib/identity-vault.js
// CP-2 — self-attested identity / tax-form capture at wallet-link. CODE-DARK.
//
// FLAGS:
//   CP2_IDENTITY_CAPTURE_ENABLED — capture is ON only when this is exactly
//     'true'. Absent or any other value = OFF = zero behavior change anywhere
//     (test-pinned). Activation is counsel-gated (PUNCH-LIST CP-2).
//   CP2_DATA_KEY — REQUIRED when the flag is on: exactly 64 hex chars
//     (32 bytes, AES-256). Anything else is invalid and capture REFUSES
//     (fail closed — never skip, never store plaintext). No passphrase
//     derivation on purpose: a weak passphrase silently sha256'd into a key
//     is a weak key wearing a strong one's clothes (GOV-3).
//
// ── GOV-3 storage design (argued per the 2026-07-01 public-repo leak) ───────
//   • SEPARATE store (data/identity.json), never inside accounts.json:
//     account records are read everywhere; identity is read NOWHERE at
//     runtime. Blast-radius isolation — a bug that serializes an account
//     object into a response cannot drag identity with it.
//   • Encrypted at rest, AES-256-GCM per record: fresh random 12-byte IV per
//     write, auth tag stored, and AAD = accountId — a ciphertext row cannot
//     be transplanted onto another account without failing authentication.
//     The key lives only in the env (Fly secret): a leak of the repo, the
//     volume, or a backup exposes ciphertext only.
//   • File is chmod 0600 and written atomically (tmp + rename).
//   • Plaintext record is MINIMAL: { legal_name, country, tax_form_type,
//     wallet, captured_at }. Self-attested; no verification vendor.
//   • No decryption on any request path. readIdentity() exists for a future
//     counsel-gated export (1099 prep) via ops shell and for tests — it is
//     wired to no route. Responses carry at most `identity_captured: true`;
//     logs carry at most an account id and a boolean.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// AUXILO_IDENTITY_FILE override: test isolation only (unset in production).
const IDENTITY_FILE = process.env.AUXILO_IDENTITY_FILE
    || path.join(__dirname, '..', 'data', 'identity.json');

const TAX_FORM_TYPES = ['W-9', 'W-8BEN'];
const LEGAL_NAME_MAX = 200;
const COUNTRY_MAX = 100;

/** Capture is on only when the flag is exactly 'true'. */
function captureEnabled() {
    return process.env.CP2_IDENTITY_CAPTURE_ENABLED === 'true';
}

/**
 * Parse CP2_DATA_KEY. Returns { ok: true, key: Buffer } or { ok: false, error }.
 * Never includes key material in the error.
 */
function keyStatus() {
    const raw = process.env.CP2_DATA_KEY;
    if (!raw || typeof raw !== 'string') {
        return { ok: false, error: 'CP2_DATA_KEY is not set' };
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
        return { ok: false, error: 'CP2_DATA_KEY must be exactly 64 hex characters (32 bytes)' };
    }
    return { ok: true, key: Buffer.from(raw, 'hex') };
}

/**
 * Validate the self-attested identity fields.
 * @returns {{ok: true, fields: object} | {ok: false, errors: string[]}}
 */
function validateIdentityFields(input) {
    const errors = [];
    const src = (input && typeof input === 'object') ? input : {};
    const legalName = typeof src.legal_name === 'string' ? src.legal_name.trim() : '';
    const country = typeof src.country === 'string' ? src.country.trim() : '';
    const taxFormType = src.tax_form_type;

    if (!legalName) errors.push('legal_name is required (self-attested full legal name)');
    else if (legalName.length > LEGAL_NAME_MAX) errors.push(`legal_name too long (max ${LEGAL_NAME_MAX} characters)`);

    if (!country) errors.push('country is required (self-attested country of residence)');
    else if (country.length > COUNTRY_MAX) errors.push(`country too long (max ${COUNTRY_MAX} characters)`);

    if (!TAX_FORM_TYPES.includes(taxFormType)) {
        errors.push(`tax_form_type must be one of: ${TAX_FORM_TYPES.join(', ')}`);
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, fields: { legal_name: legalName, country, tax_form_type: taxFormType } };
}

// ── Store I/O (0600, tmp+rename) ────────────────────────────────────────────

function loadStore() {
    try { return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8')); }
    catch { return {}; }
}

function saveStore(map) {
    fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    const tmp = IDENTITY_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, IDENTITY_FILE);
    // rename preserves the tmp mode, but harden against a pre-existing file
    // created before this module enforced 0600.
    try { fs.chmodSync(IDENTITY_FILE, 0o600); } catch { /* best effort */ }
}

// ── Crypto ──────────────────────────────────────────────────────────────────

/**
 * Encrypt an identity record for an account. AAD = accountId (binds the row).
 * Throws when the key is invalid — callers must pre-check keyStatus() to
 * refuse cleanly; the throw here is the fail-closed backstop.
 * @returns {{v:1, alg:'aes-256-gcm', iv:string, tag:string, data:string, captured_at:string}}
 */
function encryptIdentity(accountId, fields, wallet) {
    const ks = keyStatus();
    if (!ks.ok) throw new Error(`identity capture refused: ${ks.error}`);
    const capturedAt = new Date().toISOString();
    const plaintext = JSON.stringify({
        legal_name: fields.legal_name,
        country: fields.country,
        tax_form_type: fields.tax_form_type,
        wallet: wallet || null,
        captured_at: capturedAt,
    });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', ks.key, iv);
    cipher.setAAD(Buffer.from(String(accountId), 'utf8'));
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
        v: 1,
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: enc.toString('base64'),
        captured_at: capturedAt, // envelope metadata only — no PII
    };
}

/** Prior record for an account (for compensation), or null. */
function snapshotIdentity(accountId) {
    const store = loadStore();
    return Object.prototype.hasOwnProperty.call(store, accountId) ? store[accountId] : null;
}

/** Persist an encrypted record (overwrites — latest attestation wins). */
function storeIdentity(accountId, encryptedRecord) {
    const store = loadStore();
    store[accountId] = encryptedRecord;
    saveStore(store);
}

/**
 * Compensation: restore the pre-request state after a failed link.
 * prior === null → delete the row this request wrote; otherwise put it back.
 */
function restoreIdentity(accountId, prior) {
    const store = loadStore();
    if (prior === null || prior === undefined) delete store[accountId];
    else store[accountId] = prior;
    saveStore(store);
}

/** True when an (encrypted) identity record exists for the account. */
function hasIdentity(accountId) {
    return snapshotIdentity(accountId) !== null;
}

/**
 * Decrypt an account's identity record. NOT wired to any route — ops shell
 * (future counsel-gated 1099 export) and tests only. Throws on tamper/wrong
 * key/wrong account (GCM auth failure).
 * @returns {object|null} plaintext record, or null when absent
 */
function readIdentity(accountId) {
    const rec = snapshotIdentity(accountId);
    if (!rec) return null;
    const ks = keyStatus();
    if (!ks.ok) throw new Error(`identity read refused: ${ks.error}`);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ks.key, Buffer.from(rec.iv, 'base64'));
    decipher.setAAD(Buffer.from(String(accountId), 'utf8'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'base64'));
    const dec = Buffer.concat([decipher.update(Buffer.from(rec.data, 'base64')), decipher.final()]);
    return JSON.parse(dec.toString('utf8'));
}

/**
 * The machine-readable field contract advertised to clients (step-1 challenge
 * response + 400 IDENTITY_REQUIRED). Contains no data, only the schema.
 */
function identityFieldContract() {
    return {
        identity: {
            legal_name: `string, 1-${LEGAL_NAME_MAX} chars — self-attested full legal name`,
            country: `string, 1-${COUNTRY_MAX} chars — self-attested country of residence`,
            tax_form_type: `one of: ${TAX_FORM_TYPES.join(' | ')}`,
        },
    };
}

module.exports = {
    captureEnabled,
    keyStatus,
    validateIdentityFields,
    encryptIdentity,
    snapshotIdentity,
    storeIdentity,
    restoreIdentity,
    hasIdentity,
    readIdentity,
    identityFieldContract,
    TAX_FORM_TYPES,
    IDENTITY_FILE,
};
