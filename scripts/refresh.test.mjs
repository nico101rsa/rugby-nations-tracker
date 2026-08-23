import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleKickoffs } from "./static-fixtures.mjs";

test("scheduleKickoffs returns normalized kickoff rows", () => {
  const rows = scheduleKickoffs();
  assert.ok(rows.length >= 30, "expected the full announced schedule");
  const r2 = rows.find((r) => r.date === "2026-07-11T05:10:00+00:00");
  assert.deepEqual(r2, { week: "2", date: "2026-07-11T05:10:00+00:00", timeConfirmed: true });
  const nov = rows.find((r) => r.date.startsWith("2026-11-06"));
  assert.equal(nov.timeConfirmed, false, "November times are TBC");
});

import { utcDateStr, datesForWindow } from "./fetch-nations.mjs";

test("utcDateStr formats a UTC calendar date", () => {
  assert.equal(utcDateStr(new Date("2026-07-11T19:10:00Z")), "2026-07-11");
  assert.equal(utcDateStr(new Date("2026-07-11T23:30:00Z")), "2026-07-11");
});

test("datesForWindow is inclusive and UTC", () => {
  assert.deepEqual(
    datesForWindow("2026-07-11", "2026-07-13"),
    ["2026-07-11", "2026-07-12", "2026-07-13"],
  );
});

import { decideMode, runLiveBurst } from "./refresh.mjs";

const SCHED = [
  { week: "2", date: "2026-07-11T05:10:00+00:00", timeConfirmed: true },
  { week: "2", date: "2026-07-11T19:10:00+00:00", timeConfirmed: true },
  { week: "4", date: "2026-11-06T12:00:00+00:00", timeConfirmed: false },
];
const at = (iso) => new Date(iso);

test("LIVE mid-match → today-only, that match's UTC date", () => {
  const d = decideMode({ now: at("2026-07-11T06:00:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(d.mode, "live");
  assert.deepEqual(d.dates, ["2026-07-11"]);
});

test("LIVE 14 min before kickoff (inside PRE window)", () => {
  const d = decideMode({ now: at("2026-07-11T04:56:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(d.mode, "live");
});

test("not yet live 16 min before kickoff", () => {
  const d = decideMode({ now: at("2026-07-11T04:54:00Z"), schedule: SCHED, remaining: 90 });
  assert.notEqual(d.mode, "live");
});

test("still live 149 min after kickoff, idle at 151 min", () => {
  const live = decideMode({ now: at("2026-07-11T07:39:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(live.mode, "live"); // 05:10 + 149m = 07:39
  const gap = decideMode({ now: at("2026-07-11T07:41:00Z"), schedule: SCHED, remaining: 90 });
  assert.notEqual(gap.mode, "live"); // 05:10 + 151m, before next match's PRE
});

test("SWEEP at a 6-hourly UTC slot when no match is live", () => {
  const d = decideMode({ now: at("2026-07-08T12:03:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(d.mode, "sweep");
  assert.deepEqual(d.dates, ["2026-07-08", "2026-07-09", "2026-07-10"]);
});

test("IDLE off-slot with no live match → zero fetches", () => {
  const d = decideMode({ now: at("2026-07-08T13:20:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(d.mode, "idle");
  assert.deepEqual(d.dates, []);
});

test("TBC November kickoff never opens a live window", () => {
  const d = decideMode({ now: at("2026-11-06T12:00:00Z"), schedule: SCHED, remaining: 90 });
  assert.notEqual(d.mode, "live");
});

test("budget guard: remaining < floor forces guard mode, no fetch", () => {
  const d = decideMode({ now: at("2026-07-11T06:00:00Z"), schedule: SCHED, remaining: 5 });
  assert.equal(d.mode, "guard");
  assert.deepEqual(d.dates, []);
});

// ---- runLiveBurst resilience -------------------------------------------------
// The nations burst had no tests at all, and carried the identical fault that
// killed the fixtures burst's run 4349 on 2026-08-22: one rejected push threw
// out of gitPublish and took the whole run down mid-match. Here it would have
// waited until a November round to show itself.

test("live burst: a failed pass does not end the burst", async () => {
  let passes = 0;
  const r = await runLiveBurst({
    dates: ["2026-11-07"],
    refresh: async () => { passes++; if (passes === 2) throw new Error("api-sports 502"); return { remaining: 50 }; },
    isLive: () => passes < 4,
    publish: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(passes, 4, "the bad pass is skipped, the rest still run");
  assert.equal(r.iterations, 3, "only successful passes count");
});

test("live burst: a failed PUBLISH does not end the burst — the run 4349 shape", async () => {
  let passes = 0;
  const r = await runLiveBurst({
    dates: ["2026-11-07"],
    refresh: async () => { passes++; return { remaining: 50 }; },
    publish: () => { if (passes === 1) throw new Error("failed to push some refs"); },
    isLive: () => passes < 3,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(passes, 3);
  assert.equal(r.consecutiveFailures, 0, "the streak resets once a pass succeeds");
});

test("live burst: stops after 3 consecutive failures rather than burning quota", async () => {
  let passes = 0;
  const r = await runLiveBurst({
    dates: ["2026-11-07"],
    refresh: async () => { passes++; throw new Error("everything is broken"); },
    isLive: () => true,               // would otherwise loop the whole window
    publish: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(passes, 3, "tighter than the fixtures burst: each pass costs api-sports quota");
  assert.equal(r.iterations, 0);
});

test("live burst: the budget guard still stops it", async () => {
  let passes = 0;
  const r = await runLiveBurst({
    dates: ["2026-11-07"],
    refresh: async () => { passes++; return { remaining: 2 }; },   // below guardFloor
    isLive: () => true,
    publish: () => {},
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(r.iterations, 1, "one pass, then the guard breaks out");
});

test("live burst: a persistently broken publish escalates to the cap", async () => {
  // The streak must not reset on a pass whose publish threw, or a broken
  // checkout would loop for the whole window looking healthy.
  let passes = 0;
  const r = await runLiveBurst({
    dates: ["2026-11-07"],
    refresh: async () => { passes++; return { remaining: 50 }; },
    publish: () => { throw new Error("git commit failed"); },
    isLive: () => true,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(passes, 3, "stops at the failure cap rather than looping the window");
  assert.equal(r.consecutiveFailures, 3);
});
