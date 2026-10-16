'use strict';

// This inspector reads runtime facts. It never changes PRAGMAs, environment,
// directories, or financial data, and never executes a caller SQL callback.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SQLITE_VERSION = '3.53.2';
const PATCHED_SOURCE_SHA256 = 'dcd0fcf647169cdcac0c9c9447de52eeeb909aa5b075adeaff32b7e2d5892ad3';
const PAGE_SIZE = 4096;
const SECTOR_SIZE = 4096;
const MAX_DATABASE_PAGES = 0xfffffffe;
const ASSUMPTIONS = Object.freeze([
  'one main database; temp only; no attached databases',
  'sequential fixed DML; no triggers, virtual tables or DDL',
  'no nested transactions or explicit savepoints; one implicit statement journal',
  'abort the outer transaction on statement failure',
  'exclusive writer owns all physical reserve accounting',
  'strict temp environment is fixed for the process lifetime',
  'sorter/query temporary files and checkpoint/publication overlap require separate proof',
]);

function fail(code) { throw Object.assign(new Error(code), {code}); }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function integer(value) {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) fail('SQLITE_RUNTIME_VALUE');
    value = Number(value);
  }
  if (!Number.isSafeInteger(value) || value < 0) fail('SQLITE_RUNTIME_VALUE');
  return value;
}

function deriveRollbackProof(quota) {
  if (!quota || !positive(quota.maxDatabasePages) || quota.maxDatabasePages > MAX_DATABASE_PAGES || !positive(quota.maxRollbackBytes)) fail('SQLITE_QUOTA_INVALID');
  const pages = BigInt(quota.maxDatabasePages), page = BigInt(PAGE_SIZE), sector = BigInt(SECTOR_SIZE);
  const raw = pages * (2n * page + 12n + 2n * sector) + 4n * sector;
  const rounded = ((raw + page - 1n) / page) * page;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) fail('SQLITE_QUOTA_INVALID');
  const requiredRollbackBytes = Number(rounded);
  if (BigInt(quota.maxRollbackBytes) < rounded) fail('SQLITE_ROLLBACK_BOUND_INSUFFICIENT');
  const descriptor = {
    schema: 1,
    bound_model: 'auxilo-main-and-single-statement-journal-v1',
    patched_source_sha256: PATCHED_SOURCE_SHA256,
    sqlite_version: SQLITE_VERSION,
    platform: 'linux',
    compile_protections: ['AUXILO_STRICT_TEMP=1', 'DEFAULT_SECTOR_SIZE=4096'],
    page_size: PAGE_SIZE,
    sector_size: SECTOR_SIZE,
    journal_mode: 'delete',
    synchronous: 3,
    auto_vacuum: 0,
    max_database_pages: quota.maxDatabasePages,
    max_rollback_bytes: quota.maxRollbackBytes,
    required_rollback_bytes: requiredRollbackBytes,
    assumptions: [...ASSUMPTIONS],
  };
  return {
    descriptor,
    rollbackProofDigest: crypto.createHash('sha256').update(canonical(descriptor)).digest('hex'),
    requiredRollbackBytes,
  };
}

function canonicalStat(api, value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) fail('SQLITE_PATH_INVALID');
  try {
    if (api.realpathSync(value) !== value) fail('SQLITE_PATH_INVALID');
    let current = path.parse(value).root;
    if (api.lstatSync(current).isSymbolicLink()) fail('SQLITE_PATH_INVALID');
    for (const component of value.slice(current.length).split('/').filter(Boolean)) {
      current = path.join(current, component);
      if (api.lstatSync(current).isSymbolicLink()) fail('SQLITE_PATH_INVALID');
    }
    return api.lstatSync(value);
  } catch (error) {
    if (error.code === 'SQLITE_PATH_INVALID') throw error;
    fail('SQLITE_PATH_INVALID');
  }
}

function createInspector({db, file, tempDirectory, quota}, api, host, proofKind) {
  const derived = deriveRollbackProof(quota);
  if (quota.rollbackProofDigest !== derived.rollbackProofDigest) fail('SQLITE_ROLLBACK_PROOF_MISMATCH');
  const fixedQuota = {maxDatabasePages: quota.maxDatabasePages, maxRollbackBytes: quota.maxRollbackBytes};
  let baseline;

  function inspect({phase} = {}) {
    if (phase !== undefined && phase !== 'beforeCommit') fail('SQLITE_INSPECTION_PHASE');
    if (host.platform !== 'linux' || typeof host.getuid !== 'function') fail('SQLITE_LINUX_REQUIRED');
    if (!db || typeof db.pragma !== 'function' || typeof db.prepare !== 'function') fail('SQLITE_RUNTIME_HANDLE');
    if (db.inTransaction !== false && !(baseline && phase === 'beforeCommit' && db.inTransaction === true)) fail('SQLITE_TRANSACTION_STATE');

    const version = db.prepare('SELECT sqlite_version() AS version').get()?.version;
    if (version !== SQLITE_VERSION) fail('SQLITE_RUNTIME_VERSION');
    const compileRows = db.pragma('compile_options');
    if (!Array.isArray(compileRows)) fail('SQLITE_COMPILE_PROTECTION');
    const options = compileRows.map(row => row.compile_options);
    for (const [name, exact] of [['AUXILO_STRICT_TEMP', 'AUXILO_STRICT_TEMP=1'], ['DEFAULT_SECTOR_SIZE', 'DEFAULT_SECTOR_SIZE=4096']]) {
      const matches = options.filter(value => typeof value === 'string' && (value === name || value.startsWith(name + '=')));
      if (matches.length !== 1 || matches[0] !== exact) fail('SQLITE_COMPILE_PROTECTION');
    }
    for (const [name, expected] of Object.entries({page_size: PAGE_SIZE, journal_mode: 'delete', synchronous: 3, auto_vacuum: 0})) {
      const actual = db.pragma(name, {simple: true});
      if ((typeof expected === 'number' ? integer(actual) : actual) !== expected) fail('SQLITE_RUNTIME_PRAGMA');
    }
    const schemaVersion = integer(db.pragma('schema_version', {simple: true}));
    const pageCount = integer(db.pragma('page_count', {simple: true}));
    if (pageCount > fixedQuota.maxDatabasePages) fail('SQLITE_DATABASE_PAGE_LIMIT');
    if (baseline && schemaVersion !== baseline.schemaVersion) fail('SQLITE_SCHEMA_CHANGED');

    const databases = db.pragma('database_list');
    if (!Array.isArray(databases) || databases.filter(row => row.name === 'main').length !== 1 || databases.filter(row => row.name === 'temp').length > 1 || databases.some(row => !['main', 'temp'].includes(row.name))) fail('SQLITE_DATABASE_ATTACHMENTS');
    if (databases.find(row => row.name === 'main').file !== file) fail('SQLITE_DATABASE_FILE_MISMATCH');
    const schema = db.prepare("SELECT type, name, sql FROM main.sqlite_schema WHERE type IN ('trigger','table') UNION ALL SELECT type, name, sql FROM temp.sqlite_schema WHERE type IN ('trigger','table')").all();
    if (!Array.isArray(schema) || schema.some(row => {
      const sql = typeof row.sql === 'string' ? row.sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ') : '';
      return row.type === 'trigger' || /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(sql);
    })) fail('SQLITE_UNSAFE_SCHEMA');

    if (host.env.AUXILO_SQLITE_TMPDIR !== tempDirectory) fail('SQLITE_TEMP_ENVIRONMENT');
    const fileStat = canonicalStat(api, file), tempStat = canonicalStat(api, tempDirectory);
    if (!fileStat.isFile() || integer(fileStat.nlink) !== 1) fail('SQLITE_DATABASE_FILE_INVALID');
    if (!tempStat.isDirectory()) fail('SQLITE_PATH_INVALID');
    if (integer(tempStat.uid) !== integer(host.getuid())) fail('SQLITE_TEMP_OWNERSHIP');
    if ((integer(tempStat.mode) & 0o7777) !== 0o700) fail('SQLITE_TEMP_MODE');
    if (integer(tempStat.dev) !== integer(fileStat.dev)) fail('SQLITE_TEMP_FILESYSTEM');
    const physical = {
      file: {path: file, dev: integer(fileStat.dev), ino: integer(fileStat.ino)},
      tempDirectory: {path: tempDirectory, dev: integer(tempStat.dev), ino: integer(tempStat.ino)},
    };
    if (baseline && (canonical(physical.file) !== canonical(baseline.file) || canonical(physical.tempDirectory) !== canonical(baseline.tempDirectory))) fail('SQLITE_PATH_IDENTITY_CHANGED');
    if (!baseline) baseline = {...physical, schemaVersion};
    return {...deriveRollbackProof(fixedQuota), ...physical, schemaVersion, pageCount, proofKind};
  }

  // Establish the initial schema and path identities before an owned SQL
  // transaction can use phase:'beforeCommit'. No caller-supplied SQL runs here.
  inspect();
  return inspect;
}

function createRuntimeInspector(options) {
  return createInspector(options, fs, process, 'native-runtime-inspection');
}

// Explicit unit seam, not a security boundary or native-runtime attestation.
// Production creation never switches implementation based on an environment flag.
function createUnitRuntimeInspector(options, dependencies) {
  if (!process.env.NODE_TEST_CONTEXT) fail('SQLITE_UNIT_INJECTION_FORBIDDEN');
  if (!dependencies?.fs || !dependencies?.runtime) fail('SQLITE_UNIT_DEPENDENCIES_REQUIRED');
  return createInspector(options, dependencies.fs, dependencies.runtime, 'unit');
}

module.exports = {createRuntimeInspector, createUnitRuntimeInspector, deriveRollbackProof, SQLITE_VERSION, PATCHED_SOURCE_SHA256};
