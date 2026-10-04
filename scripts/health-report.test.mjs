import { test } from "node:test";
import assert from "node:assert/strict";
import { isoWeekLabel, parseGrade, tallyRuns, summarizeChanges, deliveryPlan } from "./health-report.mjs";

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
    "Ops status 2026-10-05 11:35 AEDT",
    "Digests: own concurrency group, race-safe publish (#13)",
    "Fix round-2 archive failures (#90)",
    "",
  ];
  assert.deepEqual(summarizeChanges(lines), [
    "Digests: own concurrency group, race-safe publish (#13)",
    "Fix round-2 archive failures (#90)",
  ]);
});

// The weekly report is delivered by being committed: the Claude weekly review
// reads editorial/health/<week>.md. Until 2026-10-04 it also filed an issue
// that @mentioned Nico and emailed him every Thursday; both are off unless he
// opts the email back in with the HEALTH_EMAIL repository variable.
test("deliveryPlan: silent by default, email only on HEALTH_EMAIL=1, never an issue", () => {
  assert.deepEqual(deliveryPlan({}), { issue: false, email: false });
  assert.deepEqual(deliveryPlan(undefined), { issue: false, email: false });
  assert.deepEqual(deliveryPlan({ HEALTH_EMAIL: "1" }), { issue: false, email: true });
  assert.deepEqual(deliveryPlan({ HEALTH_EMAIL: " 1 " }), { issue: false, email: true });
  for (const v of ["", "0", "true", "yes"]) assert.equal(deliveryPlan({ HEALTH_EMAIL: v }).email, false, v);
  // A key being present is not consent: the secrets stay wired for the opt-in.
  assert.equal(deliveryPlan({ RESEND_API_KEY: "x", DIGEST_EMAIL_TO: "y" }).email, false);
});
