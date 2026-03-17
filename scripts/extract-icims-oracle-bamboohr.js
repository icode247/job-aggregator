#!/usr/bin/env node
/**
 * Extract unique companies from iCIMS, Oracle Cloud & BambooHR JSON files.
 * Cross-reference against company-names.txt, add missing names, generate SQL.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = '/Users/codev/Downloads/icims-oraclecloud-bamboohr';
const ROOT = '/Users/codev/job-aggregator/.claude/worktrees/relaxed-ritchie';
const NAMES_FILE = path.join(ROOT, 'data/company-names.txt');
const SQL_FILE = path.join(ROOT, 'scripts/import-icims-oracle-bamboohr.sql');

// ── helpers ──────────────────────────────────────────────────────────────────

function extractBamboohr(job) {
  // url like https://dbgroup.bamboohr.com/careers/1249
  const url = job.url || '';
  const m = url.match(/^https?:\/\/([^.]+)\.bamboohr\.com\//);
  if (m === null) return null;
  const slug = m[1];
  return {
    ats: 'bamboohr',
    slug,
    domain: `${slug}.bamboohr.com`,
    career_url: `https://${slug}.bamboohr.com/careers`,
    company_name: (job.organization || slug).trim(),
  };
}

function extractIcims(job) {
  const url = job.url || '';
  const domain = job.source_domain || '';

  // Two patterns:
  // 1. Custom domain: https://careers.principal.com/careers-home/jobs/50300
  //    career_url = everything before /jobs/
  // 2. icims.com domain: https://careers-fdcorp.icims.com/jobs/8349/.../job
  //    slug = subdomain part, career_url = https://<subdomain>.icims.com/jobs/search

  if (domain.endsWith('.icims.com')) {
    const slug = domain.replace('.icims.com', '');
    return {
      ats: 'icims',
      slug,
      domain,
      career_url: `https://${domain}/jobs/search`,
      company_name: (job.organization || slug).trim(),
    };
  }

  // Custom domain – strip /jobs/... to get career_url base
  const jobsIdx = url.indexOf('/jobs/');
  if (jobsIdx === -1) return null;
  const base = url.substring(0, jobsIdx);
  // Also try /careers-home/jobs pattern
  const careersHomeIdx = url.indexOf('/careers-home/jobs/');
  const career_url = careersHomeIdx !== -1
    ? url.substring(0, careersHomeIdx + '/careers-home'.length)
    : base;

  return {
    ats: 'icims',
    slug: domain,
    domain,
    career_url,
    company_name: (job.organization || domain).trim(),
  };
}

function extractOracle(job) {
  const url = job.url || '';
  const domain = job.source_domain || '';

  // url like https://fa-exmi-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/105575
  // slug = subdomain prefix (e.g. fa-exmi-saasfaprod1)
  // career_url = everything up to /job/ (drop /job/XXXXX)
  const jobIdx = url.search(/\/job\/[^/]+\/?$/);
  if (jobIdx === -1) return null;
  const career_url = url.substring(0, jobIdx);

  const slugMatch = domain.match(/^([^.]+)\./);
  const slug = slugMatch ? slugMatch[1] : domain;

  return {
    ats: 'oraclecloud',
    slug,
    domain,
    career_url,
    company_name: (job.organization || slug).trim(),
  };
}

// ── main ─────────────────────────────────────────────────────────────────────

const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
console.log(`Found ${files.length} JSON files`);

// Map: career_url -> company info  (dedup by career_url)
const companies = new Map();
let totalJobs = 0;

for (const file of files) {
  const raw = fs.readFileSync(path.join(DATA_DIR, file), 'utf8');
  const jobs = JSON.parse(raw);
  totalJobs += jobs.length;

  for (const job of jobs) {
    const src = job.source || '';
    let info = null;
    if (src === 'bamboohr') info = extractBamboohr(job);
    else if (src === 'icims') info = extractIcims(job);
    else if (src === 'oraclecloud') info = extractOracle(job);

    if (info === null) continue;
    if (companies.has(info.career_url)) continue;
    companies.set(info.career_url, info);
  }
}

console.log(`Total jobs scanned: ${totalJobs}`);
console.log(`Unique companies found: ${companies.size}`);

// ── breakdown by ATS ────────────────────────────────────────────────────────

const byAts = {};
for (const c of companies.values()) {
  if (byAts[c.ats] === undefined) byAts[c.ats] = [];
  byAts[c.ats].push(c);
}

console.log('\n=== By ATS ===');
for (const [ats, list] of Object.entries(byAts).sort()) {
  console.log(`  ${ats}: ${list.length} companies`);
}

// ── cross-reference against company-names.txt ───────────────────────────────

const namesRaw = fs.readFileSync(NAMES_FILE, 'utf8');
const existingNames = new Set();
for (const line of namesRaw.split('\n')) {
  const trimmed = line.trim();
  if (trimmed.length === 0) continue;
  if (trimmed.startsWith('#')) continue;
  existingNames.add(trimmed.toLowerCase());
}

const newCompanies = [];
const existingCompanies = [];

for (const c of companies.values()) {
  if (existingNames.has(c.company_name.toLowerCase())) {
    existingCompanies.push(c);
  } else {
    newCompanies.push(c);
  }
}

console.log(`\n=== Cross-reference ===`);
console.log(`  Already in dictionary: ${existingCompanies.length}`);
console.log(`  New companies to add:  ${newCompanies.length}`);

// breakdown new by ATS
const newByAts = {};
for (const c of newCompanies) {
  if (newByAts[c.ats] === undefined) newByAts[c.ats] = 0;
  newByAts[c.ats]++;
}
console.log('\n  New by ATS:');
for (const [ats, count] of Object.entries(newByAts).sort()) {
  console.log(`    ${ats}: ${count}`);
}

// ── append new names to company-names.txt ───────────────────────────────────

const newNames = [...new Set(newCompanies.map(c => c.company_name))].sort();
if (newNames.length > 0) {
  const block = '\n\n# iCIMS, Oracle Cloud & BambooHR imports\n' + newNames.join('\n') + '\n';
  fs.appendFileSync(NAMES_FILE, block);
  console.log(`\nAppended ${newNames.length} names to company-names.txt`);
}

// ── generate SQL ────────────────────────────────────────────────────────────

function esc(s) {
  return s.replace(/'/g, "''");
}

const lines = [
  '-- Auto-generated import for iCIMS, Oracle Cloud & BambooHR companies',
  `-- Generated: ${new Date().toISOString()}`,
  '',
  'BEGIN;',
  '',
];

for (const ats of ['bamboohr', 'icims', 'oraclecloud']) {
  const list = (byAts[ats] || []).sort((a, b) => a.company_name.localeCompare(b.company_name));
  if (list.length === 0) continue;
  lines.push(`-- ${ats} companies (${list.length})`);
  for (const c of list) {
    lines.push(
      `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at) ` +
      `VALUES ('${esc(c.company_name)}', '${esc(c.domain)}', '${ats}', '${esc(c.slug)}', '${esc(c.career_url)}', 'active', 'csv_import', NOW(), NOW()) ` +
      `ON CONFLICT (career_url) DO NOTHING;`
    );
  }
  lines.push('');
}

lines.push('COMMIT;');
lines.push('');

fs.writeFileSync(SQL_FILE, lines.join('\n'));
console.log(`\nSQL written to ${SQL_FILE}`);
console.log(`Total INSERT statements: ${companies.size}`);
