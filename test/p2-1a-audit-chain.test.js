/**
 * test/p2-1a-audit-chain.test.js — Hash-chained audit log tests
 *
 * Covers: B1 consent_version hard assertion (Phase 1),
 *         CORRECTION 1.5 retract ordering (Phase 1),
 *         B7 rotation + in-memory cache (Phase 3),
 *         B19 consent chain integration (Phase 3)
 *
 * Runner: node --test test/p2-1a-audit-chain.test.js
 */

'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Test isolation ──────────────────────────────────────────────────────────
// Route this file's audit + consent writes into a private temp data dir so the
// hash-chain assertions cannot be polluted by sibling test files that run
// concurrently against the shared repo data/ dir. The audit-writer and
// consent-reader both honor AUXILO_DATA_DIR, read at their require() time — so
// this must be set before the require() calls in the before() hook below.
const os = require('os');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-audit-chain-'));
process.env.AUXILO_DATA_DIR = DATA_DIR;
const CONSENT_FILE = path.join(DATA_DIR, 'extraction-consent.jsonl');
const CONSENT_BACKUP = CONSENT_FILE + '.test-backup';

// Back up any existing audit and consent files
let auditBackups = [];
let appendAuditRow, readLastHash, GENESIS_HASH, getAuditFilePath, listAuditFiles,
    verifyAuditChain, resetCache, getCachedHash, computeEntryHash;

function currentAuditFile() {
  return getAuditFilePath(new Date());
}

function cleanAuditFiles() {
  // Remove all audit files created during tests
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.startsWith('audit-extractions.') && f.endsWith('.jsonl'));
    for (const f of files) {
      const full = path.join(DATA_DIR, f);
      // Back up real files
      if (!f.includes('.test-backup')) {
        const backup = full + '.test-backup';
        if (!auditBackups.find(b => b.original === full)) {
          if (fs.existsSync(full)) {
            fs.copyFileSync(full, backup);
            auditBackups.push({ original: full, backup });
          }
        }
        fs.writeFileSync(full, '', 'utf-8');
      }
    }
  } catch {}
  // Also create/clear current month's file
  const cur = currentAuditFile();
  fs.mkdirSync(path.dirname(cur), { recursive: true });
  fs.writeFileSync(cur, '', 'utf-8');
}

before(() => {
  // Back up consent file
  if (fs.existsSync(CONSENT_FILE)) {
    fs.copyFileSync(CONSENT_FILE, CONSENT_BACKUP);
  }
  // Load module
  ({
    appendAuditRow, readLastHash, GENESIS_HASH, getAuditFilePath, listAuditFiles,
    verifyAuditChain, resetCache, getCachedHash, computeEntryHash,
  } = require('../lib/extraction-audit-writer'));
  cleanAuditFiles();
});

after(() => {
  // Restore audit backups
  for (const { original, backup } of auditBackups) {
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, original);
      fs.unlinkSync(backup);
    }
  }
  // Restore consent file
  if (fs.existsSync(CONSENT_BACKUP)) {
    fs.copyFileSync(CONSENT_BACKUP, CONSENT_FILE);
    fs.unlinkSync(CONSENT_BACKUP);
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function makeBaseRow(overrides = {}) {
  return {
    account_id: 'acc_test1',
    consent_version: '2026-04-14',
    action: 'publish',
    source: { type: 'claude-code', session_id: 'sess_test1' },
    transcript_sha256: crypto.randomBytes(32).toString('hex'),
    transcript_length: 5000,
    scrubber_version: 'sensitivity-filter@0.4.0',
    client_scrub_matches: [],
    server_scrub_matches: [],
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    usage: { input_tokens: 500, output_tokens: 200 },
    cost_usd: 0.0045,
    quality_pass_count: 1,
    quality_fail_count: 0,
    published_learning_ids: ['lrn_test1'],
    mode: 'automatic',
    ...overrides,
  };
}

// ── B1: consent_version hard assertion ──────────────────────────────────────

describe('B1: consent_version guard in appendAuditRow', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('appendAuditRow succeeds with valid consent_version for action=publish', async () => {
    const result = await appendAuditRow(makeBaseRow({ action: 'publish', consent_version: '2026-04-14' }));
    assert.ok(result.audit_id, 'must return audit_id');
    assert.ok(result.entry_hash, 'must return entry_hash');
    assert.ok(result.entry_hash.startsWith('sha256:'), 'hash must have sha256: prefix');
  });

  it('appendAuditRow throws when consent_version is null for action=publish', () => {
    assert.throws(
      () => appendAuditRow(makeBaseRow({ action: 'publish', consent_version: null })),
      { message: /consent_version is required for action: publish/ }
    );
  });

  it('appendAuditRow throws when consent_version is undefined for action=publish', () => {
    const row = makeBaseRow({ action: 'publish' });
    delete row.consent_version;
    assert.throws(
      () => appendAuditRow(row),
      { message: /consent_version is required for action: publish/ }
    );
  });

  it('appendAuditRow throws when consent_version is null for action=retract (CORRECTION 1)', () => {
    assert.throws(
      () => appendAuditRow(makeBaseRow({ action: 'retract', consent_version: null })),
      { message: /consent_version is required for action: retract/ }
    );
  });

  it('appendAuditRow throws when consent_version is empty string for action=reject', () => {
    assert.throws(
      () => appendAuditRow(makeBaseRow({ action: 'reject', consent_version: '' })),
      { message: /consent_version is required for action: reject/ }
    );
  });

  it('appendAuditRow does NOT throw when consent_version is null for action=kill_switch_reset', async () => {
    const result = await appendAuditRow(makeBaseRow({
      action: 'kill_switch_reset',
      consent_version: null,
    }));
    assert.ok(result.audit_id, 'must succeed for kill_switch_reset');
  });

  it('appendAuditRow succeeds for action=extract_attempt with consent_version', async () => {
    const result = await appendAuditRow(makeBaseRow({ action: 'extract_attempt' }));
    assert.ok(result.audit_id);
  });
});

describe('Audit chain integrity (Phase 1 initial)', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('publish row stamps consent_version into audit log', async () => {
    await appendAuditRow(makeBaseRow({ consent_version: '2026-04-14' }));
    const auditFile = currentAuditFile();
    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(l => l.trim());
    assert.equal(lines.length, 1);
    const row = JSON.parse(lines[0]);
    assert.equal(row.consent_version, '2026-04-14', 'consent_version must be stamped in audit row');
  });

  it('hash chain links correctly across two rows', async () => {
    await appendAuditRow(makeBaseRow());
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));

    const auditFile = currentAuditFile();
    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(l => l.trim());
    assert.equal(lines.length, 2);

    const row1 = JSON.parse(lines[0]);
    const row2 = JSON.parse(lines[1]);

    assert.equal(row1.prev_hash, GENESIS_HASH, 'first row must link to genesis');
    assert.equal(row2.prev_hash, row1.entry_hash, 'second row must chain from first');
    assert.notEqual(row1.entry_hash, row2.entry_hash, 'each row must have unique hash');
  });

  it('readLastHash returns GENESIS_HASH on empty file', () => {
    resetCache();
    const hash = readLastHash({ forceRead: true });
    assert.equal(hash, GENESIS_HASH);
  });
});

// ── CORRECTION 1.5: Retract handler audit-first/mutate-second ───────────────

describe('CORRECTION 1.5: Retract handler audit-first ordering', () => {
  const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

  it('T-A: appendAuditRow call appears BEFORE safeWrite in retract path', () => {
    const retractAuditIdx = SERVER_SRC.indexOf('CORRECTION 1.5: Audit FIRST, mutate SECOND');
    assert.ok(retractAuditIdx > -1, 'CORRECTION 1.5 comment must exist');
    const retractBlock = SERVER_SRC.slice(retractAuditIdx, retractAuditIdx + 2000);
    const auditPos = retractBlock.indexOf('appendAuditRow({');
    const safeWritePos = retractBlock.indexOf('safeWrite(LEARNINGS_FILE');
    assert.ok(auditPos > -1, 'appendAuditRow must exist in retract path');
    assert.ok(safeWritePos > -1, 'safeWrite must exist in retract path');
    assert.ok(auditPos < safeWritePos,
      `appendAuditRow (offset ${auditPos}) must appear BEFORE safeWrite (offset ${safeWritePos})`);
  });

  it('T-B: audit failure returns 500 with code audit_integrity_error', () => {
    const retractSection = SERVER_SRC.slice(
      SERVER_SRC.indexOf('CORRECTION 1.5: Audit FIRST'),
      SERVER_SRC.indexOf('CORRECTION 1.5: Audit FIRST') + 2000
    );
    assert.ok(retractSection.includes("code: 'audit_integrity_error'"),
      'catch block must return code: audit_integrity_error');
    assert.ok(retractSection.includes('}, 500)'),
      'catch block must return HTTP 500');
    const tryBlock = retractSection.slice(
      retractSection.indexOf('try {'),
      retractSection.indexOf('} catch (auditErr)')
    );
    assert.ok(!tryBlock.includes('safeWrite'),
      'safeWrite must NOT be inside the try block');
    assert.ok(!tryBlock.includes("learning.retracted_at"),
      'catalog mutation must NOT be inside the try block');
    assert.ok(!tryBlock.includes("learning.status = 'retracted'"),
      'catalog status mutation must NOT be inside the try block');
  });

  it('T-C: catalog mutation only runs after catch block (on audit success)', () => {
    const retractSection = SERVER_SRC.slice(
      SERVER_SRC.indexOf('CORRECTION 1.5: Audit FIRST'),
      SERVER_SRC.indexOf('CORRECTION 1.5: Audit FIRST') + 2000
    );
    const catchBlock = retractSection.slice(
      retractSection.indexOf('} catch (auditErr)'),
      retractSection.indexOf('} catch (auditErr)') + 300
    );
    assert.ok(catchBlock.includes('return c.json'),
      'catch block must return early');
    const afterCatch = retractSection.slice(retractSection.indexOf('Audit succeeded'));
    assert.ok(afterCatch, 'must have "Audit succeeded" comment after catch');
    assert.ok(afterCatch.includes("learning.retracted_at"), 'retracted_at must be set after');
    assert.ok(afterCatch.includes("learning.status = 'retracted'"), 'status must be set after');
    assert.ok(afterCatch.includes('safeWrite'), 'safeWrite must be called after');
  });
});

describe('CORRECTION 1.5: appendAuditRow guard prevents silent catalog mutation', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('retract with null consent_version throws synchronously — no audit row written', () => {
    assert.throws(
      () => appendAuditRow(makeBaseRow({ action: 'retract', consent_version: null })),
      { message: /consent_version is required for action: retract/ }
    );
    const content = fs.readFileSync(currentAuditFile(), 'utf-8').trim();
    assert.equal(content, '', 'audit file must be empty');
  });

  it('retract with valid consent_version succeeds — audit row IS written', async () => {
    const result = await appendAuditRow(makeBaseRow({
      action: 'retract',
      consent_version: '2026-04-14',
    }));
    assert.ok(result.audit_id, 'must return audit_id');
    const lines = fs.readFileSync(currentAuditFile(), 'utf-8').split('\n').filter(l => l.trim());
    assert.equal(lines.length, 1, 'exactly one audit row');
    const row = JSON.parse(lines[0]);
    assert.equal(row.action, 'retract');
    assert.equal(row.consent_version, '2026-04-14');
  });

  it('response includes audit_ref on successful retraction (structural)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
    const retractSection = src.slice(
      src.indexOf('Audit succeeded'),
      src.indexOf('Audit succeeded') + 500
    );
    assert.ok(retractSection.includes('audit_ref: auditResult.audit_id'),
      'successful retraction response must include audit_ref');
  });
});

// ── B7: In-memory hash cache ────────────────────────────────────────────────

describe('B7: In-memory cachedLastHash', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('getCachedHash returns null before first read', () => {
    assert.equal(getCachedHash(), null);
  });

  it('readLastHash populates cache from disk on first call', () => {
    assert.equal(getCachedHash(), null);
    const hash = readLastHash();
    assert.equal(hash, GENESIS_HASH);
    assert.equal(getCachedHash(), GENESIS_HASH, 'cache must be populated after first read');
  });

  it('append 10 rows — cachedLastHash updates without disk read after first', async () => {
    // First read populates cache from disk
    readLastHash();
    assert.equal(getCachedHash(), GENESIS_HASH);

    // Append 10 rows
    let lastHash = GENESIS_HASH;
    for (let i = 0; i < 10; i++) {
      const result = await appendAuditRow(makeBaseRow({
        transcript_sha256: crypto.randomBytes(32).toString('hex'),
      }));
      assert.notEqual(getCachedHash(), lastHash, `cache must update on append ${i + 1}`);
      lastHash = getCachedHash();
      assert.equal(lastHash, result.entry_hash,
        `cachedLastHash must equal the last appended entry_hash after append ${i + 1}`);
    }

    // Verify 10 rows in file
    const lines = fs.readFileSync(currentAuditFile(), 'utf-8').split('\n').filter(l => l.trim());
    assert.equal(lines.length, 10, 'must have 10 rows');

    // Verify cache matches the last row
    const lastRow = JSON.parse(lines[9]);
    assert.equal(getCachedHash(), lastRow.entry_hash, 'cache must match last row on disk');
  });

  it('resetCache clears the in-memory hash', () => {
    readLastHash();
    assert.ok(getCachedHash() !== null);
    resetCache();
    assert.equal(getCachedHash(), null);
  });
});

// ── B7: Monthly file rotation ───────────────────────────────────────────────

describe('B7: Monthly file rotation', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('getAuditFilePath returns YYYY-MM format', () => {
    const p = getAuditFilePath(new Date('2026-04-15T12:00:00Z'));
    assert.ok(p.includes('audit-extractions.2026-04.jsonl'), `path must contain YYYY-MM: ${p}`);
  });

  it('getAuditFilePath for different months returns different paths', () => {
    const apr = getAuditFilePath(new Date('2026-04-15T12:00:00Z'));
    const may = getAuditFilePath(new Date('2026-05-01T12:00:00Z'));
    assert.notEqual(apr, may, 'different months must produce different paths');
  });

  it('rollover chain continuation: first row of new file chains from last row of old', async () => {
    // Write a row to the "old" file (simulate previous month)
    const oldDate = new Date('2026-03-15T12:00:00Z');
    const oldFile = getAuditFilePath(oldDate);
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });

    // Write directly to old file to simulate previous month's last row
    const prevRow = {
      audit_id: 'audit_prev_month_test',
      prev_hash: GENESIS_HASH,
      ts: oldDate.toISOString(),
      ...makeBaseRow(),
    };
    prevRow.entry_hash = computeEntryHash(prevRow, GENESIS_HASH);
    fs.writeFileSync(oldFile, JSON.stringify(prevRow) + '\n', 'utf-8');

    // Reset cache to force reading from disk
    resetCache();

    // Now append a new row (goes to current month's file)
    const result = await appendAuditRow(makeBaseRow({
      transcript_sha256: crypto.randomBytes(32).toString('hex'),
    }));

    // Read the current month's file
    const curFile = currentAuditFile();
    const lines = fs.readFileSync(curFile, 'utf-8').split('\n').filter(l => l.trim());
    assert.ok(lines.length >= 1, 'new file must have at least 1 row');

    const newRow = JSON.parse(lines[lines.length - 1]);
    assert.equal(newRow.prev_hash, prevRow.entry_hash,
      'first row of new file must chain from last row of old file');

    // Cleanup old file
    try { fs.unlinkSync(oldFile); } catch {}
  });

  it('listAuditFiles returns all audit files sorted', () => {
    // Create two month files
    const f1 = getAuditFilePath(new Date('2026-03-01'));
    const f2 = getAuditFilePath(new Date('2026-04-01'));
    fs.writeFileSync(f1, '', 'utf-8');
    fs.writeFileSync(f2, '', 'utf-8');

    const files = listAuditFiles();
    assert.ok(files.length >= 2, 'must find at least 2 files');
    // Verify sorted order
    for (let i = 1; i < files.length; i++) {
      assert.ok(files[i] >= files[i - 1], 'files must be sorted chronologically');
    }

    // Cleanup
    try { fs.unlinkSync(f1); } catch {}
  });
});

// ── B7: verifyAuditChain (audit:verify) ─────────────────────────────────────

describe('B7: verifyAuditChain', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
  });

  it('empty audit log reports valid with 0 rows', () => {
    const result = verifyAuditChain();
    assert.equal(result.valid, true);
    assert.equal(result.total, 0);
    assert.equal(result.errors.length, 0);
  });

  it('valid 3-row chain passes verification', async () => {
    await appendAuditRow(makeBaseRow());
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));

    const result = verifyAuditChain();
    assert.equal(result.valid, true, `expected valid, got errors: ${JSON.stringify(result.errors)}`);
    assert.equal(result.total, 3);
  });

  it('detects tampered row (modified one byte in middle of chain)', async () => {
    await appendAuditRow(makeBaseRow());
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));

    // Tamper with the middle row
    const auditFile = currentAuditFile();
    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(l => l.trim());
    const middleRow = JSON.parse(lines[1]);
    middleRow.cost_usd = 999.99; // tamper
    lines[1] = JSON.stringify(middleRow);
    fs.writeFileSync(auditFile, lines.join('\n') + '\n', 'utf-8');

    const result = verifyAuditChain();
    assert.equal(result.valid, false, 'tampered chain must be invalid');
    assert.ok(result.errors.length > 0, 'must report errors');
    assert.ok(result.errors.some(e => e.error.includes('Hash mismatch')),
      'must report hash mismatch');
  });

  it('detects chain break (prev_hash mismatch)', async () => {
    await appendAuditRow(makeBaseRow());
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));

    // Corrupt prev_hash of second row
    const auditFile = currentAuditFile();
    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(l => l.trim());
    const row2 = JSON.parse(lines[1]);
    row2.prev_hash = 'sha256:corrupted_fake_hash';
    lines[1] = JSON.stringify(row2);
    fs.writeFileSync(auditFile, lines.join('\n') + '\n', 'utf-8');

    const result = verifyAuditChain();
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.error.includes('Chain break')),
      'must report chain break');
  });

  it('admin.js contains audit:verify subcommand', () => {
    const adminSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'admin.js'), 'utf-8');
    assert.ok(adminSrc.includes("'audit:verify'"), 'admin.js must have audit:verify command');
    assert.ok(adminSrc.includes('verifyAuditChain'), 'audit:verify must call verifyAuditChain');
  });
});

// ── B19: Consent chain integration ──────────────────────────────────────────

describe('B19: Consent events in audit chain', () => {
  beforeEach(() => {
    cleanAuditFiles();
    resetCache();
    fs.writeFileSync(CONSENT_FILE, '', 'utf-8');
  });

  it('consent_grant action is exempt from consent_version hard assertion', async () => {
    const result = await appendAuditRow(makeBaseRow({
      action: 'consent_grant',
      consent_version: null,
    }));
    assert.ok(result.audit_id, 'consent_grant with null consent_version must succeed');
  });

  it('consent_revoke action is exempt from consent_version hard assertion', async () => {
    const result = await appendAuditRow(makeBaseRow({
      action: 'consent_revoke',
      consent_version: null,
    }));
    assert.ok(result.audit_id, 'consent_revoke with null consent_version must succeed');
  });

  it('consent grant appears in audit chain with correct action', async () => {
    const { appendConsent } = require('../lib/extraction-consent-reader');
    appendConsent({
      accountId: 'acc_consent_test',
      action: 'grant',
      consentVersion: '2026-04-15',
      ipRedacted: '1.2.*.*',
      userAgent: 'test',
    });

    // Wait for async audit write to complete
    await new Promise(r => setTimeout(r, 100));

    const auditFile = currentAuditFile();
    const content = fs.readFileSync(auditFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    assert.ok(lines.length > 0, 'at least one audit row');

    const consentRow = lines.map(l => JSON.parse(l)).find(r => r.action === 'consent_grant');
    assert.ok(consentRow, 'must have a consent_grant row in audit chain');
    assert.equal(consentRow.account_id, 'acc_consent_test');
    assert.equal(consentRow.consent_version, '2026-04-15');
  });

  it('consent revoke appears in audit chain', async () => {
    const { appendConsent } = require('../lib/extraction-consent-reader');
    appendConsent({
      accountId: 'acc_revoke_test',
      action: 'revoke',
      consentVersion: '2026-04-15',
      ipRedacted: '3.4.*.*',
      userAgent: 'test',
    });

    await new Promise(r => setTimeout(r, 100));

    const auditFile = currentAuditFile();
    const content = fs.readFileSync(auditFile, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    const revokeRow = lines.map(l => JSON.parse(l)).find(r => r.action === 'consent_revoke');
    assert.ok(revokeRow, 'must have a consent_revoke row in audit chain');
    assert.equal(revokeRow.account_id, 'acc_revoke_test');
  });

  it('tampering a consent row in chain is detected by verifyAuditChain', async () => {
    const { appendConsent } = require('../lib/extraction-consent-reader');

    // Add a regular row first
    await appendAuditRow(makeBaseRow());

    // Add consent via appendConsent
    appendConsent({
      accountId: 'acc_tamper_test',
      action: 'grant',
      consentVersion: '2026-04-15',
    });
    await new Promise(r => setTimeout(r, 100));

    // Add another regular row
    await appendAuditRow(makeBaseRow({ transcript_sha256: crypto.randomBytes(32).toString('hex') }));

    // Verify chain is valid first
    let result = verifyAuditChain();
    assert.equal(result.valid, true, `chain must be valid before tamper: ${JSON.stringify(result.errors)}`);

    // Tamper the consent row
    const auditFile = currentAuditFile();
    const lines = fs.readFileSync(auditFile, 'utf-8').split('\n').filter(l => l.trim());
    const consentIdx = lines.findIndex(l => l.includes('consent_grant'));
    assert.ok(consentIdx >= 0, 'consent row must exist');

    const consentRow = JSON.parse(lines[consentIdx]);
    consentRow.account_id = 'acc_hacked'; // tamper
    lines[consentIdx] = JSON.stringify(consentRow);
    fs.writeFileSync(auditFile, lines.join('\n') + '\n', 'utf-8');

    // Verify chain is now broken
    result = verifyAuditChain();
    assert.equal(result.valid, false, 'tampered consent row must break the chain');
    assert.ok(result.errors.some(e => e.error.includes('Hash mismatch')),
      'must report hash mismatch on tampered consent row');
  });

  it('consent log file still serves as source of truth for forceReload', () => {
    const { appendConsent, getConsentState } = require('../lib/extraction-consent-reader');
    appendConsent({
      accountId: 'acc_sot_test',
      action: 'grant',
      consentVersion: '2026-04-15',
    });

    const state = getConsentState('acc_sot_test', { forceReload: true });
    assert.ok(state, 'consent state must be readable from consent file');
    assert.equal(state.action, 'grant');
    assert.equal(state.consent_version, '2026-04-15');
  });
});

// ── B19: CONSENT_VERSION_EXEMPT list structural check ───────────────────────

describe('B19: CONSENT_VERSION_EXEMPT list', () => {
  it('consent_grant is in the exempt list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'extraction-audit-writer.js'), 'utf-8');
    assert.ok(src.includes("'consent_grant'"),
      'CONSENT_VERSION_EXEMPT must include consent_grant');
  });

  it('consent_revoke is in the exempt list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'extraction-audit-writer.js'), 'utf-8');
    assert.ok(src.includes("'consent_revoke'"),
      'CONSENT_VERSION_EXEMPT must include consent_revoke');
  });

  it('retract is NOT in the exempt list', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'extraction-audit-writer.js'), 'utf-8');
    const exemptLine = src.split('\n').find(l => l.includes('CONSENT_VERSION_EXEMPT'));
    assert.ok(exemptLine, 'CONSENT_VERSION_EXEMPT must exist');
    assert.ok(!exemptLine.includes("'retract'"),
      'retract must NOT be in CONSENT_VERSION_EXEMPT');
  });
});
