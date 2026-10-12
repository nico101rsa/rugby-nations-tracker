// Kickoff corrections: the committed table's invariants, and the same match
// keyed identically from each of the three feed shapes. Synthetic rows and an
// explicit test table throughout, so these tests outlive the Bledisloe row.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KICKOFF_OVERRIDES, ESPN_TEAM_IDS, UNTRACKED_CODES,
  utcDay, matchKey, keyOf, overrideKickoff, applyKickoffOverrides, correctedKickoffMs,
} from "./kickoff-overrides.mjs";
import { API_SPORTS_TEAMS, API_SPORTS_CODE_BY_ID, staticFixtures } from "./static-fixtures.mjs";
import { SEEDS } from "./seed-competitions.mjs";

const ms = (iso) => new Date(iso).getTime();
const quiet = { log: () => {} };
const KEY_RE = /^\d{4}-\d{2}-\d{2} [A-Z]{3}-[A-Z]{3}$/;
const CODES = new Set([...Object.keys(ESPN_TEAM_IDS), ...Object.values(UNTRACKED_CODES)]);

// The Bledisloe row as committed on 12 Oct 2026, pinned here so the tests do
// not depend on the live table still carrying it.
const TABLE = {
  "2026-10-17 AUS-NZL": {
    date: "2026-10-17T04:45:00.000Z",
    vendor: "2026-10-17T05:00:00.000Z",
    note: "AUS v NZL Bledisloe, Accor Stadium, Sydney",
  },
  "2027-10-01 AUS-HKG": {
    date: "2027-10-01T10:30:00.000Z",
    vendor: "2027-10-01T10:45:00.000Z",
    note: "synthetic: an untracked opponent",
  },
};

// fixtures.json shape
const fixtureRow = (over = {}) => ({
  id: "espn-603464", date: "2026-10-17T05:00:00.000Z", timeTBC: false,
  home: { code: "AUS", name: "Australia", tracked: true },
  away: { code: "NZL", name: "New Zealand", tracked: true },
  comp: { key: "series-nzl-aus-2026", label: "NZ v AUS", kind: "series" },
  venue: "Accor Stadium, Sydney", series: { label: "NZ v AUS", game: 2, of: 2 },
  ...over,
});

test("table: every row moves its kickoff EARLIER, same UTC day, by an hour at most, with a note", () => {
  for (const [key, o] of Object.entries(KICKOFF_OVERRIDES)) {
    assert.ok(Number.isFinite(ms(o.date)), `${key}: date parses`);
    assert.ok(Number.isFinite(ms(o.vendor)), `${key}: vendor parses`);
    assert.ok(ms(o.date) < ms(o.vendor), `${key}: ${o.date} must be before the vendor's ${o.vendor}`);
    assert.equal(utcDay(o.date), utcDay(o.vendor), `${key}: a correction never leaves its UTC day`);
    assert.ok(ms(o.vendor) - ms(o.date) <= 3_600_000, `${key}: more than an hour is a reschedule — the vendor's job`);
    assert.match(key, KEY_RE, `${key}: "<YYYY-MM-DD> <HOME>-<AWAY>"`);
    assert.equal(key.slice(0, 10), utcDay(o.vendor), `${key}: keyed on the VENDOR's UTC day`);
    const [home, away] = key.slice(11).split("-");
    assert.ok(CODES.has(home), `${key}: ${home} is a code fixtures.json prints`);
    assert.ok(CODES.has(away), `${key}: ${away} is a code fixtures.json prints`);
    assert.ok(typeof o.note === "string" && o.note.trim().length > 0, `${key}: say where the time came from`);
  }
});

test("table: no row is keyed on a seed or static placeholder time", () => {
  // Seeded 6N rows and the static November NC rows sit on expected slots
  // (timeTBC). A row recording one of those as the "vendor" time would fire
  // on a placeholder and publish a made-up kickoff as confirmed.
  const placeholders = new Set([
    ...Object.values(SEEDS).flatMap((s) => s.fixtures)
      .filter((f) => f.timeTBC).map((f) => `${keyOf.fixture(f)}@${ms(f.date)}`),
    ...staticFixtures()
      .filter((f) => f.timeTBC).map((f) => `${keyOf.nations()(f)}@${ms(f.date)}`),
  ]);
  assert.ok(placeholders.size > 0, "the placeholder sets are populated");
  for (const [key, o] of Object.entries(KICKOFF_OVERRIDES)) {
    assert.ok(!placeholders.has(`${key}@${ms(o.vendor)}`), `${key}: ${o.vendor} is a placeholder slot`);
  }
});

test("the test table obeys the same rules as the real one", () => {
  for (const [key, o] of Object.entries(TABLE)) {
    assert.ok(ms(o.date) < ms(o.vendor) && utcDay(o.date) === utcDay(o.vendor), key);
    assert.match(key, KEY_RE);
  }
});

test("matchKey: UTC day of the time given + HOME-AWAY; null when any part is missing", () => {
  assert.equal(matchKey("AUS", "NZL", "2026-10-17T05:00Z"), "2026-10-17 AUS-NZL");
  assert.equal(matchKey("AUS", "NZL", "2026-10-17T05:00:00+00:00"), "2026-10-17 AUS-NZL");
  // 15:45 Sydney time is still the 17th in UTC; a 23:30Z kickoff keys its UTC day.
  assert.equal(matchKey("ENG", "AUS", "2026-11-08T23:30:00.000Z"), "2026-11-08 ENG-AUS");
  assert.equal(matchKey(null, "NZL", "2026-10-17T05:00Z"), null);
  assert.equal(matchKey("AUS", "NZL", null), null);
  assert.equal(matchKey("AUS", "NZL", "not a date"), null);
});

test("fixtures.json row: 05:00Z becomes 04:45Z with timeTBC false, input untouched", () => {
  const row = fixtureRow();
  const out = overrideKickoff(row, keyOf.fixture, TABLE);
  assert.notEqual(out, row);
  assert.equal(out.date, "2026-10-17T04:45:00.000Z");
  assert.equal(out.timeTBC, false);
  assert.equal(out.venue, row.venue);
  assert.deepEqual(out.series, row.series);
  assert.equal(row.date, "2026-10-17T05:00:00.000Z", "input not mutated");
  // A TBC flag on the vendor row is cleared: the time is now confirmed.
  assert.equal(overrideKickoff(fixtureRow({ timeTBC: true }), keyOf.fixture, TABLE).timeTBC, false);
});

test("nations.json row: api-sports ids 461 v 465 at '+00:00' move via keyOf.nations", () => {
  assert.equal(API_SPORTS_TEAMS.AUS.id, 461);
  assert.equal(API_SPORTS_CODE_BY_ID[465], "NZL");
  const row = {
    id: 53213, date: "2026-10-17T05:00:00+00:00", week: null,
    status: { short: "NS", long: "Not Started", live: false },
    home: { id: 461, name: "Australia", logo: "", score: null },
    away: { id: 465, name: "New Zealand", logo: "", score: null },
  };
  const out = overrideKickoff(row, keyOf.nations(API_SPORTS_CODE_BY_ID), TABLE);
  assert.equal(out.date, "2026-10-17T04:45:00.000Z");
  assert.equal(out.home, row.home);
  assert.equal(row.date, "2026-10-17T05:00:00+00:00");
  // The default map is the api-sports one.
  assert.equal(overrideKickoff(row, keyOf.nations(), TABLE).date, "2026-10-17T04:45:00.000Z");
});

test("team-events next rows: AUS 'H' and NZL 'A' key the same match and both move", () => {
  const aus = { id: "espn-603464", date: "2026-10-17T05:00Z", opponent: "New Zealand", opponentCode: "NZL", tracked: true, homeAway: "H", us: null, them: null, result: null };
  const nzl = { ...aus, opponent: "Australia", opponentCode: "AUS", homeAway: "A" };
  assert.equal(keyOf.teamNext("AUS")(aus), "2026-10-17 AUS-NZL");
  assert.equal(keyOf.teamNext("NZL")(nzl), "2026-10-17 AUS-NZL");
  assert.equal(overrideKickoff(aus, keyOf.teamNext("AUS"), TABLE).date, "2026-10-17T04:45:00.000Z");
  assert.equal(overrideKickoff(nzl, keyOf.teamNext("NZL"), TABLE).date, "2026-10-17T04:45:00.000Z");
  assert.equal(aus.date, "2026-10-17T05:00Z", "input not mutated");
});

test("team-events next row with an untracked opponent keys through UNTRACKED_CODES", () => {
  const row = { id: "espn-603499", date: "2027-10-01T10:45:00.000Z", opponent: "Hong Kong", opponentCode: null, tracked: false, homeAway: "H" };
  assert.equal(keyOf.teamNext("AUS")(row), "2027-10-01 AUS-HKG");
  // …the same key fixtures.json's AUS v HKG row produces.
  const fx = fixtureRow({ id: "espn-603499", date: "2027-10-01T10:45:00.000Z", away: { code: "HKG", name: "Hong Kong", tracked: false } });
  assert.equal(keyOf.fixture(fx), keyOf.teamNext("AUS")(row));
  assert.equal(overrideKickoff(row, keyOf.teamNext("AUS"), TABLE).date, "2027-10-01T10:30:00.000Z");
  // An opponent nobody can code is never keyed.
  assert.equal(keyOf.teamNext("AUS")({ ...row, opponent: "Somewhere" }), null);
});

test("the vendor moving the game, or catching up, returns the row itself", () => {
  const moved = fixtureRow({ date: "2026-10-17T05:15:00.000Z" });
  assert.equal(overrideKickoff(moved, keyOf.fixture, TABLE), moved);
  const caughtUp = fixtureRow({ date: "2026-10-17T04:45:00.000Z" });
  assert.equal(overrideKickoff(caughtUp, keyOf.fixture, TABLE), caughtUp);
  // A move to another UTC day is a different key altogether.
  const nextDay = fixtureRow({ date: "2026-10-18T05:00:00.000Z" });
  assert.equal(overrideKickoff(nextDay, keyOf.fixture, TABLE), nextDay);
});

test("a seed row on a placeholder time never matches", () => {
  const seed = fixtureRow({ id: "seed-x", date: "2026-10-17T12:00:00Z", timeTBC: true, seeded: true });
  assert.equal(overrideKickoff(seed, keyOf.fixture, TABLE), seed);
  assert.equal(seed.timeTBC, true);
});

test("a reversed fixture (NZL home) is a different match key and is left alone", () => {
  const reversed = fixtureRow({ home: { code: "NZL", name: "New Zealand" }, away: { code: "AUS", name: "Australia" } });
  assert.equal(overrideKickoff(reversed, keyOf.fixture, TABLE), reversed);
});

test("applyKickoffOverrides: the same array when nothing applies, a new one otherwise, with a log line per hit", () => {
  const other = fixtureRow({ id: "espn-1", home: { code: "ENG" }, away: { code: "FRA" } });
  const untouched = [other, fixtureRow({ date: "2026-10-17T05:15:00.000Z" })];
  assert.equal(applyKickoffOverrides(untouched, keyOf.fixture, TABLE, quiet), untouched);
  const lines = [];
  const rows = [other, fixtureRow()];
  const out = applyKickoffOverrides(rows, keyOf.fixture, TABLE, { log: (l) => lines.push(l) });
  assert.notEqual(out, rows);
  assert.equal(out[0], other);
  assert.equal(out[1].date, "2026-10-17T04:45:00.000Z");
  assert.equal(rows[1].date, "2026-10-17T05:00:00.000Z");
  assert.deepEqual(lines, ["kickoff override applied: 2026-10-17 AUS-NZL 2026-10-17T05:00:00.000Z→2026-10-17T04:45:00.000Z"]);
  assert.equal(applyKickoffOverrides(undefined, keyOf.fixture, TABLE, quiet), undefined);
  assert.deepEqual(applyKickoffOverrides([], keyOf.fixture, TABLE, quiet), []);
});

test("an empty table changes nothing", () => {
  const rows = [fixtureRow()];
  assert.equal(applyKickoffOverrides(rows, keyOf.fixture, {}, quiet), rows);
});

// ---- correctedKickoffMs: the kickoff every live-window decision reads -----------

test("correctedKickoffMs: the earlier of the row's time and its correction — vendor and corrected feeds agree", () => {
  const corrected = ms("2026-10-17T04:45:00.000Z");
  assert.equal(correctedKickoffMs(fixtureRow(), keyOf.fixture, TABLE), corrected, "feed still on ESPN's 05:00Z");
  assert.equal(correctedKickoffMs(fixtureRow({ date: "2026-10-17T04:45:00.000Z" }), keyOf.fixture, TABLE), corrected, "feed already corrected");
  assert.equal(correctedKickoffMs(fixtureRow({ date: "2026-10-17T05:00Z" }), keyOf.fixture, TABLE), corrected, "short ESPN date form");
  // The default key function is the fixtures.json one.
  assert.equal(correctedKickoffMs(fixtureRow(), undefined, TABLE), corrected);
});

test("correctedKickoffMs: reads only — the row is untouched and the published rows are what they were", () => {
  const row = fixtureRow();
  const before = JSON.stringify(row);
  correctedKickoffMs(row, keyOf.fixture, TABLE);
  assert.equal(JSON.stringify(row), before);
  // And applyKickoffOverrides still publishes exactly the corrected row.
  assert.equal(applyKickoffOverrides([row], keyOf.fixture, TABLE, quiet)[0].date, "2026-10-17T04:45:00.000Z");
});

test("correctedKickoffMs: the vendor guard holds — a rescheduled game follows the feed, either way", () => {
  assert.equal(correctedKickoffMs(fixtureRow({ date: "2026-10-17T05:30:00.000Z" }), keyOf.fixture, TABLE), ms("2026-10-17T05:30:00.000Z"));
  assert.equal(correctedKickoffMs(fixtureRow({ date: "2026-10-17T04:00:00.000Z" }), keyOf.fixture, TABLE), ms("2026-10-17T04:00:00.000Z"));
});

test("correctedKickoffMs: no row in the table, no key, or no date", () => {
  assert.equal(correctedKickoffMs(fixtureRow(), keyOf.fixture, {}), ms("2026-10-17T05:00:00.000Z"));
  assert.equal(correctedKickoffMs({ date: "2026-10-17T05:00:00.000Z", comp: { kind: "test" } }, keyOf.fixture, TABLE), ms("2026-10-17T05:00:00.000Z"));
  assert.ok(Number.isNaN(correctedKickoffMs(fixtureRow({ date: "TBC" }), keyOf.fixture, TABLE)));
  assert.ok(Number.isNaN(correctedKickoffMs(null, keyOf.fixture, TABLE)));
  assert.ok(Number.isNaN(correctedKickoffMs(undefined)));
});

test("correctedKickoffMs: never later than the row's own time, for every committed row", () => {
  for (const [key, o] of Object.entries(KICKOFF_OVERRIDES)) {
    const [home, away] = key.slice(11).split("-");
    const row = fixtureRow({ date: o.vendor, home: { code: home }, away: { code: away } });
    assert.equal(correctedKickoffMs(row), ms(o.date), `${key}: the live window opens from the corrected time`);
    assert.ok(correctedKickoffMs(row) <= ms(row.date));
  }
});
