import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStorylineBacklog,
  checkUnreconciled,
  silentFailuresSection,
  BACKLOG_STALE_DAYS,
  checkMissingResults,
} from "./silent-failures.mjs";

const NOW = new Date("2026-07-25T00:00:00Z").getTime();
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// --- storyline backlog (#201) --------------------------------------------

test("a backlog written today is healthy", () => {
  const r = checkStorylineBacklog({ updatedAt: daysAgo(0), count: 21 }, NOW);
  assert.equal(r.ok, true);
  assert.match(r.headline, /21 open/);
});

test("one or two dropped runs do not cry wolf", () => {
  assert.equal(checkStorylineBacklog({ updatedAt: daysAgo(2), count: 21 }, NOW).ok, true);
  assert.equal(BACKLOG_STALE_DAYS, 3);
});

test("a stalled backlog alerts and explains the consequence", () => {
  const r = checkStorylineBacklog({ updatedAt: daysAgo(9), count: 21 }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.severity, "alert");
  assert.match(r.headline, /hasn't grown in 9 days/);
  assert.match(r.detail, /drops a rung to the data edition/);
  // Names the log line to search for, so the alert is actionable.
  assert.match(r.detail, /storyline backlog refresh failed/);
});

test("a count that grows is irrelevant if the timestamp stalled", () => {
  // writeBacklog is only reached when extraction succeeds, so the timestamp is
  // the precise signal — a stale file with a big count is still a stall.
  const r = checkStorylineBacklog({ updatedAt: daysAgo(30), count: 400 }, NOW);
  assert.equal(r.ok, false);
});

test("a never-written backlog is a warning, not an alert — day one is expected", () => {
  const r = checkStorylineBacklog({}, NOW);
  assert.equal(r.severity, "warn");
  assert.match(r.detail, /cold start this is expected/);
  assert.equal(checkStorylineBacklog(null, NOW).ok, false);
});

// --- refused box scores (#203) -------------------------------------------

const match = (id, home, away, reconciled) => ({
  id, date: "2026-07-18T00:00:00Z",
  home: { name: home, score: 24 }, away: { name: away, score: 31 },
  reconciled,
});

test("all reconciling is healthy", () => {
  const r = checkUnreconciled({ matches: [match(1, "A", "B", true), match(2, "C", "D", true)] });
  assert.equal(r.ok, true);
  assert.match(r.headline, /All 2 box scores reconcile/);
});

test("the live case: 1 of 18 refused, and BOTH sides are named as affected", () => {
  const matches = [
    ...Array.from({ length: 17 }, (_, i) => match(i, "X", "Y", true)),
    match(99, "Argentina", "England", false),
  ];
  const r = checkUnreconciled({ matches });
  assert.equal(r.ok, false);
  assert.equal(r.severity, "warn"); // 1/18 is noise, not an alert
  assert.match(r.headline, /1 of 18 box scores refused/);
  assert.match(r.detail, /Argentina, England/);
  assert.match(r.detail, /Argentina 24-31 England/);
});

test("a growing share escalates from warn to alert", () => {
  const matches = [
    ...Array.from({ length: 5 }, (_, i) => match(i, "X", "Y", true)),
    ...Array.from({ length: 5 }, (_, i) => match(100 + i, "A", "B", false)),
  ];
  assert.equal(checkUnreconciled({ matches }).severity, "alert");
});

test("the check never suggests changing the gate or the averaging", () => {
  const r = checkUnreconciled({ matches: [match(1, "A", "B", false)] });
  assert.match(r.detail, /gate is right to refuse/);
  assert.match(r.detail, /coverage signal, not a bug to fix here/);
});

test("a missing stats file is a finding, not a crash", () => {
  assert.equal(checkUnreconciled(null).ok, false);
  assert.equal(checkUnreconciled({ matches: [] }).ok, false);
});

test("undefined `reconciled` is not treated as refused", () => {
  // Only an explicit false is a refusal; a match the gate never looked at
  // shouldn't be reported as one.
  const r = checkUnreconciled({ matches: [{ id: 1, home: {}, away: {} }] });
  assert.equal(r.ok, true);
});

// --- the report section ---------------------------------------------------

test("the section marks each check and folds in the detail only when unhealthy", () => {
  const healthy = silentFailuresSection(
    { updatedAt: daysAgo(0), count: 21 },
    { matches: [match(1, "A", "B", true)] },
    NOW,
  );
  assert.match(healthy, /✅ \*\*Storyline backlog\*\*/);
  assert.match(healthy, /✅ \*\*Box-score reconciliation\*\*/);
  assert.doesNotMatch(healthy, /arithmetic gate is right/);

  const sick = silentFailuresSection(
    { updatedAt: daysAgo(9), count: 21 },
    { matches: [match(1, "Argentina", "England", false)] },
    NOW,
  );
  assert.match(sick, /🔴 \*\*Storyline backlog\*\*/);
  assert.match(sick, /Argentina, England/);
});

// --- cron worker liveness (#196) -----------------------------------------

import { checkCronWorker } from "./silent-failures.mjs";

const run = (event, days, title = "") => ({ event, createdAt: daysAgo(days), displayTitle: title, conclusion: "success" });
const workerRun = (days) => run("workflow_dispatch", days, "Refresh match data (cloudflare-worker)");
// The Mac pinger: same event, same user, DIFFERENT stamp.
const pingerRun = (days) => run("workflow_dispatch", days, "Refresh match data (manual)");

test("stamped runs present: the Worker is alive", () => {
  const r = checkCronWorker([workerRun(1), run("schedule", 1), run("schedule", 2)], NOW);
  assert.equal(r.ok, true);
  assert.match(r.headline, /1 dispatched \+ 2 scheduled/);
});

test("MAC PINGER traffic must NOT count as the Worker being alive", () => {
  // The pinger dispatches the same workflow as the same user. Counting bare
  // workflow_dispatch runs made this check a placebo — it would have gone
  // green on pinger traffic while the Worker was dead, which is the exact
  // failure the Worker exists to prevent.
  const r = checkCronWorker([pingerRun(1), pingerRun(2), run("schedule", 1)], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.severity, "alert");
});

test("the Worker is alive even when the pinger is also firing", () => {
  const r = checkCronWorker([workerRun(1), pingerRun(1), run("schedule", 1)], NOW);
  assert.equal(r.ok, true);
});

test("no dispatched runs alerts, and says why it is otherwise invisible", () => {
  const r = checkCronWorker([run("schedule", 1), run("schedule", 2)], NOW);
  assert.equal(r.ok, false);
  assert.equal(r.severity, "alert");
  assert.match(r.headline, /No Worker-dispatched refresh runs/);
  assert.match(r.detail, /invisible without the check/);
  assert.match(r.detail, /\/health/);
});

test("old dispatched runs outside the window do not count as alive", () => {
  // A Worker that died last month must not look healthy on last month's runs.
  const r = checkCronWorker([workerRun(30), run("schedule", 1)], NOW);
  assert.equal(r.ok, false);
});

test("an unqueryable run history is a warning, not a false all-clear", () => {
  assert.equal(checkCronWorker(null, NOW).ok, false);
  assert.equal(checkCronWorker(null, NOW).severity, "warn");
});

// ---- checkMissingResults -----------------------------------------------------
// The catch-up exits GREEN with "no finished-but-unpublished games" when it has
// nothing to do, and a game lost from both `last` and `next` looks exactly like
// nothing to do. This asks the question from outside, of the published files.

const MR_KO = Date.parse("2026-08-22T15:10:00.000Z");
const MR_LATER = MR_KO + 25 * 3600 * 1000;

const mrTest = (over = {}) => ({
  date: "2026-08-22T15:10:00.000Z",
  home: { code: "RSA", name: "South Africa", tracked: true },
  away: { code: "NZL", name: "New Zealand", tracked: true },
  homeScore: 16, awayScore: 33,
  ...over,
});
const mrTour = () => ({
  date: "2026-08-07T17:00:00.000Z",
  home: { code: "STO", name: "Stormers", tracked: false },
  away: { code: "NZL", name: "New Zealand", tracked: true },
  homeScore: 21, awayScore: 38,
});
const mrGame = (date, oppCode, opponent) => ({ id: 1, date, opponentCode: oppCode, opponent, us: 1, them: 0 });

test("a played game absent from the team that should chart it is an alert", () => {
  const teams = { NZL: { last: [mrGame("2026-08-15T17:00:00Z", null, "Vodacom Bulls XV")] } };
  const r = checkMissingResults(teams, [mrTest()], MR_LATER);
  assert.equal(r.ok, false);
  assert.equal(r.severity, "alert");
  assert.match(r.detail, /NZL/);
});

test("the side that did publish it is not flagged", () => {
  const teams = {
    RSA: { last: [mrGame("2026-08-22T15:10:00Z", "NZL", "New Zealand")] },
    NZL: { last: [mrGame("2026-08-15T17:00:00Z", null, "Vodacom Bulls XV")] },
  };
  const r = checkMissingResults(teams, [mrTest()], MR_LATER);
  assert.match(r.detail, /NZL/);
  assert.doesNotMatch(r.detail, /\*\*RSA\*\*/);
});

test("a tour game the feeds name differently is NOT a false alarm", () => {
  // fixtures.json says "Stormers"; team-events carries the vendor's own name.
  // Comparing opponents made all three of New Zealand's published tour games
  // read as missing, which is why the match is on calendar day alone.
  const teams = { NZL: { last: [mrGame("2026-08-07T17:00:00Z", null, "Stormers XV")] } };
  assert.equal(checkMissingResults(teams, [mrTour()], MR_LATER).ok, true);
});

test("inside the grace period nothing is reported", () => {
  const teams = { NZL: { last: [] } };
  assert.equal(checkMissingResults(teams, [mrTest()], MR_KO + 3 * 3600 * 1000).ok, true);
});

test("a game older than a full last-10 has aged out, not gone missing", () => {
  const ten = Array.from({ length: 10 }, (_, i) =>
    mrGame(`2026-09-${String(i + 1).padStart(2, "0")}T12:00:00Z`, "ENG", "England"));
  assert.equal(checkMissingResults({ NZL: { last: ten } }, [mrTest()], MR_LATER).ok, true);
});

test("missing inputs are reported as a warning, not a crash", () => {
  assert.equal(checkMissingResults(null, null).severity, "warn");
  assert.equal(checkMissingResults({ NZL: { last: [] } }, [null, {}, mrTest({ date: "nope" })], MR_LATER).ok, true);
});
