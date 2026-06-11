// CSV export of every session in scope.
// GET /.netlify/functions/download?range=all
import { sessions, handlePreflight, CORS, RANGE_MS, now } from './_common.js';

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (s.includes('"') || s.includes(',') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

export default async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const range = url.searchParams.get('range') || 'all';
  const window = RANGE_MS[range] ?? RANGE_MS['all'];
  const cutoff = window === Infinity ? 0 : (now() - window);

  const store = sessions();
  const listing = await store.list();
  const blobs = listing?.blobs || [];

  const all = [];
  for (let i = 0; i < blobs.length; i += 25) {
    const batch = blobs.slice(i, i + 25);
    const fetched = await Promise.all(batch.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    fetched.forEach(s => { if (s) all.push(s); });
  }

  const filtered = all.filter(s => (s.started || 0) >= cutoff);

  const headers = [
    'session_id','started_iso','last_seen_iso','completed_iso','abandoned_iso',
    'branch','deepest_screen','completed','duration_seconds',
    'country','city','region','referrer','ua',
    'gender','age','identity','primary_concern','duration_answer','severity','confession_1',
    'mirror_crack','sunk_cost','money_pit','dark_empathy','commitment'
  ];

  const rows = [headers.map(csvEscape).join(',')];
  filtered.forEach(s => {
    const a = s.answers || {};
    const dur = s.completed_at && s.started ? Math.round((s.completed_at - s.started) / 1000) : '';
    const row = [
      s.id,
      s.started ? new Date(s.started).toISOString() : '',
      s.last_seen ? new Date(s.last_seen).toISOString() : '',
      s.completed_at ? new Date(s.completed_at).toISOString() : '',
      s.abandoned_at ? new Date(s.abandoned_at).toISOString() : '',
      s.branch || '',
      s.deepest_screen || '',
      s.completed_at ? 'yes' : 'no',
      dur,
      s.country || '',
      s.city || '',
      s.region || '',
      s.referrer || '',
      s.ua || '',
      a.actualGender || '',
      a.age || '',
      Array.isArray(a.identity) ? a.identity.join(' | ') : (a.identity || ''),
      a.primaryConcern || a.branch || '',
      a.duration || '',
      a.severity || '',
      a.confession1 || '',
      a.mirrorCrack || '',
      Array.isArray(a.sunkCost) ? a.sunkCost.join(' | ') : (a.sunkCost || ''),
      a.moneyPit || '',
      a.darkEmpathy || '',
      a.commitment || ''
    ];
    rows.push(row.map(csvEscape).join(','));
  });

  const csv = rows.join('\n');
  const today = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="healthyblood-quiz-${range}-${today}.csv"`
    }
  });
};
