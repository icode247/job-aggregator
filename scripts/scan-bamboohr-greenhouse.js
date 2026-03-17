#!/usr/bin/env node
/**
 * Scan BambooHR datasets and Greenhouse CSV, cross-reference with company-names.txt,
 * add missing entries, and generate SQL for DB import.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DATA_DIR = '/Users/codev/Downloads/bamboohr-datasets';
const DICT_PATH = '/Users/codev/job-aggregator/.claude/worktrees/relaxed-ritchie/data/company-names.txt';
const SQL_PATH = '/Users/codev/job-aggregator/.claude/worktrees/relaxed-ritchie/scripts/import-bamboohr-greenhouse.sql';

// BambooHR: slug -> best company name
const bamboohrMap = new Map();
// Greenhouse: slug -> company name (from CSV col 1)
const greenhouseMap = new Map();
// Workable: slug -> company name (from job_leads CSV)
const workableMap = new Map();

function extractBamboohrSlug(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/([a-z0-9._-]+)\.bamboohr\.com/i);
  return m ? m[1].toLowerCase() : null;
}

async function processJsonFile(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';
    let depth = 0;
    let inString = false;
    let escape = false;
    let objectStart = -1;
    let count = 0;

    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const ch = chunk[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;

        if (ch === '{') {
          if (depth === 0) {
            objectStart = buffer.length + i;
          }
          depth++;
        } else if (ch === '}') {
          depth--;
          if (depth === 0) {
            // Extract the object substring
            const objStr = (buffer + chunk).substring(objectStart, buffer.length + i + 1);
            try {
              const obj = JSON.parse(objStr);
              processRecord(obj);
              count++;
            } catch (_e) {
              // skip malformed
            }
            objectStart = -1;
          }
        }
      }
      // Keep buffer minimal - only keep from objectStart if we're inside an object
      if (depth > 0 && objectStart >= 0) {
        buffer = (buffer + chunk).substring(objectStart);
        objectStart = 0;
      } else {
        buffer = '';
        objectStart = -1;
      }
    });

    stream.on('end', () => {
      console.log(`  Processed ${count} records from ${path.basename(filePath)}`);
      resolve();
    });
    stream.on('error', reject);
  });
}

function processRecord(obj) {
  const url = obj.listing_url || obj.url || obj.apply_url || '';
  const slug = extractBamboohrSlug(url);
  if (slug) {
    const name = obj['company.name'] || obj.organization || slug;
    // Prefer longer/more descriptive names
    if (!bamboohrMap.has(slug) || (name.length > bamboohrMap.get(slug).length && name !== slug)) {
      bamboohrMap.set(slug, name);
    }
  }
}

async function processGreenhouseCsv() {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA_DIR, 'greenhouse_companies.csv'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    // CSV format: "slug","job title","industry"
    const parts = line.split(',');
    let slug = parts[0].replace(/^"/, '').replace(/"$/, '').trim();
    if (slug && slug !== '...') {
      greenhouseMap.set(slug.toLowerCase(), slug);
    }
  }
  console.log(`  Found ${greenhouseMap.size} unique Greenhouse slugs`);
}

async function processJobLeadsCsv() {
  const rl = readline.createInterface({
    input: fs.createReadStream(path.join(DATA_DIR, 'job_leads_5111_records.csv'), { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    // CSV: platform,job_title,company,job_listing_title,url
    const parts = line.split(',');
    let company = parts[2] ? parts[2].replace(/^"/, '').replace(/"$/, '').trim() : '';
    let url = parts[4] ? parts[4].replace(/^"/, '').replace(/"$/, '').trim() : '';
    if (company && url.includes('workable.com')) {
      // Extract workable slug from URL: https://apply.workable.com/SLUG/j/...
      const m = url.match(/workable\.com\/([a-z0-9._-]+)\//i);
      if (m) {
        const slug = m[1].toLowerCase();
        // Get display name from job_listing_title (after last " - ")
        const title = parts[3] ? parts[3].replace(/^"/, '').replace(/"$/, '').trim() : '';
        const dashIdx = title.lastIndexOf(' - ');
        const displayName = dashIdx > 0 ? title.substring(dashIdx + 3) : company;
        if (!workableMap.has(slug) || (displayName.length > workableMap.get(slug).length)) {
          workableMap.set(slug, displayName);
        }
      }
    }
  }
  console.log(`  Found ${workableMap.size} unique Workable slugs from job leads`);
}

function loadDictionary() {
  const content = fs.readFileSync(DICT_PATH, 'utf8');
  const names = new Set();
  const slugs = new Set();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    names.add(trimmed.toLowerCase());
    // Also add a slug-ified version for matching
    slugs.add(trimmed.toLowerCase().replace(/[^a-z0-9]/g, ''));
  }
  return { names, slugs, content };
}

function escSql(s) {
  return s.replace(/'/g, "''");
}

function slugToName(slug) {
  // Convert slug to title case as fallback
  return slug.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

async function main() {
  console.log('=== Scanning BambooHR JSON datasets ===');
  const jsonFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('dataset_') && f.endsWith('.json'));
  console.log(`Found ${jsonFiles.length} JSON files`);

  for (const file of jsonFiles) {
    await processJsonFile(path.join(DATA_DIR, file));
  }
  console.log(`\nTotal unique BambooHR subdomains: ${bamboohrMap.size}`);

  console.log('\n=== Scanning Greenhouse CSV ===');
  await processGreenhouseCsv();

  console.log('\n=== Scanning Job Leads CSV ===');
  await processJobLeadsCsv();

  console.log('\n=== Cross-referencing with dictionary ===');
  const { names, slugs, content: dictContent } = loadDictionary();

  // Check BambooHR
  let bamboohrExisting = 0;
  let bamboohrNew = 0;
  const newBamboohr = [];
  for (const [slug, name] of bamboohrMap) {
    const nameLC = name.toLowerCase();
    const slugClean = slug.replace(/[^a-z0-9]/g, '');
    if (names.has(nameLC) || slugs.has(slugClean) || slugs.has(nameLC.replace(/[^a-z0-9]/g, ''))) {
      bamboohrExisting++;
    } else {
      bamboohrNew++;
      newBamboohr.push({ slug, name });
    }
  }

  // Check Greenhouse
  let ghExisting = 0;
  let ghNew = 0;
  const newGreenhouse = [];
  for (const [slugLC, slug] of greenhouseMap) {
    const slugClean = slugLC.replace(/[^a-z0-9]/g, '');
    if (slugs.has(slugClean) || names.has(slugLC)) {
      ghExisting++;
    } else {
      ghNew++;
      newGreenhouse.push(slug);
    }
  }

  // Check Workable
  let wkExisting = 0;
  let wkNew = 0;
  const newWorkable = [];
  for (const [slug, name] of workableMap) {
    const nameLC = name.toLowerCase();
    const slugClean = slug.replace(/[^a-z0-9]/g, '');
    if (names.has(nameLC) || slugs.has(slugClean) || slugs.has(nameLC.replace(/[^a-z0-9]/g, ''))) {
      wkExisting++;
    } else {
      wkNew++;
      newWorkable.push({ slug, name });
    }
  }

  console.log(`\nBambooHR:   ${bamboohrMap.size} total, ${bamboohrExisting} existing, ${bamboohrNew} NEW`);
  console.log(`Greenhouse: ${greenhouseMap.size} total, ${ghExisting} existing, ${ghNew} NEW`);
  console.log(`Workable:   ${workableMap.size} total, ${wkExisting} existing, ${wkNew} NEW`);
  console.log(`\nGrand total NEW companies: ${bamboohrNew + ghNew + wkNew}`);

  // Add to dictionary
  console.log('\n=== Updating dictionary ===');
  let additions = '\n\n# BambooHR imports\n';
  for (const { slug, name } of newBamboohr.sort((a, b) => a.name.localeCompare(b.name))) {
    additions += `${name}\n`;
  }
  additions += '\n# Greenhouse imports\n';
  for (const slug of newGreenhouse.sort()) {
    const name = slugToName(slug);
    additions += `${name}\n`;
  }
  additions += '\n# Workable imports (from job leads)\n';
  for (const { slug, name } of newWorkable.sort((a, b) => a.name.localeCompare(b.name))) {
    additions += `${name}\n`;
  }

  fs.appendFileSync(DICT_PATH, additions);
  console.log(`Added ${bamboohrNew + ghNew + wkNew} new entries to company-names.txt`);

  // Generate SQL
  console.log('\n=== Generating SQL ===');
  let sql = '-- Auto-generated import for BambooHR, Greenhouse, and Workable companies\n';
  sql += '-- Generated: ' + new Date().toISOString() + '\n\n';
  sql += 'BEGIN;\n\n';
  sql += '-- BambooHR companies\n';
  for (const [slug, name] of bamboohrMap) {
    const domain = `${slug}.bamboohr.com`;
    sql += `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at) VALUES ('${escSql(name)}', '${escSql(domain)}', 'bamboohr', '${escSql(slug)}', 'https://${escSql(slug)}.bamboohr.com/careers', 'active', 'csv_import', NOW(), NOW()) ON CONFLICT (career_url) DO NOTHING;\n`;
  }

  sql += '\n-- Greenhouse companies\n';
  for (const [slugLC, slug] of greenhouseMap) {
    const name = slugToName(slug);
    sql += `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at) VALUES ('${escSql(name)}', 'boards.greenhouse.io', 'greenhouse', '${escSql(slug)}', 'https://boards.greenhouse.io/${escSql(slug)}', 'active', 'csv_import', NOW(), NOW()) ON CONFLICT (career_url) DO NOTHING;\n`;
  }

  sql += '\n-- Workable companies\n';
  for (const [slug, name] of workableMap) {
    sql += `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at) VALUES ('${escSql(name)}', 'apply.workable.com', 'workable', '${escSql(slug)}', 'https://apply.workable.com/${escSql(slug)}', 'active', 'csv_import', NOW(), NOW()) ON CONFLICT (career_url) DO NOTHING;\n`;
  }

  sql += '\nCOMMIT;\n';

  fs.writeFileSync(SQL_PATH, sql);
  console.log(`SQL written to ${SQL_PATH}`);
  console.log(`Total SQL INSERT statements: ${bamboohrMap.size + greenhouseMap.size + workableMap.size}`);
}

main().catch(err => { console.error(err); process.exit(1); });
