# Healthy Blood — Quiz Analytics Dashboard

Live dashboard: **https://healthyblood-quiz-analytics.netlify.app/**

A real-time funnel analytics dashboard for the Healthy Blood cholesterol quiz
(same design as the GetGrounded analytics dashboard).

## What it shows
- **Live visitors**, quizzes started, completed, and conversion rate
- **Funnel** across all 10 quiz screens with step-by-step drop-off
- **Branch split** by current protocol — On a Statin / Supplements / Both / Nothing Yet — with completion rate per path
- **Bottleneck detector** (auto-flags any screen losing >20%)
- **CTA engagement** — which "Get Healthy Blood Now" button gets clicked
- **Per-question answer distribution**, live visitor map, device/referrer/geo
- Click any session to replay its full journey · **CSV export**

## How it's wired
The quiz at **https://healthyblood-quiz.netlify.app/** (repo: `healthyblood-quiz`)
sends an event on every screen view, answer, branch, completion, and CTA click to
this site's `track` function. Data is stored in **Netlify Blobs** — no database,
no monthly cost. The dashboard polls the `stats` function every 5 seconds.

```
quiz  ──events──▶  /.netlify/functions/track  ──▶  Netlify Blobs
dashboard  ◀──json──  /.netlify/functions/stats  ◀──┘
```

## Deploy / update
Hosted on Netlify (account: xxclaude1). To redeploy after changes:

```bash
npm install
netlify deploy --prod --dir .
```

Or connect this GitHub repo to the Netlify site for automatic deploys on push
(Netlify → Site → Build & deploy → Link repository).

## Files
- `index.html` — the dashboard UI
- `netlify/functions/track.js` — receives quiz events
- `netlify/functions/stats.js` — aggregates the numbers the dashboard shows
- `netlify/functions/download.js` — CSV export
- `netlify/functions/heartbeat.js` — live-visitor presence ping
