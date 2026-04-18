#!/usr/bin/env node

/**
 * scripts/admin.js — Auxilo Admin CLI (P2.1a §3.6)
 *
 * Command dispatcher for administrative operations.
 *
 * Usage:
 *   node scripts/admin.js extract:reset-kill-switch --reason "<incident-summary>" --acknowledged-by <operator>
 *
 * @module admin
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_FILE = path.join(__dirname, '..', 'data', 'audit-extractions.jsonl');
const KILL_SWITCH_RESET_FILE = path.join(__dirname, '..', 'data', '.extract-kill-switch-reset');

// ─── Audit Log Helpers ──────────────────────────────────────────────────────

function readLastHash() {
  const GENESIS = 'sha256:genesis';
  if (!fs.existsSync(AUDIT_FILE)) return GENESIS;
  const content = fs.readFileSync(AUDIT_FILE, 'utf-8').trim();
  if (!content) return GENESIS;
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length > 0) {
      try {
        const row = JSON.parse(line);
        return row.entry_hash || GENESIS;
      } catch { continue; }
    }
  }
  return GENESIS;
}

function appendAuditRow(rowData) {
  const prevHash = readLastHash();
  const row = {
    audit_id: 'audit_' + crypto.randomBytes(12).toString('hex'),
    prev_hash: prevHash,
    ts: new Date().toISOString(),
    ...rowData,
  };
  const payload = JSON.stringify(row) + prevHash;
  row.entry_hash = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(row) + '\n', 'utf-8');
  return row;
}

// ─── Commands ───────────────────────────────────────────────────────────────

const commands = {
  /**
   * extract:reset-kill-switch — Reset the $100/day circuit breaker kill switch.
   *
   * Required flags:
   *   --reason <incident-summary>   Description of the incident that triggered the reset.
   *   --acknowledged-by <operator>  Name or ID of the operator performing the reset.
   *
   * Behavior:
   *   1. Writes a sentinel file that the running server process picks up on next /extract request.
   *   2. Writes a hash-chained audit row with action="kill_switch_reset".
   *   3. Exits 0 on success.
   *
   * @param {object} args - Parsed CLI arguments
   */
  'extract:reset-kill-switch'(args) {
    if (!args.reason || !args['acknowledged-by']) {
      console.error('Usage: node scripts/admin.js extract:reset-kill-switch --reason "<incident-summary>" --acknowledged-by <operator>');
      process.exit(1);
    }

    const reason = args.reason;
    const acknowledgedBy = args['acknowledged-by'];

    // Write sentinel file for server to pick up
    fs.writeFileSync(KILL_SWITCH_RESET_FILE, JSON.stringify({
      reset_at: new Date().toISOString(),
      reason,
      acknowledged_by: acknowledgedBy,
    }), 'utf-8');

    // Write audit row
    const auditRow = appendAuditRow({
      action: 'kill_switch_reset',
      reason,
      acknowledged_by: acknowledgedBy,
      account_id: 'admin',
      consent_version: null,
      source: { type: 'cli', session_id: `cli_${Date.now()}` },
      transcript_sha256: '',
      transcript_length: 0,
      scrubber_version: 'n/a',
      client_scrub_matches: [],
      server_scrub_matches: [],
      provider: 'none',
      model: 'none',
      usage: { input_tokens: 0, output_tokens: 0 },
      cost_usd: 0,
      quality_pass_count: 0,
      quality_fail_count: 0,
      published_learning_ids: [],
      mode: 'admin',
    });

    console.log(`Kill switch reset by ${acknowledgedBy}.`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Audit ID: ${auditRow.audit_id}`);
    console.log(`  Hash: ${auditRow.entry_hash}`);
    console.log(`  Sentinel written to: ${KILL_SWITCH_RESET_FILE}`);
    process.exit(0);
  },

  /**
   * audit:verify — Walk all audit log files and verify hash chain integrity.
   *
   * Behavior:
   *   1. Walks all data/audit-extractions.*.jsonl files in chronological order.
   *   2. Recomputes each row's entry_hash from the row data + prev_hash.
   *   3. Verifies each row's prev_hash matches the previous row's entry_hash.
   *   4. Reports any chain breaks or hash mismatches.
   *   5. Exits 0 if chain is valid, 1 if any integrity errors found.
   *
   * @param {object} args - Parsed CLI arguments (none required)
   */
  'audit:verify'(args) {
    const { verifyAuditChain } = require('../lib/extraction-audit-writer');
    const result = verifyAuditChain();

    console.log(`Audit chain verification: ${result.total} row(s) checked`);

    if (result.valid) {
      console.log('✓ Chain is VALID — no integrity errors found.');
      process.exit(0);
    } else {
      console.log(`✗ Chain BROKEN — ${result.errors.length} error(s) found:`);
      for (const err of result.errors) {
        console.log(`  ${err.file}:${err.line} — ${err.error}`);
      }
      process.exit(1);
    }
  },
};

// ─── CLI Parser ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  let command = null;
  let i = 2; // skip node and script path

  // First non-flag argument is the command
  if (argv[i] && !argv[i].startsWith('--')) {
    command = argv[i];
    i++;
  }

  // Parse --flag value pairs
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('--')) {
        args[key] = nextArg;
        i += 2;
      } else {
        args[key] = true;
        i++;
      }
    } else {
      i++;
    }
  }

  return { command, args };
}

// ─── Main ───────────────────────────────────────────────────────────────────

const { command, args } = parseArgs(process.argv);

if (!command) {
  console.log('Auxilo Admin CLI');
  console.log('');
  console.log('Available commands:');
  for (const cmd of Object.keys(commands)) {
    console.log(`  node scripts/admin.js ${cmd}`);
  }
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}`);
  console.error(`Available commands: ${Object.keys(commands).join(', ')}`);
  process.exit(1);
}

commands[command](args);
