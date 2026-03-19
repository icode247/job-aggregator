const { classifyJob } = require('../src/utils/classify');
const tests = [
  // TRUE WORLDWIDE
  ['Software Engineer', 'Remote', 'Work from anywhere in the world', true],
  ['Data Analyst', 'Anywhere', '', true],
  ['DevOps', 'Worldwide', '', true],
  ['PM', 'Remote', 'We are a fully distributed team', true],
  ['Engineer', '', 'This is a remote position, work from anywhere', true],
  ['ML Engineer', 'Remote, Global', '', true],
  ['Designer', 'Remote', 'Location agnostic role', true],
  ['SRE', 'Remote', 'Our team is globally distributed', true],
  ['Backend Dev', 'Remote', 'Remote first company, open to all locations', true],

  // FALSE — country-specific remote
  ['Engineer', 'Remote, US', '', false],
  ['Engineer', 'Remote - United States', '', false],
  ['Engineer', 'Remote, United Kingdom', '', false],
  ['Engineer', 'Remote (Canada only)', '', false],
  ['Engineer', 'Remote, California', '', false],
  ['Engineer', 'Remote - EMEA', '', false],
  ['Sales', 'London, UK', 'Remote role for UK residents', false],
  ['Engineer', 'Remote, New York', '', false],
  ['Engineer', 'Remote, Germany', '', false],
  ['Engineer', 'Remote, India', '', false],
  ['Engineer', 'Remote, Australia', '', false],

  // FALSE — not remote at all
  ['Engineer', 'New York, NY', '', false],
  ['Manager', 'San Francisco, CA', 'In-office role', false],
  ['Analyst', 'Berlin, Germany', 'Hybrid position', false],

  // EDGE CASES
  ['Remote Engineer', '', '', true],  // title says remote, no location
  ['Engineer', 'Remote', '', true],   // just "Remote" location, no country qualifier
];

let pass = 0, fail = 0;
for (const [title, loc, desc, expected] of tests) {
  const r = classifyJob({ title, location: loc, description: desc, workplace_type: '' });
  const got = r.remote_worldwide;
  const ok = got === expected;
  if (!ok) {
    console.log(`❌ got=${got} expected=${expected} ← "${title}" | "${loc}" | "${desc.substring(0,40)}"`);
    fail++;
  } else {
    pass++;
  }
}
console.log(`\n${pass}/${pass+fail} passed`);
if (fail === 0) console.log('✅ All edge cases handled correctly');
