/**
 * Shared helpers for the human-in-the-loop company-logo review pipeline.
 *
 * State lives in data/logo/ (NOT /tmp) — an earlier run kept everything in the
 * session scratchpad and lost the whole processed-set + pending batch when the
 * scratchpad was wiped mid-review.
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '../..');
const STATE_DIR = path.join(ROOT, 'data', 'logo');
fs.mkdirSync(STATE_DIR, { recursive: true });

// Overridable so a re-review pass (REDO=1, which revisits companies that already have a
// junk logo rather than none) keeps its own decided-set and can't retire ids from the
// main queue — or be blocked by them.
const PROCESSED = process.env.PROCESSED_FILE
  ? path.resolve(ROOT, process.env.PROCESSED_FILE)
  : path.join(STATE_DIR, 'processed.txt');
const BATCH_JSON = path.join(STATE_DIR, 'batch-companies.json');
const BATCH_CSV = path.join(STATE_DIR, 'batch-websites.csv');
const SCRAPED_CSV = path.join(STATE_DIR, 'batch-logos.csv');
const REVIEW_JSON = path.join(STATE_DIR, 'batch-review.json');
const PREVIEW_HTML = path.join(STATE_DIR, 'logo-preview.html');

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return execSync('heroku config:get DATABASE_URL -a fastapply-board', { encoding: 'utf8' }).trim();
}

// essential-2 Postgres caps at 40 connections and the crawl fleet already sits close
// to it, so this pipeline never opens more than one.
function makePool() {
  return new Pool({ connectionString: databaseUrl(), max: 1, ssl: { rejectUnauthorized: false } });
}

// Retry around the connection cap: "too many connections" is transient here — the
// crawlers churn connections constantly, so a short backoff usually gets a slot.
async function q(pool, sql, params = [], tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      return await pool.query(sql, params);
    } catch (err) {
      const retryable = /too many connections|Connection terminated|read timeout|ECONNRESET/i.test(err.message);
      if (!retryable || i === tries - 1) throw err;
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

function readProcessed() {
  if (!fs.existsSync(PROCESSED)) return new Set();
  return new Set(fs.readFileSync(PROCESSED, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
}

function appendProcessed(ids) {
  fs.appendFileSync(PROCESSED, ids.map(String).join('\n') + '\n');
}

// Logos served by the ATS itself (or a generic favicon CDN) are never the company's
// own mark — every Lever board serves the same lever.co placeholder, etc.
const VENDOR_PATTERNS = [
  /lever\.co\/img/i,
  /paylocity\.com\/.*cdn/i,
  /careerpuck/i,
  /myworkdayjobs\.com\/.*(assets|logo)/i,
  /greenhouse\.io\/embed/i,
  /ashbyprd.*apple-touch/i,
  /gstatic\.com\/faviconV2/i,
  /bamboohr\.com\/media/i,
  /recruitee\.com\/assets/i,
  /icims\.com\/.*favicon/i,
  /teamtailor-cdn\.com\/.*default/i,
  /static\.zohocdn\.com/i,
  // A careers page behind SSO paints the identity provider's logo, not the company's.
  // Two of these reached a review page looking like ordinary marks; they sit below the
  // repeated-URL threshold because only a handful of boards per batch are login-walled.
  /aadcdn\.msftauth\.net/i,
  /login\.microsoftonline\.com/i,
  // Okta only, not Okta-hosted customer art: tenants upload their own mark for the login
  // page under /fs/bco/, and blanket-matching oktacdn flagged a real company logo as vendor.
  /okta(cdn)?\.com\/(?!fs\/bco\/)/i,
  // Same tenant-upload carve-out as Okta. OneLogin serves customer marks from two paths —
  // /images/brands/ and /images/account_branding/ — both under an opaque hashed filename.
  // Missing the second one flagged a real company logo (Global Prairie) as vendor art.
  /onelogin\.com\/(?!images\/(brands|account_branding)\/).*logo/i,
  /auth0\.com\/.*logo/i,
  // Domain marketplaces. A company whose site has lapsed serves the parking page's art,
  // which looks like an ordinary logo on a review card. The repeated-URL rule catches
  // these only when two land in the same batch — a lone one would sail through.
  /forsale\.godaddy\.com/i,
  /static\.hugedomains\.com/i,
  /img\.atom\.com/i,
  /forsale\.spaceship-cdn\.com/i,
];

function isVendor(url) {
  return VENDOR_PATTERNS.some(re => re.test(url || ''));
}

// Types the scraper is confident about; favicon/og-image are guesses worth eyeballing.
const HIGH_CONFIDENCE = new Set(['img-logo', 'inline-svg']);

module.exports = {
  STATE_DIR, PROCESSED, BATCH_JSON, BATCH_CSV, SCRAPED_CSV, REVIEW_JSON, PREVIEW_HTML,
  databaseUrl, makePool, q, readProcessed, appendProcessed, isVendor, HIGH_CONFIDENCE,
};
