// nations.json `triesPending`: how many finished games the log counted
// without their try counts. The app's "what they need" line trusts the table
// to the point only when this is 0, so it must count exactly the games whose
// 4+ try bonus computeLog could not award, and survive every later writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLog, countTriesPending, applyNews, preserveDigests, poolStageGames } from "./fetch-nations.mjs";

const team = (id, name) => ({ id, name, logo: "" });
const IRE = team(388, "Ireland"), ARG = team(460, "Argentina");
const FRA = team(387, "France"), FIJ = team(28, "Fiji");
const game = (id, home, away, hs, as) => ({
  id, date: "2026-11-07T12:00:00+00:00", week: "4",
  status: { short: "FT", long: "Finished" },
  teams: { home, away }, scores: { home: hs, away: as },
});

test("triesPending: a finished game with no scraped tries is pending", () => {
  const finished = [game(1, IRE, ARG, 38, 10), game(2, FRA, FIJ, 45, 12)];
  assert.equal(countTriesPending(finished, { 1: { home: 5, away: 1 } }), 1);
  assert.equal(countTriesPending(finished, {}), 2);
  assert.equal(countTriesPending(finished, { 1: { home: 5, away: 1 }, 2: { home: 6, away: 2 } }), 0);
});

test("triesPending: a scraped 0-0 try count is scraped, not pending", () => {
  // An all-penalties game: {home: 0, away: 0} is a real answer.
  assert.equal(countTriesPending([game(1, IRE, ARG, 9, 6)], { 1: { home: 0, away: 0 } }), 0);
});

test("triesPending: a game without both scores is not in the log, so not pending", () => {
  const finished = [{ ...game(1, IRE, ARG, null, null) }, { ...game(2, FRA, FIJ, 20, null) }];
  assert.equal(countTriesPending(finished, {}), 0);
  assert.equal(computeLog(finished, {}).length, 0);
});

test("triesPending: counts exactly the games whose try bonus the log is missing", () => {
  const finished = [game(1, IRE, ARG, 38, 10), game(2, FRA, FIJ, 45, 12)];
  const tries = { 1: { home: 5, away: 1 }, 2: { home: 6, away: 2 } };
  const full = computeLog(finished, tries);
  const partial = computeLog(finished, { 1: tries[1] });
  const pts = (log, id) => log.find((r) => r.id === id).Pts;
  // France's try bonus waits on game 2's scrape; everything else still adds up.
  assert.equal(pts(full, FRA.id), 5);
  assert.equal(pts(partial, FRA.id), 4);
  for (const r of partial) assert.equal(r.Pts, 4 * r.W + 2 * r.D + r.BP);
  assert.equal(countTriesPending(finished, { 1: tries[1] }), 1);
  assert.equal(countTriesPending(finished, tries), 0);
});

test("triesPending: survives the news-only refresh and the digest carry-forward", () => {
  const out = { log: [], triesPending: 2, counts: {} };
  const news = [{ title: "t", link: "l", source: "s", published: "p" }];
  assert.equal(applyNews(out, news, new Date("2026-11-07T00:00:00Z")).triesPending, 2);
  assert.equal(preserveDigests(out, { digests: { 388: {} } }).triesPending, 2);
  assert.equal(preserveDigests(out, null).triesPending, 2);
});

// ---- pool stage: finals weekend stays out of the table ----------------------
// Each side meets every opposing-conference side exactly once in weeks 1-6;
// finals weekend (27-29 Nov) pairs them again place for place, under the same
// api-sports league. Without poolStageGames the first final (Sat 28 Nov 03:40
// Sydney time) would give two rows P=7 in the table every phone reads.

const NORTH = [[386, "England"], [387, "France"], [388, "Ireland"], [389, "Italy"], [390, "Scotland"], [391, "Wales"]].map(([i, n]) => team(i, n));
const SOUTH = [[460, "Argentina"], [461, "Australia"], [463, "Japan"], [465, "New Zealand"], [467, "South Africa"], [28, "Fiji"]].map(([i, n]) => team(i, n));
const at = (id, week, day, home, away, hs, as) => ({
  ...game(id, home, away, hs, as), week, date: `2026-11-${String(day).padStart(2, "0")}T15:10:00+00:00`,
});
// The 36-game pool stage: in week w, North i hosts South (i + w) % 6. Scores
// vary so bonus points and margins are all exercised.
const POOL = [];
for (let w = 1; w <= 6; w++) {
  for (let i = 0; i < 6; i++) {
    POOL.push(at(1000 + w * 10 + i, String(w), w, NORTH[i], SOUTH[(i + w) % 6], 10 + 3 * i + w, 12 + 2 * w));
  }
}
const POOL_TRIES = Object.fromEntries(POOL.map((g, k) => [g.id, { home: k % 5, away: (k + 2) % 5 }]));
// Finals weekend: North i v South i, every one a repeat of a pool pairing.
const FINALS = NORTH.map((n, i) => at(2000 + i, "Final", 27 + Math.floor(i / 2), n, SOUTH[i], 30, 20));

test("pool stage: a week-'7' repeat pairing is excluded, with a reason", () => {
  const repeat = { ...POOL[0], id: 9001, week: "7", date: "2026-11-27T16:40:00+00:00" };
  const { kept, excluded } = poolStageGames([POOL[0], repeat]);
  assert.deepEqual(kept.map((g) => g.id), [POOL[0].id]);
  assert.equal(excluded.length, 1);
  assert.equal(excluded[0].id, 9001);
  assert.match(excluded[0].reason, /week 7/);
});

test("pool stage: a repeat pairing with no week field is excluded as a repeat", () => {
  const { week, ...noWeek } = { ...POOL[0], id: 9002, date: "2026-11-27T16:40:00+00:00" };
  assert.equal(week, "1");
  const { kept, excluded } = poolStageGames([POOL[0], noWeek]);
  assert.deepEqual(kept.map((g) => g.id), [POOL[0].id]);
  assert.deepEqual(excluded.map((x) => x.id), [9002]);
  assert.match(excluded[0].reason, /repeat pairing/);
});

test("pool stage: the pairing is unordered — the away side hosting the rematch is still a repeat", () => {
  const flipped = { ...game(9003, POOL[0].teams.away, POOL[0].teams.home, 20, 10), week: undefined, date: "2026-11-28T13:10:00+00:00" };
  assert.deepEqual(poolStageGames([POOL[0], flipped]).excluded.map((x) => x.id), [9003]);
});

test("pool stage: a week-'Finals' string is excluded", () => {
  const finals = { ...POOL[0], id: 9004, week: "Finals", date: "2026-11-29T16:40:00+00:00" };
  const { kept, excluded } = poolStageGames([POOL[0], finals]);
  assert.deepEqual(kept.map((g) => g.id), [POOL[0].id]);
  assert.deepEqual(excluded.map((x) => x.id), [9004]);
});

test("pool stage: a finals-labelled or week-7 game is excluded even with no pool twin in the cache", () => {
  // api-sports never recorded the pool meeting: the label alone has to do it.
  for (const week of ["Final", "3rd Place Final", "7", "Play-off"]) {
    const { kept, excluded } = poolStageGames([{ ...FINALS[0], week }]);
    assert.equal(kept.length, 0, `week ${week}`);
    assert.equal(excluded.length, 1, `week ${week}`);
  }
  assert.equal(poolStageGames([{ ...POOL[0], week: "0" }]).kept.length, 0, "week 0 is not pool stage");
});

test("pool stage: first meetings in weeks 1-6 are kept in input order", () => {
  const { kept, excluded } = poolStageGames([...POOL, ...FINALS]);
  assert.deepEqual(kept.map((g) => g.id), POOL.map((g) => g.id));
  assert.deepEqual(excluded.map((x) => x.id), FINALS.map((g) => g.id));
});

test("pool stage: no repeats → kept is the input, and the log and triesPending are exactly today's", () => {
  // Today's feed: weeks 1-3 played, no finals — the filter must be a no-op.
  const today = POOL.slice(0, 18);
  const { kept, excluded } = poolStageGames(today);
  assert.deepEqual(kept, today);
  assert.deepEqual(excluded, []);
  assert.deepEqual(computeLog(kept, POOL_TRIES), computeLog(today, POOL_TRIES));
  assert.equal(countTriesPending(kept, {}), countTriesPending(today, {}));
  assert.equal(countTriesPending(kept, POOL_TRIES), 0);
});

test("pool stage: with finals weekend played, every team still shows P=6 and 36 pairings", () => {
  const { kept } = poolStageGames([...POOL, ...FINALS]);
  // The app's scenarios.js (seasonInputs) expects exactly the 36 North-v-South
  // pairings behind the table.
  assert.equal(kept.length, 36);
  assert.equal(new Set(kept.map((g) => [g.teams.home.id, g.teams.away.id].sort().join("-"))).size, 36);
  const log = computeLog(kept, POOL_TRIES);
  assert.equal(log.length, 12);
  for (const r of log) {
    assert.equal(r.P, 6, `${r.team} P`);
    assert.equal(r.Pts, 4 * r.W + 2 * r.D + r.BP, `${r.team} Pts adds up`);
  }
  assert.deepEqual(log, computeLog(POOL, POOL_TRIES), "finals change nothing in the table");
  // Unfiltered, the bug: the six finals would make it P=7 on every row.
  assert.ok(computeLog([...POOL, ...FINALS], POOL_TRIES).every((r) => r.P === 7));
});

test("pool stage: triesPending ignores finals without try counts (same filter as the log)", () => {
  // The scrape only runs over the kept games, so a final never has tries;
  // counting it would hold triesPending above 0 and hide the app's scenario
  // line for a game that is not in the table.
  const { kept } = poolStageGames([...POOL, ...FINALS]);
  assert.equal(countTriesPending(kept, POOL_TRIES), 0);
  assert.equal(countTriesPending([...POOL, ...FINALS], POOL_TRIES), 6);
});

test("pool stage: the slim nations.json shape ({home:{id}, away:{id}}) is accepted", () => {
  const slim = (g) => ({
    id: g.id, date: g.date, week: g.week, status: g.status,
    home: { id: g.teams.home.id, name: g.teams.home.name, score: g.scores.home },
    away: { id: g.teams.away.id, name: g.teams.away.name, score: g.scores.away },
  });
  const { kept, excluded } = poolStageGames([...POOL, ...FINALS].map(slim));
  assert.equal(kept.length, 36);
  assert.deepEqual(excluded.map((x) => x.id), FINALS.map((g) => g.id));
  // A slim rematch with no week is caught on the pairing alone.
  const rematch = { ...slim(POOL[5]), id: 9005, week: undefined, date: "2026-11-28T16:40:00+00:00" };
  assert.deepEqual(poolStageGames([slim(POOL[5]), rematch]).excluded.map((x) => x.id), [9005]);
});
