import { test } from "node:test";
import assert from "node:assert/strict";
import { projectedFinals, rncComp, API_SPORTS_CODES, FINALS_BY_SEASON, FINALS_VENUE } from "./projected-finals.mjs";
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

test("projectedFinals: stands down the moment ESPN lists a finals-weekend row; its own rows never count", () => {
  const espnFinal = poolRow("espn-9", "2026-11-28T16:40:00.000Z", "IRE", "RSA");
  delete espnFinal.round;
  assert.equal(projectedFinals([espnFinal], LOG).length, 0);
  const own = projectedFinals([], LOG, { comp: COMP });
  assert.equal(projectedFinals(own, LOG).length, 6, "a previous build's projected rows do not stand the projection down");
  // A pool row on the Sunday before the weekend is not a finals row.
  assert.equal(projectedFinals([poolRow("espn-8", "2026-11-21T20:10:00.000Z", "WAL", "AUS")], LOG).length, 6);
});

test("projectedFinals: needs a full log and a season it knows", () => {
  assert.equal(projectedFinals([], LOG.slice(0, 11), { comp: COMP }).length, 0);
  assert.equal(projectedFinals([], null, { comp: COMP }).length, 0);
  assert.equal(projectedFinals([], LOG, { comp: { key: "rnc-2028", label: "RNC '28", kind: "competition" } }).length, 0, "no kick-off table for 2028 yet");
  assert.equal(FINALS_BY_SEASON[2026].length, 6);
});

test("rncComp: the registry's current Nations Championship as a comp tag; an expired one is not", () => {
  const registry = { competitions: [
    { key: "6n-2027", label: "6N '27", name: "Six Nations" },
    { key: "rnc-2026", label: "RNC '26", name: "Nations Championship", defaultUntil: "2026-12-13" },
  ] };
  assert.deepEqual(rncComp(registry, "2026-11-24"), COMP);
  assert.equal(rncComp(registry, "2026-12-13"), null);
  assert.equal(rncComp({ competitions: [] }, "2026-11-24"), null);
});

// ---- repairedFinals: the rows follow the table between fixtures builds ----
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

test("repairedFinals: ESPN's listing drops our rows; a log that cannot be read keeps them", () => {
  const own = projectedFinals([], LOG, { comp: COMP });
  const espnFinal = poolRow("espn-9", "2026-11-28T16:40:00.000Z", "IRE", "NZL");
  assert.deepEqual(repairedFinals([espnFinal, ...own], NZ_TOP), [espnFinal]);
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
