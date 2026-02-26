/**
 * tests/test-sensitivity-filter.js
 *
 * Sensitivity filter unit tests.
 * Validates that the filter catches private keys, API tokens,
 * JWTs, internal IPs, passwords, connection strings, and env secrets.
 *
 * Run: node tests/test-sensitivity-filter.js
 */

'use strict';

const assert = require('assert');
const { scanLearning, getRedactionHint, PATTERNS } = require('../lib/sensitivity-filter.js');

let passed = 0;
let failed = 0;
const failures = [];

function runTest(name, fn) {
  try {
    fn();
    passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.error(`❌ ${name}`);
    console.error(`   ${err.message}`);
  }
}

console.log('=== Sensitivity Filter Tests ===\n');

// ═══════════════════════════════════════════════════════════════════════
// Clean learnings (should pass)
// ═══════════════════════════════════════════════════════════════════════

console.log('--- Clean Learnings (should pass) ---');

runTest('SF-001: Normal learning passes filter', () => {
  const result = scanLearning({
    title: 'Conway exec API nohup causes 30s timeout — use setsid and disown',
    body: 'When using the Conway exec API to start long-running processes, nohup alone causes the exec call to hang. Use setsid to create a new session and disown to detach.',
    task_context: 'Starting a Node.js server on a Conway VM via the exec API.',
    tags: ['conway', 'exec-api', 'nohup', 'setsid'],
  });
  assert.strictEqual(result.clean, true, 'Normal learning should pass');
});

runTest('SF-002: Wallet addresses (42 char) do NOT trigger private key filter', () => {
  const result = scanLearning({
    title: 'Send USDC to wallet address',
    body: 'Send funds to 0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6 for the contributor.',
    task_context: 'Processing payouts.',
    tags: ['wallet', 'usdc'],
  });
  assert.strictEqual(result.clean, true, '42-char wallet address should not trigger filter');
});

runTest('SF-003: Public IPs do NOT trigger internal IP filter', () => {
  const result = scanLearning({
    title: 'DNS resolution issue — use 8.8.8.8',
    body: 'When DNS fails, use Google public DNS 8.8.8.8 or 1.1.1.1 as fallback.',
    task_context: 'Debugging DNS issues.',
    tags: ['dns', 'networking'],
  });
  assert.strictEqual(result.clean, true, 'Public IPs should pass');
});

runTest('SF-004: Short hex strings do NOT trigger', () => {
  const result = scanLearning({
    title: 'Color codes in CSS — use #FF5733',
    body: 'Use hex color codes like 0xFF5733 or #FF5733 for consistent styling.',
    task_context: 'Frontend styling.',
    tags: ['css', 'colors'],
  });
  assert.strictEqual(result.clean, true, 'Short hex strings should pass');
});

// ═══════════════════════════════════════════════════════════════════════
// Sensitive learnings (should block)
// ═══════════════════════════════════════════════════════════════════════

console.log('\n--- Sensitive Learnings (should block) ---');

runTest('SF-010: Private key in body caught', () => {
  const result = scanLearning({
    title: 'Wallet setup issue',
    body: 'Set the private key to 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 in your config.',
    task_context: 'Setting up wallet.',
    tags: ['wallet'],
  });
  assert.strictEqual(result.clean, false, 'Private key should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'private_key'), 'Should identify as private_key');
});

runTest('SF-011: Bearer token in body caught', () => {
  const result = scanLearning({
    title: 'API auth issue workaround',
    body: 'Use the token Bearer eyJhbGciOiJIUzI1NiJ9abcdefghij1234567890 in the Authorization header.',
    task_context: 'Authenticating to API.',
    tags: ['auth', 'api'],
  });
  assert.strictEqual(result.clean, false, 'Bearer token should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'api_token'), 'Should identify as api_token');
});

runTest('SF-012: sk- token caught', () => {
  const result = scanLearning({
    title: 'OpenAI API fallback',
    body: 'When the primary key fails, use sk-proj-abcdefghijklmnop1234567890 as backup.',
    task_context: 'API fallback.',
    tags: ['openai'],
  });
  assert.strictEqual(result.clean, false, 'sk- token should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'api_token'), 'Should identify as api_token');
});

runTest('SF-013: GitHub token caught', () => {
  const result = scanLearning({
    title: 'GitHub API rate limit workaround',
    body: 'Authenticate with ghp_ABCDEFabcdef1234567890abcdef12345678 to increase rate limits.',
    task_context: 'GitHub API.',
    tags: ['github'],
  });
  assert.strictEqual(result.clean, false, 'GitHub token should be caught');
});

runTest('SF-014: Conway API key caught', () => {
  const result = scanLearning({
    title: 'Conway VM exec auth',
    body: 'Set the auth header to cnwy_k__HYcupmK8d9f2jN7xAbcDefGhiJklMnO for Conway API access.',
    task_context: 'Conway API calls.',
    tags: ['conway'],
  });
  assert.strictEqual(result.clean, false, 'Conway API key should be caught');
});

runTest('SF-015: JWT in body caught', () => {
  const result = scanLearning({
    title: 'Session handling issue',
    body: 'The session token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0 was expired.',
    task_context: 'Session management.',
    tags: ['jwt', 'session'],
  });
  assert.strictEqual(result.clean, false, 'JWT should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'jwt_token'), 'Should identify as jwt_token');
});

runTest('SF-016: Internal IP (10.x.x.x) caught', () => {
  const result = scanLearning({
    title: 'Service discovery on internal network',
    body: 'The service runs on 10.0.1.55 port 8080. Connect via internal DNS or direct IP.',
    task_context: 'Internal service setup.',
    tags: ['networking'],
  });
  assert.strictEqual(result.clean, false, 'Internal IP should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'internal_ip'), 'Should identify as internal_ip');
});

runTest('SF-017: Internal IP (192.168.x.x) caught', () => {
  const result = scanLearning({
    title: 'Dev server setup',
    body: 'Access the dev server at 192.168.1.100:3000 for local testing.',
    task_context: 'Local dev.',
    tags: ['networking'],
  });
  assert.strictEqual(result.clean, false, '192.168 IP should be caught');
});

runTest('SF-018: Internal IP (172.16-31.x.x) caught', () => {
  const result = scanLearning({
    title: 'Docker network issue',
    body: 'The container is on 172.17.0.2 and cannot reach the host.',
    task_context: 'Docker networking.',
    tags: ['docker'],
  });
  assert.strictEqual(result.clean, false, '172.17 IP should be caught');
});

runTest('SF-019: Password in plaintext caught', () => {
  const result = scanLearning({
    title: 'Database connection issue',
    body: 'Set password=MyS3cur3P@ss! in the connection config to authenticate.',
    task_context: 'Database setup.',
    tags: ['database'],
  });
  assert.strictEqual(result.clean, false, 'Password should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'password_pair'), 'Should identify as password_pair');
});

runTest('SF-020: MongoDB connection string caught', () => {
  const result = scanLearning({
    title: 'MongoDB timeout fix',
    body: 'Connect with mongodb://admin:secretpass@cluster0.mongodb.net/mydb to fix timeout.',
    task_context: 'MongoDB.',
    tags: ['mongodb'],
  });
  assert.strictEqual(result.clean, false, 'Connection string should be caught');
  assert.ok(result.matches.some(m => m.pattern === 'connection_string'), 'Should identify as connection_string');
});

runTest('SF-021: Postgres connection string caught', () => {
  const result = scanLearning({
    title: 'Postgres SSL issue',
    body: 'Use postgres://user:password123@db.example.com:5432/app with sslmode=require.',
    task_context: 'Postgres.',
    tags: ['postgres'],
  });
  assert.strictEqual(result.clean, false, 'Postgres connection string should be caught');
});

runTest('SF-022: Env var with secret caught', () => {
  const result = scanLearning({
    title: 'Environment config issue',
    body: 'Set OPENAI_API_KEY=sk-proj1234567890abcdefghijklmnopqrst in your .env file.',
    task_context: 'Environment setup.',
    tags: ['env', 'config'],
  });
  assert.strictEqual(result.clean, false, 'Env secret should be caught');
});

runTest('SF-023: AKIA (AWS access key) caught', () => {
  const result = scanLearning({
    title: 'S3 upload fix',
    body: 'Use AKIAIOSFODNN7EXAMPLE as the access key ID for S3.',
    task_context: 'AWS S3.',
    tags: ['aws', 's3'],
  });
  assert.strictEqual(result.clean, false, 'AKIA token should be caught');
});

// ═══════════════════════════════════════════════════════════════════════
// Sensitive data in different fields
// ═══════════════════════════════════════════════════════════════════════

console.log('\n--- Field-specific detection ---');

runTest('SF-030: Sensitive data in title caught', () => {
  const result = scanLearning({
    title: 'Fix for sk-abcdefghij1234567890 key rotation',
    body: 'When the key rotates, update the config.',
    task_context: 'Key rotation.',
    tags: ['auth'],
  });
  assert.strictEqual(result.clean, false, 'Should catch secret in title');
  assert.ok(result.matches.some(m => m.field === 'title'), 'Should flag title field');
});

runTest('SF-031: Sensitive data in task_context caught', () => {
  const result = scanLearning({
    title: 'Database migration issue',
    body: 'Run the migration script to update the schema.',
    task_context: 'Connecting to postgres://admin:hunter2@prod-db.internal:5432/app',
    tags: ['database'],
  });
  assert.strictEqual(result.clean, false, 'Should catch secret in task_context');
  assert.ok(result.matches.some(m => m.field === 'task_context'), 'Should flag task_context field');
});

runTest('SF-032: Sensitive data in tags caught', () => {
  const result = scanLearning({
    title: 'Network routing fix',
    body: 'Update the routing table for the subnet.',
    task_context: 'Network config.',
    tags: ['networking', '192.168.1.0', 'subnet'],
  });
  assert.strictEqual(result.clean, false, 'Should catch secret in tags');
  assert.ok(result.matches.some(m => m.field === 'tags'), 'Should flag tags field');
});

// ═══════════════════════════════════════════════════════════════════════
// Redaction hints
// ═══════════════════════════════════════════════════════════════════════

console.log('\n--- Redaction hints ---');

runTest('SF-040: Redaction hints exist for all pattern types', () => {
  for (const pattern of PATTERNS) {
    const hint = getRedactionHint(pattern.name);
    assert.ok(hint, `Should have redaction hint for ${pattern.name}`);
    assert.ok(hint.includes('{'), `Hint for ${pattern.name} should contain placeholder`);
  }
});

runTest('SF-041: Match values are redacted in output', () => {
  const result = scanLearning({
    title: 'Key issue',
    body: 'Use sk-proj-abcdefghijklmnop1234567890abcdef to authenticate.',
    task_context: 'Auth.',
    tags: ['auth'],
  });
  assert.strictEqual(result.clean, false);
  // The matched value should be redacted (not show the full token)
  for (const match of result.matches) {
    assert.ok(match.match.includes('...'), `Match should be redacted: ${match.match}`);
    assert.ok(match.match.length < 30, 'Redacted match should be short');
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Edge cases
// ═══════════════════════════════════════════════════════════════════════

console.log('\n--- Edge cases ---');

runTest('SF-050: Empty fields do not crash', () => {
  const result = scanLearning({
    title: '',
    body: '',
    task_context: '',
    tags: [],
  });
  assert.strictEqual(result.clean, true, 'Empty learning should pass');
});

runTest('SF-051: Missing fields do not crash', () => {
  const result = scanLearning({});
  assert.strictEqual(result.clean, true, 'Missing fields should not crash');
});

runTest('SF-052: Multiple sensitive patterns in one learning', () => {
  const result = scanLearning({
    title: 'Full config setup',
    body: 'Set password=admin123 and connect to postgres://user:pass@192.168.1.50:5432/db with Bearer sk-abcdefghijklmnop12345678 header.',
    task_context: 'Full setup.',
    tags: ['config'],
  });
  assert.strictEqual(result.clean, false);
  // Should catch at least 3 patterns
  const patternNames = new Set(result.matches.map(m => m.pattern));
  assert.ok(patternNames.size >= 3, `Should catch multiple patterns, got: ${[...patternNames].join(', ')}`);
});

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(60)}`);
console.log(`Sensitivity Filter: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  ❌ ${f.name}: ${f.error}`);
  }
}
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
