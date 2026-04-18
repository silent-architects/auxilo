'use strict';

// ─── Core Engine Functions ────────────────────────────────────────────

// IR-H-002 FIX: Post-redirect host validation + response size limit
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5MB — generous for HTML content

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Renderly/0.3.0 (Web Content API)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow'
  });

  // Post-redirect SSRF check: verify the final URL host isn't private
  const finalUrl = resp.url;
  try {
    const finalParsed = new URL(finalUrl);
    if (isPrivateHost(finalParsed.hostname)) {
      throw new Error('Redirect to private/local address blocked');
    }
  } catch (e) {
    if (e.message.includes('blocked')) throw e;
    throw new Error('Invalid redirect URL');
  }

  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);

  // Response size limit to prevent memory exhaustion
  const contentLength = resp.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error('Response too large (>' + (MAX_RESPONSE_SIZE / 1024 / 1024) + 'MB)');
  }

  const html = await resp.text();
  if (html.length > MAX_RESPONSE_SIZE) {
    throw new Error('Response body too large (>' + (MAX_RESPONSE_SIZE / 1024 / 1024) + 'MB)');
  }
  return { html, finalUrl, status: resp.status };
}

function stripNonContent(html) {
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

// IR-H-002 FIX: Comprehensive SSRF protection — private range blocklist + IPv6 + cloud metadata
const PRIVATE_RANGES = [
  /^127\./,                           // Loopback
  /^10\./,                            // RFC 1918 Class A
  /^192\.168\./,                      // RFC 1918 Class C
  /^172\.(1[6-9]|2\d|3[01])\./,      // RFC 1918 Class B (172.16-31 only, not all 172.x)
  /^169\.254\./,                      // Link-local / cloud metadata (AWS, GCP, Azure)
  /^0\./,                             // Current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT (100.64-127.x)
];
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]',
  'metadata.google.internal',         // GCP metadata
  'metadata.google.internal.',
]);

function isPrivateHost(hostname) {
  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) return true;
  // Strip IPv6 brackets for range check
  const bare = hostname.replace(/^\[|\]$/g, '');
  // IPv6 ULA (fc00::/7) and link-local (fe80::/10)
  if (/^f[cd]/i.test(bare) || /^fe[89ab]/i.test(bare)) return true;
  // IPv4 private ranges
  return PRIVATE_RANGES.some(re => re.test(bare));
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
Wallet: 0x1BE960313c93b3aA0AA62BF33B300CAB48c36Ca6
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
  LLMS_TXT
};
