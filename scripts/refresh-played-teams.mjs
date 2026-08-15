// Post-match catch-up for team-events.json: re-fetches ONLY the teams whose
// game has just finished, so a result reaches the app's Team page (form bar
// chart, last-10 averages) within hours of the final whistle instead of at the
// next full run.
//
// Why this exists (Nico, 2026-08-15): the full team-events job runs daily at
// 01:00 UTC plus a Saturday 19:00 UTC catch-up, and that Saturday slot was
// picked for Northern-Hemisphere kickoffs finishing ~17:20 UTC. Australia beat
// Japan 56-17 in Townsville at 05:15 UTC; the 01:00 run had already committed,
// so at 20:24 AEST the Team page still drew the 15 Aug test as an upcoming
// placeholder while the news card carried the result. Any Asia-Pacific kickoff
// hits the same ~12h hole.
//
// Cost: the due check is pure local JSON — a run with nothing to catch up
// spends ZERO vendor calls and exits. When a game is due it is 2 SportsAPI Pro
// calls per team (4 for a lone test), against the 100/day free tier shared
// with the full job and the box-score harvest. Bounds that keep it there:
//
//   - SETTLE_MS: a game is only "due" 150 min after kickoff (play + HT + FT
//     settle — same figure refresh.mjs polls to).
//   - WINDOW_MS: attempts stop 12h after kickoff. If the vendor never marks
//     the game finished, the full run picks it up later; we do not retry
//     forever.
//   - MAX_TEAMS: at most 8 teams (16 calls) per run. A full NC Saturday is
//     already covered by the 19:00 UTC run — this job is for the games that
//     schedule misses, not a replacement for it.
//
// A team stops being due the moment the game lands in `last`, so a successful
// catch-up makes every later run a no-op by itself.

import { fetchEventsByCode, assembleTeams } from "./fetch-team-events.mjs";

const SETTLE_MS = 150 * 60000; // kickoff -> earliest attempt
const WINDOW_MS = 12 * 3600 * 1000; // kickoff -> last attempt
const MAX_TEAMS = 8;

// Which teams have a kicked-off game still sitting unscored in `next`?
// Returns team codes, most recent kickoff first, capped at MAX_TEAMS.
export function teamsDue(teams, nowMs = Date.now(), max = MAX_TEAMS) {
  const due = [];
  for (const [code, t] of Object.entries(teams ?? {})) {
    let latest = null;
    for (const g of t?.next ?? []) {
      if (g.us != null && g.them != null) continue; // already has a final
      const t0 = new Date(g.date).getTime();
      if (!Number.isFinite(t0)) continue;
      const age = nowMs - t0;
      if (age < SETTLE_MS || age > WINDOW_MS) continue;
      if (latest == null || t0 > latest) latest = t0;
    }
    if (latest != null) due.push({ code, kickoff: latest });
  }
  return due.sort((a, b) => b.kickoff - a.kickoff).slice(0, max).map((d) => d.code);
}

// Splice freshly fetched teams into the published map. Only the refreshed
// codes change; every other team is left byte-identical. A non-null enrichment
// already on file is never clobbered by a null re-fetch (same rule as
// archive-team-events.mjs — an ESPN stats hiccup must not erase tries/cards).
export function mergeRefreshed(prevTeams, freshTeams) {
  const out = { ...(prevTeams ?? {}) };
  for (const [code, fresh] of Object.entries(freshTeams ?? {})) {
    const prevById = new Map((prevTeams?.[code]?.last ?? []).map((g) => [String(g.id), g]));
    out[code] = {
      ...fresh,
      last: (fresh.last ?? []).map((g) => {
        const prev = prevById.get(String(g.id));
        if (!prev) return g;
        const merged = { ...g };
        for (const k of ["tries", "cards", "venue"]) {
          if (g[k] == null && prev[k] != null) merged[k] = prev[k];
        }
        return merged;
      }),
    };
  }
  return out;
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const te = JSON.parse(await readFile("team-events.json", "utf8"));

  const due = teamsDue(te.teams);
  if (due.length === 0) {
    console.log("no finished-but-unpublished games — no vendor calls made");
    return;
  }
  if (!process.env.SPORTSAPIPRO_KEY) throw new Error("SPORTSAPIPRO_KEY not set");

  const teamIds = Object.fromEntries(
    due.map((code) => [code, te.teamIds?.[code]]).filter(([, id]) => id != null),
  );
  const unknown = due.filter((code) => !(code in teamIds));
  if (unknown.length) console.log(`no cached vendor id for ${unknown.join(", ")} — left to the full run`);
  if (Object.keys(teamIds).length === 0) return;

  console.log(`catching up ${Object.keys(teamIds).join(", ")} (${Object.keys(teamIds).length * 2} vendor calls)`);
  const eventsByCode = await fetchEventsByCode(teamIds);
  const statsJson = await readFile("stats.json", "utf8").then(JSON.parse).catch(() => null);
  const fresh = await assembleTeams(eventsByCode, statsJson);

  const out = { ...te, updatedAt: new Date().toISOString(), teams: mergeRefreshed(te.teams, fresh) };
  await writeFile("team-events.json", JSON.stringify(out, null, 1) + "\n");

  const still = teamsDue(out.teams);
  const landed = due.filter((c) => !still.includes(c));
  console.log(
    `team-events.json written — results published for: ${landed.join(", ") || "none"}` +
      (still.length ? `; vendor still has no final for: ${still.join(", ")}` : ""),
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
