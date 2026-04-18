#!/usr/bin/env node
/**
 * deploy.js — Push Phase 0.1 (accounts system) to Conway VM
 *
 * Usage:
 *   X_PAYMENT="<token>" SESSION_SECRET="<secret>" node deploy.js
 *
 * What it does:
 *   1. Uploads lib/accounts.js   → /app/lib/accounts.js  (base64 via /files)
 *   2. Uploads server.js         → /app/server.js         (base64 via /files)
 *   3. Kills existing server process
 *   4. npm install --production inside /app
 *   5. Starts server with nohup + SESSION_SECRET injected
 *
 * Conway seed-knowledge references:
 *   lrn_conway01: Content-Type: application/json is required on /exec
 *   lrn_conway03: node_modules must be installed inside the VM — never copy from local
 *   lrn_conway04: nohup + & to survive API session disconnect
 *   lrn_conway02: Sandbox ID stays constant — reconstruct URL from ID
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────

// ⚠️ Sandbox ID: Conway rotates these. If the deploy fails with
// "Sandbox not found or access denied", run:
//   curl -sS -H "X-API-Key: $X_PAYMENT" https://api.conway.tech/v1/sandboxes
// and update the ID below from the entry named "auxilo".
const SANDBOX_ID = 'dc034f2b068cfe25bd0b46a281ae656c';

// Conway management API base (not the public sandbox URL)
// Adjust if your Conway account uses a different base URL.
const CONWAY_API = process.env.CONWAY_API_BASE ||
    `https://api.conway.tech/v1/sandboxes/${SANDBOX_ID}`;

const PAYMENT_HEADER = process.env.X_PAYMENT;
const SESSION_SECRET = process.env.SESSION_SECRET;

// ─── Pre-flight checks ────────────────────────────────────────────────────────

if (!PAYMENT_HEADER) {
    console.error('❌  Missing X_PAYMENT env var. Usage:');
    console.error('    X_PAYMENT="<token>" SESSION_SECRET="<secret>" node deploy.js');
    process.exit(1);
}

if (!SESSION_SECRET) {
    console.error('❌  Missing SESSION_SECRET env var. This is required for JWT signing on the VM.');
    console.error('    SESSION_SECRET must be a strong random string (32+ bytes recommended).');
    process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const authHeaders = {
    'Content-Type': 'application/json',
    'X-API-Key': PAYMENT_HEADER,
};

async function exec(command, label) {
    const label_ = label || command.slice(0, 60);
    process.stdout.write(`  ⏳ ${label_}...`);

    const res = await fetch(`${CONWAY_API}/exec`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ command }),
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        process.stdout.write(' ❌\n');
        throw new Error(`exec failed (${res.status}): ${body}`);
    }

    const data = await res.json().catch(() => ({}));
    process.stdout.write(' ✅\n');
    return data;
}

async function uploadFile(localPath, remotePath) {
    const content = fs.readFileSync(localPath);
    const b64 = content.toString('base64');
    const remoteDir = remotePath.substring(0, remotePath.lastIndexOf('/'));

    process.stdout.write(`  ⏳ Uploading ${path.basename(localPath)} → ${remotePath}...`);

    // Ensure remote directory exists
    await fetch(`${CONWAY_API}/exec`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ command: `mkdir -p ${remoteDir}` }),
    });

    // Upload via /files endpoint (base64-encoded body per Conway API spec)
    const res = await fetch(`${CONWAY_API}/files`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
            path: remotePath,
            content: b64,
            encoding: 'base64',
        }),
    });

    if (!res.ok) {
        // Fallback: write via exec + printf (avoids heredoc quoting issues)
        // Split into chunks to stay under command-line limits for large files
        process.stdout.write(' (falling back to exec)...');
        await exec(`printf '%s' '${b64}' | base64 -d > ${remotePath}`,
            `write ${path.basename(localPath)} via base64 decode`);
    } else {
        process.stdout.write(' ✅\n');
    }
}

// ─── Deploy ───────────────────────────────────────────────────────────────────

// ─── File manifest ────────────────────────────────────────────────────────────
// Source of truth for what gets deployed. Keep this list in sync with
// server.js `require('./lib/...')` statements + any public assets the
// server reads at startup (openapi.json, agent.json, etc.).
//
// Client-only files (scripts/, jobs/, test/) are intentionally absent —
// those run on the builder's machine via launchd, not on the Conway VM.

const MANIFEST = [
    // Top-level
    ['server.js',                         '/app/server.js'],
    ['mcp-server.js',                     '/app/mcp-server.js'],
    ['package.json',                      '/app/package.json'],
    ['model_config.json',                 '/app/model_config.json'],
    ['openapi.json',                      '/app/openapi.json'],
    ['skills.json',                       '/app/skills.json'],
    ['.well-known/agent.json',            '/app/.well-known/agent.json'],

    // Core libs (auth, marketplace, payouts)
    ['lib/accounts.js',                   '/app/lib/accounts.js'],
    ['lib/admin-auth.js',                 '/app/lib/admin-auth.js'],
    ['lib/credits.js',                    '/app/lib/credits.js'],
    ['lib/earnings.js',                   '/app/lib/earnings.js'],
    ['lib/eip712.js',                     '/app/lib/eip712.js'],
    ['lib/extractor.js',                  '/app/lib/extractor.js'],
    ['lib/openclaw-adapter.js',           '/app/lib/openclaw-adapter.js'],
    ['lib/pricing.js',                    '/app/lib/pricing.js'],
    ['lib/renderly.js',                   '/app/lib/renderly.js'],
    ['lib/sensitivity-filter.js',         '/app/lib/sensitivity-filter.js'],
    ['lib/stripe.js',                     '/app/lib/stripe.js'],
    ['lib/tx-manager.js',                 '/app/lib/tx-manager.js'],
    ['lib/wal.js',                        '/app/lib/wal.js'],
    ['lib/wallet-lock.js',                '/app/lib/wallet-lock.js'],
    ['lib/x402-local.js',                 '/app/lib/x402-local.js'],

    // P2.1a autonomous extraction pipeline
    ['lib/extraction-audit-writer.js',    '/app/lib/extraction-audit-writer.js'],
    ['lib/extraction-consent-reader.js',  '/app/lib/extraction-consent-reader.js'],
    ['lib/providers/provider.interface.js', '/app/lib/providers/provider.interface.js'],
    ['lib/providers/anthropic.js',        '/app/lib/providers/anthropic.js'],
];

async function deploy() {
    console.log(`\n🚀 Deploying Auxilo to Conway sandbox ${SANDBOX_ID}\n`);
    console.log(`── Step 1: Upload ${MANIFEST.length} source files ───────────`);

    for (const [local, remote] of MANIFEST) {
        await uploadFile(path.join(__dirname, local), remote);
    }

    console.log('\n── Step 2: Install dependencies ─────────────────────');
    await exec('cd /app && npm install --production', 'npm install --production');

    console.log('\n── Step 3: Restart server ───────────────────────────');
    // Kill old process gracefully, then start fresh with nohup
    // SESSION_SECRET is exported inline — survives nohup
    const startCmd = [
        'pkill -f "node server.js" || true',
        'sleep 1',
        `cd /app && SESSION_SECRET='${SESSION_SECRET}' nohup node server.js > /tmp/server.log 2>&1 &`,
        'sleep 2',
        'pgrep -fa "node server.js" && echo "server running" || echo "WARNING: server not found in process list"',
    ].join(' && ');

    await exec(startCmd, 'kill old + start fresh server with nohup');

    console.log('\n── Step 4: Verify process is alive ──────────────────');
    await exec('pgrep -fa "node server.js"', 'confirm server PID');

    console.log('\n🎉 Deployment complete!');
    console.log(`\nSandbox URL: https://3000-${SANDBOX_ID}.life.conway.tech`);
    console.log('Run live validation: npx --yes mocha tests/test-a-01-account.js (with server running)\n');
}

deploy().catch((err) => {
    console.error('\n❌ Deployment failed:', err.message);
    process.exit(1);
});
