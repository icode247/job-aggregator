/**
 * Route outbound fetches through Bright Data's Web Unlocker, for hosts that block us outright.
 *
 * WHY THIS EXISTS ALONGSIDE proxy.js
 * proxy.js rotates raw IPRoyal residential IPs and is metered by GB — the right tool when the
 * target merely rate-limits per IP. Workable is past that: measured 2026-08-08, the v3 jobs API
 * returned 429 on 12/12 real boards from our residential IP, instantly and with no retry-after,
 * and the HTML board fallback is an SPA shell carrying no job data. Web Unlocker solves the
 * block itself rather than just changing address.
 *
 * Same install() shape as proxy.js: monkeypatch global fetch so adapters need no changes.
 *
 * BILLING — Web Unlocker charges PER REQUEST, not per GB. A full pass over ~8k workable
 * companies is ~8k requests. Requests are therefore restricted to BD_ROUTE_HOSTS (default
 * apply.workable.com) so nothing else can quietly spend the plan; every other host keeps
 * going out direct.
 */
const fs = require('fs');
const path = require('path');

function cred(key) {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', '..', '.env');
    const line = fs.readFileSync(envPath, 'utf8').split(/\r?\n/).find((l) => l.startsWith(key + '='));
    return line ? line.slice(key.length + 1).trim() : '';
  } catch { return ''; }
}

const KEY = cred('BRIGHT_DATA_API_KEY');
const ZONE = cred('BRIGHT_DATA_ZONE') || 'web_unlocker1';
const ROUTE_HOSTS = (process.env.BD_ROUTE_HOSTS || 'apply.workable.com').split(',').map((s) => s.trim()).filter(Boolean);
const ENDPOINT = 'https://api.brightdata.com/request';

const enabled = !!KEY && process.env.BRIGHTDATA_PROXY === '1';

function shouldRoute(url) {
  try { return ROUTE_HOSTS.includes(new URL(url).hostname); } catch { return false; }
}

// Headers Bright Data reports from the upstream response that must not be replayed onto a
// Response we construct: the body we get back is already decoded, so claiming it is gzipped
// (or declaring the original length) makes undici fail to read it.
const STRIP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);

async function viaBrightData(orig, url, opts) {
  const payload = {
    zone: ZONE,
    url,
    format: 'json', // 'raw' hides upstream errors as an empty 200 body — see below
    method: (opts.method || 'GET').toUpperCase(),
  };
  if (opts.body) payload.body = typeof opts.body === 'string' ? opts.body : String(opts.body);
  if (opts.headers) payload.headers = Object.fromEntries(new Headers(opts.headers).entries());

  const res = await orig(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: opts.signal,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`BrightData HTTP ${res.status}: ${text.slice(0, 160)}`);

  // format:'json' wraps the real response. format:'raw' would return the upstream body
  // directly, but a suspended account then looks like a successful empty 200 — which is
  // exactly how the previous account's suspension went unnoticed. Keep the envelope.
  let env;
  try { env = JSON.parse(text); } catch { throw new Error(`BrightData unparseable envelope: ${text.slice(0, 160)}`); }
  if (env.status_code === undefined) throw new Error(`BrightData error: ${text.slice(0, 200)}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(env.headers || {})) {
    if (!STRIP.has(k.toLowerCase())) { try { headers.set(k, Array.isArray(v) ? v.join(', ') : String(v)); } catch { /* skip unrepresentable header */ } }
  }
  return new Response(env.body ?? '', { status: env.status_code, headers });
}

let installed = false;
/** Wrap global fetch so BD_ROUTE_HOSTS egress via Web Unlocker. Idempotent. */
function install() {
  if (!enabled || installed) return enabled && installed;
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const target = typeof url === 'string' ? url : (url && url.url) || '';
    if (!shouldRoute(target)) return orig(url, opts);
    return viaBrightData(orig, target, opts);
  };
  installed = true;
  return true;
}

module.exports = { enabled, install, shouldRoute, ROUTE_HOSTS, ZONE };
