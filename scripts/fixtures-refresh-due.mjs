// Should this refresh tick rebuild fixtures.json? Prints "due" when yes.
//
// The refresh job runs every 15 min; build-fixtures is a full keyless-ESPN
// walk (~10s + a few hundred fetches), so it only runs when it can change
// something the app shows:
//   - a test/series/tour game is in its LIVE window (kickoff-15min .. +6h):
//     live status + running score need refreshing every tick;
//   - a test/series game from the last 48h still has no final: the fill
//     pass should catch it up (a probe/vendor may have lagged).
// Everything else is the daily team-events build's job. The tour-probe path
// (tour-results.json changing) is handled by the workflow's git diff, not
// here — tour scores come from api-sports, not ESPN.
import { readFile } from "node:fs/promises";

const LIVE_KINDS = new Set(["test", "series", "tour"]);
const PRE_MS = 15 * 60000;
const LIVE_MS = 6 * 3600 * 1000;
const CATCHUP_MS = 48 * 3600 * 1000;

export function refreshDue(fixtures, nowMs = Date.now()) {
  return (fixtures ?? []).some((f) => {
    if (!LIVE_KINDS.has(f.comp?.kind)) return false;
    const t = new Date(f.date).getTime();
    if (t - PRE_MS <= nowMs && nowMs - t < LIVE_MS) return true; // live window
    const unscored = f.homeScore == null || f.awayScore == null;
    return unscored && nowMs - t >= LIVE_MS && nowMs - t < CATCHUP_MS; // missing final
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try {
    const { fixtures } = JSON.parse(await readFile("fixtures.json", "utf8"));
    if (refreshDue(fixtures)) console.log("due");
  } catch {
    // no fixtures.json yet — the daily build owns bootstrapping it
  }
}
