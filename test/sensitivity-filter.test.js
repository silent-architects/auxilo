'use strict';

/**
 * test/sensitivity-filter.test.js
 * Runner: node --test test/sensitivity-filter.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanLearning, getRedactionHint, PATTERNS } = require('../lib/sensitivity-filter.js');

function learning(overrides = {}) {
    return { title: '', body: '', task_context: '', tags: [], ...overrides };
}

// ─── 1. Clean content passes ─────────────────────────────────────────────────

test('Clean: normal learning with no secrets passes', () => {
    const r = scanLearning(learning({
        title: 'nohup causes 30-second timeout — use setsid and disown',
        body:  'Use setsid to start a new session and disown to detach the process.',
        tags:  ['exec-api', 'setsid'],
    }));
    assert.equal(r.clean, true);
    assert.equal(Object.keys(r).length, 1, 'Clean result must only have "clean" key');
});

test('Clean: public DNS IPs (8.8.8.8, 1.1.1.1) do NOT trigger internal_ip', () => {
    const r = scanLearning(learning({ body: 'Use Google DNS 8.8.8.8 or 1.1.1.1 as fallback.' }));
    assert.equal(r.clean, true, 'Public IPs must not be flagged');
});

test('Clean: 42-char wallet address does NOT trigger private_key', () => {
    const r = scanLearning(learning({ body: 'Send to 0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6.' }));
    assert.equal(r.clean, true, '42-char wallet address must not be flagged');
});

test('Clean: password=null is NOT flagged (M-4 negative lookahead)', () => {
    const r = scanLearning(learning({ body: 'Config shows password=null when unset.' }));
    assert.equal(r.clean, true);
});

test('Clean: password=undefined is NOT flagged (M-4)', () => {
    const r = scanLearning(learning({ body: 'Parser returns password=undefined for optional fields.' }));
    assert.equal(r.clean, true);
});

test('Clean: password=<placeholder> is NOT flagged (M-4)', () => {
    const r = scanLearning(learning({ body: 'Template: password=<your_password_here>' }));
    assert.equal(r.clean, true);
});

test('Clean: empty learning does not crash', () => {
    const r = scanLearning(learning());
    assert.equal(r.clean, true);
});

test('Clean: completely missing fields object does not crash', () => {
    const r = scanLearning({});
    assert.equal(r.clean, true);
});

test('Clean: tags:null does not throw', () => {
    assert.doesNotThrow(() => scanLearning(learning({ tags: null })));
});

// ─── 2. API key detection ────────────────────────────────────────────────────

test('API keys: AWS AKIA access key ID detected', () => {
    const r = scanLearning(learning({
        body: 'Use AKIAIOSFODNN7EXAMPLE as the access key ID.',
        tags: ['aws', 's3'],
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'api_token'), 'AKIA→api_token');
});

test('API keys: sk- (Anthropic/OpenAI style) token detected', () => {
    const r = scanLearning(learning({ body: 'Use sk-proj-abcdefghijklmnop1234567890 as backup.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'api_token'));
});

test('API keys: GitHub ghp_ token detected', () => {
    const r = scanLearning(learning({ body: 'Authenticate with ghp_ABCDEFabcdef1234567890abcdef12345678.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'api_token'));
});

test('API keys: Bearer token in string detected', () => {
    const r = scanLearning(learning({ body: 'Set header: Bearer eyJhbGciOiJIUzI1NiJ9abcdefghij1234.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'api_token'));
});

test('API keys: Stripe sk_live_ key detected as stripe_key', () => {
    const r = scanLearning(learning({
        body: 'Use sk_live_abcdefghij1234567890abcdefghij for live payments.',
        tags: ['stripe'],
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'stripe_key'));
});

test('API keys: Stripe sk_test_ key detected as stripe_key', () => {
    const r = scanLearning(learning({ body: 'Test key: sk_test_abcdefghij1234567890abcdef.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'stripe_key'));
});

test('API keys: Stripe pk_live_ publishable key detected as stripe_key', () => {
    const r = scanLearning(learning({ body: 'Pass pk_live_abcdefghij1234567890abcdefghij to Stripe.js.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'stripe_key'));
});

test('API keys: Google AIza API key detected', () => {
    const r = scanLearning(learning({ body: 'Init with AIzaSyAbcdefghijklmnopqrstuvwxyz12345678.', tags: ['google'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'google_api_key'));
});

test('API keys: Slack xoxb- bot token detected', () => {
    const r = scanLearning(learning({ body: 'Bot token: xoxb-12345678901-12345678901-abcdefghijklmnop.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'slack_token'));
});

test('API keys: Slack xoxp- user token detected', () => {
    const r = scanLearning(learning({ body: 'User token xoxp-12345678901-12345678901-abcdefghijklmnop.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'slack_token'));
});

test('API keys: npm access token detected', () => {
    const r = scanLearning(learning({ body: 'Set NPM_TOKEN=npm_AbcdefghijklmnopQrstuvwxyz12345678Ab.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'npm_token'));
});

// ─── 3. Email addresses ───────────────────────────────────────────────────────
// P2.1a: email detection pattern added — email addresses MUST be flagged.

test('Emails: a plain email address triggers email_address pattern (P2.1a)', () => {
    const r = scanLearning(learning({
        title: 'User account setup',
        body:  'Send confirmation to user@example.com after creating the account.',
    }));
    assert.equal(r.clean, false, 'Email addresses must be flagged (P2.1a)');
    assert.ok(r.matches.some(m => m.pattern === 'email_address'), 'Must match email_address pattern');
});

// ─── 4. IP address detection ─────────────────────────────────────────────────

test('IPs: 10.x.x.x range detected as internal_ip', () => {
    const r = scanLearning(learning({ body: 'Service runs on 10.0.1.55 port 8080.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'internal_ip'));
});

test('IPs: 192.168.x.x range detected as internal_ip', () => {
    const r = scanLearning(learning({ body: 'Dev server at 192.168.1.100:3000.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'internal_ip'));
});

test('IPs: 172.17.x.x Docker range detected as internal_ip', () => {
    const r = scanLearning(learning({ body: 'Container on 172.17.0.2 cannot reach the host.', tags: ['docker'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'internal_ip'));
});

test('IPs: 172.16.x.x is detected as internal_ip', () => {
    const r = scanLearning(learning({ body: '172.16.0.5 is the VPN gateway.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'internal_ip'));
});

test('IPs: 172.32.x.x (outside RFC-1918) does NOT trigger internal_ip', () => {
    const r = scanLearning(learning({ body: 'Server is at 172.32.10.5.' }));
    assert.equal(r.clean, true, '172.32 is not in the private range');
});

// ─── 5. Password patterns ─────────────────────────────────────────────────────

test('Passwords: password=<value> in plaintext detected', () => {
    const r = scanLearning(learning({ body: 'Set password=MyS3cur3P@ss! in connection config.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'password_pair'));
});

test('Passwords: PASSWORD: value (case-insensitive) detected', () => {
    const r = scanLearning(learning({ body: 'Log shows PASSWORD:hunter2 in plaintext.' }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'password_pair'));
});

test('Passwords: password=*** suppressed placeholder does NOT trigger', () => {
    const r = scanLearning(learning({ body: 'Config shows password=*** for redacted fields.' }));
    assert.equal(r.clean, true, 'password=*** must not trigger');
});

// ─── 6. Private key detection ─────────────────────────────────────────────────

test('Private keys: 64-char hex blockchain private key detected', () => {
    const r = scanLearning(learning({
        body: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 is the key.',
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'private_key'));
});

test('Private keys: SSH RSA PEM header detected as ssh_private_key', () => {
    const r = scanLearning(learning({ body: 'Key: -----BEGIN RSA PRIVATE KEY-----', tags: ['ssh'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'ssh_private_key'));
});

test('Private keys: SSH OPENSSH PEM header detected as ssh_private_key', () => {
    const r = scanLearning(learning({ body: '-----BEGIN OPENSSH PRIVATE KEY-----', tags: ['openssh'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'ssh_private_key'));
});

test('Private keys: PEM CERTIFICATE block detected as pem_block', () => {
    const r = scanLearning(learning({ body: 'Paste -----BEGIN CERTIFICATE----- into cert.pem.', tags: ['tls'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'pem_block'));
});

test('Private keys: PEM PUBLIC KEY block detected as pem_block', () => {
    const r = scanLearning(learning({ body: 'Header: -----BEGIN PUBLIC KEY-----', tags: ['rsa'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'pem_block'));
});

// ─── 7. JWT detection ─────────────────────────────────────────────────────────

test('JWT: eyJ.eyJ token detected as jwt_token', () => {
    const r = scanLearning(learning({
        body: 'Session: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 expired.',
        tags: ['jwt'],
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'jwt_token'));
});

// ─── 8. Connection strings ────────────────────────────────────────────────────

test('Connection strings: MongoDB URI with credentials detected', () => {
    const r = scanLearning(learning({ body: 'Connect: mongodb://admin:secretpass@cluster0.mongodb.net/mydb.', tags: ['mongodb'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'connection_string'));
});

test('Connection strings: Postgres URI with credentials detected', () => {
    const r = scanLearning(learning({ body: 'Use postgres://user:password123@db.example.com:5432/app.', tags: ['postgres'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.pattern === 'connection_string'));
});

// ─── 9. Multi-field detection ─────────────────────────────────────────────────

test('Multi-field: sensitive data in title is caught', () => {
    const r = scanLearning(learning({
        title: 'Fix for sk-abcdefghijklmnop1234567890 key rotation',
        body:  'When the key rotates, update the config.',
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.field === 'title'), 'title field must be flagged');
});

test('Multi-field: sensitive data in task_context is caught', () => {
    const r = scanLearning(learning({
        task_context: 'postgres://admin:hunter2@prod-db.internal:5432/app',
    }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.field === 'task_context'));
});

test('Multi-field: sensitive data in tags is caught', () => {
    const r = scanLearning(learning({ tags: ['networking', '192.168.1.0', 'subnet'] }));
    assert.equal(r.clean, false);
    assert.ok(r.matches.some(m => m.field === 'tags'));
});

test('Multi-field: multiple sensitive patterns produce multiple match entries', () => {
    const r = scanLearning(learning({
        body: 'Connect to postgres://user:pass@192.168.1.50:5432/db with Bearer sk-abcdefghijklmnop12345678.',
    }));
    assert.equal(r.clean, false);
    const patternNames = new Set(r.matches.map(m => m.pattern));
    assert.ok(patternNames.size >= 2, `Expected ≥2 patterns, got: ${[...patternNames].join(', ')}`);
});

// ─── 10. Match details structure ──────────────────────────────────────────────

test('Match details: each match has pattern, field, match, description string fields', () => {
    const r = scanLearning(learning({
        body: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 is the key.',
    }));
    assert.equal(r.clean, false);
    for (const m of r.matches) {
        assert.equal(typeof m.pattern,     'string', 'match.pattern must be string');
        assert.equal(typeof m.field,       'string', 'match.field must be string');
        assert.equal(typeof m.match,       'string', 'match.match must be string');
        assert.equal(typeof m.description, 'string', 'match.description must be string');
    }
});

test('Match details: matched value is redacted (contains ***)', () => {
    const r = scanLearning(learning({ body: 'Use sk-proj-abcdefghijklmnop1234567890abcdef to auth.' }));
    assert.equal(r.clean, false);
    for (const m of r.matches) {
        assert.ok(m.match.includes('***'), `"${m.match}" must be redacted with ***`);
    }
});

test('Match details: redacted value shows 3 prefix chars + *** + 2 suffix chars for long tokens', () => {
    const r = scanLearning(learning({ body: 'Use sk-proj-abcdefghijklmnop1234567890abcdef to auth.' }));
    assert.equal(r.clean, false);
    for (const m of r.matches) {
        const starIdx = m.match.indexOf('***');
        if (starIdx !== -1) {
            assert.equal(starIdx, 3, `Prefix should be 3 chars in "${m.match}"`);
            const suffix = m.match.substring(starIdx + 3);
            assert.equal(suffix.length, 2, `Suffix should be 2 chars in "${m.match}"`);
        }
    }
});

// ─── 11. Redaction hints ─────────────────────────────────────────────────────

test('getRedactionHint: returns a { placeholder for every known pattern', () => {
    for (const p of PATTERNS) {
        const hint = getRedactionHint(p.name);
        assert.ok(hint, `Must have hint for ${p.name}`);
        assert.ok(hint.includes('{'), `Hint for ${p.name} must contain {`);
    }
});

test('getRedactionHint: unknown pattern returns {REDACTED}', () => {
    assert.equal(getRedactionHint('nonexistent_xyz'), '{REDACTED}');
});

// ─── 12. Performance ─────────────────────────────────────────────────────────

test('Performance: 10 KB body scanned in < 200ms', () => {
    const body = 'A safe, clean word that repeats. '.repeat(300);
    const start = Date.now();
    scanLearning(learning({ title: 'Large', body, tags: [] }));
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 200, `Scan took ${elapsed}ms — must be < 200ms`);
});
