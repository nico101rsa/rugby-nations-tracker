import { test } from "node:test";
import assert from "node:assert/strict";
import { teamsDue, mergeRefreshed } from "./refresh-played-teams.mjs";

const NOW = new Date("2026-08-15T10:24:00Z").getTime(); // the screenshot moment
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
const fixture = (date, extra = {}) => ({
  id: 1, date, opponent: "Japan", opponentCode: "JPN", tracked: true,
  homeAway: "H", us: null, them: null, result: null, ...extra,
});

test("teamsDue: the real 2026-08-15 case — AUS v JPN kicked off 05:15Z, unscored in next", () => {
  const teams = {
    AUS: { last: [], next: [fixture("2026-08-15T05:15:00.000Z")] },
    RSA: { last: [], next: [fixture("2026-09-27T09:45:00.000Z")] }, // weeks away
  };
  assert.deepEqual(teamsDue(teams, NOW), ["AUS"]);
});

test("teamsDue: settle and window bounds", () => {
  const due = (hoursAgo) => teamsDue({ AUS: { next: [fixture(at(hoursAgo))] } }, NOW);
  assert.deepEqual(due(1), []); // still playing — under the 150 min settle
  assert.deepEqual(due(2), []); // 120 min, just short
  assert.deepEqual(due(3), ["AUS"]); // finished, publishable
  assert.deepEqual(due(11), ["AUS"]); // inside the 12h window
  assert.deepEqual(due(13), []); // gave up — the full run owns it now
});

test("teamsDue: a fixture that already carries a final is not due", () => {
  const teams = { AUS: { next: [fixture(at(4), { us: 56, them: 17, result: "W" })] } };
  assert.deepEqual(teamsDue(teams, NOW), []);
});

test("teamsDue: a published result clears the team — the catch-up is self-quieting", () => {
  const before = { AUS: { last: [], next: [fixture(at(4))] } };
  assert.deepEqual(teamsDue(before, NOW), ["AUS"]);
  const after = { AUS: { last: [{ id: 1, date: at(4), us: 56, them: 17, result: "W" }], next: [] } };
  assert.deepEqual(teamsDue(after, NOW), []);
});

test("teamsDue: unparseable dates and empty teams are ignored, never thrown on", () => {
  assert.deepEqual(teamsDue({ AUS: { next: [fixture("not a date")] } }, NOW), []);
  assert.deepEqual(teamsDue({ AUS: {} }, NOW), []);
  assert.deepEqual(teamsDue(null, NOW), []);
});

test("teamsDue: capped, most recent kickoff first", () => {
  const teams = {};
  const codes = ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL", "ARG", "AUS", "JPN", "NZL"];
  codes.forEach((c, i) => { teams[c] = { next: [fixture(at(3 + i * 0.5))] }; });
  const due = teamsDue(teams, NOW);
  assert.equal(due.length, 8); // MAX_TEAMS — 16 vendor calls, not 20
  assert.equal(due[0], "ENG"); // most recent kickoff
  assert.equal(teamsDue(teams, NOW, 2).length, 2);
});

test("mergeRefreshed: only the refreshed team changes; others are untouched", () => {
  const prev = {
    AUS: { last: [{ id: 1, us: 35, them: 32, tries: null, cards: null }], next: [] },
    RSA: { last: [{ id: 9, us: 20, them: 10, tries: 3, cards: 0 }], next: [] },
  };
  const fresh = { AUS: { last: [{ id: 1, us: 35, them: 32, tries: 5, cards: 1 }, { id: 2, us: 56, them: 17, tries: 8, cards: 0 }], next: [] } };
  const out = mergeRefreshed(prev, fresh);
  assert.equal(out.RSA, prev.RSA); // same reference — byte-identical on disk
  assert.equal(out.AUS.last.length, 2);
  assert.deepEqual(out.AUS.last[1], { id: 2, us: 56, them: 17, tries: 8, cards: 0 });
});

test("mergeRefreshed: a null re-fetch never erases enrichment already on file", () => {
  const prev = { AUS: { last: [{ id: 1, us: 35, them: 32, tries: 4, cards: 1, venue: "Osaka" }], next: [] } };
  const fresh = { AUS: { last: [{ id: 1, us: 35, them: 32, tries: null, cards: null, venue: null }], next: [] } };
  const g = mergeRefreshed(prev, fresh).AUS.last[0];
  assert.equal(g.tries, 4);
  assert.equal(g.cards, 1);
  assert.equal(g.venue, "Osaka");
});

test("mergeRefreshed: fresh non-null values win over stale ones", () => {
  const prev = { AUS: { last: [{ id: 1, us: null, them: null, tries: 4 }], next: [] } };
  const fresh = { AUS: { last: [{ id: 1, us: 56, them: 17, tries: 8 }], next: [] } };
  const g = mergeRefreshed(prev, fresh).AUS.last[0];
  assert.equal(g.us, 56);
  assert.equal(g.tries, 8);
});

test("mergeRefreshed: `next` comes wholly from the fresh build (stale fixtures drop out)", () => {
  const prev = { AUS: { last: [], next: [{ id: 1, date: at(4) }, { id: 2, date: "2026-08-29T19:00Z" }] } };
  const fresh = { AUS: { last: [{ id: 1, date: at(4), us: 56, them: 17 }], next: [{ id: 2, date: "2026-08-29T19:00Z" }] } };
  assert.deepEqual(mergeRefreshed(prev, fresh).AUS.next, [{ id: 2, date: "2026-08-29T19:00Z" }]);
});
