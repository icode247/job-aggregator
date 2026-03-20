const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  // Test SmartRecruiters
  const { rows: sr } = await query(
    `SELECT j.id, j.external_id, c.ats_slug FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'smartrecruiters' AND (j.description IS NULL OR j.description = '')
     AND j.removed_at IS NULL LIMIT 3`
  );
  console.log('=== SmartRecruiters ===');
  console.log('Missing desc samples:', sr.length);
  for (const job of sr) {
    const postingId = job.external_id.replace('smartrecruiters_', '');
    const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(job.ats_slug)}/postings/${postingId}`;
    console.log('  Fetching:', url);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      console.log('  Status:', res.status);
      if (res.ok) {
        const data = await res.json();
        const hasSections = !!(data.jobAd && data.jobAd.sections);
        console.log('  Has sections:', hasSections);
      } else {
        const text = await res.text();
        console.log('  Body:', text.substring(0, 200));
      }
    } catch (e) { console.log('  Error:', e.message); }
  }

  // Test iCIMS
  const { rows: ic } = await query(
    `SELECT j.id, j.external_id, c.ats_slug, j.url FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'icims' AND (j.description IS NULL OR j.description = '')
     AND j.removed_at IS NULL LIMIT 5`
  );
  console.log('\n=== iCIMS ===');
  console.log('Missing desc samples:', ic.length);
  for (const job of ic) {
    const jobId = job.external_id.replace('icims_', '');
    console.log('  Slug:', job.ats_slug, 'JobId:', jobId);
    console.log('  Job URL:', job.url);

    // Try the API URLs
    const urls = [
      `https://careers.${job.ats_slug}.com/api/jobs/${jobId}`,
      `https://jobs.${job.ats_slug}.com/api/jobs/${jobId}`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        console.log('  ', url, '=>', res.status);
        if (res.ok) {
          const data = await res.json();
          const hasDesc = !!(data.description || data.data?.description);
          console.log('    Has description:', hasDesc);
        }
      } catch (e) { console.log('  ', url, '=>', e.message); }
    }

    // Try fetching the actual job URL for HTML/JSON-LD
    if (job.url) {
      try {
        const res = await fetch(job.url, { signal: AbortSignal.timeout(10000) });
        console.log('  Job URL status:', res.status);
        if (res.ok) {
          const html = await res.text();
          // Check for JSON-LD
          const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
          if (ldMatch) {
            try {
              const ld = JSON.parse(ldMatch[1]);
              console.log('    JSON-LD type:', ld['@type'], 'has desc:', !!(ld.description));
            } catch { console.log('    JSON-LD parse failed'); }
          } else {
            console.log('    No JSON-LD found');
          }
          // Check for og:description
          const ogMatch = html.match(/property="og:description"[^>]*content="([^"]*)"/i);
          console.log('    og:description length:', ogMatch ? ogMatch[1].length : 0);
        }
      } catch (e) { console.log('  Job URL error:', e.message); }
    }
    console.log();
  }

  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
