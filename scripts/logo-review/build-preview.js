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
const path = require('path');
const { BATCH_JSON, SCRAPED_CSV, REVIEW_JSON, PREVIEW_HTML, isVendor, HIGH_CONFIDENCE } = require('./lib');

const CONC = 24;
// Generous, because the downscale pass below is what actually controls page weight.
// At 420KB this silently dropped company-uploaded originals — a Greenhouse batch found 9
// logos and produced 1 card, with the other 8 fetching fine at 200/image.
const MAX_BYTES = 4 * 1024 * 1024;

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

function renderHtml(items, tag) {
  const cards = items.map(it => `
    <label class="card${it.suggest ? ' on' : ''}" data-id="${it.id}">
      <input type="checkbox" ${it.suggest ? 'checked' : ''}>
      <div class="thumb"><img src="${it.data_uri}" alt=""></div>
      <div class="meta">
        <div class="name">${esc(it.company_name || it.domain)}</div>
        <div class="sub">#${it.id} &middot; ${esc(it.domain)} &middot; ${it.jobs} jobs</div>
        ${it.scraped_from && norm(it.scraped_from) !== norm(it.domain) ? `<div class="sub">from ${esc(it.scraped_from)}${it.slug_match === false ? ' <span class="tag warn">name unverified</span>' : ''}</div>` : ''}
        <div class="tags">${it.vendor ? '<span class="tag bad">vendor</span>' : ''}${!HIGH_CONFIDENCE.has(it.logo_type) ? `<span class="tag warn">${esc(it.logo_type)}</span>` : ''}</div>
      </div>
    </label>`).join('');

  // The batch identity goes in the title, the sticky header and the save-list itself.
  // Numbered filenames stopped the file being overwritten but not a tab staying open, and
  // three save-lists were pasted back from a previous batch's tab, which look identical.
  return `<title>Logo review ${esc(tag.label)} — ${items.length} cards</title>
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
  <strong style="font-size:15px">${esc(tag.label)}</strong>
  <span style="color:var(--muted)">ids ${tag.minId}–${tag.maxId} &middot; first #${tag.firstId}</span>
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

/**
 * Shrink inlined thumbnails through a headless canvas.
 *
 * Company-uploaded logos are often 300KB+ each, which made a 45-card page weigh 15MB
 * and would have stretched the recovery set across ~24 review rounds. The cards render
 * at 80px tall anyway, so the full-resolution bytes buy nothing. Uses puppeteer (already
 * a dependency) instead of pulling in an image library.
 */
async function downscale(items) {
  const puppeteer = require('puppeteer');
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  try {
    const page = await browser.newPage();
    const CHUNK = 40;
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK);
      const shrunk = await page.evaluate(async (uris) => Promise.all(uris.map(uri => new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(1, 180 / Math.max(img.width, img.height));
            if (scale === 1 && uri.length < 60000) return resolve(uri); // already small
            const c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.width * scale));
            c.height = Math.max(1, Math.round(img.height * scale));
            const ctx = c.getContext('2d');
            // Logos are frequently transparent PNGs and the cards sit on white, so
            // flatten onto white before encoding as JPEG — otherwise alpha goes black.
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.82));
          } catch { resolve(uri); }
        };
        img.onerror = () => resolve(uri); // SVGs without intrinsic size, etc.
        img.src = uri;
      }))), slice.map(it => it.data_uri));
      slice.forEach((it, n) => { if (shrunk[n]) it.data_uri = shrunk[n]; });
    }
  } finally {
    await browser.close();
  }
}

// The scraper echoes back the URL it actually fetched (scheme added, trailing slash),
// so match on a normalized host rather than the raw string.
const norm = s => String(s || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

async function main() {
  const companies = JSON.parse(fs.readFileSync(BATCH_JSON, 'utf8'));
  // Index every identifier a scraped row might echo back: the scraper navigates to
  // career_url and writes that into the CSV, but scrape_target is the bare domain in
  // own-domain mode, and keying on scrape_target alone dropped ~80% of those batches.
  //
  // A key is only usable if exactly one company claims it. Under SHARED=1 `domain` is the
  // ATS host (jobs.ashbyhq.com, shared by hundreds), so picking a winner for it silently
  // attributes one company's scrape to another. Ambiguous keys are dropped, not resolved.
  const claims = new Map();
  for (const c of companies) {
    for (const key of [c.scrape_target, c.domain, c.career_url]) {
      const k = norm(key);
      if (!k) continue;
      if (!claims.has(k)) claims.set(k, new Set());
      claims.get(k).add(c);
    }
  }
  const byDomain = new Map();
  for (const [k, owners] of claims) if (owners.size === 1) byDomain.set(k, [...owners][0]);
  const scraped = parseCsv(fs.readFileSync(SCRAPED_CSV, 'utf8'));

  const candidates = [];
  for (const row of scraped) {
    const c = byDomain.get(norm(row.website));
    if (!c || !row.logo_url || !/^https?:\/\//i.test(row.logo_url)) continue;
    candidates.push({
      id: c.id, company_name: c.company_name, domain: c.domain, jobs: c.jobs,
      // In WORKDAY mode the scraped site is a guess derived from the tenant slug, so the
      // reviewer needs to see WHICH site the logo came from to judge whether it belongs to
      // this company. `domain` alone is the shared ATS host and says nothing.
      scraped_from: c.scrape_target,
      // false only in SLUG mode, where the slug didn't resemble the company name.
      slug_match: c.slug_match,
      logo_url: row.logo_url, logo_type: row.logo_type || 'unknown',
      vendor: isVendor(row.logo_url),
    });
  }

  // The scraper only writes its CSV when it finishes, so a killed run leaves the PREVIOUS
  // batch's file in place. Joining against it yields no cards, but save-logos.js would
  // still mark all 500 companies of the new batch processed — burning them without a
  // single one having been looked at. A batch that matched nothing is a stale file, not
  // an unlucky scrape.
  const matched = new Set(candidates.map(c => c.id)).size;
  if (!matched) {
    console.error(`FATAL: none of the ${companies.length} batch companies appear in ${SCRAPED_CSV}.`);
    console.error('That file is almost certainly left over from a previous batch — re-run render-scrape.js.');
    process.exit(1);
  }

  // A logo that several companies share can't be any one company's own mark — it's the
  // ATS's. VENDOR_PATTERNS only catches hosts someone thought to add (Zoho Recruit handed
  // the same lockup to 213 of 445 cards in one batch before this existed), so key off the
  // structure instead: drop URL groups outright rather than making the reviewer scroll
  // past hundreds of identical thumbnails. Done before download, so the bytes are saved too.
  //
  // Groups of 2 and 3 sit under that limit deliberately, because they are ambiguous: the
  // same company is often duplicated in `companies` (Impruvon, Aligned, sewts all appeared
  // twice in one night) and there both rows legitimately share the real logo. What settles
  // it is the name — same company duplicated, or unrelated companies handed platform art.
  // That judgement was being made by hand on every batch, so make it here.
  const DUP_LIMIT = 4;
  const normName = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const sameCompany = group => {
    const names = group.map(c => normName(c.company_name)).filter(Boolean);
    if (names.length < group.length) return false; // a missing name proves nothing
    return names.every(n => n.startsWith(names[0]) || names[0].startsWith(n));
  };

  const byUrl = new Map();
  for (const c of candidates) {
    if (!byUrl.has(c.logo_url)) byUrl.set(c.logo_url, []);
    byUrl.get(c.logo_url).push(c);
  }
  const repeated = [...byUrl.entries()]
    .filter(([, g]) => g.length >= DUP_LIMIT || (g.length > 1 && !sameCompany(g)));
  const repeatedUrls = new Set(repeated.map(([u]) => u));
  const unique = candidates.filter(c => !repeatedUrls.has(c.logo_url));
  if (repeated.length) {
    const dropped = candidates.length - unique.length;
    console.log(`shared-art: dropped ${dropped} cards across ${repeated.length} repeated URL(s)`);
    for (const [u, g] of repeated.sort((a, b) => b[1].length - a[1].length).slice(0, 6)) {
      const who = g.length <= 3 ? ` (${g.map(c => c.company_name).join(' / ')})` : '';
      console.log(`  ${g.length}x ${u.slice(0, 80)}${who}`);
    }
  }

  const withImages = (await mapLimit(unique, CONC, async it => {
    const data_uri = await toDataUri(it.logo_url);
    return data_uri ? { ...it, data_uri } : null;
  })).filter(Boolean);

  if (process.env.THUMB !== '0') await downscale(withImages);

  // Pre-select the ones the scraper is confident about and that aren't ATS boilerplate;
  // the human pass is about unchecking the misses, not hunting for the hits.
  // A name-unverified slug is a guess about WHICH company the site belongs to, which is
  // the one error the eyeball step is worst at catching — so never pre-check those.
  for (const it of withImages) it.suggest = !it.vendor && HIGH_CONFIDENCE.has(it.logo_type) && it.slug_match !== false;

  fs.writeFileSync(REVIEW_JSON, JSON.stringify(withImages.map(({ data_uri, ...rest }) => rest), null, 2));

  // Write a numbered copy. The fixed filename means a browser tab left open from the
  // previous batch looks identical to the current one — a reviewer copied a stale
  // save-list three times from tabs they had no reason to distrust. A fresh path per batch
  // makes the old tab a different URL, and the label below makes it visibly different too.
  const dir = path.dirname(PREVIEW_HTML);
  const stem = path.basename(PREVIEW_HTML, '.html');
  const seen = fs.readdirSync(dir)
    .map(f => new RegExp(`^${stem}-(\\d+)\\.html$`).exec(f))
    .filter(Boolean)
    .map(m => parseInt(m[1], 10));
  const n = (seen.length ? Math.max(...seen) : 0) + 1;
  const numbered = path.join(dir, `${stem}-${String(n).padStart(3, '0')}.html`);

  const ids = withImages.map(i => i.id).sort((a, b) => a - b);
  const html = renderHtml(withImages, {
    label: `preview-${String(n).padStart(3, '0')}`,
    minId: ids[0], maxId: ids[ids.length - 1], firstId: withImages[0].id,
  });
  fs.writeFileSync(PREVIEW_HTML, html);
  fs.writeFileSync(numbered, html);

  const suggested = withImages.filter(i => i.suggest).length;
  const vendor = withImages.filter(i => i.vendor).length;
  const lowConf = withImages.filter(i => !HIGH_CONFIDENCE.has(i.logo_type)).length;
  console.log(`items: ${withImages.length} | suggested save: ${suggested} | vendor-flagged: ${vendor} | low-conf: ${lowConf}`);
  console.log(`html: ${Math.round(fs.statSync(PREVIEW_HTML).size / 1024)} KB`);
  console.log(`open this one (fresh path, no stale tab): ${numbered}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
