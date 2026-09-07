'use strict';

/**
 * lib/tar-extract.js — Minimal POSIX ustar/PAX reader for npm tarballs
 * (RUNNER-AUTO-UPDATE, 0.9.16).
 *
 * No `tar` npm dependency exists in this package (checked: not installed,
 * not a transitive dep) — this hand-rolled reader exists specifically so
 * lib/runner-autoupdate.js can extract a downloaded `auxilo-mcp` tarball
 * without adding a new third-party dependency to a security-sensitive
 * unattended-download path.
 *
 * Verified against a REAL npm tarball (auxilo-mcp@0.9.15, fetched from
 * registry.npmjs.org during this build): every entry is typeflag '0'
 * (regular file), no directory entries, no PAX headers, names fit the
 * 100-byte ustar `name` field with an empty `prefix`. This reader supports
 * more than that minimum on purpose (directories, the ustar prefix field,
 * PAX 'path' overrides, GNU long-name blocks) so it keeps working if a
 * future publish's file layout needs the extra header room — but it
 * deliberately does NOT support hard links or symlinks: those entry types
 * are skipped (never extracted, never followed) as a hardening measure
 * against a compromised/malicious tarball writing outside destDir.
 *
 * @module tar-extract
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLOCK_SIZE = 512;

/** Read a NUL/space-padded octal or decimal numeric tar header field. */
function readNumericField(buf) {
  // GNU tar base-256 encoding: high bit of the first byte set.
  if (buf.length > 0 && (buf[0] & 0x80) !== 0) {
    let value = 0n;
    for (let i = 1; i < buf.length; i++) value = (value << 8n) | BigInt(buf[i]);
    return Number(value);
  }
  const str = buf.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!str) return 0;
  const n = parseInt(str, 8);
  return Number.isFinite(n) ? n : 0;
}

function readStringField(buf) {
  const idx = buf.indexOf(0);
  return (idx === -1 ? buf : buf.subarray(0, idx)).toString('utf-8');
}

/** Parse a PAX extended-header block body into a { key: value } map. */
function parsePaxBody(body) {
  const out = {};
  let offset = 0;
  const text = body;
  while (offset < text.length) {
    // "<length> <key>=<value>\n" — length includes itself + the trailing \n.
    let spaceIdx = text.indexOf(' ', offset);
    if (spaceIdx === -1) break;
    const lenStr = text.slice(offset, spaceIdx).toString('ascii');
    const len = parseInt(lenStr, 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const recordEnd = offset + len;
    if (recordEnd > text.length) break;
    const record = text.slice(spaceIdx + 1, recordEnd - 1).toString('utf-8'); // drop trailing \n
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    offset = recordEnd;
  }
  return out;
}

/**
 * Extract a gzip-compressed tar buffer into destDir.
 *
 * Every extracted path is resolved and checked to stay strictly inside
 * destDir before any write — a `..`-traversing or absolute entry name is
 * refused (the whole extraction throws, since a tampered/corrupt tarball is
 * not something the caller should partially trust).
 *
 * @param {Buffer} gzBuffer
 * @param {string} destDir  Must already exist (or be creatable via mkdirSync).
 * @returns {{ files: string[], dirs: string[], skipped: string[] }}
 *   files/dirs are destDir-relative paths written; skipped names entries
 *   deliberately not extracted (symlinks/hardlinks/unsupported types).
 */
function extractTarGz(gzBuffer, destDir) {
  const tarBuffer = zlib.gunzipSync(gzBuffer);
  fs.mkdirSync(destDir, { recursive: true });

  const files = [];
  const dirs = [];
  const skipped = [];

  let offset = 0;
  let pendingLongName = null; // GNU 'L' typeflag: next header's name
  let pendingPaxName = null; // PAX 'x' typeflag: next header's name override

  while (offset + BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK_SIZE);

    // End of archive: two consecutive zero-filled blocks (we only need to
    // detect the first all-zero block since nothing meaningful follows).
    if (header.every((b) => b === 0)) break;

    const nameField = readStringField(header.subarray(0, 100));
    const sizeField = readNumericField(header.subarray(124, 136));
    const typeflag = String.fromCharCode(header[156] || 0);
    const prefixField = readStringField(header.subarray(345, 500));

    const dataStart = offset + BLOCK_SIZE;
    const dataEnd = dataStart + sizeField;
    const paddedEnd = dataStart + Math.ceil(sizeField / BLOCK_SIZE) * BLOCK_SIZE;

    if (typeflag === 'x' || typeflag === 'g') {
      // PAX extended header — applies to the NEXT entry (or 'g' for the
      // whole archive; treated the same here since we only read one key).
      const paxData = tarBuffer.subarray(dataStart, dataEnd);
      const pax = parsePaxBody(paxData);
      if (pax.path) pendingPaxName = pax.path;
      offset = paddedEnd;
      continue;
    }

    if (typeflag === 'L') {
      // GNU long-name: the data block IS the next entry's full name.
      pendingLongName = tarBuffer.subarray(dataStart, dataEnd).toString('utf-8').replace(/\0+$/, '');
      offset = paddedEnd;
      continue;
    }

    let entryName = pendingPaxName || pendingLongName ||
      (prefixField ? `${prefixField}/${nameField}` : nameField);
    pendingLongName = null;
    pendingPaxName = null;

    // npm tarballs wrap every file under a single "package/" root — strip
    // exactly that first path segment so callers get the package contents
    // directly at destDir.
    const parts = entryName.split('/').filter(Boolean);
    const rel = parts.length > 1 ? parts.slice(1).join('/') : parts.join('/');

    if (rel) {
      // Defense in depth: refuse anything that would escape destDir, even
      // though the leading-segment strip above already removes the normal
      // "package/" prefix an npm tarball carries.
      const resolved = path.resolve(destDir, rel);
      if (resolved !== destDir && !resolved.startsWith(destDir + path.sep)) {
        throw new Error(`tar-extract: refusing path-traversal entry "${entryName}"`);
      }

      if (typeflag === '5') {
        // Directory.
        fs.mkdirSync(resolved, { recursive: true });
        dirs.push(rel);
      } else if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
        // Regular file.
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, tarBuffer.subarray(dataStart, dataEnd));
        files.push(rel);
      } else {
        // '1' hard link, '2' symlink, and anything else (device nodes,
        // FIFOs, ...) — never extracted.
        skipped.push(rel);
      }
    }

    offset = paddedEnd;
  }

  return { files, dirs, skipped };
}

module.exports = { extractTarGz };
