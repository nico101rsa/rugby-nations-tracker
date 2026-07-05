# Rugby Nations Tracker — pages + data

Public companion repo for the **Rugby Nations Tracker** iOS app. Serves via GitHub Pages:

- [`index.html`](index.html) — support page (App Store support URL)
- [`privacy.html`](privacy.html) — privacy policy (App Store privacy URL)
- [`nations.json`](nations.json) — match data the app fetches (fixtures, results, standings, news)

## Data pipeline

`.github/workflows/refresh-data.yml` runs every 2 hours: it pulls Nations Championship
games from api-sports (key stored as the `RUGBY_API_KEY` Actions secret — one call per
day in a 7-day window, ~96 calls/day against the 100/day free-tier quota), scrapes try
counts from ESPN for bonus points, rebuilds the log, grabs news headlines, and commits
`nations.json` back to this repo. GitHub Pages then serves it from the CDN edge:

```
https://nico101rsa.github.io/rugby-nations-tracker/nations.json
```

**Source of truth for the scripts** is the private app repo
(`nico101rsa/rugby-nations-tracker-app`, `scripts/`). The copies here are the deploy
artifacts — if you change the fetch logic there, re-copy it here.

The app itself (React/Vite, wrapped with Capacitor) lives in the private repo. This is
an unofficial fan project, not affiliated with World Rugby or any national union.
