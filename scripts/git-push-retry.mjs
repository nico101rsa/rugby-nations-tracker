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
export function pushWithRetries({
  run = (cmd) => execSync(cmd),
  attempts = PUSH_ATTEMPTS,
  log = console.warn,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      run("git push");
      return true;
    } catch {
      if (attempt === attempts) break;
      // Rebase onto whoever beat us, then try again. If the rebase itself
      // loses a race, don't give up on its account — just push again.
      try { run("git pull --rebase --autostash"); } catch { /* next attempt */ }
    }
  }
  log(`[git] push lost ${attempts} races; commit stays local for the next pass`);
  return false;
}
