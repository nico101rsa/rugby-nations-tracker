import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshDue } from "./fixtures-refresh-due.mjs";

const NOW = Date.parse("2026-08-11T18:00:00Z");
const fx = (kind, iso, scores = {}) => ({
  comp: { kind }, date: iso,
  homeScore: scores.h ?? null, awayScore: scores.a ?? null,
});

test("due during a live window (test/series/tour), including 15min pre-kickoff", () => {
  assert.ok(refreshDue([fx("tour", "2026-08-11T17:10:00Z")], NOW));
  assert.ok(refreshDue([fx("series", "2026-08-11T18:10:00Z")], NOW)); // kicks off in 10min
  assert.ok(!refreshDue([fx("test", "2026-08-11T20:00:00Z")], NOW)); // 2h away
});

test("due while a recent final is missing; settles once scored or after 48h", () => {
  assert.ok(refreshDue([fx("test", "2026-08-10T14:00:00Z")], NOW)); // yesterday, unscored
  assert.ok(!refreshDue([fx("test", "2026-08-10T14:00:00Z", { h: 22, a: 30 })], NOW));
  assert.ok(!refreshDue([fx("test", "2026-08-01T14:00:00Z")], NOW)); // beyond catch-up
});

test("competition games never make a tick due", () => {
  assert.ok(!refreshDue([fx("competition", "2026-08-11T17:30:00Z")], NOW));
  assert.ok(!refreshDue(undefined, NOW));
});
