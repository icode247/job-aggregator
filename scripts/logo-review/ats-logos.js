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
 *
 *  - pinpoint: <img alt="<Company> - Home"> pointing at app.pinpointhq.com/rails/
 *    active_storage/representations/<signed>/<file>. The signature looks alarming after the
 *    Rippling episode, but both payload segments decode to {"exp":null} — Rails signs these
 *    for integrity, not expiry, so they are safe to store.
 *
 *  - personio: <img class="Header_logoImage__*"> on assets.cdn.personio.de/logos/<id>/...
 *    Boards that uploaded nothing render no such tag at all, so absence is the signal.
 *
 *  - jobvite: <div class="logo"><a><img src="//careers.jobvite.com/<slug>/..."></a>. The
 *    src is PROTOCOL-RELATIVE, so it has to be resolved against the page or it is stored as
 *    a path and renders nowhere.
 *
 *  - jazzhr: <img alt="brand logo"> on s3.amazonaws.com/resumator/customer_<id>/logos/. Every
 *    JazzHR board also serves /img/v1.1/logos/jazzhr-logo.png — the vendor's own mark, which
 *    a "first image in the header" rule would take for all of them.
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
  pinpoint(html, base) {
    // Anchor on the storage path, not on the alt text: alt is "<Company> - Home" and the
    // company name is exactly what we do not want to have to know in advance.
    const tags = html.match(/<img[^>]*rails\/active_storage\/[^>]*>/gi) || [];
    for (const tag of tags) {
      let src = srcOf(tag);
      if (!src) continue;
      try { src = new URL(src, base).href; } catch { continue; }
      return { logo_url: src, logo_type: 'img-logo', status: 'ok' };
    }
    return { status: 'no logo' };
  },
  personio(html, base) {
    let src = null;
    const tag = (html.match(/<img[^>]*Header_logoImage[^>]*>/i) || [])[0];
    if (tag) src = srcOf(tag);
    // Some templates ship the logo only in the og:image / JSON blob; the CDN path is
    // distinctive enough to take directly.
    if (!src) src = (html.match(/https:\/\/assets\.cdn\.personio\.de\/logos\/[^"'\\ >)]+/i) || [])[0];
    if (!src) return { status: 'no logo' };
    try { src = new URL(src, base).href; } catch { return { status: 'bad url' }; }
    return { logo_url: src, logo_type: 'img-logo', status: 'ok' };
  },
  jobvite(html, base) {
    // The board is jobs.jobvite.com/<slug>. careers.jobvite.com/<slug>/ looks plausible and
    // answers 200, but serves either an Apache directory index (/icons/blank.gif) or
    // Jobvite's "pancake" error art — both of which a naive image rule happily stores.
    const VENDOR = /jobvite[-_]?logo|\/images\/jobvite|__assets__|pancake|\/icons\//i;
    const head = [], foot = [];
    const block = (html.match(/<div[^>]*class=["'][^"']*\blogo\b[^"']*["'][^>]*>[\s\S]{0,600}?<\/div>/i) || [])[0];
    if (block) { const t = (block.match(/<img[^>]*>/i) || [])[0]; if (t) head.push(srcOf(t)); }
    for (const t of html.match(/<img[^>]*>/gi) || []) {
      const src = srcOf(t);
      if (!src || !/careers\.jobvite\.com\//i.test(src)) continue;
      // Header before footer, and DOCUMENT ORDER within each: a board often carries both,
      // and the footer copy is usually a reversed/mono variant that reads badly on a light
      // card. Absolute Software ships absolutelogo.svg then absolute-logo-reverse-png.png;
      // anything that does not preserve order picks the reversed one.
      (/footer-logo/i.test(t) ? foot : head).push(src);
    }
    // Prefer a raster over an SVG only when nothing else is available - some boards ship a
    // one-colour svg sprite that renders as a black box on the review card.
    const pick = [...head, ...foot].filter(Boolean).find(x => !VENDOR.test(x));
    if (!pick) return { status: (head.length + foot.length) ? 'vendor art' : 'no logo' };
    let src = pick;
    try { src = new URL(src, base).href; } catch { return { status: 'bad url' }; }
    return { logo_url: src, logo_type: 'img-logo', status: 'ok' };
  },
  jazzhr(html, base) {
    // The same asset appears under two different hosts depending on the board's vintage:
    //   //s3.amazonaws.com/resumator/customer_<id>/logos/...
    //   http://resumator.s3.amazonaws.com/customer_<id>/logos/...
    // Matching only the first shape silently drops the older boards.
    const ASSET = /(?:s3\.amazonaws\.com\/resumator|resumator\.s3\.amazonaws\.com)\/customer_[^"'\\ >)]+/i;
    const tag = (html.match(/<img[^>]*alt=["']brand logo["'][^>]*>/i) || [])[0];
    let src = tag && srcOf(tag);
    let type = 'img-logo';
    if (!src) src = (html.match(new RegExp('https?:' + ASSET.source, 'i')) || [])[0]
      || (html.match(new RegExp('//' + ASSET.source, 'i')) || [])[0];
    if (src && /\/social_icons\//i.test(src)) type = 'social-icon';   // company art, but it
    // is the share thumbnail rather than the header mark - sometimes a photo. Marked so
    // build-preview leaves it unchecked for a human look instead of pre-approving it.
    if (!src) return { status: 'no logo' };
    if (/jazzhr[-_]?logo|powered-by-jazzhr/i.test(src)) return { status: 'vendor art' };
    try { src = new URL(src, base).href; } catch { return { status: 'bad url' }; }
    // These boards still hand out http:// on older records. Stored as-is the image is
    // blocked as mixed content on an https page, so it would look "saved" and render nothing.
    src = src.replace(/^http:\/\/([^/]*amazonaws\.com)/i, 'https://$1');
    return { logo_url: src, logo_type: type, status: 'ok' };
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
