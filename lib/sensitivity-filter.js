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
    name: 'password_pair',
    regex: /password[=:]\s*\S+/gi,
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
    name: 'aws_secret',
    regex: /[A-Za-z0-9/+=]{40}/g,
    description: 'Potential AWS secret access key (40-char base64)',
    // This one is noisy — only flag if it looks like it's in a config context
    contextRequired: true,
  },
];

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
 * Shows first 6 and last 4 characters, replaces middle with ...
 */
function redactMatch(value) {
  if (value.length <= 12) return value.substring(0, 4) + '...';
  return value.substring(0, 6) + '...' + value.substring(value.length - 4);
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
  };
  return hints[patternName] || '{REDACTED}';
}

module.exports = { scanLearning, getRedactionHint, PATTERNS };
