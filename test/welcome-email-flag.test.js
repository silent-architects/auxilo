'use strict';

/**
 * test/welcome-email-flag.test.js — FIX-UNIT-TERMS-3.md, W-1/W-2.
 *
 * The owner's word, 2026-09-27: "welcome on". fly.toml's [env] block now
 * arms WELCOME_EMAIL_ENABLED = "true" (the one-time welcome email a first
 * sign-in sends when it creates the account -- lib/accounts.js's own gate,
 * unchanged). EARNING_NOTIFICATIONS_ENABLED is NOT added -- the unlock
 * notification stays off, unchanged.
 *
 * Same style as the CLEAN-LANE-FLIP Phase B fly.toml pin
 * (test/clean-lane-phase-b.test.js): a source pin on the deploy config
 * itself, not a staged server -- the deploy config is the fact.
 *
 * Runner: node --test test/welcome-email-flag.test.js
 */

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('W-1/W-2: fly.toml deploy config pin -- welcome email armed, unlock notification untouched', () => {
  it('fly.toml [env] sets WELCOME_EMAIL_ENABLED = "true" exactly, once, and EARNING_NOTIFICATIONS_ENABLED appears nowhere in the file', () => {
    const toml = fs.readFileSync(path.join(__dirname, '..', 'fly.toml'), 'utf8');
    const lines = toml.split('\n');
    const envStart = lines.findIndex((l) => /^\[env\]\s*$/.test(l));
    assert.ok(envStart >= 0, 'fly.toml has an [env] block');
    let envEnd = lines.findIndex((l, i) => i > envStart && /^\[/.test(l));
    if (envEnd < 0) envEnd = lines.length;
    const envBlock = lines.slice(envStart + 1, envEnd).map((l) => l.trim());

    const armed = envBlock.filter((l) => /^WELCOME_EMAIL_ENABLED = "true"$/.test(l));
    assert.equal(armed.length, 1, 'exactly one exact-"true" WELCOME_EMAIL_ENABLED line inside [env]');
    assert.equal(lines.filter((l) => /^\s*WELCOME_EMAIL_ENABLED\s*=/.test(l)).length, 1,
      'the flag is set once in the whole file (no later override)');

    assert.ok(!/EARNING_NOTIFICATIONS_ENABLED/.test(toml),
      'EARNING_NOTIFICATIONS_ENABLED must appear nowhere in fly.toml -- the unlock notification stays off, unchanged');
  });
});
