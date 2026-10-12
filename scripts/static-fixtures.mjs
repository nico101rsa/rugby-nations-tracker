// The announced 2026 Nations Championship schedule (rounds 2-6), used to fill
// the Fixtures tab because the api-sports data plan only exposes a 3-day
// window. Once a match enters that window the real API record (same week +
// home team) replaces the static one, so live status/scores still work.
//
// SCHEDULE is also what refresh.mjs decideMode() reads to decide when to
// burst-poll api-sports for live scores, and it SKIPS any row whose kickoff is
// not confirmed. Rounds 4-6 sat here as noon placeholders (timeConfirmed:
// false) until 2026-10-12, so no November match would ever have opened a
// live window: nations.json would have moved only on the 6-hourly sweeps.
//
// Sources: Wikipedia "2026 Nations Championship" + RugbyPass fixtures page
// (July kickoffs, confirmed 5 Jul 2026). Rounds 4-6: ESPN's league 17567
// scoreboard as published in fixtures.json (comp rnc-2026, ids
// espn-603993..604010, timeTBC false), read 12 Oct 2026 and cross-checked
// against RugbyPass/Where's The Match for IRE v ARG (20:10 GMT) and ENG v AUS
// (15:10 GMT). November is GMT, so the UTC times below are the UK times.
//
// Finals weekend (27-29 Nov, Twickenham) is deliberately NOT here: the
// pairings depend on the final conference ranks. scheduleKickoffs() picks its
// kickoffs up from fixtures.json instead, as soon as ESPN publishes them with
// a confirmed time (see publishedKickoffs below), so no hand edit is needed.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures.json");

const T = {
  ENG: { id: 386, name: "England" },
  FRA: { id: 387, name: "France" },
  IRE: { id: 388, name: "Ireland" },
  ITA: { id: 389, name: "Italy" },
  SCO: { id: 390, name: "Scotland" },
  WAL: { id: 391, name: "Wales" },
  ARG: { id: 460, name: "Argentina" },
  AUS: { id: 461, name: "Australia" },
  JPN: { id: 463, name: "Japan" },
  NZL: { id: 465, name: "New Zealand" },
  RSA: { id: 467, name: "South Africa" },
  FIJ: { id: 28, name: "Fiji" },
};

// api-sports team ids by our three-letter code ({ id, name }), for anything
// that has to map nations.json rows (keyed by api-sports id) onto codes; and
// the reverse, id -> code, which kickoff-overrides.mjs keys its rows through.
export const API_SPORTS_TEAMS = T;
export const API_SPORTS_CODE_BY_ID = Object.fromEntries(Object.entries(T).map(([code, { id }]) => [id, code]));

// [week, home, away, dateISO, timeConfirmed]
const SCHEDULE = [
  // Round 2 — 11 July (kickoffs confirmed)
  ["2", "NZL", "ITA", "2026-07-11T05:10:00+00:00", true],
  ["2", "AUS", "FRA", "2026-07-11T07:40:00+00:00", true],
  ["2", "JPN", "IRE", "2026-07-11T10:10:00+00:00", true],
  ["2", "FIJ", "ENG", "2026-07-11T13:10:00+00:00", true],
  ["2", "RSA", "SCO", "2026-07-11T15:40:00+00:00", true],
  ["2", "ARG", "WAL", "2026-07-11T19:10:00+00:00", true],
  // Round 3 — 18 July (kickoffs confirmed)
  ["3", "NZL", "IRE", "2026-07-18T07:10:00+00:00", true],
  ["3", "JPN", "FRA", "2026-07-18T08:40:00+00:00", true],
  ["3", "AUS", "ITA", "2026-07-18T10:10:00+00:00", true],
  ["3", "FIJ", "SCO", "2026-07-18T13:10:00+00:00", true],
  ["3", "RSA", "WAL", "2026-07-18T15:40:00+00:00", true],
  ["3", "ARG", "ENG", "2026-07-18T19:10:00+00:00", true],
  // Round 4 — 6-8 November (ESPN-confirmed, fixtures.json espn-603993..603998)
  ["4", "IRE", "ARG", "2026-11-06T20:10:00+00:00", true],
  ["4", "ITA", "RSA", "2026-11-07T11:40:00+00:00", true],
  ["4", "SCO", "NZL", "2026-11-07T14:10:00+00:00", true],
  ["4", "WAL", "JPN", "2026-11-07T16:40:00+00:00", true],
  ["4", "FRA", "FIJ", "2026-11-07T20:10:00+00:00", true],
  ["4", "ENG", "AUS", "2026-11-08T15:10:00+00:00", true],
  // Round 5 — 13-15 November (ESPN-confirmed, espn-603999..604004)
  ["5", "FRA", "RSA", "2026-11-13T20:10:00+00:00", true],
  ["5", "ITA", "ARG", "2026-11-14T11:40:00+00:00", true],
  ["5", "WAL", "NZL", "2026-11-14T14:10:00+00:00", true],
  ["5", "ENG", "JPN", "2026-11-14T16:40:00+00:00", true],
  ["5", "IRE", "FIJ", "2026-11-14T20:10:00+00:00", true],
  ["5", "SCO", "AUS", "2026-11-15T15:10:00+00:00", true],
  // Round 6 — 21 November (ESPN-confirmed, espn-604005..604010)
  ["6", "ENG", "NZL", "2026-11-21T14:10:00+00:00", true],
  ["6", "SCO", "JPN", "2026-11-21T14:10:00+00:00", true],
  ["6", "IRE", "RSA", "2026-11-21T16:40:00+00:00", true],
  ["6", "ITA", "FIJ", "2026-11-21T16:40:00+00:00", true],
  ["6", "FRA", "ARG", "2026-11-21T20:10:00+00:00", true],
  ["6", "WAL", "AUS", "2026-11-21T20:10:00+00:00", true],
];

// Normalized kickoff rows for the refresh scheduler (single source of truth
// for "is a match live now?"). Dates are UTC.
//
// SCHEDULE first, then every Nations Championship row fixtures.json carries
// with a CONFIRMED kickoff that no confirmed row already covers (same UTC
// minute). That second half is what latches live mode for finals weekend:
// ESPN publishes those six games once Round 6 sets the pairings (expected
// after 21 Nov), the daily team-events build (and any fixtures burst) writes
// them into fixtures.json, and the next refresh tick reads them here. It is a
// local file read: zero vendor calls, and no hand edit.
//
// Deduping by minute only matters for decideMode's windows, which care about
// kickoff times, not pairings — two games at one minute need one window. If
// the two sources ever disagree on a game's time, both minutes stay in, so
// the live window covers the earlier and the later kickoff alike (the cost
// is a few extra 12-min polls, never a missed match).
//
// `published` defaults to the committed fixtures.json; pass an array of
// fixtures.json rows (or the whole file object) to keep tests off the disk.
export function scheduleKickoffs(published = loadPublishedFixtures()) {
  const rows = SCHEDULE.map(([week, , , date, timeConfirmed]) => ({
    week,
    date,
    timeConfirmed,
  }));
  const confirmed = new Set(rows.filter((r) => r.timeConfirmed).map((r) => kickoffMinute(r.date)));
  for (const k of publishedKickoffs(published)) {
    const minute = kickoffMinute(k.date);
    if (confirmed.has(minute)) continue;
    confirmed.add(minute);
    rows.push(k);
  }
  return rows;
}

const kickoffMinute = (iso) => new Date(iso).toISOString().slice(0, 16);

// fixtures.json rows -> confirmed Nations Championship kickoffs, in the
// scheduleKickoffs shape. Only `rnc-*` competition rows with timeTBC exactly
// false and a parseable date; a TBC row gets sweep-only coverage, as in
// SCHEDULE. Accepts the file object or its `fixtures` array.
export function publishedKickoffs(published) {
  const list = Array.isArray(published) ? published : published?.fixtures;
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const f of list) {
    if (!String(f?.comp?.key ?? "").startsWith("rnc-")) continue;
    if (f.timeTBC !== false) continue;
    const t = Date.parse(f.date);
    if (!Number.isFinite(t)) continue;
    out.push({
      week: f.round != null ? String(f.round) : null,
      date: new Date(t).toISOString(),
      timeConfirmed: true,
    });
  }
  return out;
}

// The committed fixtures.json, or [] when it is missing or unreadable — a
// bad file must never take the scheduler down, it just falls back to
// SCHEDULE alone. Read synchronously because decideMode (and the live
// burst's per-pass isLive check) are synchronous; the file is ~90 rows.
export function loadPublishedFixtures(path = FIXTURES_JSON) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.warn(`[schedule] fixtures.json unreadable (${e.message}) — using SCHEDULE alone`);
    return [];
  }
}

const side = (code) => ({
  id: T[code].id,
  name: T[code].name,
  logo: `https://media.api-sports.io/rugby/teams/${T[code].id}.png`,
  score: null,
});

export function staticFixtures() {
  return SCHEDULE.map(([week, home, away, date, timeConfirmed]) => ({
    id: `static-r${week}-${T[home].id}`,
    date,
    week,
    timeTBC: !timeConfirmed,
    status: { short: "NS", long: "Not Started", live: false },
    home: side(home),
    away: side(away),
  }));
}

// Appends static fixtures the API hasn't covered yet. A cached API game with
// the same week + home team supersedes its static twin.
export function mergeStaticFixtures(fixtures, cachedGames) {
  const covered = new Set(cachedGames.map((g) => `${g.week}:${g.teams?.home?.id ?? g.home?.id}`));
  const merged = [
    ...fixtures,
    ...staticFixtures().filter((f) => !covered.has(`${f.week}:${f.home.id}`)),
  ];
  return merged.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// The 12 Nations Championship teams by code, with their api-sports ids
// ({ ENG: { id: 386, name: "England" }, ... }). build-standings.mjs maps
// nations.json results (ids, no codes) onto registry codes with it. The same
// object as API_SPORTS_TEAMS above: both names landed from parallel branches,
// and either may be imported.
export const API_SPORTS_NATIONS = API_SPORTS_TEAMS;
