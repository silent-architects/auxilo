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

// W3: fixtures (example.com/.org/.net, and anything ending .test/.invalid/
// .localhost) are never real mailboxes. Applied inside the two new send
// functions below (sendWelcomeEmail, sendEarningNotification) only — the two
// pre-existing send functions (sendMagicLink, sendDeletionConfirmation) are
// unchanged, per the build ruling.
function isFixtureEmailDomain(email) {
    const at = String(email == null ? '' : email).lastIndexOf('@');
    if (at === -1) return false;
    const domain = String(email).slice(at + 1).toLowerCase();
    return domain === 'example.com' || domain === 'example.org' || domain === 'example.net' ||
        domain.endsWith('.test') || domain.endsWith('.invalid') || domain.endsWith('.localhost');
}

/**
 * Learning titles are contributor-supplied and untrusted (see
 * UNTRUSTED_CONTENT_ADVISORY elsewhere in the codebase). Strip control
 * characters and line breaks (defends against a title forging extra
 * "From:"-looking lines in a plain-text mail client, or faking a link) and
 * cap length — applied BEFORE escapeHtml for the HTML part, and used as-is
 * for the plain-text part. A title is never rendered as a link in either
 * format.
 *
 * Review finding L5: the C0 control range does not cover every character a
 * mail client can render as a line break or reorder text with — also strips
 * NEL (U+0085), LINE/PARAGRAPH SEPARATOR (U+2028/U+2029), and the
 * bidirectional-override/isolate characters (U+202A-U+202E, U+2066-U+2069).
 */
function sanitizeTitleText(title) {
    return String(title == null ? '' : title)
        .replace(/[\r\n\u0000-\u001F\u0085\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, ' ')
        .slice(0, 200);
}

function fmtUsd(n) {
    const num = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return '$' + num.toFixed(2);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

// UTC, not local time — deterministic across test/CI environments.
function formatAccrualDate(ts) {
    const d = new Date(ts);
    return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function unlockCountLabel(n) {
    return n === 1 ? '1 unlock' : `${n} unlocks`;
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
 * @returns {string} the full HTML document for the email (review finding
 *   A4: `<!doctype html>`, `<html lang="en">`, a `<head>` with
 *   `<meta charset="utf-8">`, and a `<body>` — a mail client renders this as
 *   its own document, so it needs a declared language like any other page).
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

    return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:${BRAND.bg};"><table role="presentation" width="100%" bgcolor="${BRAND.bg}" style="background:${BRAND.bg};margin:0;padding:0;"><tr><td align="center">
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
</td></tr></table></body></html>`;
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
        '',
        // L12 (REGISTER-B2-REV2.md E-01/E-02).
        'Sent by Auxilo, auxilo.io. For help, write to support@auxilo.io.',
    ].join('\n');

    const html = renderEmail({
        heading: 'Sign in to Auxilo',
        bodyHtml: `<p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.</p>`,
        button: { text: 'Sign in to Auxilo', url: verifyUrl },
        // L12 (REGISTER-B2-REV2.md E-01/E-02): add the shared footer line.
        footerHtml: `<p style="margin:0 0 12px;font-size:12px;color:${BRAND.muted};line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>
  <p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">Sent by Auxilo, auxilo.io. For help, write to support@auxilo.io.</p>`,
    });

    return { text, html };
}

function buildDeletionBodies(confirmUrl) {
    const text = [
        'Confirm Auxilo account deletion',
        '',
        // L12: the plain-text part's "Open the link below" is correct and KEPT.
        'Open the link below to confirm deletion of your account data from live Auxilo systems. This link expires in 15 minutes and can only be used once.',
        '',
        confirmUrl,
        '',
        "If you didn't request this, you can safely ignore this email.",
        '',
        // L12 (REGISTER-B2-REV2.md E-01/E-04).
        'Sent by Auxilo, auxilo.io. For help, write to support@auxilo.io.',
    ].join('\n');

    const html = renderEmail({
        heading: 'Confirm account deletion',
        // L12: "Open the button below" -> "Click the button below" (HTML only).
        bodyHtml: `<p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">Click the button below to confirm deletion of your account data from live Auxilo systems. This link expires in <strong>15 minutes</strong> and can only be used once.</p>`,
        button: { text: 'Confirm account deletion', url: confirmUrl },
        // L12 (REGISTER-B2-REV2.md E-01/E-04): add the shared footer line.
        footerHtml: `<p style="margin:0 0 12px;font-size:12px;color:${BRAND.muted};line-height:1.6;">If you didn't request this, you can safely ignore this email.</p>
  <p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">Sent by Auxilo, auxilo.io. For help, write to support@auxilo.io.</p>`,
        tone: 'danger',
    });

    return { text, html };
}

/**
 * Welcome email (W3, dark behind WELCOME_EMAIL_ENABLED — see server.js/
 * lib/accounts.js for the gate). Copy per REGISTER-B2-REV2.md rows E-10 to
 * E-21. No earnings clause (GOV-4 Q10: none owed here, so no paused-rail
 * strip and no not-guaranteed disclaimer are owed either — both are CUT
 * per E-18/E-19/E-20). Static copy only — no interpolated values beyond the
 * connect URL, which is server-generated, never contributor-controlled.
 */
function buildWelcomeEmailBodies(connectUrl) {
    const preheader = 'One command connects your agent. Here is what happens after that.';

    const bodyHtml = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
  <p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">When your agent asks Auxilo, signed in to your account, anything you have published comes back free, so it does not have to work out the same fix twice.</p>
  <p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 8px;">If you have not run it yet, your next step is one command in your terminal.</p>
  <p style="font-size:13px;font-family:ui-monospace,'JetBrains Mono',monospace;color:${BRAND.ink};background:${BRAND.linkBg};padding:10px 14px;border-radius:4px;margin:0 0 24px;">npx auxilo setup</p>`;

    const footerHtml = `<p style="margin:0 0 12px;font-size:13px;color:${BRAND.muted};line-height:1.6;">Extraction stays off until you turn it on. Nothing your agent extracts goes live without your approval, which you give one learning at a time or in advance in your dashboard.</p>
  <p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">You are getting this because you signed in to Auxilo for the first time. For help, write to support@auxilo.io.</p>`;

    const html = renderEmail({
        heading: 'Welcome to Auxilo',
        bodyHtml,
        button: { text: 'Get the Setup Command', url: connectUrl },
        footerHtml,
    });

    const text = [
        'Welcome to Auxilo',
        '',
        'When your agent asks Auxilo, signed in to your account, anything you have published comes back free, so it does not have to work out the same fix twice.',
        '',
        'If you have not run it yet, your next step is one command in your terminal.',
        'npx auxilo setup',
        '',
        `Get the Setup Command: ${connectUrl}`,
        '',
        'Extraction stays off until you turn it on. Nothing your agent extracts goes live without your approval, which you give one learning at a time or in advance in your dashboard.',
        '',
        'You are getting this because you signed in to Auxilo for the first time. For help, write to support@auxilo.io.',
    ].join('\n');

    return { text, html };
}

// Shared small-print + footer for both earning-notification templates
// (REGISTER-B2-REV2.md E-35/E-46, E-36/E-47). The paused-rail sentence is
// required; the not-guaranteed disclaimer is CUT here — GOV-4 Q10 rules it
// is not owed for a factual report of a past accrual (the dashboard is the
// shipped precedent: "Your share (accrued)" carries the rail, not the
// disclaimer). Never uses `paid`, `payout`, `sent` or `deposited`.
function earningEmailFooterHtml(prefsUrl, plural) {
    const stopSentence = plural
        ? 'You get this email when other agents unlock learnings you published.'
        : 'You get this email when another agent unlocks a learning you published.';
    const safePrefsUrl = escapeHtml(prefsUrl);
    return `<p style="margin:0 0 12px;font-size:12px;color:${BRAND.muted};line-height:1.6;">Earnings accrue now. <a href="https://auxilo.io/status" style="color:${BRAND.muted};">Withdrawals open soon.</a></p>
  <p style="margin:0;font-size:12px;color:${BRAND.muted};line-height:1.6;">${stopSentence} To stop these emails, go to <a href="${safePrefsUrl}" style="color:${BRAND.muted};">${safePrefsUrl}</a> or turn off Unlock emails in your dashboard. For help, write to support@auxilo.io.</p>`;
}

function earningEmailFooterText(prefsUrl, plural) {
    const stopSentence = plural
        ? 'You get this email when other agents unlock learnings you published.'
        : 'You get this email when another agent unlocks a learning you published.';
    return [
        'Earnings accrue now. Withdrawals open soon, and auxilo.io/status shows where things stand.',
        '',
        `${stopSentence} To stop these emails, go to ${prefsUrl} or turn off Unlock emails in your dashboard. For help, write to support@auxilo.io.`,
    ].join('\n');
}

/**
 * Single-unlock earning-notification email (REGISTER-B2-REV2.md E-30 to
 * E-36). Sent when exactly one accrual is due. `title` is untrusted
 * (contributor-supplied) — sanitized (control chars stripped, length capped)
 * before either format, and HTML-escaped for the HTML part; never rendered
 * as a link or placed inside an attribute. `amountUsd` is the ledger's
 * recorded contributor_earned for that one unlock (never recomputed from
 * list price). Never identifies the buyer.
 */
function buildEarningSingleBodies({ title, amountUsd, totalAccrued, prefsUrl }) {
    const safeTitle = sanitizeTitleText(title);
    const amount = fmtUsd(amountUsd);
    const total = fmtUsd(totalAccrued);
    const preheader = `Your share, ${amount}, accrued to your Auxilo account.`;

    const bodyHtml = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
  <p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 24px;">Another agent unlocked <strong>${escapeHtml(safeTitle)}</strong>. Your share, ${amount}, accrued to your Auxilo account. Your total accrued is now ${total}.</p>`;

    const html = renderEmail({
        heading: 'Your Share Accrued',
        bodyHtml,
        button: { text: 'View Your Dashboard', url: 'https://auxilo.io/dashboard' },
        footerHtml: earningEmailFooterHtml(prefsUrl, false),
    });

    const text = [
        'Your Share Accrued',
        '',
        `Another agent unlocked ${safeTitle}. Your share, ${amount}, accrued to your Auxilo account. Your total accrued is now ${total}.`,
        '',
        'View Your Dashboard: https://auxilo.io/dashboard',
        '',
        earningEmailFooterText(prefsUrl, false),
    ].join('\n');

    return { subject: 'Another agent unlocked your learning', text, html };
}

/**
 * Digest earning-notification email (REGISTER-B2-REV2.md E-40 to E-47).
 * Sent when 2+ accruals are due in one flush; a single queued item always
 * uses buildEarningSingleBodies instead (E-40's own note: "When unlock_count
 * is 1, send the single template"). `items` is an array of
 * {learningId, title, amountUsd, ts} queued by lib/earning-notifications.js.
 */
function buildEarningDigestBodies({ items, totalAccrued, prefsUrl }) {
    const unlockCount = items.length;
    const amountSum = items.reduce((s, i) => s + (i.amountUsd || 0), 0);
    const amount = fmtUsd(amountSum);
    const total = fmtUsd(totalAccrued);
    const sinceTs = items.reduce((min, i) => Math.min(min, i.ts || Date.now()), items[0].ts || Date.now());
    const sinceDate = formatAccrualDate(sinceTs);
    const preheader = `Your share, ${amount}, accrued to your Auxilo account.`;

    // Group by learning, preserving first-seen order — one row per learning
    // (E-44), never one row per raw unlock event.
    const byLearning = new Map();
    for (const item of items) {
        const key = item.learningId || item.title;
        if (!byLearning.has(key)) {
            byLearning.set(key, { title: sanitizeTitleText(item.title), count: 0, amount: 0 });
        }
        const g = byLearning.get(key);
        g.count += 1;
        g.amount += (item.amountUsd || 0);
    }
    const rows = Array.from(byLearning.values());

    const rowsHtml = rows.map((g) =>
        `<li>${escapeHtml(g.title)} &middot; ${unlockCountLabel(g.count)} &middot; ${fmtUsd(g.amount)}</li>`
    ).join('');
    const rowsText = rows.map((g) =>
        `- ${g.title} · ${unlockCountLabel(g.count)} · ${fmtUsd(g.amount)}`
    ).join('\n');

    const bodyHtml = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</div>
  <p style="font-size:15px;line-height:1.6;color:${BRAND.body};margin:0 0 16px;">Since ${sinceDate}, other agents unlocked your learnings ${unlockCount} times. Your share, ${amount}, accrued to your Auxilo account. Your total accrued is now ${total}.</p>
  <ul style="font-size:14px;line-height:1.8;color:${BRAND.body};margin:0 0 24px;padding-left:20px;">${rowsHtml}</ul>`;

    const html = renderEmail({
        heading: 'Your Share Accrued',
        bodyHtml,
        button: { text: 'View Your Dashboard', url: 'https://auxilo.io/dashboard' },
        footerHtml: earningEmailFooterHtml(prefsUrl, true),
    });

    const text = [
        'Your Share Accrued',
        '',
        `Since ${sinceDate}, other agents unlocked your learnings ${unlockCount} times. Your share, ${amount}, accrued to your Auxilo account. Your total accrued is now ${total}.`,
        '',
        rowsText,
        '',
        'View Your Dashboard: https://auxilo.io/dashboard',
        '',
        earningEmailFooterText(prefsUrl, true),
    ].join('\n');

    return { subject: `${unlockCount} new unlocks of your learnings`, text, html };
}

async function sendEmail(email, subject, bodies, logLabel, options = {}) {
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
            // W3: reply_to is set for the welcome and earning-notification
            // emails only (via options.replyTo, passed by sendWelcomeEmail /
            // sendEarningNotification below) — the sender address itself
            // (`from`) and the two pre-existing emails are unchanged.
            body: JSON.stringify({
                from, to: [email], subject,
                ...(options && options.replyTo ? { reply_to: options.replyTo } : {}),
                ...bodies,
            }),
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

/**
 * Welcome email (W3, dark). Fixture-domain recipients are refused before any
 * network call. Reply-to is support@auxilo.io (row E-10) — the sender
 * address itself is unchanged.
 */
async function sendWelcomeEmail(email, connectUrl) {
    if (isFixtureEmailDomain(email)) return { ok: false, error: 'fixture domain' };
    const { text, html } = buildWelcomeEmailBodies(connectUrl);
    return sendEmail(email, 'Welcome to Auxilo', { text, html }, 'welcome', { replyTo: 'support@auxilo.io' });
}

/**
 * Earning-notification email (W3, dark). Dispatches to the single-unlock
 * template for exactly one queued item, or the digest template for 2+ (per
 * E-40's own rule). Fixture-domain recipients are refused before any network
 * call. Reply-to is support@auxilo.io, same as the welcome email.
 */
async function sendEarningNotification(email, { items, totalAccrued, prefsUrl }) {
    if (isFixtureEmailDomain(email)) return { ok: false, error: 'fixture domain' };
    if (!Array.isArray(items) || items.length === 0) return { ok: false, error: 'no items' };
    const built = items.length === 1
        ? buildEarningSingleBodies({ title: items[0].title, amountUsd: items[0].amountUsd, totalAccrued, prefsUrl })
        : buildEarningDigestBodies({ items, totalAccrued, prefsUrl });
    return sendEmail(email, built.subject, { text: built.text, html: built.html }, 'earning notification', { replyTo: 'support@auxilo.io' });
}

module.exports = {
    sendMagicLink,
    sendDeletionConfirmation,
    sendWelcomeEmail,
    sendEarningNotification,
    emailEnabled,
    redactEmail,
    escapeHtml,
    renderEmail,
    // Exported for testing only:
    isFixtureEmailDomain,
    sanitizeTitleText,
    fmtUsd,
    formatAccrualDate,
    unlockCountLabel,
    buildWelcomeEmailBodies,
    buildEarningSingleBodies,
    buildEarningDigestBodies,
};
