// A Nations Championship game api-sports has not listed, kept from ESPN.
//
// nations.json is the Nations Championship's record and api-sports writes
// it. The pool stage could wait for api-sports, because SCHEDULE
// (static-fixtures.mjs) carried every pool game as a row until the vendor's
// own arrived. Finals weekend has no such rows: its pairings are only known
// once the pool stage ends, and api-sports' free plan shows a date only from
// the day before (the 11:00 Sydney time sweep of Wed 25 Nov 2026 was refused
// Fri 27 Nov: "Free plans do not have access to this date"). So until the
// eve of each final nobody can tell whether api-sports will list it, and if
// it never does, the app has no score: its Results tab and the live card
// take a Nations Championship game from nations.json and nowhere else
// (app repo src/fixtures-list.js `ownsResult`).
//
// This module closes that gap with what the repo already has:
//
//   standInGames   every real `rnc-*` row in fixtures.json (ESPN's listing)
//                  that no api-sports game and no SCHEDULE row covers becomes
//                  a game in api-sports' own shape, "Not Started". It rides
//                  through slimGames like any other, so nations.json lists
//                  it, and the live overlay (espn-live-overlay.mjs) lifts its
//                  score and phase from ESPN in play, as it does for a row
//                  api-sports is slow on.
//   recordFinals   when the overlay has called such a row full time, its
//                  score is kept in scripts/espn-finals.json. fixtures.json
//                  drops a played Nations Championship row a day after
//                  kickoff and ESPN's scoreboard is read only near the game,
//                  so without the file the result would revert to "Not
//                  Started" at the next rebuild and then vanish.
//
// The moment api-sports lists the game (same two sides, within a day), its
// record replaces the stand-in, kept score and all: api-sports stays the
// record wherever it has one. A stand-in is a finals-weekend game by
// construction, so its week is "Finals" and the pool table never counts it
// (poolStageGames in fetch-nations.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { API_SPORTS_TEAMS, API_SPORTS_CODE_BY_ID, staticFixtures } from "./static-fixtures.mjs";

export const FINALS_STORE = "scripts/espn-finals.json";
export const STAND_IN_WEEK = "Finals";
const SAME_GAME_MS = 24 * 3600 * 1000;
const STATIC_GAME_MS = 36 * 3600 * 1000; // SCHEDULE rows may sit on a placeholder time

export const isStandIn = (row) => String(row?.id ?? "").startsWith("espn-");

const pairOf = (h, a) => [String(h), String(a)].sort().join("-");
const side = (code) => ({
  id: API_SPORTS_TEAMS[code].id,
  name: API_SPORTS_TEAMS[code].name,
  logo: `https://media.api-sports.io/rugby/teams/${API_SPORTS_TEAMS[code].id}.png`,
});

// Pure. `cachedGames` are raw api-sports games; `published` is fixtures.json
// (the file object or its array); `store` is espn-finals.json's content.
// Returns the stand-ins, in api-sports' raw shape, oldest first.
export function standInGames(cachedGames, published, store = {}, { staticRows = staticFixtures() } = {}) {
  const covered = (pair, t, rows, windowMs, ids) =>
    rows.some((g) => pairOf(...ids(g)) === pair && Math.abs(Date.parse(g.date) - t) <= windowMs);
  const list = Array.isArray(published) ? published : published?.fixtures;

  // What ESPN lists now, then what was kept from a game it no longer lists.
  const wanted = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!String(f?.comp?.key ?? "").startsWith("rnc-")) continue;
    if (!isStandIn(f) || f.final?.projected) continue;
    wanted.set(f.id, { id: f.id, date: f.date, home: f.home?.code, away: f.away?.code });
  }
  for (const [id, kept] of Object.entries(store ?? {})) {
    wanted.set(id, { ...kept, ...wanted.get(id), id, final: kept });
  }

  const out = [];
  for (const w of wanted.values()) {
    const t = Date.parse(w.date);
    if (!Number.isFinite(t) || !API_SPORTS_TEAMS[w.home] || !API_SPORTS_TEAMS[w.away]) continue;
    const pair = pairOf(API_SPORTS_TEAMS[w.home].id, API_SPORTS_TEAMS[w.away].id);
    if (covered(pair, t, cachedGames ?? [], SAME_GAME_MS, (g) => [g.teams?.home?.id, g.teams?.away?.id])) continue;
    if (covered(pair, t, staticRows ?? [], STATIC_GAME_MS, (g) => [g.home?.id, g.away?.id])) continue;
    // A kept final was recorded with its own home and away; ESPN's listing
    // has not been seen to flip them, and the kept sides win if it does.
    const f = w.final;
    const [home, away] = f ? [f.home, f.away] : [w.home, w.away];
    out.push({
      id: w.id,
      date: new Date(t).toISOString(),
      week: STAND_IN_WEEK,
      status: f
        ? { short: "FT", long: "Finished", via: "espn" }
        : { short: "NS", long: "Not Started" },
      teams: { home: side(home), away: side(away) },
      scores: { home: f ? f.homeScore : null, away: f ? f.awayScore : null },
    });
  }
  return out.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Pure. Is a stand-in past its kickoff, inside the day ESPN's scoreboard is
// read for, and still without a final? Outside a live burst nothing asks
// ESPN, so the sweep uses this to ask once (refresh.mjs): a final ESPN
// posted after the burst closed is then kept at the next sweep, not lost.
export function standInAwaitingFinal(doc, nowMs = Date.now()) {
  return [...(doc?.fixtures ?? []), ...(doc?.results ?? [])].some((r) => {
    if (!isStandIn(r) || (r.status?.short === "FT" && !r.status?.live)) return false;
    const t = Date.parse(r.date);
    return t <= nowMs && nowMs - t <= SAME_GAME_MS;
  });
}

// Pure. A nations.json document -> the store with every stand-in the overlay
// has called full time. Returns the same object when nothing moved, so the
// caller writes (and the job commits) only on a new or corrected final.
export function recordFinals(doc, store = {}) {
  let next = store;
  for (const r of doc?.results ?? []) {
    if (!isStandIn(r) || r.status?.short !== "FT" || r.status?.live) continue;
    if (r.home?.score == null || r.away?.score == null) continue;
    const home = API_SPORTS_CODE_BY_ID[r.home.id];
    const away = API_SPORTS_CODE_BY_ID[r.away.id];
    if (!home || !away) continue;
    const kept = { date: r.date, home, away, homeScore: r.home.score, awayScore: r.away.score };
    if (JSON.stringify(next[r.id]) === JSON.stringify(kept)) continue;
    next = { ...next, [r.id]: kept };
  }
  return next;
}

// The committed store, or {} when it is missing or unreadable: a bad file
// costs the kept finals until it is mended, never the refresh.
export function loadFinalsStore(path = FINALS_STORE, { warn = console.warn } = {}) {
  try {
    const store = JSON.parse(readFileSync(path, "utf8"));
    return store && typeof store === "object" && !Array.isArray(store) ? store : {};
  } catch (e) {
    if (e.code !== "ENOENT") warn(`[espn-finals] ${path} unreadable (${e.message}): no kept finals this pass`);
    return {};
  }
}

// Keep the finals in `doc`. Returns how many entries were added or changed.
export function saveFinals(doc, { path = FINALS_STORE, log = console.log, load = loadFinalsStore, write = writeFileSync } = {}) {
  const store = load(path);
  const next = recordFinals(doc, store);
  if (next === store) return 0;
  const moved = Object.keys(next).filter((id) => next[id] !== store[id]);
  const sorted = Object.fromEntries(Object.entries(next).sort(([, a], [, b]) => a.date.localeCompare(b.date)));
  write(path, `${JSON.stringify(sorted, null, 2)}\n`);
  for (const id of moved) {
    const k = next[id];
    log(`[espn-finals] kept ${id}: ${k.home} ${k.homeScore}-${k.awayScore} ${k.away} (ESPN's final; api-sports has not listed this game)`);
  }
  return moved.length;
}
