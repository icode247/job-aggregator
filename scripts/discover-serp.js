#!/usr/bin/env node
/**
 * SERP-based workable discovery — runs your Google dork
 *   site:apply.workable.com ("Role A" OR "Role B" OR ... 5 roles)
 * through Bright Data Web Unlocker AND ScrapingDog (alternating, to split free
 * credits + fail over), extracts apply.workable.com/{slug} from result URLs
 * (exact — no proxy verify needed), and imports net-new as active workable
 * companies (origin=serp_discovery, last_synced_at=NULL so instance E crawls them).
 *
 * Catches companies on apply.workable.com that are NOT on the marketplace (the gap
 * Path A / discover-all-roles.js can't see).
 *
 * Skips industries the user did manually (SKIP_INDUSTRIES, default Technology + Supply Chain).
 * Groups of 5 roles per query. Checkpoints /tmp/discover-serp.checkpoint.
 */
const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');
const { ROLES_BY_INDUSTRY } = require('./job-roles');

function cred(k) { if (process.env[k]) return process.env[k]; try { const l = fs.readFileSync(require('path').join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith(k + '=')); return l ? l.slice(k.length + 1).replace(/^["']|["']$/g, '').trim() : ''; } catch { return ''; } }
const BD_KEY = cred('BRIGHT_DATA_API_KEY'), BD_ZONE = cred('BRIGHT_DATA_ZONE') || 'web_unlocker1', SD_KEY = cred('SCRAPINGDOG_API_KEY');
const SKIP = (process.env.SKIP_INDUSTRIES || 'Technology,Supply Chain').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const GROUP = parseInt(process.env.GROUP_SIZE || '5', 10);
// Google result pages to walk per dork (10 results/page). Higher = more coverage,
// but multiplies SERP credits. Stops early when a page yields no new slugs.
const DEPTH = parseInt(process.env.SERP_DEPTH || '4', 10);

// Per-ATS config (DISCOVER_ATS=workable|bamboohr). workable slugs are URL path
// segments (apply.workable.com/{slug}); bamboohr slugs are subdomains
// ({slug}.bamboohr.com) and its career pages are partly noindex so the dork is a
// phrase search, not site:.
const BAMBOO_BAD = new Set(['www', 'www2', 'www1', 'help', 'support', 'app', 'api', 'blog', 'careers', 'marketing', 'resources', 'status', 'developer', 'partners', 'newsroom', 'info', 'meet', 'get', 'go', 'try', 'hello', 'start']);
const ATS_CFG = {
  workable: {
    dork: (titlesOr) => `site:apply.workable.com (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/apply\.workable\.com\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['api', 'j', 'view', 'company', 'jobs'].includes(s)),
    url: (s) => `https://apply.workable.com/${s}`,
    domain: () => 'apply.workable.com',
  },
  bamboohr: {
    dork: (titlesOr) => `"bamboohr.com/careers" (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/https?:\/\/([a-z0-9][a-z0-9-]*)\.bamboohr\.com/gi) || []).map((u) => u.replace(/^https?:\/\//i, '').split('.')[0].toLowerCase()))].filter((s) => !BAMBOO_BAD.has(s) && s !== 'bamboohr'),
    url: (s) => `https://${s}.bamboohr.com`,
    domain: (s) => `${s}.bamboohr.com`,
  },
  rippling: {
    dork: (titlesOr) => `site:ats.rippling.com (${titlesOr})`,
    // path slug; drop self + locale codes (en-gb, pt-pt, ...) that appear in URLs
    extract: (blob) => [...new Set((String(blob).match(/ats\.rippling\.com\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['rippling', 'jobs', 'api'].includes(s) && !/^[a-z]{2}(-[a-z]{2})?$/.test(s)),
    url: (s) => `https://ats.rippling.com/${s}`,
    domain: () => 'ats.rippling.com',
  },
  breezy: {
    dork: (titlesOr) => `site:breezy.hr (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/https?:\/\/([a-z0-9][a-z0-9-]*)\.breezy\.hr/gi) || []).map((u) => u.replace(/^https?:\/\//i, '').split('.')[0].toLowerCase()))].filter((s) => !['www', 'app', 'gallery-cdn', 'assets'].includes(s)),
    url: (s) => `https://${s}.breezy.hr`,
    domain: (s) => `${s}.breezy.hr`,
  },
  recruitee: {
    dork: (titlesOr) => `site:recruitee.com (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/https?:\/\/([a-z0-9][a-z0-9-]*)\.recruitee\.com/gi) || []).map((u) => u.replace(/^https?:\/\//i, '').split('.')[0].toLowerCase()))].filter((s) => !['www', 'jobs', 'app', 'help', 'blog', 'careers', 'api', 'account'].includes(s)),
    url: (s) => `https://${s}.recruitee.com`,
    domain: (s) => `${s}.recruitee.com`,
  },
  ashby: {
    dork: (titlesOr) => `site:jobs.ashbyhq.com (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/jobs\.ashbyhq\.com\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['api'].includes(s)),
    url: (s) => `https://jobs.ashbyhq.com/${s}`,
    domain: () => 'jobs.ashbyhq.com',
  },
  greenhouse: {
    dork: (titlesOr) => `site:greenhouse.io (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/(?:boards|job-boards)\.greenhouse\.io\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['embed', 'api'].includes(s)),
    url: (s) => `https://boards.greenhouse.io/${s}`,
    domain: () => 'boards.greenhouse.io',
  },
  smartrecruiters: {
    dork: (titlesOr) => `site:careers.smartrecruiters.com (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/(?:jobs|careers)\.smartrecruiters\.com\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['api', 'account'].includes(s)),
    url: (s) => `https://jobs.smartrecruiters.com/${s}`,
    domain: () => 'jobs.smartrecruiters.com',
  },
  lever: {
    dork: (titlesOr) => `site:jobs.lever.co (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/jobs\.lever\.co\/[a-zA-Z0-9][a-zA-Z0-9._-]+/g) || []).map((u) => u.split('/')[1].toLowerCase()))].filter((s) => !['api'].includes(s)),
    url: (s) => `https://jobs.lever.co/${s}`,
    domain: () => 'jobs.lever.co',
  },
  pinpoint: {
    dork: (titlesOr) => `site:pinpointhq.com (${titlesOr})`,
    extract: (blob) => [...new Set((String(blob).match(/([a-z0-9][a-z0-9-]*)\.pinpointhq\.com/gi) || []).map((u) => u.split('.')[0].toLowerCase()))].filter((s) => !['www', 'app', 'api', 'help', 'support', 'blog'].includes(s)),
    url: (s) => `https://${s}.pinpointhq.com`,
    domain: (s) => `${s}.pinpointhq.com`,
  },
};
const ATS = (process.env.DISCOVER_ATS || 'workable').toLowerCase();
const CFG = ATS_CFG[ATS];
if (!CFG) { console.error(`Unknown DISCOVER_ATS=${ATS} (use: ${Object.keys(ATS_CFG).join(', ')})`); process.exit(1); }
const CKPT = `/tmp/discover-serp-${ATS}${process.env.RUN_TAG ? '-' + process.env.RUN_TAG : ''}.checkpoint`;

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const q = async (s, p) => { for (let i = 0; i < 8; i++) { try { return await query(s, p); } catch (e) { if (i === 7) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); } } };
const slugsFrom = (blob) => CFG.extract(blob);

// Walk up to DEPTH result pages (start=0,10,20,...); stop when a page adds nothing.
async function viaBrightData(dork) {
  const acc = new Set();
  for (let page = 0; page < DEPTH; page++) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(dork)}&num=100&start=${page * 10}`;
    const res = await fetch('https://api.brightdata.com/request', { method: 'POST', headers: { Authorization: 'Bearer ' + BD_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ zone: BD_ZONE, url, format: 'raw' }), signal: AbortSignal.timeout(60000) });
    if (!res.ok) { if (page === 0) throw new Error('BD ' + res.status); break; }
    const before = acc.size;
    slugsFrom(await res.text()).forEach((s) => acc.add(s));
    if (acc.size === before) break; // no new results on this page -> end of results
  }
  return [...acc];
}
async function viaScrapingDog(dork) {
  const acc = new Set();
  for (let page = 0; page < DEPTH; page++) {
    const url = `https://api.scrapingdog.com/google/?api_key=${SD_KEY}&query=${encodeURIComponent(dork)}&results=100&country=us&page=${page}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) { if (page === 0) throw new Error('SD ' + res.status); break; }
    const d = JSON.parse(await res.text());
    const org = d.organic_results || d.organic_data || [];
    const before = acc.size;
    slugsFrom(org.map((o) => o.link || o.url || '').join(' ')).forEach((s) => acc.add(s));
    if (acc.size === before) break;
  }
  return [...acc];
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL'); process.exit(1); }
  if (!BD_KEY && !SD_KEY) { console.error('Need BRIGHT_DATA_API_KEY and/or SCRAPINGDOG_API_KEY'); process.exit(1); }

  // ROLES_OVERRIDE=comma,titles runs an ad-hoc set. INCLUDE_INDUSTRIES=substr,substr
  // runs ONLY those industries (inverse of SKIP). Else: all minus SKIP.
  const INCLUDE = (process.env.INCLUDE_INDUSTRIES || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  // DORK=<raw query after site:> runs a single arbitrary combined dork per ATS
  // (e.g. "(Procurement OR Buyer) (Canada OR Toronto)") instead of the role list.
  const roles = process.env.DORK
    ? ['__single__']
    : process.env.ROLES_OVERRIDE
    ? process.env.ROLES_OVERRIDE.split(',').map((s) => s.trim()).filter(Boolean)
    : Object.entries(ROLES_BY_INDUSTRY).filter(([ind]) => {
        const l = ind.toLowerCase();
        return INCLUDE.length ? INCLUDE.some((s) => l.includes(s)) : !SKIP.some((s) => l.includes(s));
      }).reduce((a, [, r]) => a.concat(r), []);
  const groups = chunk(roles, GROUP);
  let start = parseInt(process.env.START_GROUP || '0', 10);
  if (!process.env.START_GROUP && fs.existsSync(CKPT)) { const c = parseInt(fs.readFileSync(CKPT, 'utf8').trim(), 10); if (!isNaN(c)) start = c; }
  const scope = INCLUDE.length ? `only ${INCLUDE.join('+')}` : (process.env.ROLES_OVERRIDE ? 'custom roles' : `skipping ${SKIP.join('+')}`);
  console.log(`SERP discovery [${ATS}] | ${roles.length} roles (${scope}) | ${groups.length} dorks of ${GROUP} | BD=${!!BD_KEY} SD=${!!SD_KEY} | from group ${start}`);

  let totalImported = 0, bdUsed = 0, sdUsed = 0, bdFail = 0, sdFail = 0;
  for (let g = start; g < groups.length; g++) {
    const dork = process.env.DORK
      ? CFG.dork('').replace(/\s*\(\s*\)\s*$/, ' ') + process.env.DORK   // site prefix + raw combined query
      : CFG.dork(groups[g].map((r) => `"${r}"`).join(' OR '));
    // Bright Data primary (ScrapingDog free quota is exhausted); SD only as fallback.
    const order = BD_KEY ? ['bd', 'sd'] : ['sd', 'bd'];
    let slugs = null;
    for (const provider of order) {
      try {
        if (provider === 'bd' && BD_KEY) { slugs = await viaBrightData(dork); bdUsed++; break; }
        if (provider === 'sd' && SD_KEY) { slugs = await viaScrapingDog(dork); sdUsed++; break; }
      } catch (e) { if (provider === 'bd') bdFail++; else sdFail++; }
    }
    if (!slugs) { console.log(`[serp ${g + 1}/${groups.length}] both providers failed — skipping`); fs.writeFileSync(CKPT, String(g + 1)); continue; }

    // dedup vs DB, import net-new
    let inserted = 0, already = 0;
    if (slugs.length) {
      const ex = new Set();
      for (const grp of chunk(slugs, 300)) { const { rows } = await q(`SELECT ats_slug FROM companies WHERE ats=? AND ats_slug IN (${grp.map(() => '?').join(',')})`, [ATS, ...grp]); rows.forEach((r) => ex.add(r.ats_slug)); }
      already = slugs.filter((s) => ex.has(s)).length;
      const toIns = slugs.filter((s) => !ex.has(s));
      const title = (s) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      for (const grp of chunk(toIns, 120)) {
        const vals = [], p = [];
        grp.forEach((s) => { vals.push('(?,?,?,?,?,?,?,NOW(),NULL,NOW())'); p.push(CFG.url(s), CFG.domain(s), ATS, s, title(s), 'serp_discovery', 'active'); });
        const r = await q(`INSERT INTO companies (career_url,domain,ats,ats_slug,company_name,origin,status,created_at,last_synced_at,updated_at) VALUES ${vals.join(',')} ON CONFLICT (career_url) DO NOTHING`, p);
        inserted += r.rowCount;
      }
    }
    totalImported += inserted;
    fs.writeFileSync(CKPT, String(g + 1));
    console.log(`[serp ${g + 1}/${groups.length}] slugs=${slugs.length} new=${inserted} known=${already} | TOTAL new ${totalImported} | BD ${bdUsed}(${bdFail}f) SD ${sdUsed}(${sdFail}f)`);
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log(`DONE. Net-new imported ${totalImported}. Credits used: BrightData ${bdUsed}, ScrapingDog ${sdUsed}.`);
  await closeDb();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
