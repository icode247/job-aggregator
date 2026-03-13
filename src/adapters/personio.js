async function fetchJobs(clientname) {
  const res = await fetch(`https://${encodeURIComponent(clientname)}.jobs.personio.de/xml`);
  if (!res.ok) throw new Error(`Personio HTTP ${res.status}`);
  const xml = await res.text();

  const jobs = [];
  const positionRegex = /<position>([\s\S]*?)<\/position>/g;
  let match;

  while ((match = positionRegex.exec(xml)) !== null) {
    const pos = match[1];
    const get = (tag) => {
      const m = pos.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
      return m ? m[1].trim() : null;
    };

    // Extract all CDATA job description sections and concatenate
    const descParts = [];
    const descRegex = /<jobDescription>[\s\S]*?<value>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/value>[\s\S]*?<\/jobDescription>/g;
    let descMatch;
    while ((descMatch = descRegex.exec(pos)) !== null) {
      descParts.push(descMatch[1].trim());
    }

    const id = get('id');
    const name = get('name');
    const department = get('department');
    const office = get('office');
    const employmentType = get('employmentType') || get('schedule');
    const createdAt = get('createdAt');
    const subcompany = get('subcompany');

    jobs.push({
      external_id: `personio_${id}`,
      title: name,
      department,
      location: office || 'Remote',
      workplace_type: null,
      employment_type: employmentType,
      salary_min: null,
      salary_max: null,
      salary_currency: null,
      salary_interval: null,
      description: descParts.length > 0 ? descParts.join('\n') : null,
      url: `https://${encodeURIComponent(clientname)}.jobs.personio.de/job/${id}`,
      posted_at: createdAt || null,
      raw_data: { xml: pos },
    });
  }

  return {
    jobs,
    meta: {
      companyName: null,
    },
  };
}

module.exports = { fetchJobs };
