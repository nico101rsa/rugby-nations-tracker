// Announced competitions ESPN hasn't published yet.
//
// WHY THIS EXISTS. On 2026-07-25 the 2027 Six Nations was publicly announced —
// 15 fixtures, 5 Feb to 13 Mar 2027 — and ESPN's feed carried the season shell
// with ZERO events. Left alone that produces a genuinely bad outcome: the
// registry skips competitions with no fixtures (a dropdown entry with nothing
// behind it is a dead end), so the handover chain jumps straight from the
// Nations Championship to the World Cup, and the biggest northern-hemisphere
// tournament of the year runs for six weeks completely invisible in the app —
// during precisely the months nobody is watching the pipeline.
//
// This is the same shape of problem, and the same solution, as
// static-fixtures.mjs: seed the announced schedule from public sources, and let
// the vendor record supersede it the moment it appears. Nothing here is
// permanent — see supersede() below.
//
// ⚠️ SOURCING AND ITS LIMITS. Dates, rounds and pairings are cross-checked
// against two sources that agree on all 15 matches: Wikipedia's "2027 Six
// Nations Championship" and Scottish Rugby's official fixture announcement
// (which confirms Scotland's R1 Italy home, R2 Wales home, R3 France away on
// the Sunday, R4 Ireland home on the Friday night, R5 England away as the
// middle Super Saturday match).
//
// KICKOFF TIMES ARE MARKED TBC ON PURPOSE. The two sources disagree on
// Scotland v Wales (16:40 vs 16:10), and Scottish Rugby states outright that
// most kickoff times are not yet confirmed. Publishing a precise time we
// cannot support would put a wrong number on the screen, so every seeded
// fixture carries `timeTBC: true` and the app renders "TBC" rather than a
// time. The date is the part we can stand behind; ESPN supplies exact times
// when it publishes.

// The 2027 Six Nations. [round, home, away, dateISO]
// Times in the ISO strings are the best current estimate and are NOT rendered
// (timeTBC is set on every entry) — they exist only to order fixtures within a
// day.
const SIX_NATIONS_2027 = [
  // Round 1
  ["1", "IRE", "ENG", "2027-02-05T20:10:00Z"],
  ["1", "SCO", "ITA", "2027-02-06T14:10:00Z"],
  ["1", "FRA", "WAL", "2027-02-06T16:40:00Z"],
  // Round 2
  ["2", "ITA", "IRE", "2027-02-13T14:10:00Z"],
  ["2", "SCO", "WAL", "2027-02-13T16:40:00Z"],
  ["2", "ENG", "FRA", "2027-02-14T15:10:00Z"],
  // Round 3
  ["3", "WAL", "IRE", "2027-02-20T14:10:00Z"],
  ["3", "ENG", "ITA", "2027-02-20T16:40:00Z"],
  ["3", "FRA", "SCO", "2027-02-21T15:10:00Z"],
  // Round 4 (one rest week after Round 3)
  ["4", "SCO", "IRE", "2027-03-05T20:10:00Z"],
  ["4", "ITA", "FRA", "2027-03-06T14:10:00Z"],
  ["4", "WAL", "ENG", "2027-03-06T16:40:00Z"],
  // Round 5 — Super Saturday
  ["5", "ITA", "WAL", "2027-03-13T14:10:00Z"],
  ["5", "ENG", "SCO", "2027-03-13T16:40:00Z"],
  ["5", "IRE", "FRA", "2027-03-13T20:10:00Z"],
];

const VENUES = {
  IRE: "Aviva Stadium, Dublin",
  SCO: "Scottish Gas Murrayfield, Edinburgh",
  FRA: "Stade de France, Saint-Denis",
  ITA: "Stadio Olimpico, Rome",
  ENG: "Twickenham Stadium, London",
  WAL: "Principality Stadium, Cardiff",
};

const NAMES = {
  ENG: "England", FRA: "France", IRE: "Ireland",
  ITA: "Italy", SCO: "Scotland", WAL: "Wales",
};

// Seeds keyed by the registry key they stand in for.
export const SEEDS = {
  "6n-2027": {
    key: "6n-2027",
    label: "6N '27",
    name: "Six Nations",
    espnLeagueId: 180659,
    season: 2027,
    // Announced 2026-07-25; sources in the header note.
    fixtures: SIX_NATIONS_2027.map(([round, home, away, date]) => ({
      id: `seed-6n2027-${home.toLowerCase()}-${away.toLowerCase()}`,
      date,
      timeTBC: true,
      round,
      home: { code: home, name: NAMES[home], tracked: true },
      away: { code: away, name: NAMES[away], tracked: true },
      venue: VENUES[home] ?? null,
      comp: { key: "6n-2027", label: "6N '27", kind: "competition" },
      seeded: true,
    })),
  },
};

// A seed applies only while the vendor has published NOTHING for that
// competition. The moment ESPN carries even one fixture we defer entirely —
// a half-seeded, half-live list would double-count matches and there is no
// reliable key to dedupe a seeded fixture against a vendor one (ids differ,
// and kickoff times move).
//
// ⚠️ The test is the registry entry's `seeded` FLAG, not its fixture count.
// The first version of this asked "does the registry show zero fixtures?" —
// but build-competitions has already substituted the seed by then, so the
// count reads 15 and the seed skipped itself, leaving the competition in the
// registry with no fixtures behind it. The daily integrity check caught that
// on its first run ("Six Nations 2027 is selectable but has no fixtures in
// fixtures.json"), which is precisely the class of silent breakage it exists
// for. `seeded: true` means the vendor is still empty; when ESPN publishes,
// build-competitions emits a real entry without the flag and this returns
// nothing.
export function applicableSeeds(registry) {
  const byKey = new Map((registry?.competitions ?? []).map((c) => [c.key, c]));
  return Object.values(SEEDS).filter((s) => {
    const entry = byKey.get(s.key);
    return entry ? entry.seeded === true : false;
  });
}

// Seeded fixtures for competitions the vendor still has nothing for.
export function seededFixtures(registry) {
  return applicableSeeds(registry).flatMap((s) => s.fixtures);
}

// A seed's competition entry, shaped like build-competitions' entryFor output
// so the registry can carry it unchanged. Structure is asserted rather than
// classified: a 6-team single round robin IS a table, and the graph would say
// so — but stating it here keeps the seed honest if a fixture is ever mistyped,
// because the integrity check recomputes it and compares.
export function seededCompetition(seed) {
  const dates = seed.fixtures.map((f) => f.date.slice(0, 10)).sort();
  const teams = [...new Set(seed.fixtures.flatMap((f) => [f.home.code, f.away.code]))].sort();
  return {
    key: seed.key,
    label: seed.label,
    name: seed.name,
    espnLeagueId: seed.espnLeagueId,
    season: seed.season,
    startDate: dates[0],
    endDate: dates.at(-1),
    structure: "table",
    groups: null,
    teams,
    fixtureCount: seed.fixtures.length,
    status: "scheduled",
    seeded: true,
  };
}
