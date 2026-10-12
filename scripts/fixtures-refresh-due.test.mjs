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

test("Nations Championship games never make a tick due — nations.json covers them", () => {
  assert.ok(!refreshDue([{ ...fx("competition", "2026-08-11T17:30:00Z"), comp: { kind: "competition", key: "rnc-2026" } }], NOW));
  assert.ok(!refreshDue(undefined, NOW));
});

test("an ESPN-scored competition game (the Pacific Nations Cup) does — live window and missing final", () => {
  const pnc = (iso, scores) => ({ ...fx("competition", iso, scores), comp: { kind: "competition", key: "pnc-2026" } });
  assert.ok(refreshDue([pnc("2026-08-11T17:30:00Z")], NOW)); // in play
  assert.ok(refreshDue([pnc("2026-08-10T14:00:00Z")], NOW)); // yesterday, unscored — the Japan v USA case
  assert.ok(!refreshDue([pnc("2026-08-10T14:00:00Z", { h: 57, a: 12 })], NOW));
});

test("a bare 0-0 is ESPN's placeholder, so it is a missing final; a live 0-0 is just kickoff", () => {
  const pnc = (iso, extra) => ({ ...fx("competition", iso), comp: { kind: "competition", key: "pnc-2026" }, ...extra });
  assert.ok(refreshDue([pnc("2026-08-10T14:00:00Z", { homeScore: 0, awayScore: 0 })], NOW));
  assert.ok(!refreshDue([pnc("2026-08-01T14:00:00Z", { homeScore: 0, awayScore: 0 })], NOW)); // beyond catch-up
  assert.ok(refreshDue([pnc("2026-08-11T17:50:00Z", { homeScore: 0, awayScore: 0, status: { short: "1H", live: true } })], NOW)); // live window anyway
});

// The Bledisloe, Sat 17 Oct 2026: ESPN 05:00Z, corrected to 04:45Z (15:45
// Sydney time). The tick that starts the burst must come at 04:30Z whether
// fixtures.json already carries the correction or still the vendor time (a
// row merged on match morning whose push-triggered rebuild has not landed).
const BLEDISLOE = {
  "2026-10-17 AUS-NZL": { date: "2026-10-17T04:45:00.000Z", vendor: "2026-10-17T05:00:00.000Z", note: "test" },
};
const bledisloe = (date) => ({
  id: "espn-603464", date, homeScore: null, awayScore: null,
  comp: { key: "series-nzl-aus-2026", label: "NZ v AUS", kind: "series" },
  home: { code: "AUS", name: "Australia" }, away: { code: "NZL", name: "New Zealand" },
});

test("the live window runs from the CORRECTED kickoff, on the vendor's time or the corrected one", () => {
  for (const date of ["2026-10-17T05:00:00.000Z", "2026-10-17T04:45:00.000Z"]) {
    assert.ok(!refreshDue([bledisloe(date)], Date.parse("2026-10-17T04:29:00Z"), BLEDISLOE), date);
    assert.ok(refreshDue([bledisloe(date)], Date.parse("2026-10-17T04:30:00Z"), BLEDISLOE), date);
    assert.ok(refreshDue([bledisloe(date)], Date.parse("2026-10-17T04:50:00Z"), BLEDISLOE), date);
  }
  // Without the correction, a vendor-time feed was due 15 minutes late.
  assert.ok(!refreshDue([bledisloe("2026-10-17T05:00:00.000Z")], Date.parse("2026-10-17T04:40:00Z"), {}));
});
