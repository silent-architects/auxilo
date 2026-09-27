'use strict';
/*
 * test/email-template.test.js — shared email shell (renderEmail/escapeHtml)
 * and the two existing emails (sign-in magic link, deletion confirmation)
 * rebuilt on top of it. Per LAYOUT-SHEET.md item 9: light ground, wordmark,
 * gold primary button (danger red for deletion), fallback link, footer.
 *
 * No test here touches the real HOME or the network. Sending is exercised
 * with RESEND_API_KEY set and global.fetch monkey-patched to capture the
 * outgoing request body (precedent: test/ext-0806b-silent-skip.test.js),
 * and separately with RESEND_API_KEY unset to prove no network call and no
 * throw.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const email = require('../lib/email.js');

const SAMPLE_URL = 'https://auxilo.io/auth/verify?token=SAMPLE';

// --- shared fetch/env save-restore helper for the send*() tests ---
let saved = null;

function stashEnvAndFetch() {
    saved = { key: process.env.RESEND_API_KEY, fetch: global.fetch };
}

function restoreEnvAndFetch() {
    if (!saved) return;
    if (saved.key === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.key;
    global.fetch = saved.fetch;
    saved = null;
}

afterEach(() => {
    restoreEnvAndFetch();
});

async function captureSend(sendFn) {
    stashEnvAndFetch();
    process.env.RESEND_API_KEY = 'test-key';
    let captured = null;
    global.fetch = async (_url, init) => {
        captured = JSON.parse(init.body);
        return { ok: true, status: 202 };
    };
    const result = await sendFn();
    return { result, captured };
}

describe('escapeHtml', () => {
    it('neutralizes all five special characters', () => {
        assert.equal(email.escapeHtml('&'), '&amp;');
        assert.equal(email.escapeHtml('<'), '&lt;');
        assert.equal(email.escapeHtml('>'), '&gt;');
        assert.equal(email.escapeHtml('"'), '&quot;');
        assert.equal(email.escapeHtml("'"), '&#39;');
    });

    it('escapes a script tag to literal text with no raw <script> surviving', () => {
        const out = email.escapeHtml('<script>alert(1)</script>');
        assert.match(out, /&lt;script&gt;/);
        assert.ok(!out.includes('<script>'));
    });

    it('treats null and undefined as an empty string', () => {
        assert.equal(email.escapeHtml(null), '');
        assert.equal(email.escapeHtml(undefined), '');
    });
});

describe('renderEmail', () => {
    it('escapes heading and button.text but leaves an intentional bodyHtml fragment untouched', () => {
        const html = email.renderEmail({
            heading: '<b>Hi</b> & welcome',
            bodyHtml: '<p>Hello <strong>World</strong>, keep this markup.</p>',
            button: { text: 'Go <now> & fast', url: 'https://auxilo.io/x' },
        });
        // heading escaped
        assert.match(html, /&lt;b&gt;Hi&lt;\/b&gt; &amp; welcome/);
        assert.ok(!html.includes('<b>Hi</b>'));
        // button text escaped
        assert.match(html, /Go &lt;now&gt; &amp; fast/);
        // bodyHtml passed through verbatim, not re-escaped or altered
        assert.ok(html.includes('<p>Hello <strong>World</strong>, keep this markup.</p>'));
    });

    it('cannot have a double-quote in button.url break out of the href attribute', () => {
        const maliciousUrl = 'https://example.com/x?y="><script>alert(1)</script>';
        const html = email.renderEmail({
            heading: 'H',
            bodyHtml: '<p>b</p>',
            button: { text: 'Click', url: maliciousUrl },
        });
        // the raw breakout sequence must not appear unescaped
        assert.ok(!html.includes('"><script>'));
        assert.ok(!/<script>/.test(html));
        // the escaped URL is present inside the href attribute
        assert.match(html, /href="https:\/\/example\.com\/x\?y=&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
    });

    it('renders no button for a javascript: URL', () => {
        const html = email.renderEmail({
            heading: 'H',
            bodyHtml: '<p>b</p>',
            button: { text: 'Click', url: 'javascript:alert(1)' },
        });
        assert.ok(!html.includes('javascript:alert'));
        // the fallback-link block only appears alongside a rendered button
        assert.ok(!html.includes("copy and paste this link"));
    });

    it('uses the gold primary by default and the danger red only for tone: "danger"', () => {
        const gold = email.renderEmail({
            heading: 'H',
            bodyHtml: '<p>b</p>',
            button: { text: 'Go', url: 'https://auxilo.io/x' },
        });
        assert.match(gold, /#C9A84C/);
        assert.ok(!gold.includes('#B91C1C'));

        const danger = email.renderEmail({
            heading: 'H',
            bodyHtml: '<p>b</p>',
            button: { text: 'Go', url: 'https://auxilo.io/x' },
            tone: 'danger',
        });
        assert.match(danger, /#B91C1C/);
        assert.ok(!danger.includes('#C9A84C'));
    });

    it('always ends the footer with a plain auxilo.io link to https://auxilo.io', () => {
        const html = email.renderEmail({ heading: 'H', bodyHtml: '<p>b</p>' });
        assert.match(html, /<a href="https:\/\/auxilo\.io"[^>]*>auxilo\.io<\/a>/);
    });

    it('never emits a <style> block, <script>, SVG, or a web-font reference', () => {
        const html = email.renderEmail({
            heading: 'H',
            bodyHtml: '<p>b</p>',
            button: { text: 'Go', url: 'https://auxilo.io/x' },
            footerHtml: '<p>footer</p>',
            tone: 'danger',
        });
        assert.ok(!/<style[\s>]/i.test(html));
        assert.ok(!/<script[\s>]/i.test(html));
        assert.ok(!/<svg[\s>]/i.test(html));
        assert.ok(!/fonts\.googleapis\.com|@font-face/i.test(html));
    });
});

describe('sign-in (magic-link) email', () => {
    it('contains the wordmark image, text wordmark, gold button, fallback link, and the unchanged wording', async () => {
        const { result, captured } = await captureSend(() => email.sendMagicLink('user@example.com', SAMPLE_URL));
        assert.equal(result.ok, true);

        // plain-text body unchanged
        assert.equal(
            captured.text,
            [
                'Sign in to Auxilo',
                '',
                'Click the link below to sign in. This link expires in 15 minutes and can only be used once.',
                '',
                SAMPLE_URL,
                '',
                "If you didn't request this, you can safely ignore this email.",
            ].join('\n')
        );

        const html = captured.html;
        // wordmark: hosted image with alt="Auxilo" + text wordmark
        assert.match(html, /<img src="https:\/\/auxilo\.io\/logo-square\.png"[^>]*alt="Auxilo"[^>]*>/);
        assert.match(html, />auxilo<\/td>/);
        // gold button color from the layout sheet
        assert.match(html, /#C9A84C/);
        // fallback link block
        assert.ok(html.includes("If the button doesn't work, copy and paste this link:"));
        assert.ok(html.includes(SAMPLE_URL));
        // exact existing wording, pinned
        assert.ok(html.includes('Sign in to Auxilo'));
        assert.ok(html.includes('Click the button below to sign in. This link expires in <strong>15 minutes</strong> and can only be used once.'));
        assert.ok(html.includes("If you didn't request this, you can safely ignore this email."));
    });
});

describe('deletion confirmation email', () => {
    it('uses the red button color and never the gold, and keeps the unchanged wording', async () => {
        const { result, captured } = await captureSend(() => email.sendDeletionConfirmation('user@example.com', SAMPLE_URL));
        assert.equal(result.ok, true);

        assert.equal(
            captured.text,
            [
                'Confirm Auxilo account deletion',
                '',
                'Open the link below to confirm deletion of your account data from live Auxilo systems. This link expires in 15 minutes and can only be used once.',
                '',
                SAMPLE_URL,
                '',
                "If you didn't request this, you can safely ignore this email.",
            ].join('\n')
        );

        const html = captured.html;
        assert.match(html, /#B91C1C/);
        assert.ok(!html.includes('#C9A84C'));
        assert.ok(html.includes('Confirm account deletion'));
        assert.ok(html.includes('Open the button below to confirm deletion of your account data from live Auxilo systems. This link expires in <strong>15 minutes</strong> and can only be used once.'));
        assert.ok(html.includes("If you didn't request this, you can safely ignore this email."));
    });
});

describe('RESEND_API_KEY absent', () => {
    it('sendMagicLink does not call fetch and does not throw', async () => {
        stashEnvAndFetch();
        delete process.env.RESEND_API_KEY;
        let fetchCalled = false;
        global.fetch = async () => {
            fetchCalled = true;
            return { ok: true, status: 200 };
        };
        const result = await email.sendMagicLink('user@example.com', SAMPLE_URL);
        assert.equal(fetchCalled, false);
        assert.equal(result.ok, false);
    });

    it('sendDeletionConfirmation does not call fetch and does not throw', async () => {
        stashEnvAndFetch();
        delete process.env.RESEND_API_KEY;
        let fetchCalled = false;
        global.fetch = async () => {
            fetchCalled = true;
            return { ok: true, status: 200 };
        };
        const result = await email.sendDeletionConfirmation('user@example.com', SAMPLE_URL);
        assert.equal(fetchCalled, false);
        assert.equal(result.ok, false);
    });
});
