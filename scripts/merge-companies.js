const fs = require("fs");

const existingFile = fs.readFileSync("data/company-names.txt", "utf8");
const lines = existingFile.split("\n");
const existing = new Set(
  lines.filter(l => l.trim() !== "" && !l.startsWith("#")).map(l => l.trim())
);
console.log("Existing unique:", existing.size);

function parseCSV(fp) {
  const rows = fs.readFileSync(fp, "utf8").split("\n").slice(1);
  const out = [];
  for (const row of rows) {
    if (row.trim() === "") continue;
    const m = row.match(/^"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/);
    if (m) out.push({ name: m[2].trim() });
  }
  return out;
}

const all = [
  ...parseCSV("/Users/codev/Downloads/linkedin_companies_batch1_US_UK_Canada_Australia_China.csv"),
  ...parseCSV("/Users/codev/Downloads/linkedin_companies_batch2_India_Kenya_Germany_France_Brazil.csv"),
];
console.log("CSV rows:", all.length);

const existingLower = new Set([...existing].map(n => n.toLowerCase()));
const added = [];

for (const c of all) {
  if (c.name === "") continue;
  if (existingLower.has(c.name.toLowerCase())) continue;
  existingLower.add(c.name.toLowerCase());
  added.push(c.name);
}

console.log("New unique to add:", added.length);
console.log("Total after merge:", existing.size + added.length);

const section = "\n# LinkedIn companies (batch import)\n" + added.sort((a, b) => a.localeCompare(b)).join("\n") + "\n";
fs.writeFileSync("data/company-names.txt", existingFile.trimEnd() + section);
console.log("Done - written to data/company-names.txt");
