// The announced 2026 Nations Championship schedule (rounds 2-6), used to fill
// the Fixtures tab because the api-sports data plan only exposes a 3-day
// window. Once a match enters that window the real API record (same week +
// home team) replaces the static one, so live status/scores still work.
//
// Sources: Wikipedia "2026 Nations Championship" + RugbyPass fixtures page
// (kickoff times confirmed for July; November times still TBC as of 5 Jul 2026).
// Finals weekend (27-29 Nov, Twickenham) is omitted — pairings depend on the
// final conference ranks.

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
  // Round 4 — 6-8 November (times TBC)
  ["4", "IRE", "ARG", "2026-11-06T12:00:00+00:00", false],
  ["4", "ITA", "RSA", "2026-11-07T12:00:00+00:00", false],
  ["4", "SCO", "NZL", "2026-11-07T12:00:00+00:00", false],
  ["4", "WAL", "JPN", "2026-11-07T12:00:00+00:00", false],
  ["4", "FRA", "FIJ", "2026-11-07T12:00:00+00:00", false],
  ["4", "ENG", "AUS", "2026-11-08T12:00:00+00:00", false],
  // Round 5 — 13-15 November (times TBC)
  ["5", "FRA", "RSA", "2026-11-13T12:00:00+00:00", false],
  ["5", "ITA", "ARG", "2026-11-14T12:00:00+00:00", false],
  ["5", "WAL", "NZL", "2026-11-14T12:00:00+00:00", false],
  ["5", "ENG", "JPN", "2026-11-14T12:00:00+00:00", false],
  ["5", "IRE", "FIJ", "2026-11-14T12:00:00+00:00", false],
  ["5", "SCO", "AUS", "2026-11-15T12:00:00+00:00", false],
  // Round 6 — 21 November (times TBC)
  ["6", "ENG", "NZL", "2026-11-21T12:00:00+00:00", false],
  ["6", "SCO", "JPN", "2026-11-21T12:00:00+00:00", false],
  ["6", "IRE", "RSA", "2026-11-21T12:00:00+00:00", false],
  ["6", "ITA", "FIJ", "2026-11-21T12:00:00+00:00", false],
  ["6", "WAL", "AUS", "2026-11-21T12:00:00+00:00", false],
  ["6", "FRA", "ARG", "2026-11-21T12:00:00+00:00", false],
];

// Normalized kickoff rows for the refresh scheduler (single source of truth
// for "is a match live now?"). Dates are UTC, as stored in SCHEDULE.
export function scheduleKickoffs() {
  return SCHEDULE.map(([week, , , date, timeConfirmed]) => ({
    week,
    date,
    timeConfirmed,
  }));
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
