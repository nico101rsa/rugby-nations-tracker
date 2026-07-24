import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRegistry } from "./watch-competitions.mjs";

const comp = (over = {}) => ({
  key: "6n-2027",
  name: "Six Nations",
  season: 2027,
  espnLeagueId: 180659,
  startDate: "2027-01-31",
  endDate: "2027-03-17",
  structure: "table",
  groups: null,
  teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"],
  fixtureCount: 15,
  status: "scheduled",
  defaultFrom: "2026-12-05",
  defaultUntil: "2027-03-31",
  ...over,
});
const announced = (over = {}) =>
  comp({ startDate: null, endDate: null, structure: null, teams: [], fixtureCount: 0, status: "announced", ...over });

const reg = (...cs) => ({ competitions: cs });

test("the watcher's first real job: Six Nations 2027 publishing its fixtures", () => {
  const events = diffRegistry(reg(announced()), reg(comp()));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "fixtures-published");
  assert.match(events[0].title, /Six Nations 2027 has published fixtures/);
  assert.match(events[0].detail, /15 fixtures, 6 teams/);
  assert.match(events[0].detail, /\*\*table\*\*/);
});

test("a steady state raises nothing", () => {
  assert.deepEqual(diffRegistry(reg(comp()), reg(comp())), []);
});

test("an announced competition staying announced is not news", () => {
  assert.deepEqual(diffRegistry(reg(announced()), reg(announced())), []);
});

test("a NEW competition arriving with no fixtures is not news either", () => {
  assert.deepEqual(diffRegistry(reg(), reg(announced())), []);
});

test("a new competition arriving already populated IS news", () => {
  const events = diffRegistry(reg(), reg(comp()));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "fixtures-published");
});

test("UNKNOWN structure raises, and says a knockout bracket is the expected case", () => {
  const events = diffRegistry(reg(comp()), reg(comp({ structure: "UNKNOWN", fixtureCount: 8 })));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "unknown-structure");
  assert.match(events[0].detail, /knockout/);
});

test("UNKNOWN takes precedence over any other change on the same competition", () => {
  // A competition that both gained fixtures and classifies UNKNOWN should
  // report the UNKNOWN — that is the one needing a human.
  const events = diffRegistry(reg(announced()), reg(comp({ structure: "UNKNOWN" })));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "unknown-structure");
});

test("fixtures vanishing raises — it is not a normal transition", () => {
  const events = diffRegistry(reg(comp()), reg(announced()));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "fixtures-vanished");
  assert.match(events[0].detail, /had 15 fixtures/);
});

test("a moved window raises and states the new handover date", () => {
  const events = diffRegistry(
    reg(comp()),
    reg(comp({ endDate: "2027-03-24", defaultUntil: "2027-04-07" })),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "window-moved");
  assert.match(events[0].detail, /2027-04-07/);
});

test("a fixture count changing inside the same window is not news", () => {
  // A rescheduled game that stays inside the span shouldn't nag weekly.
  assert.deepEqual(diffRegistry(reg(comp()), reg(comp({ fixtureCount: 16 }))), []);
});

test("several competitions changing at once each get their own event", () => {
  const rwc = comp({ key: "rwc-2027", name: "Rugby World Cup", structure: "pools" });
  const events = diffRegistry(reg(announced(), announced({ key: "rwc-2027" })), reg(comp(), rwc));
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => e.key).sort(), ["6n-2027", "rwc-2027"]);
});

test("a missing previous registry treats populated competitions as newly published", () => {
  const events = diffRegistry(null, reg(comp()));
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "fixtures-published");
});
