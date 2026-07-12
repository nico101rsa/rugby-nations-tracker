import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekLabel, parseGrade, tallyRuns, summarizeChanges } from "./health-report.mjs";

test("isoWeekLabel is Thursday-anchored", () => {
  assert.equal(isoWeekLabel(new Date("2026-07-16T21:00:00Z")), "2026-W29");
  assert.equal(isoWeekLabel(new Date("2026-01-01T00:00:00Z")), "2026-W01");
});

test("parseGrade reads the editor grade line", () => {
  assert.equal(parseGrade("### Grade: C+\n\nObservations..."), "C+");
  assert.equal(parseGrade("today's grade (A-F): **B-** overall"), "B-");
  assert.equal(parseGrade("no grade here"), null);
});

test("tallyRuns counts only the last 7 days and finds the newest", () => {
  const now = new Date("2026-07-13T00:00:00Z");
  const rows = [
    { createdAt: "2026-07-12T20:00:00Z", conclusion: "success" },
    { createdAt: "2026-07-11T20:00:00Z", conclusion: "failure" },
    { createdAt: "2026-07-01T20:00:00Z", conclusion: "success" }, // >7d, excluded
    { createdAt: "2026-07-10T20:00:00Z", conclusion: "cancelled" },
  ];
  const t = tallyRuns(rows, now);
  assert.equal(t.total, 3);
  assert.equal(t.success, 1);
  assert.equal(t.failure, 1);
  assert.equal(t.cancelled, 1);
  assert.equal(t.lastAt.toISOString(), "2026-07-12T20:00:00.000Z");
});

test("summarizeChanges drops bot noise, keeps real commits", () => {
  const lines = [
    "data: live refresh (2026-07-12T20:45:07Z)",
    "Data refresh 2026-07-13 06:41 AEST",
    "Daily digests 2026-07-12 08:00 AEST",
    "chore: keepalive",
    "Digests: own concurrency group, race-safe publish (#13)",
    "Fix round-2 archive failures (#90)",
    "",
  ];
  assert.deepEqual(summarizeChanges(lines), [
    "Digests: own concurrency group, race-safe publish (#13)",
    "Fix round-2 archive failures (#90)",
  ]);
});
