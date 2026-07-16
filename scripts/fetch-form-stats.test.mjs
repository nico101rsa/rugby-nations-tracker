import { test } from "node:test";
import assert from "node:assert/strict";
import { extractEspnStats, ncStatsByEventId, enrichLast } from "./fetch-form-stats.mjs";

const espnStats = (tries, penaltyTries, yellow, red) => ({
  splits: {
    categories: [
      { stats: [{ name: "tries", value: tries }, { name: "penaltyTries", value: penaltyTries }] },
      { stats: [{ name: "yellowCards", value: yellow }, { name: "redCards", value: red }, { name: "points", value: 99 }] },
    ],
  },
});

test("extractEspnStats: tries include penalty tries; cards = yellow + red", () => {
  assert.deepEqual(extractEspnStats(espnStats(6, 1, 2, 1)), { tries: 7, cards: 3 });
  assert.deepEqual(extractEspnStats(espnStats(0, 0, 0, 0)), { tries: 0, cards: 0 });
});

test("extractEspnStats: missing stat names -> null (never fabricate a zero)", () => {
  assert.deepEqual(extractEspnStats({ splits: { categories: [] } }), { tries: null, cards: null });
});

const STATS_JSON = {
  matches: [
    {
      id: 53213, eventId: 16098042, date: "2026-07-04T07:10:00+00:00", reconciled: true,
      home: { id: 465, name: "New Zealand", score: 34 }, away: { id: 387, name: "France", score: 32 },
      scoring: [
        { min: 2, team: "away", type: "try", player: "A" },
        { min: 8, team: "home", type: "try", player: "B" },
        { min: 9, team: "home", type: "conversion", player: "B" },
        { min: 21, team: "home", type: "try", player: "C" },
      ],
      cards: [{ min: 2, team: "home", type: "yellow", player: "D" }],
    },
    // unreconciled stub: scoring can't be trusted -> no entry
    { id: 1, eventId: 999, date: "2026-07-04T09:00:00+00:00", reconciled: false, home: { name: "X" }, away: { name: "Y" }, scoring: [], cards: [] },
  ],
};

test("ncStatsByEventId: per-side tries + cards keyed by the vendor event id; unreconciled skipped", () => {
  const map = ncStatsByEventId(STATS_JSON);
  assert.deepEqual(map.get(16098042), {
    home: { tries: 2, cards: 1 },
    away: { tries: 1, cards: 0 },
  });
  assert.equal(map.has(999), false);
});

test("enrichLast: NC games enrich from stats.json by event id + homeAway; others from ESPN by day; unmatched stay null", () => {
  const teams = {
    NZL: {
      last: [
        { id: 16098042, date: "2026-07-04T07:10:00.000Z", homeAway: "H", tracked: true }, // NC, we were home
        { id: 14321531, date: "2025-09-06T07:05:00.000Z", homeAway: "H", tracked: true }, // TRC, ESPN
        { id: 5, date: "2025-11-01T00:00:00.000Z", homeAway: "A", tracked: true },        // no source
      ],
      next: [],
    },
  };
  const espnByCodeDay = { NZL: new Map([["2025-09-06", { tries: 3, cards: 2 }]]) };
  enrichLast(teams, ncStatsByEventId(STATS_JSON), espnByCodeDay);
  assert.equal(teams.NZL.last[0].tries, 2);
  assert.equal(teams.NZL.last[0].cards, 1);
  assert.equal(teams.NZL.last[1].tries, 3);
  assert.equal(teams.NZL.last[1].cards, 2);
  assert.equal(teams.NZL.last[2].tries, null);
  assert.equal(teams.NZL.last[2].cards, null);
});
