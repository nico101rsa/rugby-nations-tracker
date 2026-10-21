// The Nations Championship finals weekend, projected (issue #165).
//
// ESPN lists the six finals only once round 6 has set the pairings, which is
// after the last pool game (Sun 22 Nov 2026 07:10 Sydney time) and some days
// before the first final (Fri 27 Nov). The app projects the pairings from
// nations.json's log on its own, but only while fixtures.json carries at
// least one rnc-* row: played pool games leave this file (nations.json is
// their record), so from the first build after the last pool game until
// ESPN's listing the app showed no finals-weekend games at all. These rows
// close that gap from the data side, with no app build: equal conference
// ranks meet (North 1 v South 1 for the title, and so on down), the kick-offs
// are the confirmed GMT times, and `final.projected` stays true until every
// side has played all six rounds. The moment fixtures.json carries a real
// finals-weekend rnc-* row (ESPN's), nothing is projected: ESPN's rows are
// the record, and the app stands its own projection down on the same test.
//
// The rows are not appointments: the calendars (build-calendars) and the
// storylines (build-storylines) skip `final.projected` rows, and the
// live-score pass (liveCandidates) never asks ESPN about them.
//
// Mirrors the app's src/fixtures-list.js `projectedFinals` (FINALS table,
// NORTH_IDS from src/conferences.js), so a feed row and a projected row read
// the same way in the app.

// [label, rank, kickoff (UTC), isTitle] — Allianz Stadium, Twickenham.
export const FINALS_BY_SEASON = Object.freeze({
  2026: Object.freeze([
    ["Grand final", 1, "2026-11-29T16:40:00+00:00", true],
    ["3rd-place final", 2, "2026-11-28T16:40:00+00:00", false],
    ["5th-place final", 3, "2026-11-27T20:10:00+00:00", false],
    ["7th-place final", 4, "2026-11-29T13:10:00+00:00", false],
    ["9th-place final", 5, "2026-11-28T13:10:00+00:00", false],
    ["11th-place final", 6, "2026-11-27T16:40:00+00:00", false],
  ]),
});
export const FINALS_VENUE = "Allianz Stadium, Twickenham";
// Six Nations sides, by api-sports team id (nations.json's log carries ids).
export const NORTH_IDS = new Set([386, 387, 388, 389, 390, 391]);
// api-sports id -> code, as fixtures.json prints it (the twelve tracked
// nations; the same table as TEAMS in generate-digests, which the test pins).
export const API_SPORTS_CODES = Object.freeze({
  386: "ENG", 387: "FRA", 388: "IRE", 389: "ITA", 390: "SCO", 391: "WAL",
  460: "ARG", 461: "AUS", 463: "JPN", 465: "NZL", 467: "RSA", 28: "FIJ",
});
export const POOL_ROUNDS = 6;
const DAY_MS = 24 * 3600 * 1000;
// A real finals-weekend row from the feed: anything in the competition dated
// within three days before the first final.
export const STAND_DOWN_DAYS = 3;

export const isRnc = (f) => String(f?.comp?.key ?? "").startsWith("rnc-");
const seasonOf = (key) => Number(String(key ?? "").split("-")[1]);

// The registry's current Nations Championship, as a fixtures.json comp tag,
// or null. `today` is an ISO date.
export function rncComp(registry, today) {
  const c = (registry?.competitions ?? []).find(
    (x) => String(x?.key ?? "").startsWith("rnc-") && !(x.defaultUntil && x.defaultUntil <= today),
  );
  return c ? { key: c.key, label: c.label ?? c.name ?? c.key, kind: "competition" } : null;
}

// fixtures (published shape) + nations.json's log (+ the comp tag for the
// days no rnc row is in the file) -> the six projected rows, or [].
export function projectedFinals(fixtures, log, { comp = null, codes = API_SPORTS_CODES } = {}) {
  const rows = fixtures ?? [];
  const c = rows.find(isRnc)?.comp ?? comp;
  if (!c || !Array.isArray(log) || !log.length) return [];
  const finals = FINALS_BY_SEASON[seasonOf(c.key)];
  if (!finals) return [];
  const weekend = Math.min(...finals.map(([, , d]) => Date.parse(d))) - STAND_DOWN_DAYS * DAY_MS;
  if (rows.some((f) => isRnc(f) && !f.final?.projected && Date.parse(f.date) >= weekend)) return [];
  // The log arrives ranked overall; keep that order within each conference.
  const north = log.filter((r) => NORTH_IDS.has(r.id));
  const south = log.filter((r) => !NORTH_IDS.has(r.id));
  if (north.length < finals.length || south.length < finals.length) return [];
  const locked = log.every((r) => (r.P ?? 0) >= POOL_ROUNDS);
  const side = (r) => ({ code: codes[r.id] ?? String(r.team), name: r.team, tracked: true });
  return finals.map(([label, rank, date, title]) => ({
    id: `${c.key}-final-${rank}`,
    date: new Date(date).toISOString(),
    timeTBC: false,
    home: side(north[rank - 1]),
    away: side(south[rank - 1]),
    comp: { key: c.key, label: c.label, kind: c.kind ?? "competition" },
    venue: FINALS_VENUE,
    final: { label, rank, title, projected: !locked },
  }));
}
