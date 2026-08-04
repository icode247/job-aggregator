#!/usr/bin/env node
/**
 * Join the scraper output back to the batch and build the clickable review page.
 *
 *   node scripts/logo-review/build-preview.js
 *
 * Reads data/logo/{batch-companies.json,batch-logos.csv}; writes batch-review.json
 * (id -> logo_url, the map save-logos.js needs) and logo-preview.html.
 *
 * Images are inlined as data URIs: the published artifact runs under a CSP that
 * blocks every external host, so a remote <img src> would render as a blank card
 * and get rejected for the wrong reason.
 */
const fs = require('fs');
const { BATCH_JSON, SCRAPED_CSV, REVIEW_JSON, PREVIEW_HTML, isVendor, HIGH_CONFIDENCE } = require('./lib');

const CONC = 24;
const MAX_BYTES = 420 * 1024; // skip anything too heavy to inline

// Plenty of hosts serve a perfectly good logo as application/octet-stream (Paylocity's
// GetLogoFileById does it for ~half its images), so trusting Content-Type alone silently
// dropped them from review. Sniff the magic bytes and believe those instead.
function sniffImageType(buf) {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
  const head = buf.slice(0, 300).toString('utf8').trimStart();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return null;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length >= header.length).map(r =>
    Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

async function toDataUri(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    // Plenty of CDNs 403 a bare fetch; send a browser UA + same-origin referer so the
    // preview shows the logo instead of dropping the card for the wrong reason.
    let referer;
    try { referer = new URL(url).origin + '/'; } catch { referer = undefined; }
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(referer ? { referer } : {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    // Header first, then fall back to sniffing — an HTML error page must still be
    // rejected, so a non-image header only gets a second chance if the bytes agree.
    const header = (res.headers.get('content-type') || '').split(';')[0];
    const type = /^image\//.test(header) ? header : sniffImageType(buf);
    if (!type) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderHtml(items) {
  const cards = items.map(it => `
    <label class="card${it.suggest ? ' on' : ''}" data-id="${it.id}">
      <input type="checkbox" ${it.suggest ? 'checked' : ''}>
      <div class="thumb"><img src="${it.data_uri}" alt=""></div>
      <div class="meta">
        <div class="name">${esc(it.company_name || it.domain)}</div>
        <div class="sub">#${it.id} &middot; ${esc(it.domain)} &middot; ${it.jobs} jobs</div>
        <div class="tags">${it.vendor ? '<span class="tag bad">vendor</span>' : ''}${!HIGH_CONFIDENCE.has(it.logo_type) ? `<span class="tag warn">${esc(it.logo_type)}</span>` : ''}</div>
      </div>
    </label>`).join('');

  return `<title>Company logo review</title>
<style>
  :root { --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --on:#0a7; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#999; --line:#333; --card:#1a1a1a; } }
  :root[data-theme="dark"] { --bg:#111; --fg:#eee; --muted:#999; --line:#333; --card:#1a1a1a; }
  :root[data-theme="light"] { --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --card:#fafafa; }
  body { background:var(--bg); color:var(--fg); font:14px/1.4 -apple-system,system-ui,sans-serif; margin:0; padding:16px; }
  header { position:sticky; top:0; background:var(--bg); border-bottom:1px solid var(--line); padding:12px 0; z-index:5; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  button { font:inherit; padding:8px 14px; border:1px solid var(--line); border-radius:8px; background:var(--card); color:var(--fg); cursor:pointer; }
  #count { color:var(--muted); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; margin-top:16px; }
  .card { border:2px solid var(--line); border-radius:10px; padding:10px; background:var(--card); cursor:pointer; display:block; opacity:.45; }
  .card.on { border-color:var(--on); opacity:1; }
  .card input { display:none; }
  .thumb { height:88px; display:flex; align-items:center; justify-content:center; background:#fff; border-radius:6px; overflow:hidden; }
  .thumb img { max-width:100%; max-height:80px; object-fit:contain; }
  .name { font-weight:600; margin-top:8px; word-break:break-word; }
  .sub { color:var(--muted); font-size:12px; word-break:break-all; }
  .tag { display:inline-block; font-size:11px; padding:1px 6px; border-radius:99px; margin-top:4px; margin-right:4px; }
  .tag.bad { background:#c33; color:#fff; }
  .tag.warn { background:#e90; color:#000; }
  #out { width:100%; margin-top:12px; font:12px/1.4 ui-monospace,monospace; }
</style>
<header>
  <button id="copy">Copy save-list</button>
  <button id="none">Deselect all</button>
  <button id="all">Select all</button>
  <span id="count"></span>
</header>
<div class="grid">${cards}</div>
<textarea id="out" rows="4" readonly></textarea>
<script>
  const cards = [...document.querySelectorAll('.card')];
  const count = document.getElementById('count');
  const out = document.getElementById('out');
  function selected() { return cards.filter(c => c.classList.contains('on')).map(c => '#' + c.dataset.id); }
  function refresh() {
    const s = selected();
    count.textContent = s.length + ' of ' + cards.length + ' selected';
    out.value = 'save these logos: ' + s.join(', ');
  }
  cards.forEach(c => c.addEventListener('click', e => {
    e.preventDefault();
    c.classList.toggle('on');
    refresh();
  }));
  document.getElementById('none').onclick = () => { cards.forEach(c => c.classList.remove('on')); refresh(); };
  document.getElementById('all').onclick = () => { cards.forEach(c => c.classList.add('on')); refresh(); };
  document.getElementById('copy').onclick = () => {
    out.select();
    navigator.clipboard && navigator.clipboard.writeText(out.value);
  };
  refresh();
</script>`;
}

async function main() {
  const companies = JSON.parse(fs.readFileSync(BATCH_JSON, 'utf8'));
  // The scraper echoes back the URL it actually fetched (scheme added, trailing slash),
  // so match on a normalized host rather than the raw string.
  const norm = s => String(s || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  // Keyed on scrape_target: the own domain in normal mode, the ATS careers URL
  // in SHARED mode. Older batch files only carry `domain`.
  const byDomain = new Map(companies.map(c => [norm(c.scrape_target || c.domain), c]));
  const scraped = parseCsv(fs.readFileSync(SCRAPED_CSV, 'utf8'));

  const candidates = [];
  for (const row of scraped) {
    const c = byDomain.get(norm(row.website));
    if (!c || !row.logo_url || !/^https?:\/\//i.test(row.logo_url)) continue;
    candidates.push({
      id: c.id, company_name: c.company_name, domain: c.domain, jobs: c.jobs,
      logo_url: row.logo_url, logo_type: row.logo_type || 'unknown',
      vendor: isVendor(row.logo_url),
    });
  }

  const withImages = (await mapLimit(candidates, CONC, async it => {
    const data_uri = await toDataUri(it.logo_url);
    return data_uri ? { ...it, data_uri } : null;
  })).filter(Boolean);

  // Pre-select the ones the scraper is confident about and that aren't ATS boilerplate;
  // the human pass is about unchecking the misses, not hunting for the hits.
  for (const it of withImages) it.suggest = !it.vendor && HIGH_CONFIDENCE.has(it.logo_type);

  fs.writeFileSync(REVIEW_JSON, JSON.stringify(withImages.map(({ data_uri, ...rest }) => rest), null, 2));
  fs.writeFileSync(PREVIEW_HTML, renderHtml(withImages));

  const suggested = withImages.filter(i => i.suggest).length;
  const vendor = withImages.filter(i => i.vendor).length;
  const lowConf = withImages.filter(i => !HIGH_CONFIDENCE.has(i.logo_type)).length;
  console.log(`items: ${withImages.length} | suggested save: ${suggested} | vendor-flagged: ${vendor} | low-conf: ${lowConf}`);
  console.log(`html: ${Math.round(fs.statSync(PREVIEW_HTML).size / 1024)} KB`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
