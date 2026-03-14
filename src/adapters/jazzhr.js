async function fetchJobs(clientname) {
  const res = await fetch(
    `https://app.jazz.co/widgets/basic/create/${encodeURIComponent(clientname)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  if (!res.ok) throw new Error(`JazzHR HTTP ${res.status}`);
  const html = await res.text();

  const jobs = [];
  const seen = new Set();

  // Structure: <div class="resumator-job">
  //   <div class="resumator-job-title">Title</div>
  //   <div class="resumator-job-info"><span>Location: </span>City, Country</div>
  //   <div ...><a href="https://{slug}.applytojob.com/apply/{jobId}/{title}">...</a></div>
  // </div>
  const blockRegex = /class="resumator-job-title[^"]*"[^>]*>([^<]+)<\/div>[\s\S]*?class="resumator-job-info[^"]*"[^>]*>[\s\S]*?Location:\s*<\/span>([^<]*)<\/div>[\s\S]*?href="(https:\/\/[^"]*\.applytojob\.com\/apply\/([^/]+)\/[^"]*)"[^>]*>/gi;

  let match;
  while ((match = blockRegex.exec(html)) !== null) {
    const [, title, location, url, jobId] = match;
    if (seen.has(jobId)) continue;
    seen.add(jobId);

    const loc = location?.trim() || null;
    jobs.push({
      external_id: `jazzhr_${jobId}`,
      title: title.trim(),
      department: null,
      location: loc,
      workplace_type: loc?.toLowerCase().includes('remote') ? 'remote' : null,
      employment_type: null,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: null,
      url,
      posted_at: null,
      raw_data: { jobId, title: title.trim(), location: loc },
    });
  }

  // Fallback: just extract job links if structured regex didn't match
  if (jobs.length === 0) {
    const linkRegex = /href="(https:\/\/[^"]*\.applytojob\.com\/apply\/([^/]+)\/([^"?]+)[^"]*)"/g;
    while ((match = linkRegex.exec(html)) !== null) {
      const [, url, jobId, titleSlug] = match;
      if (seen.has(jobId)) continue;
      seen.add(jobId);

      jobs.push({
        external_id: `jazzhr_${jobId}`,
        title: decodeURIComponent(titleSlug).replace(/-/g, ' '),
        department: null,
        location: null,
        workplace_type: null,
        employment_type: null,
        salary_min: null,
        salary_max: null,
        salary_currency: null,
        salary_interval: null,
        description: null,
        url,
        posted_at: null,
        raw_data: { jobId },
      });
    }
  }

  return { jobs, meta: {} };
}

module.exports = { fetchJobs };
