#!/usr/bin/env node
/**
 * Pull the company logo off ATS pages that are server-rendered.
 *
 *   node scripts/logo-review/ats-logos.js <recruitee|oracle> [in.json] [out.csv] [conc]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged. No
 * headless browser — both of these serve the logo in the initial HTML.
 *
 * Each ATS needs its own anchor, because the page also carries art that is NOT the logo
 * and outscores it on size:
 *
 *  - recruitee: the logo is the <img data-cy="navigation-section-logo-image">, at
 *    careers.recruiteecdn.com/image/upload/...,w_400,.../production/images/...
 *    The same page serves a w_1920 cover banner and, for boards that never uploaded
 *    anything, a /lookbook/ stock photo. A generic "biggest image near the top" rule picks
 *    the banner every time.
 *
 *  - oracle: the logo is the <img class="app-header__logo-image">, whose src is a relative
 *    CandidateExperience/images?imageId=<GUID> on the tenant's own host. The GUID is not
 *    derivable, so the page has to be read — but the tenant host makes it per-company.
 */
const fs = require('fs');
const path = require('path');

const ATS = String(process.argv[2] || '').toLowerCase();
const IN = process.argv[3] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[4] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[5] || '6', 10));

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 25000;

const srcOf = tag => (String(tag).match(/\ssrc=["']([^"']+)["']/i) || [])[1];

const RULES = {
  recruitee(html) {
    const tag = (html.match(/<img[^>]*navigation-section-logo-image[^>]*>/i) || [])[0];
    const src = tag && srcOf(tag);
    if (!src) return { status: /lookbook\//i.test(html) ? 'stock lookbook only' : 'no logo' };
    // Recruitee's own stock imagery, served when a board uploaded nothing.
    if (/\/lookbook\//i.test(src)) return { status: 'stock lookbook' };
    return { logo_url: src, logo_type: 'img-logo', status: 'ok' };
  },
  oracle(html, base) {
    const tag = (html.match(/<img[^>]*app-header__logo-image[^>]*>/i) || [])[0];
    let src = tag && srcOf(tag);
    if (!src) {
      // The attribute is data-bound in some templates, so fall back to the image endpoint.
      // Build it from the ORIGIN, not by resolving against the job URL: the job page lives
      // at /hcmUI/CandidateExperience/en/sites/<site>/job/<id>, so a relative resolve
      // produces .../en/sites/<site>/CandidateExperience/images?... which answers with
      // HTML. That silently cost 16 of 18 logos in the first run.
      const id = (html.match(/CandidateExperience\/images\?imageId=([A-Za-z0-9-]+)/i) || [])[1];
      if (id) {
        try { src = new URL(base).origin + '/hcmUI/CandidateExperience/images?imageId=' + id; }
        catch { return { status: 'bad url' }; }
      }
    }
    if (!src) return { status: 'no logo' };
    try { src = new URL(src, base).href; } catch { return { status: 'bad url' }; }
    // Strip the explicit :443 Oracle emits — harmless but ugly in stored data.
    src = src.replace(/^https:\/\/([^/:]+):443\//i, 'https://$1/');
    return { logo_url: src, logo_type: 'img-logo', status: 'ok' };
  },
};

async function logoFor(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) return { status: 'http ' + res.status };
    const html = await res.text();
    return RULES[ATS](html, res.url || url);
  } catch (err) {
    return { status: 'error: ' + err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!RULES[ATS]) {
    console.error(`usage: ats-logos.js <${Object.keys(RULES).join('|')}> [in.json] [out.csv] [conc]`);
    process.exit(1);
  }
  const items = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const rows = new Array(items.length).fill(null);
  let next = 0, done = 0, found = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      const res = await logoFor(it.job_url || it.scrape_target || it.career_url);
      if (res.logo_url) found++;
      rows[i] = [it.scrape_target || it.career_url, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 25 === 0) console.log(`  ${done}/${items.length} pages, ${found} logos`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(OUT, [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n');
  console.log(`${ATS.toUpperCase()} ${items.length} | logos: ${found} (${(found / items.length * 100).toFixed(1)}%) -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
