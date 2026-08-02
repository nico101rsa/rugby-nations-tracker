// The 2026 All Blacks tour of South Africa — the four midweek/provincial
// games (vs SA's URC franchises) that NO reachable vendor carries.
//
// WHY THIS EXISTS. The four SA-NZ tests flow in from ESPN (league 289234,
// "International Test Match") and need nothing here. The midweek games exist
// nowhere: ESPN has no event objects for them (probed 2026-08-02 — league
// 289234, URC, Currie Cup, tour leagues, adjacent event ids), and api-sports
// is circumstantially negative (see probe-tour.mjs for the definitive
// 1-request match-day check). Left alone, half the tour is invisible in the
// app. Same shape of problem, same solution as seed-competitions.mjs /
// static-fixtures.mjs: seed the announced schedule from public sources.
//
// UNLIKE those seeds, no vendor record will ever supersede these — so this
// module also owns the RESULTS path. Each fixture carries a `score` field
// (null until played). It fills from, in order of precedence:
//   1. HAND_RESULTS below — a hand-edit after each game, the fallback of
//      record (edit the null to { home, away } and let CI publish);
//   2. scripts/tour-results.json — written by the match-day api-sports probe
//      (probe-tour.mjs) if that vendor turns out to carry the games.
// Hand edits win: a human correcting a score must never be re-clobbered by
// a stale probe record.
//
// SOURCING. Fixture list cross-checked 2026-08-02 against rugby.com.au's
// official announcement (2025-10-16) and The Citizen's kick-off list, which
// agree on all four games; ESPN's records for the four tests match The
// Citizen exactly, so the two sources cross-validate. All kickoffs 19:10
// SAST = 17:10Z — confirmed times, not TBC.
//
// CLASSIFICATION. `kind: "tour"` is a first-class comp kind (alongside
// competition | series | test): the app tags Tour rows on it, the stats/form
// exclusion keys on it, and it is reusable for future tours. The series pass
// in build-fixtures.mjs only folds `kind: "test"` pairs, so tour games can
// never be mistaken for a test series; they also never enter standings
// (nations.json is league-145-only by construction).
//
// Opponents are franchises, not nations: `tracked: false`, 3-letter code,
// no flag (the app renders the code as a grey tile) — same treatment as
// Portugal/Georgia one-offs.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const TOUR_COMP = { key: "tour-nzl-2026", label: "TOUR", kind: "tour" };

// [slug, dateISO (17:10Z = 19:10 SAST), opponent code, opponent name, venue]
const GAMES = [
  ["sto", "2026-08-07T17:10:00Z", "STO", "Stormers", "Cape Town Stadium, Cape Town"],
  ["sha", "2026-08-11T17:10:00Z", "SHA", "Sharks", "Kings Park, Durban"],
  ["bul", "2026-08-15T17:10:00Z", "BUL", "Bulls", "Loftus Versfeld, Pretoria"],
  ["lio", "2026-08-25T17:10:00Z", "LIO", "Lions", "Ellis Park, Johannesburg"],
];

// HAND-EDITED RESULTS — the fallback of record if the probe finds nothing.
// After each game, replace the null with `{ home: <franchise>, away: <NZ> }`
// (home is always the SA franchise) and let the next scheduled run publish.
export const HAND_RESULTS = {
  "seed-tour-nzl2026-sto": null,
  "seed-tour-nzl2026-sha": null,
  "seed-tour-nzl2026-bul": null,
  "seed-tour-nzl2026-lio": null,
};

// Probe-written results (probe-tour.mjs). Missing/unreadable file is the
// normal state until a probe actually finds a game.
export const RESULTS_FILE = join(__dirname, "tour-results.json");
export async function loadProbeResults(file = RESULTS_FILE) {
  try {
    return JSON.parse(await readFile(file, "utf8")).results ?? {};
  } catch {
    return {};
  }
}

// The four fixtures in published fixtures.json shape (+ `score`). Pure so
// tests can inject probe results.
//
// ⚠️ NO FUTURE-ONLY FILTER APPLIES TO THESE. seed-competitions fixtures are
// dropped once their date passes (ESPN owns the played record); these have
// no vendor record to graduate into, so a played tour game must PERSIST in
// fixtures.json carrying its score — that IS the record the app shows.
// build-fixtures.mjs appends them unfiltered on purpose.
export function tourFixtures(probeResults = {}) {
  return GAMES.map(([slug, date, code, name, venue]) => {
    const id = `seed-tour-nzl2026-${slug}`;
    return {
      id,
      date,
      timeTBC: false,
      home: { code, name, tracked: false },
      away: { code: "NZL", name: "New Zealand", tracked: true },
      comp: { ...TOUR_COMP },
      venue,
      seeded: true,
      // Hand edit beats probe (a human correction must stick).
      score: HAND_RESULTS[id] ?? probeResults[id] ?? null,
    };
  });
}
