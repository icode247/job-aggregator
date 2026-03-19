const { classifyJob } = require('../src/utils/classify');

const tests = [
  // Remote detection
  { title: 'Senior Software Engineer (Remote)', location: '', workplace_type: '', description: '', expect: { is_remote: true } },
  { title: 'Data Analyst', location: 'Remote, US', workplace_type: '', description: '', expect: { is_remote: true } },
  { title: 'Backend Developer', location: 'New York, NY', workplace_type: 'remote', description: '', expect: { is_remote: true } },
  { title: 'Frontend Engineer', location: 'San Francisco', workplace_type: 'hybrid', description: '', expect: { is_remote: false } },
  { title: 'DevOps Engineer', location: 'Austin, TX', workplace_type: 'on-site', description: '', expect: { is_remote: false } },
  { title: 'ML Engineer', location: '', workplace_type: '', description: 'This is a fully remote position', expect: { is_remote: true } },
  { title: 'Product Manager', location: '', workplace_type: '', description: 'Work from home available', expect: { is_remote: true } },
  { title: 'Designer', location: '', workplace_type: '', description: 'This is not a remote role. On-site only.', expect: { is_remote: false } },
  { title: 'QA Engineer', location: '', workplace_type: '', description: 'Remote work not available', expect: { is_remote: false } },
  { title: 'Analyst - Remote Operations Center', location: 'Chicago, IL', workplace_type: 'onsite', description: 'Work on-site at our remote operations center', expect: { is_remote: false } },

  // Visa sponsorship
  { title: 'SWE', description: 'We sponsor H1B visas for qualified candidates', expect: { visa_sponsorship: 'yes' } },
  { title: 'SWE', description: 'Visa sponsorship available for this role', expect: { visa_sponsorship: 'yes' } },
  { title: 'SWE', description: 'Willing to sponsor work visa', expect: { visa_sponsorship: 'yes' } },
  { title: 'SWE', description: 'H-1B transfer supported', expect: { visa_sponsorship: 'yes' } },
  { title: 'SWE', description: 'Immigration support provided', expect: { visa_sponsorship: 'yes' } },
  { title: 'SWE', description: 'We are unable to sponsor visas at this time', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'Must be authorized to work in the United States without sponsorship', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'This company does not sponsor work visas', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'Cannot sponsor visa for this position', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'No sponsorship available', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'Will not sponsor visa', expect: { visa_sponsorship: 'no' } },
  { title: 'SWE', description: 'Great opportunity to work with a team', expect: { visa_sponsorship: null } },
  { title: 'SWE', description: '', expect: { visa_sponsorship: null } },

  // Experience level - Internship
  { title: 'Software Engineering Intern', description: '', expect: { experience_level: 'internship' } },
  { title: 'Summer Intern - Data Science', description: '', expect: { experience_level: 'internship' } },
  { title: 'Co-op Engineer', description: '', expect: { experience_level: 'internship' } },
  { title: 'Apprentice Developer', description: '', expect: { experience_level: 'internship' } },

  // Experience level - Entry
  { title: 'Junior Frontend Developer', description: '', expect: { experience_level: 'entry' } },
  { title: 'Entry-Level Data Analyst', description: '', expect: { experience_level: 'entry' } },
  { title: 'Software Engineer I', description: '', expect: { experience_level: 'entry' } },
  { title: 'New Graduate Program - Engineering', description: '', expect: { experience_level: 'entry' } },
  { title: 'Jr. Software Developer', description: '', expect: { experience_level: 'entry' } },
  { title: 'Associate Analyst', description: '', expect: { experience_level: 'entry' } },

  // Experience level - Mid
  { title: 'Software Engineer II', description: '', expect: { experience_level: 'mid' } },
  { title: 'Analyst III', description: '', expect: { experience_level: 'mid' } },

  // Experience level - Senior
  { title: 'Senior Software Engineer', description: '', expect: { experience_level: 'senior' } },
  { title: 'Staff Engineer', description: '', expect: { experience_level: 'senior' } },
  { title: 'Principal Engineer', description: '', expect: { experience_level: 'senior' } },
  { title: 'Sr. Developer', description: '', expect: { experience_level: 'senior' } },
  { title: 'Lead Software Engineer', description: '', expect: { experience_level: 'senior' } },

  // Experience level - Lead/Manager
  { title: 'Engineering Manager', description: '', expect: { experience_level: 'lead' } },
  { title: 'Head of Engineering', description: '', expect: { experience_level: 'lead' } },
  { title: 'Team Lead - Backend', description: '', expect: { experience_level: 'lead' } },

  // Experience level - Executive
  { title: 'VP of Product', description: '', expect: { experience_level: 'executive' } },
  { title: 'Chief Technology Officer', description: '', expect: { experience_level: 'executive' } },
  { title: 'Director of Marketing', description: '', expect: { experience_level: 'executive' } },

  // Disambiguation
  { title: 'Senior Engineering Manager', description: '', expect: { experience_level: 'senior' } },
  { title: 'Lead Intern', description: '', expect: { experience_level: 'internship' } },

  // Description-based entry detection
  { title: 'Software Engineer', description: 'This is an entry-level position requiring 0-2 years experience', expect: { experience_level: 'entry' } },
  { title: 'Analyst', description: 'Looking for a recent graduate to join our team', expect: { experience_level: 'entry' } },

  // Combined test
  { title: 'Senior Backend Engineer (Remote)', location: '', workplace_type: '', description: 'H1B sponsorship available. 7+ years experience required.', expect: { is_remote: true, visa_sponsorship: 'yes', experience_level: 'senior' } },
  { title: 'Junior Data Analyst', location: 'New York, NY', workplace_type: 'on-site', description: 'Must be authorized to work in the US. Entry-level role.', expect: { is_remote: false, visa_sponsorship: 'no', experience_level: 'entry' } },
];

let passed = 0, failed = 0;
for (const t of tests) {
  const result = classifyJob(t);
  for (const [key, expected] of Object.entries(t.expect)) {
    if (result[key] !== expected) {
      console.log(`FAIL: "${t.title}" | ${key} | got: ${result[key]} | expected: ${expected}`);
      if (t.description) console.log(`  desc: ${t.description.substring(0, 80)}`);
      failed++;
    } else {
      passed++;
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
