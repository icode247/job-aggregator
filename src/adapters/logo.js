const logger = require('../logger');

/**
 * ATS-specific logo URL patterns.
 * Each entry is an array of regexes tried in order. First match wins.
 * Patterns capture the full URL in group 1.
 */
const LOGO_PATTERNS = {
  lever: [
    /https:\/\/lever-client-logos\.s3[^"'\s)]+/,
  ],
  greenhouse: [
    // CDN logo in img src (the actual logo image)
    /https:\/\/s\d+-recruiting\.cdn\.greenhouse\.io\/external_greenhouse_job_boards\/logos\/[^"'\s)]+/,
  ],
  ashby: [
    // Ashby org theme images
    /https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme[^"'\s)]+/,
  ],
  workable: [
    // Workable S3 account logos
    /https:\/\/workablehr\.s3[^"'\s)]+\/uploads\/account\/logo\/[^"'\s)]+/,
  ],
  recruitee: [
    // Recruitee CDN logos
    /https:\/\/careers\.recruiteecdn\.com\/image\/upload\/[^"'\s)]+/,
  ],
  smartrecruiters: [
    // SmartRecruiters CDN logos
    /https:\/\/c\.smartrecruiters\.com\/sr-company-logo[^"'\s)]+/,
    /https:\/\/c\.smartrecruiters\.com\/sr-careersite-image[^"'\s)]+/,
  ],
  rippling: [
    // Rippling company logos
    /https:\/\/[^"'\s)]*rippling[^"'\s)]*logo[^"'\s)]+/i,
  ],
  personio: [],
  breezy: [],
  jazzhr: [],
  workday: [],
};

/**
 * Generic patterns tried for all ATS types as fallback.
 * These look for img tags with "logo" in any attribute.
 */
const GENERIC_PATTERNS = [
  // img with src before logo-related attributes
  /<img[^>]*\bsrc="([^"]+)"[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"/i,
  // img with logo-related attributes before src
  /<img[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"[^>]*\bsrc="([^"]+)"/i,
  // og:image (content before property or vice versa)
  /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i,
  /<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i,
];

async function fetchLogoUrl(ats, atsSlug, domain) {
  const pageUrls = {
    lever: `https://jobs.lever.co/${atsSlug}`,
    greenhouse: `https://boards.greenhouse.io/${atsSlug}`,
    ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
    workable: `https://apply.workable.com/${atsSlug}`,
    recruitee: `https://${atsSlug}.recruitee.com`,
    smartrecruiters: `https://careers.smartrecruiters.com/${atsSlug}`,
    rippling: `https://ats.rippling.com/${atsSlug}`,
    personio: `https://${atsSlug}.jobs.personio.de`,
    breezy: `https://${atsSlug}.breezy.hr`,
    jazzhr: `https://${atsSlug}.applytojob.com`,
    workday: null, // Workday career pages are JS-rendered, can't scrape logo
  };

  const pageUrl = pageUrls[ats];
  if (!pageUrl) return `https://logo.clearbit.com/${domain}`;

  try {
    const res = await fetch(pageUrl, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // 1. Try ATS-specific patterns (match the CDN URL directly in the HTML)
    const atsPatterns = LOGO_PATTERNS[ats] || [];
    for (const regex of atsPatterns) {
      const match = html.match(regex);
      if (match) {
        const url = match[1] || match[0];
        logger.info({ ats, atsSlug, logoUrl: url }, 'Logo found via ATS pattern');
        return url;
      }
    }

    // 2. Try generic img/meta patterns
    for (const regex of GENERIC_PATTERNS) {
      const match = html.match(regex);
      if (match && match[1] && !match[1].includes('sr-logo/')) {
        logger.info({ ats, atsSlug, logoUrl: match[1] }, 'Logo found via generic pattern');
        return match[1];
      }
    }
  } catch (err) {
    logger.warn({ ats, atsSlug, err: err.message }, 'Failed to fetch logo from ATS page');
  }

  return `https://logo.clearbit.com/${domain}`;
}

module.exports = { fetchLogoUrl };
