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
function validateExtractedDir(dir, marker) {
  const errors = [];
  const checked = { json: 0, jsonl: 0 };

  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.json')) {
        checked.json += 1;
        try {
          JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (e) {
          errors.push(`${path.relative(dir, p)}: JSON parse failed (${e.message})`);
        }
      } else if (entry.name.endsWith('.jsonl')) {
        checked.jsonl += 1;
        const lines = fs.readFileSync(p, 'utf8').split('\n');
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
  const ageMin = Math.round((Date.now() - Date.parse(marker.generated_at)) / 60000);
  console.log(`[drill] marker: ${marker.object_key} generated ${marker.generated_at} (${ageMin} min ago), ` +
    `${marker.bytes} bytes, counts=${JSON.stringify(marker.counts)}`);

  // 2. Download + decrypt + extract in one streamed pass.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-restore-drill-'));
  const objRes = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: marker.object_key }));
  const tar = spawn('tar', ['-xzf', '-', '-C', workDir], { stdio: ['pipe', 'inherit', 'inherit'] });
  const tarExit = new Promise((resolve, reject) => {
    tar.on('error', reject);
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
  await pipeline(Readable.from(decryptGen(objRes.Body, config.keyHex)), tar.stdin);
  await tarExit;
  console.log(`[drill] decrypted + extracted to ${workDir}`);

  // 3. Validate.
  const result = validateExtractedDir(workDir, marker);
  console.log(`[drill] validated ${result.checked.json} .json + ${result.checked.jsonl} .jsonl files`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`[drill] FAIL: ${e}`);
    process.exit(1);
  }

  console.log('[drill] PASS — backup is decryptable, parseable, and counts match the marker');
  if (keep) {
    console.log(`[drill] extracted tree kept at: ${workDir} (restore procedure: docs/RUNBOOK.md §4)`);
  } else {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[drill] FAILED: ${err && err.message}`);
    process.exit(1);
  });
}

module.exports = { validateExtractedDir };
