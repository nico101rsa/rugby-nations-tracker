import { test } from "node:test";
import assert from "node:assert/strict";
import { standInGames, recordFinals, saveFinals, standInAwaitingFinal, isStandIn, STAND_IN_WEEK } from "./espn-finals.mjs";
import { slimGames, poolStageGames } from "./fetch-nations.mjs";
import { applyEspnOverlay } from "./espn-live-overlay.mjs";
import { API_SPORTS_TEAMS as T } from "./static-fixtures.mjs";

// ESPN's finals-weekend listing as fixtures.json carried it on 25 Nov 2026.
const rnc = { key: "rnc-2026", label: "RNC '26", kind: "competition" };
const row = (id, date, home, away, extra = {}) => ({ id, date, timeTBC: false, home: { code: home }, away: { code: away }, comp: rnc, ...extra });
const FINALS = [
  row("espn-604011", "2026-11-27T16:40:00.000Z", "ITA", "FIJ"),
  row("espn-604012", "2026-11-27T20:10:00.000Z", "IRE", "AUS"),
  row("espn-604016", "2026-11-29T16:40:00.000Z", "FRA", "RSA"),
];
const apiGame = (id, date, home, away, { week = "6", short = "FT", long = "Finished", h = 10, a = 7 } = {}) => ({
  id, date, week, status: { short, long },
  teams: { home: { id: T[home].id, name: T[home].name }, away: { id: T[away].id, name: T[away].name } },
  scores: { home: h, away: a },
});
// The pool meetings of the same pairs, a week before: never the same game.
const POOL = [
  apiGame(53245, "2026-11-21T16:40:00+00:00", "ITA", "FIJ", { h: 16, a: 21 }),
  apiGame(53246, "2026-11-21T16:40:00+00:00", "IRE", "RSA", { h: 20, a: 17 }),
];
const quiet = { log: () => {} };

test("a final api-sports has not listed stands in, in api-sports' shape, not started", () => {
  const games = standInGames(POOL, { fixtures: FINALS }, {}, { staticRows: [] });
  assert.deepEqual(games.map((g) => g.id), ["espn-604011", "espn-604012", "espn-604016"]);
  const g = games[0];
  assert.equal(g.week, STAND_IN_WEEK);
  assert.deepEqual(g.status, { short: "NS", long: "Not Started" });
  assert.equal(g.teams.home.id, T.ITA.id);
  assert.equal(g.teams.away.name, "Fiji");
  assert.deepEqual(g.scores, { home: null, away: null });
  const { fixtures, results } = slimGames([...POOL, ...games], { table: {}, ...quiet });
  assert.equal(results.length, 2);
  assert.deepEqual(fixtures.filter(isStandIn).map((f) => f.id), ["espn-604011", "espn-604012", "espn-604016"]);
});

test("api-sports' own record replaces the stand-in, whichever way round it lists the sides", () => {
  const listed = apiGame(60001, "2026-11-27T16:45:00+00:00", "FIJ", "ITA", { week: "Final", short: "NS", long: "Not Started", h: null, a: null });
  const games = standInGames([...POOL, listed], FINALS, {}, { staticRows: [] });
  assert.deepEqual(games.map((g) => g.id), ["espn-604012", "espn-604016"]);
  // ...and a kept ESPN final for that game goes with it.
  const kept = { "espn-604011": { date: "2026-11-27T16:40:00.000Z", home: "ITA", away: "FIJ", homeScore: 20, awayScore: 24 } };
  assert.deepEqual(standInGames([...POOL, listed], FINALS, kept, { staticRows: [] }).map((g) => g.id), ["espn-604012", "espn-604016"]);
});

test("a pool game SCHEDULE already carries, a projected pairing and another competition get no stand-in", () => {
  const staticRows = [{ id: "static-r6-1", date: "2026-11-21T12:00:00+00:00", home: { id: T.WAL.id }, away: { id: T.AUS.id } }];
  const rows = [
    row("espn-1", "2026-11-21T20:10:00.000Z", "WAL", "AUS"),
    row("rnc-2026-final-1", "2026-11-29T16:40:00.000Z", "FRA", "RSA", { final: { projected: true } }),
    row("espn-2", "2026-11-28T13:10:00.000Z", "WAL", "JPN", { final: { projected: true } }),
    { ...row("espn-3", "2026-11-28T13:10:00.000Z", "ENG", "NZL"), comp: { key: "6n-2027", kind: "competition" } },
    row("espn-4", "2026-11-28T13:10:00.000Z", "ENG", "USA"),
  ];
  assert.deepEqual(standInGames([], rows, {}, { staticRows }), []);
});

test("ESPN's score reaches a stand-in in play, and its full time is kept", () => {
  const all = [...POOL, ...standInGames(POOL, FINALS, {}, { staticRows: [] })];
  const doc = slimGames(all, { table: {}, ...quiet });
  const live = applyEspnOverlay(doc, [{ key: "ITA-FIJ", date: "2026-11-27T16:40:00.000Z", home: 7, away: 3, live: true, short: "1H" }]).doc;
  const inPlay = live.results.find((r) => r.id === "espn-604011");
  assert.equal(inPlay.status.live, true);
  assert.deepEqual([inPlay.home.score, inPlay.away.score], [7, 3]);
  assert.equal(recordFinals(live, {}) && Object.keys(recordFinals(live, {})).length, 0, "a game in play is not kept");

  const done = applyEspnOverlay(doc, [{ key: "ITA-FIJ", date: "2026-11-27T16:40:00.000Z", home: 20, away: 24, live: false, short: "FT" }]).doc;
  const store = recordFinals(done, {});
  assert.deepEqual(store, { "espn-604011": { date: "2026-11-27T16:40:00.000Z", home: "ITA", away: "FIJ", homeScore: 20, awayScore: 24 } });
  assert.equal(recordFinals(done, store), store, "told once: the same final changes nothing");
});

test("a kept final outlives ESPN's listing, publishes as a result, and never reaches the pool table", () => {
  const store = { "espn-604011": { date: "2026-11-27T16:40:00.000Z", home: "ITA", away: "FIJ", homeScore: 20, awayScore: 24 } };
  // fixtures.json has dropped the played row; the other two are still listed.
  const games = standInGames(POOL, FINALS.slice(1), store, { staticRows: [] });
  const kept = games.find((g) => g.id === "espn-604011");
  assert.deepEqual(kept.status, { short: "FT", long: "Finished", via: "espn" });
  assert.deepEqual(kept.scores, { home: 20, away: 24 });
  const all = [...POOL, ...games];
  const { results, fixtures } = slimGames(all, { table: {}, ...quiet });
  const r = results.find((x) => x.id === "espn-604011");
  assert.deepEqual([r.home.name, r.home.score, r.away.name, r.away.score, r.week], ["Italy", 20, "Fiji", 24, "Finals"]);
  assert.deepEqual(r.status, { short: "FT", long: "Finished", live: false, via: "espn" });
  assert.equal(fixtures.filter(isStandIn).length, 2);
  const finished = all.filter((g) => g.status.short === "FT");
  const { kept: pool, excluded } = poolStageGames(finished);
  assert.deepEqual(pool.map((g) => g.id), [53245, 53246]);
  assert.equal(excluded[0].id, "espn-604011");
  // A row api-sports called (no `via`) carries no marker.
  assert.equal("via" in results.find((x) => x.id === 53245).status, false);
});

test("ESPN may correct its own kept final upward; the store follows", () => {
  const store = { "espn-604011": { date: "2026-11-27T16:40:00.000Z", home: "ITA", away: "FIJ", homeScore: 20, awayScore: 24 } };
  const doc = slimGames(standInGames([], [], store, { staticRows: [] }), { table: {}, ...quiet });
  const fixed = applyEspnOverlay(doc, [{ key: "ITA-FIJ", date: "2026-11-27T16:40:00.000Z", home: 20, away: 27, live: false, short: "FT" }]).doc;
  assert.equal(recordFinals(fixed, store)["espn-604011"].awayScore, 27);
});

test("saveFinals writes only when a final is new, sorted by date", () => {
  const writes = [];
  const lines = [];
  const doc = { results: [
    { id: "espn-b", date: "2026-11-28T13:10:00.000Z", status: { short: "FT", live: false, via: "espn" }, home: { id: T.WAL.id, score: 30 }, away: { id: T.JPN.id, score: 12 } },
    { id: "espn-a", date: "2026-11-27T16:40:00.000Z", status: { short: "FT", live: false, via: "espn" }, home: { id: T.ITA.id, score: 20 }, away: { id: T.FIJ.id, score: 24 } },
    { id: 53245, date: "2026-11-21T16:40:00+00:00", status: { short: "FT", live: false }, home: { id: T.ITA.id, score: 16 }, away: { id: T.FIJ.id, score: 21 } },
  ] };
  let disk = {};
  const opts = { load: () => disk, write: (p, text) => { writes.push(text); disk = JSON.parse(text); }, log: (l) => lines.push(l) };
  assert.equal(saveFinals(doc, opts), 2);
  assert.deepEqual(Object.keys(disk), ["espn-a", "espn-b"]);
  assert.match(lines[0], /kept espn-b: WAL 30-12 JPN|kept espn-a: ITA 20-24 FIJ/);
  assert.equal(saveFinals(doc, opts), 0);
  assert.equal(writes.length, 1);
});

test("the sweep asks ESPN only for a stand-in past kickoff, within a day, without a final", () => {
  const ko = Date.parse("2026-11-27T16:40:00.000Z");
  const ns = { id: "espn-604011", date: "2026-11-27T16:40:00.000Z", status: { short: "NS", live: false } };
  assert.equal(standInAwaitingFinal({ fixtures: [ns] }, ko - 60000), false);
  assert.equal(standInAwaitingFinal({ fixtures: [ns] }, ko + 3 * 3600e3), true);
  assert.equal(standInAwaitingFinal({ fixtures: [ns] }, ko + 25 * 3600e3), false);
  assert.equal(standInAwaitingFinal({ results: [{ ...ns, status: { short: "FT", live: false, via: "espn" } }] }, ko + 3 * 3600e3), false);
  assert.equal(standInAwaitingFinal({ results: [{ ...ns, id: 60001 }] }, ko + 3 * 3600e3), false);
});
