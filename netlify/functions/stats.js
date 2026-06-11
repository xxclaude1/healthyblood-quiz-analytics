// Aggregated analytics endpoint. Pull all sessions, compute everything the dashboard needs.
// GET /.netlify/functions/stats?range=1h|6h|12h|24h|7d|30d|all
// GET /.netlify/functions/stats?session=<id>          → full session detail (timeline + answers)
import { sessions, jsonResponse, handlePreflight, RANGE_MS, now } from './_common.js';

// ===== Healthy Blood cholesterol quiz screen map =====
// The quiz uses string IDs (screen-2, screen-q1, ...). We map them to ordinals so the
// numeric-keyed funnel math works, AND we expose the string IDs for the path tree.
const SCREEN_ORDER = [
  'screen-2','screen-q1','screen-q2','screen-q3','screen-q4',
  'screen-q5','screen-q6','screen-q7','screen-analysis','screen-results'
];
const SCREEN_LABELS = {
  1: 'Gender + Age',
  2: 'Q1 · Current Protocol',
  3: 'Q2 · Which Statin',
  4: 'Q3 · Side Effects',
  5: 'Q4 · LDL Number',
  6: 'Q5 · Calcium Score',
  7: 'Q6 · Biggest Worry',
  8: 'Q7 · What Matters Most',
  9: 'Analysis',
  10: 'Results'
};
const TOTAL_SCREENS = SCREEN_ORDER.length;

// "Branch" = current cholesterol protocol = Q1 answer. Four paths.
const ALL_BRANCHES = ['statin','supplements','both','nothing'];
// Q1 (current protocol) is at ordinal 2 — that's where the branch is known.
const BRANCH_KNOWN_AT = 2;

function screenOrdinal(v) {
  if (typeof v === 'number' && !isNaN(v)) return v;
  if (typeof v !== 'string') return null;
  const idx = SCREEN_ORDER.indexOf(v);
  return idx >= 0 ? (idx + 1) : null;
}
const LIVE_WINDOW_MS = 30 * 1000;  // Tightened from 60s → 30s. Heartbeats fire every 10s so this allows 3 missed pings.

function detectDevice(ua) {
  if (!ua) return 'Unknown';
  if (/iPhone|iPad|iPod/.test(ua)) return /iPad/.test(ua) ? 'Tablet' : 'iPhone';
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'Android' : 'Android Tablet';
  if (/Macintosh|Mac OS/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Other';
}

async function loadAllSessions() {
  const store = sessions();
  const listing = await store.list();
  const blobs = listing?.blobs || [];
  const all = [];
  for (let i = 0; i < blobs.length; i += 25) {
    const batch = blobs.slice(i, i + 25);
    const fetched = await Promise.all(batch.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    fetched.forEach(s => { if (s) all.push(s); });
  }
  return all;
}

export default async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);

  // ===== Single session detail mode =====
  const sessionId = url.searchParams.get('session');
  if (sessionId) {
    const store = sessions();
    const s = await store.get(sessionId, { type: 'json' }).catch(() => null);
    if (!s) return jsonResponse({ error: 'session not found' }, 404);
    return jsonResponse({
      id: s.id,
      started: s.started,
      last_seen: s.last_seen,
      completed_at: s.completed_at || null,
      abandoned_at: s.abandoned_at || null,
      deepest_screen: s.deepest_screen,
      duration_seconds: s.completed_at ? Math.round((s.completed_at - s.started) / 1000) : Math.round((s.last_seen - s.started) / 1000),
      branch: s.branch,
      country: s.country, city: s.city, region: s.region,
      referrer: s.referrer, ua: s.ua,
      device: detectDevice(s.ua),
      answers: s.answers || {},
      screen_times: s.screen_times || {},
      events: s.events || [],
      screen_labels: SCREEN_LABELS
    });
  }

  // ===== Aggregate mode =====
  const range = url.searchParams.get('range') || '24h';
  const window = RANGE_MS[range] ?? RANGE_MS['24h'];
  const cutoff = window === Infinity ? 0 : (now() - window);

  const all = await loadAllSessions();
  const inRange = all.filter(s => (s.started || 0) >= cutoff);

  const out = {
    range,
    generated_at: now(),
    totals: {
      live: 0,
      started: inRange.length,
      completed: 0,
      conversion_pct: 0,
      avg_completion_seconds: 0,
      median_completion_seconds: 0
    },
    funnel: {},
    funnel_by_branch: {},
    branch_completion: {},   // NEW: branch -> { started, completed, completion_pct }
    branches: {},
    countries: {},
    cities: {},
    referrers: {},
    devices: {},             // NEW: device label -> count
    hourly: [],              // NEW: array of {hour_iso, started, completed} for last 24 buckets
    answers: {},
    bottlenecks: [],
    durations: {},
    duration_by_branch: {},  // NEW: branch -> { screen -> avg seconds }
    live_visitors: [],
    live_active_screens: {},   // screen# -> count of live visitors currently on that step (drives green highlight)
    recent_sessions: []
  };

  // Init funnel + branch completion
  for (let i = 1; i <= TOTAL_SCREENS; i++) out.funnel[i] = 0;
  ALL_BRANCHES.forEach(b => {
    out.funnel_by_branch[b] = {};
    for (let i = BRANCH_KNOWN_AT; i <= TOTAL_SCREENS; i++) out.funnel_by_branch[b][i] = 0;
    out.branch_completion[b] = { started: 0, completed: 0, completion_pct: 0 };
    out.duration_by_branch[b] = {};
  });

  // Path-tree: every transition between screens, plus per-node live count.
  // nodes[ord] = { label, count } · edges["from>to"] = count · live_on[ord] = #live there now.
  out.path_tree = { nodes: {}, edges: {}, live_on: {} };
  for (let i = 1; i <= TOTAL_SCREENS; i++) {
    out.path_tree.nodes[i] = { ord: i, screen_id: SCREEN_ORDER[i - 1], label: SCREEN_LABELS[i] || ('Screen ' + i), count: 0 };
    out.path_tree.live_on[i] = 0;
  }

  const completionDurations = [];
  const screenDurations = {};
  const screenDurationsByBranch = {};
  for (let i = 1; i <= TOTAL_SCREENS - 1; i++) screenDurations[i] = [];
  ALL_BRANCHES.forEach(b => {
    screenDurationsByBranch[b] = {};
    for (let i = 1; i <= TOTAL_SCREENS - 1; i++) screenDurationsByBranch[b][i] = [];
  });

  // Hourly buckets — 24 buckets, ending at 'now'
  const hourMs = 60 * 60 * 1000;
  const hourBuckets = [];
  const nowHour = Math.floor(now() / hourMs) * hourMs;
  for (let h = 23; h >= 0; h--) {
    hourBuckets.push({
      hour_iso: new Date(nowHour - h * hourMs).toISOString(),
      hour_ts: nowHour - h * hourMs,
      started: 0,
      completed: 0
    });
  }

  // CTA engagement (click-through vs exit-close, per branch)
  out.cta_engagement = {
    by_branch: {},
    by_cta: {},
    by_close_method: { x: 0, no_thanks: 0 },
    totals: { clicks: 0, closes: 0, click_through_pct: 0 }
  };
  ALL_BRANCHES.forEach(b => {
    out.cta_engagement.by_branch[b] = { clicks: 0, closes: 0, click_through_pct: 0 };
  });

  inRange.forEach(s => {
    // Funnel
    for (let i = 1; i <= (s.deepest_screen || 1); i++) {
      out.funnel[i] = (out.funnel[i] || 0) + 1;
      if (s.branch && i >= BRANCH_KNOWN_AT && out.funnel_by_branch[s.branch]) {
        out.funnel_by_branch[s.branch][i] = (out.funnel_by_branch[s.branch][i] || 0) + 1;
      }
    }

    // Path-tree: per-session screen path (use stored screen_path, else derive from screen_times by ts order)
    let path = Array.isArray(s.screen_path) ? s.screen_path.slice() : null;
    if (!path && s.screen_times) {
      path = Object.entries(s.screen_times)
        .map(([k, t]) => [Number(k), Number(t)])
        .filter(([k]) => !isNaN(k))
        .sort((a, b) => a[1] - b[1])
        .map(([k]) => k);
    }
    if (path && path.length) {
      // Node visit counts (deduped consecutive — same screen back-to-back counted once)
      const seen = new Set();
      path.forEach(ord => {
        if (out.path_tree.nodes[ord]) out.path_tree.nodes[ord].count += 1;
      });
      // Edge counts
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        if (a === b) continue;
        const k = a + '>' + b;
        out.path_tree.edges[k] = (out.path_tree.edges[k] || 0) + 1;
      }
    }

    // Branch counts + completion rate per branch
    if (s.branch) {
      out.branches[s.branch] = (out.branches[s.branch] || 0) + 1;
      if (out.branch_completion[s.branch]) {
        out.branch_completion[s.branch].started += 1;
        if (s.completed_at) out.branch_completion[s.branch].completed += 1;
      }
    }

    // Geo
    if (s.country) out.countries[s.country] = (out.countries[s.country] || 0) + 1;
    if (s.city && s.country) {
      const k = `${s.city}, ${s.country}`;
      out.cities[k] = (out.cities[k] || 0) + 1;
    }

    // Referrer
    const ref = s.referrer || 'direct';
    out.referrers[ref] = (out.referrers[ref] || 0) + 1;

    // Device
    const dev = detectDevice(s.ua);
    out.devices[dev] = (out.devices[dev] || 0) + 1;

    // Hourly bucket
    if (s.started) {
      const startedHour = Math.floor(s.started / hourMs) * hourMs;
      const bucket = hourBuckets.find(h => h.hour_ts === startedHour);
      if (bucket) bucket.started += 1;
    }
    if (s.completed_at) {
      const completedHour = Math.floor(s.completed_at / hourMs) * hourMs;
      const bucket = hourBuckets.find(h => h.hour_ts === completedHour);
      if (bucket) bucket.completed += 1;
    }

    // Answers
    if (s.answers) {
      Object.entries(s.answers).forEach(([k, v]) => {
        if (v == null || v === '') return;
        out.answers[k] = out.answers[k] || {};
        const key = Array.isArray(v) ? v.join(' | ') : String(v);
        out.answers[k][key] = (out.answers[k][key] || 0) + 1;
      });
    }

    if (s.completed_at) {
      out.totals.completed += 1;
      completionDurations.push((s.completed_at - s.started) / 1000);
    }

    // Screen durations (also by branch)
    if (s.screen_times) {
      const times = Object.entries(s.screen_times)
        .map(([k, v]) => [Number(k), Number(v)])
        .sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < times.length - 1; i++) {
        const [scr, t] = times[i];
        const [, tn] = times[i + 1];
        if (screenDurations[scr]) screenDurations[scr].push(tn - t);
        if (s.branch && screenDurationsByBranch[s.branch] && screenDurationsByBranch[s.branch][scr]) {
          screenDurationsByBranch[s.branch][scr].push(tn - t);
        }
      }
    }

    // Live presence — strictly someone actively moving through the funnel.
    // Excludes completed/abandoned so "Live N" only counts in-flight visitors.
    if (s.last_seen && (now() - s.last_seen) < LIVE_WINDOW_MS && !s.completed_at && !s.abandoned_at) {
      out.totals.live += 1;
      const currentScreen = s.deepest_screen || 1;
      out.live_active_screens[currentScreen] = (out.live_active_screens[currentScreen] || 0) + 1;
      out.live_visitors.push({
        id: s.id.slice(0, 12),
        full_id: s.id,
        city: s.city || '—',
        country: s.country || '—',
        device: detectDevice(s.ua),
        branch: s.branch || null,
        screen: currentScreen,
        screen_label: SCREEN_LABELS[currentScreen] || '',
        started: s.started,
        last_seen: s.last_seen,
        completed: false
      });
    }

    // CTA engagement events scanned from per-session event log
    if (Array.isArray(s.events)) {
      const br = (s.branch && out.cta_engagement.by_branch[s.branch]) ? s.branch : null;
      s.events.forEach(ev => {
        if (ev.type === 'cta_click') {
          out.cta_engagement.totals.clicks += 1;
          if (br) out.cta_engagement.by_branch[br].clicks += 1;
          if (ev.cta_id) out.cta_engagement.by_cta[ev.cta_id] = (out.cta_engagement.by_cta[ev.cta_id] || 0) + 1;
        } else if (ev.type === 'exit_close') {
          out.cta_engagement.totals.closes += 1;
          if (br) out.cta_engagement.by_branch[br].closes += 1;
          if (ev.method && Object.prototype.hasOwnProperty.call(out.cta_engagement.by_close_method, ev.method)) {
            out.cta_engagement.by_close_method[ev.method] += 1;
          }
        }
      });
    }
  });

  // Completion %
  out.totals.conversion_pct = out.totals.started > 0
    ? Math.round((out.totals.completed / out.totals.started) * 1000) / 10
    : 0;

  // Avg + median completion times
  if (completionDurations.length > 0) {
    const sorted = completionDurations.slice().sort((a, b) => a - b);
    out.totals.avg_completion_seconds = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    out.totals.median_completion_seconds = Math.round(sorted[Math.floor(sorted.length / 2)]);
  }

  // Per-branch completion %
  ALL_BRANCHES.forEach(b => {
    const bc = out.branch_completion[b];
    bc.completion_pct = bc.started > 0 ? Math.round((bc.completed / bc.started) * 1000) / 10 : 0;
  });

  // Avg screen durations
  Object.entries(screenDurations).forEach(([scr, arr]) => {
    if (arr.length > 0) {
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      out.durations[scr] = Math.round(avg / 100) / 10;
    }
  });
  ALL_BRANCHES.forEach(b => {
    Object.entries(screenDurationsByBranch[b]).forEach(([scr, arr]) => {
      if (arr.length > 0) {
        const avg = arr.reduce((a, b2) => a + b2, 0) / arr.length;
        out.duration_by_branch[b][scr] = Math.round(avg / 100) / 10;
      }
    });
  });

  // Bottlenecks
  for (let i = 1; i <= TOTAL_SCREENS - 1; i++) {
    const from = out.funnel[i] || 0;
    const to = out.funnel[i + 1] || 0;
    if (from === 0) continue;
    const dropoff = ((from - to) / from) * 100;
    if (dropoff > 20 && from >= 5) {
      out.bottlenecks.push({
        from_screen: i,
        to_screen: i + 1,
        from_count: from,
        to_count: to,
        dropoff_pct: Math.round(dropoff * 10) / 10,
        from_label: SCREEN_LABELS[i] || `Screen ${i}`,
        to_label: SCREEN_LABELS[i + 1] || `Screen ${i + 1}`,
        avg_seconds_on_screen: out.durations[i] || null
      });
    }
  }
  out.bottlenecks.sort((a, b) => b.dropoff_pct - a.dropoff_pct);

  out.live_visitors.sort((a, b) => b.last_seen - a.last_seen);
  out.hourly = hourBuckets;

  // Recent sessions (last 100 — more, since dashboard hides most behind dropdown)
  const liveCutoff = now() - LIVE_WINDOW_MS;
  out.recent_sessions = inRange
    .slice()
    .sort((a, b) => b.started - a.started)
    .slice(0, 100)
    .map(s => {
      let status;
      if (s.completed_at) status = 'completed';
      else if (s.last_seen && s.last_seen > liveCutoff) status = 'live';
      else status = 'left';
      return {
        id: s.id.slice(0, 12),
        full_id: s.id,
        started: s.started,
        last_seen: s.last_seen,
        last_seen_seconds_ago: s.last_seen ? Math.round((now() - s.last_seen) / 1000) : null,
        branch: s.branch || null,
        deepest_screen: s.deepest_screen || 1,
        completed: !!s.completed_at,
        status: status,
        left_at_label: status === 'left' ? (SCREEN_LABELS[s.deepest_screen || 1] || ('Screen ' + (s.deepest_screen || 1))) : null,
        duration_seconds: s.completed_at ? Math.round((s.completed_at - s.started) / 1000) : Math.round(((s.last_seen || s.started) - s.started) / 1000),
        city: s.city || '—',
        country: s.country || '—',
        device: detectDevice(s.ua),
        referrer: s.referrer || 'direct'
      };
    });

  out.screen_labels = SCREEN_LABELS;
  out.branch_colors = {
    statin: '#ef4444',       // on a statin — red
    supplements: '#22c55e',  // supplements only — green
    both: '#a855f7',         // statin + supplements — purple
    nothing: '#3b82f6'       // nothing yet — blue
  };
  // Per-question color palette (used by dashboard for funnel bars) — 10 screens.
  out.question_colors = {
    1: '#0a84ff', 2: '#ef4444', 3: '#f59e0b',
    4: '#ec4899', 5: '#06b6d4', 6: '#10b981',
    7: '#a855f7', 8: '#5856d6', 9: '#34c759',
    10: '#0d2137'
  };

  // CTA engagement percentages
  const ctaTotalClicks = out.cta_engagement.totals.clicks;
  const ctaTotalCloses = out.cta_engagement.totals.closes;
  out.cta_engagement.totals.click_through_pct = (ctaTotalClicks + ctaTotalCloses) > 0
    ? Math.round((ctaTotalClicks / (ctaTotalClicks + ctaTotalCloses)) * 1000) / 10
    : 0;
  ALL_BRANCHES.forEach(b => {
    const br = out.cta_engagement.by_branch[b];
    const tot = br.clicks + br.closes;
    br.click_through_pct = tot > 0 ? Math.round((br.clicks / tot) * 1000) / 10 : 0;
  });

  return jsonResponse(out);
};
