// Teamtailor adapter — parses each company's public RSS feed at {slug}.teamtailor.com/jobs.rss.
// No auth, works direct. RSS is used over jobs.json because it carries MORE structured metadata:
// remoteStatus (work type) and tt:department, which the JSON feed's JSON-LD omits. Both feeds carry
// the FULL description, so teamtailor jobs need NO backfill.
//
// Field availability (what teamtailor actually publishes):
//   location    ✅ tt:city / tt:country          work type ✅ remoteStatus (none|hybrid|fully)
//   department  ✅ tt:department                  description ✅ full (CDATA)
//   employment_type ❌ not published              salary ❌ not published (only ~11% mention pay,
//                                                          as free text in the description — not parsed)
//
// NOTE: the feed caps at 100 jobs/company with no pagination; the rare tenant with >100 open roles
// is truncated to the 100 most recent.
const CAP_HINT = 100;

const stripCdata = (s) => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? stripCdata(m[1]) : null;
};

// remoteStatus -> our workplace_type vocabulary
function workplaceType(rs) {
  const v = String(rs || '').toLowerCase();
  if (v === 'fully') return 'remote';
  if (v === 'hybrid') return 'hybrid';
  if (v === 'none') return 'onsite';
  return null;
}

function locationOf(block) {
  const city = tag(block, 'tt:city');
  const country = tag(block, 'tt:country');
  const parts = [city, country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

async function fetchJobs(clientname) {
  const res = await fetch(`https://${encodeURIComponent(clientname)}.teamtailor.com/jobs.rss`, {
    headers: { accept: 'application/rss+xml, application/xml', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Teamtailor HTTP ${res.status}`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const jobs = items.map((block) => {
    const guid = tag(block, 'guid');
    return {
      external_id: `teamtailor_${guid}`,
      title: tag(block, 'title'),
      department: tag(block, 'tt:department') || null,
      location: locationOf(block),
      workplace_type: workplaceType(tag(block, 'remoteStatus')),
      employment_type: null,        // not published by teamtailor
      salary_min: null,             // not published
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: tag(block, 'description') || null, // full — no backfill needed
      url: tag(block, 'link'),
      posted_at: tag(block, 'pubDate') || null,
      raw_data: { guid },
    };
  }).filter((j) => j.url && j.external_id !== 'teamtailor_null');

  return { jobs, meta: { companyName: null, logoUrl: null, truncated: items.length >= CAP_HINT } };
}

module.exports = { fetchJobs };
