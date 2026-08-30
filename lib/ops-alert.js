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
 *   - No-op when unconfigured unless a caller explicitly requests the
 *     subject-only local fallback. Server/dev callers keep the old behavior.
 *
 * Env:
 *   RESEND_API_KEY   — shared with lib/email.js (already a Fly secret).
 *   OPS_ALERT_EMAIL  — recipient for ops alerts (set as a Fly secret; keeps the
 *                      personal address out of the public repo).
 *   EMAIL_FROM       — sender, default 'Auxilo Ops <login@auxilo.io>'.
 */

'use strict';

const { spawn } = require('child_process');

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 8_000;
const ALERT_MIN_INTERVAL_MS = 5 * 60_000; // at most one alert / 5 min PER CATEGORY

// Reviewer debt (Wave 1, 2026-07-19): the rate limit is PER CATEGORY, not
// global — a routine pending-review digest must never consume the 5-minute
// slot a crash alert needs. Categories are independent sliding windows.
// Known categories in use: crash, extraction-spend, pending-review, ofac,
// geo-embargo, unlock-refund; anything uncategorized shares 'default'.
const _lastSentAtByCategory = new Map();

/**
 * Pure-ish limiter decision: true → suppressed (inside the window), false →
 * allowed (and the category window is armed). Exported for tests.
 */
function _categoryRateLimited(category, now = Date.now()) {
    const key = (typeof category === 'string' && category) ? category : 'default';
    const last = _lastSentAtByCategory.get(key) || 0;
    if (now - last < ALERT_MIN_INTERVAL_MS) return true;
    _lastSentAtByCategory.set(key, now);
    return false;
}

/** Test hook: clear all category windows. */
function _resetOpsAlertStateForTests() {
    _lastSentAtByCategory.clear();
}

function isOpsAlertConfigured(env = process.env) {
    return Boolean(env && env.RESEND_API_KEY && env.OPS_ALERT_EMAIL);
}

/**
 * Best-effort macOS fallback for client-side alerts. The notification is
 * deliberately subject-only: caller bodies may contain operational context
 * that does not belong on a lock screen. Never throws.
 */
function notifyLocalOpsAlert(subject, opts = {}) {
    try {
        const platform = opts.platform || process.platform;
        const env = opts.env || process.env;
        if (platform !== 'darwin') return { ok: false, skipped: 'unsupported-platform' };
        if (env.AUXILO_NO_NOTIFY === '1') return { ok: false, skipped: 'disabled' };

        const safeSubject = String(subject || 'Auxilo operational alert').slice(0, 180);
        const message = `${safeSubject} — run claude auth login`;
        const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn;
        const child = spawnImpl('/usr/bin/osascript', [
            '-e', `display notification ${JSON.stringify(message)} with title "Auxilo"`,
        ], { stdio: 'ignore', detached: true });
        child.unref();
        child.on('error', () => { /* fail-silent */ });
        return { ok: true };
    } catch (err) {
        return { ok: false, error: (err && err.message) || 'unknown' };
    }
}

/**
 * Fire a best-effort ops alert email. Never throws; returns a small result object.
 * @param {string} subject - short subject line (env/app prefix added)
 * @param {string} text - plain-text body
 * @param {{category?: string, omitHost?: boolean, localFallback?: boolean}} [opts] - rate-limit bucket
 *        (default 'default'); categories are throttled independently. Set
 *        omitHost when the caller supplies its own identity-safe context.
 * @returns {Promise<{ok: boolean, skipped?: string, status?: number, error?: string}>}
 */
async function sendOpsAlert(subject, text, opts = {}) {
    try {
        const env = opts.env || process.env;
        const apiKey = env.RESEND_API_KEY;
        const to = env.OPS_ALERT_EMAIL;
        if (!isOpsAlertConfigured(env)) {
            console.warn('[ops-alert] not configured (need RESEND_API_KEY + OPS_ALERT_EMAIL) — alert not sent:', subject);
            if (opts.localFallback === true) {
                const localNotifier = typeof opts.notifyLocalOpsAlert === 'function'
                    ? opts.notifyLocalOpsAlert
                    : notifyLocalOpsAlert;
                try {
                    const local = localNotifier(subject, {
                        env,
                        ...(opts.platform && { platform: opts.platform }),
                        ...(opts.spawnImpl && { spawnImpl: opts.spawnImpl }),
                    });
                    if (local && local.ok) {
                        return { ok: false, skipped: 'unconfigured', localFallback: true };
                    }
                } catch { /* local fallback is fail-silent */ }
            }
            return { ok: false, skipped: 'unconfigured' };
        }

        const category = (opts && typeof opts.category === 'string' && opts.category) || 'default';
        if (_categoryRateLimited(category)) {
            console.warn(`[ops-alert] rate-limited (category '${category}' alerted <5m ago) — suppressed:`, subject);
            return { ok: false, skipped: 'rate_limited' };
        }

        const from = env.EMAIL_FROM || 'Auxilo Ops <login@auxilo.io>';
        const host = env.BASE_URL || 'auxilo';
        const footer = opts.omitHost
            ? `\n\n— time: ${new Date().toISOString()}`
            : `\n\n— host: ${host}\n— time: ${new Date().toISOString()}`;
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
                    text: `${text}${footer}`,
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

module.exports = {
    sendOpsAlert,
    isOpsAlertConfigured,
    notifyLocalOpsAlert,
    ALERT_MIN_INTERVAL_MS,
    // Exported for testing only:
    _categoryRateLimited,
    _resetOpsAlertStateForTests,
};
