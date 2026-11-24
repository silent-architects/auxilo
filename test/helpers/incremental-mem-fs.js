'use strict';

// In-memory fs + clock for the INCREMENTAL-SWEEP tests. Nothing here touches disk.
// Files are never removed through an fs method: the lock/offset code takes an
// injected `removeFile`, which this helper provides as a plain Map operation.

const { Readable, PassThrough } = require('stream');

function enoent(p) {
  const e = new Error(`ENOENT: no such file or directory, '${p}'`);
  e.code = 'ENOENT';
  return e;
}

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; }, set: (v) => { t = v; } };
}

function makeMemFs({ clock = makeClock(), chunkSize = 64 } = {}) {
  const files = new Map();
  const fsImpl = {
    files,
    readFileSync(p, enc) {
      if (!files.has(p)) throw enoent(p);
      const buf = files.get(p).data;
      return enc ? buf.toString('utf8') : Buffer.from(buf);
    },
    writeFileSync(p, data, opts) {
      const flag = opts && typeof opts === 'object' ? opts.flag : undefined;
      if (flag === 'wx' && files.has(p)) {
        const e = new Error(`EEXIST: file already exists, '${p}'`);
        e.code = 'EEXIST';
        throw e;
      }
      files.set(p, { data: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)), mtimeMs: clock.now() });
    },
    renameSync(a, b) {
      if (!files.has(a)) throw enoent(a);
      files.set(b, files.get(a));
      files.delete(a);
    },
    statSync(p) {
      if (!files.has(p)) throw enoent(p);
      const f = files.get(p);
      return { size: f.data.length, mtimeMs: f.mtimeMs, isFile: () => true };
    },
    mkdirSync() {},
    createReadStream(p, o) {
      if (!files.has(p)) {
        const s = new PassThrough();
        process.nextTick(() => s.destroy(enoent(p)));
        return s;
      }
      const start = o && o.start ? o.start : 0;
      const buf = files.get(p).data.subarray(start);
      const pieces = [];
      for (let i = 0; i < buf.length; i += chunkSize) pieces.push(Buffer.from(buf.subarray(i, i + chunkSize)));
      return Readable.from(pieces, { objectMode: false });
    },
  };
  const removeFile = (p) => { files.delete(p); };
  const put = (p, content) => { fsImpl.writeFileSync(p, content); };
  return { fsImpl, removeFile, put, clock, files };
}

// Identity "zstd": the stored bytes ARE the decompressed stream.
const identityZlib = { createZstdDecompress: () => new PassThrough() };

module.exports = { makeMemFs, makeClock, identityZlib };
