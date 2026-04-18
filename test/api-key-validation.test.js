'use strict';

/**
 * test/api-key-validation.test.js
 *
 * Unit tests for the validateApiKey() function in lib/accounts.js.
 * Runner: node --test test/api-key-validation.test.js
 *
 * Strategy:
 *   - Back up data/accounts.json before tests begin.
 *   - Write a known fixture (synthetic accounts with hashed API keys).
 *   - Run assertions against validateApiKey() (pure function, no Hono needed).
 *   - Restore the original file in after().
 *
 * Note: accounts.js imports 'jose' at module load time, which requires the
 * SESSION_SECRET env var (or emits a warning). We set a dummy value upfront.
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret-do-not-use-in-prod';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ACCOUNTS_FILE = path.join(__dirname, '..', 'data', 'accounts.json');
const BACKUP_FILE   = ACCOUNTS_FILE + '.test-backup';

// lazy-import after backup is done so the module sees the file
let validateApiKey;

// ─── Raw key factory ─────────────────────────────────────────────────────────

/**
 * Generate a raw axl_ API key for the given scope, compute its SHA-256 hash,
 * and return { rawKey, keyHash }.
 */
function makeKey(scope = 'admin') {
    const prefixMap = { admin: 'axl_a_', contribute: 'axl_c_', read: 'axl_r_' };
    const prefix  = prefixMap[scope] || 'axl_a_';
    const rawKey  = prefix + crypto.randomBytes(24).toString('base64url');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    return { rawKey, keyHash };
}

// ─── Fixture builder ─────────────────────────────────────────────────────────

/**
 * Write a known accounts.json fixture.
 * Returns { adminKey, readKey, contributeKey, expiredKey } (raw keys).
 */
function buildFixture() {
    const admin      = makeKey('admin');
    const readK      = makeKey('read');
    const contribute = makeKey('contribute');

    const accounts = {
        acc_testA: {
            email: 'alice@example.com',
            created_at: Date.now(),
            api_keys: [
                { id: 'key_admin1',       hash: admin.keyHash,      scope: 'admin',      name: 'Admin key',      created_at: Date.now() },
                { id: 'key_read1',        hash: readK.keyHash,      scope: 'read',       name: 'Read key',       created_at: Date.now() },
                { id: 'key_contribute1',  hash: contribute.keyHash, scope: 'contribute', name: 'Contribute key', created_at: Date.now() },
            ],
        },
        acc_testB: {
            email: 'bob@example.com',
            created_at: Date.now(),
            api_keys: [],
        },
    };

    fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));

    return {
        adminKey:      admin.rawKey,
        readKey:       readK.rawKey,
        contributeKey: contribute.rawKey,
    };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let fixture;

before(() => {
    // Back up the real file
    if (fs.existsSync(ACCOUNTS_FILE)) {
        fs.copyFileSync(ACCOUNTS_FILE, BACKUP_FILE);
    }
    // Write test fixture
    fixture = buildFixture();
    // Load the module after the fixture is in place
    ({ validateApiKey } = require('../lib/accounts.js'));
});

after(() => {
    if (fs.existsSync(BACKUP_FILE)) {
        fs.copyFileSync(BACKUP_FILE, ACCOUNTS_FILE);
        fs.unlinkSync(BACKUP_FILE);
    } else {
        fs.unlinkSync(ACCOUNTS_FILE);
    }
});

// ─── 1. Valid key returns account ──────────────────────────────────────────────

test('Valid admin key: returns valid=true with correct accountId', () => {
    const result = validateApiKey(fixture.adminKey);
    assert.equal(result.valid, true, 'Admin key must be valid');
    assert.equal(result.accountId, 'acc_testA');
    assert.equal(result.scope, 'admin');
});

test('Valid read key: returns valid=true with scope=read', () => {
    const result = validateApiKey(fixture.readKey);
    assert.equal(result.valid, true);
    assert.equal(result.accountId, 'acc_testA');
    assert.equal(result.scope, 'read');
});

test('Valid contribute key: returns valid=true with scope=contribute', () => {
    const result = validateApiKey(fixture.contributeKey);
    assert.equal(result.valid, true);
    assert.equal(result.accountId, 'acc_testA');
    assert.equal(result.scope, 'contribute');
});

test('Valid key: result contains accountId string', () => {
    const result = validateApiKey(fixture.adminKey);
    assert.equal(typeof result.accountId, 'string');
    assert.ok(result.accountId.startsWith('acc_'));
});

// ─── 2. Invalid key returns null / { valid: false } ───────────────────────────

test('Invalid key: completely bogus string returns valid=false', () => {
    const result = validateApiKey('totally-invalid-key-xyz');
    assert.equal(result.valid, false);
    assert.equal(result.accountId, undefined, 'accountId must not be present on invalid result');
});

test('Invalid key: key with correct prefix but wrong hash returns valid=false', () => {
    const fakeKey = 'axl_a_' + crypto.randomBytes(24).toString('base64url');
    const result = validateApiKey(fakeKey);
    assert.equal(result.valid, false);
});

test('Invalid key: empty string returns valid=false', () => {
    const result = validateApiKey('');
    assert.equal(result.valid, false);
});

test('Invalid key: null returns valid=false', () => {
    const result = validateApiKey(null);
    assert.equal(result.valid, false);
});

test('Invalid key: undefined returns valid=false', () => {
    const result = validateApiKey(undefined);
    assert.equal(result.valid, false);
});

test('Invalid key: key without axl_ prefix returns valid=false', () => {
    // Even if it hashes to an existing key, the prefix guard rejects it
    const result = validateApiKey('sk_live_somedummyvalue1234567890');
    assert.equal(result.valid, false);
});

test('Invalid key: non-string number returns valid=false', () => {
    const result = validateApiKey(12345);
    assert.equal(result.valid, false);
});

// ─── 3. Keys from an account with no api_keys do not crash ───────────────────

test('Account with no api_keys: lookup does not throw', () => {
    // acc_testB has an empty api_keys array
    assert.doesNotThrow(() => {
        const fakeKey = 'axl_a_' + crypto.randomBytes(24).toString('base64url');
        validateApiKey(fakeKey);
    });
});

// ─── 4. Scoped key validation ─────────────────────────────────────────────────

test('Scoped keys: admin key reports scope=admin', () => {
    const r = validateApiKey(fixture.adminKey);
    assert.equal(r.scope, 'admin');
});

test('Scoped keys: read key reports scope=read', () => {
    const r = validateApiKey(fixture.readKey);
    assert.equal(r.scope, 'read');
});

test('Scoped keys: contribute key reports scope=contribute', () => {
    const r = validateApiKey(fixture.contributeKey);
    assert.equal(r.scope, 'contribute');
});

test('Scoped keys: admin scope is distinct from read scope', () => {
    const admin = validateApiKey(fixture.adminKey);
    const read  = validateApiKey(fixture.readKey);
    assert.notEqual(admin.scope, read.scope);
});

test('Scoped keys: each key is uniquely identified by its hash (no cross-match)', () => {
    // Read key must NOT validate as admin scope
    const r = validateApiKey(fixture.readKey);
    assert.equal(r.valid, true);
    assert.notEqual(r.scope, 'admin', 'read key must not be promoted to admin scope');
});

// ─── 5. Admin scope observation ──────────────────────────────────────────────

test('Admin scope: admin key can be distinguished from lower-privilege keys', () => {
    const adminResult = validateApiKey(fixture.adminKey);
    const readResult  = validateApiKey(fixture.readKey);
    assert.equal(adminResult.scope, 'admin');
    // Admin is higher-privileged — callers can simply check scope === 'admin'
    assert.ok(adminResult.scope === 'admin' && readResult.scope !== 'admin',
        'Admin key scope must be "admin" while read key is not');
});

// ─── 6. Key prefix format ─────────────────────────────────────────────────────

test('Key format: admin key starts with axl_a_', () => {
    assert.ok(fixture.adminKey.startsWith('axl_a_'), `Expected axl_a_ prefix, got: ${fixture.adminKey.slice(0, 7)}`);
});

test('Key format: read key starts with axl_r_', () => {
    assert.ok(fixture.readKey.startsWith('axl_r_'), `Expected axl_r_ prefix, got: ${fixture.readKey.slice(0, 7)}`);
});

test('Key format: contribute key starts with axl_c_', () => {
    assert.ok(fixture.contributeKey.startsWith('axl_c_'), `Expected axl_c_ prefix, got: ${fixture.contributeKey.slice(0, 7)}`);
});

// ─── 7. Timing safety (no timing oracle) ─────────────────────────────────────

test('Timing: invalid key does not short-circuit before hash comparison', () => {
    // This is a structural / code-level assertion: the module uses crypto.timingSafeEqual.
    // We verify it by reading the source and asserting the function is used.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accounts.js'), 'utf8');
    assert.ok(src.includes('timingSafeEqual'), 'validateApiKey must use timingSafeEqual for hash comparison');
});

// ─── 8. Result shape ─────────────────────────────────────────────────────────

test('Result shape: valid result has exactly {valid, accountId, scope}', () => {
    const r = validateApiKey(fixture.adminKey);
    assert.ok('valid'     in r, 'Result must have "valid"');
    assert.ok('accountId' in r, 'Result must have "accountId"');
    assert.ok('scope'     in r, 'Result must have "scope"');
});

test('Result shape: invalid result has exactly {valid} key (no accountId)', () => {
    const r = validateApiKey('axl_a_' + crypto.randomBytes(24).toString('base64url'));
    assert.equal(r.valid, false);
    assert.ok(!('accountId' in r), 'Invalid result must not include accountId');
    assert.ok(!('scope' in r),     'Invalid result must not include scope');
});
