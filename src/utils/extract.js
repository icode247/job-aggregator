/**
 * Extraction utilities for enriching job data from descriptions.
 * Extracts salary, workplace type, and employment type from free text.
 */

/**
 * Extract salary information from job description text.
 * Returns { min, max, currency, interval } or null.
 */
function extractSalary(text) {
  if (!text) return null;

  // Common currency symbols and codes
  const currencyMap = {
    '$': 'USD', '£': 'GBP', '€': 'EUR', 'A$': 'AUD', 'C$': 'CAD',
    'USD': 'USD', 'GBP': 'GBP', 'EUR': 'EUR', 'AUD': 'AUD', 'CAD': 'CAD',
    'CHF': 'CHF', 'SGD': 'SGD', 'HKD': 'HKD', 'NZD': 'NZD', 'INR': 'INR',
  };

  // Pattern: $120,000 - $180,000 or $120k - $180k
  const patterns = [
    // $120,000 - $180,000 (with optional currency code after)
    /(?<curr>[$£€]|[AC]\$)\s*(?<min>\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*[kK]?\s*(?:[-–—to]+)\s*(?:[$£€]|[AC]\$)?\s*(?<max>\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*[kK]?/,
    // 120,000 USD - 180,000 USD
    /(?<min2>\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?<curr2>USD|GBP|EUR|AUD|CAD|CHF|SGD|INR)\s*[-–—to]+\s*(?<max2>\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:USD|GBP|EUR|AUD|CAD|CHF|SGD|INR)?/,
    // $120k - $180k
    /(?<curr3>[$£€])\s*(?<min3>\d{2,4})[kK]\s*[-–—to]+\s*(?:[$£€])?\s*(?<max3>\d{2,4})[kK]/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    let min, max, currency;

    if (match.groups.curr) {
      currency = currencyMap[match.groups.curr] || 'USD';
      min = parseFloat(match.groups.min.replace(/,/g, ''));
      max = parseFloat(match.groups.max.replace(/,/g, ''));
    } else if (match.groups.curr2) {
      currency = match.groups.curr2;
      min = parseFloat(match.groups.min2.replace(/,/g, ''));
      max = parseFloat(match.groups.max2.replace(/,/g, ''));
    } else if (match.groups.curr3) {
      currency = currencyMap[match.groups.curr3] || 'USD';
      min = parseFloat(match.groups.min3) * 1000;
      max = parseFloat(match.groups.max3) * 1000;
    }

    // Handle k suffix on non-k pattern
    if (text.match(new RegExp(match[0] + '\\s*[kK]'))) {
      min *= 1000;
      max *= 1000;
    }

    // Validate ranges
    if (min >= 10000 && max >= min && max < 10000000) {
      // Detect interval
      let interval = 'yearly';
      const context = text.substring(Math.max(0, match.index - 50), match.index + match[0].length + 80).toLowerCase();
      if (/per\s*hour|hourly|\/\s*hr|\/\s*hour/.test(context)) interval = 'hourly';
      else if (/per\s*month|monthly|\/\s*month/.test(context)) interval = 'monthly';

      return {
        min: String(min),
        max: String(max),
        currency,
        interval,
      };
    }
  }

  return null;
}

/**
 * Detect workplace type from job fields.
 */
function extractWorkplaceType(title, location, description) {
  const fields = [title, location, description].filter(Boolean).join(' ').toLowerCase();

  if (/\bremote\b|\bwork from home\b|\bwfh\b|\bfully remote\b|\b100% remote\b/.test(fields)) {
    // Check if it's actually hybrid
    if (/\bhybrid\b/.test(fields)) return 'hybrid';
    return 'remote';
  }
  if (/\bhybrid\b|\bflex\s*office\b|\bpartially remote\b/.test(fields)) return 'hybrid';
  if (/\bon-site\b|\bonsite\b|\bin-office\b|\bin office\b|\bon site\b/.test(fields)) return 'onsite';

  return null;
}

/**
 * Detect employment type from job fields.
 */
function extractEmploymentType(title, description) {
  const text = [title, description].filter(Boolean).join(' ').toLowerCase();

  if (/\bfull[\s-]?time\b/.test(text)) return 'Full-time';
  if (/\bpart[\s-]?time\b/.test(text)) return 'Part-time';
  if (/\bcontract(?:or)?\b|\bfreelance\b|\b1099\b/.test(text)) return 'Contract';
  if (/\binternship\b|\bintern\b/.test(text)) return 'Internship';
  if (/\btemporary\b|\btemp\b/.test(text)) return 'Temporary';

  return null;
}

module.exports = { extractSalary, extractWorkplaceType, extractEmploymentType };
