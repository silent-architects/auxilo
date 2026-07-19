const { Hono } = require('hono');
const { serve } = require('@hono/node-server');

const app = new Hono();

const WALLET = '0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const FACILITATOR = 'https://facilitator.openx402.ai';
const VERSION = '0.3.1';

const stats = {
  started: new Date().toISOString(),
  requests: { total: 0, markdown: 0, extract: 0, readable: 0 },
  revenue_usdc: 0,
  errors: 0
};

// ─── x402 Payment Gate ───────────────────────────────────────────────
function x402Gate(price_usd, description) {
  const amount = String(Math.round(price_usd * 1_000_000));
  return async (c, next) => {
    const paymentHeader = c.req.header('X-Payment');
    if (!paymentHeader) {
      c.status(402);
      c.header('X-Payment-Required', 'true');
      return c.json({
        x402Version: 2,
        accepts: [{
          scheme: 'exact',
          network: 'eip155:8453',
          maxAmountRequired: amount,
          resource: new URL(c.req.url).pathname,
          description,
          mimeType: 'application/json',
          payTo: WALLET,
          maxTimeoutSeconds: 30,
          asset: USDC_BASE,
          extra: { assetTransferMethod: 'eip3009', name: 'USD Coin', version: '2' }
        }]
      });
    }
    try {
      const verifyResp = await fetch(FACILITATOR + '/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment: paymentHeader, payTo: WALLET,
          maxAmountRequired: amount, network: 'eip155:8453',
          resource: new URL(c.req.url).pathname,
        })
      });
      if (!verifyResp.ok) { c.status(402); return c.json({ error: 'Payment verification failed', details: await verifyResp.text() }); }
      const result = await verifyResp.json();
      if (!result.valid && !result.isValid) { c.status(402); return c.json({ error: 'Invalid payment', details: result }); }
      stats.revenue_usdc += price_usd;
    } catch (err) { console.log('Facilitator check failed, accepting optimistically:', err.message); }
    await next();
  };
}

// ─── Core Engines (pure JS — no display server needed) ───────────────

async function fetchPage(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Renderly/0.3.0 (Web Content API)' },
    signal: AbortSignal.timeout(15000),
    redirect: 'follow'
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + resp.statusText);
  const html = await resp.text();
  return { html, finalUrl: resp.url, status: resp.status };
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

function validateUrl(url) {
  if (!url || typeof url !== 'string') return { valid: false, error: 'Missing url field' };
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return { valid: false, error: 'Only http/https URLs supported' };
    const h = parsed.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]' || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('172.')) {
      return { valid: false, error: 'Private/local URLs not allowed' };
    }
    return { valid: true, url: parsed.href };
  } catch { return { valid: false, error: 'Invalid URL format' }; }
}

// ─── llms.txt — Agent Discovery ─────────────────────────────────────

const LLMS_TXT = `# Renderly

> Web Content Extraction API for AI agents. Convert any URL to clean markdown, structured data, or readable text. Payments via x402 protocol (USDC on Base).

Renderly is a stateless web content extraction service designed for autonomous agents. It accepts any public URL and returns clean, structured content ready for LLM consumption. No API keys required — pay per request via the x402 micropayment protocol.

## Endpoints

- [Service Info](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/): Free. Returns service metadata, version, and endpoint catalog.
- [Health Check](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/health): Free. Server status and uptime.
- [Pricing](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/pricing): Free. Detailed pricing for all services.
- [Test](https://3000-725fa3fea775ba39db5a2e3703fa4557.life.conway.tech/test): Free. Verify all extraction engines are operational.

## Paid Services

- POST /markdown: $0.001 USDC — Convert any URL to clean markdown. Preserves headings, links, lists, formatting. Body: { "url": "https://..." }
- POST /extract: $0.001 USDC — Structured extraction: title, meta description, Open Graph tags, headings, links (max 50), images (max 30), word count. Body: { "url": "https://..." }
- POST /readable: $0.0005 USDC — Clean readable text with nav, ads, and scripts stripped. Body: { "url": "https://..." }

## Payment

Protocol: x402 v2
Network: Base (eip155:8453)
Asset: USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
Wallet: 0xA19Cf92cc1daCf742f0E50b4128cAD3A86A81EC4
Facilitator: https://facilitator.openx402.ai
Method: Include X-Payment header with x402 payment proof. Without it, endpoints return HTTP 402 with payment requirements.
`;

app.get('/llms.txt', (c) => {
  return c.text(LLMS_TXT, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
});

// ─── Free Endpoints ──────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    name: 'Renderly',
    tagline: 'Web Content Extraction API for Agents',
    version: VERSION,
    protocol: 'x402',
    network: 'eip155:8453',
    wallet: WALLET,
    endpoints: {
      '/': { method: 'GET', price: 'free', description: 'Service info' },
      '/health': { method: 'GET', price: 'free', description: 'Health check' },
      '/pricing': { method: 'GET', price: 'free', description: 'Pricing details' },
      '/llms.txt': { method: 'GET', price: 'free', description: 'Agent discovery (llms.txt standard)' },
      '/test': { method: 'GET', price: 'free', description: 'Test all engines (example.com only)' },
      '/markdown': { method: 'POST', price: '$0.001 USDC', description: 'Extract clean markdown from any URL. Body: { "url": "https://..." }' },
      '/extract': { method: 'POST', price: '$0.001 USDC', description: 'Structured data: title, meta, OG tags, headings, links, images. Body: { "url": "https://..." }' },
      '/readable': { method: 'POST', price: '$0.0005 USDC', description: 'Clean readable text, nav/ads/scripts stripped. Body: { "url": "https://..." }' }
    },
    stats: { total_requests: stats.requests.total },
    built: new Date().toISOString()
  });
});

app.get('/health', (c) => {
  return c.json({ status: 'ok', uptime: process.uptime(), version: VERSION, engines: { markdown: true, extract: true, readable: true }, timestamp: new Date().toISOString() });
});

app.get('/pricing', (c) => {
  return c.json({
    currency: 'USDC', network: 'Base (eip155:8453)', protocol: 'x402',
    services: {
      markdown: { price: 0.001, unit: 'per extraction', description: 'Clean markdown from any URL — headings, links, lists, formatting preserved' },
      extract: { price: 0.001, unit: 'per extraction', description: 'Structured data: title, description, OG tags, headings, links, images, word count' },
      readable: { price: 0.0005, unit: 'per extraction', description: 'Clean readable text — nav, ads, scripts stripped' }
    },
    payment: { method: 'X-Payment header with x402 protocol', facilitator: FACILITATOR, wallet: WALLET, asset: USDC_BASE }
  });
});

// ─── Paid Endpoints ──────────────────────────────────────────────────

app.post('/markdown', x402Gate(0.001, 'Extract clean markdown from webpage'), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON. Expected: { "url": "https://..." }' }, 400); }
  const check = validateUrl(body.url);
  if (!check.valid) return c.json({ error: check.error }, 400);
  stats.requests.total++; stats.requests.markdown++;
  try {
    const page = await fetchPage(check.url);
    const markdown = htmlToMarkdown(page.html);
    return c.json({ success: true, url: check.url, final_url: page.finalUrl, format: 'markdown', chars: markdown.length, markdown, timestamp: new Date().toISOString() });
  } catch (err) { stats.errors++; return c.json({ error: 'Extraction failed', details: err.message }, 500); }
});

app.post('/extract', x402Gate(0.001, 'Extract structured data from webpage'), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON. Expected: { "url": "https://..." }' }, 400); }
  const check = validateUrl(body.url);
  if (!check.valid) return c.json({ error: check.error }, 400);
  stats.requests.total++; stats.requests.extract++;
  try {
    const page = await fetchPage(check.url);
    const data = extractStructured(page.html, check.url);
    return c.json({ success: true, url: check.url, final_url: page.finalUrl, ...data, timestamp: new Date().toISOString() });
  } catch (err) { stats.errors++; return c.json({ error: 'Extraction failed', details: err.message }, 500); }
});

app.post('/readable', x402Gate(0.0005, 'Get clean readable text from webpage'), async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: 'Invalid JSON. Expected: { "url": "https://..." }' }, 400); }
  const check = validateUrl(body.url);
  if (!check.valid) return c.json({ error: check.error }, 400);
  stats.requests.total++; stats.requests.readable++;
  try {
    const page = await fetchPage(check.url);
    let text = stripNonContent(page.html);
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
    text = text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
    const words = text.split(/\s+/).filter(w => w.length > 0).length;
    return c.json({ success: true, url: check.url, final_url: page.finalUrl, format: 'text', word_count: words, chars: text.length, text, timestamp: new Date().toISOString() });
  } catch (err) { stats.errors++; return c.json({ error: 'Extraction failed', details: err.message }, 500); }
});

// ─── Test Endpoint (free, limited to example.com) ────────────────────

app.get('/test', async (c) => {
  try {
    const page = await fetchPage('https://example.com');
    const markdown = htmlToMarkdown(page.html);
    const data = extractStructured(page.html, 'https://example.com');
    return c.json({
      status: 'all_engines_operational',
      test_url: 'https://example.com',
      markdown_sample: markdown.substring(0, 200),
      extract_sample: { title: data.title, headings: data.headings.length, links: data.links.length, word_count: data.word_count },
      timestamp: new Date().toISOString()
    });
  } catch (err) { return c.json({ status: 'error', details: err.message }, 500); }
});

// ─── Start ───────────────────────────────────────────────────────────
const PORT = 3000;
console.log('Renderly v' + VERSION + ' starting on port ' + PORT + '...');
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log('Renderly v' + VERSION + ' running at http://0.0.0.0:' + PORT);
  console.log('Wallet: ' + WALLET);
  console.log('x402 payments on Base mainnet');
  console.log('Engines: markdown, extract, readable');
});
