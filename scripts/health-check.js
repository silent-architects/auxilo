#!/usr/bin/env node
'use strict';

/**
 * Auxilo Health Check — Simple Exit-Code Script (S21-5)
 *
 * PM2 health check script. No dependencies — uses only native http module.
 *
 * Behavior:
 *   - HTTP GET to http://localhost:3000/health
 *   - If response status === 200 AND response time <= 5000ms → exit(0) (healthy)
 *   - If response status !== 200 OR response time > 5000ms → exit(1) (unhealthy)
 *   - If connection error or timeout → exit(1) (unhealthy)
 *
 * PM2 uses the exit code to determine health. This script is referenced
 * in ecosystem.config.js and can be used with PM2's --health-check-script option.
 *
 * Usage:
 *   node scripts/health-check.js
 *   echo $?  # 0 = healthy, 1 = unhealthy
 */

const http = require('http');

const HOST = process.env.HEALTH_CHECK_HOST || 'localhost';
const PORT = parseInt(process.env.HEALTH_CHECK_PORT, 10) || 3000;
const TIMEOUT_MS = 5000; // 5 second timeout — matches spec

const startTime = Date.now();

const req = http.request(
  {
    hostname: HOST,
    port: PORT,
    path: '/health',
    method: 'GET',
    timeout: TIMEOUT_MS,
  },
  (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      const elapsed = Date.now() - startTime;

      // Check response time
      if (elapsed > TIMEOUT_MS) {
        process.exit(1);
      }

      // Check status code
      if (res.statusCode !== 200) {
        process.exit(1);
      }

      // Optionally verify response body is valid JSON with status: 'ok'
      try {
        const data = JSON.parse(body);
        if (data.status !== 'ok') {
          process.exit(1);
        }
      } catch {
        process.exit(1);
      }

      // Healthy
      process.exit(0);
    });
  }
);

req.on('error', () => {
  process.exit(1);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});

req.end();
