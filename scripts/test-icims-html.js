const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

async function main() {
  await migrate();

  const { rows } = await query(
    `SELECT j.id, j.external_id, c.ats_slug, j.url FROM jobs j JOIN companies c ON j.company_id = c.id
     WHERE j.ats = 'icims' AND (j.description IS NULL OR j.description = '')
     AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 2`
  );

  for (const job of rows) {
    console.log('URL:', job.url);
    try {
      const res = await fetch(job.url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { console.log('Status:', res.status); continue; }
      const html = await res.text();
      console.log('HTML length:', html.length);

      // Look for description patterns
      // Check for iCIMS-specific class names
      const patterns = [
        { name: 'iCIMS_MainWrapper', regex: /class="iCIMS_MainWrapper"/ },
        { name: 'iCIMS_JobContent', regex: /class="iCIMS_JobContent"/ },
        { name: 'iCIMS_InfoMsg_Job', regex: /class="iCIMS_InfoMsg_Job"/ },
        { name: 'overview-top', regex: /class="[^"]*overview-top/ },
        { name: 'job-description', regex: /class="[^"]*job-description/ },
        { name: 'data-automation', regex: /data-automation[^>]*>/ },
        { name: 'additionalFields', regex: /additionalFields/ },
        { name: 'textblock', regex: /textblock/ },
      ];
      for (const p of patterns) {
        console.log('  ' + p.name + ':', p.regex.test(html));
      }

      // Extract a chunk around "description" or "overview"
      const descIdx = html.indexOf('iCIMS_InfoMsg_Job');
      if (descIdx > -1) {
        console.log('  iCIMS_InfoMsg_Job snippet:', html.substring(descIdx, descIdx + 500).replace(/<[^>]+>/g, ' ').trim().substring(0, 300));
      }

      // Try to find any large text blocks
      const divs = html.match(/<div[^>]*class="[^"]*"[^>]*>[\s\S]{200,}<\/div>/g);
      console.log('  Large divs found:', divs ? divs.length : 0);

      // Check for meta description
      const metaDesc = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
      if (metaDesc) console.log('  meta description:', metaDesc[1].substring(0, 200));

    } catch (e) { console.log('Error:', e.message); }
    console.log();
  }

  await closeDb();
}

main().catch(err => { console.error(err); process.exit(1); });
