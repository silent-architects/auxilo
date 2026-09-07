'use strict';

/**
 * lib/semver-min.js — Minimal semver parse/compare (RUNNER-AUTO-UPDATE,
 * 0.9.16).
 *
 * No `semver` npm dependency exists in this package — this hand-rolled
 * comparator covers exactly what the auto-updater needs: parse
 * MAJOR.MINOR.PATCH[-prerelease][+build] and compare two versions per
 * semver 2.0.0 precedence (build metadata is ignored for precedence,
 * exactly per spec https://semver.org/#spec-item-10).
 *
 * @module semver-min
 */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

/** @returns {{major:number,minor:number,patch:number,prerelease:string[]}|null} */
function semverParse(v) {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: parseInt(m[1], 10),
    minor: parseInt(m[2], 10),
    patch: parseInt(m[3], 10),
    prerelease: m[4] ? m[4].split('.') : [],
  };
}

/** Compare two prerelease identifier arrays per semver precedence rule 11. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  // No prerelease has HIGHER precedence than a version with one.
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const an = /^\d+$/.test(a[i]);
    const bn = /^\d+$/.test(b[i]);
    if (an && bn) {
      const diff = parseInt(a[i], 10) - parseInt(b[i], 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1; // numeric identifiers always have lower precedence
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} -1 | 0 | 1, or null if either string doesn't parse.
 */
function semverCompare(a, b) {
  const pa = semverParse(a);
  const pb = semverParse(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/** True iff a > b (both must parse — invalid input is never "greater"). */
function semverGt(a, b) {
  const cmp = semverCompare(a, b);
  return cmp === 1;
}

module.exports = { semverParse, semverCompare, semverGt };
