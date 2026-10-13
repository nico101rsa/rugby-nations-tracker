// One push, retried against the other jobs pushing to main.
//
// main is shared by half a dozen scheduled jobs — the two live bursts, the
// news harvest, rankings, team-events and the daily digests — so a rejected
// push is routine here, not exceptional. One rebase-and-retry was not enough:
// on 2026-08-22 the fixtures burst's retry lost a SECOND race and threw,
// killing run 4349 twenty-five minutes into the match it existed to cover.
// That day's digests commit is even labelled "(reapplied over live refresh)".
//
// Both bursts call this. The bug existed in two places because the logic did.
import { execSync } from "node:child_process";

export const PUSH_ATTEMPTS = 4;

// True when the push landed, false when it kept losing. NEVER throws: an
// unpushed commit stays local and the next pass carries it along with fresher
// data, which beats ending a burst mid-match every time.
//
// A rebase that CONFLICTS is the other way to lose a burst, and a quieter one.
// `git pull --rebase` stops mid-rebase and leaves the checkout there; every
// later add, commit and pull in the same burst then fails ("unmerged paths",
// "rebase in progress"), so the burst carries on polling and publishes nothing
// for the rest of the match. Two writers of one file are enough: the digests
// job rewrites nations.json during Saturday windows, and team-events commits
// fixtures.json, standings.json (whose `updatedAt` is wall-clock) and the
// ESPN try cache while the fixtures burst does. So when the rebase fails AND
// a rebase is in progress, abort it and drop this pass's unpushed commit by
// moving to the upstream. Everything the bursts publish is rebuilt from
// fresh inputs on every pass, so the next pass republishes on top of the
// other writer's commit; the loss is one pass. `--keep`, not `--hard`: an
// uncommitted file another step wrote (refresh.mjs runs before the fixtures
// burst in the same job) survives unless upstream changed it too, in which
// case git refuses and the commit simply stays local, as before.
export function pushWithRetries(opts) {
  return pushOutcome(opts) === "pushed";
}

// The same push, saying how it ended, for a caller that must tell a conflict
// from a real failure: "pushed"; "dropped" (a conflicting rebase was aborted
// and this pass's commit dropped) or "kept" (aborted, commit left local)
// when another writer just landed the same file; "lost" when every attempt
// lost a race. The final commit step of refresh-data.yml exits green on the
// two conflict outcomes and red only on "lost" (scripts/push-data.mjs).
export function pushOutcome({
  run = (cmd) => execSync(cmd),
  attempts = PUSH_ATTEMPTS,
  log = console.warn,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run("git push");
      return "pushed";
    } catch {
      if (attempt === attempts) break;
      // Rebase onto whoever beat us, then try again. If the rebase itself
      // loses a race, don't give up on its account — just push again.
      try {
        run("git pull --rebase --autostash");
      } catch {
        if (abortRebase(run)) {
          try {
            run("git reset --keep @{u}");
            log("[git] rebase conflicted; aborted it and dropped this pass's commit — the next pass rebuilds on top of main");
            return "dropped";
          } catch {
            log("[git] rebase conflicted; aborted it, commit stays local for the next pass");
            return "kept";
          }
        }
        /* not a conflict (a fetch or race failure): next attempt */
      }
    }
  }
  log(`[git] push lost ${attempts} races; commit stays local for the next pass`);
  return "lost";
}

// True when a rebase was in progress and is now aborted (the checkout is back
// on its own branch, autostash restored); false when there was none to abort.
function abortRebase(run) {
  try {
    run("git rebase --abort");
    return true;
  } catch {
    return false;
  }
}
