const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

// Copy the actual extraction logic to test
function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) {
        return ld.description;
      }
    } catch { /* invalid JSON-LD */ }
  }
  return null;
}

async function main() {
  await migrate();

  // SmartRecruiters - run actual fetcher logic
  console.log('=== SMARTRECRUITERS ===');
  let { rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 3`,
    ['smartrecruiters', '']
  );
  for (const row of rows) {
    const postingId = row.external_id.replace('smartrecruiters_', '');
    const res = await fetch(`https://api.smartrecruiters.com/v1/companies/${row.ats_slug}/postings/${postingId}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.log(`  ${row.ats_slug}/${postingId}: status ${res.status}`); continue; }
    const data = await res.json();
    if (!data?.jobAd?.sections) { console.log(`  ${row.ats_slug}/${postingId}: no sections`); continue; }
    const parts = [];
    for (const section of Object.values(data.jobAd.sections)) {
      if (section.text) parts.push(section.text);
    }
    const desc = parts.length > 0 ? parts.join('\n') : null;
    console.log(`  ${row.ats_slug}/${postingId}: ${desc ? 'GOT DESC ' + desc.length + ' chars' : 'NULL - sections exist but text empty'}`);
    if (!desc) {
      for (const [k, v] of Object.entries(data.jobAd.sections)) {
        console.log(`    ${k}: text=${v.text ? v.text.length : 'null'}`);
      }
    }
  }

  // Oracle - try alternative fields
  console.log('\n=== ORACLE ===');
  ({ rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 3`,
    ['oracle', '']
  ));
  for (const row of rows) {
    const p = row.ats_slug.split('.');
    if (p.length < 3) { console.log(`  ${row.ats_slug}: no site number`); continue; }
    const jobId = row.external_id.replace('oracle_', '');
    const url = `https://${p[0]}.fa.${p[1]}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${p.slice(2).join('.')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.log(`  ${row.ats_slug}/${jobId}: status ${res.status}`); continue; }
    const data = await res.json();
    const item = data.items?.[0];
    if (!item) { console.log(`  ${row.ats_slug}/${jobId}: no items`); continue; }
    const ext = item.ExternalDescriptionStr || '';
    const corp = item.CorporateDescriptionStr || '';
    const org = item.OrganizationDescriptionStr || '';
    const short = item.ShortDescriptionStr || '';
    const qual = item.ExternalQualificationsStr || '';
    const resp = item.ExternalResponsibilitiesStr || '';
    console.log(`  ${row.ats_slug}/${jobId}: ext=${ext.length} corp=${corp.length} org=${org.length} short=${short.length} qual=${qual.length} resp=${resp.length}`);
  }

  // JazzHR - check HTML for description
  console.log('\n=== JAZZHR ===');
  ({ rows } = await query(
    `SELECT j.url FROM jobs j WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 3`,
    ['jazzhr', '']
  ));
  for (const row of rows) {
    const res = await fetch(row.url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { console.log(`  ${row.url}: status ${res.status}`); continue; }
    const html = await res.text();
    const ld = extractJsonLdDescription(html);
    if (ld) { console.log(`  ${row.url}: JSON-LD desc ${ld.length} chars`); continue; }
    // Check what JSON-LD types exist
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    const types = [];
    while ((m = ldRegex.exec(html)) !== null) {
      try { types.push(JSON.parse(m[1])['@type']); } catch {}
    }
    console.log(`  JSON-LD types: ${types.join(', ') || 'none'}`);
    // Check for description div
    const descDiv = html.match(/class="[^"]*job[_-]?desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    console.log(`  Has job-desc div: ${!!descDiv}`);
    // Largest div approach
    const divs = html.match(/<div[^>]*>((?:(?!<div).)*?)<\/div>/gs) || [];
    let bestLen = 0;
    for (const d of divs) {
      const clean = d.replace(/<[^>]+>/g, '').trim();
      if (clean.length > bestLen) bestLen = clean.length;
    }
    console.log(`  Largest inner div: ${bestLen} chars`);
  }

  // Personio - check CDATA extraction
  console.log('\n=== PERSONIO ===');
  ({ rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 2`,
    ['personio', '']
  ));
  for (const row of rows) {
    const posId = row.external_id.replace('personio_', '');
    const res = await fetch(`https://${row.ats_slug}.jobs.personio.de/xml`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.log(`  ${row.ats_slug}: status ${res.status}`); continue; }
    const xml = await res.text();
    console.log(`  ${row.ats_slug} pos=${posId}: XML has ID: ${xml.includes(posId)}`);
    // Try to find the position block
    const posRegex = new RegExp(`<position>([\\s\\S]*?)</position>`, 'g');
    let posMatch;
    let found = false;
    while ((posMatch = posRegex.exec(xml)) !== null) {
      const block = posMatch[1];
      const idMatch = block.match(/<id>(\d+)<\/id>/);
      if (idMatch && idMatch[1] === posId) {
        found = true;
        console.log(`  Found position block for ${posId}`);
        // Try CDATA regex
        const descRegex = /<jobDescription>[\s\S]*?<name><!\[CDATA\[(.*?)\]\]><\/name>[\s\S]*?<value><!\[CDATA\[([\s\S]*?)\]\]><\/value>[\s\S]*?<\/jobDescription>/g;
        let descMatch;
        let descCount = 0;
        while ((descMatch = descRegex.exec(block)) !== null) {
          descCount++;
          console.log(`    Section: "${descMatch[1]}" value length: ${descMatch[2].length}`);
        }
        if (descCount === 0) {
          console.log(`  No CDATA descriptions found in block`);
          // Show a snippet of the block
          console.log(`  Block snippet: ${block.slice(0, 300)}`);
        }
      }
    }
    if (!found) console.log(`  Position ${posId} NOT FOUND in XML`);
  }

  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
