// The refresh scheduler "brain". decideMode() is a pure function of (now,
// schedule, remaining budget) → which UTC dates to fetch. main() runs it and
// drives the fetcher. Fires every 15 min from GitHub Actions (UTC).
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { scheduleKickoffs } from "./static-fixtures.mjs";
import { refresh, refreshNewsOnly, utcDateStr, datesForWindow } from "./fetch-nations.mjs";

const PRE_MS = 15 * 60000;    // start polling 15 min before kickoff
const POST_MS = 150 * 60000;  // keep polling 150 min after (play + HT + FT settle)
const GUARD_FLOOR = 10;       // never spend the last ~10 requests of the day
const SWEEP_WINDOW_DAYS = 2;  // today..+2 UTC = 3 calls per sweep
// Live-burst tuning. A Round has up to 6 matches staggered across a ~17h UTC
// window (near-continuous "live"), and api-sports free tier is 100 calls/day.
// 12-min polling ≈ the nominal */15 cron's spend (~today's ~76/Sat) but fires
// RELIABLY once a run latches, instead of the cron dropping into 1.5-4h gaps.
// The GUARD_FLOOR backstop stops a burst before the daily budget is exhausted.
const LIVE_POLL_INTERVAL_MS = 12 * 60000;   // 12 min between live fetches (quota-safe)
const LIVE_BURST_MAX_MS = 2 * 60 * 60000;   // one landed fire covers ~a full match (<6h job cap)

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultIsLive() {
  return decideMode({ now: new Date(), schedule: scheduleKickoffs(), remaining: null }).mode === "live";
}

// Publish the freshly-written data to the public repo mid-burst. Only runs in
// CI (GITHUB_ACTIONS) — locally it's a no-op so a live-window run just writes
// the file, as before. The CDN serves the site-ROOT nations.json (the workflow
// normally cp's it once at the end); during a live burst we must mirror it per
// iteration or the phone sees nothing until the run exits. Retries once through
// a rebase if a concurrent push raced us.
function gitPublish(msg) {
  if (!process.env.GITHUB_ACTIONS) return;
  execSync("cp public/nations.json nations.json");   // mirror the file the CDN serves
  execSync("git add -A");
  const staged = execSync("git diff --cached --name-only").toString().trim();
  if (!staged) return;                               // nothing changed → no Pages build
  execSync(`git -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" commit -m ${JSON.stringify(msg)}`);
  try { execSync("git push"); }
  catch { execSync("git pull --rebase --autostash && git push"); }
}

// When a match is live, one landed cron run polls in a loop — publishing each
// iteration — for up to burstMs (default ~2h), instead of a single fetch-and-
// exit. This turns a single scheduled fire (GitHub drops most) into a full
// match's worth of reliable coverage. Deps are injectable for tests.
export async function runLiveBurst({
  dates,
  refresh: doRefresh = refresh,
  sleep = wait,
  now = () => Date.now(),
  isLive = defaultIsLive,
  publish = gitPublish,
  intervalMs = LIVE_POLL_INTERVAL_MS,
  burstMs = LIVE_BURST_MAX_MS,
  guardFloor = GUARD_FLOOR,
} = {}) {
  const started = now();
  let iterations = 0;
  while (true) {
    const result = await doRefresh({ dates });
    iterations++;
    publish(`data: live refresh (${new Date().toISOString()})`);
    if (result.remaining != null && result.remaining < guardFloor) {
      console.warn(`[refresh] live burst stop: budget ${result.remaining} < ${guardFloor}`);
      break;
    }
    if (now() - started >= burstMs) break;   // burst window elapsed
    if (!isLive()) break;                     // match window closed
    await sleep(intervalMs);
  }
  return { iterations };
}

async function mainRun() {
  const decision = decideMode({
    now: new Date(),
    schedule: scheduleKickoffs(),
    remaining: null, // first run of the process has no prior header; guard applies next time
  });
  console.log(`[refresh] mode=${decision.mode} — ${decision.reason} — dates=${decision.dates.join(",") || "none"}`);

  if (decision.mode === "live") {
    // Live: poll in a loop, publishing each fetch, so one landed fire covers
    // ~a full match even when GitHub drops the following scheduled runs.
    const { iterations } = await runLiveBurst({ dates: decision.dates });
    console.log(`[refresh] live burst done — ${iterations} fetch(es)`);
    return;
  }

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
