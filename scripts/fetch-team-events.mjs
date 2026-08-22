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

// Exact-name guard for team resolution. Lookalike sides — "South Africa A",
// "New Zealand XV", "Emerging Ireland", age-grade and women's teams — play on
// tours and MUST never resolve to the real nation: one fuzzy hit would leak a
// franchise-strength game into a nation's form record. The TRACKED_NAMES
// lookup is already exact (own-property, no trimming, no substring), and the
// lookalike patterns are belt-and-braces: even if someone later "improves"
// matching with normalisation, these names still return null. All resolution
// in this file goes through here — never index TRACKED_NAMES directly.
const LOOKALIKE = [
  /\s+(?:a|b|xv|development|invitational|legends|classic|president'?s\s+xv)$/i, // "South Africa A", "New Zealand XV"
  /^(?:emerging|junior|young)\s+/i, // "Emerging Ireland", "Junior Japan"
  /\b(?:u-?\d+|under[\s-]?\d+|women)\b/i, // "France U20", "Australia Women"
];
export function trackedCodeFor(name) {
  if (typeof name !== "string") return null;
  if (LOOKALIKE.some((re) => re.test(name))) return null;
  return Object.prototype.hasOwnProperty.call(TRACKED_NAMES, name) ? TRACKED_NAMES[name] : null;
}

const scoreOf = (s) =>
  s == null ? null : typeof s === "number" ? s : s.current ?? s.display ?? null;

const isFinished = (e) =>
  (e.status?.type ?? e.status?.description ?? "").toString().toLowerCase() === "finished";

// One vendor event -> our entry, from the given team's side. Defensive about
// score/date shapes (score may be a number or {current,display}; date may be
// a unix startTimestamp or an ISO string).
export function normalizeEvent(e, teamCode) {
  const homeCode = trackedCodeFor(e.homeTeam?.name);
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
    opponentCode: trackedCodeFor(opp?.name),
    tracked: trackedCodeFor(opp?.name) != null,
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

// SportsAPI Pro throws short 5xx bursts — 503/504 on a single team, gone a
// minute later. Retry those; a 4xx is a real answer and must not be retried.
const RETRY_BACKOFF = [2000, 6000, 15000];

let logged = false;
async function fetchJson(url, backoff = RETRY_BACKOFF) {
  let res;
  try {
    res = await fetch(url, { headers: { "x-api-key": process.env.SPORTSAPIPRO_KEY } });
  } catch (err) {
    // DNS/socket failures are the same transient class as a 503.
    if (!backoff.length) throw err;
    console.log(`${err.message} for ${url} — retrying in ${backoff[0] / 1000}s`);
    await sleep(backoff[0]);
    return fetchJson(url, backoff.slice(1));
  }
  // The events endpoints 404 when a team simply has no games on that page
  // (seen live: /events/next/0 with nothing scheduled) — that's an empty
  // result, not a failure.
  if (res.status === 404) {
    console.log(`404 (empty) for ${url}`);
    return { events: [] };
  }
  if (res.status >= 500 && backoff.length) {
    console.log(`HTTP ${res.status} for ${url} — retrying in ${backoff[0] / 1000}s`);
    await sleep(backoff[0]);
    return fetchJson(url, backoff.slice(1));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const body = await res.json();
  if (!logged && url.includes("/events/")) {
    // Focused sample per run so vendor shape drift is diagnosable from the
    // Actions log (the full event is mostly translation noise).
    const evs = body.data?.events ?? body.events ?? [];
    const pick = (e) => e && {
      id: e.id, startTimestamp: e.startTimestamp, status: e.status,
      home: e.homeTeam?.name, away: e.awayTeam?.name,
      homeScore: e.homeScore, awayScore: e.awayScore,
    };
    console.log(`first events response ${url}: ${evs.length} events;`, JSON.stringify([pick(evs[0]), pick(evs[1])]).slice(0, 800));
    logged = true;
  }
  return body;
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
    const schedBody = await fetchJson(`${BASE}/api/schedule/${date}`);
    const events = schedBody.data?.events ?? schedBody.events ?? [];
    for (const e of events) {
      for (const t of [e.homeTeam, e.awayTeam]) {
        const code = trackedCodeFor(t?.name);
        if (code && t?.id != null) ids[code] = t.id;
      }
    }
  }
  const missing = Object.values(TRACKED_NAMES).filter((c) => !(c in ids));
  if (missing.length) throw new Error(`could not resolve vendor team ids for: ${missing.join(", ")}`);
  return ids;
}

// Paced vendor fetch for a code -> vendor-team-id map (2 calls per team).
// Exported so the post-match catch-up job (refresh-played-teams.mjs) can pull
// the same feed for a SUBSET of teams instead of all twelve.
//
// A team that still fails after the retries is SKIPPED, not fatal: it drops
// out of the returned map and the caller keeps its previous entry. One team's
// vendor 5xx used to abort the whole twelve-team walk, which is how the feed
// froze for three days over 21-23 Aug 2026 while the Springboks' Ellis Park
// result sat unpublished.
// `paceMs`/`backoff` are overridable so the tests can run the retry and skip
// paths without sitting through 6.5s of real vendor pacing per call.
export async function fetchEventsByCode(teamIds, { paceMs = PACE, backoff = RETRY_BACKOFF } = {}) {
  const eventsByCode = {};
  const skipped = [];
  let dumped = false;
  for (const [code, id] of Object.entries(teamIds)) {
    try {
      await sleep(paceMs);
      const lastBody = await fetchJson(`${BASE}/api/teams/${id}/events/last/0`, backoff);
      const lastEvents = lastBody.data?.events ?? lastBody.events ?? [];
      await sleep(paceMs);
      const nextBody = await fetchJson(`${BASE}/api/teams/${id}/events/next/0`, backoff);
      const nextEvents = nextBody.data?.events ?? nextBody.events ?? [];
      if (!dumped && lastEvents[0]) {
        // One raw sample in the run log so a vendor shape drift is diagnosable
        // from the Actions page without re-instrumenting.
        console.log("sample raw event:", JSON.stringify(lastEvents[0]).slice(0, 600));
        dumped = true;
      }
      eventsByCode[code] = { lastEvents, nextEvents };
    } catch (err) {
      skipped.push(code);
      console.log(`skipping ${code} — ${err.message}`);
    }
  }
  if (skipped.length) console.log(`kept previous entries for: ${skipped.join(", ")}`);
  // Every team failing is an outage or a dead key, not vendor flakiness —
  // that still has to go red so the health monitor sees it.
  if (Object.keys(teamIds).length && !Object.keys(eventsByCode).length) {
    throw new Error(`vendor returned nothing for all ${skipped.length} teams`);
  }
  return eventsByCode;
}

// Fresh team entries laid over the previous ones: a code absent from `fresh`
// keeps what it had. Used by the full run for teams the vendor skipped, and by
// the catch-up job, which only ever rebuilds the handful of teams that played.
// Per-game `tries`/`cards`/`venue` come from supplements the partial rebuild
// may not have re-fetched, so a null in the fresh copy defers to the old one.
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

// Raw vendor events -> published team entries: ESPN fixtures merged into
// `next`, per-game tries/cards enriched onto `last`. Both supplements are
// keyless (no SportsAPI Pro quota), so the catch-up job runs this too and its
// partial rebuild is shaped exactly like the full one.
export async function assembleTeams(eventsByCode, statsJson) {
  // SportsAPI Pro's next feed misses whole competitions (RSA's 2026 Aug–Sep
  // tests were absent) — supplement upcoming fixtures from keyless ESPN.
  const { fetchEspnFixtures, mergeNext } = await import("./fetch-espn-fixtures.mjs");
  const teams = buildTeamEvents(eventsByCode);
  const espn = await fetchEspnFixtures();
  for (const [code, t] of Object.entries(teams)) {
    t.next = mergeNext(t.next, espn[code] ?? []);
  }

  // Per-game tries/cards for the last-10 window: NC games from our own
  // stats.json, TRC/6N from ESPN; games with no source keep null (the app
  // drops them from those averages).
  const { ncStatsByEventId, fetchEspnFormStats, enrichLast } = await import("./fetch-form-stats.mjs");
  const neededDaysByCode = Object.fromEntries(
    Object.entries(teams).map(([code, t]) => [
      code,
      new Set((t.last ?? []).map((g) => String(g.date).slice(0, 10))),
    ]),
  );
  enrichLast(teams, ncStatsByEventId(statsJson), await fetchEspnFormStats(neededDaysByCode));
  return teams;
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  if (!process.env.SPORTSAPIPRO_KEY) throw new Error("SPORTSAPIPRO_KEY not set");
  const prev = await readFile("team-events.json", "utf8").then(JSON.parse).catch(() => null);
  const teamIds = await resolveTeamIds(prev);

  const eventsByCode = await fetchEventsByCode(teamIds);
  const statsJson = await readFile("stats.json", "utf8").then(JSON.parse).catch(() => null);
  const fresh = await assembleTeams(eventsByCode, statsJson);

  const out = {
    updatedAt: new Date().toISOString(),
    source: "sportsapipro+espn",
    teamIds,
    // Layer over the previous file so a team the vendor skipped keeps its
    // entry instead of disappearing from the Team page.
    teams: mergeRefreshed(prev?.teams, fresh),
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
