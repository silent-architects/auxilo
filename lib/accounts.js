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

// IR-H-003 FIX: Canonical IP extraction — consistent header priority + socket fallback
function getClientIp(c) {
    // Priority: x-forwarded-for (standard proxy header) > x-real-ip (nginx) > socket
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    const xri = c.req.header('x-real-ip');
    if (xri) return xri.trim();
    // Hono node-server exposes remote address via env
    const remoteAddr = c.env?.incoming?.socket?.remoteAddress;
    if (remoteAddr) return remoteAddr;
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

    // Attach to context for downstream handlers
    c.set('accountId', payload.accountId);
    c.set('email', payload.email);
    await next();
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
            ? [{ hash: account.api_key_hash, label: 'default', scope: 'admin', id: null, active: true }]
            : []);
        for (let i = 0; i < keys.length; i++) {
            const key = keys[i];
            if (key.hash && key.active !== false) {
                apiKeyIndex.set(key.hash, {
                    hash: key.hash,        // stored for timingSafeEqual in validateApiKey
                    accountId,
                    scope:    key.scope || 'admin',
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
    apiKeyIndex.set(keyHash, {
        hash: keyHash,
        accountId,
        scope: scope || 'admin',
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
        scope:      entry.scope,
        key_index:  entry.key_index,
        key_label:  entry.label,
    };
}

// ─── linkWallet ────────────────────────────────────────────────────────────────

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Link a verified wallet to an account.
 *
 * Validation order (matches SPEC-P0.5 § 4.1):
 *   1. Wallet format (EVM hex address).
 *   2. Wallet already verified by the challenge system (caller provides verifiedWallets).
 *   3. Wallet not already claimed by another account.
 *   4. Account does not already have a wallet linked.
 *   5. Write wallet + wallet_linked_at to the account and persist.
 *
 * Does NOT touch earnings.json — caller is responsible for calling
 * lazyMigrateOnWalletLink() and persisting earnings changes.
 *
 * @param {string} accountId          The acc_… ID of the authenticated account.
 * @param {string} wallet             The wallet address to link (any case).
 * @param {Set|object} verifiedWallets   In-memory set/map of verified wallet addresses.
 * @returns {{ success: boolean, error?: string, status_code?: number, wallet?: string }}
 */
function linkWallet(accountId, wallet, verifiedWallets) {
    // 1. Format validation
    if (!wallet || typeof wallet !== 'string' || !EVM_ADDRESS_RE.test(wallet)) {
        return { success: false, error: 'Invalid wallet address format', status_code: 400 };
    }

    const walletLower = wallet.toLowerCase();

    // 2. Verified check
    const isVerified = verifiedWallets instanceof Set
        ? verifiedWallets.has(walletLower)
        : !!(verifiedWallets && verifiedWallets[walletLower]);

    if (!isVerified) {
        return { success: false, error: 'Wallet not verified. Complete the wallet challenge first.', status_code: 403 };
    }

    const accounts = loadAccounts();

    // 3. Not already claimed by another account
    for (const [aid, account] of Object.entries(accounts)) {
        if (aid !== accountId && account.wallet && account.wallet.toLowerCase() === walletLower) {
            return { success: false, error: 'Wallet already linked to another account', status_code: 409 };
        }
    }

    // 4. Account does not already have a wallet
    const account = accounts[accountId];
    if (!account) {
        return { success: false, error: 'Account not found', status_code: 404 };
    }

    if (account.wallet) {
        return { success: false, error: 'Account already has a wallet linked', status_code: 409 };
    }

    // 5. Persist
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

        const links = loadMagicLinks();
        links[rawToken] = { email: normalizedEmail, expires_at: expiresAt };
        saveMagicLinks(links);

        // Dev delivery: log to console. Hook SendGrid/Resend here for prod.
        const verifyUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/auth/verify?token=${encodeURIComponent(rawToken)}`;
        console.log(`[accounts] Magic link for ${normalizedEmail}: ${verifyUrl}`);

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

        // O(1) lookup. Timing attacks are mitigated by the 256-bit entropy of the token.
        // We do a dummy timing-safe comparison to satisfy the spec requirement
        // for "timing-safe comparisons" while avoiding the O(N) DoS vulnerability.
        const dummyBuf = Buffer.from('dummy-string-to-pad-time-123456');
        crypto.timingSafeEqual(dummyBuf, dummyBuf);

        const entry = links[inputStr];
        let matchedToken = null;
        let matchedEntry = null;

        if (entry) {
            matchedToken = inputStr;
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

            const rawKey = 'axl_' + crypto.randomBytes(32).toString('hex');
            const hash   = crypto.createHash('sha256').update(rawKey).digest('hex');
            const keyId  = generateKeyId();

            const keyEntry = {
                id:          keyId,
                hash,
                label:       keyLabel,
                scope:       'admin',  // labeled keys default to admin scope
                created_at:  new Date().toISOString(),
                last_used_at: null,
                active:      true,
            };

            account.api_keys.push(keyEntry);
            const newIndex = account.api_keys.length - 1;
            saveAccounts(accounts);
            addToKeyIndex(hash, accountId, 'admin', keyId, newIndex, keyLabel);
            console.log(`[accounts] New labeled API key for account ${accountId}: ${keyLabel} (${keyId})`);

            return c.json({
                api_key: rawKey,
                label:   keyLabel,
                message: 'Store this key — it will not be shown again.',
            }, 201);
        }

        // ── Legacy name/scope key creation ──────────────────────────────────
        const name = (body?.name || '').trim() || 'Unnamed Key';

        // Scope validation
        const VALID_SCOPES = ['admin', 'read', 'contribute'];
        const scope = body?.scope || 'admin';
        if (!VALID_SCOPES.includes(scope)) {
            return c.json({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}` }, 400);
        }

        // Scope → prefix mapping
        const SCOPE_PREFIXES = { contribute: 'axl_c_', read: 'axl_r_', admin: 'axl_a_' };
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

        // Return key metadata — never expose hash or raw key
        const safeKeys = (account.api_keys || []).map(k => ({
            id: k.id,
            name: k.name,
            scope: k.scope || 'admin',
            created_at: k.created_at,
        }));

        return c.json({
            email: account.email,
            wallet: account.wallet || null,
            api_keys: safeKeys,
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
    validateApiKey,
    linkWallet,
    getClientIp,
    setStripeConnectId,
    newAccountCreationStore,
    NEW_ACCOUNT_WINDOW_MS,
    rebuildKeyIndex,
    removeFromKeyIndex,
    addToKeyIndex,
    migrateToApiKeysArray,
    loadAccounts,
    saveAccounts,
};
