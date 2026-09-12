'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACTIVE_BUNDLE_VERSION = '1';
const BUNDLE_PATHS = Object.freeze({
  '1': path.join(__dirname, 'extraction.v1.js'),
});

function bundlePath(version = ACTIVE_BUNDLE_VERSION) {
  const resolved = BUNDLE_PATHS[String(version)];
  if (!resolved) throw new Error(`Unknown extraction prompt bundle version: ${version}`);
  return resolved;
}

function loadPromptBundle(version = ACTIVE_BUNDLE_VERSION) {
  return require(bundlePath(version));
}

function bundleDigest(version = ACTIVE_BUNDLE_VERSION) {
  return crypto.createHash('sha256').update(fs.readFileSync(bundlePath(version))).digest('hex');
}

module.exports = Object.freeze({
  ...loadPromptBundle(),
  bundleDigest,
  loadPromptBundle,
});
