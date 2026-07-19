#!/usr/bin/env node
// scripts/backup-runner.js — Wave 2a (LW-4): durable off-VM backups to Tigris.
//
// One-shot backup cycle, invoked every 6h by scripts/backup-supervisor.sh,
// which is spawned as a crash-isolated background sibling of the server by
// scripts/docker-entrypoint.sh. This process NEVER runs in the server's
// supervision path — a failure here cannot take the server down.
//
// Pipeline (streaming end-to-end; the tarball is never buffered in memory):
//   tar -czf - -C /app/data .   →   AES-256-GCM cipher   →   S3 multipart
//                                                            upload (Tigris)
//
// Object layout in the bucket:
//   daily/auxilo-data-<UTC-timestamp>.tar.gz.enc    (pruned after 30 days)
//   weekly/auxilo-data-<ISO-week>.tar.gz.enc        (pruned after 84 days)
//   freshness/latest.json                           (monitoring marker)
//
// Encrypted file format:  "AUXBKUP1" (8B) ‖ IV (12B) ‖ ciphertext ‖ GCM tag (16B)
// The key is 32 bytes hex in env BACKUP_ENCRYPTION_KEY. It lives ONLY in:
// the Fly secret, ~/.auxilo/backup-encryption-key on the operator laptop, and
// the operator password manager. Never in the repo.
//
// Exit codes: 0 = cycle ok, 1 = cycle failed (supervisor retries in 30 min),
//             2 = unconfigured (supervisor treats the feature as OFF).
//
// The /app/data volume contains PII (account emails). Everything leaving the
// box is encrypted; the freshness marker carries only counts/sizes/hashes.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable, Transform } = require('node:stream');

const MAGIC = Buffer.from('AUXBKUP1', 'ascii');
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + IV_LEN;

const DAILY_PREFIX = 'daily/';
const WEEKLY_PREFIX = 'weekly/';
const MARKER_KEY = 'freshness/latest.json';
const DAILY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const WEEKLY_RETENTION_MS = 84 * 24 * 60 * 60 * 1000;  // 12 weeks
const CYCLE_TIMEOUT_MS = 15 * 60 * 1000;               // watchdog

// Paths under the data dir excluded from the archive:
//  - ./backups     on-box secondary snapshots (would recursively inflate)
//  - ./lost+found  ext4 volume artifact, no app data
const TAR_EXCLUDES = ['./backups', './backups/*', './lost+found', './lost+found/*'];

// ── Config ────────────────────────────────────────────────────────────────

function validateConfig(env) {
  const missing = [];
  const key = env.BACKUP_ENCRYPTION_KEY || '';
  const bucket = env.BACKUP_S3_BUCKET || env.BUCKET_NAME || '';
  if (!key) missing.push('BACKUP_ENCRYPTION_KEY');
  if (!bucket) missing.push('BUCKET_NAME (or BACKUP_S3_BUCKET)');
  if (!env.AWS_ACCESS_KEY_ID) missing.push('AWS_ACCESS_KEY_ID');
  if (!env.AWS_SECRET_ACCESS_KEY) missing.push('AWS_SECRET_ACCESS_KEY');
  if (missing.length > 0) return { ok: false, unconfigured: true, missing };
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    return { ok: false, unconfigured: false, missing: ['BACKUP_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'] };
  }
  return {
    ok: true,
    keyHex: key,
    bucket,
    endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
    region: env.AWS_REGION || 'auto',
    dataDir: env.BACKUP_DATA_DIR || '/app/data',
  };
}

// ── Object keys / time ────────────────────────────────────────────────────

function utcStamp(date) {
  // 2026-07-19T18:04:05.123Z -> 20260719T180405Z
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function buildDailyKey(date) {
  return `${DAILY_PREFIX}auxilo-data-${utcStamp(date)}.tar.gz.enc`;
}

function isoWeek(date) {
  // ISO-8601 week id, e.g. 2026-W29 (weeks start Monday; week 1 contains Jan 4).
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function buildWeeklyKey(date) {
  return `${WEEKLY_PREFIX}auxilo-data-${isoWeek(date)}.tar.gz.enc`;
}

function parseKeyTimestamp(key) {
  // daily/auxilo-data-20260719T180405Z.tar.gz.enc -> epoch ms, else null
  const m = /auxilo-data-(\d{8})T(\d{6})Z\.tar\.gz\.enc$/.exec(key);
  if (!m) return null;
  const [, d, t] = m;
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ── Retention ─────────────────────────────────────────────────────────────

/**
 * Decide which objects to delete. `objects` is [{ Key, LastModified }].
 * Timestamp comes from the key name; falls back to LastModified; objects
 * with neither are KEPT (never delete blind).
 */
function planPrune(objects, now) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const doomed = [];
  for (const obj of objects || []) {
    const key = obj.Key || '';
    let retention;
    if (key.startsWith(DAILY_PREFIX)) retention = DAILY_RETENTION_MS;
    else if (key.startsWith(WEEKLY_PREFIX)) retention = WEEKLY_RETENTION_MS;
    else continue; // never touch anything outside the two managed prefixes
    let ts = parseKeyTimestamp(key);
    if (ts === null && obj.LastModified) {
      const lm = new Date(obj.LastModified).getTime();
      ts = Number.isNaN(lm) ? null : lm;
    }
    if (ts === null) continue; // unknown age -> keep
    if (nowMs - ts > retention) doomed.push(key);
  }
  return doomed;
}

// ── Crypto (AES-256-GCM, streaming) ───────────────────────────────────────

function parseKeyHex(keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

/** Async generator: plaintext chunks in, framed AUXBKUP1 ciphertext out. */
async function* encryptGen(source, keyHex) {
  const key = parseKeyHex(keyHex);
  const iv = crypto.randomBytes(IV_LEN); // fresh IV per backup — GCM must never reuse (Gate-A F5: caller-supplied IV removed)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  yield Buffer.concat([MAGIC, iv]);
  for await (const chunk of source) {
    const enc = cipher.update(chunk);
    if (enc.length > 0) yield enc;
  }
  const fin = cipher.final(); // empty for GCM, kept for form
  if (fin.length > 0) yield fin;
  yield cipher.getAuthTag();
}

/** Async generator: framed AUXBKUP1 ciphertext in, plaintext out. Throws on tamper/truncation. */
async function* decryptGen(source, keyHex) {
  const key = parseKeyHex(keyHex);
  let pending = Buffer.alloc(0);
  let decipher = null;
  for await (const chunk of source) {
    pending = Buffer.concat([pending, chunk]);
    if (!decipher) {
      if (pending.length < HEADER_LEN + TAG_LEN) continue;
      if (!pending.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('not an AUXBKUP1 file (bad magic)');
      }
      const iv = pending.subarray(MAGIC.length, HEADER_LEN);
      decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      pending = Buffer.from(pending.subarray(HEADER_LEN));
    }
    if (pending.length > TAG_LEN) {
      // Hold the trailing TAG_LEN bytes back — they may be the auth tag.
      const emit = pending.subarray(0, pending.length - TAG_LEN);
      pending = Buffer.from(pending.subarray(pending.length - TAG_LEN));
      const dec = decipher.update(emit);
      if (dec.length > 0) yield dec;
    }
  }
  if (!decipher || pending.length !== TAG_LEN) {
    throw new Error('truncated backup file');
  }
  decipher.setAuthTag(pending);
  const fin = decipher.final(); // throws if tag mismatch (tamper / wrong key)
  if (fin.length > 0) yield fin;
}

/** Transform that counts bytes and folds them into a sha256. */
class Meter extends Transform {
  constructor() {
    super();
    this.bytes = 0;
    this.hash = crypto.createHash('sha256');
  }
  _transform(chunk, _enc, cb) {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    cb(null, chunk);
  }
  sha256() {
    return this.hash.digest('hex');
  }
}

// ── Data-dir inspection ───────────────────────────────────────────────────

/** Row counts for the freshness marker + restore-drill integrity check. */
function readCounts(dataDir) {
  const counts = {};
  const spec = [
    ['learnings', 'learnings.json'],
    ['accounts', 'accounts.json'],
  ];
  for (const [name, file] of spec) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
      counts[name] = Array.isArray(parsed)
        ? parsed.length
        : Object.keys(parsed).filter((k) => !k.startsWith('__')).length;
    } catch {
      counts[name] = null; // absent/unparseable at snapshot time — recorded as unknown
    }
  }
  return counts;
}

// ── S3 plumbing (lazily required so unit tests need no AWS SDK objects) ───

function makeS3Client(config) {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: false,
  });
}

async function defaultUpload(s3, params) {
  const { Upload } = require('@aws-sdk/lib-storage');
  const up = new Upload({
    client: s3,
    params,
    queueSize: 1,        // memory-light: one 8MB part in flight max
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await up.done();
}

function cmd(name, input) {
  // Build the SDK command object lazily; unit tests inject their own `send`.
  const clientMod = require('@aws-sdk/client-s3');
  return new clientMod[name](input);
}

async function listAllObjects(send, bucket, prefix) {
  const out = [];
  let token;
  do {
    const res = await send(cmd('ListObjectsV2Command', {
      Bucket: bucket, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents || []) out.push({ Key: o.Key, LastModified: o.LastModified });
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

// ── The cycle ─────────────────────────────────────────────────────────────

/**
 * Run one backup cycle. All side-effectful collaborators are injectable for
 * tests: { send, upload, spawnTar, now, log }.
 * Returns { objectKey, bytes, sha256, counts, weeklyPromoted, pruned }.
 */
async function runBackupCycle(config, deps = {}) {
  const log = deps.log || ((...a) => console.log('[backup]', ...a));
  const now = deps.now || new Date();
  const send = deps.send; // required: (command) => Promise<result>
  const upload = deps.upload || defaultUpload;
  const s3ForUpload = deps.s3 || null;
  if (typeof send !== 'function') throw new Error('runBackupCycle: deps.send is required');

  // 1. Row counts BEFORE the tar so marker counts describe this snapshot.
  const counts = readCounts(config.dataDir);
  log(`counts: learnings=${counts.learnings} accounts=${counts.accounts}`);

  // 2. tar (streaming). busybox tar on prod, bsdtar on macOS — flags shared.
  const tarArgs = ['-czf', '-', ...TAR_EXCLUDES.map((p) => `--exclude=${p}`), '-C', config.dataDir, '.'];
  const spawnTar = deps.spawnTar || (() => spawn('tar', tarArgs, { stdio: ['ignore', 'pipe', 'pipe'] }));
  const tar = spawnTar();
  let tarStderr = '';
  if (tar.stderr) tar.stderr.on('data', (d) => { tarStderr += d.toString().slice(0, 2000); });
  const tarExit = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${tarStderr.trim()}`));
    });
  });

  // 3. encrypt + meter + upload (single streaming pipeline).
  const meter = new Meter();
  Readable.from(encryptGen(tar.stdout, config.keyHex)).pipe(meter);
  const objectKey = buildDailyKey(now);
  log(`uploading ${objectKey}`);
  await upload(s3ForUpload, {
    Bucket: config.bucket,
    Key: objectKey,
    Body: meter,
    ContentType: 'application/octet-stream',
  });
  await tarExit; // surface a tar failure even though upload completed
  const bytes = meter.bytes;
  const sha256 = meter.sha256();
  log(`uploaded ${bytes} bytes, sha256=${sha256}`);

  // 4. Verify: HEAD must agree byte-for-byte with what we streamed.
  const head = await send(cmd('HeadObjectCommand', { Bucket: config.bucket, Key: objectKey }));
  if (Number(head.ContentLength) !== bytes) {
    throw new Error(`upload verification failed: HEAD ContentLength=${head.ContentLength}, streamed=${bytes}`);
  }
  log('upload verified (HEAD size match)');

  // 5. Weekly promotion — first successful daily of each ISO week.
  const weeklyKey = buildWeeklyKey(now);
  let weeklyPromoted = false;
  let weeklyExists = false;
  try {
    await send(cmd('HeadObjectCommand', { Bucket: config.bucket, Key: weeklyKey }));
    weeklyExists = true;
  } catch (err) {
    const status = err && (err.$metadata?.httpStatusCode || err.statusCode);
    const name = err && err.name;
    if (!(status === 404 || name === 'NotFound' || name === 'NoSuchKey')) throw err;
  }
  if (!weeklyExists) {
    await send(cmd('CopyObjectCommand', {
      Bucket: config.bucket,
      Key: weeklyKey,
      CopySource: `${config.bucket}/${objectKey}`,
    }));
    weeklyPromoted = true;
    log(`promoted to ${weeklyKey}`);
  }

  // 6. Freshness marker — written ONLY after verification succeeded, so a
  //    stale/failed upload can never advance the monitoring heartbeat.
  //    Contents are non-sensitive by construction: timestamps, key names,
  //    sizes, hashes, row counts. No PII.
  const marker = {
    version: 1,
    generated_at: now.toISOString(),
    object_key: objectKey,
    bytes,
    sha256,
    counts,
  };
  await send(cmd('PutObjectCommand', {
    Bucket: config.bucket,
    Key: MARKER_KEY,
    Body: JSON.stringify(marker, null, 2),
    ContentType: 'application/json',
  }));
  log(`marker updated (${MARKER_KEY})`);

  // 7. Retention. Runs last — marker is already fresh even if pruning fails.
  const objects = [
    ...(await listAllObjects(send, config.bucket, DAILY_PREFIX)),
    ...(await listAllObjects(send, config.bucket, WEEKLY_PREFIX)),
  ];
  const doomed = planPrune(objects, now);
  if (doomed.length > 0) {
    await send(cmd('DeleteObjectsCommand', {
      Bucket: config.bucket,
      Delete: { Objects: doomed.map((Key) => ({ Key })), Quiet: true },
    }));
    log(`pruned ${doomed.length} expired object(s)`);
  }

  return { objectKey, bytes, sha256, counts, weeklyPromoted, pruned: doomed };
}

// ── CLI entry ─────────────────────────────────────────────────────────────

async function main() {
  const config = validateConfig(process.env);
  if (!config.ok) {
    if (config.unconfigured) {
      console.log(`[backup] not configured (missing: ${config.missing.join(', ')}) — backups disabled`);
      process.exit(2);
    }
    console.error(`[backup] bad configuration: ${config.missing.join(', ')}`);
    process.exit(1);
  }
  const s3 = makeS3Client(config);
  const watchdog = setTimeout(() => {
    console.error(`[backup] cycle exceeded ${CYCLE_TIMEOUT_MS / 60000} min watchdog — aborting`);
    process.exit(1);
  }, CYCLE_TIMEOUT_MS);
  watchdog.unref();
  try {
    const result = await runBackupCycle(config, { s3, send: (c) => s3.send(c) });
    console.log(`[backup] cycle ok: ${result.objectKey} (${result.bytes} bytes)`);
    process.exit(0);
  } catch (err) {
    console.error(`[backup] cycle FAILED: ${err && err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  MAGIC,
  MARKER_KEY,
  DAILY_PREFIX,
  WEEKLY_PREFIX,
  TAR_EXCLUDES,
  validateConfig,
  utcStamp,
  buildDailyKey,
  buildWeeklyKey,
  isoWeek,
  parseKeyTimestamp,
  planPrune,
  encryptGen,
  decryptGen,
  Meter,
  readCounts,
  runBackupCycle,
};
