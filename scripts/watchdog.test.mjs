import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, formatReport } from "./watchdog.mjs";

const WATCHERS = [
  { workflow: "a.yml", label: "A", maxAgeHours: 26 },
  { workflow: "b.yml", label: "B", maxAgeHours: 6 },
];
const NOW = new Date("2026-07-13T00:00:00Z");

test("all fresh → no misses", () => {
  const latest = {
    "a.yml": new Date("2026-07-12T20:00:00Z"), // 4h ago
    "b.yml": new Date("2026-07-12T22:00:00Z"), // 2h ago
  };
  assert.deepEqual(evaluate(NOW, latest, WATCHERS), []);
});

test("stale run past its limit is a miss", () => {
  const latest = {
    "a.yml": new Date("2026-07-12T20:00:00Z"), // 4h ago, ok
    "b.yml": new Date("2026-07-12T10:00:00Z"), // 14h ago > 6h
  };
  const misses = evaluate(NOW, latest, WATCHERS);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].workflow, "b.yml");
  assert.ok(misses[0].ageHours > 6);
});

test("no successful run at all is a miss", () => {
  const latest = { "a.yml": null, "b.yml": new Date("2026-07-12T22:00:00Z") };
  const misses = evaluate(NOW, latest, WATCHERS);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].lastSuccessAt, null);
  assert.equal(misses[0].ageHours, null);
});

test("exactly at the limit is not a miss (boundary)", () => {
  const latest = { "a.yml": new Date("2026-07-11T22:00:00Z"), "b.yml": new Date("2026-07-12T18:00:00Z") };
  // a.yml is exactly 26h; b.yml exactly 6h — both allowed.
  assert.deepEqual(evaluate(NOW, latest, WATCHERS), []);
});

test("report names the overdue job and its age", () => {
  const misses = evaluate(NOW, { "a.yml": null, "b.yml": new Date("2026-07-12T10:00:00Z") }, WATCHERS);
  const report = formatReport(misses, NOW);
  assert.match(report, /no successful run found at all/);
  assert.match(report, /14\.0h ago/);
  assert.match(report, /cron drift/);
});
