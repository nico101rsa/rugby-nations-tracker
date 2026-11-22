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

Nothing, on Cloudflare's free plan, whose daily allowances for the Durable
Object are 100,000 requests, 100,000 rows written and 5 million rows read.
A phone pings when it opens and every ten minutes while open, and each ping
writes one row.

**It ran out once: round 6, Sun 22 Nov 2026 (Sydney time).** From about
05:00 every route answered 503: "Exceeded allowed rows read in Durable
Objects free tier" (read from the live Worker at 11:06, once a 503 carried
its reason). It was still refusing eight minutes after 00:00 UTC, so the
reset is not on the stroke of the day. Every phone on Results asks `/pulse` once a minute
during a live game and each ask counted every vote row, and each ping
cleared and sized the whole online table. Since that day:

- the Worker hands a count it was given in the last 15 seconds to the next
  phone that asks (`makeReadCache` in `src/index.js`), so most reads never
  reach the object;
- the pulse counts are remembered in the object until a vote changes them
  (`makeTally`), so a read costs no rows;
- a ping reads by key: old rows are cleared once a minute, through an index
  on the time, and the ceiling is checked against the remembered count.

The online count is still worked out at most once every 20 seconds. If it
goes again, the 503 itself names the limit (`reason`, also printed by the
deploy check and visible with `curl <address>/health`); Workers Paid (US$5 a month) lifts them all.

## If it is abused

It cannot tell a fan from a script; there is no account, on purpose. If the
numbers are ever gamed, stop showing them in the app. Don't add sign-in. The
online table also has a ceiling of 20,000 rows, so a flood can't fill the
store.
