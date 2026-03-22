const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  // SmartRecruiters
  console.log('=== SMARTRECRUITERS ===');
  let { rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 1`,
    ['smartrecruiters', '']
  );
  if (rows.length) {
    const postingId = rows[0].external_id.replace('smartrecruiters_', '');
    const url = `https://api.smartrecruiters.com/v1/companies/${rows[0].ats_slug}/postings/${postingId}`;
    console.log('URL:', url);
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    console.log('Top keys:', Object.keys(data));
    console.log('Has jobAd:', !!data.jobAd);
    if (data.jobAd) {
      console.log('jobAd keys:', Object.keys(data.jobAd));
      console.log('Has sections:', !!data.jobAd.sections);
      if (data.jobAd.sections) {
        console.log('Section keys:', Object.keys(data.jobAd.sections));
        for (const [k, v] of Object.entries(data.jobAd.sections)) {
          console.log(`  section "${k}":`, typeof v, v && typeof v === 'object' ? Object.keys(v) : '');
          if (v && v.text) console.log(`    text length: ${v.text.length}`);
        }
      }
    }
    // look for description anywhere
    if (data.customField) console.log('customField:', JSON.stringify(data.customField).slice(0, 200));
    if (data.jobDescription) console.log('jobDescription exists, len:', data.jobDescription.length);
  }

  // Oracle
  console.log('\n=== ORACLE ===');
  ({ rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 1`,
    ['oracle', '']
  ));
  if (rows.length) {
    const p = rows[0].ats_slug.split('.');
    const jobId = rows[0].external_id.replace('oracle_', '');
    if (p.length >= 3) {
      const url = `https://${p[0]}.fa.${p[1]}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?onlyData=true&expand=all&finder=ById;Id=${jobId},siteNumber=${p.slice(2).join('.')}`;
      console.log('URL:', url.slice(0, 140));
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      const item = data.items?.[0];
      if (item) {
        console.log('ExternalDescriptionStr:', (item.ExternalDescriptionStr || '').length, 'chars');
        console.log('ExternalQualificationsStr:', (item.ExternalQualificationsStr || '').length, 'chars');
        console.log('ExternalResponsibilitiesStr:', (item.ExternalResponsibilitiesStr || '').length, 'chars');
        if (!item.ExternalDescriptionStr && !item.ExternalQualificationsStr && !item.ExternalResponsibilitiesStr) {
          // Check what keys exist
          const descKeys = Object.keys(item).filter(k => k.includes('escription') || k.includes('ontent') || k.includes('ummary'));
          console.log('Possible desc keys:', descKeys);
          console.log('All keys:', Object.keys(item).join(', '));
        }
      } else {
        console.log('No items');
      }
    }
  }

  // JazzHR
  console.log('\n=== JAZZHR ===');
  ({ rows } = await query(
    `SELECT j.url FROM jobs j WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 1`,
    ['jazzhr', '']
  ));
  if (rows.length) {
    console.log('URL:', rows[0].url);
    const res = await fetch(rows[0].url, { signal: AbortSignal.timeout(10000) });
    console.log('Status:', res.status);
    const html = await res.text();
    // Check JSON-LD
    const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(html)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        console.log('JSON-LD type:', ld['@type'], 'has desc:', !!(ld.description));
        if (ld.description) console.log('Desc length:', ld.description.length);
      } catch (e) { console.log('JSON-LD parse error'); }
    }
    if (!html.includes('application/ld+json')) {
      console.log('No JSON-LD found');
      // Check for large content divs
      const divs = html.match(/<div[^>]*class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/div>/gi);
      console.log('Description divs found:', divs ? divs.length : 0);
    }
  }

  // Taleo
  console.log('\n=== TALEO ===');
  ({ rows } = await query(
    `SELECT j.url FROM jobs j WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 1`,
    ['taleo', '']
  ));
  if (rows.length) {
    console.log('URL:', rows[0].url);
    const res = await fetch(rows[0].url, { signal: AbortSignal.timeout(15000) });
    console.log('Status:', res.status);
    const html = await res.text();
    console.log('HTML length:', html.length);
    console.log('Has JSON-LD:', html.includes('application/ld+json'));
    console.log('Has pipe sep:', html.includes('!|!'));
    console.log('Has star sep:', html.includes('!*!'));
    // Taleo often serves JS-only pages
    if (html.length < 500) console.log('HTML too short - probably JS redirect');
  }

  // Personio
  console.log('\n=== PERSONIO ===');
  ({ rows } = await query(
    `SELECT j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL LIMIT 1`,
    ['personio', '']
  ));
  if (rows.length) {
    const slug = rows[0].ats_slug;
    const posId = rows[0].external_id.replace('personio_', '');
    console.log('Slug:', slug, 'Position ID:', posId);
    const url = `https://${slug}.jobs.personio.de/xml`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    console.log('Status:', res.status);
    const xml = await res.text();
    console.log('XML length:', xml.length);
    // Check if position ID exists in the XML
    console.log('Contains position ID:', xml.includes(posId));
    const idMatches = xml.match(/<id>(\d+)<\/id>/g);
    console.log('Position IDs in XML:', idMatches ? idMatches.slice(0, 5).join(', ') : 'none');
  }

  // Zoho
  console.log('\n=== ZOHO ===');
  ({ rows } = await query(
    `SELECT j.url FROM jobs j WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 1`,
    ['zoho', '']
  ));
  if (rows.length) {
    console.log('URL:', rows[0].url);
    const res = await fetch(rows[0].url, { signal: AbortSignal.timeout(15000) });
    console.log('Status:', res.status);
    const html = await res.text();
    console.log('HTML length:', html.length);
    const match = html.match(/var\s+jobs\s*=\s*JSON\.parse\('(.+?)'\)/);
    console.log('Has jobs JSON.parse:', !!match);
    if (!match) {
      // Look for other patterns
      const altMatch = html.match(/var\s+jobs\s*=/);
      console.log('Has var jobs:', !!altMatch);
      // Look for description in meta or LD
      console.log('Has JSON-LD:', html.includes('application/ld+json'));
    }
  }

  await closeDb();
}

main().catch(e => { console.error(e); process.exit(1); });
