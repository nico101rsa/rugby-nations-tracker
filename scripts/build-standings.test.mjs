import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rncPoolStage, normaliseRncGames, normaliseFixtureGames, tableGames, tally, rankRows,
  groupStandings, tableTotal, competitionEntry, buildStandings, selfCheck, serialise, changed, noteFor,
} from "./build-standings.mjs";
import { RULES } from "./competition-rules.mjs";
import * as nationsModule from "./fetch-nations.mjs";

const { computeLog } = nationsModule;

// api-sports ids of the twelve (static-fixtures.mjs)
const ID = { ENG: 386, FRA: 387, IRE: 388, ITA: 389, SCO: 390, WAL: 391, ARG: 460, AUS: 461, JPN: 463, NZL: 465, RSA: 467, FIJ: 28 };
const NAME = {
  ENG: "England", FRA: "France", IRE: "Ireland", ITA: "Italy", SCO: "Scotland", WAL: "Wales",
  ARG: "Argentina", AUS: "Australia", JPN: "Japan", NZL: "New Zealand", RSA: "South Africa", FIJ: "Fiji",
};
const SIX = ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"];

// A normalised game.
let seq = 0;
const game = (home, away, hs, as, tries = { home: 0, away: 0 }, date = null) => ({
  id: `g${++seq}`,
  date: date ?? new Date(Date.UTC(2027, 1, 1) + seq * 3600_000).toISOString(),
  home: { code: home, id: ID[home] ?? null, name: NAME[home] ?? home },
  away: { code: away, id: ID[away] ?? null, name: NAME[away] ?? away },
  homeScore: hs, awayScore: as,
  tries: tries === null ? null : { home: tries.home, away: tries.away },
});
const t = (home, away) => ({ home, away });
const byCodeRow = (rows) => Object.fromEntries(rows.map((r) => [r.code, r]));
const names = Object.fromEntries(Object.entries(NAME));

// ---------------------------------------------------------------------------
// (a) parity with computeLog (nations.json `log`)
// ---------------------------------------------------------------------------

// Deterministic PRNG so every run sees the same synthetic seasons.
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const NORTH = ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"];
const SOUTH = ["ARG", "AUS", "FIJ", "JPN", "NZL", "RSA"];
const RNC = {
  key: "rnc-2026", label: "RNC '26", name: "Nations Championship", season: 2026, structure: "conference",
  fixtureCount: 36, defaultUntil: "2026-12-05",
  teams: [...NORTH, ...SOUTH].sort(),
  groups: [{ name: "South", teams: SOUTH }, { name: "North", teams: NORTH }],
};

// A synthetic season in raw api-sports shape (what computeLog reads), its
// nations.json slim twin, and the try cache keyed by game id.
function syntheticSeason(seed, { missingTries = 0.1 } = {}) {
  const rnd = mulberry32(seed);
  const raw = [];
  const tries = {};
  let id = 90000 + seed * 100;
  let day = 0;
  for (const n of NORTH) {
    for (const s of SOUTH) {
      const [home, away] = rnd() < 0.5 ? [n, s] : [s, n];
      const hs = Math.floor(rnd() * 45);
      const as = rnd() < 0.08 ? hs : Math.floor(rnd() * 45); // the odd draw
      const g = {
        id: ++id,
        date: new Date(Date.UTC(2026, 6, 4) + day++ * 6 * 3600_000).toISOString(),
        week: String(1 + Math.floor((day - 1) / 6)),
        status: { short: "FT", long: "Finished" },
        teams: { home: { id: ID[home], name: NAME[home], logo: "" }, away: { id: ID[away], name: NAME[away], logo: "" } },
        scores: { home: hs, away: as },
      };
      raw.push(g);
      if (rnd() >= missingTries) tries[g.id] = { home: Math.floor(rnd() * 8), away: Math.floor(rnd() * 8) };
    }
  }
  const nations = {
    competition: { id: 145, name: "Nations Championship", season: 2026 },
    results: raw.map((g) => ({
      id: g.id, date: g.date, week: g.week,
      status: { short: "FT", long: "Finished", live: false },
      home: { id: g.teams.home.id, name: g.teams.home.name, logo: "", score: g.scores.home },
      away: { id: g.teams.away.id, name: g.teams.away.name, logo: "", score: g.scores.away },
    })),
  };
  return { raw, nations, tries };
}

test("(a) parity: the rnc table equals computeLog row for row, across 40 synthetic seasons", () => {
  const seen = new Set();
  let orderChecked = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { raw, nations, tries } = syntheticSeason(seed);
    const log = computeLog(raw, tries);
    const { games, excluded } = normaliseRncGames(nations, tries);
    assert.equal(excluded.length, 0);
    assert.equal(games.length, 36);
    const { groups } = groupStandings(RNC, games, RULES.rnc, names);
    const ours = groups.flatMap((g) => g.rows);
    const theirs = new Map(log.map((r) => [r.id, r]));
    for (const r of ours) {
      const l = theirs.get(r.id);
      for (const k of ["P", "W", "D", "L", "PF", "PA", "PD", "BP", "Pts"]) {
        assert.equal(r[k], l[k], `seed ${seed} ${r.code} ${k}`);
      }
      if (r.pending === 0) {
        assert.equal(r.TF, l.TF, `seed ${seed} ${r.code} TF`);
        assert.equal(r.TA, l.TA, `seed ${seed} ${r.code} TA`);
      } else {
        assert.equal(r.TF, null);
        assert.equal(r.TA, null);
      }
      if (r.decidedBy) seen.add(r.decidedBy);
    }
    // Order: computeLog's single list, filtered to each conference. Only
    // comparable where no level set reached the end of the chain (computeLog
    // then falls back to insertion order; we publish a shared rank).
    if (ours.some((r) => r.tied)) continue;
    orderChecked++;
    for (const g of groups) {
      const codes = new Set(g.rows.map((r) => r.code));
      const expected = log.filter((r) => codes.has(Object.keys(ID).find((c) => ID[c] === r.id))).map((r) => r.id);
      assert.deepEqual(g.rows.map((r) => r.id), expected, `seed ${seed} ${g.name} order`);
    }
  }
  assert.ok(orderChecked >= 30, `order compared on ${orderChecked} seasons`);
  // The chain was genuinely exercised past points.
  for (const k of ["pts", "w", "pd"]) assert.ok(seen.has(k), `some row decided by ${k}`);
});

test("(a) parity on one table: a Pts tie split by W, then PD, then PF, exactly as computeLog sorts", () => {
  // Four teams, crafted levels: A 8 pts/2W, B 8 pts/1W1D+bonuses… keep it in
  // computeLog's terms: compare orders, not hand-computed ranks.
  const raw = [
    ["ENG", "FRA", 20, 10, t(2, 1)], ["IRE", "ITA", 30, 10, t(4, 1)], ["ENG", "IRE", 10, 10, t(1, 1)],
    ["FRA", "ITA", 25, 20, t(3, 2)], ["ENG", "ITA", 15, 22, t(1, 3)], ["FRA", "IRE", 18, 12, t(2, 1)],
  ].map(([h, a, hs, as, tr], i) => ({
    id: 500 + i, date: `2027-02-0${i + 1}T15:00:00Z`, status: { short: "FT", long: "Finished" },
    teams: { home: { id: ID[h], name: NAME[h] }, away: { id: ID[a], name: NAME[a] } }, scores: { home: hs, away: as }, tr,
  }));
  const tries = Object.fromEntries(raw.map((g) => [g.id, g.tr]));
  const log = computeLog(raw, tries);
  const nations = {
    competition: { name: "Nations Championship", season: 2027 },
    results: raw.map((g) => ({ id: g.id, date: g.date, week: "1", status: { short: "FT", long: "Finished", live: false },
      home: { id: g.teams.home.id, name: g.teams.home.name, score: g.scores.home },
      away: { id: g.teams.away.id, name: g.teams.away.name, score: g.scores.away } })),
  };
  const { games } = normaliseRncGames(nations, tries);
  const codes = ["ENG", "FRA", "IRE", "ITA"];
  const ranked = rankRows(tally(games, RULES.rnc, codes, names), games, RULES.rnc);
  assert.deepEqual(ranked.rows.map((r) => r.id), log.map((r) => r.id));
});

test("(a) rncPoolStage agrees with fetch-nations' pool-stage filter whenever that is exported", { skip: typeof nationsModule.poolStageGames !== "function" && "fetch-nations.mjs has no poolStageGames yet" }, () => {
  const g = (id, week, h, a) => ({ id, week, home: { id: h }, away: { id: a } });
  const input = [
    g(1, "1", 465, 387), g(2, "2", 467, 390), g(3, "6", 386, 461), g(4, "7", 465, 387),
    g(5, undefined, 467, 390), g(6, "Finals", 388, 460), g(7, "3rd Place Final", 391, 463), g(8, "", 389, 28),
  ];
  assert.deepEqual(rncPoolStage(input), nationsModule.poolStageGames(input));
});

// ---------------------------------------------------------------------------
// (b)-(d) bonus arithmetic
// ---------------------------------------------------------------------------

test("(b) bonus points: 4 tries in a loss = 1, lose by 7 = 1, lose by 8 = 0, draw = 2 each", () => {
  const rows = byCodeRow(tally([
    game("ENG", "FRA", 30, 28, t(2, 4)), // FRA: 4 tries AND within 7 -> 2 bonus points
    game("IRE", "ITA", 20, 13, t(1, 1)), // ITA loses by 7 -> 1
    game("SCO", "WAL", 21, 13, t(2, 1)), // WAL loses by 8 -> 0
  ], RULES["6n"], SIX, names));
  assert.deepEqual([rows.FRA.BPtry, rows.FRA.BPlose, rows.FRA.BP, rows.FRA.Pts], [1, 1, 2, 2]);
  assert.deepEqual([rows.ENG.BP, rows.ENG.Pts], [0, 4]);
  assert.deepEqual([rows.ITA.BPlose, rows.ITA.Pts], [1, 1]);
  assert.deepEqual([rows.WAL.BP, rows.WAL.Pts], [0, 0]);

  const draw = byCodeRow(tally([game("ENG", "FRA", 17, 17, t(2, 2))], RULES["6n"], SIX, names));
  assert.deepEqual([draw.ENG.D, draw.ENG.Pts, draw.FRA.Pts, draw.ENG.BP], [1, 2, 2, 0]);
  const tryDraw = byCodeRow(tally([game("ENG", "FRA", 28, 28, t(4, 4))], RULES["6n"], SIX, names));
  assert.deepEqual([tryDraw.ENG.Pts, tryDraw.FRA.Pts], [3, 3]);
});

test("(b) TRC's differential try bonus: 5-2 tries = 1, 4-2 tries = 0", () => {
  const four = ["ARG", "AUS", "NZL", "RSA"];
  const a = byCodeRow(tally([game("NZL", "AUS", 35, 14, t(5, 2))], RULES.trc, four, names));
  assert.equal(a.NZL.BPtry, 1);
  assert.equal(a.NZL.Pts, 5);
  const b = byCodeRow(tally([game("NZL", "AUS", 28, 14, t(4, 2))], RULES.trc, four, names));
  assert.equal(b.NZL.BPtry, 0, "4 tries is no bonus when it is only 2 more than the opponent");
  assert.equal(b.NZL.Pts, 4);
  // A losing side can earn it too only by outscoring on tries — it can't.
  const c = byCodeRow(tally([game("RSA", "ARG", 20, 19, t(0, 3))], RULES.trc, four, names));
  assert.deepEqual([c.ARG.BPtry, c.ARG.BPlose, c.ARG.Pts], [1, 1, 2]);
});

test("(c) a game with no try counts: no try bonus, TF/TA null on both rows, pending and triesPending count it", () => {
  const games = [game("ENG", "FRA", 40, 10, null), game("IRE", "ITA", 24, 20, t(4, 2))];
  const rows = byCodeRow(tally(games, RULES["6n"], SIX, names));
  assert.deepEqual([rows.ENG.BPtry, rows.ENG.Pts, rows.ENG.pending, rows.ENG.TF, rows.ENG.TA], [0, 4, 1, null, null]);
  assert.deepEqual([rows.FRA.pending, rows.FRA.TF, rows.FRA.TA], [1, null, null]);
  assert.deepEqual([rows.IRE.TF, rows.IRE.TA, rows.IRE.pending, rows.IRE.Pts], [4, 2, 0, 5]);
  assert.deepEqual([rows.SCO.TF, rows.SCO.TA, rows.SCO.P], [0, 0, 0], "an unplayed team's 0 is a real 0");

  const comp = { key: "6n-2027", label: "6N '27", name: "Six Nations", season: 2027, structure: "table", teams: SIX, fixtureCount: 15 };
  const fixtures = games.map((g) => ({ id: g.id, date: g.date, home: g.home, away: g.away, comp: { key: "6n-2027", kind: "competition" }, homeScore: g.homeScore, awayScore: g.awayScore }));
  const espnTries = { [games[1].id]: { home: 4, away: 2 } };
  const entry = competitionEntry(comp, { fixtures, espnTries, names });
  assert.equal(entry.triesPending, 1);
  assert.equal(entry.played, 2);
});

test("(d) Grand Slam +3 only at five wins from five, and only for the Six Nations", () => {
  const sweep = ["FRA", "IRE", "ITA", "SCO", "WAL"].map((o) => game("ENG", o, 30, 10, t(3, 1)));
  const six = byCodeRow(tally(sweep, RULES["6n"], SIX, names));
  assert.deepEqual([six.ENG.W, six.ENG.GS, six.ENG.Pts], [5, 3, 23]);
  const four = byCodeRow(tally(sweep.slice(0, 4), RULES["6n"], SIX, names));
  assert.equal(four.ENG.GS, 0, "four from four is not a Grand Slam yet");
  const other = byCodeRow(tally(sweep, { ...RULES["6n"], grandSlam: 0 }, SIX, names));
  assert.equal(other.ENG.GS, 0);
  const rwc = byCodeRow(tally(sweep, RULES.rwc, SIX, names));
  assert.equal(rwc.ENG.GS, 0);
  const drawn = byCodeRow(tally([...sweep.slice(0, 4), game("ENG", "WAL", 10, 10, t(1, 1))], RULES["6n"], SIX, names));
  assert.equal(drawn.ENG.GS, 0, "a draw ends the Grand Slam");
});

// ---------------------------------------------------------------------------
// (e) Six Nations ties
// ---------------------------------------------------------------------------

// The contract's own example: IRE 24-20 ENG (4-2 tries), FRA 24-20 WAL (3-2),
// SCO 22-18 ITA (tries unknown).
const round1 = (scoItaTries = null) => [
  game("IRE", "ENG", 24, 20, t(4, 2)),
  game("FRA", "WAL", 24, 20, t(3, 2)),
  game("SCO", "ITA", 22, 18, scoItaTries),
];

test("(e) level on Pts and PD with tries pending: tied, needs tries, ranks 1-2-2-4-4-4 in code order", () => {
  const games = round1(null);
  const out = rankRows(tally(games, RULES["6n"], SIX, names), games, RULES["6n"]);
  assert.deepEqual(out.rows.map((r) => [r.rank, r.code, r.tied, r.decidedBy]), [
    [1, "IRE", false, null],
    [2, "FRA", true, "pts"], [2, "SCO", true, null],
    [4, "ENG", true, "pts"], [4, "ITA", true, null], [4, "WAL", true, null],
  ]);
  assert.deepEqual(out.unresolved, [
    { codes: ["FRA", "SCO"], rank: 2, criterion: "tf", needs: "tries" },
    { codes: ["ENG", "ITA", "WAL"], rank: 4, criterion: "tf", needs: "tries" },
  ]);
  assert.deepEqual(out.notes, [
    "France and Scotland are level on 4 points and +4; tries decide and are not in yet.",
    "England, Italy and Wales are level on 1 point and -4; tries decide and are not in yet.",
  ]);
});

test("(e) the same round with tries in: split on tries, the rest shared", () => {
  const games = round1(t(2, 1));
  const out = rankRows(tally(games, RULES["6n"], SIX, names), games, RULES["6n"]);
  assert.deepEqual(out.rows.map((r) => [r.rank, r.code, r.tied, r.decidedBy]), [
    [1, "IRE", false, null],
    [2, "FRA", false, "pts"],
    [3, "SCO", false, "tf"],
    [4, "ENG", true, "pts"], [4, "WAL", true, null],
    [6, "ITA", false, "tf"],
  ]);
  assert.deepEqual(out.unresolved, [{ codes: ["ENG", "WAL"], rank: 4, criterion: "shared", needs: "shared" }]);
  assert.deepEqual(out.notes, ["England and Wales share 4th place under the rules."]);
});

test("(e) teams yet to play share their rank with no unresolved set and no note", () => {
  // One drawn game: IRE and ENG genuinely share 1st under the rules; the four
  // who haven't played are level only because nothing has happened yet.
  const games = [game("IRE", "ENG", 10, 10, t(1, 1))];
  const out = rankRows(tally(games, RULES["6n"], SIX, names), games, RULES["6n"]);
  assert.deepEqual(out.rows.map((r) => [r.rank, r.code, r.tied, r.P]), [
    [1, "ENG", true, 1], [1, "IRE", true, 1],
    [3, "FRA", true, 0], [3, "ITA", true, 0], [3, "SCO", true, 0], [3, "WAL", true, 0],
  ]);
  assert.deepEqual(out.unresolved, [{ codes: ["ENG", "IRE"], rank: 1, criterion: "shared", needs: "shared" }]);
  assert.deepEqual(out.notes, ["England and Ireland share 1st place under the rules."]);
});

test("(e) PD splits a points tie before tries are even asked for", () => {
  const games = [game("IRE", "ENG", 30, 10, null), game("FRA", "WAL", 24, 20, t(3, 2))];
  const out = rankRows(tally(games, RULES["6n"], SIX, names), games, RULES["6n"]);
  assert.deepEqual(out.rows.slice(0, 2).map((r) => [r.code, r.rank, r.decidedBy]), [["IRE", 1, null], ["FRA", 2, "pd"]]);
});

// ---------------------------------------------------------------------------
// (f) World Cup ties: head-to-head, restart, rankings
// ---------------------------------------------------------------------------

const POOL = ["NZL", "AUS", "CHI", "HKG"];

test("(f) a two-way tie is split by head-to-head, even against a better PD", () => {
  const games = [
    game("AUS", "NZL", 28, 18, t(2, 2)), // AUS beat NZL by 10: no losing bonus
    game("NZL", "CHI", 60, 0, t(3, 0)), game("AUS", "CHI", 20, 15, t(2, 1)),
    game("NZL", "HKG", 20, 10, t(1, 1)), game("AUS", "HKG", 10, 18, t(1, 2)),
  ];
  const out = rankRows(tally(games, RULES.rwc, POOL, names), games, RULES.rwc);
  const r = byCodeRow(out.rows);
  assert.equal(r.NZL.Pts, r.AUS.Pts, "level on points");
  assert.ok(r.NZL.PD > r.AUS.PD, "NZL has the better PD");
  assert.ok(r.AUS.rank < r.NZL.rank, "AUS above on head-to-head");
  assert.equal(r.NZL.decidedBy, "h2h");
});

test("(f) a drawn head-to-head falls through to PD", () => {
  const games = [
    game("AUS", "NZL", 20, 20, t(2, 2)),
    game("NZL", "CHI", 40, 0, t(3, 0)), game("AUS", "CHI", 20, 0, t(2, 0)),
  ];
  const out = rankRows(tally(games, RULES.rwc, POOL, names), games, RULES.rwc);
  assert.deepEqual(out.rows.slice(0, 2).map((r) => [r.code, r.decidedBy]), [["NZL", null], ["AUS", "pd"]]);
});

test("(f) a three-way tie skips head-to-head, splits on PD, and the pair left restarts and resolves on head-to-head", () => {
  // NZL beat AUS, AUS beat CHI, CHI beat NZL (each by 10, no bonuses); all beat HKG.
  const games = [
    game("NZL", "AUS", 20, 10, t(2, 1)), game("AUS", "CHI", 20, 10, t(2, 1)), game("CHI", "NZL", 20, 10, t(2, 1)),
    game("NZL", "HKG", 30, 0, t(3, 0)), game("AUS", "HKG", 25, 0, t(3, 0)), game("CHI", "HKG", 25, 0, t(3, 0)),
  ];
  const out = rankRows(tally(games, RULES.rwc, POOL, names), games, RULES.rwc);
  assert.deepEqual(out.rows.map((r) => [r.rank, r.code, r.Pts, r.PD, r.decidedBy]), [
    [1, "NZL", 8, 30, null],
    [2, "AUS", 8, 25, "pd"],
    [3, "CHI", 8, 25, "h2h"],
    [4, "HKG", 0, -80, "pts"],
  ]);
  assert.equal(out.unresolved.length, 0);
});

test("(f) without the restart the same pair would fall to try difference — the restart is what reaches h2h", () => {
  const games = [
    game("NZL", "AUS", 20, 10, t(2, 1)), game("AUS", "CHI", 20, 10, t(2, 1)), game("CHI", "NZL", 20, 10, t(2, 1)),
    game("NZL", "HKG", 30, 0, t(3, 0)), game("AUS", "HKG", 25, 0, t(3, 0)), game("CHI", "HKG", 25, 0, t(3, 0)),
  ];
  const noRestart = { ...RULES.rwc, restart: false };
  const out = rankRows(tally(games, noRestart, POOL, names), games, noRestart);
  assert.equal(byCodeRow(out.rows).CHI.decidedBy === "h2h", false);
});

test("(f) a tie that reaches the World Rugby rankings stays tied, needs ranking (never computed)", () => {
  const games = [
    game("NZL", "AUS", 10, 10, t(1, 1)),
    game("NZL", "CHI", 20, 10, t(2, 1)), game("AUS", "HKG", 20, 10, t(2, 1)),
    game("NZL", "HKG", 20, 10, t(2, 1)), game("AUS", "CHI", 20, 10, t(2, 1)),
    game("CHI", "HKG", 15, 15, t(1, 1)),
  ];
  const out = rankRows(tally(games, RULES.rwc, POOL, names), games, RULES.rwc);
  assert.deepEqual(out.rows.slice(0, 2).map((r) => [r.rank, r.code, r.tied]), [[1, "AUS", true], [1, "NZL", true]]);
  assert.deepEqual(out.unresolved[0], { codes: ["AUS", "NZL"], rank: 1, criterion: "ranking", needs: "ranking" });
  assert.match(out.notes[0], /^Australia and New Zealand are level on 10 points and \+20 .*World Rugby rankings decide/);
});

test("(f) try difference with a game pending stops the walk and says it needs tries", () => {
  const games = [
    game("NZL", "AUS", 10, 10, null),
    game("NZL", "CHI", 20, 10, t(2, 1)), game("AUS", "CHI", 20, 10, t(2, 1)),
  ];
  const out = rankRows(tally(games, RULES.rwc, POOL, names), games, RULES.rwc);
  assert.deepEqual(out.unresolved[0], { codes: ["AUS", "NZL"], rank: 1, criterion: "td", needs: "tries" });
  assert.match(out.notes[0], /try difference decides/);
});

test("(f) TRC: wins, then wins among the tied, then PD", () => {
  const four = ["ARG", "AUS", "NZL", "RSA"];
  // NZL and RSA both 2W; NZL beat RSA; RSA has the better PD.
  const games = [
    game("NZL", "RSA", 20, 10, t(2, 1)), game("RSA", "ARG", 50, 0, t(2, 0)), game("NZL", "AUS", 9, 8, t(0, 0)),
    game("RSA", "AUS", 30, 10, t(2, 1)), game("ARG", "NZL", 30, 15, t(2, 1)),
  ];
  const out = rankRows(tally(games, RULES.trc, four, names), games, RULES.trc);
  const r = byCodeRow(out.rows);
  assert.equal(r.NZL.Pts, r.RSA.Pts);
  assert.equal(r.NZL.W, r.RSA.W);
  assert.ok(r.RSA.PD > r.NZL.PD, "RSA has the better PD");
  assert.ok(r.NZL.rank < r.RSA.rank);
  assert.equal(r.RSA.decidedBy, "h2hW");
});

test("rnc: a tie on Pts, W and PD falls to PF; level on all four is published shared, needs rule", () => {
  const codes = ["ENG", "FRA", "NZL", "RSA"];
  const rows = tally([
    game("ENG", "NZL", 30, 20, t(3, 2)), game("FRA", "RSA", 25, 15, t(3, 2)),
  ], RULES.rnc, codes, names);
  const out = rankRows(rows, [], RULES.rnc);
  assert.deepEqual(out.rows.slice(0, 2).map((r) => [r.code, r.decidedBy]), [["ENG", null], ["FRA", "pf"]]);
  const level = tally([game("ENG", "NZL", 30, 20, t(3, 2)), game("FRA", "RSA", 30, 20, t(3, 2))], RULES.rnc, codes, names);
  const o2 = rankRows(level, [], RULES.rnc);
  assert.deepEqual(o2.unresolved[0], { codes: ["ENG", "FRA"], rank: 1, criterion: null, needs: "rule" });
});

test("noteFor words a zero points difference and a single point", () => {
  const rows = [{ team: "A", Pts: 1, PD: 0 }, { team: "B", Pts: 1, PD: 0 }];
  assert.equal(noteFor({ rows, rank: 3, criterion: "tf", needs: "tries" }), "A and B are level on 1 point and a points difference of 0; tries decide and are not in yet.");
  assert.equal(noteFor({ rows, rank: 11, criterion: "shared", needs: "shared" }), "A and B share 11th place under the rules.");
  assert.equal(noteFor({ rows, rank: 22, criterion: "shared", needs: "shared" }), "A and B share 22nd place under the rules.");
});

// ---------------------------------------------------------------------------
// (g)-(h) structures
// ---------------------------------------------------------------------------

test("(g) a conference game credits a North row and a South row, each ranked in its own group", () => {
  const games = [game("ENG", "NZL", 30, 25, t(4, 4)), game("RSA", "FRA", 40, 3, t(6, 0))];
  const { groups } = groupStandings(RNC, games, RULES.rnc, names);
  assert.deepEqual(groups.map((g) => g.name), ["South", "North"]);
  const south = byCodeRow(groups[0].rows);
  const north = byCodeRow(groups[1].rows);
  assert.deepEqual([north.ENG.P, north.ENG.Pts, south.NZL.P, south.NZL.Pts], [1, 5, 1, 2]);
  assert.equal(groups[0].rows[0].code, "RSA");
  assert.equal(groups[1].rows[0].code, "ENG");
  assert.equal(groups[0].rows.length, 6);
  assert.ok(groups[1].rows.every((r) => NORTH.includes(r.code)));
  assert.equal(groups[0].rows.reduce((s, r) => s + r.P, 0) + groups[1].rows.reduce((s, r) => s + r.P, 0), 4);
});

const RWC = {
  key: "rwc-2027", label: "RWC '27", name: "Rugby World Cup", season: 2027, structure: "pools", fixtureCount: 36,
  defaultUntil: "2027-10-31",
  // As competitions.json carries them: the drawn letter in `pool`, `name`
  // null (the shipped app prints a pool's `name` bare).
  groups: [
    { name: null, teams: ["AUS", "HKG", "CHI", "NZL"], pool: "A" },
    { name: null, teams: ["WAL", "ENG", "TGA", "ZIM"], pool: null },
  ],
};

test("(h) pools: a group's name is the registry's pool letter (null stays null), codes without api ids have id null", () => {
  const games = [game("AUS", "HKG", 50, 5, t(8, 1)), game("ENG", "TGA", 30, 10, t(4, 1))];
  const { groups } = groupStandings(RWC, games, RULES.rwc, { ...names, HKG: "Hong Kong China", TGA: "Tonga" });
  assert.deepEqual(groups.map((g) => g.name), ["A", null]);
  // A conference side keeps its registry name; a pool letter never leaks onto it.
  const conf = { ...RWC, structure: "conference", groups: [{ name: "South", teams: ["AUS", "HKG"], pool: "Z" }, { name: "North", teams: ["ENG", "TGA"] }] };
  assert.deepEqual(groupStandings(conf, [game("AUS", "ENG", 20, 10)], RULES.rnc, names).groups.map((g) => g.name), ["South", "North"]);
  const hkg = groups[0].rows.find((r) => r.code === "HKG");
  assert.deepEqual([hkg.id, hkg.team], [null, "Hong Kong China"]);
  assert.equal(groups[0].rows.find((r) => r.code === "AUS").id, 461);
});

test("(h) pools: one game in, the unplayed pools and pairs carry no ranking needs or notes; provable", () => {
  // Review of PR #146: AUS 30-10 HKG alone used to publish provable:false and
  // "Chile and New Zealand ... the World Rugby rankings decide" for every pool.
  const games = [game("AUS", "HKG", 30, 10, t(4, 1))];
  const { groups, unresolved, notes } = groupStandings(RWC, games, RULES.rwc, names);
  assert.deepEqual(groups[0].rows.map((r) => [r.rank, r.code, r.tied]), [
    [1, "AUS", false], [2, "CHI", true], [2, "NZL", true], [4, "HKG", false],
  ]);
  assert.ok(groups[1].rows.every((r) => r.rank === 1 && r.tied && r.P === 0));
  assert.deepEqual(unresolved, []);
  assert.deepEqual(notes, []);
  const row = {
    id: "espn-rwc-1", date: "2027-10-01T10:00:00Z", comp: { key: "rwc-2027", kind: "competition" },
    home: { code: "AUS", name: "Australia" }, away: { code: "HKG", name: "Hong Kong China" }, homeScore: 30, awayScore: 10,
  };
  const entry = competitionEntry(RWC, { fixtures: { fixtures: [row] }, espnTries: { "espn-rwc-1": { home: 4, away: 1 } } });
  assert.equal(entry.played, 1);
  assert.equal(entry.provable, true);
  assert.deepEqual([entry.unresolved, entry.notes], [[], []]);
});

test("(h) a knockout and a played-0 competition yield groups null", () => {
  const pnc = { key: "pnc-2026", structure: "knockout", fixtureCount: 4, teams: ["CAN", "FIJ", "JPN", "USA"] };
  assert.equal(groupStandings(pnc, [game("JPN", "FIJ", 20, 15)], null, names).groups, null);
  assert.equal(groupStandings(RWC, [], RULES.rwc, names).groups, null);
  const entry = competitionEntry({ ...pnc, label: "PNC '26", name: "Pacific Nations Cup", season: 2026 }, { fixtures: [] });
  assert.deepEqual([entry.rules, entry.groups, entry.played, entry.total, entry.qualify], [null, null, 0, 4, null]);
});

test("pools: a knockout game between two pools is not a table game", () => {
  const games = [game("AUS", "ENG", 20, 10), game("AUS", "NZL", 20, 10)];
  const out = tableGames(RWC, games, RULES.rwc);
  assert.deepEqual(out.games.map((g) => g.id), [games[1].id]);
  assert.match(out.excluded[0].reason, /different pools/);
  assert.equal(tableTotal({ ...RWC, fixtureCount: 52 }, RULES.rwc), 12, "two 4-team pools hold 12 games whatever the fixture count");
});

// ---------------------------------------------------------------------------
// (i) carry-forward and never-backwards
// ---------------------------------------------------------------------------

const sixNations = (over = {}) => ({
  key: "6n-2027", label: "6N '27", name: "Six Nations", season: 2027, structure: "table", teams: SIX,
  fixtureCount: 15, defaultUntil: "2027-03-27", ...over,
});
const triesOf = (games) => Object.fromEntries(games.filter((g) => g.tries).map((g) => [g.id, g.tries]));
const asFixtures = (games, key = "6n-2027") => ({
  fixtures: games.map((g) => ({ id: g.id, date: g.date, home: g.home, away: g.away, comp: { key, kind: "competition" }, homeScore: g.homeScore, awayScore: g.awayScore })),
});

test("(i) an expired competition whose results left the feed keeps its table verbatim, frozen", () => {
  const games = round1(t(2, 1));
  const espnTries = triesOf(games);
  const registry = { competitions: [sixNations()] };
  const during = buildStandings({ registry, fixtures: asFixtures(games), espnTries, now: new Date("2027-02-08T00:00:00Z") });
  assert.equal(during.competitions[0].played, 3);

  // April: expired, and fixtures.json has dropped its results.
  const after = buildStandings({ registry, fixtures: { fixtures: [] }, espnTries, prev: during, now: new Date("2027-04-02T00:00:00Z") });
  assert.deepEqual(after.competitions[0], { ...during.competitions[0], frozen: true });
  // And from then on it is byte-identical, run after run.
  const later = buildStandings({ registry, fixtures: { fixtures: [] }, espnTries, prev: after, now: new Date("2027-05-01T00:00:00Z") });
  assert.equal(serialise(later), serialise(after));
});

test("(i) a still-offered competition never goes backwards: the previous entry is kept, with a warning", () => {
  const games = round1(t(2, 1));
  const registry = { competitions: [sixNations()] };
  const during = buildStandings({ registry, fixtures: asFixtures(games), now: new Date("2027-02-08T00:00:00Z") });
  const warnings = [];
  const after = buildStandings({
    registry, fixtures: asFixtures(games.slice(0, 1)), prev: during,
    now: new Date("2027-02-09T00:00:00Z"), warn: (w) => warnings.push(w),
  });
  assert.equal(after.competitions[0], during.competitions[0]);
  assert.equal(after.competitions[0].frozen, false, "only an expired key is frozen");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /6n-2027: played would drop from 3 to 1/);
  assert.equal(after.updatedAt, during.updatedAt, "nothing changed, so the timestamp holds");
});

// ---------------------------------------------------------------------------
// (j)-(k) what is not counted
// ---------------------------------------------------------------------------

const slim = (id, week, home, away, hs, as, date) => ({
  id, date, week, status: { short: "FT", long: "Finished", live: false },
  home: { id: ID[home], name: NAME[home], score: hs }, away: { id: ID[away], name: NAME[away], score: as },
});

test("(j) a finals-weekend repeat pairing lands in excluded and not in the table", () => {
  const nations = {
    competition: { name: "Nations Championship", season: 2026 },
    results: [
      slim(53213, "1", "NZL", "FRA", 34, 32, "2026-07-04T07:10:00+00:00"),
      slim(53214, "1", "RSA", "ENG", 30, 20, "2026-07-04T15:40:00+00:00"),
      // Finals weekend: France v New Zealand again, week label unknown.
      slim(54001, null, "FRA", "NZL", 25, 20, "2026-11-29T16:40:00+00:00"),
      // A labelled final and an out-of-range week.
      slim(54002, "Final", "ENG", "RSA", 18, 17, "2026-11-29T19:00:00+00:00"),
      slim(54003, "7", "IRE", "ARG", 30, 3, "2026-11-28T14:00:00+00:00"),
      // Still in play: never counted, never listed.
      { ...slim(54004, "6", "WAL", "AUS", 10, 7, "2026-11-21T20:10:00+00:00"), status: { short: "2H", long: "Second Half", live: true } },
    ],
  };
  const { games, excluded } = normaliseRncGames(nations, { 53213: t(5, 4) });
  assert.deepEqual(games.map((g) => g.id), ["53213", "53214"]);
  assert.deepEqual(games[0].tries, { home: 5, away: 4 });
  assert.equal(games[1].tries, null);
  assert.deepEqual(excluded.map((x) => x.id), ["54003", "54001", "54002"]);
  assert.match(excluded.find((x) => x.id === "54001").reason, /repeat pairing/);

  const registry = { competitions: [{ ...RNC, label: "RNC '26" }] };
  const out = buildStandings({ registry, nations, rncTries: { 53213: t(5, 4) }, now: new Date("2026-11-30T00:00:00Z") });
  const e = out.competitions[0];
  assert.equal(e.played, 2);
  assert.equal(e.excluded.length, 3);
  const nzl = e.groups[0].rows.find((r) => r.code === "NZL");
  assert.equal(nzl.P, 1, "the finals game did not add a second appearance");
});

test("(k) a 0-0 row is skipped unless a person entered it in HAND_FINALS", () => {
  const rows = [
    { id: "espn-1", date: "2027-02-06T14:10:00Z", home: { code: "SCO" }, away: { code: "ITA" }, comp: { key: "6n-2027", kind: "competition" }, homeScore: 0, awayScore: 0 },
    { id: "espn-2", date: "2027-02-06T16:40:00Z", home: { code: "FRA" }, away: { code: "WAL" }, comp: { key: "6n-2027", kind: "competition" }, homeScore: 0, awayScore: 0 },
    { id: "espn-3", date: "2027-02-05T20:10:00Z", home: { code: "IRE" }, away: { code: "ENG" }, comp: { key: "6n-2027", kind: "competition" }, homeScore: 10, awayScore: 3, status: { short: "2H", live: true } },
    { id: "espn-4", date: "2027-02-05T20:10:00Z", home: { code: "IRE" }, away: { code: "ENG" }, comp: { key: "rwc-2027", kind: "competition" }, homeScore: 10, awayScore: 3 },
  ];
  const out = normaliseFixtureGames("6n-2027", { fixtures: rows }, {}, { "espn-2": { home: 0, away: 0 } });
  assert.deepEqual(out.games.map((g) => g.id), ["espn-2"]);
  assert.deepEqual(out.excluded.map((x) => x.id), ["espn-1"]);
  assert.equal(out.games[0].home.id, ID.FRA);
});

// ---------------------------------------------------------------------------
// (l)-(n) self-check, change detection, determinism
// ---------------------------------------------------------------------------

test("(l) selfCheck passes a real entry and rejects Pts off by one and a missing team", () => {
  const games = round1(null);
  const comp = sixNations();
  const entry = competitionEntry(comp, { fixtures: asFixtures(games), names });
  assert.deepEqual(selfCheck(entry, comp), []);

  const offByOne = structuredClone(entry);
  offByOne.groups[0].rows[0].Pts += 1;
  assert.ok(selfCheck(offByOne, comp).some((p) => /Pts/.test(p)));

  const missing = structuredClone(entry);
  missing.groups[0].rows = missing.groups[0].rows.filter((r) => r.code !== "WAL");
  const problems = selfCheck(missing, comp);
  assert.ok(problems.some((p) => /WAL appears 0 times/.test(p)));
  assert.ok(problems.some((p) => /appearances/.test(p)), "ΣP no longer equals 2·played");

  const partial = structuredClone(entry);
  partial.groups[0].rows.find((r) => r.code === "SCO").TF = 2;
  assert.ok(selfCheck(partial, comp).some((p) => /TF\/TA/.test(p)), "a partial TF while pending is refused");
});

test("(m) changed() ignores updatedAt and sees any table change", () => {
  const registry = { competitions: [sixNations()] };
  const a = buildStandings({ registry, fixtures: asFixtures(round1(null)), now: new Date("2027-02-08T00:00:00Z") });
  const b = { ...a, updatedAt: "2030-01-01T00:00:00.000Z" };
  assert.equal(changed(a, b), false);
  assert.equal(changed(null, a), true);
  const c = structuredClone(a);
  c.competitions[0].triesPending = 0;
  assert.equal(changed(a, c), true);
});

test("(n) identical input gives byte-identical output; a later quiet run keeps updatedAt", () => {
  const registry = { competitions: [sixNations(), { ...RWC, teams: [] }] };
  const games = round1(null);
  const input = { registry, fixtures: asFixtures(games), espnTries: triesOf(games), now: new Date("2027-02-08T00:00:00Z") };
  const first = serialise(buildStandings(input));
  assert.equal(serialise(buildStandings(input)), first);
  const prev = JSON.parse(first);
  const quiet = buildStandings({ ...input, prev, now: new Date("2027-02-09T12:00:00Z") });
  assert.equal(serialise(quiet), first);
  // SCO v ITA's try counts arrive: the table moves, and so does updatedAt.
  const moved = buildStandings({ ...input, espnTries: { ...triesOf(games), [games[2].id]: t(2, 1) }, prev, now: new Date("2027-02-09T12:00:00Z") });
  assert.equal(moved.updatedAt, "2027-02-09T12:00:00.000Z");
  assert.equal(moved.competitions[0].triesPending, 0);
});

test("buildStandings: registry order, zero-fixture entries omitted, the contract's shape and key order", () => {
  const registry = {
    competitions: [
      sixNations(),
      { key: "trc-2026", label: "TRC '26", name: "The Rugby Championship", season: 2026, structure: null, fixtureCount: 0 },
      { ...RNC },
    ],
  };
  const games = round1(null);
  const out = buildStandings({ registry, fixtures: asFixtures(games), espnTries: triesOf(games), now: new Date("2027-02-08T00:00:00Z") });
  assert.deepEqual(Object.keys(out), ["updatedAt", "source", "competitions"]);
  assert.equal(out.source, "computed");
  assert.deepEqual(out.competitions.map((e) => e.key), ["6n-2027", "rnc-2026"]);
  const e = out.competitions[0];
  assert.deepEqual(Object.keys(e), [
    "key", "label", "name", "season", "structure", "rules", "played", "total", "complete", "completedAt",
    "triesPending", "provable", "frozen", "qualify", "groups", "unresolved", "notes", "excluded", "qualification",
  ]);
  assert.deepEqual(Object.keys(e.groups[0].rows[0]), [
    "rank", "tied", "code", "id", "team", "P", "W", "D", "L", "PF", "PA", "PD", "TF", "TA",
    "BPtry", "BPlose", "BP", "GS", "Pts", "pending", "form", "decidedBy", "q",
  ]);
  assert.equal(e.rules.id, "6n");
  assert.ok(!("note" in out.competitions[1].rules), "the rules module's internal note is not published");
  assert.equal(e.provable, false);
  assert.equal(e.triesPending, 1);
  // The rnc entry has no nations.json here, so nothing has been played.
  assert.deepEqual([out.competitions[1].played, out.competitions[1].groups], [0, null]);
});

test("complete: completedAt is stamped once and then kept", () => {
  const all = [];
  for (let i = 0; i < SIX.length; i++) for (let j = i + 1; j < SIX.length; j++) all.push(game(SIX[i], SIX[j], 20 + i, 10 + j, t(2, 1)));
  const registry = { competitions: [sixNations()] };
  const fixtures = asFixtures(all);
  const espnTries = Object.fromEntries(all.map((g) => [g.id, g.tries]));
  const first = buildStandings({ registry, fixtures, espnTries, now: new Date("2027-03-13T22:00:00Z") });
  const e = first.competitions[0];
  assert.deepEqual([e.played, e.total, e.complete, e.completedAt], [15, 15, true, "2027-03-13T22:00:00.000Z"]);
  const second = buildStandings({ registry, fixtures, espnTries, prev: first, now: new Date("2027-03-15T00:00:00Z") });
  assert.equal(second.competitions[0].completedAt, "2027-03-13T22:00:00.000Z");
  assert.equal(serialise(second), serialise(first));
  // ENG beat everyone: Grand Slam.
  assert.equal(e.groups[0].rows[0].code, "ENG");
  assert.equal(e.groups[0].rows[0].GS, 3);
  assert.deepEqual(selfCheck(e, sixNations()), []);
});
