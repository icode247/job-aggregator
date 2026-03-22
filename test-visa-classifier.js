const { classifyVisa } = require('./src/utils/classify.js');
const data = require('/Users/codev/job-aggregator/visa-sponsorship-job.json');

let mismatches = 0;
let correct = 0;

// For each job, manually check the description for visa signals and compare
for (const job of data.data) {
  const classifierResult = classifyVisa(job.description);
  const apiValue = job.visa_sponsorship;

  // Find what the description actually says about sponsorship
  const desc = job.description || '';

  // Extract relevant lines mentioning sponsor/visa/relocation/immigration
  const lines = desc.split(/[\n<>]/).filter(l =>
    /sponsor|visa|relocation|immigration|authorized\s*to\s*work|must\s*be\s*legally|citizenship/i.test(l)
  ).map(l => l.replace(/&amp;/g, '&').replace(/&#\d+;/g, '').trim()).filter(Boolean);

  if (classifierResult !== apiValue) {
    mismatches++;
    console.log(`\n❌ MISMATCH: "${job.title}" (${job.company.name})`);
    console.log(`   API says: ${apiValue}`);
    console.log(`   Classifier says: ${classifierResult}`);
    console.log(`   Relevant text:`);
    lines.forEach(l => console.log(`     - ${l.substring(0, 120)}`));
  } else {
    // Also check if "yes" results are actually correct
    if (apiValue === 'yes' && lines.length > 0) {
      const hasNo = lines.some(l => /\b(?:not?\s*available|no\b(?! relocation)|cannot|unable|will\s*not|does\s*not|isn'?t)/i.test(l));
      if (hasNo) {
        console.log(`\n⚠️  FALSE POSITIVE: "${job.title}" (${job.company.name})`);
        console.log(`   Both API and classifier say: ${apiValue}`);
        console.log(`   But description suggests NO sponsorship:`);
        lines.forEach(l => console.log(`     - ${l.substring(0, 120)}`));
        mismatches++;
      } else {
        correct++;
      }
    } else {
      correct++;
    }
  }
}

console.log(`\n\n=== SUMMARY ===`);
console.log(`Total jobs: ${data.data.length}`);
console.log(`Correct: ${correct}`);
console.log(`Issues: ${mismatches}`);
