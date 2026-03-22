const { classifyVisa } = require('./src/utils/classify');
const data = require('./visa-sponsorship-job.json');

let correct = 0;
let falsePositive = 0;
let noDesc = 0;
const issues = [];

for (const job of data.data) {
  const desc = job.description || '';
  if (!desc) { noDesc++; continue; }

  const result = classifyVisa(desc);

  if (result === 'yes') {
    correct++;
  } else if (result === 'no') {
    falsePositive++;
    const lines = desc.split(/\n/).filter(l =>
      /sponsor|visa|relocation|immigration|authorized\s*to\s*work|must\s*be\s*legally|citizenship/i.test(l)
    ).map(l => l.trim().substring(0, 150)).filter(Boolean);
    issues.push({ title: job.title, company: job.company.name, classified: 'NO', lines });
  } else {
    const lines = desc.split(/\n/).filter(l =>
      /sponsor|visa|relocation|immigration|authorized\s*to\s*work|must\s*be\s*legally|citizenship/i.test(l)
    ).map(l => l.trim().substring(0, 150)).filter(Boolean);
    if (lines.length > 0) {
      issues.push({ title: job.title, company: job.company.name, classified: 'NULL (has text)', lines });
    } else {
      issues.push({ title: job.title, company: job.company.name, classified: 'NULL (no text)', lines: ['(no visa/sponsor mention in description)'] });
    }
  }
}

console.log('=== SUMMARY ===');
console.log('Total:', data.data.length);
console.log('Classifier says YES:', correct);
console.log('Classifier says NO (API wrong?):', falsePositive);
console.log('Classifier says NULL:', issues.length - falsePositive);
console.log('No description:', noDesc);
console.log();

if (issues.length > 0) {
  console.log('=== ISSUES ===');
  for (const i of issues) {
    console.log();
    console.log('X', i.title, '(' + i.company + ') — classifier:', i.classified);
    for (const l of i.lines) console.log('   ', l);
  }
}
