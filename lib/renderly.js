'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');

// ─── Core Engine Functions ────────────────────────────────────────────

// IR-H-002 FIX: Post-redirect host validation + response size limit
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB — generous for HTML content
// D-8 FIX: cap the HTML actually handed to the backtracking markdown regexes.
// MAX_RESPONSE_SIZE bounds what we *fetch*; this bounds what we *parse* well below it.
// The chained /<tag>[\s\S]*?<\/tag>/gi regexes backtrack O(n^2) on pathological
// unclosed-tag input; measured worst case ~4.5s at 256KB vs ~73s at 1MB on this
// single-process event loop. 256KB is generous for real article content while
// keeping the worst-case stall to a few seconds. (Normal closed-tag HTML at this
// size processes in single-digit ms.)
const MAX_HTML_PROCESS_SIZE = 256 * 1024; // 256KB
const FETCH_TIMEOUT_MS = 15000;
const MAX_REDIRECTS = 5;

// ─── S-1 / S-2 FIX: SSRF resolve-and-pin ──────────────────────────────
// The old isPrivateHost() validated only the literal hostname string and never
// resolved DNS, so an attacker-registered domain (A record -> 169.254.169.254 /
// 127.0.0.1 / 10.x, or <ip>.nip.io) and IPv4-mapped IPv6 literals
// (::ffff:7f00:1, ::ffff:a9fe:a9fe) all bypassed it. The correct primitive is
// resolve-then-pin: resolve to IPs BEFORE connecting, reject any private result,
// then pin the socket to a validated IP (custom http.get lookup hook) so a TOCTOU
// re-resolve / DNS-rebinding cannot swap in a private address. Re-validated on
// every redirect hop.

// Normalize an IP literal to a canonical form for range checks. Handles
// IPv4-mapped IPv6 (::ffff:a.b.c.d AND ::ffff:hhhh:hhhh hex form) by returning
// the embedded dotted-quad IPv4. Returns { family: 4|6, ip } or null.
function normalizeIp(addr) {
  if (typeof addr !== 'string') return null;
  let s = addr.trim().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // Drop zone id (fe80::1%eth0)
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);

  const fam = net.isIP(s);
  if (fam === 4) return { family: 4, ip: s };
  if (fam === 6) {
    const lower = s.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) — already dotted at the tail
    let m = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m && net.isIP(m[1]) === 4) return { family: 4, ip: m[1] };
    // IPv4-mapped hex form (::ffff:7f00:1 -> 127.0.0.1). Also covers
    // ::ffff:0:a.b.c.d style by normalizing the two trailing 16-bit groups.
    m = lower.match(/^::ffff(?::0)?:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (m) {
      const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
      const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      if (net.isIP(v4) === 4) return { family: 4, ip: v4 };
    }
    return { family: 6, ip: lower };
  }
  return null;
}

// True if the IP literal falls in any private/loopback/link-local/ULA/CGNAT range.
function isBlockedIp(addr) {
  const norm = normalizeIp(addr);
  if (!norm) return true; // unparseable -> reject (fail closed)

  if (norm.family === 4) {
    const o = norm.ip.split('.').map(Number);
    if (o.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
    const [a, b] = o;
    if (a === 0) return true;                                   // 0.0.0.0/8 "this network"
    if (a === 127) return true;                                 // 127.0.0.0/8 loopback
    if (a === 10) return true;                                  // 10.0.0.0/8 RFC1918
    if (a === 192 && b === 168) return true;                    // 192.168.0.0/16 RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12 RFC1918
    if (a === 169 && b === 254) return true;                    // 169.254.0.0/16 link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                                  // 224.0.0.0/4 multicast + 240/4 reserved
    return false;
  }

  // IPv6
  const ip = norm.ip;
  if (ip === '::' || ip === '::1') return true;                 // unspecified, loopback
  if (/^f[cd]/.test(ip)) return true;                           // fc00::/7 ULA
  if (/^fe[89ab]/.test(ip)) return true;                        // fe80::/10 link-local
  if (/^ff/.test(ip)) return true;                              // ff00::/8 multicast
  // ::ffff:* that didn't normalize to v4 above (defensive): treat as blocked
  if (ip.startsWith('::ffff:')) return true;
  return false;
}

// Resolve a hostname to its IPs and reject if ANY resolved address is private.
// Returns the list of validated, public IPs to pin against. An IP literal host
// is validated directly without DNS. Throws a GENERIC error on rejection so the
// caller cannot tell *why* (SSRF oracle, see SD-1).
async function resolvePublicIps(hostname) {
  const bare = hostname.replace(/^\[|\]$/g, '');
  // Host is already an IP literal — validate it directly, no DNS.
  if (net.isIP(bare)) {
    if (isBlockedIp(bare)) throw new Error('SSRF_BLOCKED');
    const norm = normalizeIp(bare);
    return [{ address: norm.ip, family: norm.family }];
  }

  let records;
  try {
    records = await dns.promises.lookup(hostname, { all: true });
  } catch {
    throw new Error('SSRF_BLOCKED'); // unresolvable -> fail closed, generic
  }
  if (!records || records.length === 0) throw new Error('SSRF_BLOCKED');
  for (const r of records) {
    if (isBlockedIp(r.address)) throw new Error('SSRF_BLOCKED');
  }
  return records;
}

// Pinned single-hop GET: connects ONLY to a pre-validated IP (via the lookup
// hook) so DNS cannot be re-resolved to a private address between validation and
// connect. Streams the body with a hard byte ceiling, aborting mid-stream.
function pinnedGet(parsedUrl, pinnedIp, family) {
  return new Promise((resolve, reject) => {
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      method: 'GET',
      headers: {
        'User-Agent': 'Renderly/0.3.1 (Web Content API)',
        'Host': parsedUrl.host,
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: FETCH_TIMEOUT_MS,
      // Pin: ignore the resolver entirely, always hand back the validated IP.
      // Node calls the hook with opts.all=true (expecting an array of records)
      // for the modern multi-connect path, and without it (expecting the legacy
      // address/family args) otherwise — support both so the socket can only ever
      // reach the IP we already validated.
      lookup: (_host, lookupOpts, cb) => {
        if (lookupOpts && lookupOpts.all) return cb(null, [{ address: pinnedIp, family }]);
        return cb(null, pinnedIp, family);
      },
    };
    // Preserve correct TLS SNI / cert verification for the real hostname even
    // though we connect to the pinned IP.
    if (isHttps) options.servername = parsedUrl.hostname;

    const req = lib.get(options, (res) => {
      resolve(res);
    });
    req.on('error', (e) => reject(e));
    req.on('timeout', () => { req.destroy(new Error('Request timeout')); });
  });
}

// Read a response stream, aborting once cumulative bytes exceed MAX_RESPONSE_SIZE.
// D-4 FIX: never trust Content-Length and never buffer the whole body first.
function readBodyCapped(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false; // ensure exactly one outcome (size-abort wins the race)
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_SIZE) {
        // Reject FIRST, then tear down the socket. The settled flag makes the
        // subsequent 'aborted'/'error' from destroy() a no-op so the caller
        // always sees the deterministic "Response too large".
        fail(new Error('Response too large'));
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    res.on('error', (e) => fail(e));
    res.on('aborted', () => fail(new Error('Response aborted')));
  });
}

// Fetch a page with resolve-and-pin SSRF protection, manual redirect following
// (re-validated on every hop), a streaming byte ceiling, and a generic error on
// any SSRF rejection. Mirrors the old { html, finalUrl, status } contract.
//
// `opts._resolveIps` is an OPTIONAL injected resolver (same shape as
// resolvePublicIps) used ONLY by the regression tests to exercise the success /
// redirect-revalidation paths against a local server. Production callers pass
// just the URL and get the real, fail-closed resolvePublicIps — the default is
// never weakened.
async function fetchPage(url, opts = {}, _depth = 0) {
  const resolveIps = opts._resolveIps || resolvePublicIps;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('SSRF_BLOCKED');
  }

  // Resolve-and-pin: validate every resolved IP BEFORE connecting.
  const ips = await resolveIps(parsed.hostname);
  const pin = ips[0];

  const res = await pinnedGet(parsed, pin.address, pin.family);
  const status = res.statusCode;

  // Manual redirect following with per-hop re-validation (same resolver applied).
  if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
    res.resume(); // drain
    if (_depth >= MAX_REDIRECTS) throw new Error('Too many redirects');
    let next;
    try {
      next = new URL(res.headers.location, parsed.href);
    } catch {
      throw new Error('Invalid redirect URL');
    }
    if (!['http:', 'https:'].includes(next.protocol)) throw new Error('SSRF_BLOCKED');
    return fetchPage(next.href, opts, _depth + 1);
  }

  if (status < 200 || status >= 300) {
    res.resume(); // drain
    // Generic, non-distinguishing error (SD-1): do not leak upstream status.
    throw new Error('Upstream fetch failed');
  }

  const html = await readBodyCapped(res);
  return { html, finalUrl: parsed.href, status };
}

function stripNonContent(html) {
  // D-8 FIX: cap input before running backtracking regexes so attacker HTML
  // cannot spike CPU regardless of the 5MB fetch ceiling.
  if (typeof html === 'string' && html.length > MAX_HTML_PROCESS_SIZE) {
    html = html.slice(0, MAX_HTML_PROCESS_SIZE);
  }
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
}

function htmlToMarkdown(html) {
  // D-8 FIX: bound input length before the per-tag transforms (stripNonContent
  // already caps, but htmlToMarkdown may be called on pre-stripped HTML).
  if (typeof html === 'string' && html.length > MAX_HTML_PROCESS_SIZE) {
    html = html.slice(0, MAX_HTML_PROCESS_SIZE);
  }
  let text = stripNonContent(html);
  text = text.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  text = text.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  text = text.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  text = text.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  text = text.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, '\n##### $1\n');
  text = text.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, '\n###### $1\n');
  text = text.replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  text = text.replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  text = text.replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  text = text.replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '\n```\n$1\n```\n');
  text = text.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)');
  text = text.replace(/<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)');
  text = text.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, '![]($1)');
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  text = text.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\s*\/?>/gi, '\n---\n');
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, function(_, content) {
    return content.split('\n').map(function(line) { return '> ' + line; }).join('\n');
  });
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function extractStructured(html, url) {
  // D-8 FIX: bound input before the backtracking extraction regexes below.
  if (typeof html === 'string' && html.length > MAX_HTML_PROCESS_SIZE) {
    html = html.slice(0, MAX_HTML_PROCESS_SIZE);
  }
  const result = { title: null, description: null, og: {}, headings: [], links: [], images: [], word_count: 0 };

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) result.title = titleMatch[1].trim().replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) ||
                     html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  if (descMatch) result.description = descMatch[1].trim();

  const ogRegex = /<meta[^>]*property=["']og:([^"']*)["'][^>]*content=["']([^"']*)["']/gi;
  let ogMatch;
  while ((ogMatch = ogRegex.exec(html)) !== null) { result.og[ogMatch[1]] = ogMatch[2]; }

  const headingRegex = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi;
  let hMatch;
  while ((hMatch = headingRegex.exec(html)) !== null) {
    const level = parseInt(hMatch[1][1]);
    const text = hMatch[2].replace(/<[^>]+>/g, '').trim();
    if (text) result.headings.push({ level, text });
  }

  const linkRegex = /<a[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seenLinks = new Set();
  let lMatch;
  while ((lMatch = linkRegex.exec(html)) !== null) {
    let href = lMatch[1].trim();
    if (href.startsWith('/')) { try { href = new URL(href, url).href; } catch {} }
    const text = lMatch[2].replace(/<[^>]+>/g, '').trim();
    if (!seenLinks.has(href) && text) { seenLinks.add(href); result.links.push({ href, text: text.substring(0, 100) }); }
  }
  if (result.links.length > 50) result.links = result.links.slice(0, 50);

  const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const seenImgs = new Set();
  let iMatch;
  while ((iMatch = imgRegex.exec(html)) !== null) {
    let src = iMatch[1].trim();
    if (src.startsWith('/')) { try { src = new URL(src, url).href; } catch {} }
    if (!seenImgs.has(src) && !src.startsWith('data:')) {
      seenImgs.add(src);
      const altMatch = iMatch[0].match(/alt=["']([^"']*?)["']/i);
      result.images.push({ src, alt: altMatch ? altMatch[1] : null });
    }
  }
  if (result.images.length > 30) result.images = result.images.slice(0, 30);

  const visibleText = stripNonContent(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  result.word_count = visibleText.split(/\s+/).filter(w => w.length > 0).length;

  return result;
}

// IR-H-002 / S-1 / S-2 FIX: SSRF protection.
//
// validateUrl() is a CHEAP synchronous PRE-check only — it rejects obvious
// blocked hostnames and any IP-literal host that falls in a private range
// (using the same robust isBlockedIp() that normalizes IPv4-mapped IPv6). It is
// NOT the authoritative control: a hostname's DNS record is not resolved here,
// so an attacker-registered domain pointing at an internal IP passes this gate.
// The LOAD-BEARING protection is fetchPage()'s resolve-and-pin, which resolves
// every hostname, rejects any private resolved IP, pins the socket to a
// validated IP, and re-validates on every redirect hop.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',         // GCP metadata
  'metadata.google.internal.',
]);

function isPrivateHost(hostname) {
  if (typeof hostname !== 'string' || hostname.length === 0) return true;
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return true;
  const bare = hostname.replace(/^\[|\]$/g, '');
  // If the host is an IP literal (incl. IPv4-mapped IPv6), apply the full
  // private-range check. Non-IP hostnames cannot be judged here without DNS —
  // fetchPage()'s resolve-and-pin is the authoritative gate for those.
  if (net.isIP(bare)) return isBlockedIp(bare);
  return false;
}

function validateUrl(url) {
  if (!url || typeof url !== 'string') return { valid: false, error: 'Missing url field' };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { valid: false, error: 'Only http/https URLs supported' };
    if (isPrivateHost(parsed.hostname)) {
      return { valid: false, error: 'Private/local URLs not allowed' };
    }
    return { valid: true, url: parsed.href };
  } catch { return { valid: false, error: 'Invalid URL format' }; }
}

// ─── Agent Discovery ──────────────────────────────────────────────────

const LLMS_TXT = `# Renderly

> Web Content Extraction API for AI agents. Convert any URL to clean markdown, structured data, or readable text. Payments via x402 protocol (USDC on Base).

Renderly is a stateless web content extraction service designed for autonomous agents. It accepts any public URL and returns clean, structured content ready for LLM consumption. No API keys required — pay per request via the x402 micropayment protocol.

## Endpoints

- [Service Info](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/renderly): Free. Returns service metadata, version, and endpoint catalog.
- [Health Check](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/renderly/health): Free. Server status and uptime.
- [Pricing](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/renderly/pricing): Free. Detailed pricing for all services.

## Paid Services

- POST /renderly/markdown: $0.001 USDC — Convert any URL to clean markdown. Preserves headings, links, lists, formatting. Body: { "url": "https://..." }
- POST /renderly/extract: $0.001 USDC — Structured extraction: title, meta description, Open Graph tags, headings, links (max 50), images (max 30), word count. Body: { "url": "https://..." }
- POST /renderly/readable: $0.0005 USDC — Clean readable text with nav, ads, and scripts stripped. Body: { "url": "https://..." }

## Payment

Protocol: x402 v2
Network: Base (eip155:8453)
Asset: USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
Wallet: 0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4
Facilitator: https://facilitator.openx402.ai
Method: Include X-Payment header with x402 payment proof. Without it, endpoints return HTTP 402 with payment requirements.
`;

// ─── Exports ──────────────────────────────────────────────────────────

module.exports = {
  fetchPage,
  stripNonContent,
  htmlToMarkdown,
  extractStructured,
  validateUrl,
  LLMS_TXT,
  // Exported for the SSRF regression tests (S-1/S-2/D-4/D-8).
  isPrivateHost,
  isBlockedIp,
  normalizeIp,
  resolvePublicIps,
  MAX_RESPONSE_SIZE,
  MAX_HTML_PROCESS_SIZE,
};
