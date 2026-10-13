// The final push of refresh-data.yml's "Commit and push if changed" step.
//
// Why not `git push || (git pull --rebase --autostash && git push)` like the
// other jobs: this job's live burst holds the run for up to ~2h, and during
// it another writer (the digests job's nations.json, team-events' fixtures
// and standings) often lands the same file. That rebase then CONFLICTS, the
// step exits red, and GitHub emails Nico a failure for a refresh whose data
// was already published by the burst. On 9–10 Oct 2026 that was 36 failure
// runs in a day (and 35 on 2 Oct, 21 on 25 Sep): every one of them noise.
//
// So a conflict exits green with a ::notice::. Everything this job commits
// is rebuilt from fresh inputs on the next run (15 min, 10 on Saturdays),
// which publishes on top of the other writer's commit. Only "lost" — four
// straight lost races, which has not happened since the retry landed —
// stays red, so a push that can't land at all (a token or permission
// fault) still fails the run and the watchdog still sees it.
import { pushOutcome } from "./git-push-retry.mjs";

export function exitCodeFor(outcome) {
  return outcome === "lost" ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outcome = pushOutcome();
  if (outcome === "dropped" || outcome === "kept") {
    console.log("::notice::Another job pushed the same file first; this run's tail commit was dropped and the next run republishes on top of it.");
  }
  process.exit(exitCodeFor(outcome));
}
