// scripts/fetch-stats.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseIncidents, reconcile, buildAggregates, findEvent, decideAlert, runPipeline,
  POINTS, espnMinute, parseEspnDetails, findEspnEvent,
} from "./fetch-stats.mjs";

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
  // A reconciled vendor list, or a failed vendor lookup, never reaches ESPN.
  const fetchEspn = async () => { throw new Error("ESPN must not be called"); };

  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, fetchEspn, sleepMs: 0 });

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
  const fetchEspn = async () => { throw new Error("ESPN must not be called either"); };
  const { stats, failures } = await runPipeline({ nations, prevStats, fetchJson, fetchEspn, sleepMs: 0 });
  assert.deepEqual(failures, []);
  assert.equal(stats.matches[0].reconciled, true);
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
  const fetchEspn = async () => ({ events: [] }); // ESPN has nothing either
  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, fetchEspn, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.equal(stats.matches[0].eventId, 16098042); // discovery cached for the retry
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /did not reconcile: home 34\/34, away 32\/35; no ESPN event for New Zealand/);
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
  const fetchEspn = async () => ({ events: [] });
  const { stats, failures } = await runPipeline({ nations, prevStats: null, fetchJson, fetchEspn, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.equal(failures.length, 1);
  assert.match(failures[0].reason, /unknown incident classes: goal:mysteryBonus; no ESPN event/);
});

// ---- Second source: ESPN ---------------------------------------------------
//
// Argentina 24-31 England, 18 Jul 2026 (issue #48). One script of events
// feeds both fakes: the vendor's incidents minus one Argentina conversion
// (the real defect: home 22/24) and ESPN's summary details with the full box
// score. The ESPN shape is the one scrape-tries.mjs reads in production
// (type.text, team.id, competitor ids) plus clock/athletesInvolved as ESPN's
// soccer summaries carry them; the parser treats those as best-effort.
const ARG_ENG = [ // [min, side, type, player]
  [7, "home", "try", "H. Wing"],
  [8, "home", "conversion", "H. Ten"], // the one the vendor drops
  [15, "away", "try", "A. Wing"],
  [16, "away", "conversion", "A. Ten"],
  [22, "home", "penalty", "H. Ten"],
  [30, "away", "try", "A. Eight"],
  [38, "home", "penalty", "H. Ten"],
  [45, "away", "try", "A. Wing"],
  [46, "away", "conversion", "A. Ten"],
  [52, "home", "try", "H. Fullback"],
  [58, "home", "penalty", "H. Ten"],
  [63, "away", "try", "A. Hooker"],
  [64, "away", "conversion", "A. Ten"],
  [70, "home", "penalty", "H. Ten"],
  [76, "away", "try", "A. Centre"],
];
const VENDOR_CLASS = { try: "try", conversion: "twoPoints", penalty: "threePoints", dropGoal: "dropGoal", penaltyTry: "penaltyTry" };
const ESPN_TEXT = { try: "Try", conversion: "Conversion", penalty: "Penalty Goal", dropGoal: "Drop Goal", penaltyTry: "Penalty Try" };
const HOME_ID = "9", AWAY_ID = "4";

function vendorIncidents(script) {
  let h = 0, a = 0;
  return script.map(([time, side, type, name]) => {
    if (side === "home") h += POINTS[type]; else a += POINTS[type];
    return { time, incidentType: "goal", incidentClass: VENDOR_CLASS[type], player: { name }, isHome: side === "home", homeScore: h, awayScore: a };
  }).reverse(); // the vendor lists newest first
}
function espnDetail([min, side, type, name]) {
  return {
    type: { text: ESPN_TEXT[type] ?? type }, clock: { value: min * 60, displayValue: `${min}'` },
    team: { id: side === "home" ? HOME_ID : AWAY_ID }, scoreValue: POINTS[type] ?? 0, scoringPlay: type in POINTS,
    athletesInvolved: name ? [{ displayName: name }] : [],
  };
}
function espnSummary(script, extra = []) {
  return { header: { competitions: [{
    competitors: [
      { id: HOME_ID, homeAway: "home", team: { id: HOME_ID, displayName: "Argentina" } },
      { id: AWAY_ID, homeAway: "away", team: { id: AWAY_ID, displayName: "England" } },
    ],
    details: [...script.map(espnDetail), ...extra],
  }] } };
}
const espnScoreboard = (events) => ({ events: events.map(([id, date, home]) => ({
  id, date, status: { type: { completed: true } },
  competitions: [{ competitors: [{ homeAway: "home", team: { displayName: home } }, { homeAway: "away", team: { displayName: "x" } }] }],
})) });

const ARG_ENG_NATIONS = {
  results: [{ id: 53230, date: "2026-07-18T19:10:00+00:00", week: "3", status: { short: "FT" },
    home: { id: 460, name: "Argentina", score: 24 }, away: { id: 386, name: "England", score: 31 } }],
  fixtures: [],
};
// What stats.json carried for months: the vendor event id known, nothing published.
const ARG_ENG_PREV = { matches: [{ id: 53230, round: "3", date: "2026-07-18T19:10:00+00:00",
  home: { id: 460, name: "Argentina", score: 24 }, away: { id: 386, name: "England", score: 31 },
  eventId: 16098059, reconciled: false, scoring: [], cards: [] }] };
const SHORT_VENDOR = { data: { incidents: vendorIncidents(ARG_ENG.filter((e) => e[0] !== 8)) } }; // home 22/24

test("runPipeline: a vendor list that does not reconcile is retried from ESPN and published with source espn", async () => {
  const vendorCalls = [], espnCalls = [];
  const fetchJson = async (url) => {
    vendorCalls.push(url);
    if (url.includes("/api/match/16098059/incidents")) return SHORT_VENDOR;
    throw new Error(`unexpected vendor url ${url}`);
  };
  const fetchEspn = async (url) => {
    espnCalls.push(url);
    if (url.endsWith("scoreboard?dates=20260718")) return espnScoreboard([["401", "2026-07-18T19:10Z", "Argentina"]]);
    if (url.endsWith("summary?event=401")) return espnSummary(ARG_ENG, [espnDetail([33, "away", "Yellow Card", "A. Lock"])]);
    throw new Error(`unexpected ESPN url ${url}`);
  };

  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });

  assert.deepEqual(failures, []);
  const m = stats.matches[0];
  assert.equal(m.reconciled, true);
  assert.equal(m.source, "espn");
  assert.equal(m.eventId, 16098059); // the vendor id stays: fetch-form-stats keys team-events by it
  assert.equal(m.scoring.length, 15);
  assert.equal(m.scoring.filter((s) => s.team === "home" && s.type === "conversion").length, 1); // the one the vendor lost
  assert.deepEqual(m.scoring[1], { min: 8, team: "home", type: "conversion", player: "H. Ten", after: [7, 0] });
  assert.deepEqual(m.scoring.at(-1), { min: 76, team: "away", type: "try", player: "A. Centre", after: [24, 31] });
  assert.deepEqual(m.cards, [{ min: 33, team: "away", type: "yellow", player: "A. Lock" }]);
  assert.equal(reconcile(m.scoring, 24, 31).ok, true);
  assert.deepEqual(stats.aggregates.teamTotals.find((t) => t.team === "Argentina"), { team: "Argentina", tries: 2, cons: 1, pens: 4, drops: 0, pointsFor: 24 });
  assert.deepEqual(stats.aggregates.discipline[0], { team: "England", yellow: 1, red: 0 });
  // One vendor call (no schedule discovery: the event id was kept), then ESPN.
  assert.deepEqual(vendorCalls, ["https://api.sportsapipro.com/v2/rugby/api/match/16098059/incidents"]);
  assert.deepEqual(espnCalls, [
    "https://site.api.espn.com/apis/site/v2/sports/rugby/17567/scoreboard?dates=20260718",
    "https://site.api.espn.com/apis/site/v2/sports/rugby/17567/summary?event=401",
  ]);
});

test("runPipeline: ESPN event found on the next UTC day (kickoffs cross the date line)", async () => {
  const espnCalls = [];
  const fetchJson = async () => SHORT_VENDOR;
  const fetchEspn = async (url) => {
    espnCalls.push(url.slice(url.lastIndexOf("/") + 1));
    if (url.endsWith("scoreboard?dates=20260719")) return espnScoreboard([["401", "2026-07-18T19:10Z", "Argentina"]]);
    if (url.includes("scoreboard?dates=")) return { events: [] };
    if (url.endsWith("summary?event=401")) return espnSummary(ARG_ENG);
    throw new Error(`unexpected ESPN url ${url}`);
  };
  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });
  assert.deepEqual(failures, []);
  assert.equal(stats.matches[0].source, "espn");
  assert.deepEqual(espnCalls, ["scoreboard?dates=20260718", "scoreboard?dates=20260719", "summary?event=401"]);
});

test("runPipeline: an ESPN event type we do not recognise holds the match and reports both reasons (negative case)", async () => {
  const fetchJson = async () => SHORT_VENDOR;
  const fetchEspn = async (url) =>
    url.includes("scoreboard?dates=20260718")
      ? espnScoreboard([["401", "2026-07-18T19:10Z", "Argentina"]])
      : espnSummary(ARG_ENG, [espnDetail([66, "home", "Bonus Point", null])]); // score balances, type does not
  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });
  const m = stats.matches[0];
  assert.equal(m.reconciled, false);
  assert.equal(m.source, undefined);
  assert.deepEqual(m.scoring, []); // nothing unverified is published
  assert.equal(m.eventId, 16098059);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].title, "Stats: Argentina v England (match 53230) not publishing");
  assert.match(failures[0].reason, /^did not reconcile: home 22\/24, away 31\/31; /); // the vendor's reason first
  assert.match(failures[0].reason, /ESPN event 401 did not reconcile: home 24\/24, away 31\/31; unknown event types: Bonus Point$/);
});

test("runPipeline: ESPN details that do not add up hold the match with both reasons (negative case)", async () => {
  const fetchJson = async () => SHORT_VENDOR;
  const fetchEspn = async (url) =>
    url.includes("scoreboard?dates=20260718")
      ? espnScoreboard([["401", "2026-07-18T19:10Z", "Argentina"]])
      : espnSummary(ARG_ENG.filter((e) => e[0] !== 70)); // ESPN short a penalty: home 21
  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.equal(failures[0].reason, "did not reconcile: home 22/24, away 31/31; ESPN event 401 did not reconcile: home 21/24, away 31/31");
});

test("runPipeline: an ESPN outage is folded into the reason, never thrown (negative case)", async () => {
  const fetchJson = async () => SHORT_VENDOR;
  const fetchEspn = async (url) => { throw new Error(`HTTP 503 for ${url}`); };
  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });
  assert.equal(stats.matches[0].reconciled, false);
  assert.match(failures[0].reason, /^did not reconcile: home 22\/24, away 31\/31; ESPN: HTTP 503 for .*scoreboard\?dates=20260718$/);
});

test("runPipeline: a vendor list with an unknown class is also retried from ESPN", async () => {
  const withUnknown = structuredClone(SHORT_VENDOR);
  withUnknown.data.incidents.push({ time: 8, incidentType: "goal", incidentClass: "twoPointsNew", player: { name: "H. Ten" }, isHome: true });
  const fetchJson = async () => withUnknown;
  const fetchEspn = async (url) =>
    url.includes("scoreboard?dates=20260718") ? espnScoreboard([["401", "2026-07-18T19:10Z", "Argentina"]]) : espnSummary(ARG_ENG);
  const { stats, failures } = await runPipeline({ nations: ARG_ENG_NATIONS, prevStats: ARG_ENG_PREV, fetchJson, fetchEspn, sleepMs: 0 });
  assert.deepEqual(failures, []);
  assert.equal(stats.matches[0].source, "espn");
});

test("findEspnEvent: kickoff minute + home name, as scrape-tries matches", () => {
  const events = espnScoreboard([
    ["400", "2026-07-18T17:00Z", "Argentina"], // same home, earlier game
    ["401", "2026-07-18T19:10Z", "Argentina"],
    ["402", "2026-07-18T19:10Z", "England"],   // same minute, other home
  ]).events;
  assert.equal(findEspnEvent(events, "2026-07-18T19:10:00+00:00", "Argentina").id, "401");
  assert.equal(findEspnEvent(events, "2026-07-18T19:10:00+00:00", " argentina ").id, "401"); // case/space-insensitive
  assert.equal(findEspnEvent(events, "2026-07-18T19:10:00+00:00", "England").id, "402");
  assert.equal(findEspnEvent(events, "2026-07-18T19:15:00+00:00", "Argentina"), null); // minute differs
  assert.equal(findEspnEvent(events, "2026-07-18T19:10:00+00:00", "Georgia"), null);
  assert.equal(findEspnEvent(events, "not a date", "Argentina"), null);
  assert.equal(findEspnEvent([], "2026-07-18T19:10:00+00:00", "Argentina"), null);
});

test("espnMinute: seconds of play, then the display string, then null", () => {
  assert.equal(espnMinute({ value: 1234, displayValue: "21'" }), 21);
  assert.equal(espnMinute({ value: 60 }), 1);
  assert.equal(espnMinute({ value: 0, displayValue: "40'+2'" }), 42);
  assert.equal(espnMinute({ displayValue: "78" }), 78);
  assert.equal(espnMinute({ displayValue: "HT" }), null);
  assert.equal(espnMinute({}), null);
  assert.equal(espnMinute(undefined), null);
});

test("parseEspnDetails: every type maps, non-events are skipped, unknown text and foreign team are collected", () => {
  const rows = [
    { type: { text: "Try" }, clock: { value: 300 }, team: { id: 9 }, athletesInvolved: [{ displayName: "A" }] },
    { type: { text: "Conversion" }, clock: { value: 330 }, team: { id: "9" }, athletesInvolved: [{ displayName: "K" }] },
    { type: { text: "Penalty Try" }, clock: { value: 900 }, team: { id: "4" } },
    { type: { text: "Penalty" }, clock: { value: 1500 }, team: { id: "4" }, athletesInvolved: [{ displayName: "P" }] },
    { type: { text: "Drop Goal" }, clock: { value: 2100 }, team: { id: "9" }, athletesInvolved: [{ displayName: "D" }] },
    { type: { text: "Yellow Card" }, clock: { displayValue: "33'" }, team: { id: "4" }, athletesInvolved: [{ displayName: "Y" }] },
    { type: { text: "Red Card" }, clock: { value: 3000 }, team: { id: "9" }, athletesInvolved: [{ displayName: "R" }] },
    { type: { text: "Substitution" }, clock: { value: 3100 }, team: { id: "9" } },
    { type: { text: "Half Time" } },
    { type: { text: "Bonus Point" }, team: { id: "9" } },
    { type: { text: "Try" }, clock: { value: 4000 }, team: { id: "77" } },
    { team: { id: "9" } },
  ];
  const { scoring, cards, unknown } = parseEspnDetails(rows, ["9"], ["4"]);
  assert.deepEqual(scoring, [
    { min: 5, team: "home", type: "try", player: "A", after: [5, 0] },
    { min: 6, team: "home", type: "conversion", player: "K", after: [7, 0] },
    { min: 15, team: "away", type: "penaltyTry", player: null, after: [7, 7] },
    { min: 25, team: "away", type: "penalty", player: "P", after: [7, 10] },
    { min: 35, team: "home", type: "dropGoal", player: "D", after: [10, 10] },
  ]);
  assert.deepEqual(cards, [
    { min: 33, team: "away", type: "yellow", player: "Y" },
    { min: 50, team: "home", type: "red", player: "R" },
  ]);
  assert.deepEqual(unknown, ["Bonus Point", "Try for team 77", "(untyped)"]);
  assert.equal(reconcile(scoring, 10, 10).ok, true);
});

test("parseEspnDetails: ESPN's own running score wins over accumulation and orders a shared minute", () => {
  const rows = [ // arrives newest-first; the running total puts the try before its conversion
    { type: { text: "Conversion" }, clock: { value: 600 }, team: { id: "9" }, homeScore: 7, awayScore: 3 },
    { type: { text: "Try" }, clock: { value: 600 }, team: { id: "9" }, homeScore: 5, awayScore: 3 },
    { type: { text: "Penalty Goal" }, clock: { value: 120 }, team: { id: "4" }, homeScore: 0, awayScore: 3 },
  ];
  const { scoring } = parseEspnDetails(rows, ["9"], ["4"]);
  assert.deepEqual(scoring.map((s) => [s.min, s.type, s.after]), [[2, "penalty", [0, 3]], [10, "try", [5, 3]], [10, "conversion", [7, 3]]]);
});

test("parseEspnDetails: without a running score a conversion sorts after the try in its minute", () => {
  const rows = [
    { type: { text: "Conversion" }, clock: { value: 600 }, team: { id: "9" } },
    { type: { text: "Try" }, clock: { value: 600 }, team: { id: "9" } },
  ];
  const { scoring } = parseEspnDetails(rows, ["9"], ["4"]);
  assert.deepEqual(scoring.map((s) => [s.type, s.after]), [["try", [5, 0]], ["conversion", [7, 0]]]);
});

test("parseEspnDetails: card flags stand in for an unrecognised card label; empty and absent input are empty", () => {
  const { cards, unknown } = parseEspnDetails([{ type: { text: "Sin Bin" }, yellowCard: true, team: { id: "4" }, clock: { value: 60 } }], ["9"], ["4"]);
  assert.deepEqual(cards, [{ min: 1, team: "away", type: "yellow", player: null }]);
  assert.deepEqual(unknown, []);
  assert.deepEqual(parseEspnDetails([], ["9"], ["4"]), { scoring: [], cards: [], unknown: [] });
  assert.deepEqual(parseEspnDetails(undefined), { scoring: [], cards: [], unknown: [] });
});

test("parseEspnDetails: a team id matching neither competitor holds the match even when the sum balances", () => {
  const { scoring, unknown } = parseEspnDetails([{ type: { text: "Try" }, clock: { value: 60 }, team: { id: "9" } }], ["1"], ["2"]);
  assert.deepEqual(scoring, []);
  assert.deepEqual(unknown, ["Try for team 9"]);
});
