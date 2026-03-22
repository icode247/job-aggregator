const { migrate, closeDb } = require('../src/db');
const { query } = require('../src/db/connection');

function extractJsonLdDescription(html) {
  const ldRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      if (ld['@type'] === 'JobPosting' && ld.description) return ld.description;
    } catch {}
  }
  return null;
}

async function main() {
  await migrate();
  const { rows } = await query(
    `SELECT j.url FROM jobs j WHERE j.ats = $1 AND (j.description IS NULL OR j.description = $2) AND j.removed_at IS NULL AND j.url IS NOT NULL LIMIT 1`,
    ['jazzhr', '']
  );
  if (!rows.length) { console.log('No missing JazzHR jobs'); await closeDb(); return; }

  console.log('URL:', rows[0].url);
  const res = await fetch(rows[0].url, { signal: AbortSignal.timeout(10000) });
  const html = await res.text();

  const ld = extractJsonLdDescription(html);
  console.log('JSON-LD result:', ld ? 'found ' + ld.length + ' chars' : 'null');

  // Exact same regex from backfill code
  const divs = html.match(/<div[^>]*>((?:(?!<div).)*?)<\/div>/gs) || [];
  console.log('Matching divs:', divs.length);
  let best = null;
  let bestLen = 0;
  for (const div of divs) {
    const clean = div.replace(/<[^>]+>/g, '').trim();
    if (clean.length > bestLen && clean.length > 100) {
      bestLen = clean.length;
      best = div.replace(/^<div[^>]*>/, '').replace(/<\/div>$/, '').trim();
    }
  }
  console.log('Best div text length:', bestLen);
  if (best) console.log('Result preview:', best.slice(0, 300));
  else console.log('Result: null');

  // Try a broader approach — look for specific JazzHR job content class
  const jobContent = html.match(/<div[^>]*class="[^"]*job-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  console.log('Has .job-description:', !!jobContent);

  // Check for #description-body or similar
  const descBody = html.match(/<div[^>]*id="[^"]*desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  console.log('Has #desc... div:', !!descBody);

  // Look for the apply-container that holds the main description
  const applyBody = html.match(/class="ats-description"[^>]*>([\s\S]*?)<\/div>/i);
  console.log('Has .ats-description:', !!applyBody);
  if (applyBody) console.log('ats-description length:', applyBody[1].length);

  await closeDb();
}
main().catch(e => { console.error(e); process.exit(1); });
