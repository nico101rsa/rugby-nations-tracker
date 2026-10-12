// The keyless ESPN burst for fixtures.json — the mirror of the api-sports
// burst refresh.mjs already runs for nations.json, which fixtures.json never
// had.
//
// decideMode() reads scheduleKickoffs(), the Nations Championship schedule in
// static-fixtures.mjs. So on a test, series or tour Saturday the mode is never
// "live" and no burst ever latches — and fixtures.json, the feed carrying
// EVERY test, series and tour score, was left with the cron as its only
// cadence. GitHub drops scheduled runs (1.5-4h gaps observed, which is why the
// nations burst exists at all). On 22 Aug 2026 the Springboks-New Zealand
// series opener at Ellis Park sat on 3-0 for 11.5 minutes while ESPN already
// had 10-5, because the */10 Saturday slot simply did not fire.
//
// The nations burst is paced by QUOTA — 12 min, against a 100-call/day free
// tier. This one is keyless, so the interval is only about not hammering a
// free endpoint. Three minutes, and gitPublish skips the commit when the build
// changed nothing, so a quiet stretch costs a fetch and no Pages build.

import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pushWithRetries } from "./git-push-retry.mjs";
import { liveTracked } from "./espn-scored.mjs";

const PRE_MS = 15 * 60000;             // start 15 min before kickoff
// Play + HT + the FT settle. 150 until 2026-10-04, when the app's full-time
// alert (kickoff + 160) needed the final in by then: ESPN's 12 Sep SA v NZ
// final first landed at 150.4 min. This source is keyless, so the longer tail
// costs nothing but a few no-op rebuilds.
const POST_MS = 180 * 60000;
const POLL_MS = 3 * 60000;
const BURST_MAX_MS = 2 * 60 * 60000;   // one landed fire covers a full match, well under the 6h job cap
const MAX_CONSECUTIVE_FAILURES = 5;    // ~15 min of nothing working — stop pretending

// Is a test/series/tour game actually in play right now?
//
// Deliberately narrower than fixtures-refresh-due's 6h window. That one asks
// "is a rebuild worth doing at all", and stays open for hours so a final that
// a vendor published late still gets caught. This one asks "should we still be
// LOOPING" — and looping six hours past a kickoff would spend most of the job
// cap rebuilding a finished game.
export function inBurstWindow(fixtures, nowMs = Date.now()) {
  return (fixtures ?? []).some((f) => {
    // Tests, series, tours and ESPN-scored competitions (see espn-scored.mjs).
    // Nations Championship rounds stay with the nations.json burst.
    if (!liveTracked(f?.comp)) return false;
    const ko = new Date(f.date).getTime();
    return Number.isFinite(ko) && nowMs >= ko - PRE_MS && nowMs <= ko + POST_MS;
  });
}

// Build once, then keep rebuilding while a game is in play. The first build is
// unconditional: the workflow only reaches this script when a rebuild is
// already warranted, and that includes the not-live catch-up cases (a missing
// final, the tour probe recording a result), which want exactly one pass.
// Deps injectable for tests, matching runLiveBurst.
export async function runFixturesBurst({
  build,
  publish = () => {},
  stillLive = async () => false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  intervalMs = POLL_MS,
  burstMs = BURST_MAX_MS,
} = {}) {
  const started = now();
  let iterations = 0;
  let consecutiveFailures = 0;
  while (true) {
    try {
      await build();
      iterations++;
      publish(`Live fixtures refresh ${new Date().toISOString()}`);
      consecutiveFailures = 0;
    } catch (err) {
      // A blip at ESPN or a lost push race must NOT end the burst. Run 4349 on
      // 2026-08-22 died at 16:41 on exactly this: one rejected push threw out
      // of gitPublish and took the whole run with it, mid-match. The next pass
      // republishes the newer score anyway, so a single bad pass costs three
      // minutes, not the rest of the game.
      consecutiveFailures++;
      console.warn(`[fixtures-burst] pass failed (${consecutiveFailures} in a row): ${err.message}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`[fixtures-burst] ${consecutiveFailures} consecutive failures — giving up`);
        break;
      }
    }
    if (now() - started >= burstMs) break;    // burst window elapsed
    if (!(await stillLive())) break;          // nothing in play any more
    await sleep(intervalMs);
  }
  return { iterations, consecutiveFailures };
}

// One pass: rebuild fixtures.json (and calendar/ with it), then cache any new
// try counts and rebuild standings.json from it — so a Six Nations or World
// Cup result moves its table on the same 3-minute pass that lands the score,
// not up to 15 minutes later. Only the fixtures build can fail a pass. The two
// standings steps are keyless and zero-quota; both scripts catch their own
// errors and exit 0, and they are wrapped here as well, so even a crash (a
// syntax error, a missing file) is logged and the pass still publishes
// fixtures.json — a throw would count toward MAX_CONSECUTIVE_FAILURES and
// could end the burst mid-match.
// `--recent`: espn-tries re-asks a game ESPN has no try counts for only near
// its kickoff (espn-tries.mjs RECENT_HOURS); the daily team-events run keeps
// the backlog.
export const BUILD_STEP = "node scripts/build-fixtures.mjs";
export const STANDINGS_STEPS = ["node scripts/espn-tries.mjs --recent", "node scripts/build-standings.mjs"];

export function buildPass({ run = (cmd) => execSync(cmd, { stdio: "inherit" }), warn = console.warn } = {}) {
  run(BUILD_STEP);
  for (const cmd of STANDINGS_STEPS) {
    try {
      run(cmd);
    } catch (err) {
      warn(`[fixtures-burst] ${cmd} failed (${err.message}) — fixtures.json still publishes`);
    }
  }
}

// Mid-burst publish, mirroring refresh.mjs's gitPublish. CI only — locally the
// burst just rewrites the file, as a plain build would. fixtures.json is served
// from the site root, so unlike nations.json there is nothing to mirror.
// calendar/ is rebuilt with every fixtures.json (build-calendars.mjs) and must
// ride the same commit: a pass that left it out would publish a corrected
// kickoff to the app and not to the calendars. standings.json and the ESPN try
// cache are rebuilt on every pass (buildPass) and ride it too. All of them are
// byte-stable when nothing moved, so this adds nothing to a quiet pass's no-op.
export const PUBLISH_PATHS = ["fixtures.json", "calendar", "standings.json", "scripts/match-tries-espn.json"];

function gitPublish(msg) {
  if (!process.env.GITHUB_ACTIONS) return;
  execSync(`git add ${PUBLISH_PATHS.join(" ")}`);
  if (!execSync("git diff --cached --name-only").toString().trim()) return; // no change → no Pages build
  execSync(`git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -m ${JSON.stringify(msg)}`);

  pushWithRetries();
}

const readFixtures = async () => {
  try { return JSON.parse(await readFile("fixtures.json", "utf8")).fixtures ?? []; }
  catch { return []; }   // no fixtures.json yet — the daily build owns bootstrapping it
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const { iterations } = await runFixturesBurst({
    build: () => buildPass(),
    publish: gitPublish,
    // Re-read from disk each time: the build we just ran is what decides
    // whether the game is still on.
    stillLive: async () => inBurstWindow(await readFixtures()),
  });
  console.log(`[fixtures-burst] ${iterations} build(s)`);
}
