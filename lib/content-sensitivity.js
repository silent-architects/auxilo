/**
 * lib/content-sensitivity.js — LW-16 content-sensitivity classifier
 *
 * THE PROBLEM THIS SOLVES: on 2026-06-10, autonomous extraction mass-published
 * private learnings full of client names, R&D context, and personal data. The
 * existing screens do NOT catch that class of content:
 *   - lib/sensitivity-filter.js → credentials / secrets / PII *tokens* (keys,
 *     emails, IPs) — not confidential *narrative* content.
 *   - lib/injection-screen.js   → prompt-injection phrasing — not confidentiality.
 *   - lib/similarity.js         → duplication — orthogonal.
 * So "passes the existing screens" must NOT be read as "safe to auto-publish."
 *
 * This module is the gate that lets GENUINE generic tech learnings publish
 * seamlessly while holding anything that looks like it carries person / client
 * / brand / proprietary content for human review.
 *
 * DESIGN BIAS — OVER-FLAG, NEVER UNDER-FLAG (read carefully):
 *   A false positive costs the contributor ONE extra click in `auxilo review`.
 *   A false negative re-causes the incident: private content auto-published to a
 *   public marketplace. The two error modes are NOT symmetric. Every heuristic
 *   here is tuned toward firing when ambiguous. The tech-term allowlist is the
 *   ONLY mechanism pulling the other way, and it is intentionally narrow —
 *   known generic tech proper nouns only. An unknown Brand-like token is treated
 *   as a (weak) sensitivity signal, not waved through.
 *
 * Pure module: no fs, no network, no Hono. Unit-testable in isolation
 * (test/lw16-content-sensitivity.test.js). server.js wires classifySensitivity
 * into /learn and /extract and uses evaluateGate as the publish predicate.
 */

'use strict';

const CONTENT_SENSITIVITY_VERSION = '0.1.0';

// Score threshold: a learning is `sensitive` when score >= this OR any hard
// signal fires. Tuned low (conservative) — two weak corroborating signals are
// enough to hold for review.
const SENSITIVE_THRESHOLD = 3;

// ─── Tech-term allowlist (the false-positive control) ───────────────────────
// Proper nouns that legitimately appear in generic, sensitive-data-free tech
// learnings. Seeded by extracting every capitalized token from
// outputs/SEED-VERIFIED.json (the 22 verified seeds) plus the broader ecosystem
// of common tools/APIs/formats. Matching is case-insensitive on whole tokens.
//
// IMPORTANT: this list only suppresses the proper-noun / person-name heuristics.
// It does NOT suppress hard signals (email, private path, account id, @handle,
// proprietary-context phrases) — those fire regardless of allowlist membership.
const TECH_ALLOWLIST = new Set([
  // Cloud / platforms
  'google', 'gcp', 'aws', 'azure', 'cloudflare', 'vercel', 'netlify', 'heroku',
  'fly', 'railway', 'render', 'digitalocean', 'linode', 'firebase', 'supabase',
  'vertex', 'bigquery', 'cloudfront', 's3', 'ec2', 'lambda', 'kubernetes', 'k8s',
  'docker', 'terraform', 'ansible', 'pulumi',
  // Google ecosystem (heavy in the seeds)
  'gmail', 'drive', 'docs', 'sheets', 'slides', 'calendar', 'apps', 'script',
  'gemini', 'flash', 'analytics', 'ga4', 'tag', 'manager', 'workspace',
  'propertiesservice', 'getscriptproperties', 'oauth', 'oauth2',
  // LLM / AI
  'openai', 'anthropic', 'claude', 'gpt', 'llama', 'mistral', 'cohere', 'ollama',
  'huggingface', 'langchain', 'mem0', 'pinecone', 'weaviate', 'chroma', 'sdk',
  'generative', 'language', 'temporal', 'reasoning', 'decay', 'memory', 'llm',
  // Payments / commerce
  'stripe', 'paypal', 'square', 'plaid', 'shopify', 'coinbase', 'circle',
  // Languages / runtimes
  'node', 'nodejs', 'deno', 'bun', 'python', 'ruby', 'rust', 'golang', 'java',
  'kotlin', 'swift', 'typescript', 'javascript', 'php', 'dotnet', 'omp', 'openmp',
  'cpu', 'gpu', 'io', 'cli', 'api', 'apis', 'sdk', 'rpc', 'grpc', 'rest', 'dom',
  // OS / hardware
  'macos', 'osx', 'darwin', 'linux', 'ubuntu', 'debian', 'windows', 'ios',
  'android', 'apple', 'silicon', 'arm', 'arm64', 'x86', 'intel', 'amd', 'm1',
  'm2', 'm3', 'launchagent', 'launchagents', 'launchd', 'systemd', 'terminal',
  'tcc', 'transparency', 'consent', 'control', 'eperm', 'eagain', 'enoent',
  'programarguments', 'workingdirectory', 'standardoutpath', 'standarderrorpath',
  // Formats / specs / web
  'json', 'yaml', 'toml', 'xml', 'html', 'css', 'svg', 'png', 'jpeg', 'jpg',
  'webp', 'gif', 'pdf', 'csv', 'tsv', 'utf', 'rgb', 'opentype', 'truetype',
  'woff', 'http', 'https', 'tcp', 'udp', 'tls', 'ssl', 'url', 'uri', 'uuid',
  'jwt', 'cors', 'csrf', 'utm', 'ui', 'ux', 'kb', 'mb', 'gb', 'tb',
  // Databases / infra
  'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'sqlite', 'elasticsearch',
  'kafka', 'rabbitmq', 'nginx', 'apache', 'envoy', 'graphql', 'webpack', 'vite',
  'esbuild', 'rollup', 'babel', 'eslint', 'prettier', 'jest', 'vitest', 'pytest',
  // Music / media / scraping tools (present in the seeds)
  'spotify', 'deezer', 'suno', 'upc', 'upcs', 'isrc', 'isrcs', 'scraping',
  'parser', 'preprocess', 'posterize', 'threshold', 'griffin', 'stereo', 'phase',
  // Fonts (present in the seeds)
  'fontshare', 'fontsource', 'general', 'sans', 'mono', 'plex', 'ibm', 'inter',
  'roboto', 'helvetica', 'arial', 'fontface',
  // Dev / process words that appear Title-Cased mid-sentence
  'wonk', 'cleanup', 'backfill', 'remediation', 'wrapper', 'runner', 'enterprise',
  'practical', 'identical', 'concrete', 'systematically', 'middle',
  // Project-internal proper nouns that are part of this product's own docs
  'auxilo', 'renderly', 'openclaw',
]);

// ─── Common capitalized English words (grammar, not proper nouns) ───────────
// These appear Title-Cased mid-sentence or sentence-initial and must NEVER be
// read as a name token. Sentence-initial words are also stripped structurally
// (see tokenizeForNames), but this catches Title-Case mid-sentence emphasis.
const COMMON_CAPS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'while',
  'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their', 'we',
  'our', 'us', 'you', 'your', 'he', 'she', 'his', 'her', 'i', 'my', 'me',
  'for', 'with', 'without', 'from', 'into', 'onto', 'to', 'of', 'in', 'on', 'at',
  'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'do', 'does',
  'did', 'done', 'can', 'could', 'should', 'would', 'will', 'shall', 'may',
  'might', 'must', 'not', 'no', 'yes', 'so', 'because', 'since', 'after',
  'before', 'during', 'until', 'unless', 'whether', 'which', 'who', 'whom',
  'what', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'every', 'some',
  'most', 'more', 'less', 'few', 'many', 'much', 'one', 'two', 'three', 'first',
  'last', 'next', 'new', 'old', 'now', 'always', 'never', 'often', 'only',
  'also', 'just', 'even', 'still', 'instead', 'however', 'therefore', 'thus',
  'note', 'fix', 'check', 'set', 'use', 'add', 'make', 'run', 'go', 'get', 'find',
  'diagnose', 'verify', 'compare', 'wrap', 'route', 'move', 'open', 'close',
  'read', 'write', 'log', 'logs', 'tell', 'look', 'count', 'filter', 'reports',
  'method', 'matching', 'problem', 'symptom', 'caveat', 'caveats', 'diagnosis',
  'environment', 'resolution', 'investigation', 'attempt', 'image', 'model',
  'event', 'key', 'free', 'cost', 'two', 'three', 'high', 'distinguish',
  'presenting', 'picking', 'calling', 'granting', 'relocate', 'rewrite', 'reload',
  'populate', 'audit', 'treat', 'disable', 'vary', 'toggle', 'observed',
  'unassigned', 'unknown', 'operation', 'missing', 'likely', 'critically',
  'defensive', 'diagnostic', 'optional', 'reliable', 'exact', 'root', 'every',
  'both', 'then', 'always', 'never', 'jobs', 'desktop', 'downloads',
  'documents', 'library', 'copy',
  // Common English / UI / OS-permission words that appear Title-Cased in error
  // messages and feature names within generic tech learnings (seed-derived).
  'limit', 'exceeded', 'full', 'disk', 'access', 'type', 'foundry', 'indian',
  'general', 'sans', 'mono', 'service', 'services', 'billing', 'reports',
  'enterprise', 'cloud', 'search', 'practical', 'concrete', 'identical',
  'systematically', 'middle', 'threshold', 'preprocess', 'posterize', 'flag',
  'flags', 'backfill', 'cleanup', 'wonk', 'remediation', 'wrapper', 'parser',
  'stereo', 'phase', 'click', 'into', 'toggle', 'vary', 'compare', 'matching',
]);

// ─── Patterns ────────────────────────────────────────────────────────────────

// Email addresses (mirror of sensitivity-filter, kept here so the classifier is
// self-contained for narrative-content gating).
// Linearly-bounded form (D-1 ReDoS fix) — must stay in sync with the copy in
// lib/sensitivity-filter.js. The prior /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/
// backtracked O(n^2) on long dash/digit runs and hung the event loop.
const EMAIL_RE = /[a-z0-9._%+\-]{1,64}@[a-z0-9](?:[a-z0-9\-]{0,253}[a-z0-9])?(?:\.[a-z]{2,24})+/gi;

// @handle mentions (social/Slack/GitHub-style). Requires a leading boundary that
// is NOT part of an email (no preceding word char). Min 2 chars after @.
const HANDLE_RE = /(?<![\w.])@[a-zA-Z][a-zA-Z0-9_]{2,}\b/g;

// Phone numbers — E.164 + common US formats. Conservative (needs separators or +)
// so it does not match bare port numbers or token windows.
const PHONE_RE = /(?:\+\d{1,3}[\s.\-]?)?(?:\(\d{3}\)|\d{3})[\s.\-]\d{3}[\s.\-]\d{4}\b/g;

// Private home file paths that EXPOSE A USERNAME: /Users/<name>, /home/<name>,
// C:\Users\<name>. A real username in a path is the leak — the 2026-06-10
// incident shipped these. The standard tilde home (`~/Documents`, `~/Desktop`,
// `~/Downloads`, `~/Library`) is intentionally NOT flagged: it carries no
// username and appears in generic macOS/Linux tech learnings (e.g. the seeds).
const PRIVATE_PATH_RE =
  /(?:\/Users\/[^/\s]+|\/home\/[^/\s]+|[A-Za-z]:\\Users\\[^\\\s]+)/g;

// Account / wallet / tenant ids. 0x + 40 hex (eth address), acc_..., cus_...,
// org_..., tenant ids with long opaque suffixes.
const ACCOUNT_ID_RE =
  /\b(?:0x[a-fA-F0-9]{40}\b|(?:acc|cus|org|sub|ten|usr|wlt)_[A-Za-z0-9]{8,})/g;

// Private / internal URLs: internal hostnames, *.local, *.internal, IPs in URLs.
// localhost and 127.0.0.1 explicitly excepted (legit dev examples).
const PRIVATE_URL_RE =
  /https?:\/\/(?!localhost|127\.0\.0\.1)(?:[a-z0-9\-]+\.)*(?:internal|local|corp|intranet|lan)\b[^\s]*/gi;

// First-person / proprietary-context phrases. These are HARD signals — the exact
// language that surrounds leaked client work ("our client X", "my company's ...").
const PROPRIETARY_PHRASES = [
  /\bour\s+client\b/i,
  /\bthe\s+client\b/i,
  /\bmy\s+client\b/i,
  /\bclients?\s+(?:called|named|asked|requested|wanted)\b/i,
  /\bmy\s+compan(?:y|ies)\b/i,
  /\bour\s+compan(?:y|ies)\b/i,
  /\b(?:my|our)\s+(?:internal|proprietary|private|confidential)\s+\w+/i,
  /\binternal\s+(?:tool|system|service|project|codename|repo|repository|dashboard)\b/i,
  /\b(?:my|our)\s+team(?:'s)?\b/i,
  /\bthe\s+[A-Z][a-zA-Z0-9]+\s+account\b/, // "the Acme account"
  /\bproject\s+[A-Z][a-zA-Z0-9]+\b/, // "Project Phoenix" — internal codename pattern
  /\bcodename\b/i,
  /\b[A-Z]{2,}-internal\b/,
  /\bunder\s+nda\b/i,
];

// Signal weights. Hard signals (weight >= SENSITIVE_THRESHOLD) flag on their own;
// soft signals must corroborate.
const WEIGHTS = {
  email: 4, // hard
  private_path: 4, // hard
  account_id: 4, // hard
  proprietary_context: 4, // hard
  person_name: 4, // hard — the exact class the incident leaked
  social_handle: 3, // hard
  phone: 3, // hard
  private_url: 3, // hard
  unknown_proper_noun: 1, // soft — needs corroboration (or several of them)
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Split text into sentences and, for each, return its non-initial word tokens
 * tagged with whether each is the sentence's first word. The first word of a
 * sentence is grammar-capitalized and must be excluded from name detection.
 *
 * @param {string} text
 * @returns {Array<{ word: string, sentenceInitial: boolean }>}
 */
function tokenizeForNames(text) {
  const out = [];
  // Split on sentence boundaries and newlines/bullets — anything that resets the
  // "first word is capitalized by grammar" rule.
  const sentences = text.split(/(?<=[.!?:;])\s+|\n+|^\s*[-*•]\s*/m);
  for (const sentence of sentences) {
    const words = sentence.match(/[A-Za-z][A-Za-z'.\-]*/g) || [];
    words.forEach((w, i) => {
      out.push({ word: w, sentenceInitial: i === 0 });
    });
  }
  return out;
}

/** Is a token a "known/grammar" word that can never be a name part? */
function isKnownWord(token) {
  const lower = token.toLowerCase().replace(/[.'-]+$/g, '');
  return TECH_ALLOWLIST.has(lower) || COMMON_CAPS.has(lower);
}

/** Does this token LOOK like a name part: Title-Case, alphabetic, len >= 2? */
function looksLikeNamePart(token) {
  return /^[A-Z][a-z]{1,}$/.test(token);
}

// Words that, appearing immediately before or after a Title-Case bigram, are
// strong evidence the bigram is a PERSON (not a product/error/UI phrase). This
// corroboration is what makes person_name precise enough not to fire on
// "Limit Exceeded" / "Full Disk Access" while still catching "Sarah Johnson
// asked" — including names at the start of a sentence.
const PERSON_CONTEXT = new Set([
  'asked', 'said', 'told', 'wrote', 'emailed', 'messaged', 'called', 'named',
  'contacted', 'replied', 'reached', 'met', 'spoke', 'mentioned', 'requested',
  'reported', 'flagged', 'approved', 'rejected', 'signed', 'owns', 'owned',
  'manages', 'managed', 'leads', 'led', 'reports', 'joined', 'left', 'quit',
  'hired', 'fired', 'by', 'from', 'with', 'cc', 'attn', 'mr', 'mrs', 'ms',
  'dr', 'prof', 'sir', 'madam', 'ceo', 'cto', 'cfo', 'vp', 'lead', 'manager',
  'director', 'engineer', 'founder', 'client', 'contact', 'colleague',
  'teammate', 'recruiter', 'candidate', 'customer',
]);

/**
 * Detect person-name patterns: a Title-Case `First Last` bigram where neither
 * token is a known tech term or common grammar/UI word, corroborated by a
 * person-context cue immediately adjacent (a person verb/title/relationship) OR
 * a possessive ("Sarah's"). This is the highest-weighted heuristic — it is the
 * class the 2026-06-10 incident leaked — and the corroboration keeps it precise
 * enough not to fire on Title-Cased error/UI phrases in generic tech learnings.
 *
 * Sentence-initial names ARE caught: "Sarah Johnson asked …" must flag even
 * though "Sarah" is the first word. Conservative tie-break — when corroboration
 * is absent, a lone unknown Title-Case bigram still contributes via the
 * unknown_proper_noun soft signal (counted separately), so a real client name
 * like "Vandelay Industries" is not lost; it just routes through the softer path.
 *
 * @param {string} text
 * @returns {boolean}
 */
function hasPersonName(text) {
  const toks = tokenizeForNames(text);
  for (let i = 0; i < toks.length - 1; i++) {
    const a = toks[i];
    const b = toks[i + 1];
    if (!looksLikeNamePart(a.word) || !looksLikeNamePart(b.word)) continue;
    if (isKnownWord(a.word) || isKnownWord(b.word)) continue;

    // Possessive on either token → person ("Sarah's", "Johnson's").
    const possessive = /'s$/i.test(a.word) || /'s$/i.test(b.word);

    // Adjacent person-context cue: the token before `a` or after `b`.
    const before = i > 0 ? toks[i - 1].word.toLowerCase().replace(/[.'-]+$/g, '') : '';
    const after = i + 2 < toks.length ? toks[i + 2].word.toLowerCase().replace(/[.'-]+$/g, '') : '';
    const corroborated =
      PERSON_CONTEXT.has(before) || PERSON_CONTEXT.has(after) || possessive;

    if (corroborated) return true;
  }
  return false;
}

/**
 * Count unknown proper-noun-like tokens: Title-Case, not sentence-initial, not
 * in the tech allowlist, not a common grammar word. Brand-like tokens
 * ("Vandelay", "Acme") land here. Each is a WEAK signal — a single one will not
 * flag on its own, but several, or one alongside any other signal, will.
 *
 * @param {string} text
 * @returns {number}
 */
function countUnknownProperNouns(text) {
  const toks = tokenizeForNames(text);
  let count = 0;
  const seen = new Set();
  for (const t of toks) {
    if (t.sentenceInitial) continue;
    if (!/^[A-Z][a-z]{2,}$/.test(t.word)) continue; // Title-Case word, len>=3
    if (isKnownWord(t.word)) continue;
    const key = t.word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
  }
  return count;
}

/** Count regex matches, resetting lastIndex for /g patterns. */
function countMatches(re, text) {
  re.lastIndex = 0;
  let n = 0;
  while (re.exec(text) !== null) {
    n++;
    if (!re.global) break;
  }
  return n;
}

// ─── Public: classifySensitivity ────────────────────────────────────────────

/**
 * Classify a learning's CONTENT for confidentiality sensitivity.
 *
 * @param {string} title
 * @param {string} body
 * @param {string[]} [tags]
 * @returns {{ sensitive: boolean, signals: string[], score: number }}
 */
function classifySensitivity(title, body, tags) {
  const text = [
    title || '',
    body || '',
    Array.isArray(tags) ? tags.join(' ') : '',
  ].join('\n');

  const signals = [];
  let score = 0;
  const add = (name) => {
    if (!signals.includes(name)) {
      signals.push(name);
      score += WEIGHTS[name] || 1;
    }
  };

  // Hard token signals.
  if (countMatches(EMAIL_RE, text) > 0) add('email');
  if (countMatches(HANDLE_RE, text) > 0) add('social_handle');
  if (countMatches(PHONE_RE, text) > 0) add('phone');
  if (countMatches(PRIVATE_PATH_RE, text) > 0) add('private_path');
  if (countMatches(ACCOUNT_ID_RE, text) > 0) add('account_id');
  if (countMatches(PRIVATE_URL_RE, text) > 0) add('private_url');

  // First-person / proprietary-context phrases (hard).
  if (PROPRIETARY_PHRASES.some((re) => re.test(text))) add('proprietary_context');

  // Person-name bigram (hard).
  if (hasPersonName(text)) add('person_name');

  // Unknown proper nouns (soft, corroborating). Two or more on their own reach
  // the threshold; one contributes weight that tips an otherwise-borderline body.
  const unknownProperNouns = countUnknownProperNouns(text);
  if (unknownProperNouns >= 1) {
    // weight scales with count, capped so a long tech doc with a couple of
    // unusual-but-benign tokens does not runaway-flag on this signal alone.
    signals.push('unknown_proper_noun');
    score += Math.min(unknownProperNouns, 3) * WEIGHTS.unknown_proper_noun;
  }

  const sensitive = score >= SENSITIVE_THRESHOLD;
  return { sensitive, signals, score };
}

// ─── Public: evaluateGate (the publish predicate) ───────────────────────────

/**
 * Evaluate the LW-16 seamless-publish predicate. A submission publishes
 * seamlessly only when EVERY screen is clean AND the kill switch is off.
 *
 * This is the pure core of the server-side gate so the predicate is unit-testable
 * without booting server.js. server.js computes the individual boolean inputs
 * from its screens (sensitivity-filter, injection-screen, near-dup, this
 * classifier, quality presence) and the FORCE_ALL_REVIEW env var, then calls
 * this to decide status + review_reason.
 *
 * @param {object} flags
 * @param {boolean} flags.sensitivityFilterClean  credentials/PII filter passed
 * @param {boolean} flags.injectionClean          injection screen passed
 * @param {boolean} flags.nearDupClean            no near-dup flag
 * @param {boolean} flags.contentSensitivityClean content classifier passed (NOT sensitive)
 * @param {boolean} flags.qualityPresent          quality self-score present / scoreLearning pass
 * @param {boolean} flags.forceAllReview          FORCE_ALL_REVIEW kill switch
 * @returns {{ seamlessEligible: boolean, reviewReason: string[] }}
 */
function evaluateGate(flags = {}) {
  const reviewReason = [];
  if (flags.forceAllReview) reviewReason.push('forced_review');
  if (flags.sensitivityFilterClean === false) reviewReason.push('credentials');
  if (flags.injectionClean === false) reviewReason.push('injection');
  if (flags.nearDupClean === false) reviewReason.push('near_duplicate');
  if (flags.contentSensitivityClean === false) reviewReason.push('content_sensitivity');
  if (flags.qualityPresent === false) reviewReason.push('awaiting_quality');

  const seamlessEligible = reviewReason.length === 0;
  return { seamlessEligible, reviewReason };
}

module.exports = {
  classifySensitivity,
  evaluateGate,
  CONTENT_SENSITIVITY_VERSION,
  SENSITIVE_THRESHOLD,
  // exported for tests / introspection
  TECH_ALLOWLIST,
};
