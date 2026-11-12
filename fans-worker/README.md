# Fans worker

`rugby-tracker-fans`: the things fans make together. Today, the **full-time
pulse**: after a game a fan taps one of three faces for their team, and the
app shows how each side's fans took it.

- **Rules and storage:** `src/pulse.js` (plain JavaScript, tested with
  `node --test fans-worker/src/` against node's own SQLite).
- **Cloudflare wiring:** `src/index.js` (one Durable Object, one SQLite file)
  and `wrangler.jsonc`.
- **Deploy:** merging a change under `fans-worker/` runs
  `.github/workflows/deploy-fans-worker.yml`: tests, deploy, then a check of
  the live Worker. Nothing to press and nothing to set up by hand; it uses the
  same `CLOUDFLARE_API_TOKEN` as the cron Worker.
- **Address:** `https://rugby-tracker-fans.4jc94jpbb7.workers.dev`
  (`GET /pulse`, `POST /pulse`, `GET /health`).

It is a separate Worker from `worker/` (the match-day scheduler) so that
nothing a fan sends can affect live scores.

## What is stored

One row per vote: the game, the side, the mood and a random number the phone
makes up for that one game, so a changed mind replaces the first answer. No
address, country, install number or time is stored. The privacy policy
(`privacy.html`) says the same, and `pulse.test.mjs` checks the columns.

## If it is abused

It cannot tell a fan from a script; there is no account, on purpose. If the
numbers are ever gamed, stop showing them in the app. Don't add sign-in.
