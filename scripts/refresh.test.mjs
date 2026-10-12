import { test } from "node:test";
import assert from "node:assert/strict";
import { scheduleKickoffs, publishedKickoffs, loadPublishedFixtures, staticFixtures, mergeStaticFixtures, API_SPORTS_TEAMS } from "./static-fixtures.mjs";

// SCHEDULE alone: an empty fixtures.json, so no test here is pinned to the
// committed file's contents (which the daily build rewrites).
const scheduleOnly = () => scheduleKickoffs([]);

test("scheduleKickoffs returns normalized kickoff rows", () => {
  const rows = scheduleOnly();
  assert.ok(rows.length >= 30, "expected the full announced schedule");
  const r2 = rows.find((r) => r.date === "2026-07-11T05:10:00+00:00");
  assert.deepEqual(r2, { week: "2", date: "2026-07-11T05:10:00+00:00", timeConfirmed: true });
  const nov = rows.find((r) => r.date.startsWith("2026-11-06"));
  assert.deepEqual(nov, { week: "4", date: "2026-11-06T20:10:00+00:00", timeConfirmed: true });
});

test("every Round 4-6 kickoff is confirmed — the November live burst depends on it", () => {
  // Until 2026-10-12 all eighteen were noon placeholders with timeConfirmed
  // false, and decideMode skips those: not one November match would have
  // latched live mode.
  const nov = scheduleOnly().filter((r) => ["4", "5", "6"].includes(r.week));
  assert.equal(nov.length, 18);
  for (const r of nov) assert.equal(r.timeConfirmed, true, `${r.week} ${r.date}`);
});

test("a confirmed SCHEDULE row is never a noon placeholder", () => {
  // Every 2026 kickoff is on :10 or :40 (broadcast slots). A row left at
  // 12:00 with timeConfirmed flipped to true would latch a live window at the
  // wrong time and miss the real match.
  for (const r of scheduleOnly().filter((x) => x.timeConfirmed)) {
    const d = new Date(r.date);
    assert.ok([10, 40].includes(d.getUTCMinutes()), `${r.date} is not on :10 or :40`);
    assert.ok(!(d.getUTCHours() === 12 && d.getUTCMinutes() === 0), `${r.date} is a noon placeholder`);
  }
});

test("scheduleKickoffs() reads the committed fixtures.json without throwing", () => {
  // Shape only, never contents: the daily build rewrites that file.
  const rows = scheduleKickoffs();
  assert.ok(rows.length >= scheduleOnly().length);
  for (const r of rows) assert.ok(Number.isFinite(Date.parse(r.date)) && typeof r.timeConfirmed === "boolean");
});

test("a missing or unreadable fixtures.json falls back to SCHEDULE alone", () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const none = loadPublishedFixtures("/nonexistent/fixtures.json");
    assert.deepEqual(none, []);
    assert.deepEqual(scheduleKickoffs(none), scheduleOnly());
  } finally { console.warn = warn; }
  assert.deepEqual(publishedKickoffs(null), []);
  assert.deepEqual(publishedKickoffs({ fixtures: "nope" }), []);
});

test("API_SPORTS_TEAMS maps all twelve codes to api-sports ids", () => {
  assert.equal(Object.keys(API_SPORTS_TEAMS).length, 12);
  assert.equal(API_SPORTS_TEAMS.RSA.id, 467);
  assert.equal(API_SPORTS_TEAMS.FIJ.id, 28);
});

test("mergeStaticFixtures: a cached api-sports game with the same week + home id supersedes its static twin", () => {
  const ire = API_SPORTS_TEAMS.IRE.id;
  const cached = {
    id: 53300, date: "2026-11-06T20:10:00+00:00", week: "4",
    teams: { home: { id: ire }, away: { id: API_SPORTS_TEAMS.ARG.id } },
  };
  const slimmed = { id: 53300, date: cached.date, week: "4", home: { id: ire }, away: { id: API_SPORTS_TEAMS.ARG.id } };
  const merged = mergeStaticFixtures([slimmed], [cached]);
  assert.equal(merged.filter((f) => f.week === "4" && f.home.id === ire).length, 1);
  assert.equal(merged.find((f) => f.week === "4" && f.home.id === ire).id, 53300);
  assert.equal(merged.length, staticFixtures().length, "one static row replaced, none added");
  // And with no cached game the static row stands, now with a real time.
  const statik = mergeStaticFixtures([], []).find((f) => f.id === `static-r4-${ire}`);
  assert.equal(statik.date, "2026-11-06T20:10:00+00:00");
  assert.equal(statik.timeTBC, false);
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

test("still live 169 min after kickoff, idle at 171 min", () => {
  // 170 since 2026-10-04: the app's full-time alert fires at kickoff + 160.
  const live = decideMode({ now: at("2026-07-11T07:59:00Z"), schedule: SCHED, remaining: 90 });
  assert.equal(live.mode, "live"); // 05:10 + 169m = 07:59
  const gap = decideMode({ now: at("2026-07-11T08:01:00Z"), schedule: SCHED, remaining: 90 });
  assert.notEqual(gap.mode, "live"); // 05:10 + 171m, before next match's PRE
});

test("the live window outlasts the app's full-time alert (kickoff + 160)", () => {
  const ko = Date.parse("2026-07-11T05:10:00Z");
  const d = decideMode({ now: new Date(ko + 160 * 60000), schedule: SCHED, remaining: 90 });
  assert.equal(d.mode, "live");
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

test("a TBC kickoff never opens a live window", () => {
  const d = decideMode({ now: at("2026-11-06T12:00:00Z"), schedule: SCHED, remaining: 90 });
  assert.notEqual(d.mode, "live");
});

test("budget guard: remaining < floor forces guard mode, no fetch", () => {
  const d = decideMode({ now: at("2026-07-11T06:00:00Z"), schedule: SCHED, remaining: 5 });
  assert.equal(d.mode, "guard");
  assert.deepEqual(d.dates, []);
});

// ---- November: Rounds 4-6 and finals weekend --------------------------------

test("Round 4: live 14 min before FRA v FIJ (20:10Z), with only that UTC date", () => {
  // Sat 7 Nov 19:56 UTC = Sun 8 Nov 06:56 Sydney time.
  const d = decideMode({ now: at("2026-11-07T19:56:00Z"), schedule: scheduleOnly(), remaining: null });
  assert.equal(d.mode, "live");
  assert.deepEqual(d.dates, ["2026-11-07"]);
});

test("Round 4: idle between matches, off a sweep slot", () => {
  const d = decideMode({ now: at("2026-11-07T03:00:00Z"), schedule: scheduleOnly(), remaining: null });
  assert.equal(d.mode, "idle");
});

test("every Round 4-6 kickoff opens a live window from -15 to +170 min", () => {
  for (const r of scheduleOnly().filter((x) => ["4", "5", "6"].includes(x.week))) {
    const ko = Date.parse(r.date);
    for (const offset of [-14, 0, 80, 169]) {
      const d = decideMode({ now: new Date(ko + offset * 60000), schedule: scheduleOnly(), remaining: null });
      assert.equal(d.mode, "live", `${r.date} at ${offset} min`);
      assert.ok(d.dates.includes(r.date.slice(0, 10)), `${r.date} at ${offset} min polls its own UTC date`);
    }
  }
});

// Finals weekend as ESPN is expected to publish it into fixtures.json once
// Round 6 sets the pairings (times from the RFU's ticketing listing, GMT).
const FINALS = [
  ["espn-604101", "2026-11-27T16:40:00.000Z"], // 6th v 6th — Sat 28 Nov 03:40 Sydney time
  ["espn-604102", "2026-11-27T20:10:00.000Z"], // 3rd v 3rd
  ["espn-604103", "2026-11-28T13:10:00.000Z"], // 5th v 5th
  ["espn-604104", "2026-11-28T16:40:00.000Z"], // 2nd v 2nd
  ["espn-604105", "2026-11-29T13:10:00.000Z"], // 4th v 4th
  ["espn-604106", "2026-11-29T16:40:00.000Z"], // the final
].map(([id, date]) => ({
  id, date, timeTBC: false,
  home: { code: "ENG" }, away: { code: "NZL" },
  comp: { key: "rnc-2026", label: "RNC '26", kind: "competition" },
}));
// The Round 4-6 rows ESPN already publishes, at the same minutes as SCHEDULE.
const PUBLISHED_POOL = scheduleOnly()
  .filter((r) => ["4", "5", "6"].includes(r.week))
  .map((r, i) => ({ id: `espn-${603993 + i}`, date: new Date(r.date).toISOString(), timeTBC: false, round: r.week, comp: { key: "rnc-2026", kind: "competition" } }));

test("finals weekend: no live window until ESPN publishes it (SCHEDULE has no finals)", () => {
  const d = decideMode({ now: at("2026-11-27T16:40:00Z"), schedule: scheduleKickoffs({ fixtures: PUBLISHED_POOL }), remaining: null });
  assert.notEqual(d.mode, "live");
});

test("finals weekend: every published, confirmed finals kickoff latches live — no hand edit", () => {
  const schedule = scheduleKickoffs({ fixtures: [...PUBLISHED_POOL, ...FINALS] });
  for (const f of FINALS) {
    const ko = Date.parse(f.date);
    for (const offset of [-14, 0, 169]) {
      const d = decideMode({ now: new Date(ko + offset * 60000), schedule, remaining: null });
      assert.equal(d.mode, "live", `${f.id} at ${offset} min`);
      assert.deepEqual(d.dates, [f.date.slice(0, 10)]);
    }
    const before = decideMode({ now: new Date(ko - 16 * 60000), schedule, remaining: null });
    if (f.id === "espn-604101") assert.notEqual(before.mode, "live", "the first final opens no earlier than -15 min");
  }
});

test("published rows already in SCHEDULE add nothing (deduped by kickoff minute)", () => {
  assert.equal(scheduleKickoffs({ fixtures: PUBLISHED_POOL }).length, scheduleOnly().length);
  assert.equal(scheduleKickoffs({ fixtures: [...PUBLISHED_POOL, ...FINALS] }).length, scheduleOnly().length + FINALS.length);
  // The same final twice (per-team and league-wide ingest) is one kickoff.
  assert.equal(scheduleKickoffs([...FINALS, ...FINALS]).length, scheduleOnly().length + FINALS.length);
  const added = scheduleKickoffs({ fixtures: FINALS }).slice(scheduleOnly().length);
  assert.deepEqual(added[0], { week: null, date: "2026-11-27T16:40:00.000Z", timeConfirmed: true });
});

test("a published time that disagrees with SCHEDULE keeps both windows (the earlier never lost)", () => {
  // ESPN moves IRE v ARG to 19:40: the live window opens off the earlier time.
  const moved = { ...PUBLISHED_POOL[0], date: "2026-11-06T19:40:00.000Z" };
  const schedule = scheduleKickoffs([moved]);
  assert.equal(schedule.length, scheduleOnly().length + 1);
  assert.equal(decideMode({ now: at("2026-11-06T19:30:00Z"), schedule, remaining: null }).mode, "live");
  assert.equal(decideMode({ now: at("2026-11-06T22:55:00Z"), schedule, remaining: null }).mode, "live");
});

test("only confirmed rnc-* rows are merged: TBC finals, other competitions and junk are not", () => {
  const rows = [
    { ...FINALS[0], timeTBC: true },                                   // pairings/time not set yet
    { ...FINALS[1], timeTBC: undefined },                              // no flag is not a confirmation
    { ...FINALS[2], comp: { key: "6n-2027", kind: "competition" } },  // another competition
    { ...FINALS[3], comp: { key: "test", kind: "test" } },            // a test match
    { ...FINALS[4], date: "TBC" },                                     // unparseable date
    null,
  ];
  assert.deepEqual(publishedKickoffs(rows), []);
  const schedule = scheduleKickoffs(rows);
  assert.equal(schedule.length, scheduleOnly().length);
  assert.notEqual(decideMode({ now: at("2026-11-27T16:40:00Z"), schedule, remaining: null }).mode, "live");
});

test("quota: every November match day, finals included, stays inside the guard floor at worst case", () => {
  // api-sports free tier: 100 calls/UTC day, GUARD_FLOOR 10. A live pass
  // costs one call per date in d.dates; passes run every 12 min, and each 2h
  // burst cap re-latches with an extra immediate pass. Sweeps cost 3 calls at
  // each of 00/06/12/18 UTC slots that aren't live — up to three runs per slot
  // on a Saturday, where the */15 and */10 crons both land in the first 15
  // minutes. Every cron landing is the worst case; GitHub drops most.
  const schedule = scheduleKickoffs({ fixtures: [...PUBLISHED_POOL, ...FINALS] });
  const days = ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-13", "2026-11-14", "2026-11-15",
    "2026-11-21", "2026-11-27", "2026-11-28", "2026-11-29"];
  for (const day of days) {
    let liveMinutes = 0, maxDates = 0, sweepSlots = 0;
    const start = Date.parse(`${day}T00:00:00Z`);
    for (let m = 0; m < 1440; m++) {
      const d = decideMode({ now: new Date(start + m * 60000), schedule, remaining: null });
      if (d.mode === "live") { liveMinutes++; maxDates = Math.max(maxDates, d.dates.length); }
      if (d.mode === "sweep" && m % 360 === 0) sweepSlots++;
    }
    const saturday = new Date(start).getUTCDay() === 6;
    const passes = Math.ceil(liveMinutes / 12) + Math.ceil(liveMinutes / 120);
    const worst = passes * maxDates + sweepSlots * 3 * (saturday ? 3 : 2);
    assert.ok(maxDates <= 1, `${day}: a live pass polls one UTC date`);
    assert.ok(worst < 90, `${day}: worst case ${worst} calls would breach the guard floor`);
  }
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
