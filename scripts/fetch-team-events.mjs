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
//
// `lastEvents`/`nextEvents` of null mean the vendor never answered that half,
// which is NOT the same as an empty array (a team with no upcoming games).
// The unanswered half is marked so mergeRefreshed keeps what's already
// published rather than blanking it.
export function buildTeamEvents(eventsByCode, now = Date.now()) {
  const teams = {};
  for (const [code, { lastEvents = [], nextEvents = [] }] of Object.entries(eventsByCode)) {
    const norm = (arr) =>
      (arr ?? []).map((e) => normalizeEvent(e, code)).sort((a, b) => new Date(a.date) - new Date(b.date));
    const last = norm(lastEvents).filter((e) => e.finished).slice(-10);
    const next = norm(nextEvents)
      .filter((e) => !e.finished && new Date(e.date).getTime() >= now)
      .slice(0, 5);
    // `finished` is an internal filter aid, not part of the published shape.
    for (const e of [...last, ...next]) delete e.finished;
    teams[code] = { last, next };
    if (lastEvents === null) teams[code].lastUnknown = true;
    if (nextEvents === null) teams[code].nextUnknown = true;
  }
  return teams;
}

const BASE = "https://api.sportsapipro.com/v2/rugby";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = 6500;

// SportsAPI Pro throws short 5xx bursts — 503/504 on a single team, gone a
// minute later. Retry those; a 4xx is a real answer and must not be retried.
const RETRY_BACKOFF = [2000, 6000, 15000];
// Retries a whole run may spend, so a sustained outage can't eat the 100/day
// tier that Saturday live polling also draws on. `budget` is a shared mutable
// counter, not a number, because every call in the run spends from one pot.
const RETRY_BUDGET = 12;

let logged = false;
async function fetchJson(url, backoff = RETRY_BACKOFF, budget = { left: Infinity }) {
  const canRetry = () => backoff.length > 0 && budget.left > 0;
  const spend = () => { budget.left -= 1; };
  let res;
  try {
    res = await fetch(url, { headers: { "x-api-key": process.env.SPORTSAPIPRO_KEY } });
  } catch (err) {
    // DNS/socket failures are the same transient class as a 503.
    if (!canRetry()) throw err;
    spend();
    console.log(`${err.message} for ${url} — retrying in ${backoff[0] / 1000}s`);
    await sleep(backoff[0]);
    return fetchJson(url, backoff.slice(1), budget);
  }
  // The events endpoints 404 when a team simply has no games on that page
  // (seen live: /events/next/0 with nothing scheduled) — that's an empty
  // result, not a failure.
  if (res.status === 404) {
    console.log(`404 (empty) for ${url}`);
    return { events: [] };
  }
  if (res.status >= 500 && canRetry()) {
    spend();
    console.log(`HTTP ${res.status} for ${url} — retrying in ${backoff[0] / 1000}s`);
    await sleep(backoff[0]);
    return fetchJson(url, backoff.slice(1), budget);
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`);
    // A rejected key won't come good later in the same run — stop now instead
    // of spending 24 calls proving it.
    if (res.status === 401 || res.status === 403) err.fatal = true;
    throw err;
  }
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
// Each half is kept or lost on its own. `last` carries the results — it's what
// publishes a finished game — and losing it because the SEPARATE `next` call
// 5xx'd is how the 23 Aug 2026 catch-up threw away a good South Africa results
// page and left the Ellis Park loss showing as an upcoming fixture. A half the
// vendor never answered comes back null, not [], so the merge can tell "no
// upcoming games" apart from "didn't get told".
//
// `retryBudget` bounds the whole run: 3 retries per call across 24 calls could
// otherwise burn 96 requests of the 100/day tier shared with Saturday live
// polling. Once spent, failures are immediate.
//
// `paceMs`/`backoff` are overridable so the tests can run the retry and skip
// paths without sitting through 6.5s of real vendor pacing per call.
export async function fetchEventsByCode(
  teamIds,
  { paceMs = PACE, backoff = RETRY_BACKOFF, retryBudget = RETRY_BUDGET } = {},
) {
  const eventsByCode = {};
  const missed = [];
  const budget = { left: retryBudget };
  let dumped = false;

  const half = async (code, id, which) => {
    await sleep(paceMs);
    try {
      const body = await fetchJson(`${BASE}/api/teams/${id}/events/${which}/0`, backoff, budget);
      return body.data?.events ?? body.events ?? [];
    } catch (err) {
      if (err.fatal) throw err;
      missed.push(`${code}/${which}`);
      console.log(`no ${which} for ${code} — ${err.message}`);
      return null;
    }
  };

  for (const [code, id] of Object.entries(teamIds)) {
    const lastEvents = await half(code, id, "last");
    const nextEvents = await half(code, id, "next");
    if (lastEvents === null && nextEvents === null) {
      console.log(`skipping ${code} — vendor answered neither half`);
      continue;
    }
    if (!dumped && lastEvents?.[0]) {
      // One raw sample in the run log so a vendor shape drift is diagnosable
      // from the Actions page without re-instrumenting.
      console.log("sample raw event:", JSON.stringify(lastEvents[0]).slice(0, 600));
      dumped = true;
    }
    eventsByCode[code] = { lastEvents, nextEvents };
  }

  if (missed.length) console.log(`kept what was already published for: ${missed.join(", ")}`);
  if (budget.left <= 0) console.log("retry budget spent — later failures were not retried");
  // Nothing at all coming back is an outage or a dead key, not vendor
  // flakiness — that still has to go red so the health monitor sees it.
  if (Object.keys(teamIds).length && !Object.keys(eventsByCode).length) {
    throw new Error(`vendor answered nothing for any of ${Object.keys(teamIds).length} teams`);
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
    const prevTeam = prevTeams?.[code];
    const prevById = new Map((prevTeam?.last ?? []).map((g) => [String(g.id), g]));
    const merged = {
      ...fresh,
      last: (fresh.last ?? []).map((g) => {
        const prev = prevById.get(String(g.id));
        if (!prev) return g;
        const patched = { ...g };
        for (const k of ["tries", "cards", "venue"]) {
          if (g[k] == null && prev[k] != null) patched[k] = prev[k];
        }
        return patched;
      }),
    };
    // A half the vendor never answered keeps what's on file — blanking it
    // would drop the whole Fixtures list for that team off the Team page.
    if (merged.lastUnknown) merged.last = prevTeam?.last ?? [];
    if (merged.nextUnknown) {
      // A kept `next` goes stale the moment the fresh `last` moves past it.
      // On 23 Aug 2026 the Springboks' Ellis Park game landed in `last` at
      // 16-33 while the kept `next` still carried the same event id unscored,
      // so the Team page charted it and listed it as upcoming at once.
      const played = new Set((merged.last ?? []).map((g) => String(g.id)));
      merged.next = (prevTeam?.next ?? []).filter((g) => !played.has(String(g.id)));
    }
    delete merged.lastUnknown;
    delete merged.nextUnknown;
    out[code] = merged;
  }
  return out;
}

// A tracked-vs-tracked international is ONE game with two sides, so a result
// that reaches only one of them is a vendor gap, not a fact. On 22 Aug 2026
// SportsAPI Pro's `last` endpoint for New Zealand (team 4227) 503'd on every
// attempt for ten hours while the same team's `next` answered fine, so the
// 33-16 win over South Africa charted on the RSA Team page and was missing
// from NZL's. Rebuild the absent side from the side that landed.
//
// Only the scoreline travels. tries/cards are per-team counts belonging to
// whichever side reported them, so a mirrored row carries null and the app
// shrinks that average's window rather than crediting an opponent's tries.
const MIRROR_DAY_MS = 24 * 3600 * 1000;
const sameFixture = (a, b) =>
  (a.id != null && b.id != null && String(a.id) === String(b.id)) ||
  (a.opponentCode != null &&
    a.opponentCode === b.opponentCode &&
    Math.abs(new Date(a.date) - new Date(b.date)) < MIRROR_DAY_MS);

export function mirrorMissingResults(teams) {
  if (!teams) return teams;
  const nameByCode = Object.fromEntries(
    Object.entries(TRACKED_NAMES).map(([name, code]) => [code, name]),
  );
  // Sources are read off a snapshot taken before any writing, so a mirrored
  // row can never become a source and cascade back to where it came from.
  const snapshot = Object.entries(teams).map(([code, t]) => [code, (t?.last ?? []).slice()]);
  const out = {};
  for (const [code, entry] of Object.entries(teams)) {
    if (!entry) { out[code] = entry; continue; }
    const own = entry.last ?? [];
    const added = [];
    for (const [srcCode, srcLast] of snapshot) {
      if (srcCode === code || !nameByCode[srcCode]) continue;
      for (const g of srcLast) {
        if (g.opponentCode !== code || g.us == null || g.them == null) continue;
        const flipped = {
          id: g.id,
          date: g.date,
          league: g.league,
          opponent: nameByCode[srcCode],
          opponentCode: srcCode,
          tracked: true,
          homeAway: g.homeAway === "H" ? "A" : "H",
          us: g.them,
          them: g.us,
          result: g.them > g.us ? "W" : g.them < g.us ? "L" : "D",
          tries: null,
          cards: null,
          mirroredFrom: srcCode,
        };
        if (g.venue != null) flipped.venue = g.venue;
        if ([...own, ...added].some((h) => sameFixture(h, flipped))) continue;
        added.push(flipped);
      }
    }
    if (!added.length) { out[code] = entry; continue; }
    const last = [...own, ...added]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-10);
    // The game is played; it must not also sit in the upcoming list.
    const next = (entry.next ?? []).filter((f) => !added.some((h) => sameFixture(f, h)));
    out[code] = { ...entry, last, next };
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
    // Then rebuild any tracked-vs-tracked result that reached only one side.
    teams: mirrorMissingResults(mergeRefreshed(prev?.teams, fresh)),
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
