#!/usr/bin/env node
/**
 * Fall back to the company's own site icon when no logo element could be found.
 *
 *   node scripts/logo-review/icon-scrape.js [in.json] [out.csv] [concurrency]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged.
 *
 * Why this exists: the DOM scraper looks for a logo element, and plenty of sites simply
 * don't publish one — those companies were reviewed, found nothing, and retired. But
 * nearly every site ships an apple-touch-icon, which is a high-resolution version of the
 * brand mark (sites publish it for home-screen bookmarks). At 180-512px it is usually the
 * cleanest square rendition of the logo available.
 *
 * This is NOT the same thing as the Google favicon-proxy URLs the REDO pass exists to
 * remove. Those are a third party's render of a site; this is the icon the company itself
 * publishes on its own domain.
 *
 * Preference order: apple-touch-icon, then the largest declared <link rel=icon> size, then
 * /apple-touch-icon.png, then /favicon.ico. A .ico is the last resort — they are often
 * 16-32px and look soft on a review card next to a 180px PNG.
 */
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[3] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[4] || '6', 10));

// Sites routinely 403 a bare fetch; they serve the same HTML to a browser UA.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const NAV_TIMEOUT = 15000;

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), NAV_TIMEOUT);
  try {
    return await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal, ...opts });
  } finally {
    clearTimeout(timer);
  }
}

const abs = (href, base) => { try { return new URL(href, base).href; } catch { return null; } };

// Parse declared icons out of the page head, best first.
function declaredIcons(html, base) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1] || '';
    if (!/\b(apple-touch-icon(-precomposed)?|icon|shortcut icon)\b/i.test(rel)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    const url = href && abs(href, base);
    if (!url) continue;
    const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
    const px = parseInt((sizes.match(/(\d+)/) || [])[1] || '0', 10);
    const apple = /apple-touch-icon/i.test(rel);
    // An .ico is a fallback, never a preference — they are usually 16-32px.
    const ico = /\.ico(\?|$)/i.test(url);
    out.push({ url, apple, px, ico, type: apple ? 'apple-touch-icon' : 'site-favicon' });
  }
  out.sort((a, b) => (a.ico - b.ico) || (b.apple - a.apple) || (b.px - a.px));
  return out;
}

// Confirm the URL actually serves an image — a site that 404s to an HTML error page would
// otherwise put a broken card in front of the reviewer.
async function servesImage(url) {
  try {
    const res = await get(url);
    const ct = res.headers.get('content-type') || '';
    return res.ok && /image|svg/i.test(ct);
  } catch {
    return false;
  }
}

async function iconFor(target) {
  // own-domain batches carry a bare hostname; SHARED/derived ones carry a full URL.
  const site = /^https?:\/\//i.test(target) ? target : 'https://' + String(target || '').replace(/^\/+/, '');
  let base = site, html = '';
  try {
    const res = await get(site);
    base = res.url || site;
    html = await res.text();
  } catch (err) {
    return { status: 'error: ' + err.message };
  }
  const candidates = declaredIcons(html, base);
  candidates.push({ url: abs('/apple-touch-icon.png', base), apple: true, px: 0, ico: false, type: 'apple-touch-icon' });
  candidates.push({ url: abs('/favicon.ico', base), apple: false, px: 0, ico: true, type: 'site-favicon' });

  const seen = new Set();
  for (const c of candidates) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    if (await servesImage(c.url)) return { logo_url: c.url, logo_type: c.type, status: 'ok' };
  }
  return { status: 'no icon' };
}

async function main() {
  const items = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const rows = new Array(items.length).fill(null);
  let next = 0, done = 0, found = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const res = await iconFor(it.scrape_target || it.career_url);
      if (res.logo_url) found++;
      rows[i] = [it.scrape_target || it.career_url, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 25 === 0) console.log(`  ${done}/${items.length} checked, ${found} icons`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const csv = [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n';
  fs.writeFileSync(OUT, csv);
  console.log(`ICONS ${items.length} | found: ${found} (${(found / items.length * 100).toFixed(1)}%) -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
