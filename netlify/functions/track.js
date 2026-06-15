// Ingest a single quiz event (screen view, answer, branch set, complete, abandon).
// Body: { session_id, type, screen?, branch?, answer_key?, answer_value?, referrer? }
import { sessions, jsonResponse, handlePreflight, geoFromContext, shortenUA, shortenReferrer, now, isQualityLive } from './_common.js';

// Healthy Blood cholesterol quiz screens are string IDs. Map to ordinal so the
// numeric-keyed funnel + deepest_screen + screen_times stay backwards-compatible.
// (screen-q2 / screen-q3 are conditional — only statin users actually see them.)
const SCREEN_ORDER = [
  'screen-2','screen-age','screen-intro','screen-q1','screen-q2','screen-q3',
  'screen-q4','screen-q5','screen-q6','screen-q7','screen-analysis','screen-results'
];
const TOTAL_SCREENS = SCREEN_ORDER.length;
function screenOrdinal(v) {
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v !== 'string') return null;
  const idx = SCREEN_ORDER.indexOf(v);
  return idx >= 0 ? (idx + 1) : null;
}

export default async (req, context) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let payload;
  try { payload = await req.json(); } catch { return jsonResponse({ error: 'bad json' }, 400); }

  const { session_id, type } = payload || {};
  if (!session_id || !type) return jsonResponse({ error: 'session_id+type required' }, 400);

  const store = sessions();
  let s;
  try {
    s = await store.get(session_id, { type: 'json' });
  } catch {
    s = null;
  }

  const ts = now();
  if (!s) {
    const geo = geoFromContext(context);
    const fullUA = req.headers.get('user-agent');
    // Quality gate: never create a session for bots / non-target-country / junk
    // traffic. Keeps the dashboard (and the blob store) clean and accurate.
    if (!isQualityLive(geo.country, fullUA)) {
      return jsonResponse({ ok: true, skipped: 'low_quality' });
    }
    s = {
      id: session_id,
      started: ts,
      last_seen: ts,
      completed_at: null,
      abandoned_at: null,
      deepest_screen: 1,
      branch: null,
      answers: {},
      screen_times: {},  // screen_id -> first arrival ts
      events: [],
      country: geo.country,
      city: geo.city,
      region: geo.region,
      timezone: geo.timezone,
      referrer: shortenReferrer(payload.referrer || req.headers.get('referer')),
      ua: shortenUA(req.headers.get('user-agent'))
    };
  }

  s.last_seen = ts;

  // Apply event
  switch (type) {
    case 'screen_view': {
      // accept string IDs ('screen-q1') or numbers
      const ord = screenOrdinal(payload.screen);
      if (ord !== null) {
        if (ord > s.deepest_screen) s.deepest_screen = ord;
        if (!s.screen_times[ord]) s.screen_times[ord] = ts;
        // Path-tree feed: append to ordered screen sequence (de-duped consecutive)
        s.screen_path = s.screen_path || [];
        if (s.screen_path[s.screen_path.length - 1] !== ord) s.screen_path.push(ord);
        if (s.screen_path.length > 50) s.screen_path = s.screen_path.slice(-50);
      }
      break;
    }
    case 'branch_set':
      // Branch = current cholesterol protocol (Q1): statin | supplements | both | nothing
      s.branch = payload.branch || s.branch;
      break;
    case 'answer':
      if (payload.answer_key) s.answers[payload.answer_key] = payload.answer_value ?? null;
      // Q1 answer also defines the branch path, in case branch_set didn't fire.
      if (payload.answer_key === 'q1' && payload.answer_value) {
        s.branch = payload.answer_value;
      }
      break;
    case 'complete':
      s.completed_at = ts;
      s.deepest_screen = Math.max(s.deepest_screen, TOTAL_SCREENS);
      break;
    case 'abandon':
      if (!s.completed_at) s.abandoned_at = ts;
      break;
  }

  // Keep event log bounded (last 60 events per session)
  // cta_id / label / method are only set for cta_click / exit_close events
  s.events.push({
    ts, type,
    screen: payload.screen ?? null,
    branch: payload.branch ?? null,
    k: payload.answer_key ?? null,
    v: payload.answer_value ?? null,
    cta_id: payload.cta_id ?? null,
    label: payload.label ?? null,
    method: payload.method ?? null
  });
  if (s.events.length > 60) s.events = s.events.slice(-60);

  await store.set(session_id, JSON.stringify(s));
  return jsonResponse({ ok: true });
};
