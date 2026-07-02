/**
 * lib/ops-alert.js — best-effort operational alerting via Resend.
 *
 * Purpose: when the process hits a fatal/uncaught error or the extraction-spend
 * circuit breaker trips, someone should find out WITHOUT watching `flyctl logs`.
 * This sends a short email to the ops recipient. It is intentionally defensive:
 *
 *   - NEVER throws (called from crash handlers — a throw here would mask the
 *     original error or crash Node ungracefully).
 *   - Rate-limited (ALERT_MIN_INTERVAL_MS) so a crash loop can't spam the inbox.
 *   - No-op when unconfigured: needs RESEND_API_KEY and OPS_ALERT_EMAIL. When
 *     either is missing it just logs a line and returns — safe in dev/CI.
 *
 * Env:
 *   RESEND_API_KEY   — shared with lib/email.js (already a Fly secret).
 *   OPS_ALERT_EMAIL  — recipient for ops alerts (set as a Fly secret; keeps the
 *                      personal address out of the public repo).
 *   EMAIL_FROM       — sender, default 'Auxilo Ops <login@auxilo.io>'.
 */

'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8_000;
const ALERT_MIN_INTERVAL_MS = 5 * 60_000; // at most one alert / 5 min

let _lastSentAt = 0;

/**
 * Fire a best-effort ops alert email. Never throws; returns a small result object.
 * @param {string} subject - short subject line (env/app prefix added)
 * @param {string} text - plain-text body
 * @returns {Promise<{ok: boolean, skipped?: string, status?: number, error?: string}>}
 */
async function sendOpsAlert(subject, text) {
    try {
        const apiKey = process.env.RESEND_API_KEY;
        const to = process.env.OPS_ALERT_EMAIL;
        if (!apiKey || !to) {
            console.warn('[ops-alert] not configured (need RESEND_API_KEY + OPS_ALERT_EMAIL) — alert not sent:', subject);
            return { ok: false, skipped: 'unconfigured' };
        }

        const now = Date.now();
        if (now - _lastSentAt < ALERT_MIN_INTERVAL_MS) {
            console.warn('[ops-alert] rate-limited (last alert <5m ago) — suppressed:', subject);
            return { ok: false, skipped: 'rate_limited' };
        }
        _lastSentAt = now;

        const from = process.env.EMAIL_FROM || 'Auxilo Ops <login@auxilo.io>';
        const host = process.env.BASE_URL || 'auxilo';
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
        try {
            const res = await fetch(RESEND_ENDPOINT, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from,
                    to: [to],
                    subject: `[Auxilo ALERT] ${subject}`,
                    text: `${text}\n\n— host: ${host}\n— time: ${new Date().toISOString()}`,
                }),
                signal: controller.signal,
            });
            if (!res.ok) {
                console.error(`[ops-alert] delivery failed: ${res.status}`);
                return { ok: false, status: res.status };
            }
            console.log(`[ops-alert] sent: ${subject}`);
            return { ok: true, status: res.status };
        } finally {
            clearTimeout(timer);
        }
    } catch (err) {
        // Swallow — this path must never throw.
        console.error('[ops-alert] send error (swallowed):', err && err.message);
        return { ok: false, error: (err && err.message) || 'unknown' };
    }
}

module.exports = { sendOpsAlert };
