import { test } from "node:test";
import assert from "node:assert/strict";
import { espnEntry, mergeNext, ESPN_TEAM_IDS } from "./fetch-espn-fixtures.mjs";

const NOW = new Date("2026-07-15T00:00:00Z").getTime();

// Minimal ESPN core-API event shape: competitors carry team $refs whose URL
// ends in the ESPN team id.
const espnEv = (id, iso, homeId, awayId, league = "International Test Match") => ({
  id: String(id),
  date: iso,
  competitions: [{
    competitors: [
      { homeAway: "home", team: { $ref: `http://sports.core.api.espn.com/v2/sports/rugby/leagues/289234/seasons/2026/teams/${homeId}?lang=en` } },
      { homeAway: "away", team: { $ref: `http://sports.core.api.espn.com/v2/sports/rugby/leagues/289234/seasons/2026/teams/${awayId}?lang=en` } },
    ],
  }],
  __league: league,
});

test("espnEntry: home fixture vs tracked opponent", () => {
  // RSA (5) home vs NZL (8)
  const e = espnEntry(espnEv(603001, "2026-08-22T15:00Z", 5, 8), "RSA", "International Test Match", () => null);
  assert.deepEqual(e, {
    id: "espn-603001",
    date: "2026-08-22T15:00Z",
    league: "International Test Match",
    opponent: "New Zealand",
    opponentCode: "NZL",
    tracked: true,
    homeAway: "H",
    us: null,
    them: null,
    result: null,
  });
});

test("espnEntry: away fixture; untracked opponent falls back to resolver name", () => {
  // ARG (10) away at Portugal (unknown id 37)
  const e = espnEntry(espnEv(603002, "2026-08-08T19:00Z", 37, 10), "ARG", "International Test Match", (id) => (id === "37" ? "Portugal" : null));
  assert.equal(e.homeAway, "A");
  assert.equal(e.opponent, "Portugal");
  assert.equal(e.opponentCode, null);
  assert.equal(e.tracked, false);
});

test("espnEntry: event not involving the team returns null", () => {
  assert.equal(espnEntry(espnEv(1, "2026-08-22T15:00Z", 1, 9), "RSA", "x", () => null), null);
});

test("mergeNext: dedupes same-day same-opponent, prefers vendor entry, sorts, caps, drops past", () => {
  const vendor = [
    { id: 16098074, date: "2026-07-18T15:40:00.000Z", league: "Nations Championship, Group Stage", opponent: "Wales", opponentCode: "WAL", tracked: true, homeAway: "H", us: null, them: null, result: null },
    { id: 16098099, date: "2027-10-03T09:00:00.000Z", league: "World Cup, Pool B", opponent: "Italy", opponentCode: "ITA", tracked: true, homeAway: "H", us: null, them: null, result: null },
  ];
  const espn = [
    // duplicate of the vendor NC fixture (same day, same opponent) — dropped
    { id: "espn-1", date: "2026-07-18T15:40Z", league: "Nations Championship", opponent: "Wales", opponentCode: "WAL", tracked: true, homeAway: "H", us: null, them: null, result: null },
    // stale past fixture — dropped
    { id: "espn-2", date: "2026-07-01T15:00Z", league: "International Test Match", opponent: "Georgia", opponentCode: null, tracked: false, homeAway: "H", us: null, them: null, result: null },
    // genuinely new — kept, lands between NC and WC
    { id: "espn-3", date: "2026-08-22T15:00Z", league: "International Test Match", opponent: "New Zealand", opponentCode: "NZL", tracked: true, homeAway: "H", us: null, them: null, result: null },
  ];
  const merged = mergeNext(vendor, espn, NOW);
  assert.deepEqual(merged.map((e) => e.id), [16098074, "espn-3", 16098099]);
});

test("mergeNext: caps at 10", () => {
  const espn = [];
  for (let i = 1; i <= 12; i++) {
    espn.push({ id: `espn-${i}`, date: `2026-09-${String(i).padStart(2, "0")}T00:00Z`, league: "Test", opponent: `T${i}`, opponentCode: null, tracked: false, homeAway: "H", us: null, them: null, result: null });
  }
  assert.equal(mergeNext([], espn, NOW).length, 10);
});

test("ESPN_TEAM_IDS covers exactly the 12 tracked nations", () => {
  assert.equal(Object.keys(ESPN_TEAM_IDS).length, 12);
  assert.equal(ESPN_TEAM_IDS.RSA, 5);
  assert.equal(ESPN_TEAM_IDS.NZL, 8);
});
