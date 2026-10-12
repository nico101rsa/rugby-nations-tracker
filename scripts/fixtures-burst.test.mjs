import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { inBurstWindow, runFixturesBurst, PUBLISH_PATHS, buildPass, BUILD_STEP, STANDINGS_STEPS } from "./fixtures-burst.mjs";

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

test("the burst's mid-match publish adds calendar/, standings.json and the try cache with fixtures.json", async () => {
  assert.deepEqual(PUBLISH_PATHS, ["fixtures.json", "calendar", "standings.json", "scripts/match-tries-espn.json"]);
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

// ---- standings.json rides every fixtures rebuild ------------------------------
//
// A Six Nations or World Cup result moves its points table on the same pass
// that lands the score. The two standings steps are keyless and zero-quota,
// and must never cost the burst a pass: a throw counts toward the
// consecutive-failure limit and could end it mid-match.

test("a pass runs build-fixtures, then the try cache, then build-standings", () => {
  const ran = [];
  buildPass({ run: (cmd) => ran.push(cmd), warn: () => {} });
  assert.deepEqual(ran, [
    "node scripts/build-fixtures.mjs",
    "node scripts/espn-tries.mjs --recent",
    "node scripts/build-standings.mjs",
  ]);
  assert.equal(BUILD_STEP, ran[0]);
  assert.deepEqual(STANDINGS_STEPS, ran.slice(1));
});

test("a throwing standings step does not abort the pass, or the burst", async () => {
  const warnings = [];
  const ran = [];
  const run = (cmd) => {
    ran.push(cmd);
    if (cmd.includes("espn-tries") || cmd.includes("build-standings")) throw new Error(`${cmd} exited 1`);
  };
  buildPass({ run, warn: (w) => warnings.push(w) });
  assert.equal(ran.length, 3, "build-standings still runs after the try cache failed");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /espn-tries\.mjs --recent failed .* fixtures\.json still publishes/);

  let passes = 0;
  const published = [];
  const r = await runFixturesBurst({
    build: () => { passes++; buildPass({ run, warn: () => {} }); },
    publish: (m) => published.push(m),
    stillLive: async () => passes < 3,
    sleep: async () => {},
    now: () => 0,
  });
  assert.deepEqual([r.iterations, r.consecutiveFailures, published.length], [3, 0, 3]);
});

test("a failing fixtures build still fails the pass (and skips the standings steps)", () => {
  const ran = [];
  assert.throws(() => buildPass({ run: (cmd) => { ran.push(cmd); if (cmd === BUILD_STEP) throw new Error("ESPN 503"); } }), /ESPN 503/);
  assert.deepEqual(ran, [BUILD_STEP]);
});

const STANDINGS_FILES = ["standings.json", "scripts/match-tries-espn.json"];

test("every workflow that commits standings.json also commits the try cache, and both run the build", async () => {
  const committers = [];
  for (const [file, yml] of Object.entries(await workflowTexts())) {
    for (const line of yml.match(/git add [^\n]*/g) ?? []) {
      const paths = line.trim().split(/\s+/).slice(2);
      if (!STANDINGS_FILES.some((p) => paths.includes(p))) continue;
      committers.push(file);
      for (const p of STANDINGS_FILES) assert.ok(paths.includes(p), `${file}: ${line.trim()} lacks ${p}`);
      assert.ok(paths.includes("fixtures.json") && paths.includes("calendar"), `${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual([...new Set(committers)].sort(), ["refresh-data.yml", "team-events.yml"]);
  for (const [file, yml] of Object.entries(await workflowTexts())) {
    if (!/node scripts\/(build-standings|espn-tries)\.mjs/.test(yml)) continue;
    assert.ok(committers.includes(file), `${file} builds standings.json but never commits it`);
  }
});

// The workflow steps, as (name, body) blocks of the job's step list.
const stepsOf = (yml) => yml.split(/\n(?= {6}- )/).slice(1).map((b) => ({ name: (b.match(/name: (.*)/) ?? [])[1] ?? "", body: b }));

test("team-events and refresh-data: try cache, then standings, after the fixtures build; keyless; never fail the job", async () => {
  const all = await workflowTexts();
  for (const [file, cacheCmd] of [["team-events.yml", "node scripts/espn-tries.mjs"], ["refresh-data.yml", "node scripts/espn-tries.mjs --recent"]]) {
    const steps = stepsOf(all[file]);
    const at = (re) => steps.findIndex((s) => re.test(s.body));
    const fixtures = at(/node scripts\/(build-fixtures|fixtures-burst)\.mjs/);
    const cache = steps.findIndex((s) => s.name === "Cache ESPN try counts (keyless)");
    const build = steps.findIndex((s) => s.name === "Build standings.json (computed from results, zero vendor calls)");
    const commit = at(/git add /);
    assert.ok(fixtures >= 0 && fixtures < cache && cache < build && build < commit, `${file}: ${[fixtures, cache, build, commit]}`);
    assert.match(steps[cache].body, new RegExp(`run: ${cacheCmd.replace(/[.]/g, "\\.")}\\n`), `${file}: ${cacheCmd}`);
    assert.match(steps[build].body, /run: node scripts\/build-standings\.mjs\n/);
    for (const i of [cache, build]) {
      assert.match(steps[i].body, /continue-on-error: true/, `${file}: ${steps[i].name}`);
      assert.ok(!/secrets\.|if:/.test(steps[i].body), `${file}: ${steps[i].name} is keyless and unguarded`);
    }
  }
  // The integrity check reads the standings this run just built.
  const te = stepsOf(all["team-events.yml"]);
  assert.ok(te.findIndex((s) => s.name === "Build standings.json (computed from results, zero vendor calls)") < te.findIndex((s) => s.name === "Check competition integrity"));
});
