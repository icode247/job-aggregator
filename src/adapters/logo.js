const logger = require('../logger');

/**
 * ATS-specific logo URL patterns.
 * Each entry is an array of regexes tried in order. First match wins.
 */
const LOGO_PATTERNS = {
  lever: [
    /https:\/\/lever-client-logos\.s3[^"'\s)]+/,
  ],
  greenhouse: [
    /https:\/\/s\d+-recruiting\.cdn\.greenhouse\.io\/external_greenhouse_job_boards\/logos\/[^"'\s)]+/,
  ],
  ashby: [
    // Ashby org-theme-logo (the actual company logo, not social/wordmark)
    /(https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme-logo[^"'\s)]+)/,
    /(https:\/\/app\.ashbyhq\.com\/api\/images\/org-theme[^"'\s)]+)/,
  ],
  workable: [
    /https:\/\/workablehr\.s3[^"'\s)]+\/uploads\/account\/logo\/[^"'\s)]+/,
  ],
  recruitee: [
    /https:\/\/careers\.recruiteecdn\.com\/image\/upload\/[^"'\s)]+/,
  ],
  smartrecruiters: [
    /https:\/\/c\.smartrecruiters\.com\/sr-company-logo[^"'\s)]+/,
    /https:\/\/c\.smartrecruiters\.com\/sr-careersite-image[^"'\s)]+/,
  ],
  rippling: [],
  personio: [
    /(https:\/\/assets\.cdn\.personio\.de\/logos\/[^"'\s)]+)/,
  ],
  breezy: [
    /(https:\/\/gallery-cdn\.breezy\.hr\/[^"'\s)]+)/,
  ],
  jazzhr: [
    /src="([^"]*s3\.amazonaws\.com\/resumator[^"]*logo[^"]*)"/i,
  ],
  workday: [],
  zoho: [
    /(https:\/\/[^"'\s)]*zohorecruit[^"'\s)]*viewCareerImage[^"'\s)]+)/,
  ],
  icims: [],
  oracle: [],
  bamboohr: [],
  taleo: [],
  pinpoint: [],
  successfactors: [],
};

/**
 * Generic patterns tried for all ATS types as fallback.
 */
const GENERIC_PATTERNS = [
  /<img[^>]*\bsrc="([^"]+)"[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"/i,
  /<img[^>]*(?:alt|class|id)="[^"]*[Ll]ogo[^"]*"[^>]*\bsrc="([^"]+)"/i,
  /<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i,
  /<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i,
];

/**
 * Clearbit Logo API — returns high-quality company logos.
 * Free, no API key needed, returns proper logos (not favicons).
 */
function clearbitLogoUrl(domain) {
  return `https://logo.clearbit.com/${domain}`;
}

/**
 * Google's favicon API — last-resort fallback.
 * Returns a 128px favicon (not ideal but always works).
 */
function googleFaviconUrl(domain) {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=https://${domain}&size=128`;
}

async function fetchLogoUrl(ats, atsSlug, domain) {
  const pageUrls = {
    lever: `https://jobs.lever.co/${atsSlug}`,
    greenhouse: `https://job-boards.greenhouse.io/${atsSlug}`,
    ashby: `https://jobs.ashbyhq.com/${atsSlug}`,
    workable: `https://apply.workable.com/${atsSlug}`,
    recruitee: `https://${atsSlug}.recruitee.com`,
    smartrecruiters: `https://careers.smartrecruiters.com/${atsSlug}`,
    rippling: null, // SPA with signed URLs — use Google favicon
    personio: `https://${atsSlug}.jobs.personio.de`,
    breezy: `https://${atsSlug}.breezy.hr`,
    jazzhr: `https://${atsSlug}.applytojob.com`,
    workday: null, // Logo comes from adapter meta
    zoho: `https://${atsSlug}.zohorecruit.com/jobs/Careers`,
    icims: null, // Logo comes from adapter meta
    oracle: null,
    bamboohr: `https://${atsSlug}.bamboohr.com/careers`,
    taleo: null,
    pinpoint: `https://${atsSlug}.pinpointhq.com`,
    successfactors: null,
  };

  const pageUrl = pageUrls[ats];

  // Try scraping the career page for logo
  if (pageUrl) {
    try {
      const res = await fetch(pageUrl, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const html = await res.text();

        // 1. Try ATS-specific patterns
        const atsPatterns = LOGO_PATTERNS[ats] || [];
        for (const regex of atsPatterns) {
          const match = html.match(regex);
          if (match) {
            let url = match[1] || match[0];
            if (url.startsWith('//')) url = 'https:' + url;
            logger.info({ ats, atsSlug, logoUrl: url }, 'Logo found via ATS pattern');
            return url;
          }
        }

        // 2. Try generic img/meta patterns
        for (const regex of GENERIC_PATTERNS) {
          const match = html.match(regex);
          if (match && match[1] && !match[1].includes('sr-logo/') && !match[1].includes('lever-logo')) {
            let url = match[1];
            if (url.startsWith('//')) url = 'https:' + url;
            logger.info({ ats, atsSlug, logoUrl: url }, 'Logo found via generic pattern');
            return url;
          }
        }
      }
    } catch (err) {
      logger.warn({ ats, atsSlug, err: err.message }, 'Failed to fetch logo from ATS page');
    }
  }

  // 3. Clearbit Logo API — high-quality company logos
  if (domain) {
    const logoUrl = clearbitLogoUrl(domain);
    try {
      const res = await fetch(logoUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        logger.info({ ats, atsSlug, logoUrl }, 'Logo found via Clearbit');
        return logoUrl;
      }
    } catch { /* clearbit failed */ }
  }

  // 4. Google favicon as last-resort fallback
  if (domain) {
    return googleFaviconUrl(domain);
  }

  return null;
}

module.exports = { fetchLogoUrl };
