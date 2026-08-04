#!/usr/bin/env node
/**
 * Recover logos that were silently dropped before the Content-Type fix.
 *
 *   node scripts/logo-review/recover-dropped.js
 *
 * The preview builder used to require an `image/*` Content-Type and a 220KB cap.
 * Paylocity's GetLogoFileById serves valid PNGs as application/octet-stream, so
 * roughly half of every Paylocity batch never became a card — those companies got
 * marked reviewed without ever being seen.
 *
 * This walks the cached renders in data/logo/shared*-full-logos.csv, keeps only
 * companies that are STILL logo-less, and includes a company only when its logo
 * would have FAILED under the old rules but SUCCEEDS under the new ones. That
 * distinction matters: anything that would have downloaded fine before was shown
 * and deliberately rejected, and must not be put back in front of the reviewer.
 *
 * Writes the usual batch-companies.json / batch-logos.csv pair, so build-preview.js
 * consumes the result unchanged.
 */
const fs = require('fs');
const path = require('path');
const { makePool, q, STATE_DIR, BATCH_JSON, SCRAPED_CSV } = require('./lib');

const OLD_MAX = 220 * 1024;
const NEW_MAX = 420 * 1024;
const CONC = 16;

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

async function classify(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let referer; try { referer = new URL(url).origin + '/'; } catch { /* ignore */ }
    const res = await fetch(url, {
      signal: ctrl.signal, redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        ...(referer ? { referer } : {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { oldOk: false, newOk: false };
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return { oldOk: false, newOk: false };
    const header = (res.headers.get('content-type') || '').split(';')[0];
    const headerIsImage = /^image\//.test(header);
    const oldOk = headerIsImage && buf.length <= OLD_MAX;
    const newOk = (headerIsImage || !!sniffImageType(buf)) && buf.length <= NEW_MAX;
    return { oldOk, newOk };
  } catch { return { oldOk: false, newOk: false }; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function main() {
  const norm = s => String(s || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();

  // Rebuild id -> rendered logo from every cached shared-host render.
  const byId = new Map();
  for (const f of fs.readdirSync(STATE_DIR).filter(f => /^shared\d+-full-companies\.json$/.test(f))) {
    const stem = f.replace('-companies.json', '');
    const csv = path.join(STATE_DIR, `${stem}-logos.csv`);
    if (!fs.existsSync(csv)) continue;
    const companies = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8'));
    const byTarget = new Map(companies.map(c => [norm(c.scrape_target || c.career_url), c]));
    for (const row of parseCsv(fs.readFileSync(csv, 'utf8'))) {
      const c = byTarget.get(norm(row.website));
      if (c && /^https?:\/\//i.test(row.logo_url || '')) {
        byId.set(c.id, { ...c, logo_url: row.logo_url, logo_type: row.logo_type || 'img-logo' });
      }
    }
  }
  console.log(`cached renders cover ${byId.size} companies`);

  const pool = makePool();
  let stillMissing;
  try {
    const ids = [...byId.keys()];
    const { rows } = await q(pool,
      'SELECT id FROM companies WHERE id = ANY($1::int[]) AND logo_url IS NULL', [ids], 10);
    stillMissing = rows.map(r => r.id);
  } finally {
    await pool.end();
  }
  console.log(`still logo-less: ${stillMissing.length}`);

  const candidates = stillMissing.map(id => byId.get(id));
  const verdicts = await mapLimit(candidates, CONC, c => classify(c.logo_url));

  // Only the silently-dropped ones: would have failed before, works now.
  const recovered = candidates.filter((c, i) => verdicts[i].newOk && !verdicts[i].oldOk);
  const trulyRejected = candidates.filter((c, i) => verdicts[i].oldOk).length;
  const stillBroken = candidates.length - recovered.length - trulyRejected;

  console.log(`recoverable (dropped by the old Content-Type check): ${recovered.length}`);
  console.log(`genuinely reviewed and rejected (left alone): ${trulyRejected}`);
  console.log(`still unusable: ${stillBroken}`);

  if (!recovered.length) return;
  fs.writeFileSync(BATCH_JSON, JSON.stringify(recovered, null, 2));
  fs.writeFileSync(SCRAPED_CSV,
    'website,logo_url,logo_type,status\n' +
    recovered.map(c => `${c.scrape_target || c.career_url},"${c.logo_url}",${c.logo_type},recovered`).join('\n') + '\n');
  console.log('wrote batch-companies.json + batch-logos.csv — run build-preview.js next');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
