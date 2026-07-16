#!/usr/bin/env node
/**
 * Backfill comeet job descriptions.
 *
 * The comeet careers-api (v2.0) returns positions WITHOUT descriptions — no list
 * param or per-position endpoint exposes them. The description only lives on the
 * SEO-rendered hosted page (comeet.com/jobs/...), in the `og:description` meta tag
 * (server-rendered, ~full text). comeet.com sits behind Incapsula, so we fetch via
 * Bright Data Web Unlocker.
 *
 * Run: DATABASE_URL=... node scripts/backfill-comeet-desc.js
 * Env: CONCURRENCY (default 5), BATCH (default 200), LOOP=1 (re-check every RECHECK_S).
 */
const { query, closeDb } = require('../src/db/connection');

const env = (() => {
  const fs = require('fs'); const e = {};
  try { fs.readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).forEach((l) => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) e[m[1]] = m[2]; }); } catch { /* */ }
  return { ...e, ...process.env };
})();
const BD_KEY = env.BRIGHT_DATA_API_KEY;
const BD_ZONE = env.BRIGHT_DATA_ZONE || 'web_unlocker1';
const CONC = parseInt(env.CONCURRENCY || '5', 10);
const BATCH = parseInt(env.BATCH || '200', 10);
const RECHECK_S = parseInt(env.RECHECK_S || '600', 10);
const LOOP = env.LOOP === '1';
const q = async (s, p) => { for (let i = 0; i < 8; i++) { try { return await query(s, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeOnce(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
// Run twice to unwind double-encoding (e.g. "&amp;amp;" -> "&amp;" -> "&").
function decodeEntities(s) { return decodeOnce(decodeOnce(s)).replace(/\s+\n/g, '\n').trim(); }

// Unescape JS-string \uXXXX / \" / \n etc. found inside the embedded field values.
function unescapeJs(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\\t/g, ' ').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
}
// Convert the section HTML to readable text: bullets for <li>, newlines for blocks.
function htmlToText(h) {
  return h.replace(/<li[^>]*>/gi, '\n• ').replace(/<\/(p|div|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
}

async function fetchDesc(url) {
  let html;
  try {
    const r = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone: BD_ZONE, url, format: 'raw' }),
      signal: AbortSignal.timeout(45000),
    });
    html = await r.text();
  } catch { return null; }
  // Full description = all embedded {name,value,order} sections assembled
  // (Description + Requirements + Benefits + any custom fields), in order.
  const fields = [...html.matchAll(/\{"name":\s*"([^"]*)",\s*"value":\s*"((?:[^"\\]|\\.)*)",\s*"order":\s*(\d+)\}/g)]
    .map((m) => ({ name: m[1], value: m[2], order: +m[3] }))
    .sort((a, b) => a.order - b.order);
  // Only trust the multi-section assembly when it's plausibly ONE position's
  // fields. Some pages (or company-level URLs) embed EVERY position's fields —
  // that yields dozens of fields / huge text; fall back to the job-scoped
  // og:description instead of concatenating the whole company.
  if (fields.length && fields.length <= 8) {
    let full = '';
    for (const f of fields) {
      const txt = decodeEntities(htmlToText(unescapeJs(f.value))).replace(/\n{3,}/g, '\n\n').trim();
      if (txt) full += (f.name ? f.name + '\n' : '') + txt + '\n\n';
    }
    full = full.trim();
    if (full.length > 20 && full.length <= 15000) return full;
  }
  // Fallback: og:description (Description section only) if no fields present.
  const og = (html.match(/property="og:description"\s+content="([^"]+)"/i) || [])[1];
  return og ? decodeEntities(og).trim() : null;
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!BD_KEY) { console.error('Set BRIGHT_DATA_API_KEY'); process.exit(1); }
  let filled = 0, empty = 0, pass = 0;
  do {
    pass++;
    let cursor = 2147483647, passFill = 0, passEmpty = 0, batches = 0;  // int4 max
    // Cursor-paginate by id DESC so every job needing a description is visited
    // exactly once per pass (no re-fetching the genuinely-empty ones).
    while (true) {
      const { rows } = await q(
        `SELECT id, url FROM jobs
          WHERE ats = 'comeet' AND removed_at IS NULL
            ${process.env.REFRESH === '1' ? '' : "AND (description IS NULL OR description = '')"}
            AND url LIKE 'http%' AND id < ?
          ORDER BY id DESC LIMIT ?`, [cursor, BATCH]);
      if (!rows.length) break;
      cursor = rows[rows.length - 1].id;
      batches++;
      let i = 0;
      await Promise.all(Array.from({ length: CONC }, async () => {
        while (i < rows.length) {
          const job = rows[i++];
          const desc = await fetchDesc(job.url);
          if (desc && desc.length > 20) { await q('UPDATE jobs SET description = ? WHERE id = ?', [desc, job.id]); filled++; passFill++; }
          else { empty++; passEmpty++; }
        }
      }));
      if (batches % 5 === 0) console.log(`pass ${pass} batch ${batches}: +${passFill} filled, ${passEmpty} empty this pass | ${filled} total filled`);
    }
    console.log(`pass ${pass} done: ${passFill} filled, ${passEmpty} empty (no description on page) | ${filled} total filled`);
    if (LOOP) { console.log(`--- sleeping ${RECHECK_S}s ---`); await sleep(RECHECK_S * 1000); }
  } while (LOOP);
  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
