#!/usr/bin/env node
/**
 * Build logo URLs from the Sprout logo CDN.
 *
 *   node scripts/logo-review/sprout-logos.js [in.json] [out.csv] [concurrency]
 *
 * A drop-in alternative to render-scrape.js: same input (batch-companies.json) and same
 * output (batch-logos.csv), so build-preview.js and save-logos.js work unchanged.
 *
 * usesprout.com serves company logos from a public CloudFront bucket keyed on the company
 * name:  https://d3q08qjq3lm2dy.cloudfront.net/logos/<slug>.png
 *
 * No auth, no page load, no headless browser. An unknown slug returns 403 rather than a
 * default image, so a 200 is real evidence the logo exists. (The API this was found
 * through needs a bearer token that expires hourly; the CDN needs nothing.)
 *
 * The whole risk here is matching the wrong company, so two rules are deliberate:
 *
 *  - NO first-word candidate. "Fox Pest Control" -> fox returns a real, distinct image of
 *    Fox the broadcaster; "Adams State University" -> adams and "Citizens Bank & Trust" ->
 *    citizens do the same. Naive matching scored 49% and a good share of it was wrong.
 *    Exact-name matching (flattened or hyphenated) scores 17% and is trustworthy.
 *
 *  - Reject the shared placeholder. Some slugs answer 200 with one identical image —
 *    "spero" and "sgico" both returned md5 e53e4dca..., 1732 bytes. Anything matching a
 *    known placeholder hash is dropped, and images shared across companies in one batch
 *    are dropped by build-preview's repeated-URL rule.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IN = process.argv[2] || path.join(__dirname, '../../data/logo/batch-companies.json');
const OUT = process.argv[3] || path.join(__dirname, '../../data/logo/batch-logos.csv');
const CONC = Math.max(1, parseInt(process.argv[4] || '8', 10));

const CDN = 'https://d3q08qjq3lm2dy.cloudfront.net/logos/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const TIMEOUT = 12000;

// Known shared-placeholder images, by md5 of the bytes.
const PLACEHOLDER = new Set(['e53e4dcac9e63359778545378002ca3e']);

// Legal-form suffixes only. Words like "group"/"technologies" are NOT stripped: dropping
// them turns a specific name into a generic one and invites the wrong-company match this
// script exists to avoid.
const SUFFIX = /\b(inc|llc|l\.l\.c|ltd|limited|corp|corporation|co|gmbh|bv|nv|plc|sa|ag|pty|pte|srl|oy|ab|as)\b\.?/g;

function candidates(name) {
  const base = String(name || '').toLowerCase().trim()
    .replace(/[’'`]/g, '')
    .replace(/&amp;/g, ' ')
    .replace(SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  if (!base) return [];
  const flat = base.replace(/ /g, '');
  const dash = base.replace(/ /g, '-');
  // Very short slugs collide with unrelated companies far too easily.
  return [...new Set([flat, dash])].filter(s => s.length > 3);
}

async function fetchLogo(slug) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(CDN + encodeURIComponent(slug) + '.png', { headers: { 'user-agent': UA }, signal: ctl.signal });
    if (!res.ok) return null;                       // 403 = this company isn't in their set
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null;
    const md5 = crypto.createHash('md5').update(buf).digest('hex');
    if (PLACEHOLDER.has(md5)) return { placeholder: true };
    return { logo_url: CDN + slug + '.png', logo_type: 'img-logo', status: 'ok' };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const items = JSON.parse(fs.readFileSync(IN, 'utf8'));
  const rows = new Array(items.length).fill(null);
  let next = 0, done = 0, found = 0, ph = 0;

  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      const it = items[i];
      let res = { status: 'no match' };
      for (const slug of candidates(it.company_name)) {
        const f = await fetchLogo(slug);
        if (f && f.placeholder) { res = { status: 'placeholder' }; ph++; break; }
        if (f) { res = f; break; }
      }
      if (res.logo_url) found++;
      rows[i] = [it.scrape_target || it.career_url || it.domain, res.logo_url || '', res.logo_type || '', res.status];
      if (++done % 50 === 0) console.log(`  ${done}/${items.length} checked, ${found} logos`);
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));

  const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  fs.writeFileSync(OUT, [['website', 'logo_url', 'logo_type', 'status'], ...rows.filter(Boolean)]
    .map(r => r.map(q).join(',')).join('\n') + '\n');
  console.log(`SPROUT ${items.length} | logos: ${found} (${(found / items.length * 100).toFixed(1)}%)` +
    (ph ? ` | ${ph} placeholder` : '') + ` -> ${OUT}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
