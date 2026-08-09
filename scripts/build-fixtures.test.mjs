import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixtures, compFor, roundLookup, mergeSources, fetchSeriesScores } from "./build-fixtures.mjs";

const ref = (id) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/rugby/leagues/1/seasons/2026/teams/${id}?lang=en` });
const ev = (id, iso, homeId, awayId, extra = {}) => ({
  event: {
    id: String(id),
    date: iso,
    competitions: [{
      competitors: [
        { homeAway: "home", team: ref(homeId) },
        { homeAway: "away", team: ref(awayId) },
      ],
      ...extra,
    }],
  },
  leagueName: extra.leagueName ?? "International Test Match",
});
const NAMES = new Map([["37", "Portugal"], ["55", "Georgia"]]);

test("compFor maps leagues to comp tags", () => {
  assert.deepEqual(compFor("Nations Championship", 2026), { key: "rnc-2026", label: "RNC '26", kind: "competition" });
  assert.deepEqual(compFor("The Rugby Championship", 2026), { key: "trc-2026", label: "TRC '26", kind: "competition" });
  assert.deepEqual(compFor("Six Nations", 2027), { key: "6n-2027", label: "6N '27", kind: "competition" });
  assert.deepEqual(compFor("International Test Match", 2026), { key: "test", label: "TEST", kind: "test" });
});

test("match-level entry: both sides, tracked flags, sorted ascending", () => {
  // RSA(5) v ARG(10) TRC, and WAL(4) v Georgia one-off before it
  const events = [
    ev(2, "2026-08-29T14:00:00Z", 5, 10, { leagueName: "The Rugby Championship" }),
    ev(1, "2026-08-01T14:00:00Z", 4, 55),
  ];
  const out = buildFixtures(events, NAMES, {});
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].home, { code: "WAL", name: "Wales", tracked: true });
  assert.deepEqual(out[0].away, { code: "GEO", name: "Georgia", tracked: false });
  assert.deepEqual(out[0].comp, { key: "test", label: "TEST", kind: "test" });
  assert.equal(out[1].id, "espn-2");
  assert.equal(out[1].comp.label, "TRC '26");
  assert.equal(out[1].round, undefined);
});

test("series detection: 2+ tests same pair become SA v NZ · Game n/N; one-offs stay TEST", () => {
  const events = [
    ev(11, "2026-08-22T15:00:00Z", 5, 8), // RSA v NZL game 1
    ev(12, "2026-09-12T05:05:00Z", 8, 5), // NZL v RSA game 2
    ev(13, "2026-08-29T14:00:00Z", 4, 55), // WAL v GEO one-off
  ];
  const out = buildFixtures(events, NAMES, {});
  const g1 = out.find((e) => e.id === "espn-11");
  const g2 = out.find((e) => e.id === "espn-12");
  const oneOff = out.find((e) => e.id === "espn-13");
  assert.deepEqual(g1.comp, { key: "series-rsa-nzl-2026", label: "SA v NZ", kind: "series" });
  assert.deepEqual(g1.series, { label: "SA v NZ", game: 1, of: 2 });
  assert.deepEqual(g2.series, { label: "SA v NZ", game: 2, of: 2 });
  assert.equal(oneOff.comp.kind, "test");
  assert.equal(oneOff.series, undefined);
});

test("NC rounds come from nations.json; timeTBC from ESPN timeValid", () => {
  const nations = {
    fixtures: [{
      date: "2026-11-07T12:00:00+00:00", week: "4", timeTBC: true,
      home: { name: "Italy" }, away: { name: "South Africa" },
    }],
    results: [],
  };
  const events = [ev(21, "2026-11-07T02:40:00Z", 20, 5, { leagueName: "Nations Championship", timeValid: false })];
  const out = buildFixtures(events, NAMES, nations);
  assert.equal(out[0].round, "4");
  assert.equal(out[0].timeTBC, true);
  assert.equal(out[0].comp.key, "rnc-2026");
});

test("roundLookup misses outside the 36h window and on name mismatch", () => {
  const find = roundLookup({
    fixtures: [{ date: "2026-11-07T12:00:00Z", week: "4", home: { name: "Italy" }, away: { name: "South Africa" } }],
  });
  assert.equal(find("Italy", "South Africa", "2026-11-07T02:40:00Z"), "4");
  assert.equal(find("Italy", "South Africa", "2026-11-12T02:40:00Z"), null);
  assert.equal(find("South Africa", "Italy", "2026-11-07T02:40:00Z"), null);
});

test("untracked-vs-untracked events are dropped; venue formatted", () => {
  const events = [
    ev(31, "2026-08-01T14:00:00Z", 37, 55), // POR v GEO — no tracked side
    ev(32, "2026-08-08T14:00:00Z", 5, 8, { venue: { fullName: "Ellis Park", address: { city: "Johannesburg" } } }),
  ];
  const out = buildFixtures(events, NAMES, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].venue, "Ellis Park, Johannesburg");
});

// --- league-wide ingest for registered competitions (#205) ----------------

// The site-API scoreboard shape: `team.id` inline rather than behind a $ref.
const siteEv = (id, iso, home, away, comp) => ({
  event: {
    id: String(id),
    date: iso,
    competitions: [{
      timeValid: true,
      competitors: [
        { homeAway: "home", team: { id: String(home) } },
        { homeAway: "away", team: { id: String(away) } },
      ],
    }],
  },
  leagueName: "Rugby World Cup",
  comp,
  registered: true,
});

const RWC = { key: "rwc-2027", label: "RWC '27", kind: "competition" };

test("compFor maps the Rugby World Cup — it used to fall through to a test", () => {
  assert.deepEqual(compFor("Rugby World Cup", 2027), { key: "rwc-2027", label: "RWC '27", kind: "competition" });
});

test("a registered comp keeps a match between two UNTRACKED nations", () => {
  // Chile(289243) v Hong Kong(289268) — the fixture the old filter dropped.
  const names = new Map([["289243", "Chile"], ["289268", "Hong Kong"]]);
  const out = buildFixtures([siteEv(1, "2027-10-05T10:45:00Z", 289243, 289268, RWC)], names, {});
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].home, { code: "CHI", name: "Chile", tracked: false });
  assert.deepEqual(out[0].away, { code: "HKG", name: "Hong Kong", tracked: false });
  assert.deepEqual(out[0].comp, RWC);
});

test("an UNREGISTERED match between two untracked nations is still dropped", () => {
  const names = new Map([["289243", "Chile"], ["289268", "Hong Kong"]]);
  const ev = siteEv(2, "2027-06-05T10:45:00Z", 289243, 289268, undefined);
  ev.registered = false;
  ev.leagueName = "International Test Match";
  assert.equal(buildFixtures([ev], names, {}).length, 0);
});

test("the site-API id shape resolves the same as the core-API $ref shape", () => {
  const out = buildFixtures([siteEv(3, "2027-10-05T10:45:00Z", 5, 1, RWC)], new Map(), {});
  assert.deepEqual(out[0].home, { code: "RSA", name: "South Africa", tracked: true });
  assert.deepEqual(out[0].away, { code: "ENG", name: "England", tracked: true });
});

test("registered pool matches never become a fictional series", () => {
  // Four RWC matches involving the same pair would trip the series pass if
  // they were tagged as tests, which is what the missing compFor case did.
  const out = buildFixtures(
    [
      siteEv(4, "2027-10-01T10:45:00Z", 5, 1, RWC),
      siteEv(5, "2027-10-08T10:45:00Z", 1, 5, RWC),
    ],
    new Map(),
    {},
  );
  assert.equal(out.every((f) => f.comp.kind === "competition"), true);
  assert.equal(out.every((f) => f.series === undefined), true);
});

test("United States of America resolves to USA, not UNI", () => {
  const names = new Map([["11", "United States of America"]]);
  const out = buildFixtures([siteEv(6, "2027-10-05T10:45:00Z", 11, 5, RWC)], names, {});
  assert.equal(out[0].home.code, "USA");
});

// --- played-game persistence (NZ tour spec: series scoreboard) -------------

// NOTE: no real SA-NZ test has been played yet (first is 22 Aug 2026) —
// these tests FABRICATE a finished state to pin the behaviour.

const NOW = new Date("2026-08-25T00:00:00Z").getTime(); // between tests 1 and 2

test("a played series test persists with its score; future legs keep numbering", () => {
  const events = [
    ev(11, "2026-08-22T15:10:00Z", 5, 8), // RSA v NZL test 1 — played at NOW
    ev(12, "2026-08-29T15:10:00Z", 5, 8), // test 2 — future
    ev(13, "2026-09-12T21:00:00Z", 8, 5), // test 3 — future
  ];
  const scores = { "espn-11": { home: 19, away: 31 } };
  const out = buildFixtures(events, NAMES, {}, { now: NOW, scores });
  assert.equal(out.length, 3);
  const g1 = out.find((e) => e.id === "espn-11");
  assert.equal(g1.comp.kind, "series");
  assert.deepEqual(g1.series, { label: "SA v NZ", game: 1, of: 3 });
  assert.equal(g1.homeScore, 19); // RSA home — orientation preserved
  assert.equal(g1.awayScore, 31);
  // Future legs persist unscored, numbering intact.
  assert.equal(out.find((e) => e.id === "espn-12").homeScore, undefined);
  assert.deepEqual(out.find((e) => e.id === "espn-13").series, { label: "SA v NZ", game: 3, of: 3 });
});

test("a played series test persists even before its score is fetchable", () => {
  const events = [
    ev(11, "2026-08-22T15:10:00Z", 5, 8),
    ev(12, "2026-08-29T15:10:00Z", 5, 8),
  ];
  const out = buildFixtures(events, NAMES, {}, { now: NOW });
  assert.equal(out.length, 2);
  assert.equal(out[0].homeScore, undefined);
});

test("played one-off tests persist (Results tab shows them); competition games still drop", () => {
  const events = [
    ev(21, "2026-08-01T14:00:00Z", 4, 55), // WAL v GEO one-off — played, persists
    ev(22, "2026-08-22T14:00:00Z", 5, 10, { leagueName: "The Rugby Championship" }), // played comp game — drops
    ev(23, "2026-09-05T14:00:00Z", 2, 55), // future SCO v GEO one-off — kept
    // (23 is a different pair from 21 on purpose: a repeat WAL v GEO would
    // legitimately fold into a 2-game series and persist.)
  ];
  const out = buildFixtures(events, NAMES, {}, { now: NOW });
  assert.deepEqual(out.map((e) => e.id), ["espn-21", "espn-23"]);
  // And a played test picks up its final from the scores map, like series do.
  const scored = buildFixtures(events, NAMES, {}, { now: NOW, scores: { "espn-21": { home: 31, away: 12 } } });
  assert.equal(scored[0].homeScore, 31);
  assert.equal(scored[0].awayScore, 12);
});

test("default now=0 keeps everything — existing callers/tests are unaffected", () => {
  const out = buildFixtures([ev(31, "2020-01-01T14:00:00Z", 4, 55)], NAMES, {});
  assert.equal(out.length, 1);
});

test("fetchSeriesScores follows competitor score $refs, keyed by fixture id", async () => {
  const raw = [{
    event: {
      id: "11",
      competitions: [{
        competitors: [
          { homeAway: "home", score: { $ref: "http://x/score-home" } },
          { homeAway: "away", score: { $ref: "http://x/score-away" } },
        ],
      }],
    },
  }];
  const fetchJson = async (url) => ({ value: url.endsWith("home") ? 19 : 31 });
  assert.deepEqual(await fetchSeriesScores(raw, fetchJson), { "espn-11": { home: 19, away: 31 } });
  // A missing/failed score ref yields no entry rather than a half-score.
  const broken = async () => { throw new Error("404"); };
  assert.deepEqual(await fetchSeriesScores(raw, broken), {});
});

test("mergeSources dedupes by event id and lets the league-wide entry win", () => {
  const team = { event: { id: "99" }, leagueName: "International Test Match" };
  const league = siteEv(99, "2027-10-05T10:45:00Z", 5, 1, RWC);
  const merged = mergeSources([team], [league]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].comp, RWC);
  assert.equal(merged[0].registered, true);
});
