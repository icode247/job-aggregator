#!/usr/bin/env node
/**
 * Build Comeet logo URLs without scraping anything.
 *
 *   node scripts/logo-review/comeet-logos.js [in.json] [out.csv] [concurrency]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged.
 *
 * Comeet publishes each company's logo at a stable, derivable address:
 *   https://www.comeet.co/pub/<slug>/<uid>/logo?size=medium
 * The uid is already in career_url (comeet.co/jobs/<uid>). The slug comes from the job URL
 * when the job is hosted on Comeet (comeet.com/jobs/<slug>/<uid>/...), and otherwise from
 * company_name — for Comeet rows the company_name IS the slug (anecdotes, overwolf, sett),
 * because that is what the board is keyed on.
 *
 * Comeet was written off earlier in this pipeline as unreachable, on the grounds that
 * career_url carries only an opaque id. That was true of career_url and false of the
 * company: the id is half the address, not the whole of it.
 *
 * Each URL is still fetched once to confirm it serves an image, because a wrong slug
 * returns a page rather than art, and a card that 404s wastes a human's attention.
 */
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[3] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[4] || '6', 10));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function logoUrlFor(item) {
  const uid = (String(item.career_url || '').match(/comeet\.co\/jobs\/([^/?#]+)/i) || [])[1];
  if (!uid) return null;
  const fromJob = (String(item.job_url || '').match(/comeet\.com\/jobs\/([^/]+)\//i) || [])[1];
  const fromName = String(item.company_name || '').trim().toLowerCase().replace(/\s+/g, '');
  const slug = fromJob || fromName;
  if (!slug || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) return null;
  return `https://www.comeet.co/pub/${slug}/${uid}/logo?size=medium`;
}

async function check(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { status: 'http ' + res.status };
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    // Comeet answers with binary/octet-stream for plenty of its logos, so sniff the bytes
    // rather than trusting the header — the same trap build-preview hit with Paylocity.
    const png = buf[0] === 0x89 && buf[1] === 0x50;
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    const gif = buf.slice(0, 3).toString('ascii') === 'GIF';
    const svg = buf.slice(0, 300).toString('utf8').trimStart().startsWith('<svg');
    if (!/^image\//.test(ct) && !(png || jpg || gif || svg)) return { status: 'not an image (' + ct.slice(0, 24) + ')' };
    if (buf.length < 100) return { status: 'empty' };
    return { logo_url: url, logo_type: 'img-logo', status: 'ok' };
  } catch (err) {
    return { status: 'error: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const items = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const rows = new Array(items.length).fill(null);
  let next = 0, done = 0, found = 0, noUrl = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const url = logoUrlFor(it);
      const res = url ? await check(url) : { status: 'no slug/uid' };
      if (res.logo_url) found++; else if (!url) noUrl++;
      rows[i] = [it.scrape_target || it.career_url, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 25 === 0) console.log(`  ${done}/${items.length} checked, ${found} logos`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(OUT, [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n');
  console.log(`COMEET ${items.length} | logos: ${found} (${(found / items.length * 100).toFixed(1)}%)` +
    (noUrl ? ` | ${noUrl} had no derivable slug/uid` : '') + ` -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
