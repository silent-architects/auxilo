/**
 * lib/sensitivity-filter.js
 *
 * Sensitivity filter for agent learning submissions.
 * Scans title, body, task_context, and tags for patterns that
 * indicate private/secret data (keys, tokens, credentials, IPs).
 *
 * Two-mode operation:
 *   - Supervised mode: human reviews all learnings (filter is advisory)
 *   - Autonomous mode: filter gates submission — if triggered, learning
 *     is rejected with details so the agent can redact and resubmit
 *
 * Returns { clean: true } or { clean: false, matches: [...] }
 */

'use strict';

// ─── Version ─────────────────────────────────────────────────────────────────
// Bumped when patterns are added or behavior changes. Server rejects extractions
// from clients older than N-1 (§7.6).
// 0.5.0 (task-#19, 2026-07-19): Google Drive/Docs/Sheets/Slides file-ID
// patterns — a private Drive doc ID survived the scrubber in the wild.
const SENSITIVITY_FILTER_VERSION = '0.5.0';

// ─── Patterns ────────────────────────────────────────────────────────────────
// Each pattern has a name, regex, and description for the rejection message.

const PATTERNS = [
  {
    name: 'private_key',
    regex: /0x[a-fA-F0-9]{64}/g,
    description: 'Blockchain private key (64-char hex)',
  },
  {
    name: 'api_token',
    regex: /(Bearer\s+|sk-|cnwy_k|ghp_|gho_|AKIA)[A-Za-z0-9_\-]{8,}/g,
    description: 'API token or credential (Bearer, sk-, ghp_, AKIA, etc.)',
  },
  {
    name: 'jwt_token',
    regex: /eyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+/g,
    description: 'JWT token',
  },
  {
    name: 'internal_ip',
    regex: /(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})/g,
    description: 'Private/internal IP address (RFC 1918)',
  },
  {
    // M-4: Negative lookahead to suppress common placeholder/null false positives.
    // Skips: password=null, =undefined, =<anything>, =***, =xxx, ={...}
    name: 'password_pair',
    regex: /password[=:]\s*(?!null\b|undefined\b|<[^>]+>|\*+|xxx+|\{[^}]+\})\S+/gi,
    description: 'Password value in plaintext',
  },
  {
    name: 'connection_string',
    regex: /(mongodb|postgres|mysql|redis):\/\/[^\s]+@/g,
    description: 'Database connection string with credentials',
  },
  {
    name: 'env_secret',
    regex: /[A-Z_]+=(sk-|ghp_|Bearer |0x[a-fA-F0-9]{64})/g,
    description: 'Environment variable containing secret value',
  },
  {
    // M-3: Word-boundary assertions on aws_secret to prevent matching substrings
    // of larger base64 strings. contextRequired keeps it quiet without a keyword.
    name: 'aws_secret',
    regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    description: 'Potential AWS secret access key (40-char base64)',
    contextRequired: true,
  },
  // ── New patterns added in SPEC-SF (C-1, C-2) ──────────────────────────────
  {
    // C-1: SSH/RSA/EC/OPENSSH/DSA/ED25519 private key headers
    name: 'ssh_private_key',
    regex: /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|ED25519)?\s*PRIVATE KEY-----/g,
    description: 'SSH/TLS private key header (PEM format)',
  },
  {
    name: 'slack_token',
    regex: /(xoxb-|xoxp-|xoxs-|xoxa-|xoxo-)[A-Za-z0-9\-]{10,}/g,
    description: 'Slack API token (bot, user, or workspace)',
  },
  {
    // C-2: Dedicated Stripe pattern — catches sk_live_, pk_live_, rk_live_, sk_test_, pk_test_
    // that the generic sk- prefix in api_token missed for live keys.
    name: 'stripe_key',
    regex: /(sk_live_|pk_live_|rk_live_|sk_test_|pk_test_)[A-Za-z0-9]{10,}/g,
    description: 'Stripe API key (live or test)',
  },
  {
    name: 'google_api_key',
    regex: /AIza[A-Za-z0-9_\-]{35}/g,
    description: 'Google API key (AIza... format)',
  },
  {
    name: 'npm_token',
    regex: /npm_[A-Za-z0-9]{36}/g,
    description: 'npm access token',
  },
  {
    // pem_block complements ssh_private_key — catches CERTIFICATE, PUBLIC KEY,
    // PRIVATE KEY (generic), and ENCRYPTED PRIVATE KEY blocks.
    name: 'pem_block',
    regex: /-----BEGIN\s+(CERTIFICATE|PUBLIC KEY|PRIVATE KEY|ENCRYPTED PRIVATE KEY)-----/g,
    description: 'PEM block header (certificate or key)',
  },
  // ── P2.1a new patterns (§7.6 — 10 additions) ─────────────────────────────
  {
    name: 'email_address',
    // Linearly-bounded form (D-1 ReDoS fix). The previous
    // /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/ backtracked O(n^2) on a long run
    // of dash/digit chars with no valid TLD, pinning the single-process event
    // loop for minutes. Each quantifier here is explicitly bounded and the
    // domain labels do not overlap with the dot separators, so there is no
    // catastrophic-backtracking path.
    regex: /[a-z0-9._%+\-]{1,64}@[a-z0-9](?:[a-z0-9\-]{0,253}[a-z0-9])?(?:\.[a-z]{2,24})+/gi,
    description: 'Email address',
  },
  {
    // E.164 (+1234567890) + common US formats (123-456-7890, (123) 456-7890)
    name: 'phone_number',
    regex: /(\+\d{1,3}[\s.-]?)?(\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]?\d{4}(?!\d)/g,
    description: 'Phone number (E.164 or US format)',
    contextRequired: true, // suppress false positives on port numbers, timestamps
  },
  {
    name: 'http_cookie',
    regex: /(Cookie|Set-Cookie):\s*\S+/gi,
    description: 'HTTP Cookie header',
  },
  {
    name: 'authorization_header',
    regex: /Authorization:\s*\S+/gi,
    description: 'HTTP Authorization header',
  },
  {
    name: 'gcp_service_account',
    regex: /"type"\s*:\s*"service_account"/g,
    description: 'GCP service account JSON key',
  },
  {
    name: 'azure_sas_token',
    regex: /sig=[A-Za-z0-9%]{20,}/g,
    description: 'Azure Storage SAS token',
  },
  {
    name: 'github_pat',
    regex: /github_pat_[A-Za-z0-9_]{80,}/g,
    description: 'GitHub fine-grained personal access token',
  },
  {
    name: 'openai_project_key',
    regex: /sk-proj-[A-Za-z0-9]{20,}/g,
    description: 'OpenAI project API key',
  },
  {
    // sk-ant-* — we host the marketplace; leaking these is a reputational nuke
    name: 'anthropic_key',
    regex: /sk-ant-[A-Za-z0-9_\-]{20,}/g,
    description: 'Anthropic API key',
  },
  {
    name: 'discord_bot_token',
    regex: /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/g,
    description: 'Discord bot token',
  },
  // ── task-#19 (2026-07-19): Google Drive file IDs ──────────────────────────
  // Found live: a private Google Drive doc ID survived the scrubber. A Drive
  // ID is a capability reference — a link-shared doc is readable by ANYONE
  // holding the ID — so it is credentials-class, not merely PII-class.
  {
    // The /d/<id>/ URL shapes across the editors + Drive, plus the id= and
    // folders/ forms. Precise (requires the google.com host shape), so it
    // fires unconditionally — a Drive URL in a public learning is never a
    // false positive worth waving through.
    name: 'google_drive_url',
    regex: /(?:docs|drive|sheets|slides)\.google\.com\/(?:(?:document|spreadsheets|presentation|forms|drawings|file)\/(?:u\/\d+\/)?d\/[A-Za-z0-9_-]{20,}|open\?[^\s]*\bid=[A-Za-z0-9_-]{20,}|uc\?[^\s]*\bid=[A-Za-z0-9_-]{20,}|drive\/(?:u\/\d+\/)?folders\/[A-Za-z0-9_-]{20,}|folderview\?[^\s]*\bid=[A-Za-z0-9_-]{20,})/g,
    description: 'Google Drive/Docs/Sheets/Slides URL exposing a file ID',
  },
  {
    // Bare Drive-ID heuristic, GUARDED (this filter is a hard 422 at /learn,
    // so a loose rule bounces legit content). Shape: modern IDs start with
    // '1' (33/44 chars), legacy folder IDs with '0B'; charset base64url.
    // The validate hook requires an uppercase letter, '-', or '_' in the
    // match — excludes 40-char lowercase git SHAs (the realistic collision
    // class), long lowercase words, and decimal runs. Miss cost: a real
    // 24+-char base64url ID with zero uppercase AND zero -_ ≈ (36/64)^24
    // ≈ 1e-6 — three orders below the regex layer's own recall, and the URL
    // rule above still catches every linked form.
    name: 'google_drive_id',
    regex: /(?<![A-Za-z0-9_-])(?:1|0B)[A-Za-z0-9_-]{24,63}(?![A-Za-z0-9_-])/g,
    description: 'Bare Google Drive file ID (25+ char base64url, 1/0B prefix)',
    validate: (m) => /[A-Z_-]/.test(m.slice(1)),
  },
];

// ─── M-2: /g flag invariant assertion at module load ────────────────────────
// Fail loudly at startup if any pattern is accidentally written without /g.
for (const p of PATTERNS) {
  if (!p.regex.global) throw new Error(`[sensitivity-filter] Pattern "${p.name}" is missing /g flag`);
}

// ─── Context keywords that make ambiguous patterns more suspicious ───────────
const CONTEXT_KEYWORDS = [
  'secret', 'key', 'token', 'credential', 'password', 'auth',
  'aws_secret', 'access_key', 'private', 'apikey', 'api_key',
];

/**
 * Scan text fields of a learning for sensitive patterns.
 *
 * @param {Object} learning - The learning object to scan
 * @param {string} learning.title
 * @param {string} learning.body
 * @param {string} learning.task_context
 * @param {string[]} learning.tags
 * @returns {{ clean: boolean, matches?: Array<{ pattern: string, field: string, match: string, description: string }> }}
 */
function scanLearning(learning) {
  const fields = {
    title: learning.title || '',
    body: learning.body || '',
    task_context: learning.task_context || '',
    tags: Array.isArray(learning.tags) ? learning.tags.join(' ') : '',
  };

  const allText = Object.values(fields).join(' ');
  const hasContextKeyword = CONTEXT_KEYWORDS.some(kw =>
    allText.toLowerCase().includes(kw)
  );

  const matches = [];

  for (const pattern of PATTERNS) {
    // Skip context-required patterns unless context keywords are present
    if (pattern.contextRequired && !hasContextKeyword) continue;

    for (const [fieldName, fieldValue] of Object.entries(fields)) {
      // Reset regex lastIndex for global patterns
      pattern.regex.lastIndex = 0;
      let m;
      while ((m = pattern.regex.exec(fieldValue)) !== null) {
        // For private keys, skip if it's a well-known contract/wallet address (42 chars = address, not 64-char key)
        if (pattern.name === 'private_key') {
          // 0x + 64 hex = 66 chars total — this IS a key
          // 0x + 40 hex = 42 chars total — this is an address, not a key
          if (m[0].length <= 42) continue;
        }

        // task-#19: optional per-pattern validate hook — a match the hook
        // refuses is skipped (used to guard heuristic patterns whose raw
        // regex would over-fire, e.g. the bare Drive-ID rule).
        if (pattern.validate && !pattern.validate(m[0])) continue;

        matches.push({
          pattern: pattern.name,
          field: fieldName,
          match: redactMatch(m[0]),
          description: pattern.description,
        });
      }
    }
  }

  if (matches.length === 0) {
    return { clean: true };
  }

  return { clean: false, matches };
}

/**
 * Redact a matched value for safe display in error messages.
 * H-2 fix: shows first 3 and last 2 characters (5 total visible),
 * replacing the middle with *** to reduce information leakage.
 * For very short values (<=8 chars), shows first 2 chars + ***.
 */
function redactMatch(value) {
  if (value.length <= 8) return value.substring(0, 2) + '***';
  return value.substring(0, 3) + '***' + value.substring(value.length - 2);
}

/**
 * Generate redaction suggestions for the agent.
 * Maps pattern names to placeholder formats.
 */
function getRedactionHint(patternName) {
  const hints = {
    private_key: '0x{PRIVATE_KEY}',
    api_token: '{API_TOKEN}',
    jwt_token: '{JWT_TOKEN}',
    internal_ip: '{PRIVATE_IP}',
    password_pair: 'password={REDACTED}',
    connection_string: '{protocol}://{CREDENTIALS}@{host}',
    env_secret: '{ENV_VAR}={REDACTED}',
    aws_secret: '{AWS_SECRET}',
    // New patterns (SPEC-SF)
    ssh_private_key: '-----BEGIN {KEY_TYPE} PRIVATE KEY-----',
    slack_token: '{SLACK_TOKEN}',
    stripe_key: '{STRIPE_KEY}',
    google_api_key: '{GOOGLE_API_KEY}',
    npm_token: '{NPM_TOKEN}',
    pem_block: '-----BEGIN {PEM_TYPE}-----',
    // P2.1a patterns (§7.6)
    email_address: '{EMAIL}',
    phone_number: '{PHONE}',
    http_cookie: 'Cookie: {REDACTED}',
    authorization_header: 'Authorization: {REDACTED}',
    gcp_service_account: '{GCP_SERVICE_ACCOUNT}',
    azure_sas_token: 'sig={REDACTED}',
    github_pat: '{GITHUB_PAT}',
    openai_project_key: '{OPENAI_KEY}',
    anthropic_key: '{ANTHROPIC_KEY}',
    discord_bot_token: '{DISCORD_TOKEN}',
    // task-#19 patterns
    google_drive_url: 'https://docs.google.com/document/d/{DRIVE_FILE_ID}/',
    google_drive_id: '{DRIVE_FILE_ID}',
  };
  return hints[patternName] || '{REDACTED}';
}

// ─── Normalization (§7.6) ────────────────────────────────────────────────────
// URL-decode + strip whitespace inside likely-token windows before regex matching.
// Applied before pattern scan to defeat simple obfuscation.

/**
 * Normalize text for sensitivity scanning.
 * Decodes URL-encoded characters and strips whitespace within likely token sequences.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
  if (!text) return '';
  // URL-decode
  let normalized = text;
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // If decode fails (malformed %), continue with original
  }
  // Strip whitespace inside sequences that look like they're breaking up tokens:
  // e.g. "sk - ant - api_12" → "sk-ant-api_12"
  normalized = normalized.replace(/([A-Za-z0-9_])\s+([\-_])\s+([A-Za-z0-9])/g, '$1$2$3');
  return normalized;
}

// ─── scanText (P2.1a §7.5) ──────────────────────────────────────────────────
// Raw text scanner for the runner. Cleaner seam than abusing scanLearning({body}).

/**
 * Scan raw text for sensitive patterns.
 * Used by the client-side runner (§7.5) to scrub transcripts before upload.
 *
 * Returns { clean, matches, redacted } where:
 *   - clean: true if no matches found
 *   - matches: array of { pattern, match, description, offset }
 *   - redacted: the text with matched values replaced by redaction hints
 *
 * @param {string} text - Raw text to scan
 * @returns {{ clean: boolean, matches: Array<{pattern: string, match: string, description: string, offset: number}>, redacted: string }}
 */
function scanText(text) {
  if (!text || typeof text !== 'string') {
    return { clean: true, matches: [], redacted: text || '' };
  }

  // Normalize before scanning
  const normalized = normalizeText(text);
  const allTextLower = normalized.toLowerCase();
  const hasContextKeyword = CONTEXT_KEYWORDS.some(kw => allTextLower.includes(kw));

  const matchList = [];

  for (const pattern of PATTERNS) {
    if (pattern.contextRequired && !hasContextKeyword) continue;

    pattern.regex.lastIndex = 0;
    let m;
    while ((m = pattern.regex.exec(normalized)) !== null) {
      // Private key length check (same as scanLearning)
      if (pattern.name === 'private_key' && m[0].length <= 42) continue;

      // task-#19: per-pattern validate hook (same semantics as scanLearning).
      if (pattern.validate && !pattern.validate(m[0])) continue;

      matchList.push({
        pattern: pattern.name,
        match: redactMatch(m[0]),
        description: pattern.description,
        offset: m.index,
        _rawMatch: m[0], // internal, for redaction — never exposed to API
      });
    }
  }

  if (matchList.length === 0) {
    return { clean: true, matches: [], redacted: text };
  }

  // Build redacted text by replacing each match with its redaction hint
  let redacted = text;
  // Sort matches by offset descending to replace from end to start (preserves offsets)
  const sorted = [...matchList].sort((a, b) => b.offset - a.offset);
  for (const m of sorted) {
    const hint = getRedactionHint(m.pattern);
    // Find the raw match in the original text (accounting for normalization drift)
    const idx = redacted.indexOf(m._rawMatch);
    if (idx >= 0) {
      redacted = redacted.slice(0, idx) + hint + redacted.slice(idx + m._rawMatch.length);
    }
  }

  // Strip internal _rawMatch before returning
  const cleanMatches = matchList.map(({ _rawMatch, ...rest }) => rest);

  return { clean: false, matches: cleanMatches, redacted };
}

module.exports = {
  scanLearning,
  scanText,
  getRedactionHint,
  normalizeText,
  PATTERNS,
  SENSITIVITY_FILTER_VERSION,
};
