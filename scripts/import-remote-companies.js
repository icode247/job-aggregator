const fs = require('fs');

const files = [
  '/Users/codev/Downloads/flexjobs_companies.csv',
  '/Users/codev/Downloads/flexjobs_work_anywhere_all_jobs.csv',
  '/Users/codev/Downloads/top_100_remote_companies.csv',
  '/Users/codev/Downloads/wwr_trending_companies.csv',
  '/Users/codev/Downloads/remoteok_companies.csv',
  '/Users/codev/Downloads/remoteok_new_companies_full.csv',
  '/Users/codev/Downloads/remoteok_new_companies.csv',
];

const allCompanies = new Set();

for (const f of files) {
  if (!fs.existsSync(f)) { console.log('SKIP:', f); continue; }
  const lines = fs.readFileSync(f, 'utf8').split('\n').slice(1);
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let name = null;

    // Try: #,"Company Name"
    const m = line.match(/^\d+,"([^"]+)"/);
    if (m) { name = m[1].trim(); }

    // Try: #,Company (no quotes)
    if (!name) {
      const m2 = line.match(/^\d+,([^,]+)/);
      if (m2) name = m2[1].trim().replace(/^"|"$/g, '');
    }

    // For flexjobs_work_anywhere: #,"Job Title","Company","Date"
    if (!name || name.length < 2) {
      const m3 = line.match(/^\d+,"[^"]*","([^"]+)"/);
      if (m3) name = m3[1].trim();
    }

    if (name && name.length > 1) { allCompanies.add(name); count++; }
  }
  console.log(f.split('/').pop() + ': ' + count + ' entries');
}

console.log('\nTotal unique companies across all files:', allCompanies.size);

// Check against dictionary
const dictPath = 'data/company-names.txt';
const dict = fs.readFileSync(dictPath, 'utf8').split('\n').filter(l => l.trim() && l[0] !== '#').map(l => l.trim());
const dictLower = new Set(dict.map(n => n.toLowerCase()));
console.log('Current dictionary size:', dictLower.size);

const missing = [];
for (const c of allCompanies) {
  if (!dictLower.has(c.toLowerCase())) missing.push(c);
}

console.log('Already in dictionary:', allCompanies.size - missing.length);
console.log('NEW to add:', missing.length);

// Add missing to dictionary
if (missing.length > 0) {
  const block = '\n# Remote-first companies (FlexJobs, RemoteOK full, WWR trending, Top 100)\n' + missing.sort().join('\n') + '\n';
  fs.appendFileSync(dictPath, block);
  console.log('Added ' + missing.length + ' new companies to dictionary');
} else {
  console.log('All companies already in dictionary!');
}
