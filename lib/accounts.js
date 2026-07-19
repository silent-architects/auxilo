/**
 * lib/accounts.js — Phase 0.1 Account System (SPEC-P0.1)
 *
 * Provides:
 *   - POST /auth/magic-link    — request a magic link login token
 *   - GET  /auth/verify        — redeem token, receive JWT session
 *   - POST /account/api-keys   — generate an axl_ API key (auth required)
 *   - GET  /account/dashboard  — view account + keys (auth required)
 *
 * JWT: jose (already a Hono transitive dep — no new installs)
 * Session: Bearer JWT, 24-hour expiry, signed with SESSION_SECRET env var
 *
 * Run: node server.js (requires SESSION_SECRET in env or .env)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SignJWT, jwtVerify } = require('jose');
const email_ = require('./email');

// LW-1: one-time startup warning when running in dev email mode
let devEmailWarned = false;
function warnDevEmailModeOnce() {
    if (devEmailWarned) return;
    devEmailWarned = true;
    console.warn('[email] RESEND_API_KEY not set — magic links logged to console (dev mode)');
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const MAGIC_LINKS_FILE = path.join(DATA_DIR, 'magic_links.json');

const TOKEN_EXPIRY_MS = 15 * 60 * 1000;  // 15 minutes
const JWT_EXPIRY = '24h';
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;  // 15 minutes
const RATE_LIMIT_BY_EMAIL = 5;
const RATE_LIMIT_BY_IP = 20;

// ─── JWT secret ──────────────────────────────────────────────────────────────

function getJwtSecret() {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
        console.warn('[accounts] WARNING: SESSION_SECRET env var not set. Using an ephemeral secret — sessions will not survive restarts.');
        // Ephemeral fallback for dev (not secure for production)
        return crypto.randomBytes(32);
    }
    // GOV-3: in production a present-but-weak secret is as dangerous as a missing
    // one (HS256 brute-force). Refuse to start if it is shorter than 32 bytes.
    // Dev keeps the ephemeral path above and is exempt from this floor.
    if (process.env.NODE_ENV === 'production' && Buffer.byteLength(secret) < 32) {
        console.error('[FATAL] SESSION_SECRET must be at least 32 bytes in production. Refusing to start.');
        process.exit(1);
    }
    return Buffer.from(secret);
}

// Cache the secret for the process lifetime (evaluated once)
const JWT_SECRET = getJwtSecret();

// ─── File I/O Helpers ─────────────────────────────────────────────────────────

function readJson(filepath) {
    try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); }
    catch { return null; }
}

function writeJson(filepath, data) {
    const tmp = filepath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, filepath);
}

function loadAccounts() {
    return readJson(ACCOUNTS_FILE) || {};
}

function saveAccounts(accounts) {
    writeJson(ACCOUNTS_FILE, accounts);
}

// ─── ToS Clickwrap Assent Capture (R-01 / red-team P0-3) ────────────────────────
//
// The payee-agency appointment (ToS §5.10) is only legally binding if each Builder
// AFFIRMATIVELY assents to it and that assent is captured as a durable, evidentiary
// record. Assent-via-use does NOT bind the agency. This block is the enforceable
// capture layer: a version-of-record, the per-account consent artifact, and the
// helpers the blocking gates (wallet-link + withdrawal) and the accept endpoint use.
//
// SHIP DISCIPLINE: this capture layer and the §5.10 ToS text are an all-or-nothing
// bundle — §5.10 must NOT be represented as in force until this is live, and this is
// inert product until §5.10 is the published ToS. Do not deploy either alone.
//
// CURRENT_TOS_VERSION is the server-side version of record. Bumping it re-prompts
// every Builder (their stored tos_version no longer matches, so hasAcceptedCurrentTos
// returns false and the gates re-block until they re-accept). This string MUST match
// the effective/amendment identifier published in the live Terms when §5.10 ships;
// reconcile it with docs/TERMS-OF-SERVICE.md at deploy time. Format: <effective-date>-<amendment-slug>.
const CURRENT_TOS_VERSION = '2026-07-04-payee-agency-a1';

// True only when the account has affirmatively accepted the CURRENT version. Any
// prior-version acceptance (older tos_version) is treated as un-accepted so a
// material change re-prompts. Missing artifact => false (assent-via-use never binds).
function hasAcceptedCurrentTos(account) {
    return !!(account && account.tos_version === CURRENT_TOS_VERSION && account.accepted_at);
}

// CP-6: the set of ToS versions in which the §5.10 payee-agency appointment is IN FORCE.
// isPayeeAgencyInForce (the accrual-gate predicate) keys on membership here — NOT on
// hasAcceptedCurrentTos, and NOT on merely "some version accepted" — so that:
//  (a) a later, UNRELATED ToS version bump does not re-quarantine a Builder whose accepted
//      version already carried §5.10 (add the new id below and both stay in force), and
//  (b) a future version that REMOVES or reorders §5.10 does NOT silently pass the gate — a
//      version is §5.10-bearing only if explicitly listed here (fail-closed by default;
//      red-team P2-A: don't ship the weaker `accepted_at && tos_version` predicate that
//      opens on the next bump).
// When a new §5.10-bearing ToS version ships, add its id to this set (and to any migration).
// Today CURRENT_TOS_VERSION is the only such version.
const PAYEE_AGENCY_VERSIONS = new Set([CURRENT_TOS_VERSION]);

// The payee-agency (§5.10) is "in force" for a Builder once they have affirmatively accepted
// a §5.10-bearing ToS version (PAYEE_AGENCY_VERSIONS). Distinct from hasAcceptedCurrentTos:
// the agency does not lapse merely because an unrelated later version became current.
function isPayeeAgencyInForce(account) {
    return !!(account && account.accepted_at && PAYEE_AGENCY_VERSIONS.has(account.tos_version));
}

// R01 launch invariant (REFUSE arm): a learning is PLATFORM-OWNED — always unlockable,
// never gated on payee-agency — ONLY when it has no identifiable EXTERNAL payee. An
// external payee is identifiable by (a) a contributor_wallet that is NOT the platform
// wallet, or (b) a contributor_account_id. Either one means an unlock would send a share
// to a third party, which the handler must refuse until that Builder's §5.10 payee-agency
// is in force. A missing account_id is NOT sufficient to call a learning platform-owned:
// a wallet-only external Builder has an external wallet but no account yet (so cannot have
// accepted §5.10) — their content must be refused, not received into custody (FB-3 fix).
// Platform-owned = contributor IS the platform wallet, or there is no external payee at all
// (no non-platform wallet AND no account). `platformWallets` is passed in (defined in
// server.js) so this stays a pure predicate; it accepts one wallet OR an array because
// the 2026-07-12 LLC wallet rotation retired the pre-LLC receiving wallet while existing
// seed learnings still carry it as contributor_wallet — BOTH must read as platform, or
// the refuse gate 409s the platform-seed catalog. Comparison is case-insensitive.
function isPlatformContributor(learning, platformWallets) {
    if (!learning) return true;
    const list = (Array.isArray(platformWallets) ? platformWallets : [platformWallets])
        .filter(Boolean)
        .map((w) => String(w).toLowerCase());
    const cw = learning.contributor_wallet ? String(learning.contributor_wallet).toLowerCase() : null;
    // (a) a contributor wallet that is not a platform wallet is an identifiable external payee -> NOT platform.
    if (cw && !list.includes(cw)) return false;
    // (b) an external Builder account is an identifiable external payee -> NOT platform.
    if (learning.contributor_account_id) return false;
    // Otherwise: contributor is a platform wallet, or there is no external payee at all.
    return true;
}

// The machine-readable acceptance state for an account. Consumed by GET
// /account/terms-status, the dashboard JSON, and the 403 gate bodies so both the
// web UI and MCP/API clients can tell whether (re-)acceptance is required.
function getTosStatus(account) {
    return {
        current_tos_version: CURRENT_TOS_VERSION,
        accepted_version: (account && account.tos_version) || null,
        accepted_at: (account && account.accepted_at) || null,
        accepted: hasAcceptedCurrentTos(account),
        needs_acceptance: !hasAcceptedCurrentTos(account),
    };
}

// Record an affirmative acceptance of the CURRENT terms on the account record.
// `version` is the version the client believes it is accepting; we refuse anything
// other than CURRENT_TOS_VERSION so a client can never bind itself to a stale or
// unknown version (409). Server stamps accepted_at/IP/UA — never trusts the client
// for those. Writes the four named artifact fields plus an append-only history log
// so an account that re-accepts across versions retains a full evidentiary trail.
// Follows the canonical load->mutate->save pattern; the caller serializes the
// read-modify-write with acquireAccountLock (mirroring linkWallet).
function recordTosAcceptance(accountId, { version, ip, ua, affirmed } = {}) {
    if (version !== CURRENT_TOS_VERSION) {
        return { success: false, error: 'Terms version mismatch — you must accept the current Terms', status_code: 409, current_tos_version: CURRENT_TOS_VERSION };
    }
    const accounts = loadAccounts();
    const account = accounts[accountId];
    if (!account) return { success: false, error: 'Account not found', status_code: 404 };

    // Idempotent: if this account already holds a current-version acceptance, don't
    // append a duplicate row or re-stamp. The evidentiary trail needs one row per
    // version transition, not one per repeated click/call — this also stops an
    // authenticated caller from bloating their own record (and the durable log) by
    // re-POSTing accept-terms in a loop. Callers use `alreadyAccepted` to skip the
    // durable-log append too.
    if (hasAcceptedCurrentTos(account)) {
        return { success: true, version: CURRENT_TOS_VERSION, accepted_at: account.accepted_at, alreadyAccepted: true };
    }

    const now = Date.now();
    account.tos_version = CURRENT_TOS_VERSION;
    account.accepted_at = now;
    account.accepted_ip = ip || null;
    account.accepted_ua = ua ? String(ua).slice(0, 512) : null;
    // L-2 (Gate-B): record that an explicit affirmation was transmitted, not just that an
    // authenticated version-echo arrived. The accept-terms endpoint requires agree===true
    // before calling this, so a genuine acceptance always carries affirmed:true; the field
    // makes that affirmation self-describing in the evidentiary record.
    account.accepted_affirmed = affirmed === true;

    // Append-only history — retains proof of every version the Builder assented to,
    // not just the latest, for the payee-agency evidentiary record.
    if (!Array.isArray(account.tos_acceptance_log)) account.tos_acceptance_log = [];
    account.tos_acceptance_log.push({
        version: CURRENT_TOS_VERSION,
        accepted_at: now,
        ip: account.accepted_ip,
        ua: account.accepted_ua,
        affirmed: account.accepted_affirmed,
    });

    saveAccounts(accounts);
    return { success: true, version: CURRENT_TOS_VERSION, accepted_at: now };
}

function loadMagicLinks() {
    return readJson(MAGIC_LINKS_FILE) || {};
}

function saveMagicLinks(links) {
    // Prune expired entries on every write (free GC)
    const now = Date.now();
    const clean = Object.fromEntries(
        Object.entries(links).filter(([, v]) => v.expires_at > now)
    );
    writeJson(MAGIC_LINKS_FILE, clean);
}

// ─── Account Helpers ──────────────────────────────────────────────────────────

function generateAccountId() {
    return 'acc_' + crypto.randomBytes(4).toString('hex');
}

function generateKeyId() {
    return 'key_' + crypto.randomBytes(4).toString('hex');
}

/**
 * Peek helper — returns true if an account with this email already exists.
 * Does NOT create anything. Used by the magic-link verify handler to decide
 * whether to apply the new-account creation throttle BEFORE calling
 * findOrCreateAccount().
 */
function accountExistsByEmail(email) {
    const accounts = loadAccounts();
    return Object.values(accounts).some(a => a.email === email);
}

function findOrCreateAccount(email) {
    const accounts = loadAccounts();
    const existing = Object.entries(accounts).find(([, a]) => a.email === email);
    if (existing) return { accounts, accountId: existing[0], account: existing[1], created: false };

    const accountId = generateAccountId();
    accounts[accountId] = {
        email,
        created_at: Date.now(),
        api_keys: [],
    };
    saveAccounts(accounts);
    return { accounts, accountId, account: accounts[accountId], created: true };
}

// ─── JWT Helpers ──────────────────────────────────────────────────────────────

async function signJwt(accountId, email) {
    return new SignJWT({ accountId, email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(JWT_EXPIRY)
        .sign(JWT_SECRET);
}

async function verifyJwt(token) {
    try {
        const { payload } = await jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
        return payload;
    } catch {
        return null;
    }
}

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

// In-memory store: { email: [{ts}], ip: [{ts}] }
const rateLimitStore = { email: {}, ip: {} };

function isRateLimited(type, key, limit) {
    const now = Date.now();
    if (!rateLimitStore[type][key]) rateLimitStore[type][key] = [];

    // Prune entries outside the window
    rateLimitStore[type][key] = rateLimitStore[type][key].filter(
        ts => now - ts < RATE_LIMIT_WINDOW_MS
    );

    if (rateLimitStore[type][key].length >= limit) return true;
    rateLimitStore[type][key].push(now);
    return false;
}

// ─── New-Account Creation Throttle (Fix 2) ───────────────────────────────────
// Tracks NEW account creations (not magic-link requests) per IP.
// Existing-account logins are never counted here.
// Limit: 3 new accounts per IP per 24 hours.

const NEW_ACCOUNT_LIMIT = 3;
const NEW_ACCOUNT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// Map<ip, { count: number, windowStart: number }>
const newAccountCreationStore = new Map();

/**
 * Returns true (and blocks) if this IP has already created 3+ new accounts
 * in the last 24 hours. Increments the counter when returning false.
 */
function isNewAccountRateLimited(ip) {
    const now = Date.now();
    const entry = newAccountCreationStore.get(ip);

    if (!entry || (now - entry.windowStart) >= NEW_ACCOUNT_WINDOW_MS) {
        // No record or window expired — start fresh with count=1
        newAccountCreationStore.set(ip, { count: 1, windowStart: now });
        return false;
    }

    if (entry.count >= NEW_ACCOUNT_LIMIT) {
        return true; // block
    }

    entry.count++;
    return false;
}

// D-2 / SD-2 / A-3 FIX: Trusted-proxy client IP derivation.
//
// The old implementation took the leftmost X-Forwarded-For entry with no
// trusted-proxy check. Because XFF is fully client-controlled, every per-IP
// limiter (magic-link, new-account, /report, /knowledge/:id/rate, unauth
// search) and the audit-log IP hashing were trivially bypassable by rotating
// the header. This single function is the common dependency behind all of them.
//
// New model:
//   1. Trust the platform's *signed* connecting-IP header first. On Fly.io the
//      edge proxy sets `Fly-Client-IP` (and we also accept Cloudflare's
//      `CF-Connecting-IP`). These are written by the platform and overwrite any
//      client-supplied value, so they are not spoofable from outside.
//   2. Only consult the client-supplied `X-Forwarded-For` / `X-Real-IP` when the
//      direct socket peer is an allowlisted proxy. Otherwise ignore them.
//   3. Fall back to the raw socket peer address.
//
// The trusted-proxy allowlist defaults to loopback + RFC1918 + Fly's internal
// fdaa:: range, since the platform proxy connects from a private/internal
// address. Override via the TRUSTED_PROXIES env var (comma-separated CIDRs or
// literal addresses).

const DEFAULT_TRUSTED_PROXY_CIDRS = [
    '127.0.0.0/8',   // loopback
    '::1/128',       // loopback v6
    '10.0.0.0/8',    // RFC1918
    '172.16.0.0/12', // RFC1918
    '192.168.0.0/16',// RFC1918
    'fc00::/7',      // unique-local v6 (covers Fly's fdaa::/16 6PN range)
];

let _trustedProxyMatchers = null;
function getTrustedProxyMatchers() {
    if (_trustedProxyMatchers) return _trustedProxyMatchers;
    const raw = process.env.TRUSTED_PROXIES;
    const list = raw && raw.trim()
        ? raw.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_TRUSTED_PROXY_CIDRS;
    _trustedProxyMatchers = list.map(parseCidrMatcher).filter(Boolean);
    return _trustedProxyMatchers;
}

// Normalize an address: strip IPv6 zone id and unwrap IPv4-mapped IPv6
// (::ffff:a.b.c.d) so a v4-mapped peer still matches v4 CIDRs.
function normalizeIp(addr) {
    if (!addr) return null;
    let a = String(addr).trim();
    const zone = a.indexOf('%');
    if (zone !== -1) a = a.slice(0, zone);
    const mapped = a.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped) return mapped[1];
    return a;
}

function ipToBigInt(ip) {
    if (ip.includes('.')) {
        // IPv4
        const parts = ip.split('.');
        if (parts.length !== 4) return null;
        let n = 0n;
        for (const p of parts) {
            const o = Number(p);
            if (!Number.isInteger(o) || o < 0 || o > 255) return null;
            n = (n << 8n) | BigInt(o);
        }
        // Map into IPv4-in-IPv6 space so v4 and v6 compare consistently.
        return 0xffffn << 32n | n;
    }
    // IPv6 — expand :: and parse hextets.
    let hextets;
    if (ip.includes('::')) {
        const [head, tail] = ip.split('::');
        const headParts = head ? head.split(':') : [];
        const tailParts = tail ? tail.split(':') : [];
        const fill = 8 - headParts.length - tailParts.length;
        if (fill < 0) return null;
        hextets = [...headParts, ...Array(fill).fill('0'), ...tailParts];
    } else {
        hextets = ip.split(':');
    }
    if (hextets.length !== 8) return null;
    let n = 0n;
    for (const h of hextets) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(h)) return null;
        n = (n << 16n) | BigInt(parseInt(h, 16));
    }
    return n;
}

function parseCidrMatcher(entry) {
    let addr = entry;
    let bits = null;
    const slash = entry.indexOf('/');
    if (slash !== -1) {
        addr = entry.slice(0, slash);
        bits = Number(entry.slice(slash + 1));
    }
    const isV4 = addr.includes('.');
    const base = ipToBigInt(normalizeIp(addr));
    if (base === null) return null;
    // Total bit-width is 128 in our normalized space; v4 lives in the low 32
    // bits under the ::ffff: mapping, so a /N v4 prefix becomes /(96+N).
    let prefix;
    if (bits === null) {
        prefix = 128; // exact match
    } else if (isV4) {
        prefix = 96 + bits;
    } else {
        prefix = bits;
    }
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
    const maskShift = 128 - prefix;
    const mask = maskShift === 0 ? (1n << 128n) - 1n : ((1n << 128n) - 1n) ^ ((1n << BigInt(maskShift)) - 1n);
    return { network: base & mask, mask };
}

function isTrustedProxy(addr) {
    const norm = normalizeIp(addr);
    if (!norm) return false;
    const n = ipToBigInt(norm);
    if (n === null) return false;
    for (const m of getTrustedProxyMatchers()) {
        if ((n & m.mask) === m.network) return true;
    }
    return false;
}

function getSocketPeer(c) {
    // Hono node-server exposes the raw socket via env.incoming.
    return c.env?.incoming?.socket?.remoteAddress
        || c.env?.incoming?.connection?.remoteAddress
        || null;
}

function getClientIp(c) {
    // 1. Platform signed connecting-IP header — set by the edge proxy,
    //    overwrites any client value, so it is not externally spoofable.
    const flyIp = c.req.header('fly-client-ip');
    if (flyIp && flyIp.trim()) return flyIp.trim();
    const cfIp = c.req.header('cf-connecting-ip');
    if (cfIp && cfIp.trim()) return cfIp.trim();

    const peer = getSocketPeer(c);

    // 2. Only trust client-supplied forwarding headers when the *direct* socket
    //    peer is an allowlisted proxy. Otherwise the client could forge them.
    if (peer && isTrustedProxy(peer)) {
        const xff = c.req.header('x-forwarded-for');
        if (xff && xff.trim()) {
            // Right-most entry is the one our trusted proxy appended; but to keep
            // behavior simple and safe we take the left-most *only because* we've
            // confirmed the immediate peer is trusted. Take the last untrusted hop
            // by walking from the right past trusted proxies.
            const chain = xff.split(',').map(s => s.trim()).filter(Boolean);
            for (let i = chain.length - 1; i >= 0; i--) {
                if (!isTrustedProxy(chain[i])) return chain[i];
            }
            if (chain.length) return chain[0];
        }
        const xri = c.req.header('x-real-ip');
        if (xri && xri.trim()) return xri.trim();
    }

    // 3. Fall back to the raw socket peer address. Ignore client XFF entirely
    //    when we are not behind a configured trusted proxy.
    if (peer) return peer;
    return 'unknown';
}

// ─── requireAuth Middleware ────────────────────────────────────────────────────

async function requireAuth(c, next) {
    const authHeader = c.req.header('Authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
        return c.json({ error: 'Authorization required' }, 401);
    }

    const payload = await verifyJwt(token);
    if (!payload || !payload.accountId) {
        return c.json({ error: 'Invalid or expired session token' }, 401);
    }

    // Suspended accounts cannot act on any session route (GOV-3 review L-1).
    // Single chokepoint covering key-mint, withdraw, link-wallet, settings.
    const account = loadAccounts()[payload.accountId];
    if (!account) return c.json({ error: 'Account not found' }, 401);
    if (account.disabled_at) return c.json({ error: 'Account suspended' }, 403);

    // Attach to context for downstream handlers
    c.set('accountId', payload.accountId);
    c.set('email', payload.email);
    await next();
}

/**
 * Key scope ordering for minimum-scope checks (GOV-3 review M-1; Wave 3.4 D2).
 *
 * D2 taxonomy (BUILD-SPEC-WAVE34-2026-07-19):
 *   read(1)          — catalog read, paid unlock, rate, terms-status, settings-read,
 *                      self-review listing. The least-privilege CI key.
 *   earnings-read(2) — + GET /account/earnings (financial visibility).
 *   contribute(3)    — + /learn, /extract, retraction, self-review decisions,
 *                      consent, accept-terms, link-wallet. DEFAULT (the one scope
 *                      that keeps the whole `npx auxilo setup` builder loop working;
 *                      contribute ⊃ earnings-read by design so the setup key can
 *                      show the builder their own earnings).
 *   admin(4)         — everything. NEVER issuable via the API or device flow;
 *                      pre-existing admin keys are grandfathered.
 *
 * Sessions always pass any scope. This map is the SINGLE source of truth —
 * server.js imports it (do not re-declare there).
 */
const SCOPE_RANK = { read: 1, 'earnings-read': 2, contribute: 3, admin: 4 };

/** True when `scope` meets or exceeds `minScope` (rank comparison, fail-closed
 *  on unknown scopes). Single source — server.js imports this. */
function hasMinScope(scope, minScope) {
    return (SCOPE_RANK[scope] || 0) >= (SCOPE_RANK[minScope] || 0);
}

/**
 * D2 grandfathering (Wave 3.4): the ENFORCEMENT scope for a stored key entry.
 *
 * Keys minted before Wave 3.4 carry no `scope_version`. Pre-D2 'read' keys could
 * reach GET /account/earnings (it was minScope 'read'), so demoting them to the
 * new strict 'read' rank would break existing keys. Their effective scope is
 * 'earnings-read' — EXACTLY the capability set they had before, nothing gained.
 * Legacy 'contribute'/'admin' map to themselves (identical reachable route set).
 * v2 keys (scope_version >= 2) are strict: effective == stored.
 *
 * ENFORCEMENT RULE: every scope check on an API key must use
 * `keyResult.effective_scope` (returned by validateApiKey), never the stored
 * `scope` — a site that forgets fails CLOSED for grandfathered read keys
 * (rank 1 < 2), never open.
 */
function effectiveScopeForKeyEntry(key) {
    const stored = (key && key.scope) || 'read';
    if (key && key.scope_version >= 2) return stored;
    if (stored === 'read') return 'earnings-read';
    return stored;
}

/**
 * Auth middleware FACTORY: accepts EITHER a web session JWT (Authorization:
 * Bearer) OR an account API key (X-API-Key header, or Bearer when the token
 * is not a valid JWT — matching how POST /extract reads keys). Needed by
 * routes the installer CLI calls with credentials.json keys (LW-17:
 * /extract/consent was session-only, so `auxilo setup` consent always
 * failed with 401).
 *
 * @param {'read'|'contribute'|'admin'} minScope - minimum API-key scope.
 *   Sessions are the full logged-in user and always pass the scope check.
 *   Device-login keys are minted scope 'contribute'.
 *
 * NOTE: c.get('email') is only set for session callers — API-key callers
 * have accountId only. Handlers using this middleware must not assume email.
 */
function requireSessionOrApiKey(minScope = 'contribute') {
    const minRank = SCOPE_RANK[minScope] || SCOPE_RANK.contribute;

    return async function sessionOrApiKeyAuth(c, next) {
        const xApiKey = c.req.header('X-API-Key');
        const authHeader = c.req.header('Authorization') || '';
        const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!xApiKey && !bearer) {
            return c.json({ error: 'Authorization required. Provide X-API-Key or Authorization: Bearer.' }, 401);
        }

        let accountId = null;

        // 1. Session JWT (web dashboard callers) — full user, no scope limit.
        if (bearer) {
            const payload = await verifyJwt(bearer);
            if (payload && payload.accountId) {
                accountId = payload.accountId;
                c.set('email', payload.email);
            }
        }

        // 2. API key (CLI / agent callers): X-API-Key preferred, Bearer fallback.
        if (!accountId) {
            const keyResult = validateApiKey(xApiKey || bearer);
            if (!keyResult.valid) {
                return c.json({ error: 'Invalid or expired credentials' }, 401);
            }
            // D2: enforcement uses the grandfather-aware effective scope.
            const rank = SCOPE_RANK[keyResult.effective_scope || keyResult.scope] || 0;
            if (rank < minRank) {
                return c.json({ error: `API key scope '${keyResult.scope}' is insufficient (requires ${minScope})` }, 403);
            }
            accountId = keyResult.accountId;
        }

        // Suspended accounts cannot act (GOV-3 review L-1).
        const account = loadAccounts()[accountId];
        if (!account) return c.json({ error: 'Account not found' }, 401);
        if (account.disabled_at) return c.json({ error: 'Account suspended' }, 403);

        c.set('accountId', accountId);
        await next();
    };
}

/**
 * Non-middleware sibling of requireSessionOrApiKey: resolve the caller's account
 * from EITHER a session JWT (Authorization: Bearer) OR an account API key
 * (X-API-Key, or a Bearer axl_ key), enforcing a minimum API-key scope. Sessions
 * are the full logged-in user and pass any scope. Returns { accountId } on
 * success or { error, status } on failure, so inline handlers (e.g. the
 * self-review routes consumed by both the CLI and the web dashboard) can accept
 * a browser session token without forcing users to paste their API key.
 *
 * @param {object} c        Hono context.
 * @param {'read'|'contribute'|'admin'} [minScope='read']
 * @returns {Promise<{accountId:string}|{error:string,status:number}>}
 */
async function resolveAccountFromRequest(c, minScope = 'read') {
    const resolved = await resolveAccountAndKeyFromRequest(c, minScope);
    if (resolved.error) return { error: resolved.error, status: resolved.status };
    return { accountId: resolved.accountId };
}

/**
 * Wave 3.4 (D2): like resolveAccountFromRequest, but also reports HOW the caller
 * authenticated — needed by the key-management routes, where a key-authenticated
 * caller may act only on THE KEY IT PRESENTED (self-rotate / self-revoke), while
 * a session caller (full logged-in user) may act on any of the account's keys.
 *
 * @returns {Promise<{accountId:string, viaSession:boolean, keyHash:string|null,
 *                    keyScope:string|null}|{error:string,status:number}>}
 *   keyHash is the SHA-256 hex of the presented raw key (matches the stored
 *   entry's `hash`); null for session callers. keyScope is the EFFECTIVE
 *   (grandfather-aware) scope of the presented key; null for sessions.
 */
async function resolveAccountAndKeyFromRequest(c, minScope = 'read') {
    const minRank = SCOPE_RANK[minScope] || SCOPE_RANK.read;
    const xApiKey = c.req.header('X-API-Key');
    const authHeader = c.req.header('Authorization') || '';
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!xApiKey && !bearer) {
        return { error: 'Authentication required. Provide X-API-Key or Authorization: Bearer.', status: 401 };
    }

    let accountId = null;
    let viaSession = false;
    let keyHash = null;
    let keyScope = null;

    // 1. Session JWT (web dashboard): full user, passes any scope.
    if (bearer) {
        const payload = await verifyJwt(bearer);
        if (payload && payload.accountId) {
            accountId = payload.accountId;
            viaSession = true;
        }
    }

    // 2. API key (CLI / agent): X-API-Key preferred, Bearer axl_ fallback.
    if (!accountId) {
        const rawKey = xApiKey || bearer;
        const keyResult = validateApiKey(rawKey);
        if (!keyResult.valid) return { error: 'Invalid or expired credentials', status: 401 };
        // D2: enforcement uses the grandfather-aware effective scope.
        keyScope = keyResult.effective_scope || keyResult.scope;
        const rank = SCOPE_RANK[keyScope] || 0;
        if (rank < minRank) {
            return { error: `API key scope '${keyResult.scope}' is insufficient (requires ${minScope})`, status: 403 };
        }
        accountId = keyResult.accountId;
        keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    }

    const account = loadAccounts()[accountId];
    if (!account) return { error: 'Account not found', status: 401 };
    if (account.disabled_at) return { error: 'Account suspended', status: 403 };
    return { accountId, viaSession, keyHash, keyScope };
}

// ── API Key Index (O(1) lookup) ──────────────────────────────────────────────

/**
 * In-memory index: SHA-256 hex string (Map key) → { hash, accountId, scope, key_id }
 *
 * The `hash` field mirrors the Map key and is stored so that validateApiKey()
 * can perform a genuine timingSafeEqual between the freshly-computed hash and
 * the hash that was written to disk at key-creation time.
 *
 * Populated once at module load via buildKeyIndex() and kept in sync by:
 *   - addToKeyIndex()      — called when a new key is created
 *   - removeFromKeyIndex() — called when a key is deleted / rotated
 *   - rebuildKeyIndex()    — full rebuild (exposed for manual reloads)
 */
const apiKeyIndex = new Map();

/**
 * Lazily migrate an account from the legacy single-key format (api_key_hash) to
 * the new api_keys array format. Mutates the account object in-place.
 * MUST be called before any code that reads account.api_keys on an untrusted account.
 * Migration happens at access time — NOT at startup.
 */
function migrateToApiKeysArray(account) {
    if (!account) return;
    if (account.api_key_hash && !account.api_keys) {
        account.api_keys = [{
            hash: account.api_key_hash,
            label: 'default',
            created_at: account.created_at
                ? (typeof account.created_at === 'number'
                    ? new Date(account.created_at).toISOString()
                    : account.created_at)
                : new Date().toISOString(),
            last_used_at: null,
            active: true,
        }];
    }
    if (!account.api_keys) account.api_keys = [];
}

/**
 * (Re)build the entire index from disk. Safe to call at any time.
 * Replaces the entire Map contents atomically.
 */
function buildKeyIndex() {
    const accounts = loadAccounts();
    apiKeyIndex.clear();
    for (const [accountId, account] of Object.entries(accounts)) {
        // Also handle legacy single-hash accounts during index build
        const keys = account.api_keys || (account.api_key_hash
            ? [{ hash: account.api_key_hash, label: 'default', scope: 'read', id: null, active: true }]
            : []);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key.hash && key.active !== false) {
                apiKeyIndex.set(key.hash, {
                    hash: key.hash,        // stored for timingSafeEqual in validateApiKey
                    accountId,
                    // GOV-3: fail-closed: an unscoped legacy key is least-privilege.
                    scope:    key.scope || 'read',
                    // D2 (Wave 3.4): enforcement scope — grandfather-aware. This is
                    // the ONLY place legacy (pre-scope_version) keys enter the index.
                    effective_scope: effectiveScopeForKeyEntry(key),
                    grandfathered: !(key.scope_version >= 2),
                    key_id:   key.id,
                    key_index: i,          // position in api_keys array for last_used_at updates
                    label:    key.label || 'default',
                });
            }
        }
    }
}

// Build index at module load so the first validateApiKey() call is already O(1).
buildKeyIndex();

/**
 * Add a single key to the index. Call after writing a new key to disk.
 * key_index is the position in the account's api_keys array.
 */
function addToKeyIndex(keyHash, accountId, scope, key_id, key_index, label) {
    // D2 (Wave 3.4): every key added at runtime is a v2 (scope_version 2) key —
    // creation, device-authorize, and rotation all stamp scope_version — so its
    // effective scope IS its stored scope (no grandfather mapping here).
    apiKeyIndex.set(keyHash, {
        hash: keyHash,
        accountId,
        scope: scope || 'read',  // GOV-3: fail-closed default
        effective_scope: scope || 'read',
        grandfathered: false,
        key_id,
        key_index: key_index !== undefined ? key_index : -1,
        label: label || 'default',
    });
}

/** Remove a single key from the index. Call after deleting a key from disk. */
function removeFromKeyIndex(keyHash) {
    apiKeyIndex.delete(keyHash);
}

/** Public rebuild hook — call if accounts.json is edited externally. */
function rebuildKeyIndex() {
    buildKeyIndex();
}

// ── API Key Validation ──────────────────────────────────────────────────────

function hashesMatch(computedHex, storedHex) {
    const a = Buffer.from(computedHex, 'hex');
    const b = Buffer.from(storedHex, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

/**
 * Validate a raw API key in O(1) using the in-memory index.
 *
 * Steps:
 *   1. Fast-reject on format (prefix check).
 *   2. Hash the raw key with SHA-256.
 *   3. Look up the hash in apiKeyIndex — O(1), no disk I/O.
 *   4. If found, confirm with timingSafeEqual (constant-time, required by security policy).
 *   5. Return { valid, accountId, scope } or { valid: false }.
 */
function validateApiKey(rawKey) {
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.startsWith('axl_')) {
        return { valid: false };
    }

    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    // O(1) index lookup — no disk read, no account iteration.
    const entry = apiKeyIndex.get(keyHash);
    if (!entry) {
        return { valid: false };
    }

    // Final constant-time confirmation: compare the freshly-computed hash from
    // the incoming raw key against the hash stored in the index entry (which
    // was written to disk at key-creation time).  This satisfies the security
    // requirement to use timingSafeEqual even though the Map lookup is O(1).
    if (!hashesMatch(keyHash, entry.hash)) {
        return { valid: false };
    }

    return {
        valid: true,
        accountId:  entry.accountId,
        scope:      entry.scope,                            // stored scope (display/compat)
        // D2 (Wave 3.4): use effective_scope for EVERY enforcement decision —
        // it carries the grandfather mapping for pre-D2 keys. A site that uses
        // the stored `scope` instead fails closed (never open) for those keys.
        effective_scope: entry.effective_scope || entry.scope,
        grandfathered:   entry.grandfathered === true,
        key_index:  entry.key_index,
        key_label:  entry.label,
    };
}

// ─── D2 (Wave 3.4): key rotation helper ──────────────────────────────────────

/**
 * Rotate one key entry on an account object (pure mutation — caller persists
 * and re-indexes). Capability-preserving, never escalating: the replacement key
 * carries the target's EFFECTIVE scope (so a grandfathered legacy 'read' key
 * rotates into an explicit v2 'earnings-read' key — the same powers it already
 * had, now self-describing), keeps the label, and is stamped scope_version 2.
 * The old entry is deactivated in place (kept for audit) with rotated_at set.
 *
 * @param {object} account   Account object (api_keys already migrated).
 * @param {object} targetKey One of account.api_keys entries (must be active).
 * @returns {{ rawKey: string, entry: object, oldHash: string }}
 */
function rotateKeyEntry(account, targetKey) {
    const scope = effectiveScopeForKeyEntry(targetKey);
    const rawKey = 'axl_' + crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const entry = {
        id:            generateKeyId(),
        hash,
        label:         targetKey.label || targetKey.name || 'default',
        scope,
        scope_version: 2,
        created_at:    new Date().toISOString(),
        last_used_at:  null,
        active:        true,
        rotated_from:  targetKey.id || null,
    };
    targetKey.active = false;
    targetKey.rotated_at = new Date().toISOString();
    account.api_keys.push(entry);
    return { rawKey, entry, oldHash: targetKey.hash };
}

// ─── linkWallet ────────────────────────────────────────────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Link a verified wallet to an account.
 *
 * Validation order (matches SPEC-P0.5 § 4.1, + AUD19 MED-2):
 *   1. Wallet format (EVM hex address).
 *   2. NOT a platform wallet (AUD19 Gate-A MED-2 — see below).
 *   3. Wallet already verified by the challenge system (caller provides verifiedWallets).
 *   4. Wallet not already claimed by another account.
 *   5. Account does not already have a wallet linked.
 *   6. Write wallet + wallet_linked_at to the account and persist.
 *
 * Does NOT touch earnings.json — caller is responsible for calling
 * lazyMigrateOnWalletLink() and persisting earnings changes.
 *
 * @param {string} accountId          The acc_… ID of the authenticated account.
 * @param {string} wallet             The wallet address to link (any case).
 * @param {Set|object} verifiedWallets   In-memory set/map of verified wallet addresses.
 * @param {string[]} [platformWallets]   AUD19 MED-2: platform identity wallets (live + legacy).
 *                                       Linking any of these is REFUSED — the live platform
 *                                       wallet is auto-verified at boot, so without this gate
 *                                       any ToS-accepted account could claim it, and the
 *                                       adoption/migration/sweep hooks on the link path would
 *                                       hand that account platform-attributed learnings and
 *                                       earnings (the same drain vector the legacy-wallet
 *                                       comment at the boot site describes).
 * @returns {{ success: boolean, error?: string, status_code?: number, wallet?: string }}
 */
function linkWallet(accountId, wallet, verifiedWallets, platformWallets = []) {
    // 1. Format validation
    if (!wallet || typeof wallet !== 'string' || !EVM_ADDRESS_RE.test(wallet)) {
        return { success: false, error: 'Invalid wallet address format', status_code: 400 };
    }

    const walletLower = wallet.toLowerCase();

    // 2. AUD19 MED-2: platform-wallet refusal (before any disk read — pure check).
    const platformList = Array.isArray(platformWallets) ? platformWallets : [platformWallets];
    if (platformList.some((p) => typeof p === 'string' && p.toLowerCase() === walletLower)) {
        return { success: false, error: 'This wallet is a platform wallet and cannot be linked to an account', status_code: 403 };
    }

    // 3. Verified check
    const isVerified = verifiedWallets instanceof Set
        ? verifiedWallets.has(walletLower)
        : !!(verifiedWallets && verifiedWallets[walletLower]);

    if (!isVerified) {
        return { success: false, error: 'Wallet not verified. Complete the wallet challenge first.', status_code: 403 };
    }

    const accounts = loadAccounts();

    // 4. Not already claimed by another account
    for (const [aid, account] of Object.entries(accounts)) {
        if (aid !== accountId && account.wallet && account.wallet.toLowerCase() === walletLower) {
            return { success: false, error: 'Wallet already linked to another account', status_code: 409 };
        }
    }

    // 5. Account does not already have a wallet
    const account = accounts[accountId];
    if (!account) {
        return { success: false, error: 'Account not found', status_code: 404 };
    }

    if (account.wallet) {
        return { success: false, error: 'Account already has a wallet linked', status_code: 409 };
    }

    // 6. Persist
    account.wallet = walletLower;
    account.wallet_linked_at = Date.now();
    saveAccounts(accounts);

    return { success: true, wallet: walletLower };
}

// ─── Route Setup ──────────────────────────────────────────────────────────────

function setupAccountRoutes(app) {

    // ── POST /auth/magic-link ─────────────────────────────────────────────────
    app.post('/auth/magic-link', async (c) => {
        let body;
        try { body = await c.req.json(); } catch {
            return c.json({ error: 'Invalid JSON body' }, 400);
        }

        const { email } = body || {};

        if (!email || typeof email !== 'string' || email.trim() === '') {
            return c.json({ error: 'email is required' }, 400);
        }

        // Basic email format validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email.trim())) {
            return c.json({ error: 'Invalid email format' }, 400);
        }

        const normalizedEmail = email.trim().toLowerCase();
        const ip = getClientIp(c);

        // Rate limit: per email
        if (isRateLimited('email', normalizedEmail, RATE_LIMIT_BY_EMAIL)) {
            return c.json({
                error: 'Too many requests. Please wait 15 minutes before requesting another link.'
            }, 429);
        }

        // Rate limit: per IP
        if (isRateLimited('ip', ip, RATE_LIMIT_BY_IP)) {
            return c.json({
                error: 'Too many requests from this IP. Please wait 15 minutes.'
            }, 429);
        }

        // Generate token: 32 bytes, base64url encoded
        const rawToken = crypto.randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + TOKEN_EXPIRY_MS;

        // A-5: persist only SHA-256(token), never the plaintext token. The
        // plaintext is mailed to the user; at rest we keep only its hash so a
        // data-dir/backup leak yields no usable login tokens.
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const links = loadMagicLinks();
        links[tokenHash] = { email: normalizedEmail, expires_at: expiresAt };
        saveMagicLinks(links);

        // LW-1: deliver via Resend when RESEND_API_KEY is set; console-log in dev.
        // The magic link must land on /dashboard (not the raw /auth/verify API):
        // dashboard.html reads ?token= from its URL, exchanges it at GET /auth/verify
        // for the JWT, stores the JWT in localStorage, and renders. Pointing the email
        // straight at /auth/verify dumped the JWT as JSON with no dashboard (login bug).
        const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/dashboard?token=${encodeURIComponent(rawToken)}`;
        if (email_.emailEnabled()) {
            // Prod mode: NEVER log the verify URL (token leakage to logs).
            // Delivery failures are logged to stderr inside sendMagicLink();
            // we still return the neutral 200 below either way
            // (email-enumeration defense).
            await email_.sendMagicLink(normalizedEmail, verifyUrl);
        } else {
            warnDevEmailModeOnce();
            console.log(`[accounts] Magic link for ${normalizedEmail}: ${verifyUrl}`);
        }

        // Neutral response — does not confirm or deny whether email exists
        return c.json({ message: 'If that email is valid, a login link has been sent.' });
    });

    // ── GET /auth/verify ──────────────────────────────────────────────────────
    app.get('/auth/verify', async (c) => {
        const rawToken = c.req.query('token');

        if (!rawToken || rawToken.trim() === '') {
            return c.json({ error: 'token query parameter is required' }, 400);
        }

        const links = loadMagicLinks();

        // Ensure token has expected length (32 bytes base64url = 43 chars)
        const inputStr = rawToken.trim();
        if (inputStr.length !== 43) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        // A-5: tokens are stored as SHA-256(token). Hash the incoming token and
        // look up by hash. The lookup is O(1) on a non-secret hex digest; timing
        // attacks are not a concern because the stored keys are hashes of a
        // 256-bit CSPRNG token, so there is nothing to brute-force by timing.
        // (The previous cosmetic dummy timingSafeEqual compared a constant string
        // to itself and protected nothing — removed.)
        const inputHash = crypto.createHash('sha256').update(inputStr).digest('hex');
        const entry = links[inputHash];
        let matchedToken = null;
        let matchedEntry = null;

        if (entry) {
            matchedToken = inputHash;
            matchedEntry = entry;
        }

        if (!matchedEntry) {
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        // Check expiry
        if (matchedEntry.expires_at < Date.now()) {
            // Clean up
            delete links[matchedToken];
            saveMagicLinks(links);
            return c.json({ error: 'Invalid or expired token' }, 401);
        }

        // Single-use: delete token immediately
        delete links[matchedToken];
        saveMagicLinks(links);

        // FIX 3: Check if the email is NEW before calling findOrCreateAccount.
        // If the IP is already at limit for new accounts, reject BEFORE writing
        // anything to disk — prevents phantom accounts that exist on disk but
        // the user never receives a session for.
        const ip = getClientIp(c);
        const emailAlreadyExists = accountExistsByEmail(matchedEntry.email);

        if (!emailAlreadyExists) {
            // New email → enforce IP-based creation throttle first
            if (isNewAccountRateLimited(ip)) {
                return c.json({
                    error: 'Account creation limit reached. Try again in 24 hours.'
                }, 429);
            }
        }

        // Now safe to find-or-create (throttle already passed for new accounts)
        const { accountId, created } = findOrCreateAccount(matchedEntry.email);

        // Issue JWT
        const jwt = await signJwt(accountId, matchedEntry.email);

        console.log(`[accounts] Verified magic link for ${matchedEntry.email} → account ${accountId}${created ? ' (new)' : ''}`);
        return c.json({ token: jwt });
    });

    // ── POST /account/api-keys ────────────────────────────────────────────────
    // Supports both the legacy ?name/scope format and the new ?label format.
    // The label field takes precedence for new-style scoped keys.
    app.post('/account/api-keys', requireAuth, async (c) => {
        let body;
        try { body = await c.req.json(); } catch { body = {}; }

        const accountId = c.get('accountId');
        const accounts = loadAccounts();
        const account = accounts[accountId];

        if (!account) {
            return c.json({ error: 'Account not found' }, 404);
        }

        // Lazy migrate single-key accounts
        migrateToApiKeysArray(account);

        // ── New-style labeled key creation ──────────────────────────────────
        // If a 'label' field is present (or no legacy 'name'), use labeled path.
        const hasLabel = 'label' in (body || {});
        const hasName  = 'name'  in (body || {});

        if (hasLabel || !hasName) {
            // Labeled path (spec D2)
            const keyLabel = ((body?.label || 'default-' + Date.now()) + '').trim().slice(0, 50);

            // Max 10 keys per account
            if ((account.api_keys || []).length >= 10) {
                return c.json({ error: 'Maximum 10 API keys per account' }, 400);
            }
            // Label uniqueness (active keys only)
            if ((account.api_keys || []).some(k => k.label === keyLabel && k.active !== false)) {
                return c.json({ error: 'Key label already exists' }, 409);
            }

            // GOV-3: least-privilege by default. Labeled keys are 'contribute'
            // unless the caller explicitly opts into another scope. An invalid
            // scope is rejected rather than silently upgraded.
            // D2 (Wave 3.4): 'admin' is NEVER issuable via the API — refused
            // explicitly (403), not folded into the generic 400. Pre-existing
            // admin keys are grandfathered but no new one can be minted here.
            const keyScope = ('scope' in (body || {})) ? body.scope : 'contribute';
            if (keyScope === 'admin') {
                return c.json({ error: 'admin scope cannot be issued via the API', code: 'ADMIN_SCOPE_NOT_ISSUABLE' }, 403);
            }
            const LABELED_SCOPES = ['read', 'earnings-read', 'contribute'];
            if (!LABELED_SCOPES.includes(keyScope)) {
                return c.json({ error: `scope must be one of: ${LABELED_SCOPES.join(', ')}` }, 400);
            }

            const rawKey = 'axl_' + crypto.randomBytes(32).toString('hex');
            const hash   = crypto.createHash('sha256').update(rawKey).digest('hex');
            const keyId  = generateKeyId();

            const keyEntry = {
                id:          keyId,
                hash,
                label:       keyLabel,
                scope:       keyScope,  // GOV-3: defaults to 'contribute' (least-privilege)
                scope_version: 2,       // D2: strict (non-grandfathered) scope semantics
                created_at:  new Date().toISOString(),
                last_used_at: null,
                active:      true,
            };

            account.api_keys.push(keyEntry);
            const newIndex = account.api_keys.length - 1;
            saveAccounts(accounts);
            addToKeyIndex(hash, accountId, keyScope, keyId, newIndex, keyLabel);
            console.log(`[accounts] New labeled API key for account ${accountId}: ${keyLabel} (${keyId}, scope: ${keyScope})`);

            return c.json({
                api_key: rawKey,
                label:   keyLabel,
                scope:   keyScope,
                message: 'Store this key — it will not be shown again.',
            }, 201);
        }

        // ── Legacy name/scope key creation ──────────────────────────────────
        const name = (body?.name || '').trim() || 'Unnamed Key';

        // Scope validation
        // D2 (Wave 3.4): 'admin' is NEVER issuable via the API (either path).
        // GOV-3: fail-closed: an unspecified legacy scope is least-privilege.
        const scope = body?.scope || 'read';
        if (scope === 'admin') {
            return c.json({ error: 'admin scope cannot be issued via the API', code: 'ADMIN_SCOPE_NOT_ISSUABLE' }, 403);
        }
        const VALID_SCOPES = ['read', 'earnings-read', 'contribute'];
        if (!VALID_SCOPES.includes(scope)) {
            return c.json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` }, 400);
        }

        // Scope → prefix mapping
        const SCOPE_PREFIXES = { contribute: 'axl_c_', read: 'axl_r_', 'earnings-read': 'axl_e_' };
        const prefix = SCOPE_PREFIXES[scope];

        // Generate raw key (shown once) and store only the hash
        const rawKey = prefix + crypto.randomBytes(24).toString('base64url');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const keyId = generateKeyId();

        account.api_keys.push({
            id:    keyId,
            hash:  keyHash,
            name,
            label: name,  // populate label field too for consistency
            scope,
            scope_version: 2,  // D2 (Wave 3.4): strict scope semantics
            created_at:   Date.now(),
            last_used_at: null,
            active:       true,
        });

        const newIndex = account.api_keys.length - 1;
        saveAccounts(accounts);
        // Keep the in-memory index in sync — no rebuild needed.
        addToKeyIndex(keyHash, accountId, scope, keyId, newIndex, name);
        console.log(`[accounts] New API key created for account ${accountId}: ${keyId} (scope: ${scope})`);

        // Return raw key exactly once
        return c.json({ key: rawKey, id: keyId, name, scope });
    });

    // ── GET /account/dashboard ────────────────────────────────────────────────
    app.get('/account/dashboard', requireAuth, async (c) => {
        const accountId = c.get('accountId');
        const accounts = loadAccounts();
        const account = accounts[accountId];

        if (!account) {
            return c.json({ error: 'Account not found' }, 404);
        }

        // Return key metadata — never expose hash or raw key.
        // D2 (Wave 3.4): the old `|| 'admin'` display fallback contradicted the
        // fail-closed enforcement default (unscoped legacy keys index as 'read')
        // — display now matches enforcement, with the grandfather flag surfaced.
        const safeKeys = (account.api_keys || []).map(k => ({
            id: k.id,
            name: k.name,
            scope: k.scope || 'read',
            grandfathered: !(k.scope_version >= 2),
            created_at: k.created_at,
        }));

        return c.json({
            email: account.email,
            wallet: account.wallet || null,
            api_keys: safeKeys,
            // ToS clickwrap state — the web dashboard uses this to decide whether to
            // present the blocking acceptance gate before wallet-link / withdraw.
            tos: getTosStatus(account),
        });
    });

}

// ─── Stripe Connect Account Linking (Change 6) ──────────────────────────────

function setStripeConnectId(accountId, stripeConnectId) {
    const accounts = loadAccounts();
    if (!accounts[accountId]) return false;
    accounts[accountId].stripe_connect_id = stripeConnectId;
    saveAccounts(accounts);
    return true;
}

// FIX 5: Export newAccountCreationStore and NEW_ACCOUNT_WINDOW_MS so server.js
// can sweep expired entries in sweepRateLimitStores() without importing the
// full store management logic into server.js.
module.exports = {
    setupAccountRoutes,
    requireAuth,
    requireSessionOrApiKey,
    resolveAccountFromRequest,
    resolveAccountAndKeyFromRequest,
    validateApiKey,
    // D2 (Wave 3.4): single-source scope model + rotation
    SCOPE_RANK,
    hasMinScope,
    effectiveScopeForKeyEntry,
    rotateKeyEntry,
    linkWallet,
    getClientIp,
    setStripeConnectId,
    // ToS clickwrap assent capture (R-01 / red-team P0-3)
    CURRENT_TOS_VERSION,
    hasAcceptedCurrentTos,
    isPayeeAgencyInForce,
    isPlatformContributor,
    getTosStatus,
    recordTosAcceptance,
    newAccountCreationStore,
    NEW_ACCOUNT_WINDOW_MS,
    rebuildKeyIndex,
    removeFromKeyIndex,
    addToKeyIndex,
    migrateToApiKeysArray,
    loadAccounts,
    saveAccounts,
};
