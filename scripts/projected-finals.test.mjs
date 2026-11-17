import { test } from "node:test";
import assert from "node:assert/strict";
import { projectedFinals, rncComp, withoutPartialFinals, API_SPORTS_CODES, FINALS_BY_SEASON, FINALS_VENUE } from "./projected-finals.mjs";
import { TEAMS } from "./generate-digests.mjs";

const COMP = { key: "rnc-2026", label: "RNC '26", kind: "competition" };
// A log ranked overall, three rounds in: South Africa, Ireland, France, New Zealand, ...
const row = (id, team, rank, P = 3) => ({ rank, id, team, P, W: P, D: 0, L: 0, Pts: P * 5 });
const LOG = [
  row(467, "South Africa", 1), row(388, "Ireland", 2), row(387, "France", 3), row(465, "New Zealand", 4),
  row(386, "England", 5), row(460, "Argentina", 6), row(390, "Scotland", 7), row(461, "Australia", 8),
  row(389, "Italy", 9), row(463, "Japan", 10), row(391, "Wales", 11), row(28, "Fiji", 12),
];
const poolRow = (id, date, home, away) => ({ id, date, timeTBC: false, home: { code: home, name: home, tracked: true }, away: { code: away, name: away, tracked: true }, comp: COMP, round: "4" });

test("API_SPORTS_CODES is the digests' team table", () => {
  for (const [id, t] of Object.entries(TEAMS)) assert.equal(API_SPORTS_CODES[id], t.code, `team ${id}`);
  assert.equal(Object.keys(API_SPORTS_CODES).length, Object.keys(TEAMS).length);
});

test("projectedFinals: equal conference ranks meet, title game first in rank, projected until six rounds are played", () => {
  const rows = projectedFinals([poolRow("espn-1", "2026-11-06T20:10:00.000Z", "IRE", "ARG")], LOG);
  assert.equal(rows.length, 6);
  const grand = rows.find((r) => r.final.rank === 1);
  assert.deepEqual(grand.home, { code: "IRE", name: "Ireland", tracked: true }, "North 1 is Ireland");
  assert.deepEqual(grand.away, { code: "RSA", name: "South Africa", tracked: true }, "South 1 is South Africa");
  assert.equal(grand.id, "rnc-2026-final-1");
  assert.equal(grand.date, "2026-11-29T16:40:00.000Z");
  assert.deepEqual(grand.final, { label: "Grand final", rank: 1, title: true, projected: true });
  assert.equal(grand.venue, FINALS_VENUE);
  assert.deepEqual(grand.comp, COMP);
  assert.equal(grand.timeTBC, false);
  const eleventh = rows.find((r) => r.final.rank === 6);
  assert.equal(eleventh.home.code, "WAL");
  assert.equal(eleventh.away.code, "FIJ");
  assert.equal(eleventh.final.label, "11th-place final");
  // Six rounds played on every row: the pairings are locked and say so.
  const locked = projectedFinals([poolRow("espn-1", "2026-11-06T20:10:00.000Z", "IRE", "ARG")], LOG.map((r) => ({ ...r, P: 6 })));
  assert.ok(locked.every((r) => r.final.projected === false));
});

test("projectedFinals: no rnc row in the file (the 23-27 Nov gap) still projects from the registry's comp tag", () => {
  const rows = projectedFinals([], LOG, { comp: COMP });
  assert.equal(rows.length, 6);
  assert.equal(rows[0].comp.key, "rnc-2026");
  assert.equal(projectedFinals([], LOG).length, 0, "no comp tag at all: nothing to file the rows under");
});

// ESPN's six finals as it would list them all: every side a named nation.
const espnFinalRow = (n, date, home, away) => { const f = poolRow(`espn-9${n}`, date, home, away); delete f.round; return f; };
const ESPN_SIX = [
  espnFinalRow(1, "2026-11-29T16:40:00.000Z", "IRE", "NZL"), espnFinalRow(2, "2026-11-28T16:40:00.000Z", "FRA", "RSA"),
  espnFinalRow(3, "2026-11-27T20:10:00.000Z", "ENG", "ARG"), espnFinalRow(4, "2026-11-29T13:10:00.000Z", "SCO", "AUS"),
  espnFinalRow(5, "2026-11-28T13:10:00.000Z", "ITA", "JPN"), espnFinalRow(6, "2026-11-27T16:40:00.000Z", "WAL", "FIJ"),
];
// What ESPN published on Tue 17 Nov 2026: one final, one side unnamed.
const ITA_TBC = { id: "espn-604011", date: "2026-11-27T16:40:00.000Z", timeTBC: false, home: { code: "ITA", name: "Italy", tracked: true }, away: { code: "TBC", name: "TBC", tracked: false }, comp: COMP, venue: "Allianz Stadium, London" };

test("projectedFinals: stands down once ESPN lists the whole weekend; its own rows never count", () => {
  assert.equal(projectedFinals(ESPN_SIX, LOG).length, 0);
  const own = projectedFinals([], LOG, { comp: COMP });
  assert.equal(projectedFinals(own, LOG).length, 6, "a previous build's projected rows do not stand the projection down");
  // A pool row on the Sunday before the weekend is not a finals row.
  assert.equal(projectedFinals([poolRow("espn-8", "2026-11-21T20:10:00.000Z", "WAL", "AUS")], LOG).length, 6);
});

test("a partial ESPN listing does not stand the projection down (17 Nov 2026: Italy v TBC, and five finals gone)", () => {
  assert.equal(projectedFinals([ITA_TBC], LOG).length, 6, "one final against nobody");
  assert.equal(projectedFinals(ESPN_SIX.slice(0, 5), LOG).length, 6, "five of six");
  assert.equal(projectedFinals([...ESPN_SIX.slice(0, 5), ITA_TBC], LOG).length, 6, "six rows, one side unnamed");
  // The partial rows leave the published list; pool rows and other competitions stay.
  const pool = poolRow("espn-8", "2026-11-21T20:10:00.000Z", "WAL", "AUS");
  const other = { ...poolRow("espn-7", "2026-11-28T10:00:00.000Z", "NZL", "AUS"), comp: { key: "test", label: "TEST", kind: "test" } };
  assert.deepEqual(withoutPartialFinals([pool, ITA_TBC, other]), [pool, other]);
  assert.deepEqual(withoutPartialFinals([pool, ...ESPN_SIX]), [pool, ...ESPN_SIX], "a whole listing is ESPN's to tell");
  assert.deepEqual(withoutPartialFinals([pool]), [pool]);
});

test("repairedFinals: a file holding ESPN's partial listing gets the six pairings back and loses the TBC row", () => {
  const pool = poolRow("espn-8", "2026-11-21T20:10:00.000Z", "WAL", "AUS");
  const next = repairedFinals([pool, ITA_TBC], LOG);
  assert.equal(next.length, 7);
  assert.ok(!next.includes(ITA_TBC));
  assert.equal(next.filter((f) => f.final).length, 6);
  assert.equal(repairedFinals(next, LOG), null, "then quiet");
  // The row coming back on a later fixtures build is dropped again, pairings unchanged.
  const again = repairedFinals([...next, ITA_TBC], LOG);
  assert.equal(again.length, 7);
  assert.ok(!again.includes(ITA_TBC));
});


import { repairedFinals } from "./projected-finals.mjs";
import { syncProjectedFinals } from "./build-fixtures.mjs";
import { refreshWithFinals } from "./refresh.mjs";

const POOL = poolRow("espn-1", "2026-11-21T16:40:00.000Z", "IRE", "RSA");
// The same table after New Zealand go above South Africa (Sat 14 Nov 2026).
const NZ_TOP = [LOG[3], ...LOG.filter((r) => r.id !== 465)].map((r, i) => ({ ...r, rank: i + 1 }));
const codes = (rows, rank) => { const f = rows.find((r) => r.final?.rank === rank); return `${f.home.code}-${f.away.code}`; };

test("repairedFinals: a result that reorders a conference re-pairs the finals; an unchanged table writes nothing", () => {
  const file = [POOL, ...projectedFinals([POOL], LOG)];
  assert.equal(codes(file, 1), "IRE-RSA");
  assert.equal(repairedFinals(file, LOG), null, "same table: nothing to write");
  const next = repairedFinals(file, NZ_TOP);
  assert.equal(next.length, 7, "the pool row stays, six finals replace six");
  assert.equal(codes(next, 1), "IRE-NZL");
  assert.equal(codes(next, 2), "FRA-RSA");
  assert.equal(repairedFinals(next, NZ_TOP), null);
});

test("repairedFinals: locks when round six is done, with no pool row left in the file, and stays locked", () => {
  const file = projectedFinals([], LOG, { comp: COMP });
  const done = NZ_TOP.map((r) => ({ ...r, P: 6 }));
  const locked = repairedFinals(file, done);
  assert.equal(locked.length, 6);
  assert.ok(locked.every((r) => r.final.projected === false));
  assert.equal(codes(locked, 1), "IRE-NZL");
  assert.equal(repairedFinals(locked, done), null, "a locked row of ours does not stand the projection down");
});

test("repairedFinals: ESPN's whole listing drops our rows; a log that cannot be read keeps them", () => {
  const own = projectedFinals([], LOG, { comp: COMP });
  assert.deepEqual(repairedFinals([...ESPN_SIX, ...own], NZ_TOP), ESPN_SIX);
  assert.equal(repairedFinals(own, []), null);
  assert.equal(repairedFinals(own, undefined), null);
  assert.equal(repairedFinals(own, LOG.slice(0, 11)), null);
  assert.equal(repairedFinals([POOL], []), null, "nothing to project, nothing to drop");
});

test("syncProjectedFinals: publishes only when a pairing moved", async () => {
  const file = { updatedAt: "x", source: "espn", fixtures: [POOL, ...projectedFinals([POOL], LOG)] };
  const run = async (log) => {
    const published = [];
    const wrote = await syncProjectedFinals({
      read: async (path) => JSON.stringify(path === "fixtures.json" ? file : { log }),
      publish: async (rows) => { published.push(rows); },
      log: () => {},
    });
    return { wrote, published };
  };
  assert.deepEqual(await run(LOG), { wrote: false, published: [] });
  const moved = await run(NZ_TOP);
  assert.equal(moved.wrote, true);
  assert.equal(codes(moved.published[0], 1), "IRE-NZL");
});

test("refreshWithFinals: re-pairs after the refresh, and a failed re-pair never costs the refresh", async () => {
  const order = [];
  const result = await refreshWithFinals({ dates: ["2026-11-14"] }, {
    doRefresh: async (a) => { order.push(`refresh ${a.dates}`); return { remaining: 50 }; },
    sync: async () => { order.push("sync"); },
  });
  assert.deepEqual(order, ["refresh 2026-11-14", "sync"]);
  assert.deepEqual(result, { remaining: 50 });
  const warn = console.warn; console.warn = () => {};
  try {
    assert.deepEqual(await refreshWithFinals({}, { doRefresh: async () => ({ remaining: 9 }), sync: async () => { throw new Error("no file"); } }), { remaining: 9 });
  } finally { console.warn = warn; }
});
