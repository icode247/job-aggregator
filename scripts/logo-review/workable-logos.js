#!/usr/bin/env node
/**
 * Pull the company logo off a Workable job page.
 *
 *   node scripts/logo-review/workable-logos.js [in.json] [out.csv] [concurrency]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged.
 *
 * Workable puts each company's uploaded mark at
 *   workablehr.s3.amazonaws.com/uploads/account/logo/<accountId>/logo
 * — a plain S3 path with no signature, so unlike Rippling it does not expire. 8,155
 * companies in the DB already use one.
 *
 * Two things decide where to look:
 *
 *  - The BOARD root (apply.workable.com/<slug>) does NOT carry it. Every board scraped
 *    there returns Workable's own facebook-preview.png placeholder, which is why this pool
 *    was reviewed once and retired. The JOB page (jobs.workable.com/view/...) is where the
 *    logo lives.
 *  - The job page is server-rendered, so a plain fetch is enough — no headless browser.
 *
 * The account id is not the slug and cannot be derived, so the page really must be read.
 */
const fs = require('fs');
const path = require('path');

const IN = process.argv[2] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[3] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[4] || '6', 10));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 20000;

// The uploaded mark, and only that. Workable's own art lives on www.workable.com/assets
// (facebook-preview.png) and on the job-board asset paths; neither is a company logo.
const LOGO_RE = /https:\/\/workablehr\.s3\.amazonaws\.com\/uploads\/account\/logo\/\d+\/logo[^"'\s\\]*/i;

async function jobLogo(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { status: 'http ' + res.status };
    const html = await res.text();
    const m = html.match(LOGO_RE);
    if (!m) return { status: /facebook-preview/i.test(html) ? 'placeholder only' : 'no logo' };
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
  let next = 0, done = 0, found = 0, placeholder = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const res = await jobLogo(it.job_url || it.scrape_target || it.career_url);
      if (res.logo_url) found++;
      if (res.status === 'placeholder only') placeholder++;
      rows[i] = [it.scrape_target || it.career_url, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 25 === 0) console.log(`  ${done}/${items.length} jobs, ${found} logos`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(OUT, [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n');
  console.log(`WORKABLE ${items.length} | logos: ${found} (${(found / items.length * 100).toFixed(1)}%)` +
    (placeholder ? ` | ${placeholder} showed only Workable's placeholder` : '') + ` -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
