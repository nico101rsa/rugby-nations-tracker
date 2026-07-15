// Each tracked nation's recent internationals + upcoming fixtures ACROSS ALL
// competitions (Rugby Championship, Six Nations, tours, friendlies — not just
// the Nations Championship) -> team-events.json on the Pages CDN.
//
// Source: SportsAPI Pro `/teams/:id/events/last|next/:page` (same vendor +
// key as stats.json). api-sports was tried first but its free plan rejects
// `games?season=` outside 2022–2024, so it cannot serve current seasons here.
// Vendor team ids are resolved once by name from NC schedule dates (names
// match nations.json exactly — same alignment findEvent in fetch-stats.mjs
// relies on) and cached inside team-events.json for later runs.
//
// Budget: first run ≈ 2 schedule + 24 event calls, later runs 24 — paced
// 6.5 s/call under the 10/min ceiling, Sundays only (100/day tier shared
// with the daily stats harvest, never with Saturday live polling).
//
// Consumers (app, later build): the Team page's season bar chart (all recent
// games, incl. untracked opponents like Portugal) and rolling last-10
// averages (tracked opponents only — `tracked` flags each entry).

const TRACKED_NAMES = {
  England: "ENG", France: "FRA", Ireland: "IRE", Italy: "ITA",
  Scotland: "SCO", Wales: "WAL", Argentina: "ARG", Australia: "AUS",
  Japan: "JPN", "New Zealand": "NZL", "South Africa": "RSA", Fiji: "FIJ",
};

const scoreOf = (s) =>
  s == null ? null : typeof s === "number" ? s : s.current ?? s.display ?? null;

const isFinished = (e) =>
  (e.status?.type ?? e.status?.description ?? "").toString().toLowerCase() === "finished";

// One vendor event -> our entry, from the given team's side. Defensive about
// score/date shapes (score may be a number or {current,display}; date may be
// a unix startTimestamp or an ISO string).
export function normalizeEvent(e, teamCode) {
  const homeCode = TRACKED_NAMES[e.homeTeam?.name] ?? null;
  const home = homeCode === teamCode;
  const opp = home ? e.awayTeam : e.homeTeam;
  const us = scoreOf(home ? e.homeScore : e.awayScore);
  const them = scoreOf(home ? e.awayScore : e.homeScore);
  const date = e.startTimestamp
    ? new Date(e.startTimestamp * 1000).toISOString()
    : e.startDate ?? e.date ?? null;
  const finished = isFinished(e);
  return {
    id: e.id ?? null,
    date,
    league: e.tournament?.name ?? e.season?.name ?? null,
    opponent: opp?.name ?? null,
    opponentCode: TRACKED_NAMES[opp?.name] ?? null,
    tracked: (opp?.name ?? "") in TRACKED_NAMES,
    homeAway: home ? "H" : "A",
    us: finished ? us : null,
    them: finished ? them : null,
    result: !finished || us == null || them == null ? null : us > them ? "W" : us < them ? "L" : "D",
    finished,
  };
}

// Pure core: raw vendor events per team code -> { RSA: { last, next } }.
export function buildTeamEvents(eventsByCode, now = Date.now()) {
  const teams = {};
  for (const [code, { lastEvents = [], nextEvents = [] }] of Object.entries(eventsByCode)) {
    const norm = (arr) =>
      arr.map((e) => normalizeEvent(e, code)).sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = norm(lastEvents).filter((e) => e.finished).slice(-10);
    const next = norm(nextEvents)
      .filter((e) => !e.finished && new Date(e.date).getTime() >= now)
      .slice(0, 5);
    // `finished` is an internal filter aid, not part of the published shape.
    for (const e of [...last, ...next]) delete e.finished;
    teams[code] = { last, next };
  }
  return teams;
}

const BASE = "https://api.sportsapipro.com/v2/rugby";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 6500;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "x-api-key": process.env.SPORTSAPIPRO_KEY } });
  // The events endpoints 404 when a team simply has no games on that page
  // (seen live: /events/next/0 with nothing scheduled) — that's an empty
  // result, not a failure.
  if (res.status === 404) return { events: [] };
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Resolve vendor team ids by name from NC schedule dates (each full round
// weekend names all 12 teams). Reuses ids cached in the previous
// team-events.json when present.
async function resolveTeamIds(prev) {
  const ids = { ...(prev?.teamIds ?? {}) };
  if (Object.keys(ids).length === 12) return ids;
  const { readFile } = await import("node:fs/promises");
  const nations = JSON.parse(await readFile("public/nations.json", "utf8"));
  const dates = [...new Set((nations.results ?? []).map((r) => r.date.slice(0, 10)))];
  for (const date of dates) {
    if (Object.keys(ids).length === 12) break;
    await sleep(PACE);
    const events = (await fetchJson(`${BASE}/api/schedule/${date}`)).events ?? [];
    for (const e of events) {
      for (const t of [e.homeTeam, e.awayTeam]) {
        const code = TRACKED_NAMES[t?.name];
        if (code && t?.id != null) ids[code] = t.id;
      }
    }
  }
  const missing = Object.values(TRACKED_NAMES).filter((c) => !(c in ids));
  if (missing.length) throw new Error(`could not resolve vendor team ids for: ${missing.join(", ")}`);
  return ids;
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  if (!process.env.SPORTSAPIPRO_KEY) throw new Error("SPORTSAPIPRO_KEY not set");
  const prev = await readFile("team-events.json", "utf8").then(JSON.parse).catch(() => null);
  const teamIds = await resolveTeamIds(prev);

  const eventsByCode = {};
  let dumped = false;
  for (const [code, id] of Object.entries(teamIds)) {
    await sleep(PACE);
    const lastEvents = (await fetchJson(`${BASE}/api/teams/${id}/events/last/0`)).events ?? [];
    await sleep(PACE);
    const nextEvents = (await fetchJson(`${BASE}/api/teams/${id}/events/next/0`)).events ?? [];
    if (!dumped && lastEvents[0]) {
      // One raw sample in the run log so a vendor shape drift is diagnosable
      // from the Actions page without re-instrumenting.
      console.log("sample raw event:", JSON.stringify(lastEvents[0]).slice(0, 600));
      dumped = true;
    }
    eventsByCode[code] = { lastEvents, nextEvents };
  }

  const out = {
    updatedAt: new Date().toISOString(),
    source: "sportsapipro",
    teamIds,
    teams: buildTeamEvents(eventsByCode),
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
