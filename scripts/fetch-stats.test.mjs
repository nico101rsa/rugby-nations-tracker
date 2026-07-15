// scripts/fetch-stats.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseIncidents } from "./fetch-stats.mjs";

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
