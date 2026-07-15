// scripts/fetch-stats.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIncidents, reconcile, buildAggregates, findEvent, decideAlert, runPipeline } from "./fetch-stats.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/incidents-nzl-fra.json", import.meta.url), "utf8"));

test("parseIncidents: full real match — counts, order, fields", () => {
  const { scoring, cards, unknown } = parseIncidents(FIXTURE.data.incidents);
  assert.equal(scoring.length, 18); // 9 tries + 6 conversions + 3 penalties
  assert.equal(scoring.filter((s) => s.type === "try").length, 9);
  assert.equal(scoring.filter((s) => s.type === "conversion").length, 6);
  assert.equal(scoring.filter((s) => s.type === "penalty").length, 3);
  assert.equal(cards.length, 1);
  assert.deepEqual(cards[0], { min: 2, team: "home", type: "yellow", player: "Ruben Love" });
  assert.deepEqual(unknown, []);
  // chronological (fixture arrives newest-first; parser must sort ascending)
  assert.deepEqual(scoring[0], { min: 2, team: "away", type: "try", player: "Damian Penaud", after: [0, 5] });
  assert.deepEqual(scoring.at(-1), { min: 78, team: "away", type: "conversion", player: "Antoine Hastoy", after: [34, 32] });
});

test("parseIncidents: substitutions and periods are skipped", () => {
  const { scoring, cards } = parseIncidents(FIXTURE.data.incidents);
  const all = [...scoring, ...cards];
  assert.ok(all.every((e) => e.type !== undefined));
  assert.equal(all.length, 19); // nothing else leaks through
});

test("parseIncidents: unknown goal class is collected, not guessed", () => {
  const { scoring, unknown } = parseIncidents([
    { time: 10, incidentType: "goal", incidentClass: "somethingNew", player: { name: "X" }, isHome: true },
  ]);
  assert.equal(scoring.length, 0);
  assert.deepEqual(unknown, ["goal:somethingNew"]);
});

test("parseIncidents: red card and drop goal map when they appear", () => {
  const { scoring, cards, unknown } = parseIncidents([
    { time: 55, incidentType: "goal", incidentClass: "dropGoal", player: { name: "K" }, isHome: false, homeScore: 3, awayScore: 3 },
    { time: 20, incidentType: "card", incidentClass: "red", player: { name: "R" }, isHome: true },
    { time: 60, incidentType: "card", incidentClass: "yellowRed", player: { name: "S" }, isHome: false },
  ]);
  assert.equal(scoring[0].type, "dropGoal");
  assert.deepEqual(cards.map((c) => c.type), ["red", "red"]); // yellowRed counts as red
  assert.deepEqual(unknown, []);
});

test("parseIncidents: empty input → empty output (negative case)", () => {
  assert.deepEqual(parseIncidents([]), { scoring: [], cards: [], unknown: [] });
});

test("parseIncidents: missing player field yields player:null (penalty try shape)", () => {
  const { scoring, unknown } = parseIncidents([
    { time: 9, incidentType: "goal", incidentClass: "penaltyTry", isHome: true, homeScore: 7, awayScore: 0 },
  ]);
  assert.deepEqual(scoring[0], { min: 9, team: "home", type: "penaltyTry", player: null, after: [7, 0] });
  assert.deepEqual(unknown, []);
});

test("parseIncidents: 'drop' class aliases to dropGoal", () => {
  const { scoring } = parseIncidents([
    { time: 12, incidentType: "goal", incidentClass: "drop", player: { name: "D" }, isHome: false, homeScore: 0, awayScore: 3 },
  ]);
  assert.equal(scoring[0].type, "dropGoal");
});

test("reconcile: real match sums to 34-32", () => {
  const { scoring } = parseIncidents(FIXTURE.data.incidents);
  const r = reconcile(scoring, 34, 32);
  assert.equal(r.ok, true);
  assert.deepEqual(r.home, { expected: 34, computed: 34 });
  assert.deepEqual(r.away, { expected: 32, computed: 32 });
});

test("reconcile: one point off fails the gate (negative case)", () => {
  const { scoring } = parseIncidents(FIXTURE.data.incidents);
  assert.equal(reconcile(scoring, 34, 33).ok, false);
});

test("reconcile: penalty try is worth 7", () => {
  const scoring = [
    { min: 10, team: "home", type: "penaltyTry", player: null, after: [7, 0] },
    { min: 40, team: "away", type: "penalty", player: "K", after: [7, 3] },
  ];
  const r = reconcile(scoring, 7, 3);
  assert.equal(r.ok, true);
});

test("reconcile: empty scoring only reconciles a 0-0 (negative case)", () => {
  assert.equal(reconcile([], 27, 10).ok, false);
  assert.equal(reconcile([], 0, 0).ok, true);
});

function mkMatch(overrides) {
  return {
    id: 1, reconciled: true,
    home: { name: "A", score: 12 }, away: { name: "B", score: 5 },
    scoring: [
      { min: 5, team: "home", type: "try", player: "P1", after: [5, 0] },
      { min: 15, team: "home", type: "try", player: "P1", after: [10, 0] },
      { min: 20, team: "home", type: "conversion", player: "P2", after: [12, 0] },
      { min: 30, team: "away", type: "try", player: "Q1", after: [12, 5] },
    ],
    cards: [{ min: 50, team: "away", type: "yellow", player: "Q2" }],
    ...overrides,
  };
}

test("buildAggregates: try scorers, points, discipline, team totals", () => {
  const agg = buildAggregates([mkMatch({})]);
  assert.deepEqual(agg.topTryScorers[0], { player: "P1", team: "A", tries: 2 });
  assert.deepEqual(agg.topPointsScorers[0], { player: "P1", team: "A", points: 10, t: 2, c: 0, p: 0, d: 0 });
  assert.deepEqual(agg.discipline, [{ team: "B", yellow: 1, red: 0 }, { team: "A", yellow: 0, red: 0 }]);
  const a = agg.teamTotals.find((t) => t.team === "A");
  assert.deepEqual(a, { team: "A", tries: 2, cons: 1, pens: 0, drops: 0, pointsFor: 12 });
});

test("buildAggregates: unreconciled matches are excluded (negative case)", () => {
  const agg = buildAggregates([mkMatch({ reconciled: false })]);
  assert.deepEqual(agg.topTryScorers, []);
  assert.deepEqual(agg.teamTotals, []);
});

test("buildAggregates: penalty try counts for the team, not a player", () => {
  const m = mkMatch({
    home: { name: "A", score: 7 }, away: { name: "B", score: 0 },
    scoring: [{ min: 9, team: "home", type: "penaltyTry", player: null, after: [7, 0] }],
    cards: [],
  });
  const agg = buildAggregates([m]);
  assert.deepEqual(agg.topTryScorers, []);
  assert.equal(agg.teamTotals.find((t) => t.team === "A").tries, 1);
});

test("buildAggregates: ties broken alphabetically for stable output", () => {
  const m = mkMatch({
    scoring: [
      { min: 5, team: "home", type: "try", player: "Zed", after: [5, 0] },
      { min: 15, team: "away", type: "try", player: "Abe", after: [5, 5] },
    ],
    home: { name: "A", score: 5 }, away: { name: "B", score: 5 }, cards: [],
  });
  const agg = buildAggregates([m]);
  assert.deepEqual(agg.topTryScorers.map((s) => s.player), ["Abe", "Zed"]);
});

const EVENTS = [
  { id: 16098042, homeTeam: { name: "New Zealand" }, awayTeam: { name: "France" } },
  { id: 16098052, homeTeam: { name: "Japan" }, awayTeam: { name: "Italy" } },
];

test("findEvent: exact home/away name pair", () => {
  assert.equal(findEvent(EVENTS, "New Zealand", "France").id, 16098042);
});

test("findEvent: swapped order does NOT match (negative case)", () => {
  assert.equal(findEvent(EVENTS, "France", "New Zealand"), null);
});

test("findEvent: absent pairing returns null (negative case)", () => {
  assert.equal(findEvent(EVENTS, "Fiji", "Wales"), null);
});

test("decideAlert: create when failing with no open issue", () => {
  assert.equal(decideAlert(null, false), "create");
});
test("decideAlert: close when reconciled and an issue is open", () => {
  assert.equal(decideAlert({ number: 7 }, true), "close");
});
test("decideAlert: noop when healthy/no issue, or already reported", () => {
  assert.equal(decideAlert(null, true), "noop");
  assert.equal(decideAlert({ number: 7 }, false), "noop"); // one issue per match, no spam
});

test("runPipeline: end-to-end — reconciled match publishes, NS match skipped, bad score held", async () => {
  const nations = {
    results: [
      { id: 53213, date: "2026-07-04T07:10:00+00:00", week: "1", status: { short: "FT" },
        home: { id: 465, name: "New Zealand", score: 34 }, away: { id: 387, name: "France", score: 32 } },
      { id: 53299, date: "2026-07-04T09:00:00+00:00", week: "1", status: { short: "FT" },
        home: { id: 1, name: "Fiji", score: 99 }, away: { id: 2, name: "Wales", score: 0 } }, // no event → failure
    ],
    fixtures: [
      { id: "static-r3-1", date: "2026-07-18T05:10:00+00:00", status: { short: "NS" },
        home: { name: "New Zealand", score: null }, away: { name: "South Africa", score: null } },
    ],
  };
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes("/api/schedule/")) {
      return { events: [{ id: 16098042, homeTeam: { name: "New Zealand" }, awayTeam: { name: "France" } }] };
    }
    if (url.includes("/api/match/16098042/incidents")) return FIXTURE;
    throw new Error(`unexpected url ${url}`);
  };

  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, sleepMs: 0 });

  assert.equal(stats.matches.length, 2);
  const ok = stats.matches.find((m) => m.id === 53213);
  assert.equal(ok.reconciled, true);
  assert.equal(ok.eventId, 16098042);
  assert.equal(ok.scoring.length, 18);
  assert.equal(stats.aggregates.topTryScorers[0].tries, 2); // Jordan/Roigard on 2

  const held = stats.matches.find((m) => m.id === 53299);
  assert.equal(held.reconciled, false);
  assert.deepEqual(held.scoring, []); // nothing unverified is published
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /no event found/);

  // NS fixture must never trigger a fetch (negative case)
  assert.ok(!calls.some((u) => u.includes("2026-07-18")));
});

test("runPipeline: already-reconciled matches are not refetched", async () => {
  const nations = {
    results: [{ id: 53213, date: "2026-07-04T07:10:00+00:00", week: "1", status: { short: "FT" },
      home: { id: 465, name: "New Zealand", score: 34 }, away: { id: 387, name: "France", score: 32 } }],
    fixtures: [],
  };
  const prevStats = { matches: [{ id: 53213, eventId: 16098042, reconciled: true,
    home: { name: "New Zealand", score: 34 }, away: { name: "France", score: 32 }, scoring: [], cards: [] }] };
  const fetchJson = async () => { throw new Error("must not be called"); };
  const { failures } = await runPipeline({ nations, prevStats, fetchJson, sleepMs: 0 });
  assert.deepEqual(failures, []);
});

test("runPipeline: score mismatch is held and reported (negative case)", async () => {
  const nations = {
    results: [{ id: 53213, date: "2026-07-04T07:10:00+00:00", week: "1", status: { short: "FT" },
      home: { id: 465, name: "New Zealand", score: 34 }, away: { id: 387, name: "France", score: 35 } }], // wrong final
    fixtures: [],
  };
  const fetchJson = async (url) =>
    url.includes("/schedule/")
      ? { events: [{ id: 16098042, homeTeam: { name: "New Zealand" }, awayTeam: { name: "France" } }] }
      : FIXTURE;
  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.equal(stats.matches[0].eventId, 16098042); // discovery cached for the retry
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /not reconcile/);
});

test("buildAggregates: penalty and drop goal terms flow into player points", () => {
  const m = mkMatch({
    home: { name: "A", score: 6 }, away: { name: "B", score: 3 },
    scoring: [
      { min: 10, team: "home", type: "penalty", player: "K1", after: [3, 0] },
      { min: 20, team: "home", type: "dropGoal", player: "K1", after: [6, 0] },
      { min: 30, team: "away", type: "penalty", player: "K2", after: [6, 3] },
    ],
    cards: [],
  });
  const agg = buildAggregates([m]);
  assert.deepEqual(agg.topPointsScorers[0], { player: "K1", team: "A", points: 6, t: 0, c: 0, p: 1, d: 1 });
});

test("buildAggregates: teamTotals full shape and pointsFor ordering", () => {
  const agg = buildAggregates([mkMatch({})]);
  assert.deepEqual(agg.teamTotals, [
    { team: "A", tries: 2, cons: 1, pens: 0, drops: 0, pointsFor: 12 },
    { team: "B", tries: 1, cons: 0, pens: 0, drops: 0, pointsFor: 5 },
  ]);
});

test("runPipeline: unknown incident class holds the match even when the score balances", async () => {
  const withUnknown = structuredClone(FIXTURE);
  withUnknown.data.incidents.push({ time: 63, incidentType: "goal", incidentClass: "mysteryBonus", player: { name: "X" }, isHome: true });
  const nations = {
    results: [{ id: 53213, date: "2026-07-04T07:10:00+00:00", week: "1", status: { short: "FT" },
      home: { id: 465, name: "New Zealand", score: 34 }, away: { id: 387, name: "France", score: 32 } }],
    fixtures: [],
  };
  const fetchJson = async (url) =>
    url.includes("/schedule/")
      ? { events: [{ id: 16098042, homeTeam: { name: "New Zealand" }, awayTeam: { name: "France" } }] }
      : withUnknown;
  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /unknown incident classes: goal:mysteryBonus/);
});
