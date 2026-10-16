#!/usr/bin/env node
// scripts/backup-restore-drill.js — Wave 2a (LW-4): scripted restore drill.
//
// Proves a real off-VM backup is restorable: downloads the freshness marker
// from Tigris, downloads the backup it points at, decrypts (AES-256-GCM —
// tamper/truncation fails hard), extracts, and validates:
//   - every *.json file parses,
//   - every *.jsonl file parses line-by-line,
//   - learnings/accounts row counts EQUAL the marker's recorded counts.
//
// Run from the operator laptop (or anywhere with bucket creds):
//   export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...
//   export BUCKET_NAME=auxilo-backups
//   export BACKUP_ENCRYPTION_KEY="$(cat ~/.auxilo/backup-encryption-key)"
//   node scripts/backup-restore-drill.js [--keep]
//
// --keep leaves the extracted tree in place (printed) for a real restore;
// otherwise the temp dir is removed. Exit 0 = drill passed, 1 = failed.
// Full restore-to-prod procedure: docs/RUNBOOK.md §4.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const {
  MARKER_KEY,
  decryptGen,
  readCounts,
  validateConfig,
} = require('./backup-runner.js');

// ── Validation of an extracted data tree ─────────────────────────────────

/**
 * Validate an extracted /app/data tree against the marker.
 * Returns { ok, errors: [..], checked: { json, jsonl } }.
 */
function validatePlainDir(dir, marker) {
  const errors = [];
  const checked = { json: 0, jsonl: 0 };


  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) {errors.push(`${path.relative(dir,p)}: special file refused`);continue;}
      if (entry.name.endsWith('.json')) {
        checked.json += 1;
        try {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {
          errors.push(`${path.relative(dir, p)}: JSON parse failed (${e.message})`);
        }
      } else if (entry.name.endsWith('.jsonl')) {
        checked.jsonl += 1;
        const raw=fs.readFileSync(p,'utf8');if(raw&&!raw.endsWith('\n'))errors.push(`${path.relative(dir,p)}: torn JSONL record`);const lines = raw.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          try {
            JSON.parse(line);
          } catch {
            errors.push(`${path.relative(dir, p)}: line ${i + 1} is not valid JSON`);
            break; // one bad line fails the file; no need to enumerate all
          }
        }
      }
    }
  };
  walk(dir);

  if (checked.json === 0) errors.push('no .json files found in extracted tree');

  // Row-count integrity vs the marker (counts recorded at backup time).
  if (marker && marker.counts) {
    const extracted = readCounts(dir);
    for (const name of Object.keys(marker.counts)) {
      const want = marker.counts[name];
      const got = extracted[name];
      if (want === null || want === undefined) continue; // unknown at snapshot time
      if (got !== want) {
        errors.push(`${name} count mismatch: marker says ${want}, extracted has ${got}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, checked };
}

function validateExtractedDir(dir,marker) {
  const cp=require('../lib/money-checkpoint');
  if(marker?.checkpoint_id||fs.existsSync(path.join(dir,cp.MANIFEST))||fs.existsSync(path.join(dir,'financial-epoch.json'))){
    try {const manifest=cp.validateCheckpoint(fs.realpathSync(dir));if(marker?.checkpoint_digest!==manifest.checksum)throw Error('CHECKPOINT_MARKER_BINDING_REQUIRED');return cp.withCheckpointContents(dir,manifest,root=>validatePlainDir(root,marker));}
    catch(error){return {ok:false,errors:['financial checkpoint: '+error.message],checked:{json:0,jsonl:0}};}
  }
  return validatePlainDir(dir,marker);
}
async function decryptCheckpointBackup({source,keyHex,workDir}) {
  const cp=require('../lib/money-checkpoint'),envelope=path.join(workDir,'authenticated-envelope'),destination=path.join(workDir,'checkpoint');
  async function* bounded(){let size=0;for await(const chunk of decryptGen(source,keyHex)){size+=chunk.length;if(size>cp.MAX_BACKUP_BYTES)throw Error('CHECKPOINT_ENVELOPE_SIZE');yield chunk;}}
  try {
    // No manifest parsing or extraction occurs before GCM authentication finishes.
    await pipeline(Readable.from(bounded()),fs.createWriteStream(envelope,{flags:'wx',mode:0o600}));
    fs.mkdirSync(destination,{mode:0o700});return cp.unpackCheckpointEnvelope(envelope,destination);
  } finally {if(fs.existsSync(envelope))fs.unlinkSync(envelope);}
}

// ── Drill ─────────────────────────────────────────────────────────────────

async function bodyToBuffer(body) {
  const chunks = [];
  for await (const c of body) chunks.push(c);
  return Buffer.concat(chunks);
}

async function main() {
  const keep = process.argv.includes('--keep');
  const config = validateConfig(process.env);
  if (!config.ok) {
    console.error(`[drill] missing configuration: ${config.missing.join(', ')}`);
    process.exit(1);
  }

  const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({ region: config.region, endpoint: config.endpoint, forcePathStyle: false });

  console.log(`[drill] bucket=${config.bucket} endpoint=${config.endpoint}`);

  // 1. Marker.
  const markerRes = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: MARKER_KEY }));
  const marker = JSON.parse((await bodyToBuffer(markerRes.Body)).toString('utf8'));
  if(marker.expires_at&&Date.parse(marker.expires_at)<=Date.now())throw Error('CHECKPOINT_EXPIRED');
  const ageMin = Math.round((Date.now() - Date.parse(marker.generated_at)) / 60000);
  console.log(`[drill] marker: ${marker.object_key} generated ${marker.generated_at} (${ageMin} min ago), ` +
    `${marker.bytes} bytes, counts=${JSON.stringify(marker.counts)}`);

  // 2. Download + decrypt + extract in one streamed pass.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-restore-drill-'));
  try {
  const objRes = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: marker.object_key }));
  let extracted=workDir;
  if(marker.checkpoint_id)extracted=await decryptCheckpointBackup({source:objRes.Body,keyHex:config.keyHex,workDir});
  else {
  const tar = spawn('tar', ['-xzf', '-', '-C', workDir], { stdio: ['pipe', 'inherit', 'inherit'] });
  const tarExit = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  await pipeline(Readable.from(decryptGen(objRes.Body, config.keyHex)), tar.stdin);
  await tarExit;
  console.log(`[drill] decrypted + extracted to ${workDir}`);

  }

  // 3. Validate.
  const result = validateExtractedDir(extracted, marker);
  console.log(`[drill] validated ${result.checked.json} .json + ${result.checked.jsonl} .jsonl files`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`[drill] FAIL: ${e}`);
    throw Error('BACKUP_RESTORE_VALIDATION_FAILED');
  }

  console.log('[drill] PASS — backup is decryptable, parseable, and counts match the marker');
  if (keep && marker.checkpoint_id) throw Error('Financial restore drill scratch may not be retained; use complete offline restore');
  if (keep) {
    console.log(`[drill] extracted tree kept at: ${workDir} (restore procedure: docs/RUNBOOK.md §4)`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  return result;
  } finally {
    if (!keep || marker.checkpoint_id) fs.rmSync(workDir, {recursive:true,force:true});
  }
}


if (require.main === module) {
  main().catch((err) => {
    console.error(`[drill] FAILED: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { validateExtractedDir, decryptCheckpointBackup };
