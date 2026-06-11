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
