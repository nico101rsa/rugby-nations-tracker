import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTeamEvents } from "./fetch-team-events.mjs";

const NOW = new Date("2026-07-15T00:00:00Z").getTime();
const g = (id, date, homeId, homeName, awayId, awayName, hs, as, league = "Test Match") => ({
  id, date, league: { name: league },
  teams: { home: { id: homeId, name: homeName }, away: { id: awayId, name: awayName } },
  scores: { home: hs, away: as },
  status: { short: hs == null ? "NS" : "FT" },
});

test("buildTeamEvents: results from our side, tracked flag, untracked opponents kept", () => {
  const games = [
    g(1, "2026-06-01T00:00:00Z", 467, "South Africa", 465, "New Zealand", 20, 27, "Rugby Championship"),
    g(2, "2026-06-08T00:00:00Z", 9999, "Portugal", 467, "South Africa", 10, 50),
    g(3, "2026-07-18T00:00:00Z", 467, "South Africa", 391, "Wales", null, null, "Nations Championship"),
    g(4, "2026-08-01T00:00:00Z", 465, "New Zealand", 467, "South Africa", null, null, "Rugby Championship"),
  ];
  const teams = buildTeamEvents({ 467: games }, NOW);
  const { last, next } = teams.RSA;
  assert.equal(last.length, 2);
  assert.deepEqual(
    last[0],
    { id: 1, date: "2026-06-01T00:00:00Z", league: "Rugby Championship", opponent: "New Zealand", opponentCode: "NZL", tracked: true, homeAway: "H", us: 20, them: 27, result: "L" },
  );
  assert.equal(last[1].opponent, "Portugal");
  assert.equal(last[1].tracked, false);
  assert.equal(last[1].opponentCode, null);
  assert.equal(last[1].result, "W");
  assert.deepEqual(next.map((n) => n.opponentCode), ["WAL", "NZL"]);
  assert.equal(next[0].result, null);
});

test("buildTeamEvents: caps last at 10 (oldest dropped) and next at 5", () => {
  const games = [];
  for (let i = 1; i <= 13; i++) {
    games.push(g(i, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`, 386, "England", 387, "France", 20 + i, 10));
  }
  for (let i = 1; i <= 7; i++) {
    games.push(g(100 + i, `2026-08-${String(i).padStart(2, "0")}T00:00:00Z`, 386, "England", 387, "France", null, null));
  }
  const { ENG } = buildTeamEvents({ 386: games }, NOW);
  assert.equal(ENG.last.length, 10);
  assert.equal(ENG.last[0].id, 4); // 1..3 dropped
  assert.equal(ENG.next.length, 5);
});

test("buildTeamEvents: past unplayed games (cancelled/no score) are neither last nor next", () => {
  const games = [g(1, "2026-05-01T00:00:00Z", 388, "Ireland", 9999, "Portugal", null, null)];
  const { IRE } = buildTeamEvents({ 388: games }, NOW);
  assert.deepEqual(IRE, { last: [], next: [] });
});
