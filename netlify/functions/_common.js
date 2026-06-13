// Shared utilities for analytics functions
import { getStore } from '@netlify/blobs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

export const sessions = () => getStore({ name: 'quiz-sessions', consistency: 'strong' });

export function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, ...extraHeaders }
  });
}

export function handlePreflight(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  return null;
}

export function geoFromContext(context) {
  // Netlify exposes geo on context.geo for edge/serverless functions
  const g = context?.geo || {};
  return {
    country: g.country?.code || g.country?.name || null,
    city: g.city || null,
    region: g.subdivision?.name || null,
    timezone: g.timezone || null
  };
}

export function shortenUA(ua) {
  if (!ua) return null;
  const m = ua.match(/iPhone|iPad|Android|Macintosh|Windows|Linux/);
  return m ? m[0] : 'Other';
}

export function shortenReferrer(ref) {
  if (!ref) return 'direct';
  try {
    const u = new URL(ref);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return 'direct';
  }
}

export function now() {
  return Date.now();
}

// ===== Traffic quality filtering =====
// Only count real human visitors from target countries. Everything else
// (bots, crawlers, datacenter/Linux traffic, out-of-market countries) is
// dropped at ingestion AND excluded from stats, so the dashboard reflects
// only traffic worth measuring. Edit ALLOWED_COUNTRIES to change markets.
export const ALLOWED_COUNTRIES = new Set(['US', 'CA', 'GB', 'AU', 'NZ']);

// Real consumer platforms (matches shortenUA() output). Linux/Other = junk here.
const QUALITY_PLATFORMS = new Set(['iPhone', 'iPad', 'Android', 'Macintosh', 'Windows']);

export function isBotUA(ua) {
  if (!ua) return true;
  return /bot|crawl|spider|slurp|headless|phantom|puppeteer|playwright|python|curl|wget|libwww|http[-_]?client|java\/|go-http|okhttp|axios|node-fetch|facebookexternalhit|externalhit|preview|prerender|fetch|monitor|uptime|pingdom|statuscake|scan|ahrefs|semrush|mj12|dotbot|bingpreview|yandex|baidu|duckduckbot|googlebot|applebot|petalbot|gptbot|amazonbot/i.test(ua);
}

// Live check at ingestion — full user-agent string available.
export function isQualityLive(country, fullUA) {
  if (isBotUA(fullUA)) return false;
  // Desktop Linux (not Android, which contains "Linux") → treat as bot/datacenter.
  if (/Linux/i.test(fullUA || '') && !/Android/i.test(fullUA || '')) return false;
  const platform = (String(fullUA || '').match(/iPhone|iPad|Android|Macintosh|Windows/) || [])[0];
  if (!platform) return false; // unknown/Other UA
  if (!country || !ALLOWED_COUNTRIES.has(String(country).toUpperCase())) return false;
  return true;
}

// Stored-session check — ua is already shortened to a platform string.
export function isQualityStored(s) {
  if (!s) return false;
  if (!QUALITY_PLATFORMS.has(s.ua)) return false;        // drops Linux / Other / null
  if (!s.country || !ALLOWED_COUNTRIES.has(String(s.country).toUpperCase())) return false;
  return true;
}

// Time range helpers (in ms)
export const RANGE_MS = {
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  'all': Infinity
};
