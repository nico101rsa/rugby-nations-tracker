import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { inBurstWindow, runFixturesBurst, PUBLISH_PATHS } from "./fixtures-burst.mjs";

const KO = Date.parse("2026-08-22T15:10:00.000Z");   // Ellis Park, the game that exposed this
const series = (over = {}) => ({
  id: "espn-603247", date: "2026-08-22T15:10:00.000Z",
  comp: { key: "series-rsa-nzl-2026", label: "SA v NZ", kind: "series" },
  home: { code: "RSA", name: "South Africa" }, away: { code: "NZL", name: "New Zealand" },
  ...over,
});

test("the window opens 15 min before kickoff and closes 180 min after", () => {
  assert.equal(inBurstWindow([series()], KO - 16 * 60000), false);
  assert.equal(inBurstWindow([series()], KO - 14 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 60 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 179 * 60000), true);
  assert.equal(inBurstWindow([series()], KO + 181 * 60000), false);
});

test("test, series, tour and ESPN-scored competition games open the window; NC rounds do not", () => {
  // Nations Championship rounds are the nations.json burst's job — bursting
  // here for them would rebuild from ESPN while api-sports is already polling.
  const round = series({ comp: { key: "rnc-2026", label: "RNC '26", kind: "competition" } });
  assert.equal(inBurstWindow([round], KO), false);
  for (const kind of ["test", "series", "tour"]) {
    assert.equal(inBurstWindow([series({ comp: { kind } })], KO), true, kind);
  }
  // The Pacific Nations Cup has no other live source (2026-09-12: the final
  // would have sat on its kickoff time all afternoon).
  const pnc = series({ comp: { key: "pnc-2026", label: "PNC '26", kind: "competition" } });
  assert.equal(inBurstWindow([pnc], KO), true);
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

// ---- calendar/ rides every fixtures.json commit -------------------------------
//
// build-fixtures rewrites calendar/ (build-calendars.mjs) every time it writes
// fixtures.json. A committer that adds one without the other publishes a
// corrected kickoff to the app and a stale one to the calendars — and in the
// burst's case, drops the calendar change entirely until the next daily run.

test("the burst's mid-match publish adds calendar/ with fixtures.json", async () => {
  assert.deepEqual(PUBLISH_PATHS, ["fixtures.json", "calendar"]);
  const src = await readFile(new URL("./fixtures-burst.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("function gitPublish"));
  assert.match(fn, /execSync\(`git add \$\{PUBLISH_PATHS\.join\(" "\)\}`\)/);
});

const WORKFLOWS = new URL("../.github/workflows/", import.meta.url);
const workflowTexts = async () => {
  const out = {};
  for (const f of await readdir(WORKFLOWS)) if (f.endsWith(".yml")) out[f] = await readFile(new URL(f, WORKFLOWS), "utf8");
  return out;
};

test("every workflow that commits fixtures.json also commits calendar/", async () => {
  const committers = [];
  for (const [file, yml] of Object.entries(await workflowTexts())) {
    for (const line of yml.match(/git add [^\n]*/g) ?? []) {
      const paths = line.trim().split(/\s+/).slice(2);
      if (!paths.includes("fixtures.json")) continue;
      committers.push(file);
      assert.ok(paths.includes("calendar"), `${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual([...new Set(committers)].sort(), ["fixtures-rebuild.yml", "refresh-data.yml", "team-events.yml"]);
});

test("every workflow that builds fixtures.json is one of those committers", async () => {
  for (const [file, yml] of Object.entries(await workflowTexts())) {
    if (!/node scripts\/(build-fixtures|fixtures-burst)\.mjs/.test(yml)) continue;
    assert.ok(/git add [^\n]*\bfixtures\.json\b[^\n]*\bcalendar\b/.test(yml), `${file} builds fixtures.json but never commits it with calendar/`);
  }
});

test("the rebuild workflow: push-triggered on its narrow paths, own concurrency group, silent tier", async () => {
  const all = await workflowTexts();
  const yml = all["fixtures-rebuild.yml"];
  assert.match(yml, /^name: Rebuild fixtures & calendars$/m);
  assert.match(yml, /branches: \[main\]/);
  for (const p of ["scripts/kickoff-overrides.mjs", "scripts/build-calendars.mjs", "scripts/seed-competitions.mjs"]) {
    assert.ok(yml.includes(`- ${p}`), p);
  }
  assert.match(yml, /workflow_dispatch:/);
  assert.match(yml, /group: fixtures-rebuild\n\s+cancel-in-progress: false/);
  for (const [file, other] of Object.entries(all)) {
    if (file !== "fixtures-rebuild.yml") assert.ok(!/group: fixtures-rebuild\b/.test(other), `${file} shares the group`);
  }
  assert.ok(!/secrets\./.test(yml), "keyless: no secrets");
  assert.match(yml, /git push \|\| \(git pull --rebase --autostash -X theirs && git push\)/);
  const watchdog = await readFile(new URL("./watchdog.mjs", import.meta.url), "utf8");
  assert.ok(!watchdog.includes("fixtures-rebuild.yml"), "not a paged job");
});
