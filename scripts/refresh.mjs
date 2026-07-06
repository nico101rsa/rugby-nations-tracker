// The refresh scheduler "brain". decideMode() is a pure function of (now,
// schedule, remaining budget) → which UTC dates to fetch. main() runs it and
// drives the fetcher. Fires every 15 min from GitHub Actions (UTC).
import { pathToFileURL } from "node:url";
import { scheduleKickoffs } from "./static-fixtures.mjs";
import { refresh, refreshNewsOnly, utcDateStr, datesForWindow } from "./fetch-nations.mjs";

const PRE_MS = 15 * 60000;    // start polling 15 min before kickoff
const POST_MS = 150 * 60000;  // keep polling 150 min after (play + HT + FT settle)
const GUARD_FLOOR = 10;       // never spend the last ~10 requests of the day
const SWEEP_WINDOW_DAYS = 2;  // today..+2 UTC = 3 calls per sweep

// mode: "live" | "sweep" | "idle" | "guard"
export function decideMode({ now, schedule, remaining, guardFloor = GUARD_FLOOR }) {
  if (remaining != null && remaining < guardFloor) {
    return { mode: "guard", dates: [], reason: `budget ${remaining} < ${guardFloor}` };
  }

  const t = now.getTime();
  const liveDates = new Set();
  for (const m of schedule) {
    if (!m.timeConfirmed) continue; // TBC kickoffs get sweep-only coverage
    const ko = new Date(m.date).getTime();
    if (t >= ko - PRE_MS && t <= ko + POST_MS) {
      liveDates.add(utcDateStr(new Date(ko)));
    }
  }
  if (liveDates.size) {
    return { mode: "live", dates: [...liveDates].sort(), reason: "match live/imminent" };
  }

  // Sweep at 00/06/12/18 UTC (cron fires every 15 min; take the first tick).
  const isSweepSlot = now.getUTCHours() % 6 === 0 && now.getUTCMinutes() < 15;
  if (isSweepSlot) {
    const start = utcDateStr(now);
    const end = utcDateStr(new Date(t + SWEEP_WINDOW_DAYS * 86400000));
    return { mode: "sweep", dates: datesForWindow(start, end), reason: "6-hourly sweep slot" };
  }

  return { mode: "idle", dates: [], reason: "no live match, not a sweep slot" };
}

async function mainRun() {
  const decision = decideMode({
    now: new Date(),
    schedule: scheduleKickoffs(),
    remaining: null, // first run of the process has no prior header; guard applies next time
  });
  console.log(`[refresh] mode=${decision.mode} — ${decision.reason} — dates=${decision.dates.join(",") || "none"}`);

  if (decision.dates.length === 0) {
    // idle / guard: no api-sports spend, but the news scrape is free + keyless,
    // so keep the headlines fresh on every tick instead of only on sweeps.
    const n = await refreshNewsOnly();
    console.log(`[refresh] news-only`, n);
    return;
  }

  const result = await refresh({ dates: decision.dates });
  console.log(`[refresh] done`, result.counts, `| rate remaining: ${result.remaining}`);

  if (result.remaining != null && result.remaining < GUARD_FLOOR) {
    console.warn(`[refresh] WARNING: only ${result.remaining} requests left today`);
  }
}

// pathToFileURL (not `file://${argv[1]}`) so the guard also matches when the
// script path contains spaces or other characters URLs percent-encode.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainRun().catch((e) => { console.error(e); process.exit(1); });
}
