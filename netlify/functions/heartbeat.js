// Lightweight presence ping. Updates last_seen so the dashboard knows who is live now.
import { sessions, jsonResponse, handlePreflight, now } from './_common.js';

export default async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

  let payload;
  try { payload = await req.json(); } catch { return jsonResponse({ error: 'bad json' }, 400); }
  const { session_id } = payload || {};
  if (!session_id) return jsonResponse({ error: 'session_id required' }, 400);

  const store = sessions();
  let s;
  try { s = await store.get(session_id, { type: 'json' }); } catch { s = null; }
  if (!s) return jsonResponse({ ok: false, reason: 'no session' }, 200);

  s.last_seen = now();
  await store.set(session_id, JSON.stringify(s));
  return jsonResponse({ ok: true });
};
