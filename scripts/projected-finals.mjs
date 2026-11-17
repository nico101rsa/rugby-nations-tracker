// The Nations Championship finals weekend, projected (issue #165).
//
// ESPN lists the six finals only once round 6 has set the pairings (and not
// all at once: see espnFinals), which is
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
// The pairings follow the table, not the fixtures build. fixtures.json is
// rebuilt about once a day on a Nations Championship weekend (its own games
// are nations.json's), so rows written only there named the morning's
// pairings all day: on Sat 14 Nov 2026 the grand final still read France v
// South Africa hours after New Zealand had gone top of the South. The
// refresh that rebuilds the log now re-pairs these rows in the same pass
// (`repairedFinals`, called from refresh.mjs through build-fixtures'
// `syncProjectedFinals`), so they move at full time, with the table.
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

// Our own rows, projected or locked: `<comp key>-final-<rank>`.
export const isOwnFinal = (f) => isRnc(f) && String(f?.id ?? "") === `${f.comp.key}-final-${f.final?.rank}`;

// ESPN's finals-weekend rows in the feed (never our own), and whether they
// are the whole weekend: one row per final, every side a named nation.
//
// ESPN does not list the six at once. On Tue 17 Nov 2026 it listed ONE, four
// days before round 6: Italy v "TBC". The rule then was "the first real row
// stands the projection down", so the six pairings left fixtures.json and the
// Fixtures tab showed a single final against nobody, from 19:41 Sydney time
// until the daily check found it the next morning. A partial listing tells a
// fan less than the table does, so it is not a listing yet.
export function espnFinals(rows, finals) {
  const weekend = Math.min(...finals.map(([, , d]) => Date.parse(d))) - STAND_DOWN_DAYS * DAY_MS;
  const listed = (rows ?? []).filter(
    (f) => isRnc(f) && !isOwnFinal(f) && !f.final?.projected && Date.parse(f.date) >= weekend,
  );
  const named = (side) => side?.tracked === true;
  const complete = listed.length >= finals.length && listed.every((f) => named(f.home) && named(f.away));
  return { listed, complete };
}

// Has the feed ESPN's whole finals weekend? Only then do our rows stand down.
function realFinalsListed(rows, finals) {
  return espnFinals(rows, finals).complete;
}

// The rows without ESPN's partial finals listing, for the days we project
// over it. A complete listing is ESPN's to tell and is left alone.
export function withoutPartialFinals(fixtures) {
  const rows = fixtures ?? [];
  const finals = FINALS_BY_SEASON[seasonOf(rows.find(isRnc)?.comp?.key)];
  if (!finals) return rows;
  const { listed, complete } = espnFinals(rows, finals);
  if (complete || !listed.length) return rows;
  const drop = new Set(listed);
  return rows.filter((f) => !drop.has(f));
}

// fixtures (published shape) + nations.json's log (+ the comp tag for the
// days no rnc row is in the file) -> the six projected rows, or [].
export function projectedFinals(fixtures, log, { comp = null, codes = API_SPORTS_CODES } = {}) {
  const rows = fixtures ?? [];
  const c = rows.find(isRnc)?.comp ?? comp;
  if (!c || !Array.isArray(log) || !log.length) return [];
  const finals = FINALS_BY_SEASON[seasonOf(c.key)];
  if (!finals) return [];
  if (realFinalsListed(rows, finals)) return [];
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

// fixtures.json's rows with the finals paired again from `log`, or null when
// the file already says what the table says (so a quiet refresh writes
// nothing). The comp tag is taken from the rows being replaced, so this
// works in the days no pool row is left in the file.
export function repairedFinals(fixtures, log, opts = {}) {
  const rows = fixtures ?? [];
  const own = rows.filter(isOwnFinal);
  const rest = rows.filter((f) => !isOwnFinal(f));
  const next = projectedFinals(rest, log, { comp: own[0]?.comp ?? null, ...opts });
  // No pairings and no ESPN listing means the log could not be read as a
  // full table: that says nothing about the finals, so the rows stay.
  if (!next.length && own.length) {
    const finals = FINALS_BY_SEASON[seasonOf(own[0].comp.key)];
    if (!finals || !realFinalsListed(rest, finals)) return null;
  }
  // While we project, ESPN's partial listing (a final against "TBC") goes.
  const kept = next.length ? withoutPartialFinals(rest) : rest;
  const byId = (a, b) => (a.id < b.id ? -1 : 1);
  if (kept.length === rest.length && JSON.stringify([...own].sort(byId)) === JSON.stringify([...next].sort(byId))) return null;
  return [...kept, ...next];
}
