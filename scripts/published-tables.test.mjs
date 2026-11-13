import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { espnTable, compareTable, checkPublishedTables, tablesToCheck, fetchComparisons, standingsUrl } from "./published-tables.mjs";

// ESPN's Nations Championship table as it answered on 13 Nov 2026 (the probe
// run): both groups named "Northern Hemisphere", South Africa as SOU.
const E = (id, abbr, gp, w, d, l, pf, pa, tf, ta, bt, bl, pts) => ({
  team: { id: String(id), abbreviation: abbr },
  stats: Object.entries({ gamesPlayed: gp, gamesWon: w, gamesDrawn: d, gamesLost: l, pointsFor: pf, pointsAgainst: pa, triesFor: tf, triesAgainst: ta, bonusPointsTry: bt, bonusPointsLosing: bl, bonusPoints: bt + bl, points: pts })
    .map(([name, value]) => ({ name, value })),
});
const ESPN_RNC = { children: [
  { name: "Northern Hemisphere", standings: { entries: [
    E(9, "FRA", 4, 3, 0, 1, 170, 92, 24, 13, 4, 1, 17), E(1, "ENG", 4, 3, 0, 1, 170, 99, 26, 14, 3, 0, 15),
    E(3, "IRE", 4, 3, 0, 1, 132, 103, 19, 15, 3, 0, 15), E(2, "SCO", 4, 2, 0, 2, 129, 140, 19, 21, 3, 0, 11),
    E(4, "WAL", 4, 2, 0, 2, 88, 123, 13, 18, 2, 0, 10), E(20, "ITA", 4, 0, 0, 4, 44, 197, 6, 28, 0, 0, 0),
  ] } },
  { name: "Northern Hemisphere", standings: { entries: [
    E(5, "SOU", 4, 4, 0, 0, 196, 56, 29, 8, 4, 0, 20), E(8, "NZL", 4, 4, 0, 0, 164, 91, 25, 12, 4, 0, 20),
    E(6, "AUS", 4, 1, 0, 3, 136, 130, 21, 20, 3, 1, 8), E(10, "ARG", 4, 1, 0, 3, 109, 141, 15, 21, 2, 1, 7),
    E(23, "JPN", 4, 1, 0, 3, 83, 116, 10, 16, 0, 1, 5), E(14, "FIJ", 4, 0, 0, 4, 66, 199, 9, 30, 0, 0, 0),
  ] } },
] };

const row = (code, P, W, D, L, PF, PA, TF, TA, BPtry, BPlose, Pts) => ({ code, team: code, P, W, D, L, PF, PA, TF, TA, BPtry, BPlose, BP: BPtry + BPlose, Pts });
// Our table as it stood until 13 Nov 2026: Scotland a try bonus point short.
const OURS_BEFORE = { key: "rnc-2026", played: 24, groups: [
  { name: "North", rows: [row("FRA", 4, 3, 0, 1, 170, 92, 24, 13, 4, 1, 17), row("SCO", 4, 2, 0, 2, 129, 140, 17, 21, 2, 0, 10), row("WAL", 4, 2, 0, 2, 88, 123, 13, 18, 2, 0, 10)] },
  { name: "South", rows: [row("RSA", 4, 4, 0, 0, 196, 56, 29, 8, 4, 0, 20)] },
] };
const fixed = (e) => ({ ...e, groups: e.groups.map((g) => ({ ...g, rows: g.rows.map((r) => (r.code === "SCO" ? row("SCO", 4, 2, 0, 2, 129, 140, 19, 21, 3, 0, 11) : r)) })) });
const COMP = { key: "rnc-2026", name: "Nations Championship", season: 2026, espnLeagueId: 17567, defaultUntil: "2027-01-01" };

test("espnTable keys rows by our code from ESPN's team id, whatever ESPN calls the group or the team", () => {
  const { rows, unknown } = espnTable(ESPN_RNC);
  assert.equal(rows.size, 12);
  assert.deepEqual(unknown, []);
  assert.equal(rows.get("RSA").Pts, 20, "SOU is South Africa");
  assert.deepEqual(rows.get("SCO"), { P: 4, Pts: 11, W: 2, D: 0, L: 2, PF: 129, PA: 140, BPtry: 3, BPlose: 0, TF: 19, TA: 21 });
  assert.deepEqual(espnTable({ children: [{ standings: { entries: [E(82, "NAM", 1, 0, 0, 1, 0, 9, 0, 1, 0, 0, 0)] } }] }).unknown, ["NAM"]);
  assert.equal(espnTable(null).rows.size, 0);
});

test("the 13 Nov 2026 defect: Scotland's missing bonus point is a difference, and the fixed table is none", () => {
  const before = compareTable(OURS_BEFORE, espnTable(ESPN_RNC));
  assert.equal(before.comparable, true);
  assert.deepEqual(before.diffs.map((d) => `${d.code} ${d.field} ${d.ours}/${d.espn}`), ["SCO Pts 10/11", "SCO BPtry 2/3", "SCO TF 17/19"]);
  const after = compareTable(fixed(OURS_BEFORE), espnTable(ESPN_RNC));
  assert.deepEqual(after.diffs, []);
  assert.deepEqual(after.behind, []);
});

test("the issue names both numbers and the team's games with the try counts used", () => {
  const games = [{ date: "2026-07-18T13:10:00Z", home: { code: "FIJ" }, away: { code: "SCO" }, homeScore: 17, awayScore: 33, tries: { home: 3, away: 3 } }];
  const [p, ...rest] = checkPublishedTables([{ comp: COMP, entry: OURS_BEFORE, espn: espnTable(ESPN_RNC), games }]);
  assert.deepEqual(rest, []);
  assert.equal(p.kind, "table-differs");
  assert.equal(p.title, "rnc-2026: our table differs from ESPN's (SCO)");
  assert.match(p.detail, /\*\*SCO\*\* points: ours 10, ESPN 11/);
  assert.match(p.detail, /SCO: 2026-07-18 FIJ 17-33 SCO \(tries 3-3\)/);
  assert.deepEqual(checkPublishedTables([{ comp: COMP, entry: fixed(OURS_BEFORE), espn: espnTable(ESPN_RNC), games }]), []);
});

test("a table of zeros (a season not started, or the wrong season) is not compared", () => {
  const zeros = { children: [{ standings: { entries: [E(2, "SCO", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), E(9, "FRA", 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)] } }] };
  const c = compareTable(OURS_BEFORE, espnTable(zeros));
  assert.equal(c.comparable, false);
  assert.match(c.skipped, /empty/);
  assert.deepEqual(checkPublishedTables([{ comp: COMP, entry: OURS_BEFORE, espn: espnTable(zeros) }]), []);
  assert.equal(compareTable(OURS_BEFORE, espnTable({})).comparable, false);
});

test("a team on a different game count is a result in flight: not compared, and raised only after two days", () => {
  const ahead = structuredClone(ESPN_RNC);
  const sco = ahead.children[0].standings.entries[3];
  const set = (name, v) => { sco.stats.find((s) => s.name === name).value = v; };
  set("gamesPlayed", 5); set("gamesWon", 3); set("points", 15);
  const entry = fixed(OURS_BEFORE);
  const c = compareTable(entry, espnTable(ahead));
  assert.deepEqual(c.diffs, []);
  assert.deepEqual(c.behind, [{ code: "SCO", team: "SCO", ours: 4, espn: 5 }]);
  const now = Date.parse("2026-11-16T12:00:00Z");
  assert.deepEqual(checkPublishedTables([{ comp: COMP, entry, espn: espnTable(ahead), newestMs: now - 3600000 }], now), []);
  const late = checkPublishedTables([{ comp: COMP, entry, espn: espnTable(ahead), newestMs: now - 3 * 86400000 }], now);
  assert.equal(late.length, 1);
  assert.equal(late[0].kind, "table-games-differ");
});

test("ESPN not answering raises nothing; a column one side lacks is not a difference", () => {
  assert.deepEqual(checkPublishedTables([{ comp: COMP, entry: OURS_BEFORE, espn: null }]), []);
  const noTries = structuredClone(ESPN_RNC);
  for (const g of noTries.children) for (const e of g.standings.entries) e.stats = e.stats.filter((s) => !/tries|bonusPointsTry/i.test(s.name));
  assert.deepEqual(compareTable(OURS_BEFORE, espnTable(noTries)).diffs.map((d) => d.field), ["Pts"]);
});

test("tablesToCheck: offered competitions with an ESPN league, a season and results; the season is always in the URL", async () => {
  const registry = { competitions: [
    COMP,
    { key: "6n-2027", season: 2027, espnLeagueId: 180659, defaultUntil: "2027-04-01" }, // no results yet
    { key: "6n-2026", season: 2026, espnLeagueId: 180659, defaultUntil: "2026-04-01" }, // expired
    { key: "trc-2027", season: 2027, defaultUntil: "2028-01-01" }, // no ESPN league
  ] };
  const standings = { competitions: [OURS_BEFORE, { key: "6n-2027", played: 0, groups: [] }, { key: "6n-2026", played: 15, groups: [{ rows: [] }] }, { key: "trc-2027", played: 2, groups: [{ rows: [] }] }] };
  assert.deepEqual(tablesToCheck(registry, standings, "2026-11-13").map((t) => t.comp.key), ["rnc-2026"]);
  assert.equal(standingsUrl(COMP), "https://site.api.espn.com/apis/v2/sports/rugby/17567/standings?season=2026");

  const urls = [];
  const quiet = { log() {}, warn() {} };
  const out = await fetchComparisons(registry, standings, "2026-11-13", { fetchJson: async (u) => { urls.push(u); return ESPN_RNC; }, log: quiet });
  assert.deepEqual(urls, [standingsUrl(COMP)]);
  assert.equal(out[0].espn.rows.size, 12);
  const down = await fetchComparisons(registry, standings, "2026-11-13", { fetchJson: async () => { throw new Error("HTTP 503"); }, log: quiet });
  assert.equal(down[0].espn, null);
});

test("the daily integrity check runs the comparison", async () => {
  const src = await readFile(new URL("./check-competitions.mjs", import.meta.url), "utf8");
  assert.match(src, /checkPublishedTables\(comparisons\)/);
});
