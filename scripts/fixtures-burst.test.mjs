import test from "node:test";
import assert from "node:assert/strict";
import { inBurstWindow, runFixturesBurst } from "./fixtures-burst.mjs";

const KO = Date.parse("2026-08-22T15:10:00.000Z");   // Ellis Park, the game that exposed this
const series = (over = {}) => ({
  id: "espn-603247", date: "2026-08-22T15:10:00.000Z",
  comp: { key: "series-rsa-nzl-2026", label: "SA v NZ", kind: "series" },
  home: { code: "RSA", name: "South Africa" }, away: { code: "NZL", name: "New Zealand" },
  ...over,
});

test("the window opens 15 min before kickoff and closes 150 min after", () => {
  assert.equal(inBurstWindow([series()], KO - 16 * 60000), false);
  assert.equal(inBurstWindow([series()], KO - 14 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 60 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 149 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 151 * 60000), false);
});

test("only test, series and tour games open the window", () => {
  // Nations Championship rounds are the nations.json burst's job — bursting
  // here for them would rebuild from ESPN while api-sports is already polling.
  const round = series({ comp: { key: "rnc-2026", label: "RNC '26", kind: "competition" } });
  assert.equal(inBurstWindow([round], KO), false);
  for (const kind of ["test", "series", "tour"]) {
    assert.equal(inBurstWindow([series({ comp: { kind } })], KO), true, kind);
  }
});

test("a malformed row cannot crash the check", () => {
  assert.equal(inBurstWindow([{ comp: { kind: "test" }, date: "not-a-date" }], KO), false);
  assert.equal(inBurstWindow([null, undefined, {}], KO), false);
  assert.equal(inBurstWindow(undefined, KO), false);
});

test("builds once and stops when nothing is in play", async () => {
  let builds = 0;
  const r = await runFixturesBurst({ build: () => builds++, stillLive: async () => false });
  assert.equal(r.iterations, 1);
  assert.equal(builds, 1, "the not-live catch-up path still gets its single build");
});

test("keeps rebuilding while the game is on, publishing each pass", async () => {
  let builds = 0;
  const published = [];
  const r = await runFixturesBurst({
    build: () => builds++,
    publish: (m) => published.push(m),
    stillLive: async () => builds < 5,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(r.iterations, 5);
  assert.equal(published.length, 5, "every pass publishes — a score the phone never sees is not a refresh");
});

test("stops at the burst cap even if the game somehow never ends", async () => {
  let t = 0;
  let builds = 0;
  const r = await runFixturesBurst({
    build: () => builds++,
    stillLive: async () => true,          // never closes
    sleep: async () => { t += 3 * 60000; },
    now: () => t,
    intervalMs: 3 * 60000,
    burstMs: 30 * 60000,
  });
  assert.equal(r.iterations, 11, "30 min at 3-min intervals, plus the opening build");
  assert.ok(t <= 31 * 60000, "must not run past the cap");
});

// ---- resilience --------------------------------------------------------------
// Run 4349 on 2026-08-22 died mid-match at 16:41 because one rejected push threw
// out of gitPublish and took the whole run with it. A burst whose job is to keep
// a live score fresh must not be endable by a lost race against another job.

test("a failed pass does not end the burst", async () => {
  let builds = 0;
  const r = await runFixturesBurst({
    build: () => { builds++; if (builds === 2) throw new Error("ESPN 503"); },
    stillLive: async () => builds < 4,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(builds, 4, "the bad pass is skipped, the rest still run");
  assert.equal(r.iterations, 3, "only the successful passes count");
});

test("a failed PUBLISH does not end the burst either", async () => {
  // The 4349 shape exactly: the build was fine, the push was not.
  let passes = 0;
  const r = await runFixturesBurst({
    build: () => { passes++; },
    publish: () => { if (passes === 1) throw new Error("failed to push some refs"); },
    stillLive: async () => passes < 3,
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(passes, 3);
  assert.equal(r.consecutiveFailures, 0, "the streak resets once a pass succeeds");
});

test("gives up after 5 consecutive failures rather than looping uselessly", async () => {
  let builds = 0;
  const r = await runFixturesBurst({
    build: () => { builds++; throw new Error("everything is broken"); },
    stillLive: async () => true,          // would otherwise loop for the whole window
    sleep: async () => {},
    now: () => 0,
  });
  assert.equal(builds, 5);
  assert.equal(r.iterations, 0);
  assert.equal(r.consecutiveFailures, 5);
});
