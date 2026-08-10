#!/usr/bin/env node
/**
 * Render each company's ATS careers page in a headless browser and pull the
 * company's own logo out of the painted DOM.
 *
 *   node scripts/logo-review/render-scrape.js <input.json> <output.csv> [concurrency]
 *
 * Why a browser: for the ~16.5k companies whose `domain` is a shared ATS host
 * (recruiting.paylocity.com, ats.rippling.com, ...) the only company-specific
 * page is their ATS careers page, and those are JS-rendered SPAs. A static
 * fetch sees the ATS's own assets and nothing else; the company's uploaded
 * logo only exists after the page runs. One renderer covers every ATS, which
 * beats reverse-engineering ten separate branding APIs.
 *
 * Output matches the python scraper's CSV shape (website,logo_url,logo_type,status)
 * so build-preview.js consumes it unchanged.
 */
const fs = require('fs');
const puppeteer = require('puppeteer');

const NAV_TIMEOUT = 25000;
const SETTLE_MS = 1200;      // let late-loading logo images paint
const SLOW_SETTLE_MS = 3500; // second chance for boards that hydrate late

// Assets belonging to the ATS itself, not the company. Every company on a given
// ATS would otherwise be handed the same image.
const VENDOR = [
  /cdn\.ashbyprd\.com\/cdn_assets/i,
  /staticfe\.bamboohr\.com/i,
  /static-assets\.ripplingcdn\.com/i,
  /cdn\.paylocity\.com\/cdn\/branding/i,
  /recruiting\.paylocity\.com\/Recruiting\/Content/i,
  /av-www\.smartrecruiters\.com\/sr-logo/i,
  /workablehr-ui\.s3[.-]/i,
  // Workable moved its board assets to a rotating CloudFront host, so match the
  // path, not the domain — otherwise every Workable company gets "jobs by workable".
  /\/job-board\/assets\//i,
  /boards\.greenhouse\.io\/(apple-icon|favicon)/i,
  // NOT the tenant logo: Workday serves each tenant's own uploaded mark at
  // <tenant>.wdN.myworkdayjobs.com/<Site>/assets/logo, and blanket-matching assets/logo
  // discarded it as vendor art. That is why Workday boards looked like they exposed no
  // logo element at all. Workday's own chrome lives on workdaycdn.com, matched below.
  /myworkdayjobs\.com\/.*\/(assets|images)\/favicon/i,
  /workdaycdn\.com/i,
  // Workday's outage/error page, which a wrong tenant URL lands on — it serves Workday's
  // own mark and would otherwise be recorded as that company's logo.
  /community\.workday\.com\/.*wday-logo/i,
  /comeet\.co\/(assets|images)/i,
  /icims\.com\/.*favicon/i,
  /gstatic\.com\/faviconV2/i,
  /\/(apple-touch-icon|favicon)[^/]*\.(png|ico|jpg)$/i,
];
const isVendor = u => VENDOR.some(re => re.test(u || ''));
const pick = cands => cands.filter(c => !isVendor(c.url)).sort((a, b) => b.score - a.score);

// Runs inside the page. Ranks every candidate mark by how logo-like it looks:
// position near the top, "logo" in the markup, and a sane banner-ish aspect ratio.
function collectCandidates() {
  const out = [];
  const abs = src => { try { return new URL(src, location.href).href; } catch { return null; } };

  for (const img of document.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    const src = abs(img.currentSrc || img.src);
    if (!src || !/^https?:/.test(src)) continue;
    if (r.width < 30 || r.height < 12) continue;
    const hay = `${img.alt || ''} ${img.className || ''} ${img.id || ''} ${src}`.toLowerCase();
    let score = 0;
    if (/logo|brand|wordmark/.test(hay)) score += 60;
    if (r.top < 250) score += 40;               // headers live at the top
    if (img.closest('header,nav,[class*=header],[class*=nav],[class*=brand]')) score += 30;
    const ratio = r.width / Math.max(r.height, 1);
    if (ratio > 1 && ratio < 8) score += 15;    // banner-shaped, not a hero photo
    if (r.width * r.height > 400000) score -= 40; // full-bleed hero image
    out.push({ url: src, score, w: Math.round(r.width), h: Math.round(r.height), type: 'img-logo' });
  }

  // CSS background images on header-ish elements
  for (const el of document.querySelectorAll('header *,nav *,[class*=logo],[class*=brand]')) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    if (!m) continue;
    const src = abs(m[1]);
    const r = el.getBoundingClientRect();
    if (!src || !/^https?:/.test(src) || r.width < 30) continue;
    out.push({ url: src, score: 55 + (r.top < 250 ? 40 : 0), w: Math.round(r.width), h: Math.round(r.height), type: 'css-logo' });
  }

  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content && /^https?:/.test(og.content)) {
    out.push({ url: abs(og.content), score: 10, w: 0, h: 0, type: 'og-image' });
  }
  return out;
}

function csvCell(s) {
  const v = String(s == null ? '' : s);
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

async function scrapeOne(page, item) {
  try {
    await page.goto(item.career_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // SPAs paint the header after hydration; a short settle beats networkidle,
    // which these pages often never reach (polling/analytics keep sockets busy).
    await new Promise(r => setTimeout(r, SETTLE_MS));
    let usable = pick(await page.evaluate(collectCandidates));
    if (!usable.length) {
      // Slow boards (Workday, Comeet) hydrate well after DOMContentLoaded. Only
      // these pay the extra wait, so the common case stays fast.
      await new Promise(r => setTimeout(r, SLOW_SETTLE_MS));
      usable = pick(await page.evaluate(collectCandidates));
    }
    if (!usable.length) return { logo_url: '', logo_type: 'none', status: 'no candidate' };
    const best = usable[0];
    return { logo_url: best.url, logo_type: best.type, status: `score=${best.score} ${best.w}x${best.h}` };
  } catch (err) {
    return { logo_url: '', logo_type: 'none', status: 'error: ' + err.message.slice(0, 60) };
  }
}

async function main() {
  const [inFile, outFile, concArg] = process.argv.slice(2);
  if (!inFile || !outFile) { console.error('usage: render-scrape.js <input.json> <output.csv> [concurrency]'); process.exit(1); }
  const CONC = parseInt(concArg || '6', 10);
  const items = JSON.parse(fs.readFileSync(inFile, 'utf8'));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const rows = new Array(items.length);
  let next = 0, done = 0, hits = 0;

  const pass = async (idxs, conc, label) => {
    next = 0; done = 0;
    const queue = idxs;
    await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, async () => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36');
    // Media and fonts cost seconds per page and can't contain the logo.
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'media' || t === 'font') req.abort().catch(() => {});
      else req.continue().catch(() => {});
    });

    while (next < queue.length) {
      const i = queue[next++];
      const it = items[i];
      const res = await scrapeOne(page, it);
      // Echo the batch's own join key, not the URL we navigated to. In SHARED mode the
      // two are the same career_url; in own-domain mode scrape_target is the bare domain
      // and writing career_url here made the row unjoinable in build-preview.
      rows[i] = [it.scrape_target || it.career_url, res.logo_url, res.logo_type, res.status];
      done++;
      if (res.logo_url) hits++;
      if (done % 25 === 0) console.log(`  ${label}${done}/${queue.length} rendered, ${hits} logos`);
    }
      await page.close().catch(() => {});
    }));
  };

  await pass(items.map((_, i) => i), CONC, '');

  // Navigation timeouts are usually this machine being busy — the local crawler fleet runs
  // six instances — not a dead careers page. One batch lost 275 companies to timeouts at
  // concurrency 8 and 253 of them scraped fine at 3; without this they would have been
  // marked reviewed by save-logos.js having never been fetched. Retry them slowly.
  const failed = rows.map((r, i) => [r, i]).filter(([r]) => /^error:/.test(r[3])).map(([, i]) => i);
  if (failed.length) {
    const retryConc = Math.max(1, Math.floor(CONC / 3));
    console.log(`retrying ${failed.length} failures at concurrency ${retryConc}`);
    const before = hits;
    // The retry is a bonus pass, never a gate on the results already in hand. A browser
    // too degraded to open another page throws Target.createTarget, and letting that
    // propagate killed the script before it wrote the CSV — losing 96 good logos to
    // salvage 85 uncertain ones. Keep what the main pass found.
    try {
      await pass(failed, retryConc, 'retry ');
      console.log(`  retry recovered ${hits - before} logos`);
    } catch (err) {
      console.log(`  retry aborted (${err.message.slice(0, 60)}) — keeping main-pass results`);
    }
  }

  // Same reasoning as the retry: nothing after the scrape may cost us the scrape.
  await browser.close().catch(err =>
    console.log(`  browser close failed (${err.message.slice(0, 50)}) — writing results anyway`));
  fs.writeFileSync(outFile,
    'website,logo_url,logo_type,status\n' + rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n');
  console.log(`RENDERED ${items.length} | logos found: ${hits} (${(100 * hits / items.length).toFixed(1)}%) -> ${outFile}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
