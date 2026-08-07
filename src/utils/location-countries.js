/**
 * Country resolution for job locations.
 *
 * Locations are free text from ~30 ATS platforms, so the same country arrives in every shape:
 * "London, England, GB, GB", "GB - London, United Kingdom", "Remote - United States",
 * "Navi Mumbai, Maharashtra, IN, IN". Postgres handles this with ILIKE plus a word-boundary
 * regex for short aliases (see location-aliases.js). Meilisearch has no word-boundary operator,
 * so `CONTAINS "us"` would return Houston and Austin.
 *
 * The fix is to resolve the country once, at index time, into a filterable code. An exact
 * filter on that code needs no substring matching and no fallback to Postgres.
 *
 * TWO-LETTER CODES ARE ONLY READ FROM THE LAST SEGMENT. "San Francisco, CA, US" must not be
 * tagged Canada, and "Indianapolis, IN, US" must not be tagged India — CA and IN are US state
 * codes as often as they are country codes. Country codes appear last in practice; state codes
 * do not. Spelled-out names are unambiguous and are matched anywhere in the string.
 */

// ISO 3166-1 alpha-2 -> primary name. Compact on purpose: this is data, not logic.
const TABLE = `
af:Afghanistan|al:Albania|dz:Algeria|ad:Andorra|ao:Angola|ag:Antigua and Barbuda|ar:Argentina|
am:Armenia|aw:Aruba|au:Australia|at:Austria|az:Azerbaijan|bs:Bahamas|bh:Bahrain|bd:Bangladesh|
bb:Barbados|by:Belarus|be:Belgium|bz:Belize|bj:Benin|bm:Bermuda|bt:Bhutan|bo:Bolivia|
ba:Bosnia and Herzegovina|bw:Botswana|br:Brazil|bn:Brunei|bg:Bulgaria|bf:Burkina Faso|bi:Burundi|
cv:Cabo Verde|kh:Cambodia|cm:Cameroon|ca:Canada|ky:Cayman Islands|cf:Central African Republic|
td:Chad|cl:Chile|cn:China|co:Colombia|km:Comoros|cg:Congo|cd:DR Congo|cr:Costa Rica|
ci:Cote d'Ivoire|hr:Croatia|cu:Cuba|cw:Curacao|cy:Cyprus|cz:Czechia|dk:Denmark|dj:Djibouti|
dm:Dominica|do:Dominican Republic|ec:Ecuador|eg:Egypt|sv:El Salvador|gq:Equatorial Guinea|
er:Eritrea|ee:Estonia|sz:Eswatini|et:Ethiopia|fo:Faroe Islands|fj:Fiji|fi:Finland|fr:France|
gf:French Guiana|pf:French Polynesia|ga:Gabon|gm:Gambia|ge:Georgia|de:Germany|gh:Ghana|
gi:Gibraltar|gr:Greece|gl:Greenland|gd:Grenada|gp:Guadeloupe|gu:Guam|gt:Guatemala|gg:Guernsey|
gn:Guinea|gw:Guinea-Bissau|gy:Guyana|ht:Haiti|hn:Honduras|hk:Hong Kong|hu:Hungary|is:Iceland|
in:India|id:Indonesia|ir:Iran|iq:Iraq|ie:Ireland|im:Isle of Man|il:Israel|it:Italy|jm:Jamaica|
jp:Japan|je:Jersey|jo:Jordan|kz:Kazakhstan|ke:Kenya|ki:Kiribati|kp:North Korea|kr:South Korea|
kw:Kuwait|kg:Kyrgyzstan|la:Laos|lv:Latvia|lb:Lebanon|ls:Lesotho|lr:Liberia|ly:Libya|
li:Liechtenstein|lt:Lithuania|lu:Luxembourg|mo:Macao|mg:Madagascar|mw:Malawi|my:Malaysia|
mv:Maldives|ml:Mali|mt:Malta|mh:Marshall Islands|mq:Martinique|mr:Mauritania|mu:Mauritius|
mx:Mexico|fm:Micronesia|md:Moldova|mc:Monaco|mn:Mongolia|me:Montenegro|ms:Montserrat|ma:Morocco|
mz:Mozambique|mm:Myanmar|na:Namibia|nr:Nauru|np:Nepal|nl:Netherlands|nc:New Caledonia|
nz:New Zealand|ni:Nicaragua|ne:Niger|ng:Nigeria|mk:North Macedonia|no:Norway|om:Oman|pk:Pakistan|
pw:Palau|ps:Palestine|pa:Panama|pg:Papua New Guinea|py:Paraguay|pe:Peru|ph:Philippines|pl:Poland|
pt:Portugal|pr:Puerto Rico|qa:Qatar|re:Reunion|ro:Romania|ru:Russia|rw:Rwanda|
kn:Saint Kitts and Nevis|lc:Saint Lucia|vc:Saint Vincent and the Grenadines|ws:Samoa|
sm:San Marino|st:Sao Tome and Principe|sa:Saudi Arabia|sn:Senegal|rs:Serbia|sc:Seychelles|
sl:Sierra Leone|sg:Singapore|sk:Slovakia|si:Slovenia|sb:Solomon Islands|so:Somalia|
za:South Africa|ss:South Sudan|es:Spain|lk:Sri Lanka|sd:Sudan|sr:Suriname|se:Sweden|
ch:Switzerland|sy:Syria|tw:Taiwan|tj:Tajikistan|tz:Tanzania|th:Thailand|tl:Timor-Leste|tg:Togo|
to:Tonga|tt:Trinidad and Tobago|tn:Tunisia|tr:Turkey|tm:Turkmenistan|tc:Turks and Caicos Islands|
tv:Tuvalu|ug:Uganda|ua:Ukraine|ae:United Arab Emirates|gb:United Kingdom|us:United States|
uy:Uruguay|uz:Uzbekistan|vu:Vanuatu|va:Vatican City|ve:Venezuela|vn:Vietnam|
vg:British Virgin Islands|vi:US Virgin Islands|eh:Western Sahara|ye:Yemen|zm:Zambia|zw:Zimbabwe
`;

/** code -> primary name */
const NAME = new Map();
/** normalised name or alias -> code */
const LOOKUP = new Map();

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

for (const entry of TABLE.split('|')) {
  const [code, name] = entry.split(':').map((x) => x && x.trim());
  if (!code || !name) continue;
  NAME.set(code, name);
  LOOKUP.set(code, code);
  LOOKUP.set(norm(name), code);
}

// Common variants people actually type or that ATS platforms actually emit. The UK constituent
// countries map to gb deliberately: "London, England, GB" is a United Kingdom job, and someone
// filtering by United Kingdom expects it.
const ALIASES = {
  us: ['usa', 'u.s.', 'u.s.a.', 'america', 'united states of america'],
  gb: ['uk', 'u.k.', 'britain', 'great britain', 'england', 'scotland', 'wales', 'northern ireland'],
  ae: ['uae', 'emirates'],
  nl: ['holland', 'the netherlands'],
  de: ['deutschland'],
  kr: ['korea', 'republic of korea'],
  kp: ['dprk'],
  ru: ['russian federation'],
  cz: ['czech republic'],
  ci: ['ivory coast'],
  mm: ['burma'],
  cv: ['cape verde'],
  sz: ['swaziland'],
  mk: ['macedonia'],
  va: ['vatican', 'holy see'],
  tl: ['east timor'],
  cd: ['democratic republic of the congo', 'congo-kinshasa'],
  cg: ['republic of the congo', 'congo-brazzaville'],
  tw: ['republic of china'],
  vn: ['viet nam'],
  tr: ['turkiye'],
  sy: ['syrian arab republic'],
  tz: ['united republic of tanzania'],
  bo: ['plurinational state of bolivia'],
  ve: ['bolivarian republic of venezuela'],
  ir: ['islamic republic of iran'],
  la: ["lao people's democratic republic"],
  md: ['republic of moldova'],
};
for (const [code, list] of Object.entries(ALIASES)) {
  for (const a of list) LOOKUP.set(norm(a), code);
}

/**
 * Resolve a user-supplied location term to a country.
 * Returns { code, name } for a country, or null for a city/region/anything else.
 */
function resolveCountry(term) {
  const code = LOOKUP.get(norm(term));
  return code ? { code, name: NAME.get(code) } : null;
}

/**
 * Extract country codes from a stored location string. Used at index time.
 *
 * Spelled-out names are matched in any segment. Two-letter codes are read ONLY from the final
 * segment — see the header note on CA/IN being US state codes.
 */
function countriesFromLocation(text) {
  // Dots go first so "Remote - U.S." reads as "us" in both scans below.
  const s = norm(text).replace(/\./g, '');
  if (!s) return [];

  const found = new Set();

  // Word n-grams, not substrings. A plain `includes` tags "Indianapolis" as India and
  // "Nigeria" as Niger, because both country names are substrings of the city/country that
  // contains them. Names run to four words ("saint vincent and the grenadines" is longer, but
  // its distinctive head matches at four).
  const words = s.replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const key = words.slice(i, i + n).join(' ');
      if (key.length <= 2) continue; // two-letter codes only count in the final segment, below
      const code = LOOKUP.get(key);
      if (code) found.add(code);
    }
  }

  // Trailing two-letter code: "London, England, GB, GB" -> gb. Only here, never mid-string.
  const segments = s.split(/[,/]|\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  const last = segments[segments.length - 1];
  if (last && /^[a-z]{2}$/.test(last) && NAME.has(last)) found.add(last);

  return [...found];
}

module.exports = { resolveCountry, countriesFromLocation, NAME };

/**
 * Split a stored location into filterable tokens, so the query side can use an exact filter
 * instead of a substring scan.
 *
 * "London, England, GB, GB" -> ["london", "england", "gb"]
 * "San Francisco, CA, US"   -> ["san francisco", "san", "francisco", "ca", "us"]
 *
 * Both the whole comma-separated segment AND its individual words are emitted: a user searching
 * "San Francisco" must match, and so must "Francisco". Multi-word segments are capped at four
 * words so a free-text location blob cannot explode the token list.
 */
function locationTokens(text) {
  const s = norm(text);
  if (!s) return [];
  const out = new Set();
  for (const seg of s.split(/[,/|]|\s+-\s+/).map((x) => x.trim()).filter(Boolean)) {
    const clean = seg.replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const words = clean.split(' ');
    if (words.length <= 4) out.add(clean);
    for (const w of words) if (w.length > 1) out.add(w);
  }
  return [...out];
}

module.exports.locationTokens = locationTokens;
