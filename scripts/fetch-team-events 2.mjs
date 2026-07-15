// Each tracked nation's recent internationals + upcoming fixtures ACROSS ALL
// competitions (Rugby Championship, Six Nations, tours, friendlies — not just
// the Nations Championship) -> team-events.json on the Pages CDN.
//
// Source: api-sports `games?team=<id>&season=<year>` (same vendor + key as
// nations.json; team ids match the app's src/teams.js). Budget: 12 teams x 2
// seasons = 24 calls, run SUNDAYS ONLY (own workflow) so the ~100/day free
// tier stays clear for Saturday live polling.
//
// Consumers (app, later build): the Team page's season bar chart (all recent
// games, incl. untracked opponents like Portugal) and rolling last-10
// averages (tracked opponents only — `tracked` flags each entry).

const TRACKED = {
  386: "ENG", 387: "FRA", 388: "IRE", 389: "ITA", 390: "SCO", 391: "WAL",
  460: "ARG", 461: "AUS", 463: "JPN", 465: "NZL", 467: "RSA", 28: "FIJ",
};
export const TEAM_IDS = Object.keys(TRACKED).map(Number);

// A game is a result once both scores exist and it isn't waiting to start.
const isFinished = (g) =>
  g.scores?.home != null && g.scores?.away != null && g.status?.short !== "NS";

const entryFor = (g, teamId) => {
  const home = g.teams.home.id === teamId;
  const opp = home ? g.teams.away : g.teams.home;
  const us = home ? g.scores?.home : g.scores?.away;
  const them = home ? g.scores?.away : g.scores?.home;
  return {
    id: g.id,
    date: g.date,
    league: g.league?.name ?? null,
    opponent: opp.name,
    opponentCode: TRACKED[opp.id] ?? null,
    tracked: opp.id in TRACKED,
    homeAway: home ? "H" : "A",
    us: us ?? null,
    them: them ?? null,
    result: !isFinished(g) ? null : us > them ? "W" : us < them ? "L" : "D",
  };
};

// Pure core: raw api-sports games per team -> { RSA: { last: [...<=10 oldest
// first], next: [...<=5] } }. `now` injectable for tests.
export function buildTeamEvents(gamesByTeamId, now = Date.now()) {
  const teams = {};
  for (const [idStr, games] of Object.entries(gamesByTeamId)) {
    const teamId = Number(idStr);
    const sorted = [...games].sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = sorted.filter(isFinished).slice(-10).map((g) => entryFor(g, teamId));
    const next = sorted
      .filter((g) => !isFinished(g) && new Date(g.date).getTime() >= now)
      .slice(0, 5)
      .map((g) => entryFor(g, teamId));
    teams[TRACKED[teamId]] = { last, next };
  }
  return teams;
}

const BASE = "https://v1.rugby.api-sports.io";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGames(teamId, season) {
  const r = await fetch(`${BASE}/games?team=${teamId}&season=${season}`, {
    headers: { "x-apisports-key": process.env.RUGBY_API_KEY },
  });
  const j = await r.json();
  if (j.errors && !Array.isArray(j.errors) && Object.keys(j.errors).length) {
    throw new Error(`team ${teamId}/${season}: ${Object.values(j.errors).join(" ")}`);
  }
  return j.response ?? [];
}

async function main() {
  const { writeFile } = await import("node:fs/promises");
  if (!process.env.RUGBY_API_KEY) throw new Error("RUGBY_API_KEY not set");
  const year = new Date().getUTCFullYear();
  const byTeam = {};
  for (const id of TEAM_IDS) {
    // Two seasons so "last 10" survives January (api-sports seasons = years).
    const games = [...(await apiGames(id, year - 1)), ...(await sleep(6500), await apiGames(id, year))];
    byTeam[id] = games;
    await sleep(6500); // ~9 req/min, under the vendor's 10/min ceiling
  }
  const out = {
    updatedAt: new Date().toISOString(),
    source: "api-sports",
    teams: buildTeamEvents(byTeam),
  };
  await writeFile("team-events.json", JSON.stringify(out, null, 1) + "\n");
  const counts = Object.entries(out.teams).map(([c, t]) => `${c}:${t.last.length}/${t.next.length}`).join(" ");
  console.log(`team-events.json written — last/next per team: ${counts}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
