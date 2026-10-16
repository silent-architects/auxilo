"use strict";
// The parent retains the open file description that util-linux flock locks.
// Never unlink/recreate the lock: closing the retained descriptor is release.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const ownership = new WeakMap();
function fail(code) {
  throw Object.assign(new Error(code), {
    code
  });
}
function assertMoneyWriter(writer, {
  root
}
= {
}) {
  const s = ownership.get(writer);
  if (! s) fail('MONEY_WRITER_REQUIRED');
  if (s.closed) fail('MONEY_WRITER_CLOSED');
  if (root && path.resolve(root) !== s.root) fail('MONEY_WRITER_ROOT_MISMATCH');
  if (s.check() !== true) fail('MONEY_WRITER_OWNERSHIP_LOST');
  return true;
}
function capability(root, check, release) {
  const writer = Object.freeze( {
    root, assertOwned() {
      return assertMoneyWriter(writer, {
        root
      });
    }, close() {
      const s = ownership.get(writer);
      if (! s.closed) {
        s.closed = true;
        release();
      }
    }
  });
  ownership.set(writer, {
    root, check, closed: false
  });
  return writer;
}
function acquireMoneyWriter( {
  root
}
= {
}) {
  if (process.platform !== 'linux') fail('LINUX_MONEY_WRITER_REQUIRED');
  root = path.resolve(root);
  const dir = fs.lstatSync(root);
  if (! dir.isDirectory() || dir.isSymbolicLink()) fail('MONEY_WRITER_ROOT_INVALID');
  const file = path.join(root, '.money-writer.lock');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
    const initial = fs.fstatSync(fd);
    if (! initial.isFile() ||(initial.mode & 0o777) !== 0o600 || initial.nlink !== 1 || initial.uid !== process.getuid()) fail('MONEY_WRITER_PRIVATE_FILE_REQUIRED');
    const result = cp.spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd], timeout: 5000
    });
    if (result.error || result.status !== 0) fail(result.status === 1 ? 'MONEY_WRITER_ALREADY_HELD': 'MONEY_WRITER_FLOCK_FAILED');
    fs.fsyncSync(fd);
    const parent = fs.openSync(root, 'r');
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
    const retained = fd;
    fd = undefined;
    return capability(root, () => {
      let current;
      try {
        current = fs.lstatSync(file);
      } catch {
        fail('MONEY_WRITER_INODE_CHANGED');
      }
      const held = fs.fstatSync(retained);
      if (! current.isFile() || current.isSymbolicLink() || current.dev !== held.dev || current.ino !== held.ino || current.nlink !== 1 ||(current.mode & 0o777) !== 0o600) fail('MONEY_WRITER_INODE_CHANGED');
      return true;
    }, () => fs.closeSync(retained));
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
async function openMoneyWriter(options) {
  return acquireMoneyWriter(options);
}
// Injection is confined to pure unit-test constructors, never an environment
// escape hatch in acquireMoneyWriter or runtime startup.
function injectMoneyWriter( {
  root, assertOwned
}
= {
}) {
  if (! process.env.NODE_TEST_CONTEXT || typeof assertOwned !== 'function') fail('TEST_OWNERSHIP_ONLY');
  return capability(path.resolve(root), assertOwned, () => {
  });
}
module.exports = {
  acquireMoneyWriter, openMoneyWriter, assertMoneyWriter, injectMoneyWriter
};
