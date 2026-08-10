#!/usr/bin/env node
/**
 * Pull the per-company logo off a Greenhouse job board.
 *
 *   node scripts/logo-review/gh-scrape.js [in.json] [out.csv] [concurrency]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged.
 *
 * Greenhouse boards serve a logo the company itself uploaded, from
 *   s4-recruiting.cdn.greenhouse.io/external_greenhouse_job_boards/logos/...
 * That is a tenant upload, not vendor art, and 4,431 companies in the DB already use one.
 * The board renders it server-side, so a plain fetch is enough — no headless browser.
 *
 * The trap is the OTHER Greenhouse CDN path:
 *   s9-recruiting.cdn.greenhouse.io/job_board_renderer/job_board_configurations/banners/...
 * That is the hero banner across the top of the board — a wide marketing image, often a
 * photo of an office, which is exactly the kind of thing that looks plausible on a review
 * card and is not a logo. Boards that have no logo uploaded still have a banner, so
 * matching loosely on "greenhouse cdn" would quietly swap one for the other.
 */
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[3] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[4] || '6', 10));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 20000;

// The logo, and only the logo. Anchored on the path Greenhouse uses for tenant uploads.
const LOGO_RE = /https:\/\/[^"'\s]*\/external_greenhouse_job_boards\/logos\/[^"'\s]+/i;

async function boardLogo(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { status: 'http ' + res.status };
    const html = await res.text();
    const m = html.match(LOGO_RE);
    if (!m) return { status: /job_board_configurations\/banners/i.test(html) ? 'banner only' : 'no logo' };
    // Greenhouse HTML-escapes the querystring (&amp;) inside attributes.
    return { logo_url: m[0].replace(/&amp;/g, '&'), logo_type: 'img-logo', status: 'ok' };
  } catch (err) {
    return { status: 'error: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const items = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const rows = new Array(items.length).fill(null);
  let next = 0, done = 0, found = 0, banner = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const res = await boardLogo(it.scrape_target || it.career_url);
      if (res.logo_url) found++;
      if (res.status === 'banner only') banner++;
      rows[i] = [it.scrape_target || it.career_url, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 25 === 0) console.log(`  ${done}/${items.length} boards, ${found} logos`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(OUT, [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n');
  console.log(`GREENHOUSE ${items.length} | logos: ${found} (${(found / items.length * 100).toFixed(1)}%)` +
    (banner ? ` | ${banner} had only a hero banner, skipped` : '') + ` -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
