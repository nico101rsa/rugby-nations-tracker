import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFixtures, compFor, roundLookup } from "./build-fixtures.mjs";

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
