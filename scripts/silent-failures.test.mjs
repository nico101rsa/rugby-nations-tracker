import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkStorylineBacklog,
  checkUnreconciled,
  silentFailuresSection,
  BACKLOG_STALE_DAYS,
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

const run = (event, days) => ({ event, createdAt: daysAgo(days), conclusion: "success" });

test("dispatched runs present: the Worker is alive", () => {
  const r = checkCronWorker([run("workflow_dispatch", 1), run("schedule", 1), run("schedule", 2)], NOW);
  assert.equal(r.ok, true);
  assert.match(r.headline, /1 dispatched \+ 2 scheduled/);
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
  const r = checkCronWorker([run("workflow_dispatch", 30), run("schedule", 1)], NOW);
  assert.equal(r.ok, false);
});

test("an unqueryable run history is a warning, not a false all-clear", () => {
  assert.equal(checkCronWorker(null, NOW).ok, false);
  assert.equal(checkCronWorker(null, NOW).severity, "warn");
});
