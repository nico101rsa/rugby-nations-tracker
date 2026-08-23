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

import { fetchEventsByCode, assembleTeams, mergeRefreshed } from "./fetch-team-events.mjs";

const SETTLE_MS = 150 * 60000; // kickoff -> earliest attempt
const WINDOW_MS = 12 * 3600 * 1000; // kickoff -> last attempt
const MAX_TEAMS = 8;
const LOST_WINDOW_MS = 72 * 3600 * 1000; // kickoff -> stop hunting a game lost from both lists

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

const dayKey = (d) => {
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// Which teams have a played game sitting in NEITHER list?
//
// teamsDue above only reads `next`, so it can only find a game that is waiting
// there for its final. A game can also vanish from BOTH lists. The two vendor
// halves are fetched and kept independently (#92), so a run whose `next`
// answered and whose `last` 503'd takes the fresh `next` — correctly missing
// the game just played — and keeps the STALE `last`, which never received it.
// Nothing then goes looking for that game again: it is not in `next` for
// teamsDue to find, and not in `last` to be charted.
//
// That is exactly what happened to New Zealand's 22 Aug loss at Ellis Park.
// South Africa's copy of the very same match published fine (its `last`
// answered and its `next` 503'd — the mirror case, fixed in #93), so the Team
// page charted the game for one side and not the other.
//
// fixtures.json is the independent witness. It carries every international
// with its final score, built from ESPN rather than this vendor, so it can say
// a game was played even when the vendor's `last` never arrived. Matching is
// by calendar day and opponent rather than id: the two feeds number events
// differently and always will.
//
// The window is far wider than teamsDue's 12h. That bound is for a result the
// vendor has not settled yet, where the daily full run is the backstop. This
// one is for a game already known to be played and simply lost — and while it
// stays lost the form chart is silently wrong, so it is worth hunting across a
// weekend of vendor trouble rather than a single evening.
export function teamsMissingResults(teams, fixtures, nowMs = Date.now(), max = MAX_TEAMS) {
  const latest = new Map();

  for (const f of fixtures ?? []) {
    if (f?.homeScore == null || f?.awayScore == null) continue;  // not played out
    if (f?.status?.live) continue;                               // still on
    const kickoff = new Date(f?.date).getTime();
    if (!Number.isFinite(kickoff)) continue;
    const age = nowMs - kickoff;
    if (age < SETTLE_MS || age > LOST_WINDOW_MS) continue;

    for (const [side, other] of [[f.home, f.away], [f.away, f.home]]) {
      if (!side?.tracked || !side?.code) continue;               // untracked tour sides have no entry
      const t = teams?.[side.code];
      if (!t) continue;
      const sameGame = (g) =>
        dayKey(g?.date) === dayKey(kickoff) &&
        (other?.code ? g?.opponentCode === other.code : (g?.opponent ?? null) === (other?.name ?? null));
      if ((t.last ?? []).some(sameGame)) continue;               // already published
      if ((t.next ?? []).some(sameGame)) continue;               // teamsDue owns this one
      if (!latest.has(side.code) || kickoff > latest.get(side.code)) latest.set(side.code, kickoff);
    }
  }

  return [...latest.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([code]) => code);
}

// Re-exported for this module's tests and callers: the merge now lives in
// fetch-team-events.mjs, because the full run needs the same "keep the
// previous entry" rule for teams a vendor 5xx made it skip.
export { mergeRefreshed };

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const te = JSON.parse(await readFile("team-events.json", "utf8"));

  // fixtures.json is read from the same checkout; absent, the lost-game rule
  // simply finds nothing and the job behaves exactly as it did before.
  const fixtures = await readFile("fixtures.json", "utf8")
    .then((raw) => JSON.parse(raw).fixtures ?? [])
    .catch(() => []);

  const waiting = teamsDue(te.teams);
  const lost = teamsMissingResults(te.teams, fixtures);
  if (lost.length) console.log(`played but missing from BOTH lists: ${lost.join(", ")}`);
  const due = [...new Set([...waiting, ...lost])].slice(0, MAX_TEAMS);
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

  const still = [...new Set([...teamsDue(out.teams), ...teamsMissingResults(out.teams, fixtures)])];
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
