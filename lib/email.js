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
 *
 * Visual shell (LAYOUT-SHEET.md item 9): light ground, hosted-PNG wordmark +
 * text wordmark, one bulletproof table button, fallback link, footer. Values
 * below (colors, spacing, font stack) come from that sheet, not the earlier
 * build spec's structural placeholders.
 */

'use strict';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;

// Brand values per LAYOUT-SHEET.md item 9 (Ivory ground, Obsidian text, Aurum
// primary button, distinct red for the destructive/deletion tone).
const BRAND = {
    bg: '#FAFAF8',
    ink: '#0A0A0A',
    body: '#33343A',
    muted: '#55575E',
    hairline: '#E5E5E3',
    linkBg: '#F0EFEA',
    gold: '#C9A84C',
    red: '#B91C1C',
};

const FONT_STACK = "-apple-system,BlinkMacSystemFont,'Helvetica Neue',Helvetica,Arial,sans-serif";

function emailEnabled() {
    return Boolean(process.env.RESEND_API_KEY);
}

/** Redact an email for logs: keep only the domain. */
function redactEmail(email) {
    const at = String(email).lastIndexOf('@');
    return at === -1 ? '<redacted>' : `<redacted>@${String(email).slice(at + 1)}`;
}

/**
 * Escape a string for safe interpolation into HTML text content or into an
 * HTML attribute value (this entity set is sufficient for both contexts).
 * null/undefined become an empty string.
 */
function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isSafeButtonUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

/**
 * Render the shared Auxilo email shell: table-based layout, all styles
 * inline, no <style> block, no <script>, no SVG, no web font — Outlook-safe
 * per LAYOUT-SHEET.md item 9.
 *
 * `bodyHtml` and `footerHtml` are trusted HTML fragments assembled by the
 * caller, who is responsible for escaping every interpolated value inside
 * them; this function does not re-scan or alter either fragment.
 *
 * @param {object} opts
 * @param {string} opts.heading - plain text; escaped here.
 * @param {string} opts.bodyHtml - trusted HTML fragment (see contract above).
 * @param {{text: string, url: string}} [opts.button] - optional primary
 *   button. `text` is escaped. `url` is escaped for attribute context (so a
 *   `"` in it cannot break out of the href) and must start with `http://` or
 *   `https://`; any other scheme (e.g. `javascript:`) renders no button at
 *   all, rather than throwing.
 * @param {string} [opts.footerHtml] - trusted HTML fragment, same
 *   caller-escapes contract as bodyHtml. A plain "auxilo.io" link to
 *   https://auxilo.io is always appended after it.
 * @param {'danger'|undefined} [opts.tone] - button color. Default is the gold
 *   primary; 'danger' is the red used for account deletion. No other colors.
 * @returns {string} the full HTML fragment for the email body.
 */
function renderEmail({ heading, bodyHtml, button, footerHtml, tone }) {
    const safeButton = button && isSafeButtonUrl(button.url) ? button : null;
    const buttonBg = tone === 'danger' ? BRAND.red : BRAND.gold;
    const buttonTextColor = tone === 'danger' ? '#FFFFFF' : BRAND.ink;

    const buttonHtml = safeButton
        ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td bgcolor="${buttonBg}" style="background:${buttonBg};border-radius:4px;"><a href="${escapeHtml(safeButton.url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:${buttonTextColor};text-decoration:none;">${escapeHtml(safeButton.text)}</a></td></tr></table>`
        : '';

    const fallbackHtml = safeButton
        ? `<p style="font-size:13px;color:${BRAND.muted};line-height:1.6;margin:16px 0 4px;">If the button doesn't work, copy and paste this link:</p>
  <p style="font-size:12px;color:${BRAND.muted};word-break:break-all;background:${BRAND.linkBg};padding:8px 10px;border-radius:4px;margin:0 0 24px;">${escapeHtml(safeButton.url)}</p>`
        : '';

    return `<table role="presentation" width="100%" bgcolor="${BRAND.bg}" style="background:${BRAND.bg};margin:0;padding:0;"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;margin:0 auto;"><tr><td style="padding:40px 32px;">
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 32px;"><tr>
    <td style="padding:0;"><img src="https://auxilo.io/logo-square.png" width="28" height="28" alt="Auxilo" style="display:block;border:0;"></td>
    <td style="width:8px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="font-family:${FONT_STACK};font-size:20px;font-weight:700;color:${BRAND.ink};letter-spacing:-0.01em;">auxilo</td>
  </tr></table>
  <p style="font-size:24px;font-weight:700;color:${BRAND.ink};line-height:1.25;margin:0 0 16px;">${escapeHtml(heading)}</p>
  ${bodyHtml}
  ${buttonHtml}
  ${fallbackHtml}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;padding-top:20px;border-top:1px solid ${BRAND.hairline};"><tr><td style="font-size:12px;color:${BRAND.muted};line-height:1.6;">
    ${footerHtml || ''}
    <p style="margin:8px 0 0;font-size:12px;color:${BRAND.muted};line-height:1.6;"><a href="https://auxilo.io" style="color:${BRAND.muted};text-decoration:underline;">auxilo.io</a></p>
  </td></tr></table>
</td></tr></table>
</td></tr></table>`;
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

    const html = renderEmail({
        heading: 'Sign in to Auxilo',
        bodyHtml: `<p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>`,
        button: { text: 'Sign in to Auxilo', url: verifyUrl },
        footerHtml: `<p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>`,
    });

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

    const html = renderEmail({
        heading: 'Confirm account deletion',
        bodyHtml: `<p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">Open the button below to confirm deletion of your account data from live Auxilo systems. This link expires in <strong>15 minutes</strong> and can only be used once.</p>`,
        button: { text: 'Confirm account deletion', url: confirmUrl },
        footerHtml: `<p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>`,
        tone: 'danger',
    });

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

module.exports = {
    sendMagicLink,
    sendDeletionConfirmation,
    emailEnabled,
    redactEmail,
    escapeHtml,
    renderEmail,
};
