// fixtures.json — the app's general upcoming-internationals list (Fixtures
// tab rewrite, spec 2026-07-19). One entry per MATCH (not per team): every
// announced fixture involving at least one of the 12 tracked nations, across
// all competitions, no time cutoff. Built from the same keyless ESPN core-API
// events that supplement team-events.json (fetchEspnEvents), so it costs no
// SportsAPI quota.
//
// Shape (spec §3): { id, date, timeTBC, home, away, comp, round?, series?,
// venue } sorted ascending by kickoff. `comp.kind` is competition | series |
// test; a "series" is 2+ non-competition games between the same pair
// ("SA v NZ · Game 1/4"). NC rounds come from nations.json (ESPN carries no
// round numbers). Live/today status is merged client-side from the live feed.

import { readFile, writeFile } from "node:fs/promises";
import { fetchEspnEvents, ESPN_TEAM_IDS } from "./fetch-espn-fixtures.mjs";
import { fetchLeagueFixtures, loadRegistry } from "./fetch-league-fixtures.mjs";
import { seededFixtures } from "./seed-competitions.mjs";
import { tourFixtures, loadProbeResults } from "./seed-tour.mjs";

const ID_TO_CODE = Object.fromEntries(Object.entries(ESPN_TEAM_IDS).map(([c, id]) => [String(id), c]));

const CODE_NAMES = {
  ENG: "England", SCO: "Scotland", IRE: "Ireland", WAL: "Wales",
  RSA: "South Africa", AUS: "Australia", NZL: "New Zealand", FRA: "France",
  ARG: "Argentina", FIJ: "Fiji", ITA: "Italy", JPN: "Japan",
};

// Codes for common untracked opponents; anything else falls back to the
// first three letters of the name (flags for these don't exist in the app —
// it renders the code as text).
const UNTRACKED_CODES = {
  Georgia: "GEO", Portugal: "POR", Uruguay: "URU", Spain: "ESP", Chile: "CHI",
  Samoa: "SAM", Tonga: "TGA", Romania: "ROU", Namibia: "NAM", Canada: "CAN",
  "United States": "USA", USA: "USA", Barbarians: "BAR", "Hong Kong": "HKG",
  // ESPN's league-wide feed spells it out; the 3-letter fallback would make
  // this "UNI".
  "United States of America": "USA", Zimbabwe: "ZIM",
};

// Short forms for series labels ("SA v NZ", not "RSA v NZL").
const SERIES_SHORT = {
  RSA: "SA", NZL: "NZ", AUS: "AUS", ARG: "ARG", ENG: "ENG", FRA: "FRA",
  IRE: "IRE", ITA: "ITA", SCO: "SCO", WAL: "WAL", FIJ: "FIJ", JPN: "JPN",
};

const teamIdFromRef = (ref) => (String(ref ?? "").match(/\/teams\/(\d+)/) ?? [])[1] ?? null;

// Two ESPN shapes feed this file. The per-team core API nests the team behind
// a `$ref` URL; the league-wide site-API scoreboard carries `team.id` inline.
// Both are the same id space, so one accessor reads either.
const competitorId = (c) => (c?.team?.id != null ? String(c.team.id) : teamIdFromRef(c?.team?.$ref));

function side(espnId, names) {
  const code = ID_TO_CODE[espnId];
  if (code) return { code, name: CODE_NAMES[code], tracked: true };
  const name = names.get(espnId) ?? "Unknown";
  return { code: UNTRACKED_CODES[name] ?? name.slice(0, 3).toUpperCase(), name, tracked: false };
}

// League name + fixture year -> comp tag. Test matches get a placeholder the
// series pass may upgrade.
export function compFor(leagueName, year) {
  const yy = String(year).slice(2);
  switch (leagueName) {
    case "Nations Championship":
      return { key: `rnc-${year}`, label: `RNC '${yy}`, kind: "competition" };
    case "The Rugby Championship":
      return { key: `trc-${year}`, label: `TRC '${yy}`, kind: "competition" };
    case "Six Nations":
      return { key: `6n-${year}`, label: `6N '${yy}`, kind: "competition" };
    case "Rugby World Cup":
      // Was missing, so RWC events fell through to `kind: "test"` and the
      // series pass would have paired pool matches into a fictional "series".
      return { key: `rwc-${year}`, label: `RWC '${yy}`, kind: "competition" };
    default:
      return { key: "test", label: "TEST", kind: "test" };
  }
}

// NC round lookup: nations.json fixtures/results matched by both team names
// + kickoff within 36h (static NC fixtures carry placeholder noon times).
export function roundLookup(nations) {
  const all = [...(nations?.fixtures ?? []), ...(nations?.results ?? [])];
  return (homeName, awayName, dateIso) => {
    const t = new Date(dateIso).getTime();
    const hit = all.find(
      (m) =>
        m.home?.name === homeName &&
        m.away?.name === awayName &&
        Math.abs(new Date(m.date).getTime() - t) <= 36 * 3600 * 1000,
    );
    return hit?.week != null ? String(hit.week) : null;
  };
}

// Pure core: raw ESPN events -> the published fixtures array.
//
// `now` (default 0 = keep everything, so tests stay time-independent) drops
// already-played games EXCEPT kind:"series" and kind:"test" ones: the app's
// series scoreboard is derived from fixtures.json series entries + scores,
// and the app's Results tab lists played tour/series/test games (2026-08-09
// — ARG v RSA was invisible everywhere because played one-offs dropped).
// Both kinds persist with their final via `scores` ({ "espn-<id>":
// {home, away} }, see fetchSeriesScores). A played test that still has no
// score is kept too — the next build's fill pass needs to see it; the 24h
// `now` grace bounds how long a scoreless one can linger if a vendor never
// scores it, because upstream stops carrying it. Played competition games
// still drop (the registered-league fetch is future-only upstream anyway).
export function buildFixtures(events, names, nations, { now = 0, scores = {} } = {}) {
  const findRound = roundLookup(nations);
  const out = [];
  for (const { event, leagueName, comp: registryComp, registered } of events) {
    const comp0 = event.competitions?.[0];
    if (!comp0) continue;
    const sides = {};
    for (const c of comp0.competitors ?? []) sides[c.homeAway] = competitorId(c);
    if (!sides.home || !sides.away) continue;
    const home = side(sides.home, names);
    const away = side(sides.away, names);
    // The ≥1-tracked-nation filter keeps unregistered noise out, but a match
    // in a REGISTERED competition belongs in the list whoever is playing —
    // this is exactly what would have excluded RWC's Chile v Hong Kong.
    if (!registered && !home.tracked && !away.tracked) continue;
    const date = new Date(event.date).toISOString();
    // Registered comps carry their tag from competitions.json so the key the
    // app filters by cannot drift from the registry.
    const comp = registryComp ?? compFor(leagueName, new Date(date).getUTCFullYear());
    const v = comp0.venue;
    const venue = v?.fullName
      ? v.address?.city && v.address.city !== v.fullName
        ? `${v.fullName}, ${v.address.city}`
        : v.fullName
      : null;
    const entry = {
      id: `espn-${event.id}`,
      date,
      timeTBC: comp0.timeValid === false,
      home,
      away,
      comp,
      venue,
    };
    if (comp.kind === "competition" && leagueName === "Nations Championship") {
      const round = findRound(home.name, away.name, date);
      if (round) entry.round = round;
    }
    out.push(entry);
  }

  // Series pass: 2+ test games between the same pair become a named series
  // ("SA v NZ · Game 1/4"); the pair label follows the first game's home side.
  const tests = out.filter((e) => e.comp.kind === "test");
  const byPair = new Map();
  for (const e of tests) {
    const key = [e.home.code, e.away.code].sort().join("-");
    (byPair.get(key) ?? byPair.set(key, []).get(key)).push(e);
  }
  for (const games of byPair.values()) {
    if (games.length < 2) continue;
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    const first = games[0];
    const label = `${SERIES_SHORT[first.home.code] ?? first.home.code} v ${SERIES_SHORT[first.away.code] ?? first.away.code}`;
    const year = new Date(first.date).getUTCFullYear();
    const key = `series-${first.home.code.toLowerCase()}-${first.away.code.toLowerCase()}-${year}`;
    games.forEach((e, i) => {
      e.comp = { key, label, kind: "series" };
      e.series = { label, game: i + 1, of: games.length };
    });
  }

  // Past-game policy (see the function comment): series and one-off test
  // games persist and pick up their score; everything else played drops.
  const kept = out.filter((e) => {
    const played = new Date(e.date).getTime() < now;
    if (played && e.comp.kind !== "series" && e.comp.kind !== "test") return false;
    const s = scores[e.id];
    if (s) {
      e.homeScore = s.home;
      e.awayScore = s.away;
    }
    return true;
  });

  return kept.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id < b.id ? -1 : 1));
}

// Finals for already-played series games, from ESPN's keyless core API: each
// competitor's `score` is a $ref on the raw event, so this costs 2 small
// fetches per PLAYED series game (max 8 for a 4-test series — cheap, and
// only after each test is actually played). Returns the buildFixtures
// `scores` map keyed by our fixture id, oriented home/away as ESPN lists
// them (the same orientation buildFixtures publishes).
export async function fetchSeriesScores(playedSeriesEvents, fetchJson = defaultGetJson) {
  const scores = {};
  for (const { event } of playedSeriesEvents) {
    const bySide = {};
    for (const c of event.competitions?.[0]?.competitors ?? []) {
      if (!c.score?.$ref) continue;
      const s = await fetchJson(c.score.$ref).catch(() => null);
      if (s?.value != null) bySide[c.homeAway] = s.value;
    }
    if (bySide.home != null && bySide.away != null) {
      scores[`espn-${event.id}`] = { home: bySide.home, away: bySide.away };
    }
  }
  return scores;
}

async function defaultGetJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Per-team events + league-wide events -> one list, deduped by ESPN event id.
// The league-wide entry wins: it carries the registry's comp tag, and a match
// in a registered competition should be filed under that competition even
// though the per-team walk also found it.
export function mergeSources(teamEvents, leagueEvents) {
  const byId = new Map();
  for (const e of teamEvents) byId.set(String(e.event?.id ?? Math.random()), e);
  for (const e of leagueEvents) byId.set(String(e.event?.id ?? Math.random()), e);
  return [...byId.values()];
}

async function main() {
  // 24h grace so today's already-kicked-off matches survive the daily build —
  // the app owns the device-local "until the day ends" cutoff.
  const now = Date.now() - 24 * 3600 * 1000;
  // keepPast: played events must reach buildFixtures so series games persist.
  const { events, names } = await fetchEspnEvents(now, { keepPast: true });
  // League-wide pass over every registered competition. Runs alongside the
  // per-team walk rather than replacing it: the per-team feed still supplies
  // one-off tests and series, which belong to no competition.
  const registry = await loadRegistry().catch(() => null);
  const league = registry
    ? await fetchLeagueFixtures(registry, undefined, now)
    : { events: [], names: new Map() };
  for (const [id, name] of league.names) if (!names.has(id)) names.set(id, name);
  const nations = JSON.parse(await readFile("public/nations.json", "utf8"));
  const merged = mergeSources(events, league.events);
  let fixtures = buildFixtures(merged, names, nations, { now });

  // Two-pass score fill for played series/test games: the first pass tells
  // us which persisted entries lack a final; their scores come from the raw
  // events' competitor score $refs, then the (cheap, pure) build reruns with
  // the map. No played games -> no extra fetches at all.
  //
  // "Played" here is the REAL clock + settle, not the grace-shifted `now`:
  // the grace exists so today's games stay listed, but judging playedness by
  // it meant a Saturday final sat scoreless until Sunday's build (JPN v AUS,
  // 2026-08-09). 150 min = kickoff + play + settle, same as the tour probe.
  const SETTLED_MS = 150 * 60000;
  const playedCutoff = Date.now() - SETTLED_MS;
  const scoreable = fixtures.filter(
    (f) =>
      (f.comp.kind === "series" || f.comp.kind === "test") &&
      new Date(f.date).getTime() < playedCutoff &&
      f.homeScore == null,
  );
  if (scoreable.length) {
    const byId = new Map(merged.map((e) => [`espn-${e.event?.id}`, e]));
    const raw = scoreable.map((f) => byId.get(f.id)).filter(Boolean);
    const scores = await fetchSeriesScores(raw);
    console.log(`filled finals for ${Object.keys(scores).length}/${scoreable.length} played series/test games`);
    fixtures = buildFixtures(merged, names, nations, { now, scores });
  }

  // Seeded fixtures for competitions the vendor still has nothing for. They
  // are already in published shape, so they are appended rather than rebuilt,
  // and they drop out automatically the moment ESPN carries that competition.
  const seeded = registry ? seededFixtures(registry).filter((f) => new Date(f.date).getTime() >= now) : [];
  if (seeded.length) console.log(`seeded ${seeded.length} fixtures for competitions ESPN has not published`);
  fixtures.push(...seeded);
  // The NZ tour midweek games (kind:"tour") — no vendor carries them, so no
  // future-only filter: a played tour game persists with its score (from
  // HAND_RESULTS or the match-day probe), because the seed IS the record.
  // Appended after buildFixtures, so the series pass never sees them.
  const tour = tourFixtures(await loadProbeResults());
  console.log(`seeded ${tour.length} NZ-tour fixtures (${tour.filter((f) => f.homeScore != null).length} with results)`);
  fixtures.push(...tour);
  fixtures.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id < b.id ? -1 : 1));
  const out = { updatedAt: new Date().toISOString(), source: "espn", fixtures };
  await writeFile("fixtures.json", JSON.stringify(out, null, 1) + "\n");
  const kinds = fixtures.reduce((m, f) => ((m[f.comp.label] = (m[f.comp.label] ?? 0) + 1), m), {});
  console.log(`fixtures.json written — ${fixtures.length} fixtures:`, JSON.stringify(kinds));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
