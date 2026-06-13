// One-off / on-demand cleanup: delete stored sessions that aren't quality traffic
// (bots, Linux/Other devices, out-of-market countries). Protected by ?key=.
// Call repeatedly until {remaining:0}. GET /.netlify/functions/cleanup?key=SECRET&limit=600
import { sessions, jsonResponse, handlePreflight, isQualityStored } from './_common.js';

const SECRET = 'hb_clean_7Qx2';

export default async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;
  const url = new URL(req.url);
  if (url.searchParams.get('key') !== SECRET) return jsonResponse({ error: 'unauthorized' }, 401);

  const dryRun = url.searchParams.get('dry') === '1';
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '250', 10) || 250, 400);
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

  const store = sessions();
  const listing = await store.list();
  const blobs = (listing?.blobs || []).filter(b => !String(b.key).startsWith('_'));
  const slice = blobs.slice(offset, offset + limit);

  let checked = 0, deleted = 0, kept = 0, missing = 0;
  const CONCURRENCY = 80;
  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const batch = slice.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (b) => {
      const s = await store.get(b.key, { type: 'json' }).catch(() => null);
      checked++;
      if (!s) { missing++; return; }
      if (isQualityStored(s)) { kept++; return; }
      if (!dryRun) await store.delete(b.key).catch(() => {});
      deleted++;
    }));
  }

  // Quality/missing rows remain in the store, so the next unscanned key shifts to
  // offset + (kept + missing). For dry runs nothing is deleted, so it's offset+limit.
  const next_offset = offset + kept + missing;
  const done = checked < limit; // hit the end of the list

  return jsonResponse({
    ok: true,
    dry_run: dryRun,
    total_in_store: blobs.length,
    scanned_this_call: checked,
    junk_deleted: deleted,
    quality_kept: kept,
    missing,
    next_offset,
    done,
    note: done ? 'Done — reached the end.' : 'Call again with offset=next_offset.'
  });
};
