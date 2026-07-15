import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, buildTeamEvents } from "./fetch-team-events.mjs";

const NOW = new Date("2026-07-15T00:00:00Z").getTime();
const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const ev = (id, iso, homeName, awayName, hs, as, tournament = "Test Match") => ({
  id,
  startTimestamp: ts(iso),
  tournament: { name: tournament },
  homeTeam: { id: id * 100, name: homeName },
  awayTeam: { id: id * 100 + 1, name: awayName },
  homeScore: hs == null ? {} : { current: hs },
  awayScore: as == null ? {} : { current: as },
  status: { type: hs == null ? "notstarted" : "finished" },
});

test("normalizeEvent: result from our side, tracked flag, untracked opponent kept by name", () => {
  const lost = normalizeEvent(ev(1, "2026-06-01T00:00:00Z", "South Africa", "New Zealand", 20, 27, "Rugby Championship"), "RSA");
  assert.deepEqual(lost, {
    id: 1, date: "2026-06-01T00:00:00.000Z", league: "Rugby Championship",
    opponent: "New Zealand", opponentCode: "NZL", tracked: true,
    homeAway: "H", us: 20, them: 27, result: "L", finished: true,
  });
  const away = normalizeEvent(ev(2, "2026-06-08T00:00:00Z", "Portugal", "South Africa", 10, 50), "RSA");
  assert.equal(away.opponent, "Portugal");
  assert.equal(away.tracked, false);
  assert.equal(away.opponentCode, null);
  assert.equal(away.homeAway, "A");
  assert.equal(away.result, "W");
});

test("buildTeamEvents: last capped at 10 finished (oldest dropped), next capped at 5 future", () => {
  const lastEvents = [];
  for (let i = 1; i <= 13; i++) {
    lastEvents.push(ev(i, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`, "England", "France", 20 + i, 10));
  }
  const nextEvents = [];
  for (let i = 1; i <= 7; i++) {
    nextEvents.push(ev(100 + i, `2026-08-${String(i).padStart(2, "0")}T00:00:00Z`, "England", "France", null, null));
  }
  const { ENG } = buildTeamEvents({ ENG: { lastEvents, nextEvents } }, NOW);
  assert.equal(ENG.last.length, 10);
  assert.equal(ENG.last[0].id, 4); // 1..3 dropped
  assert.equal(ENG.next.length, 5);
  assert.equal(ENG.next[0].result, null);
  assert.equal("finished" in ENG.last[0], false); // internal flag stripped
});

test("buildTeamEvents: unfinished entries never land in last; past-dated stale fixtures never in next", () => {
  const { IRE } = buildTeamEvents(
    { IRE: { lastEvents: [ev(1, "2026-05-01T00:00:00Z", "Ireland", "Portugal", null, null)],
             nextEvents: [ev(2, "2026-05-02T00:00:00Z", "Ireland", "Portugal", null, null)] } },
    NOW,
  );
  assert.deepEqual(IRE, { last: [], next: [] });
});

test("normalizeEvent: plain-number scores and ISO date fields also parse", () => {
  const e = {
    id: 9, date: "2026-06-01T00:00:00Z", tournament: { name: "Tour" },
    homeTeam: { name: "Wales" }, awayTeam: { name: "Fiji" },
    homeScore: 12, awayScore: 15, status: { type: "finished" },
  };
  const n = normalizeEvent(e, "WAL");
  assert.equal(n.us, 12);
  assert.equal(n.them, 15);
  assert.equal(n.result, "L");
  assert.equal(n.date, "2026-06-01T00:00:00Z");
});
