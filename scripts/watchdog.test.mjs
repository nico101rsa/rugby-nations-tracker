import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, formatReport, coverageReport, alertSignature, decideIssueAction } from "./watchdog.mjs";

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

// Squad-coverage email: the safeguard the 2026-07-14 blank-squad miss revealed
// was absent — the watchdog only checked that jobs RAN, never that squads were
// present. It now turns teamsheetGaps into a daily alert.
test("coverageReport lists imminent teams missing a squad, by name", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const nations = {
    fixtures: [
      { date: "2026-07-18T15:40:00+00:00", home: { id: 467, name: "South Africa" }, away: { id: 391, name: "Wales" } },
      { date: "2026-11-06T12:00:00+00:00", home: { id: 386, name: "England" }, away: { id: 460, name: "Argentina" } },
    ],
    digests: { 391: { teamsheet: { starters: [] } } }, // Wales covered; SA not
  };
  const rep = coverageReport(nations, now);
  assert.equal(rep.gaps.length, 1);
  assert.equal(rep.gaps[0].team, "South Africa");
  assert.match(rep.text, /South Africa/);
  assert.match(rep.text, /no published squad/i);
});

test("coverageReport is null when every imminent team has a squad", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const nations = {
    fixtures: [{ date: "2026-07-18T15:40:00+00:00", home: { id: 467, name: "South Africa" }, away: { id: 391, name: "Wales" } }],
    digests: { 467: { teamsheet: {} }, 391: { teamsheet: {} } },
  };
  assert.equal(coverageReport(nations, now), null);
});

// ---- GitHub-issue alerting ---------------------------------------------------
// Email is dead (Gmail SMTP app-passwords 535 from Actions IPs), so alerts go to
// a GitHub issue via the built-in GITHUB_TOKEN. It must not re-notify every day
// for a state it already reported — the signature is what makes it idempotent.

const miss = (workflow) => ({ workflow, label: workflow, maxAgeHours: 6, lastSuccessAt: null, ageHours: null });

test("alertSignature is stable regardless of ordering", () => {
  const a = alertSignature([miss("b.yml"), miss("a.yml")], { gaps: [{ team: "Wales" }, { team: "Fiji" }] });
  const b = alertSignature([miss("a.yml"), miss("b.yml")], { gaps: [{ team: "Fiji" }, { team: "Wales" }] });
  assert.equal(a, b);
  assert.match(a, /Fiji/);
  assert.notEqual(a, alertSignature([miss("a.yml")], { gaps: [{ team: "Fiji" }] })); // different state → different sig
});

test("decideIssueAction opens, stays quiet, updates on change, and closes when healthy", () => {
  const sig = "jobs=[] squads=[Fiji]";
  const open = { number: 7, body: `something\n<!-- sig: ${sig} -->` };

  assert.equal(decideIssueAction(null, sig, false), "create"); // first time
  assert.equal(decideIssueAction(open, sig, false), "noop"); // same state → don't re-ping daily
  assert.equal(decideIssueAction(open, "jobs=[] squads=[Fiji,Wales]", false), "update"); // state worsened
  assert.equal(decideIssueAction(open, "", true), "close"); // recovered
  assert.equal(decideIssueAction(null, "", true), "noop"); // healthy, nothing open
});
