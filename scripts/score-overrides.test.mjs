import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_OVERRIDES, overrideNationsScore, applyNationsScoreOverrides, overrideTeamScore } from "./score-overrides.mjs";
import { applyHostOverrides } from "./host-overrides.mjs";
import { slimGames } from "./fetch-nations.mjs";

const quiet = () => {};

// nations.json results[] for the 11th-place final exactly as published from
// 18:19 UTC on Fri 27 Nov 2026: Italy won 23-21.
const PUBLISHED = {
  id: 56382, date: "2026-11-27T16:40:00+00:00", week: "11th place",
  status: { short: "FT", long: "Finished", live: false },
  home: { id: 389, name: "Italy", logo: "x", score: 21 },
  away: { id: 28, name: "Fiji", logo: "y", score: 23 },
};

test("every row: two teams, both scores by team code, the vendor score differs, a source", () => {
  for (const [key, o] of Object.entries(SCORE_OVERRIDES)) {
    const m = key.match(/^(\d{4}-\d{2}-\d{2}) ([A-Z]{3})-([A-Z]{3})$/);
    assert.ok(m, `${key}: key shape`);
    const codes = [m[2], m[3]].sort();
    assert.deepEqual(Object.keys(o.vendor).sort(), codes, `${key}: vendor by team`);
    assert.deepEqual(Object.keys(o.score).sort(), codes, `${key}: score by team`);
    assert.ok(Object.values(o.score).every(Number.isInteger), `${key}: integer scores`);
    assert.notDeepEqual(o.vendor, o.score, `${key}: a row that changes nothing`);
    assert.ok(o.source, `${key}: source`);
  }
});

test("fix: Italy 23-21 Fiji on the published row", () => {
  const out = overrideNationsScore(PUBLISHED);
  assert.deepEqual([out.home.name, out.home.score, out.away.name, out.away.score], ["Italy", 23, "Fiji", 21]);
  assert.equal(out.id, 56382);
});

test("fix: the same game listed Fiji first is corrected by team, not by side", () => {
  const flipped = { ...PUBLISHED, home: { ...PUBLISHED.away }, away: { ...PUBLISHED.home } };
  const out = overrideNationsScore(flipped);
  assert.deepEqual([out.home.name, out.home.score, out.away.score], ["Fiji", 21, 23]);
});

test("guard: idempotent, and a vendor that corrects or rescores itself wins", () => {
  const once = overrideNationsScore(PUBLISHED);
  assert.equal(overrideNationsScore(once), once);
  const rescored = { ...PUBLISHED, home: { ...PUBLISHED.home, score: 26 } };
  assert.equal(overrideNationsScore(rescored), rescored);
});

test("guard: a game still in play is never touched", () => {
  const live = { ...PUBLISHED, status: { short: "2H", long: "Second Half", live: true } };
  assert.equal(overrideNationsScore(live), live);
});

test("guard: the pool game between the same sides (Udine, 21 Nov, Fiji 21-16) is untouched", () => {
  const pool = { ...PUBLISHED, id: 53246, date: "2026-11-21T16:40:00+00:00", week: "6",
    home: { ...PUBLISHED.home, score: 16 }, away: { ...PUBLISHED.away, score: 21 } };
  const rows = [pool];
  assert.equal(applyNationsScoreOverrides(rows, { log: quiet }), rows);
});

test("wired: slimGames publishes the corrected score from the raw api-sports game", () => {
  const raw = {
    id: 56382, date: "2026-11-27T16:40:00+00:00", week: "11th place",
    status: { short: "FT", long: "Finished" },
    teams: { home: { id: 389, name: "Italy", logo: "x" }, away: { id: 28, name: "Fiji", logo: "y" } },
    scores: { home: 21, away: 23 },
  };
  const lines = [];
  const { results } = slimGames([raw], { log: (l) => lines.push(l) });
  assert.deepEqual([results[0].home.score, results[0].away.score], [23, 21]);
  assert.ok(lines.some((l) => /score override applied: Italy 21-23 Fiji → 23-21/.test(l)));
});

test("wired: team-events rows on both sides through applyHostOverrides, idempotent", () => {
  const row = (opp, us, them, homeAway) => ({
    id: 1, date: "2026-11-27T16:40:00.000Z", league: "Nations Championship", opponent: opp === "FIJ" ? "Fiji" : "Italy",
    opponentCode: opp, tracked: true, homeAway, us, them, result: us > them ? "W" : "L",
  });
  const teams = { ITA: { last: [row("FIJ", 21, 23, "H")], next: [] }, FIJ: { last: [row("ITA", 23, 21, "A")], next: [] } };
  const out = applyHostOverrides(teams, { log: quiet });
  assert.deepEqual([out.ITA.last[0].us, out.ITA.last[0].them, out.ITA.last[0].result], [23, 21, "W"]);
  assert.deepEqual([out.FIJ.last[0].us, out.FIJ.last[0].them, out.FIJ.last[0].result], [21, 23, "L"]);
  const again = applyHostOverrides(out, { log: quiet });
  assert.equal(again.ITA, out.ITA);
  assert.equal(again.FIJ, out.FIJ);
});

test("guard: a team row without a score (a `next` row) is left alone", () => {
  const next = { date: "2026-11-27T16:40:00.000Z", opponentCode: "FIJ", homeAway: "H" };
  assert.equal(overrideTeamScore(next, "ITA"), next);
});

test("wired: an ESPN overlay pass corrects the file even when ESPN moved nothing", async () => {
  const { makeOverlayPass } = await import("./espn-live-overlay.mjs");
  const file = { results: [PUBLISHED], fixtures: [] };
  let written = null;
  const pass = makeOverlayPass({
    path: "x",
    fetchStates: async () => [{ key: "IRE-AUS", date: "2026-11-27T20:10:00Z", home: 38, away: 14, live: false, short: "FT" }],
    read: async () => JSON.stringify(file),
    write: async (_p, text) => { written = JSON.parse(text); },
    log: quiet, warn: quiet,
    keepFinals: () => 0,
  });
  assert.ok((await pass()) > 0);
  const row = written.results.find((r) => r.id === 56382);
  assert.deepEqual([row.home.score, row.away.score], [23, 21]);
});
