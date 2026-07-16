import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeArchive } from "./archive-team-events.mjs";

const g = (id, date, opponent, extra = {}) => ({
  id, date, league: "Test", opponent, opponentCode: null, tracked: false,
  homeAway: "H", us: 30, them: 10, result: "W", tries: 4, cards: 1, ...extra,
});

test("mergeArchive: new games append under their team code, keyed by game id", () => {
  const archive = { games: { RSA: {} } };
  const teams = { RSA: { last: [g(1, "2026-07-04T07:00:00Z", "England")], next: [] } };
  const { merged, added } = mergeArchive(archive, teams, "2026-07-16T00:00:00Z");
  assert.equal(added, 1);
  assert.equal(merged.games.RSA["1"].opponent, "England");
  assert.equal(merged.games.RSA["1"].tries, 4);
  assert.equal(merged.updatedAt, "2026-07-16T00:00:00Z");
});

test("mergeArchive: existing games are updated in place (late stats enrichment), not duplicated", () => {
  const archive = { games: { RSA: { "1": g(1, "2026-07-04T07:00:00Z", "England", { tries: null, cards: null }) } } };
  const teams = { RSA: { last: [g(1, "2026-07-04T07:00:00Z", "England", { tries: 7, cards: 1 })], next: [] } };
  const { merged, added } = mergeArchive(archive, teams, "x");
  assert.equal(added, 0);
  assert.equal(Object.keys(merged.games.RSA).length, 1);
  assert.equal(merged.games.RSA["1"].tries, 7);
});

test("mergeArchive: an already-enriched archived game is NOT clobbered by a null re-fetch", () => {
  const archive = { games: { RSA: { "1": g(1, "2026-07-04T07:00:00Z", "England", { tries: 7, cards: 1 }) } } };
  const teams = { RSA: { last: [g(1, "2026-07-04T07:00:00Z", "England", { tries: null, cards: null })], next: [] } };
  const { merged } = mergeArchive(archive, teams, "x");
  assert.equal(merged.games.RSA["1"].tries, 7);
  assert.equal(merged.games.RSA["1"].cards, 1);
});

test("mergeArchive: empty archive bootstrap; next fixtures are ignored (results only)", () => {
  const teams = { NZL: { last: [g(2, "2026-07-11T07:00:00Z", "France")], next: [g(3, "2026-07-18T07:00:00Z", "Ireland")] } };
  const { merged, added } = mergeArchive(null, teams, "x");
  assert.equal(added, 1);
  assert.equal(merged.games.NZL["3"], undefined);
});
