#!/usr/bin/env node
/**
 * Import companies from FlexJobs CSV exports into the database.
 * Usage: node scripts/import-flexjobs-csv.js <csv1> [csv2] ...
 */

const fs = require('fs');
const { query, closeDb } = require('../src/db/connection');

function parseCSV(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').slice(1);
  const companies = new Set();
  for (const line of lines) {
    const parts = [];
    let current = '', inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; }
      else if (ch === ',' && !inQuotes) { parts.push(current.trim()); current = ''; }
      else { current += ch; }
    }
    parts.push(current.trim());
    if (parts[2]) companies.add(parts[2]);
  }
  return companies;
}

function companyToDomain(name) {
  // Strip suffixes like "- KDP", ", Inc.", "- SMBC" etc
  let clean = name
    .replace(/\s*-\s*[A-Z]{2,}.*$/, '')   // "Keurig Dr Pepper - KDP" -> "Keurig Dr Pepper"
    .replace(/,?\s*(Inc\.|LLC|Ltd|Corp|Co\.).*$/i, '')
    .replace(/\s*\(.*\)/, '')
    .trim();

  // Known domain overrides
  const overrides = {
    'Amazon': 'amazon.com',
    'Walmart': 'walmart.com',
    'Salesforce': 'salesforce.com',
    'PayPal': 'paypal.com',
    'Honeywell': 'honeywell.com',
    'JPMorgan Chase': 'jpmorganchase.com',
    'Johnson & Johnson': 'jnj.com',
    'Siemens': 'siemens.com',
    'Novartis': 'novartis.com',
    'UBS': 'ubs.com',
    'Abbott': 'abbott.com',
    'AbbVie': 'abbvie.com',
    'Leidos': 'leidos.com',
    'Lenovo': 'lenovo.com',
    'Eaton': 'eaton.com',
    'Nordstrom': 'nordstrom.com',
    'General Dynamics': 'gd.com',
    'Lockheed Martin': 'lockheedmartin.com',
    'BAE Systems': 'baesystems.com',
    'Charles Schwab Corporation': 'schwab.com',
    'Smith & Nephew': 'smith-nephew.com',
    'Sodexo': 'sodexo.com',
    'Stantec': 'stantec.com',
    'American Heart Association': 'heart.org',
    'Ahold Delhaize USA': 'aholddelhaize.com',
    'Commonwealth Bank of Australia': 'commbank.com.au',
    'Kmart Australia': 'kmart.com.au',
    'ANZ - Australia and New Zealand Banking Group Limited': 'anz.com.au',
    'ICF': 'icf.com',
    'CDK Global': 'cdkglobal.com',
    'Elevance Health': 'elevancehealth.com',
    'Apex Systems': 'apexsystems.com',
    'Creative Circle': 'creativecircle.com',
    'JD Power': 'jdpower.com',
    'JLL - Jones Lang LaSalle': 'jll.com',
    'Syneos Health': 'syneoshealth.com',
    'SAIC - Science Applications International Corporation': 'saic.com',
    'Mitsubishi UFJ Financial Group - MUFG': 'mufg.jp',
    'Huntington National Bank': 'huntington.com',
    'Keurig Dr Pepper - KDP': 'keurigdrpepper.com',
    'CSC - Corporation Service Company': 'cscglobal.com',
    'Sumitomo Mitsui Banking - SMBC': 'smbcgroup.com',
    'State of Colorado': 'colorado.gov',
    'Cobb County, Georgia': 'cobbcounty.org',
    'PeaceHealth': 'peacehealth.org',
    'CRS': 'crs.org',
    'Olympus Corporation of the Americas': 'olympusamerica.com',
    'Helen of Troy': 'helenoftroy.com',
    'Travel + Leisure Co.': 'travelandleisureco.com',
    'National Carwash Solutions - NCS': 'ncswash.com',
    'Edgewell Personal Care': 'edgewell.com',
    'Bel Group': 'groupe-bel.com',
    'Insight Global': 'insightglobal.com',
    'Epiq Global': 'epiqglobal.com',
    'XYPN - XY Planning Network': 'xyplanningnetwork.com',
    'Husch Blackwell LLP': 'huschblackwell.com',
    'Rewards Network Inc.': 'rewardsnetwork.com',
    'FLO EV Charging': 'flo.com',
    'Docplanner Group': 'docplanner.com',
    'SGS & Co': 'sgsco.com',
    'North Payments': 'northpayments.com',
    'APSI Construction Management': 'aboretumgrp.com',
    'ElevenLabs': 'elevenlabs.io',
  };

  if (overrides[name]) return overrides[name];

  // Guess: lowercase, remove special chars, join with nothing
  return clean.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
}

async function main() {
  const csvFiles = process.argv.slice(2);
  if (csvFiles.length === 0) {
    console.error('Usage: node scripts/import-flexjobs-csv.js <csv1> [csv2] ...');
    process.exit(1);
  }

  const allCompanies = new Set();
  for (const f of csvFiles) {
    const companies = parseCSV(f);
    for (const c of companies) allCompanies.add(c);
  }

  console.log(`Found ${allCompanies.size} unique companies`);

  let added = 0, skipped = 0;
  for (const name of [...allCompanies].sort()) {
    const domain = companyToDomain(name);
    const careerUrl = `https://${domain}/careers`;

    try {
      const { rowCount } = await query(
        `INSERT INTO companies (career_url, domain, company_name, origin, created_at, updated_at)
         VALUES (?, ?, ?, 'flexjobs', datetime('now'), datetime('now'))
         ON CONFLICT(career_url) DO NOTHING`,
        [careerUrl, domain, name]
      );
      if (rowCount > 0) {
        console.log(`  + ${name} (${domain})`);
        added++;
      } else {
        console.log(`  - ${name} (${domain}) already exists`);
        skipped++;
      }
    } catch (err) {
      console.error(`  ! ${name}: ${err.message}`);
    }
  }

  console.log(`\nDone: ${added} added, ${skipped} skipped`);
  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
