/**
 * lib/email.js — Magic-link email delivery via Resend (LW-1, BUILD-SPEC-LAUNCH-WAVE)
 *
 * Plain fetch against POST https://api.resend.com/emails — no SDK dependency.
 *
 * Env:
 *   RESEND_API_KEY — if unset, email delivery is disabled (dev mode: caller
 *                    falls back to console-logging the link).
 *   EMAIL_FROM     — sender, default 'Auxilo <login@auxilo.io>'.
 *
 * Failure contract: sendMagicLink() never throws. It returns
 * { ok: boolean, status?: number, error?: string }. Callers MUST still return
 * the neutral 200 response on failure (email-enumeration defense).
 *
 * Log hygiene: this module NEVER logs the verify URL or token. On failure it
 * logs only the status/error to stderr.
 */

'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

function emailEnabled() {
    return Boolean(process.env.RESEND_API_KEY);
}

/** Redact an email for logs: keep only the domain. */
function redactEmail(email) {
    const at = String(email).lastIndexOf('@');
    return at === -1 ? '<redacted>' : `<redacted>@${String(email).slice(at + 1)}`;
}

function buildBodies(verifyUrl) {
    const text = [
        'Sign in to Auxilo',
        '',
        'Click the link below to sign in. This link expires in 15 minutes and can only be used once.',
        '',
        verifyUrl,
        '',
        "If you didn't request this, you can safely ignore this email.",
    ].join('\n');

    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px">Sign in to Auxilo</h2>
  <p>Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
  <p style="margin:24px 0"><a href="${verifyUrl}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Sign in to Auxilo</a></p>
  <p style="color:#666;font-size:13px">If the button doesn't work, copy and paste this link:<br>${verifyUrl}</p>
  <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
</div>`;

    return { text, html };
}

function buildDeletionBodies(confirmUrl) {
    const text = [
        'Confirm Auxilo account deletion',
        '',
        'Open the link below to confirm deletion of your account data from live Auxilo systems. This link expires in 15 minutes and can only be used once.',
        '',
        confirmUrl,
        '',
        "If you didn't request this, you can safely ignore this email.",
    ].join('\n');

    const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 16px">Confirm account deletion</h2>
  <p>Open the button below to confirm deletion of your account data from live Auxilo systems. This link expires in <strong>15 minutes</strong> and can only be used once.</p>
  <p style="margin:24px 0"><a href="${confirmUrl}" style="background:#8b0000;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">Confirm account deletion</a></p>
  <p style="color:#666;font-size:13px">If the button doesn't work, copy and paste this link:<br>${confirmUrl}</p>
  <p style="color:#666;font-size:13px">If you didn't request this, you can safely ignore this email.</p>
</div>`;

    return { text, html };
}

async function sendEmail(email, subject, bodies, logLabel) {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };

    const from = process.env.EMAIL_FROM || 'Auxilo <login@auxilo.io>';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    try {
        const res = await fetch(RESEND_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to: [email], subject, ...bodies }),
            signal: controller.signal,
        });
        if (!res.ok) {
            console.error(`[email] delivery failed: ${res.status}`);
            return { ok: false, status: res.status };
        }
        console.log(`[email] ${logLabel} sent to ${redactEmail(email)}`);
        return { ok: true, status: res.status };
    } catch (err) {
        const reason = err && err.name === 'AbortError' ? 'timeout' : (err && err.message) || 'unknown error';
        console.error(`[email] delivery failed: ${reason}`);
        return { ok: false, error: reason };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Send a magic-link email via Resend.
 * @param {string} email - recipient
 * @param {string} verifyUrl - the magic-link verify URL (never logged)
 * @returns {Promise<{ok: boolean, status?: number, error?: string}>}
 */
async function sendMagicLink(email, verifyUrl) {
    const { text, html } = buildBodies(verifyUrl);
    return sendEmail(email, 'Your Auxilo sign-in link', { text, html }, 'magic link');
}

async function sendDeletionConfirmation(email, confirmUrl) {
    const { text, html } = buildDeletionBodies(confirmUrl);
    return sendEmail(email, 'Confirm your Auxilo account deletion', { text, html }, 'deletion confirmation');
}

module.exports = { sendMagicLink, sendDeletionConfirmation, emailEnabled, redactEmail };
