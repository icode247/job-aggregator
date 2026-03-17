const fs = require("fs");

const companies = new Map();

function addAshby(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^"([^"]*)","([^"]*)"/);
    if (!m) continue;
    const name = m[1].trim();
    const url = m[2].trim();
    const slugMatch = url.match(/jobs\.ashbyhq\.com\/(.+)/);
    if (!name || !slugMatch) continue;
    const slug = slugMatch[1].split("/")[0];
    const careerUrl = `https://jobs.ashbyhq.com/${slug}`;
    if (!companies.has(careerUrl)) {
      companies.set(careerUrl, { name, ats: "ashby", slug, careerUrl });
    }
  }
}

function addTaleo(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^\d+,"([^"]*)","([^"]*)","([^"]*)"/);
    if (!m) continue;
    const subdomain = m[2].trim();
    const url = m[3].trim();
    const careerUrl = `https://${subdomain}.taleo.net`;
    if (!companies.has(careerUrl)) {
      companies.set(careerUrl, { name: subdomain, ats: "taleo", slug: subdomain, careerUrl });
    }
  }
}

function addZoho(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, "utf8").split("\n").slice(1);
  for (const line of lines) {
    if (line.trim() === "") continue;
    const m = line.match(/^\d+,"([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (!m) continue;
    const name = m[1].trim();
    const subdomain = m[3].trim();
    const careerUrl = `https://${subdomain}.zohorecruit.com`;
    if (!companies.has(careerUrl)) {
      companies.set(careerUrl, { name, ats: "zoho", slug: subdomain, careerUrl });
    }
  }
}

addAshby("/Users/codev/Downloads/ashby_companies.csv");
addAshby("/Users/codev/Downloads/ashby_jobs_comprehensive_final.csv");
addAshby("/Users/codev/Downloads/ashby_jobs_new_entries.csv");
addAshby("/Users/codev/Downloads/software_engineer_jobs_complete.csv");
addAshby("/Users/codev/Downloads/software_engineer_jobs.csv");
addTaleo("/Users/codev/Downloads/taleo_companies.csv");
addZoho("/Users/codev/Downloads/zohorecruit_companies.csv");
addZoho("/Users/codev/Downloads/zohorecruit_companies (1).csv");
addZoho("/Users/codev/Downloads/zohorecruit_companies (2).csv");

const byAts = {};
for (const [, c] of companies) {
  byAts[c.ats] = (byAts[c.ats] || 0) + 1;
}
console.log("Total unique board URLs:", companies.size);
console.log("By ATS:", JSON.stringify(byAts));

const sqlLines = [];
for (const [, c] of companies) {
  const companyName = c.name.replace(/'/g, "''");
  const slug = c.slug.replace(/'/g, "''");
  const careerUrl = c.careerUrl.replace(/'/g, "''");
  const domain = c.name.toLowerCase().replace(/[^a-z0-9]/g, "") + ".com";
  sqlLines.push(
    `INSERT INTO companies (company_name, domain, ats, ats_slug, career_url, status, origin, created_at, updated_at) ` +
    `VALUES ('${companyName}', '${domain}', '${c.ats}', '${slug}', '${careerUrl}', 'active', 'csv_import', NOW(), NOW()) ` +
    `ON CONFLICT (career_url) DO NOTHING;`
  );
}

fs.writeFileSync("scripts/import-ats-companies.sql", sqlLines.join("\n") + "\n");
console.log("SQL written:", sqlLines.length, "statements");
