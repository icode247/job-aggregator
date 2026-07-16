const { Client } = require("pg");
const https = require("https");
const { scrapePaylocityFromFeed, fetchFeedWithRetry } = require("./scrape-paylocity");

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => resolve(d));
    }).on("error", reject);
  });
}

(async () => {
  const c = new Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
  c.on("error", () => {});
  await c.connect();

  const r = await c.query("SELECT ats, ats_slug FROM companies WHERE ats_slug IS NOT NULL");
  const existing = new Set(r.rows.map(r => r.ats + ":" + (r.ats_slug || "").toLowerCase()));

  const feedXml = await fetchFeedWithRetry("https://portal.allscmjobs.com/jobs.xml");
  const companies = new Map();
  const blocks = feedXml.split("<application_link>").slice(1);

  for (const block of blocks) {
    const appUrl = block.split("</application_link>")[0] || "";
    if (appUrl.includes("oracle") || appUrl.includes("successfactors") || appUrl.includes("sapsf") || appUrl.includes("taleo.net")) continue;

    let ats, slug, careerUrl, domain;

    if (appUrl.includes("icims.com")) { ats="icims"; slug=(appUrl.match(/\/\/([^.]+)\.icims/) || [])[1]; if(slug){careerUrl="https://"+slug+".icims.com";domain=slug+".icims.com";} }
    else if (appUrl.includes("myworkdayjobs.com")) { ats="workday"; slug=(appUrl.match(/\/\/([^.]+)\.wd/) || [])[1]; if(slug){careerUrl="https://"+slug+".wd1.myworkdayjobs.com";domain=slug+".myworkdayjobs.com";} }
    else if (appUrl.includes("paylocity.com")) { ats="paylocity"; const gm=appUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i); if(gm){slug=gm[1];careerUrl="https://recruiting.paylocity.com/recruiting/jobs/All/"+slug;domain="recruiting.paylocity.com";} }
    else if (appUrl.includes("smartrecruiters.com")) { ats="smartrecruiters"; slug=(appUrl.match(/smartrecruiters\.com\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://jobs.smartrecruiters.com/"+slug;domain="jobs.smartrecruiters.com";} }
    else if (appUrl.includes("lever.co")) { ats="lever"; slug=(appUrl.match(/lever\.co\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://jobs.lever.co/"+slug;domain=slug+".lever.co";} }
    else if (appUrl.includes("bamboohr.com")) { ats="bamboohr"; slug=(appUrl.match(/\/\/([^.]+)\.bamboohr/) || [])[1]; if(slug){careerUrl="https://"+slug+".bamboohr.com/careers";domain=slug+".bamboohr.com";} }
    else if (appUrl.includes("ashbyhq.com")) { ats="ashby"; slug=(appUrl.match(/ashbyhq\.com\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://jobs.ashbyhq.com/"+slug;domain=slug+".ashbyhq.com";} }
    else if (appUrl.includes("rippling.com")) { ats="rippling"; slug=(appUrl.match(/rippling\.com\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://ats.rippling.com/"+slug;domain=slug+".rippling.com";} }
    else if (appUrl.includes("applytojob.com")) { ats="jazzhr"; slug=(appUrl.match(/\/\/([^.]+)\.applytojob/) || [])[1]; if(slug){careerUrl="https://"+slug+".applytojob.com";domain=slug+".applytojob.com";} }
    else if (appUrl.includes("pinpointhq.com")) { ats="pinpoint"; slug=(appUrl.match(/\/\/([^.]+)\.pinpointhq/) || [])[1]; if(slug){careerUrl="https://"+slug+".pinpointhq.com";domain=slug+".pinpointhq.com";} }
    else if (appUrl.includes("greenhouse.io")) { ats="greenhouse"; slug=(appUrl.match(/greenhouse\.io\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://boards.greenhouse.io/"+slug;domain="boards.greenhouse.io";} }
    else if (appUrl.includes("workable.com")) { ats="workable"; slug=(appUrl.match(/workable\.com\/([^/]+)/) || [])[1]; if(slug){careerUrl="https://apply.workable.com/"+slug;domain=slug+".workable.com";} }
    else if (appUrl.includes("recruitee.com")) { ats="recruitee"; slug=(appUrl.match(/\/\/([^.]+)\.recruitee/) || [])[1]; if(slug){careerUrl="https://"+slug+".recruitee.com";domain=slug+".recruitee.com";} }
    else if (appUrl.includes("zohorecruit.com")) { ats="zoho"; slug=(appUrl.match(/\/\/([^.]+)\.zohorecruit/) || [])[1]; if(slug){careerUrl="https://"+slug+".zohorecruit.com";domain=slug+".zohorecruit.com";} }
    else if (appUrl.includes("breezy.hr")) { ats="breezy"; slug=(appUrl.match(/\/\/([^.]+)\.breezy/) || [])[1]; if(slug && slug!=="breezy"){careerUrl="https://"+slug+".breezy.hr";domain=slug+".breezy.hr";} }
    else continue;

    if (!ats || !slug) continue;
    const key = ats + ":" + slug.toLowerCase();
    if (!companies.has(key)) companies.set(key, { ats, slug, careerUrl, domain, name: slug.replace(/-/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()) });
  }

  console.log("Unique:", companies.size);
  const byAts = {}; for (const [_,co] of companies) byAts[co.ats]=(byAts[co.ats]||0)+1;
  console.log("By ATS:", JSON.stringify(byAts));

  const newOnes = [...companies.values()].filter(co => !existing.has(co.ats+":"+co.slug.toLowerCase()));
  const nb = {}; for (const co of newOnes) nb[co.ats]=(nb[co.ats]||0)+1;
  console.log("New:", newOnes.length, JSON.stringify(nb));

  let ins = 0;
  for (const co of newOnes) {
    try {
      const r = await c.query("INSERT INTO companies (company_name,domain,ats,ats_slug,career_url,status,origin,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,'active','allscmjobs',NOW(),NOW()) ON CONFLICT (career_url) DO NOTHING",[co.name,co.domain,co.ats,co.slug,co.careerUrl]);
      if (r.rowCount>0) ins++;
    } catch(e) {}
  }
  console.log("Inserted:", ins);
  const r2 = await c.query("SELECT COUNT(*) as t FROM companies");
  console.log("Total:", r2.rows[0].t);

  // Paylocity jobs are per-job apply URLs (no ATS slug) — the company loop above
  // can't key them, and the paylocity adapter's feed API returns empty. Scrape
  // them straight from the feed instead so every allscm run captures them.
  try {
    const pl = await scrapePaylocityFromFeed(feedXml, c, { origin: "allscmjobs" });
    console.log("Paylocity:", JSON.stringify(pl));
  } catch (e) { console.error("Paylocity scrape error:", e.message); }

  await c.end();
})();
