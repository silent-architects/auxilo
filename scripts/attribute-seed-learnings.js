#!/usr/bin/env node
'use strict';
/*
 * scripts/attribute-seed-learnings.js — attach legacy platform-wallet rows to
 * the first-class platform account without changing their wallet provenance.
 *
 * DRY-RUN by default. A write requires both the Tyler-ruled account id and an
 * exact whole-store match count:
 *
 *   node /tmp/attribute-seed-learnings.js --account acc_platform --expect N
 *   node /tmp/attribute-seed-learnings.js --account acc_platform --expect N --apply
 *
 * On --apply, both input stores are backed up before either is changed. JSON
 * stores are replaced atomically with a sibling .tmp + rename. Restart the
 * machine after a successful apply so the server reloads learnings.json.
 */
const fs = require('fs');
const path = require('path');

const APP = process.env.APP_DIR || '/app';
const LEARNINGS = path.join(APP, 'data/learnings.json');
const ACCOUNTS = path.join(APP, 'data/accounts.json');
const BACKUP_DIR = path.join(APP, 'data/backups');
// Must stay byte-equivalent (case-insensitively) to server.js
// LEGACY_PLATFORM_WALLETS[0], the historical provenance identity.
const LEGACY_PLATFORM_WALLET = '0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6'.toLowerCase();
const REQUIRED_ACCOUNT_ID = 'acc_platform';
const PLATFORM_ACCOUNT = {
  email: 'platform@auxilo.io',
  created_at: null,
  api_keys: [],
  platform: true,
  note: 'First-class platform identity for the platform-wallet-origin learnings published with no account attached (SEED-ATTR, Tyler-ruled 2026-09-02)',
};

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  let apply = false;
  let account = null;
  let expectRaw = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--account') {
      account = argv[++i];
      if (!account || account.startsWith('--')) fail('--account requires a value');
    } else if (arg === '--expect') {
      expectRaw = argv[++i];
      if (expectRaw === undefined || expectRaw.startsWith('--')) fail('--expect requires a value');
    } else {
      fail(`unknown argument: ${arg}`);
    }
  }

  if (!account) fail('usage: node attribute-seed-learnings.js --account acc_platform --expect N [--apply]');
  if (account !== REQUIRED_ACCOUNT_ID) {
    fail(`--account must be ${REQUIRED_ACCOUNT_ID}; received ${account}`);
  }
  if (expectRaw === null || !/^\d+$/.test(expectRaw)) {
    fail('--expect must be a non-negative integer');
  }
  const expected = Number(expectRaw);
  if (!Number.isSafeInteger(expected)) fail('--expect exceeds the safe integer range');

  return { apply, account, expected };
}

function readJson(file, label) {
  if (!fs.existsSync(file)) fail(`${label} not found: ${file} (set APP_DIR if not running on the box)`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function matchesSeedRow(learning) {
  return Boolean(
    learning &&
    !learning.contributor_account_id &&
    typeof learning.contributor_wallet === 'string' &&
    learning.contributor_wallet.toLowerCase() === LEGACY_PLATFORM_WALLET
  );
}

// Mirrors server.js visibleCatalog so the report distinguishes the public
// population from non-visible legacy rows without changing selection scope.
function isVisible(learning) {
  if (!learning || learning.visibility === 'private') return false;
  if (process.env.CONTENT_MODERATION_ENABLED !== 'false') {
    return !learning.status || learning.status === 'approved';
  }
  return !(
    learning.status === 'pending_review' &&
    Array.isArray(learning.platform_hold_reasons) &&
    learning.platform_hold_reasons.length > 0
  );
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupBothStores(ts) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const learningBackup = path.join(BACKUP_DIR, `learnings-pre-seed-attr-${ts}.json`);
  const accountBackup = path.join(BACKUP_DIR, `accounts-pre-seed-attr-${ts}.json`);
  fs.copyFileSync(LEARNINGS, learningBackup);
  fs.copyFileSync(ACCOUNTS, accountBackup);
  console.log(`backup written: ${learningBackup}`);
  console.log(`backup written: ${accountBackup}`);
}

function atomicWriteJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const { apply, account, expected } = parseArgs(process.argv.slice(2));
const learnings = readJson(LEARNINGS, 'data/learnings.json');
const accounts = readJson(ACCOUNTS, 'data/accounts.json');

if (!Array.isArray(learnings)) fail('data/learnings.json is not a JSON array; refusing to touch it');
if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
  fail('data/accounts.json is not a JSON object; refusing to touch it');
}

const matched = learnings.filter(matchesSeedRow);
const visibleMatched = matched.filter(isVisible);
const accountExists = Object.prototype.hasOwnProperty.call(accounts, account);

console.log(`mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
console.log(`account: ${account}`);
console.log(`expected whole-store matches: ${expected}`);
console.log(`visible matches: ${visibleMatched.length}`);
console.log(`whole-store matches: ${matched.length}`);
console.log('matched ids:');
matched.forEach(learning => console.log(`  - ${String(learning.id ?? '(missing-id)')}`));
console.log(`platform account: ${accountExists ? 'already present' : 'would create'}`);

if (matched.length !== expected) {
  fail(`expected ${expected} whole-store matches, found ${matched.length}; no files written`);
}

if (!apply) {
  console.log('\nDRY-RUN — no files written. Re-run with --apply to persist, then restart the machine.');
  process.exit(0);
}

if (matched.length === 0 && accountExists) {
  console.log('\nNothing to do — no unattributed seed rows remain and the platform account exists. Exiting 0.');
  process.exit(0);
}

backupBothStores(timestamp());

if (!accountExists) {
  accounts[account] = {
    ...PLATFORM_ACCOUNT,
    created_at: new Date().toISOString(),
  };
  atomicWriteJson(ACCOUNTS, accounts);
  console.log(`accounts.json written: created ${account}.`);
}

for (const learning of matched) learning.contributor_account_id = account;
if (matched.length > 0) {
  atomicWriteJson(LEARNINGS, learnings);
  console.log(`learnings.json written: attributed ${matched.length} learnings.`);
}

console.log('\nAPPLIED. NOW RESTART THE MACHINE so the server reloads learnings.json.');
