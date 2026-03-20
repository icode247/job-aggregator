const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  const { rows } = await query(
    `SELECT j.id, j.external_id, c.ats_slug, j.url FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'icims' AND (j.description IS NULL OR j.description = '')
     AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 3`
  );

  for (const job of rows) {
    const jobId = job.external_id.replace('icims_', '');
    // iCIMS slug is like "careers-emcorgroup" -> domain is "careers-emcorgroup.icims.com"
    const slug = job.ats_slug;
    console.log('Job:', slug, 'ID:', jobId, 'URL:', job.url);

    // Try various iCIMS API patterns
    const urls = [
      // Gateway API
      `https://${slug}.icims.com/jobs/${jobId}/job?in_iframe=1`,
      // iCIMS public REST API pattern
      `https://${slug}.icims.com/jobs/${jobId}/description`,
      // JSON endpoint
      `https://${slug}.icims.com/jobs/${jobId}/job.json`,
      // Mobile API
      `https://${slug}.icims.com/api/jobs/${jobId}`,
      // Alternative gateway pattern
      `https://icims.com/api/v1/gateway/jobs/${slug}/${jobId}`,
    ];

    for (const url of urls) {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10000),
          headers: { 'Accept': 'application/json, text/html' }
        });
        const ct = res.headers.get('content-type') || '';
        console.log('  ', url.replace(`https://${slug}.icims.com`, ''), '=>', res.status, ct.substring(0, 40));
        if (res.ok && ct.includes('json')) {
          const data = await res.json();
          const keys = Object.keys(data).slice(0, 10);
          console.log('    Keys:', keys.join(', '));
          if (data.description) console.log('    DESC length:', data.description.length);
        } else if (res.ok && ct.includes('html')) {
          const html = await res.text();
          // Check for in_iframe content
          const hasDesc = html.includes('iCIMS_InfoMsg') || html.includes('position-description');
          const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
          console.log('    HTML length:', html.length, 'hasDesc:', hasDesc, 'hasLD:', !!ldMatch);
          if (ldMatch) {
            try {
              const ld = JSON.parse(ldMatch[1]);
              console.log('    LD type:', ld['@type'], 'desc length:', (ld.description || '').length);
            } catch {}
          }
          // Check for description-like content
          const descDiv = html.match(/<div[^>]*class="[^"]*(?:description|content|detail)[^"]*"[^>]*>([\s\S]{50,}?)<\/div>/i);
          if (descDiv) console.log('    Found desc div, length:', descDiv[1].length);
        }
      } catch (e) { console.log('  ', url.replace(`https://${slug}.icims.com`, ''), '=>', e.message); }
    }
    console.log();
  }

  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
