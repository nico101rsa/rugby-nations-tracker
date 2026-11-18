# Fans worker

`rugby-tracker-fans`: the things fans make together. Two of them:

- **The pulse.** A fan taps one of three faces for their team, and the app
  shows how each side's fans feel. Asked after a game (the full-time pulse)
  and, since 18 Nov 2026, during it (the live pulse). The two are counted
  apart.
- **Fans online now.** How many phones had the app open in the last hour, and
  which teams they follow.

- **Rules and storage:** `src/pulse.js` and `src/online.js` (plain JavaScript,
  tested with `node --test fans-worker/src/*.test.mjs` against node's own
  SQLite).
- **Cloudflare wiring:** `src/index.js` (one Durable Object, one SQLite file)
  and `wrangler.jsonc`.
- **Deploy:** merging a change under `fans-worker/` runs
  `.github/workflows/deploy-fans-worker.yml`: tests, deploy, then a check of
  the live Worker. Nothing to press and nothing to set up by hand; it uses the
  same `CLOUDFLARE_API_TOKEN` as the cron Worker.
- **Address:** `https://rugby-tracker-fans.4jc94jpbb7.workers.dev`
  (`GET /pulse`, `POST /pulse`, `GET /online`, `POST /online`, `GET /health`).

It is a separate Worker from `worker/` (the match-day scheduler) so that
nothing a fan sends can affect live scores.

## What is stored

**The pulse.** One row per vote: the game, the side, the mood and a random
number the phone makes up for that one game, so a changed mind replaces the
first answer. Mid-game answers go in a table of their own (`live_votes`) with
the same four columns. No address, country, install number or time is stored.

**Online now.** One row per running app: a random number, the followed team
and when it was last heard from. The number is made each time the app starts
and kept in memory; from the version after 1.3.17 a phone that said yes to
"Count this phone?" keeps it on the phone for the day instead, so a restart
is not counted twice. A row is deleted an hour after
its last ping. No address, country or install number. Every phone is counted
(Nico, 18 Nov 2026): the "Count this phone?" answer is about the install
number, and a ping carries none and stores nothing on the phone.

The privacy policy (`privacy.html`) says the same, and the tests check the
columns of all three tables.

## What it costs

Nothing, on Cloudflare's free plan (100,000 requests and 100,000 rows written
a day). A phone pings when it opens and every ten minutes while open, and
each ping writes one row, so the busiest day so far (about 1,100 sessions) is
a few thousand of each. The count is worked out at most once every 20
seconds, whatever the traffic.

## If it is abused

It cannot tell a fan from a script; there is no account, on purpose. If the
numbers are ever gamed, stop showing them in the app. Don't add sign-in. The
online table also has a ceiling of 20,000 rows, so a flood can't fill the
store.
