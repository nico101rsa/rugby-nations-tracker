// Read-only SportsAPI Pro health check, run nightly for the week of 24-30 Aug
// 2026 to establish whether the FREE tier is being throttled or quietly
// withdrawn.
//
// Background (2026-08-23): the nightly team-events job failed five days
// running. On 23 Aug it logged 36 separate 503s and skipped all 12 teams. A
// probe that evening had `/teams/4227/events/last/0` (New Zealand) at 503
// while `/next/0` answered 200, and South Africa 503 on BOTH halves — so this
// is not one bad team, and `last` is sicker than `next`. The key is on the
// free tier, so the likeliest explanation is throttling or deprecation rather
// than an outage, and a support ticket is weak leverage. This log is the
// evidence base for deciding whether to move `last` onto keyless ESPN.
//
// Cost: 2 teams x 2 halves = 4 calls a night against the 100/day tier.
// Writes a row to vendor-probe-log.json; never touches team-events.json.

const TEAMS = { NZL: 4227, RSA: 4231 };
const LOG = "vendor-probe-log.json";

export async function probe(team, half, fetchImpl = fetch) {
  const url = `https://api.sportsapipro.com/v2/rugby/api/teams/${team}/events/${half}/0`;
  try {
    const res = await fetchImpl(url, { headers: { "x-api-key": process.env.SPORTSAPIPRO_KEY } });
    let events = null;
    try {
      events = ((await res.json()).events ?? []).length;
    } catch {
      events = null;
    }
    return { status: res.status, events };
  } catch (err) {
    // A DNS/socket failure is its own signal — record it, don't crash the run.
    return { status: 0, events: null, error: err.message };
  }
}

// A night is healthy only if EVERY probed call returned 200. A partial answer
// is what broke New Zealand's chart in the first place, so it is not "up".
export function verdict(rows) {
  const bad = rows.filter((r) => r.status !== 200);
  if (!bad.length) return { healthy: true, summary: "all endpoints 200" };
  return {
    healthy: false,
    summary: bad.map((r) => `${r.code}/${r.half} ${r.status}`).join(", "),
  };
}

// Consecutive unhealthy nights ending at the most recent entry.
export function deadStreak(entries) {
  let n = 0;
  for (const e of [...entries].reverse()) {
    if (e.healthy) break;
    n += 1;
  }
  return n;
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  if (!process.env.SPORTSAPIPRO_KEY) throw new Error("SPORTSAPIPRO_KEY not set");

  const rows = [];
  for (const [code, id] of Object.entries(TEAMS)) {
    for (const half of ["last", "next"]) {
      const r = await probe(id, half);
      rows.push({ code, half, ...r });
      console.log(`${code} (${id}) ${half}: HTTP ${r.status}${r.events == null ? "" : `, ${r.events} events`}`);
    }
  }

  const v = verdict(rows);
  const entries = await readFile(LOG, "utf8").then((s) => JSON.parse(s).entries ?? []).catch(() => []);
  entries.push({ at: new Date().toISOString(), healthy: v.healthy, summary: v.summary, rows });
  await writeFile(LOG, JSON.stringify({ entries }, null, 1) + "\n");

  const streak = deadStreak(entries);
  console.log(v.healthy ? "vendor healthy" : `vendor DEGRADED — ${v.summary} (night ${streak} in a row)`);

  // Escalate once, at three consecutive dead nights, so a one-off blip stays
  // quiet but a sustained withdrawal actually reaches Nico. Anything less
  // than an assigned + @mentioned issue is a notification he never sees.
  if (streak === 3) {
    const { postIssue } = await import("./notify.mjs");
    await postIssue({
      title: `SportsAPI Pro free tier down ${streak} nights running`,
      body:
        `The nightly vendor probe has failed ${streak} nights in a row.\n\n` +
        `Latest: ${v.summary}\n\n` +
        `The key is on the FREE tier, so this is more likely throttling or a quiet\n` +
        `withdrawal than an outage. Evidence is in \`${LOG}\`.\n\n` +
        `Decision to make: move the \`last\` (results) call onto keyless ESPN, which\n` +
        `already supplies per-team results for team-events.json.`,
    });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
