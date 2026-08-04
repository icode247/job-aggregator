#!/usr/bin/env node
/**
 * Google search scraper to discover companies on Paylocity, Comeet, and Workday.
 * Uses puppeteer to search Google for: site:{ats-domain} AND "{role1}" OR "{role2}" OR "{role3}"
 * Extracts company slugs from URLs and writes to CSV.
 *
 * Usage:
 *   node scripts/scrape-google-ats.js
 *   node scripts/scrape-google-ats.js --ats=paylocity
 *   node scripts/scrape-google-ats.js --ats=comeet --headless=false
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// --- CLI args ---
function getArg(name, fallback) {
  const match = process.argv.find(a => a.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : fallback;
}

const ATS_FILTER = getArg('ats', 'all'); // paylocity, comeet, workday, or all
const HEADLESS = getArg('headless', 'true') !== 'false';
const DELAY_MS = parseInt(getArg('delay', '3000'));
const OUTPUT_DIR = path.join(__dirname, '..', 'data');

// --- ATS Configs ---
const ATS_CONFIGS = {
  paylocity: {
    site: 'paylocity.com',
    extractSlug: (url) => {
      // URL pattern: recruiting.paylocity.com/recruiting/jobs/All/{GUID}/{slug}
      // or: recruiting.paylocity.com/recruiting/jobs/Details/{GUID}/{jobId}/{slug}
      const guidMatch = url.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const slugMatch = url.match(/\/All\/[^/]+\/([^/?]+)/);
      const companyName = slugMatch ? slugMatch[1].replace(/-/g, ' ') : null;
      return guidMatch ? { guid: guidMatch[1], slug: slugMatch?.[1] || guidMatch[1], name: companyName } : null;
    },
  },
  comeet: {
    site: 'comeet.com',
    extractSlug: (url) => {
      // URL pattern: www.comeet.com/jobs/{company-slug}/{uid} or comeet.co/jobs/{company-slug}
      const match = url.match(/comeet\.(?:com|co)\/jobs\/([^/?#]+)/);
      if (!match) return null;
      const slug = match[1];
      // Also try to extract UID from deeper path
      const uidMatch = url.match(/comeet\.(?:com|co)\/jobs\/[^/]+\/([A-Z0-9.]+)/);
      return { slug, uid: uidMatch?.[1] || null, name: slug.replace(/-/g, ' ') };
    },
    // After scraping, visit each company page to extract the token
    postProcess: async (page, results) => {
      console.log('\n  Extracting Comeet tokens from career pages...');
      let tokenFound = 0;
      for (const [key, info] of results) {
        if (info.ats !== 'comeet' || info.token) continue;
        try {
          const url = `https://www.comeet.co/jobs/${info.slug}`;
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
          const html = await page.content();
          // Token is in the page source: token=XXXX or "token":"XXXX"
          const tokenMatch = html.match(/token[=:]["']?([A-Z0-9]{20,})/i);
          const uidMatch = html.match(/company_uid[=:]["']?([A-Z0-9.]+)/i)
            || html.match(/\/careers-api\/2\.0\/company\/([^/]+)/);
          if (tokenMatch) {
            info.token = tokenMatch[1];
            if (uidMatch) info.uid = uidMatch[1];
            tokenFound++;
            console.log(`    ✅ ${info.slug}: uid=${info.uid}, token=${info.token.substring(0, 10)}...`);
          } else {
            console.log(`    ❌ ${info.slug}: no token found`);
          }
          await new Promise(r => setTimeout(r, 2000));
        } catch (err) {
          console.log(`    ❌ ${info.slug}: ${err.message.substring(0, 50)}`);
        }
      }
      console.log(`  Tokens extracted: ${tokenFound}`);
    },
  },
  workday: {
    site: 'myworkdayjobs.com',
    extractSlug: (url) => {
      // URL pattern: {company}.wd{N}.myworkdayjobs.com/{siteslug}/job/...
      const match = url.match(/^https?:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com/);
      return match ? { slug: match[1], name: match[1].replace(/-/g, ' ') } : null;
    },
  },
};

// --- Roles grouped in threes for search ---
const SCRUM_ROLES = [
  'Scrum Master', 'Senior Scrum Master', 'Agile Coach',
  'Agile Scrum Master', 'Certified Scrum Master', 'Agile Delivery Manager',
  'Agile Project Manager', 'Agile Program Manager', 'Release Train Engineer',
  'SAFe Agilist', 'Agile Transformation Lead', 'Agile Consultant',
  'Iteration Manager', 'Kanban Coach', 'Delivery Lead',
  'Sprint Planning Lead',
];

const SCM_ROLES = [
  'Supply Chain Manager', 'Supply Chain Analyst', 'Supply Chain Planner',
  'Supply Chain Engineer', 'Supply Chain Director', 'Supply Chain Coordinator',
  'Procurement Manager', 'Procurement Specialist', 'Procurement Analyst',
  'Logistics Manager', 'Logistics Coordinator', 'Logistics Analyst',
  'Warehouse Manager', 'Warehouse Supervisor', 'Inventory Manager',
  'Inventory Analyst', 'Demand Planner', 'Supply Planner',
  'Sourcing Manager', 'Strategic Sourcing Manager', 'Purchasing Manager',
  'Buyer', 'Senior Buyer', 'Category Manager',
  'Vendor Manager', 'Fulfillment Manager', 'Distribution Manager',
  'Freight Manager', 'Transportation Manager', 'Fleet Manager',
  'Production Planner', 'Materials Manager', 'S&OP Manager',
  'Import Export Manager', 'Customs Broker', 'Trade Compliance Manager',
  'Supply Chain Operations Manager', 'VP Supply Chain', 'Head of Supply Chain',
  'Procurement Director', 'Logistics Director',
];

const ALL_ROLES = [...SCRUM_ROLES, ...SCM_ROLES];

// Group roles in threes
function groupRoles(roles, size = 3) {
  const groups = [];
  for (let i = 0; i < roles.length; i += size) {
    groups.push(roles.slice(i, i + size));
  }
  return groups;
}

function buildQuery(site, roleGroup) {
  const roleQuery = roleGroup.map(r => `"${r}"`).join(' OR ');
  return `site:${site} ${roleQuery}`;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function scrapeGoogleResults(page, query, atsKey, extractSlug, allResults) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&num=100`;

  console.log(`  Searching: ${query.substring(0, 80)}...`);

  await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  // Check for CAPTCHA
  const content = await page.content();
  if (content.includes('unusual traffic') || content.includes('captcha') || content.includes('recaptcha')) {
    console.log('  ⚠️  CAPTCHA detected! Waiting 30s for manual solve...');
    await sleep(30000);
  }

  let pageNum = 1;
  let totalFound = 0;

  while (true) {
    // Extract all links from search results
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => a.href).filter(h => h.startsWith('http'));
    });

    let pageFound = 0;
    for (const link of links) {
      const info = extractSlug(link);
      if (info && info.slug) {
        const key = `${atsKey}:${info.slug.toLowerCase()}`;
        if (!allResults.has(key)) {
          allResults.set(key, { ats: atsKey, ...info });
          pageFound++;
          totalFound++;
        }
      }
    }

    console.log(`    Page ${pageNum}: ${pageFound} new companies (${totalFound} total for this query)`);

    // Try to go to next page
    const nextButton = await page.$('a#pnnext, a[aria-label="Next"]');
    if (!nextButton) {
      console.log(`    No more pages.`);
      break;
    }

    await nextButton.click();
    await sleep(DELAY_MS + Math.random() * 2000);

    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 });
    } catch {
      // Navigation timeout — page may have loaded already
    }

    pageNum++;

    // Safety limit
    if (pageNum > 20) {
      console.log(`    Reached page limit (20).`);
      break;
    }
  }

  return totalFound;
}

async function scrapeAts(browser, atsKey, config) {
  const outputFile = path.join(OUTPUT_DIR, `${atsKey}_companies_google.csv`);
  const allResults = new Map();

  // Load existing results if file exists
  if (fs.existsSync(outputFile)) {
    const existing = fs.readFileSync(outputFile, 'utf8').split('\n').slice(1).filter(l => l.trim());
    for (const line of existing) {
      const parts = line.split(',');
      if (parts.length >= 2) {
        const key = `${atsKey}:${parts[1].replace(/"/g, '').toLowerCase()}`;
        allResults.set(key, { ats: atsKey, slug: parts[1].replace(/"/g, ''), name: parts[0].replace(/"/g, '') });
      }
    }
    console.log(`Loaded ${allResults.size} existing results for ${atsKey}`);
  }

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1280, height: 800 });

  const roleGroups = groupRoles(ALL_ROLES, 3);
  console.log(`\n=== ${atsKey.toUpperCase()} (${config.site}) ===`);
  console.log(`${roleGroups.length} search groups × all pages\n`);

  let totalNewFound = 0;

  for (let i = 0; i < roleGroups.length; i++) {
    const group = roleGroups[i];
    const query = buildQuery(config.site, group);

    console.log(`[${i + 1}/${roleGroups.length}] Roles: ${group.join(', ')}`);

    try {
      const found = await scrapeGoogleResults(page, query, atsKey, config.extractSlug, allResults);
      totalNewFound += found;
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      await sleep(10000);
    }

    // Write results after each search group
    const csv = ['Company,Slug,GUID,Token,UID,ATS'];
    for (const [, r] of allResults) {
      csv.push(`"${r.name || r.slug}","${r.slug}","${r.guid || ''}","${r.token || ''}","${r.uid || ''}","${r.ats}"`);
    }
    fs.writeFileSync(outputFile, csv.join('\n'));

    await sleep(DELAY_MS + Math.random() * 3000);
  }

  // Post-process (e.g., extract Comeet tokens)
  if (config.postProcess) {
    await config.postProcess(page, allResults);
    // Rewrite CSV with tokens
    const csv2 = ['Company,Slug,GUID,Token,UID,ATS'];
    for (const [, r] of allResults) {
      csv2.push(`"${r.name || r.slug}","${r.slug}","${r.guid || ''}","${r.token || ''}","${r.uid || ''}","${r.ats}"`);
    }
    fs.writeFileSync(outputFile, csv2.join('\n'));
  }

  await page.close();

  console.log(`\n${atsKey}: ${allResults.size} total companies (${totalNewFound} new this run)`);
  console.log(`Saved to: ${outputFile}\n`);

  return allResults.size;
}

async function main() {
  // Ensure output dir exists
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADLESS ? 'new' : false,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800'],
  });

  const atsKeys = ATS_FILTER === 'all'
    ? ['paylocity', 'comeet', 'workday']
    : [ATS_FILTER];

  let grandTotal = 0;

  for (const atsKey of atsKeys) {
    const config = ATS_CONFIGS[atsKey];
    if (!config) {
      console.error(`Unknown ATS: ${atsKey}`);
      continue;
    }
    const count = await scrapeAts(browser, atsKey, config);
    grandTotal += count;
  }

  await browser.close();

  console.log(`\n=== COMPLETE ===`);
  console.log(`Total companies discovered: ${grandTotal}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
