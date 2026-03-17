const fs = require("fs");

const dict = fs.readFileSync("data/company-names.txt", "utf8")
  .split("\n")
  .filter(l => l.trim() !== "" && l.charAt(0) !== "#")
  .map(l => l.trim());
const dictLower = new Set(dict.map(n => n.toLowerCase()));

console.log("Dictionary size:", dictLower.size);
console.log("=".repeat(60));

const files = [
  { path: "/Users/codev/Downloads/ashby_companies.csv", nameCol: 1, urlCol: 2, type: "ashby" },
  { path: "/Users/codev/Downloads/ashby_jobs_comprehensive_final.csv", nameCol: 1, urlCol: 2, type: "ashby" },
  { path: "/Users/codev/Downloads/ashby_jobs_new_entries.csv", nameCol: 1, urlCol: 2, type: "ashby" },
  { path: "/Users/codev/Downloads/software_engineer_jobs_complete.csv", nameCol: 1, urlCol: 2, type: "ashby" },
  { path: "/Users/codev/Downloads/software_engineer_jobs.csv", nameCol: 1, urlCol: 2, type: "ashby" },
  { path: "/Users/codev/Downloads/taleo_companies.csv", nameCol: "taleo", urlCol: null, type: "taleo" },
  { path: "/Users/codev/Downloads/zohorecruit_companies.csv", nameCol: "zoho", urlCol: null, type: "zoho" },
];

// Try alternate zoho files
for (const alt of [
  "/Users/codev/Downloads/zohorecruit_companies (1).csv",
  "/Users/codev/Downloads/zohorecruit_companies (2).csv",
]) {
  if (fs.existsSync(alt)) {
    files.push({ path: alt, nameCol: "zoho", urlCol: null, type: "zoho" });
  }
}

const allMissing = new Map(); // name -> { types, urls }
const allFound = new Set();
let totalRows = 0;

for (const file of files) {
  if (!fs.existsSync(file.path)) {
    console.log("\nSKIPPED (not found):", file.path.split("/").pop());
    continue;
  }

  const lines = fs.readFileSync(file.path, "utf8").split("\n").slice(1);
  const names = new Map();

  for (const line of lines) {
    if (line.trim() === "") continue;
    totalRows++;

    let name, url;

    if (file.type === "ashby") {
      const m = line.match(/^"([^"]*)","([^"]*)"/);
      if (m) { name = m[1].trim(); url = m[2].trim(); }
    } else if (file.type === "taleo") {
      // Page,Title,Subdomain,Company URL
      const parts = line.match(/^(\d+),"([^"]*)","([^"]*)","([^"]*)"/);
      if (parts) { name = parts[3].trim(); url = parts[4].trim(); }
    } else if (file.type === "zoho") {
      // #,Company Name,Page Title,Subdomain,URL,Page Number
      const m = line.match(/^\d+,"([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
      if (m) { name = m[1].trim(); url = m[4].trim(); }
    }

    if (name) names.set(name.toLowerCase(), { name, url });
  }

  let found = 0, missing = 0;
  const fileMissing = [];

  for (const [lower, { name, url }] of names) {
    if (dictLower.has(lower)) {
      found++;
      allFound.add(lower);
    } else {
      missing++;
      fileMissing.push(name);
      if (!allMissing.has(lower)) {
        allMissing.set(lower, { name, urls: new Set(), types: new Set() });
      }
      if (url) allMissing.get(lower).urls.add(url);
      allMissing.get(lower).types.add(file.type);
    }
  }

  const fname = file.path.split("/").pop();
  console.log(`\n${fname}:`);
  console.log(`  Unique companies: ${names.size} | In dict: ${found} | MISSING: ${missing}`);
  if (fileMissing.length > 0 && fileMissing.length <= 20) {
    console.log(`  Missing: ${fileMissing.join(", ")}`);
  }
}

console.log("\n" + "=".repeat(60));
console.log(`TOTAL rows across all files: ${totalRows}`);
console.log(`Already in dictionary: ${allFound.size} unique`);
console.log(`MISSING from dictionary: ${allMissing.size} unique`);

if (allMissing.size > 0) {
  console.log("\n--- ALL MISSING COMPANIES ---");
  const sorted = [...allMissing.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, { name, urls, types }] of sorted) {
    const ats = [...types].join(",");
    const url = [...urls][0] || "";
    console.log(`  ${name} [${ats}] ${url}`);
  }
}
