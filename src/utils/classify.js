/**
 * Job classification utility.
 * Classifies jobs by:
 *  - is_remote: boolean — fully remote job
 *  - visa_sponsorship: 'yes' | 'no' | null — H1B/visa sponsorship
 *  - experience_level: 'internship' | 'entry' | 'mid' | 'senior' | 'lead' | 'executive' | null
 *
 * Designed to run inline during sync (fast, no I/O).
 */

// ── Remote Detection ──────────────────────────────────────────────

const REMOTE_POSITIVE = [
  /\bfully\s*remote\b/i,
  /\b100%\s*remote\b/i,
  /\bwork\s*from\s*home\b/i,
  /\bremote[\s-]*first\b/i,
  /\bremote\s*position\b/i,
  /\bremote\s*role\b/i,
  /\bremote\s*job\b/i,
  /\bremote\s*opportunity\b/i,
  /\blocation:\s*remote\b/i,
  /\bwork\s*remotely\b/i,
  /\banywhere\b/i,
];

const REMOTE_NEGATIVE = [
  /\bnot\s*remote\b/i,
  /\bnon[\s-]*remote\b/i,
  /\bin[\s-]*office\b/i,
  /\bon[\s-]*site\s*only\b/i,
  /\bhybrid\b/i,
  /\bremote\s*not\s*available\b/i,
  /\bno\s*remote\b/i,
];

function classifyRemote(title, location, workplaceType, description) {
  // Already tagged by adapter
  const wt = (workplaceType || '').toLowerCase();
  if (wt === 'remote' || wt === 'fully remote' || wt === 'fully_remote') return true;
  if (wt === 'hybrid' || wt === 'on-site' || wt === 'onsite' || wt === 'in-office') return false;

  const text = `${title || ''} ${location || ''} ${description || ''}`;

  // Check negatives first
  for (const re of REMOTE_NEGATIVE) {
    if (re.test(text)) return false;
  }

  // Title or location says "Remote"
  if (/\bremote\b/i.test(title || '')) return true;
  if (/\bremote\b/i.test(location || '') && !/hybrid/i.test(location || '')) return true;

  // Description signals
  for (const re of REMOTE_POSITIVE) {
    if (re.test(text)) return true;
  }

  return false;
}

// ── Remote Worldwide Detection ───────────────────────────────────

const WORLDWIDE_POSITIVE = [
  /\banywhere\s*in\s*the\s*world\b/i,
  /\bwork\s*from\s*anywhere\b/i,
  /\blocation\s*agnostic\b/i,
  /\bglobally\s*distributed\b/i,
  /\bfully\s*distributed\b/i,
  /\bremote\s*worldwide\b/i,
  /\bworldwide\s*remote\b/i,
  /\bglobal\s*remote\b/i,
  /\bremote\s*[\-–—]\s*global\b/i,
  /\bno\s*location\s*requirement\b/i,
  /\bopen\s*to\s*(?:all|any)\s*(?:location|countr)/i,
  /\bremote\s*[\-–—]\s*anywhere\b/i,
  /\bremote\s*first\b/i,
];

const WORLDWIDE_LOCATION = [
  /\banywhere\b/i,
  /\bworldwide\b/i,
  /\bglobal\b/i,
  /\bworld\b/i,
  /^remote$/i,
];

// Country-specific signals that indicate NOT worldwide
const COUNTRY_SPECIFIC = [
  /\b(?:united\s*states|usa|u\.?s\.?\b)/i,
  /\b(?:united\s*kingdom|uk\b)/i,
  /\b(?:canada|germany|france|india|australia|china|japan|brazil)\b/i,
  /\b(?:california|new\s*york|texas|london|berlin|toronto|sydney)\b/i,
  /\b(?:emea|apac|latam|americas)\b/i,
  /\b(?:EU|europe)\s*only\b/i,
  /\b(?:US|UK|CA|AU)\s*only\b/i,
];

function classifyRemoteWorldwide(title, location, description, isRemote) {
  if (!isRemote) return false;

  const loc = (location || '').trim();

  // Location explicitly says worldwide/anywhere
  for (const re of WORLDWIDE_LOCATION) {
    if (re.test(loc)) {
      // But check it's not "Remote, US" or "Remote - United States"
      let countrySpecific = false;
      for (const cs of COUNTRY_SPECIFIC) {
        if (cs.test(loc)) { countrySpecific = true; break; }
      }
      if (!countrySpecific) return true;
    }
  }

  // No location at all + remote = likely worldwide
  if (!loc || loc.length < 3) {
    // Check description for worldwide signals
    for (const re of WORLDWIDE_POSITIVE) {
      if (re.test(description || '')) return true;
    }
    if (/\bremote\b/i.test(title || '')) return true;
  }

  // Description explicitly says worldwide
  for (const re of WORLDWIDE_POSITIVE) {
    if (re.test(description || '')) return true;
  }

  return false;
}

// ── Visa Sponsorship Detection ────────────────────────────────────

const VISA_NO_PATTERNS = [
  /\bunable\s*to\s*(?:offer\s*|provide\s*)?(?:[\w\s-]*)?sponsor/i,
  /\bcannot\s*(?:offer\s*|provide\s*)?sponsor/i,
  /\bwill\s*not\s*(?:offer\s*|provide\s*)?(?:have\s*)?sponsor/i,
  /\bdoes\s*not\s*(?:offer\s*|provide\s*)?sponsor/i,
  /\bdo\s*not\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  /\bcannot\s*(?:offer|provide)\s*(?:[\w\s-]*)?sponsor/i,
  /\bnot\s*(?:offer|provide|available|able)\s*(?:[\w\s-]*)?sponsor/i,
  /\bno\s*(?:h[\s-]?1b\s*)?(?:visa\s*)?sponsorship\b/i,
  /\bsponsorship\s*(?:is\s*)?(?:not|unavailable)\b/i,
  /\bwithout\s*(?:visa\s*)?sponsorship\b/i,
  /\bnot\s*eligible\s*for\s*(?:visa\s*)?sponsorship\b/i,
  /\bmust\s*(?:be\s*)?(?:legally\s*)?(?:authorized|eligible)\s*to\s*work\b/i,
  /\bauthorized\s*to\s*work\s*in\s*the\s*(?:united\s*states|u\.?s\.?|us)\s*without\b/i,
  /\bno\s*(?:work\s*)?visa\b/i,
  /\bneed\s*not\s*apply\b.*\b(?:h[\s-]?1b|visa)\b/i,
  /\b(?:h[\s-]?1b|visa)\b.*\bneed\s*not\s*apply\b/i,
  /\bnot\s*(?:be\s*)?(?:considered|accepted)\b.*\b(?:visa|sponsor)/i,
  /\brequir(?:e|ing)\s*(?:visa\s*)?sponsorship\s*will\s*not\b/i,
  /\bnot\s*(?:require|need)\s*(?:visa\s*)?sponsorship\b/i,
  /\bdo\s*not\s*apply\b.*\b(?:h[\s-]?1b|visa)\b/i,
  // "will not have sponsorship available" — future tense negation
  /\bwill\s*not\s*have\s*sponsorship\b/i,
  // Immigration/relocation negations
  /\bnot\s*(?:eligible|available)\s*(?:for\s*)?(?:relocation|immigration)/i,
  /\bisn'?t\s*eligible\s*(?:for\s*)?(?:relocation|immigration)/i,
  /\bno\s*(?:relocation|immigration)\s*(?:support|assistance|sponsorship)/i,
  /\b(?:relocation|immigration)\s*(?:support|assistance|sponsorship)\s*(?:is\s*)?(?:not|unavailable)/i,
  /\bnot\s*eligible\s*for\s*relocation\b/i,
  /\bwithout\s*(?:relocation|immigration)\s*(?:support|assistance)/i,
  /\bcannot\s*(?:offer|provide)\s*(?:[\w\s-]*)?(?:immigration|relocation)\s*(?:support|assistance)/i,
  /\bnot\s*(?:offer|provide)\s*(?:[\w\s-]*)?(?:immigration|relocation)\s*(?:support|assistance)/i,
  // "No Relocation and Visa Support" — combined negation
  /\bno\s*relocation\s*(?:and|&)\s*visa\s*(?:support|assistance)\b/i,
  /\bno\s*visa\s*(?:and|&)\s*relocation\s*(?:support|assistance)\b/i,
  // "does not engage in ... sponsorship"
  /\bdoes\s*not\s*engage\s*in\s*(?:[\w\s-]*)?(?:sponsor|immigration)/i,
  // "Visa / Sponsorship Available: Not Available" or "Not Available" after sponsorship
  /\b(?:visa|sponsorship)\s*(?:\/\s*(?:visa|sponsorship)\s*)?available\s*:\s*not\s*available\b/i,
  /\bsponsorship\s*available\s*:\s*(?:no|not|none|unavailable)\b/i,
  // US citizenship required
  /\b(?:us|u\.?s\.?)\s*citizenship\s*(?:is\s*)?required\b/i,
  /\bcitizenship\s*(?:is\s*)?required\b/i,
];

const VISA_YES_PATTERNS = [
  /\bvisa\s*sponsor(?:ship)?\s*(?:available|offered|provided|included)\b/i,
  /\bwilling\s*to\s*sponsor\b/i,
  /\bopen\s*to\s*sponsor/i,
  /\bproudly\s*sponsor/i,
  /\bwe\s*(?:do\s*)?sponsor\s*(?:h[\s-]?1b|work\s*visa|visa)\b/i,
  /\bvisa\s*(?:support|assistance)\s*(?:available|offered|provided|included)\b/i,
  /\bimmigration\s*(?:support|assistance|sponsorship)\s*(?:available|offered|provided|included|is\s*available)\b/i,
  /\b(?:offer|provide)s?\s*(?:visa|immigration)\s*(?:support|assistance|sponsorship)\b/i,
  /\bh[\s-]?1b\s*transfer/i,
  /\bh[\s-]?1b\s*(?:visa\s*)?sponsor(?:ship)?\s*(?:available|offered|provided|included|supported)\b/i,
  /\bvisa\s*arrangements\b/i,
  // "Sponsorship Available: Yes" — explicit positive with colon format
  /\bsponsorship\s*available\s*:\s*yes\b/i,
  /\bsponsorship\s*:\s*yes\b/i,
  /\bvisa\s*(?:\/\s*)?sponsorship\s*available\s*:\s*(?:yes|available)\b/i,
];

function classifyVisa(description) {
  if (!description) return null;

  // Check "no" patterns first (more common, higher confidence)
  for (const re of VISA_NO_PATTERNS) {
    if (re.test(description)) return 'no';
  }

  // Check "yes" patterns
  for (const re of VISA_YES_PATTERNS) {
    if (re.test(description)) return 'yes';
  }

  return null;
}

// ── Experience Level Detection ────────────────────────────────────

const LEVEL_PATTERNS = {
  internship: [
    /\bintern(?:ship)?\b/i,
    /\bco[\s-]?op\b/i,
    /\bsummer\s*(?:student|analyst|associate)\b/i,
    /\bstudent\b/i,
    /\bapprentice/i,
    /\btrainee\b/i,
  ],
  entry: [
    /\bentry[\s-]*level\b/i,
    /\bjunior\b/i,
    /\bjr\.?\b/i,
    /\bnew\s*grad(?:uate)?\b/i,
    /\brecent\s*grad(?:uate)?\b/i,
    /\bfresh\s*grad(?:uate)?\b/i,
    /\bgraduate\s*(?:program|role|position|engineer|analyst|developer)\b/i,
    /\bassociate\s+\w+/i,
    /\b(?:analyst|engineer|developer|designer)\s*[i1]\b/i,
    /\b0[\s-]*(?:to|-)[\s-]*[12]\s*years?\b/i,
    /\bno\s*experience\s*(?:required|needed|necessary)\b/i,
    /\blevel\s*[i1]\b/i,
  ],
  mid: [
    /\bmid[\s-]*(?:level|senior)\b/i,
    /\b(?:analyst|engineer|developer|designer|associate)\s*(?:ii|2|iii|3)\b/i,
    /\b[3-5]\+?\s*years?\b/i,
    /\blevel\s*(?:ii|2|iii|3)\b/i,
  ],
  senior: [
    /\bsenior\b/i,
    /\bsr\.?\b/i,
    /\bstaff\b/i,
    /\bprincipal\b/i,
    /\b(?:analyst|engineer|developer|designer)\s*(?:iv|4|v|5)\b/i,
    /\blead\s*(?:\w+\s+)?(?:engineer|developer|designer|analyst)\b/i,
    /\b(?:7|8|9|10)\+?\s*years?\b/i,
    /\blevel\s*(?:iv|4|v|5)\b/i,
  ],
  lead: [
    /\bteam\s*lead\b/i,
    /\btech\s*lead\b/i,
    /\bengineering\s*(?:lead|manager)\b/i,
    /\bmanager\b/i,
    /\bhead\s*of\b/i,
    /\bgroup\s*lead\b/i,
    /\blead\b/i,
  ],
  executive: [
    /\bdirector\b/i,
    /\bvp\b/i,
    /\bvice\s*president\b/i,
    /\bc[etofi]o\b/i,
    /\bchief\b/i,
    /\bexecutive\b/i,
    /\bsvp\b/i,
    /\bevp\b/i,
    /\bpartner\b/i,
    /\bfounding\b/i,
  ],
};

// Priority order: most specific first
const LEVEL_PRIORITY = ['internship', 'entry', 'executive', 'senior', 'lead', 'mid'];

function classifyExperienceLevel(title, description) {
  const titleLower = (title || '').toLowerCase();

  // Title-based classification (highest confidence)
  for (const level of LEVEL_PRIORITY) {
    for (const re of LEVEL_PATTERNS[level]) {
      if (re.test(title || '')) {
        // Disambiguate: "Senior Manager" → senior, not lead
        if (level === 'lead' && /\bsenior\b/i.test(titleLower)) return 'senior';
        // "Lead Intern" → internship, not lead
        if (level === 'lead' && /\bintern/i.test(titleLower)) return 'internship';
        return level;
      }
    }
  }

  // Description-based (lower confidence, only for entry/internship)
  if (description) {
    for (const re of LEVEL_PATTERNS.internship) {
      if (re.test(description)) return 'internship';
    }
    for (const re of LEVEL_PATTERNS.entry) {
      if (re.test(description)) return 'entry';
    }
  }

  return null;
}

// ── Main classify function ────────────────────────────────────────

function classifyJob(job) {
  const title = job.title || '';
  const description = job.description || '';
  const location = job.location || '';
  const workplaceType = job.workplace_type || '';

  const is_remote = classifyRemote(title, location, workplaceType, description);

  return {
    is_remote,
    remote_worldwide: classifyRemoteWorldwide(title, location, description, is_remote),
    visa_sponsorship: classifyVisa(description),
    experience_level: classifyExperienceLevel(title, description),
  };
}

module.exports = { classifyJob, classifyRemote, classifyVisa, classifyExperienceLevel, classifyRemoteWorldwide };
