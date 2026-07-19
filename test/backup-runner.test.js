// test/backup-runner.test.js — Wave 2a (LW-4/LW-5): off-VM backup runner.
// Spec: ~/.auxilo/handoffs/BUILD-SPEC-WAVE2A-backups-2026-07-19.md §3 (T1–T14).
// Mocked S3 (plain send/upload doubles); REAL tar + REAL AES-256-GCM over
// temp dirs. No network.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const runner = require('../scripts/backup-runner.js');
const drill = require('../scripts/backup-restore-drill.js');

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

// ── helpers ───────────────────────────────────────────────────────────────

async function collect(gen) {
  const chunks = [];
  for await (const c of gen) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

function* chunked(buf, size) {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

function makeDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auxilo-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'learnings.json'), JSON.stringify([{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }]));
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify({ acc_1: { e: 1 }, acc_2: { e: 2 } }));
  fs.writeFileSync(path.join(dir, 'settlements.jsonl'), '{"a":1}\n{"a":2}\n');
  fs.mkdirSync(path.join(dir, 'wal'));
  fs.writeFileSync(path.join(dir, 'wal', 'entry.json'), '{"w":1}');
  fs.mkdirSync(path.join(dir, 'backups'));
  fs.writeFileSync(path.join(dir, 'backups', 'junk.tar'), 'SHOULD-NOT-SHIP');
  return dir;
}

/**
 * Scriptable S3 double. `behavior` may override per-command handlers.
 * Records every command in .calls as { name, input }.
 */
function makeMockS3(behavior = {}) {
  const state = {
    calls: [],
    uploads: [], // { params, body (Buffer) }
    weeklyExists: behavior.weeklyExists || false,
    listed: behavior.listed || [],
    headLength: behavior.headLength, // undefined -> echo real uploaded bytes
  };
  const send = async (command) => {
    const name = command.constructor.name;
    state.calls.push({ name, input: command.input });
    if (behavior[name]) return behavior[name](command.input, state);
    switch (name) {
      case 'HeadObjectCommand': {
        if (command.input.Key.startsWith(runner.WEEKLY_PREFIX)) {
          if (state.weeklyExists) return { ContentLength: 1 };
          const err = new Error('NotFound');
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        const up = state.uploads.find((u) => u.params.Key === command.input.Key);
        const real = up ? up.body.length : 0;
        return { ContentLength: state.headLength !== undefined ? state.headLength : real };
      }
      case 'CopyObjectCommand':
        return {};
      case 'PutObjectCommand':
        return {};
      case 'ListObjectsV2Command':
        return { Contents: state.listed.filter((o) => o.Key.startsWith(command.input.Prefix || '')), IsTruncated: false };
      case 'DeleteObjectsCommand':
        return { Deleted: command.input.Delete.Objects };
      default:
        throw new Error(`mock S3: unhandled command ${name}`);
    }
  };
  const upload = async (_s3, params) => {
    const body = await collect(params.Body);
    state.uploads.push({ params, body });
  };
  return { state, send, upload };
}

function baseConfig(dataDir) {
  return {
    ok: true,
    keyHex: KEY_A,
    bucket: 'test-bucket',
    endpoint: 'https://example.invalid',
    region: 'auto',
    dataDir,
  };
}

const quiet = () => {};

// ── T1: object-key build/parse round-trip ────────────────────────────────

describe('T1: object keys', () => {
  test('buildDailyKey format + parseKeyTimestamp round-trip', () => {
    const d = new Date('2026-07-19T18:04:05.123Z');
    const key = runner.buildDailyKey(d);
    assert.strictEqual(key, 'daily/auxilo-data-20260719T180405Z.tar.gz.enc');
    const ts = runner.parseKeyTimestamp(key);
    assert.strictEqual(ts, Date.parse('2026-07-19T18:04:05Z'));
  });

  test('weekly key uses ISO week id', () => {
    // 2026-07-19 is a Sunday in ISO week 29.
    assert.strictEqual(runner.isoWeek(new Date('2026-07-19T12:00:00Z')), '2026-W29');
    assert.strictEqual(runner.buildWeeklyKey(new Date('2026-07-19T12:00:00Z')),
      'weekly/auxilo-data-2026-W29.tar.gz.enc');
    // Monday of the next week flips.
    assert.strictEqual(runner.isoWeek(new Date('2026-07-20T00:00:00Z')), '2026-W30');
  });

  test('malformed key -> null', () => {
    assert.strictEqual(runner.parseKeyTimestamp('daily/other-file.txt'), null);
    assert.strictEqual(runner.parseKeyTimestamp('daily/auxilo-data-2026bogus.tar.gz.enc'), null);
  });
});

// ── T2–T4: prune plan ────────────────────────────────────────────────────

describe('T2-T4: planPrune', () => {
  const now = Date.parse('2026-07-19T12:00:00Z');
  const daysAgo = (n) => new Date(now - n * 86400000);

  test('T2: daily window — 29d kept, 31d deleted', () => {
    const objects = [
      { Key: runner.buildDailyKey(daysAgo(29)) },
      { Key: runner.buildDailyKey(daysAgo(31)) },
    ];
    const doomed = runner.planPrune(objects, now);
    assert.deepStrictEqual(doomed, [runner.buildDailyKey(daysAgo(31))]);
  });

  test('T3: weekly window — 83d kept, 85d deleted; prefixes independent', () => {
    const weeklyOld = { Key: 'weekly/auxilo-data-' + runner.utcStamp(daysAgo(85)) + '.tar.gz.enc' };
    const weeklyOk = { Key: 'weekly/auxilo-data-' + runner.utcStamp(daysAgo(83)) + '.tar.gz.enc' };
    // A daily-aged object under weekly/ must use the WEEKLY window (35d < 84d -> kept).
    const weeklyDailyAge = { Key: 'weekly/auxilo-data-' + runner.utcStamp(daysAgo(35)) + '.tar.gz.enc' };
    const doomed = runner.planPrune([weeklyOld, weeklyOk, weeklyDailyAge], now);
    assert.deepStrictEqual(doomed, [weeklyOld.Key]);
  });

  test('T4: unparseable key falls back to LastModified; unknown age kept; foreign prefixes untouched', () => {
    const doomed = runner.planPrune([
      { Key: 'daily/manual-upload.tar.gz.enc', LastModified: daysAgo(40).toISOString() }, // fallback -> delete
      { Key: 'daily/manual-keep.tar.gz.enc' },                                            // no age -> keep
      { Key: 'freshness/latest.json', LastModified: daysAgo(400).toISOString() },         // foreign prefix -> keep
    ], now);
    assert.deepStrictEqual(doomed, ['daily/manual-upload.tar.gz.enc']);
  });
});

// ── T5–T7: crypto ────────────────────────────────────────────────────────

describe('T5-T7: AES-256-GCM framing', () => {
  test('T5: encrypt -> decrypt round-trip is byte-identical; header framed', async () => {
    const payload = crypto.randomBytes(300000);
    const enc = await collect(runner.encryptGen(Readable.from(chunked(payload, 7001)), KEY_A));
    assert.ok(enc.subarray(0, 8).equals(runner.MAGIC), 'magic present');
    assert.strictEqual(enc.length, 8 + 12 + payload.length + 16, 'header+iv+ct+tag length');
    // Decrypt with awkward chunk sizes to exercise the tag-holdback path.
    const dec = await collect(runner.decryptGen(Readable.from(chunked(enc, 13)), KEY_A));
    assert.ok(dec.equals(payload), 'round-trip byte-identical');
  });

  test('T6: tampered ciphertext fails GCM auth', async () => {
    const enc = await collect(runner.encryptGen(Readable.from([Buffer.from('attack at dawn')]), KEY_A));
    enc[25] ^= 0xff; // flip a ciphertext byte (past the 20-byte header)
    await assert.rejects(() => collect(runner.decryptGen(Readable.from([enc]), KEY_A)),
      /Unsupported state|unable to authenticate/i);
  });

  test('T7: wrong key fails; truncation fails; bad magic fails', async () => {
    const enc = await collect(runner.encryptGen(Readable.from([Buffer.from('secret')]), KEY_A));
    await assert.rejects(() => collect(runner.decryptGen(Readable.from([enc]), KEY_B)));
    await assert.rejects(() => collect(runner.decryptGen(Readable.from([enc.subarray(0, enc.length - 4)]), KEY_A)),
      /truncated|Unsupported state|unable to authenticate/i);
    const badMagic = Buffer.from(enc);
    badMagic[0] ^= 0xff;
    await assert.rejects(() => collect(runner.decryptGen(Readable.from([badMagic]), KEY_A)), /bad magic/);
  });
});

// ── T8/T9/T11/T13: full cycle against the mock ───────────────────────────

describe('T8/T9/T11/T13: runBackupCycle', () => {
  const NOW = new Date('2026-07-19T18:00:00Z');

  test('T8+T11+T13: uploads, verifies, markers, excludes backups/, no PII in marker', async (t) => {
    const dataDir = makeDataDir(t);
    const mock = makeMockS3();
    const result = await runner.runBackupCycle(baseConfig(dataDir), {
      send: mock.send, upload: mock.upload, now: NOW, log: quiet,
    });

    // Exactly one daily upload, correct key.
    assert.strictEqual(mock.state.uploads.length, 1);
    const up = mock.state.uploads[0];
    assert.strictEqual(up.params.Key, 'daily/auxilo-data-20260719T180000Z.tar.gz.enc');
    assert.strictEqual(result.objectKey, up.params.Key);

    // Byte meter + sha match what actually crossed the wire.
    assert.strictEqual(result.bytes, up.body.length);
    assert.strictEqual(result.sha256, crypto.createHash('sha256').update(up.body).digest('hex'));

    // HEAD verification happened on the daily object.
    assert.ok(mock.state.calls.some((c) => c.name === 'HeadObjectCommand' && c.input.Key === up.params.Key));

    // Marker written with correct counts (3 learnings, 2 accounts) and only allowlisted keys.
    const markerPut = mock.state.calls.find((c) => c.name === 'PutObjectCommand' && c.input.Key === runner.MARKER_KEY);
    assert.ok(markerPut, 'marker was written');
    const marker = JSON.parse(markerPut.input.Body);
    assert.deepStrictEqual(marker.counts, { learnings: 3, accounts: 2 });
    assert.strictEqual(marker.object_key, up.params.Key);
    assert.strictEqual(marker.bytes, result.bytes);
    assert.deepStrictEqual(Object.keys(marker).sort(),
      ['bytes', 'counts', 'generated_at', 'object_key', 'sha256', 'version'],
      'marker carries ONLY the allowlisted non-PII keys');

    // T11: decrypt the real ciphertext and list the archive — backups/ and
    // lost+found/ excluded, real payload present.
    const plaintext = await collect(runner.decryptGen(Readable.from([up.body]), KEY_A));
    const listing = await new Promise((resolve, reject) => {
      const tar = spawn('tar', ['-tzf', '-'], { stdio: ['pipe', 'pipe', 'inherit'] });
      let out = '';
      tar.stdout.on('data', (d) => { out += d; });
      tar.on('error', reject);
      tar.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`tar -t exited ${code}`))));
      tar.stdin.end(plaintext);
    });
    assert.ok(listing.includes('learnings.json'), 'learnings.json in archive');
    assert.ok(listing.includes('wal'), 'wal/ in archive');
    assert.ok(!listing.includes('backups'), 'backups/ excluded from archive');
    assert.ok(!listing.includes('junk.tar'), 'backups/junk.tar excluded');
  });

  test('T9: HEAD size mismatch -> cycle fails and marker is NOT written', async (t) => {
    const dataDir = makeDataDir(t);
    const mock = makeMockS3({ headLength: 1 }); // always disagree
    await assert.rejects(
      () => runner.runBackupCycle(baseConfig(dataDir), { send: mock.send, upload: mock.upload, now: NOW, log: quiet }),
      /upload verification failed/,
    );
    assert.ok(!mock.state.calls.some((c) => c.name === 'PutObjectCommand'),
      'freshness marker must not advance on a failed verification');
  });

  test('T9b: tar failure -> cycle fails', async (t) => {
    const dataDir = makeDataDir(t);
    const config = { ...baseConfig(dataDir), dataDir: path.join(dataDir, 'does-not-exist') };
    const mock = makeMockS3();
    await assert.rejects(
      () => runner.runBackupCycle(config, { send: mock.send, upload: mock.upload, now: NOW, log: quiet }),
      /tar exited/,
    );
  });
});

// ── T10: weekly promotion ────────────────────────────────────────────────

describe('T10: weekly promotion', () => {
  const NOW = new Date('2026-07-19T18:00:00Z');

  test('first cycle of the ISO week copies to weekly/; later cycles do not', async (t) => {
    const dataDir = makeDataDir(t);

    const first = makeMockS3({ weeklyExists: false });
    const r1 = await runner.runBackupCycle(baseConfig(dataDir), {
      send: first.send, upload: first.upload, now: NOW, log: quiet,
    });
    assert.strictEqual(r1.weeklyPromoted, true);
    const copy = first.state.calls.find((c) => c.name === 'CopyObjectCommand');
    assert.ok(copy, 'CopyObject issued');
    assert.strictEqual(copy.input.Key, 'weekly/auxilo-data-2026-W29.tar.gz.enc');
    assert.strictEqual(copy.input.CopySource, `test-bucket/${r1.objectKey}`);

    const second = makeMockS3({ weeklyExists: true });
    const r2 = await runner.runBackupCycle(baseConfig(dataDir), {
      send: second.send, upload: second.upload, now: new Date(NOW.getTime() + 6 * 3600000), log: quiet,
    });
    assert.strictEqual(r2.weeklyPromoted, false);
    assert.ok(!second.state.calls.some((c) => c.name === 'CopyObjectCommand'), 'no second copy same week');
  });

  test('prune executes against listed expired objects', async (t) => {
    const dataDir = makeDataDir(t);
    const expired = runner.buildDailyKey(new Date(NOW.getTime() - 31 * 86400000));
    const fresh = runner.buildDailyKey(new Date(NOW.getTime() - 86400000));
    const mock = makeMockS3({ listed: [{ Key: expired }, { Key: fresh }] });
    const result = await runner.runBackupCycle(baseConfig(dataDir), {
      send: mock.send, upload: mock.upload, now: NOW, log: quiet,
    });
    assert.deepStrictEqual(result.pruned, [expired]);
    const del = mock.state.calls.find((c) => c.name === 'DeleteObjectsCommand');
    assert.deepStrictEqual(del.input.Delete.Objects, [{ Key: expired }]);
  });
});

// ── T12: configuration gate ──────────────────────────────────────────────

describe('T12: validateConfig', () => {
  const full = {
    BACKUP_ENCRYPTION_KEY: KEY_A,
    BUCKET_NAME: 'b',
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
  };

  test('missing env -> unconfigured (exit-2 path), lists what is missing', () => {
    const res = runner.validateConfig({});
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.unconfigured, true);
    assert.ok(res.missing.includes('BACKUP_ENCRYPTION_KEY'));
    assert.ok(res.missing.some((m) => m.includes('BUCKET_NAME')));
  });

  test('malformed key -> hard error, NOT the silent unconfigured path', () => {
    const res = runner.validateConfig({ ...full, BACKUP_ENCRYPTION_KEY: 'too-short' });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.unconfigured, false);
  });

  test('full env -> ok with defaults', () => {
    const res = runner.validateConfig(full);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.bucket, 'b');
    assert.strictEqual(res.region, 'auto');
    assert.strictEqual(res.endpoint, 'https://fly.storage.tigris.dev');
    assert.strictEqual(res.dataDir, '/app/data');
  });

  test('BACKUP_S3_BUCKET takes precedence over BUCKET_NAME', () => {
    const res = runner.validateConfig({ ...full, BACKUP_S3_BUCKET: 'override' });
    assert.strictEqual(res.bucket, 'override');
  });
});

// ── T14: drill validator ─────────────────────────────────────────────────

describe('T14: validateExtractedDir', () => {
  const marker = { counts: { learnings: 3, accounts: 2 } };

  test('good extracted tree passes against its marker', (t) => {
    const dir = makeDataDir(t);
    const res = drill.validateExtractedDir(dir, marker);
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
    assert.ok(res.checked.json >= 3);
    assert.ok(res.checked.jsonl >= 1);
  });

  test('unparseable JSON fails', (t) => {
    const dir = makeDataDir(t);
    fs.writeFileSync(path.join(dir, 'learnings.json'), '{corrupt');
    const res = drill.validateExtractedDir(dir, marker);
    assert.strictEqual(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('learnings.json')));
  });

  test('bad JSONL line fails', (t) => {
    const dir = makeDataDir(t);
    fs.appendFileSync(path.join(dir, 'settlements.jsonl'), 'not-json\n');
    const res = drill.validateExtractedDir(dir, marker);
    assert.strictEqual(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('settlements.jsonl')));
  });

  test('row-count mismatch vs marker fails', (t) => {
    const dir = makeDataDir(t);
    const res = drill.validateExtractedDir(dir, { counts: { learnings: 999, accounts: 2 } });
    assert.strictEqual(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('learnings count mismatch')));
  });

  test('null marker count (unknown at snapshot) is tolerated', (t) => {
    const dir = makeDataDir(t);
    const res = drill.validateExtractedDir(dir, { counts: { learnings: null, accounts: 2 } });
    assert.strictEqual(res.ok, true, JSON.stringify(res.errors));
  });
});
