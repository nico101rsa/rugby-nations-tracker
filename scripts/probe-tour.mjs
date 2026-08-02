// Match-day api-sports probe for the 2026 All Blacks tour midweek games.
//
// T1 research (2026-08-02) could not confirm whether api-sports carries
// national-team-vs-franchise tour matches — the key lives only as an Actions
// secret, and all circumstantial evidence says no. This settles it the cheap
// way: on each of the four tour match days, ONE `/games?date=` request from
// the refresh job (the endpoint the pipeline already uses; 1 of the 100/day
// budget). Three outcomes, all logged loudly so the Actions page answers the
// T5 question ("can we live-poll these?") without re-instrumenting:
//
//   - game found, finished  -> auto-fill the score into
//                              scripts/tour-results.json (seed-tour.mjs merges
//                              it into fixtures.json; a HAND_RESULTS edit
//                              still wins)
//   - game found, not done  -> record found:true — evidence to enable live
//                              polling for the remaining games (T5)
//   - game absent           -> record found:false — the hand-edited seed is
//                              the results path, as expected
//
// BUDGET DISCIPLINE. The refresh cron fires every 15 min, so the "probed"
// ledger in tour-results.json is what caps spend at 1 request per match day:
// a day is marked probed on ANY completed request, and later ticks skip. The
// probe waits until kickoff + 150 min (fetch-nations' POST_MS settle) so the
// single shot lands after the final whistle and can carry the score.
//
// Degrades gracefully without RUGBY_API_KEY (local runs): logs and skips.

import { readFile, writeFile } from "node:fs/promises";
import { tourFixtures, RESULTS_FILE } from "./seed-tour.mjs";

const BASE = "https://v1.rugby.api-sports.io";
const SETTLE_MS = 150 * 60000; // kickoff + play + HT + FT settle (= POST_MS)

const utcDay = (d) => new Date(d).toISOString().slice(0, 10);

export async function loadStore(file = RESULTS_FILE) {
  try {
    const s = JSON.parse(await readFile(file, "utf8"));
    return { probed: s.probed ?? {}, results: s.results ?? {} };
  } catch {
    return { probed: {}, results: {} };
  }
}

// Which tour fixture (if any) is due a probe right now: same UTC day, past
// the settle window, not already probed.
export function probeDue(now, store, fixtures = tourFixtures()) {
  const t = new Date(now).getTime();
  return (
    fixtures.find((f) => {
      const day = utcDay(f.date);
      if (day !== utcDay(now)) return false;
      if (t < new Date(f.date).getTime() + SETTLE_MS) return false;
      return !store.probed[day];
    }) ?? null
  );
}

// Find the tour game in an api-sports day listing. NZ appears under its
// national-team name; the franchise side could be styled many ways ("DHL
// Stormers", "Vodacom Bulls"), so match NZ exactly + the franchise by
// substring. Vendor id spaces differ, so names are all we have.
export function matchTourGame(games, fixture) {
  return (
    games.find((g) => {
      const names = [g.teams?.home?.name ?? "", g.teams?.away?.name ?? ""];
      const nz = names.findIndex((n) => n === "New Zealand" || n === "All Blacks");
      if (nz === -1) return false;
      return names[1 - nz].toLowerCase().includes(fixture.home.name.toLowerCase());
    }) ?? null
  );
}

const isFinished = (g) => (g.status?.short ?? "") === "FT" || /finished/i.test(g.status?.long ?? "");

// One probe: fetch the day, look for the game, update the store. Pure-ish —
// fetch + clock injectable for tests. Returns what happened (for the caller's
// log line); the store write is the durable outcome.
export async function runTourProbe({
  now = new Date(),
  key = process.env.RUGBY_API_KEY,
  fetchGames,
  file = RESULTS_FILE,
} = {}) {
  const store = await loadStore(file);
  const fixture = probeDue(now, store);
  if (!fixture) return { probed: false, reason: "no tour probe due" };
  if (!key) {
    // Never mark the day probed on a skip: the next CI tick (which has the
    // key) should still get its one shot.
    console.log(`[tour-probe] ${fixture.id}: due but no RUGBY_API_KEY — skipping (local run?)`);
    return { probed: false, reason: "no key" };
  }
  const day = utcDay(fixture.date);
  const doFetch =
    fetchGames ??
    (async (date) => {
      const r = await fetch(`${BASE}/games?date=${date}`, { headers: { "x-apisports-key": key } });
      const j = await r.json();
      return j.response ?? [];
    });
  let games;
  try {
    games = await doFetch(day);
  } catch (e) {
    // Request failed → nothing spent learned; leave the day unprobed so a
    // later tick retries (the ledger only caps SUCCESSFUL requests, and a
    // hard vendor outage self-limits anyway).
    console.warn(`[tour-probe] ${fixture.id}: request failed (${e.message}) — will retry next tick`);
    return { probed: false, reason: "fetch failed" };
  }

  const game = matchTourGame(games, fixture);
  const entry = { fixtureId: fixture.id, found: !!game, probedAt: new Date(now).toISOString() };
  if (game) {
    entry.gameId = game.id ?? null;
    entry.status = game.status?.short ?? game.status?.long ?? null;
    console.log(
      `[tour-probe] ${fixture.id}: api-sports CARRIES this game (id=${entry.gameId}, ` +
        `status=${entry.status}, league=${game.league?.name ?? "?"} #${game.league?.id ?? "?"}) — ` +
        `live polling for remaining tour games is viable (T5)`,
    );
    if (isFinished(game) && game.scores?.home != null && game.scores?.away != null) {
      // Vendor lists the franchise/NZ either way round; ours is franchise-home.
      const nzHome = ["New Zealand", "All Blacks"].includes(game.teams?.home?.name);
      store.results[fixture.id] = nzHome
        ? { home: game.scores.away, away: game.scores.home }
        : { home: game.scores.home, away: game.scores.away };
      console.log(`[tour-probe] ${fixture.id}: result auto-filled ${JSON.stringify(store.results[fixture.id])}`);
    } else {
      console.log(`[tour-probe] ${fixture.id}: game not finished at probe time — no score captured`);
    }
  } else {
    console.log(
      `[tour-probe] ${fixture.id}: NOT in api-sports (${games.length} games listed for ${day}) — ` +
        `hand-edit HAND_RESULTS in scripts/seed-tour.mjs with the final score`,
    );
  }
  store.probed[day] = entry;
  await writeFile(file, JSON.stringify(store, null, 1) + "\n");
  return { probed: true, found: !!game, result: store.results[fixture.id] ?? null };
}
