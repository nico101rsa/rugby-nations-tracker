import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { reconciledTries, checkTries, worthRaising, correctionLine, issueFor } from "./try-counts.mjs";
import { computeLog } from "./fetch-nations.mjs";

const ev = (team, type) => ({ team, type });
const match = (id, home, away, scoring, reconciled = true) => ({
  id, date: "2026-07-18T13:10:00+00:00", home: { name: home }, away: { name: away }, reconciled, scoring,
});
// Fiji 17-33 Scotland as stats.json holds it: 3 tries v 5.
const FIJ_SCO = match(53228, "Fiji", "Scotland", [
  ev("home", "try"), ev("home", "try"), ev("home", "try"), ev("home", "conversion"),
  ev("away", "try"), ev("away", "conversion"), ev("away", "try"), ev("away", "conversion"),
  ev("away", "try"), ev("away", "conversion"), ev("away", "try"), ev("away", "conversion"), ev("away", "try"),
]);

test("reconciledTries counts tries and penalty tries of reconciled matches only", () => {
  const stats = { matches: [
    FIJ_SCO,
    match(2, "France", "Fiji", [ev("home", "try"), ev("home", "penaltyTry"), ev("home", "penalty"), ev("away", "dropGoal")]),
    match(3, "Wales", "Japan", [ev("home", "try")], false),
    { id: 4, reconciled: true }, // no scoring list: nothing to count from
  ] };
  assert.deepEqual(reconciledTries(stats), { 53228: { home: 3, away: 5 }, 2: { home: 2, away: 0 } });
  assert.deepEqual(reconciledTries(null), {});
});

test("checkTries: the 13 Nov 2026 defect. The box score's 5 replaces the cache's 3 and is flagged as moving a bonus point", () => {
  const cache = { 53228: { home: 3, away: 3 }, 9: { home: 1, away: 1 } };
  const { cache: next, corrections } = checkTries(cache, { matches: [FIJ_SCO] });
  assert.deepEqual(next, { 53228: { home: 3, away: 5 }, 9: { home: 1, away: 1 } });
  assert.deepEqual(cache[53228], { home: 3, away: 3 }, "input not mutated");
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].bonusMoved, true);
  assert.match(correctionLine(corrections[0]), /Fiji v Scotland \(2026-07-18\), game 53228: cache 3-3, box score 3-5 \(moves a try bonus point\)/);
  assert.equal(worthRaising(corrections).length, 1);
  assert.match(issueFor(corrections).title, /Fiji v Scotland/);
});

test("checkTries: a count that changes on the same side of four is corrected and not raised", () => {
  const stats = { matches: [match(1, "France", "Fiji", [...Array(8).fill(ev("home", "try")), ev("away", "try"), ev("away", "try")])] };
  const { cache, corrections } = checkTries({ 1: { home: 7, away: 2 } }, stats);
  assert.deepEqual(cache, { 1: { home: 8, away: 2 } });
  assert.equal(corrections[0].bonusMoved, false);
  assert.deepEqual(worthRaising(corrections), []);
});

test("checkTries: agreement returns the same cache; an unreconciled match keeps the first read", () => {
  const cache = { 53228: { home: 3, away: 5 }, 3: { home: 0, away: 0 } };
  const out = checkTries(cache, { matches: [FIJ_SCO, match(3, "Wales", "Japan", [ev("home", "try")], false)] });
  assert.equal(out.cache, cache);
  assert.deepEqual(out.corrections, []);
  assert.equal(checkTries(cache, null).cache, cache);
});

test("checkTries: a game the cache never had is filled, and filling a gap is not raised", () => {
  const { cache, corrections } = checkTries({}, { matches: [FIJ_SCO] });
  assert.deepEqual(cache, { 53228: { home: 3, away: 5 } });
  assert.equal(corrections[0].was, null);
  assert.equal(corrections[0].bonusMoved, true);
  assert.deepEqual(worthRaising(corrections), []);
});

test("the table: Scotland's bonus point arrives with the checked count", () => {
  const g = { id: 53228, teams: { home: { id: 28, name: "Fiji" }, away: { id: 390, name: "Scotland" } }, scores: { home: 17, away: 33 } };
  const sco = (tries) => computeLog([g], tries).find((r) => r.id === 390);
  assert.equal(sco({ 53228: { home: 3, away: 3 } }).Pts, 4);
  assert.equal(sco(checkTries({ 53228: { home: 3, away: 3 } }, { matches: [FIJ_SCO] }).cache).Pts, 5);
});

test("refresh-data runs the check before it builds standings, and may file the issue", async () => {
  const yml = await readFile(new URL("../.github/workflows/refresh-data.yml", import.meta.url), "utf8");
  const check = yml.indexOf("node scripts/try-counts.mjs");
  assert.ok(check > 0, "the check step is there");
  assert.ok(check < yml.indexOf("node scripts/build-standings.mjs"), "and runs before build-standings");
  assert.match(yml, /issues: write/);
});

// ---- summaryTries: every competition's first read ----------------------------
{
  const { summaryTries, countTries } = await import("./try-counts.mjs");
  const det = (type, team, hs, as) => ({ type: { text: type }, team: { id: team }, ...(hs == null ? {} : { homeScore: hs, awayScore: as }) });
  const comp = (details) => ({
    competitors: [{ id: "3", homeAway: "home", team: { id: "3" } }, { id: "1", homeAway: "away", team: { id: "1" } }],
    details,
  });
  // Home 12 (a converted try and a try), away 3.
  const ROWS = [det("Try", "3"), det("Conversion", "3"), det("Try", "3"), det("Penalty Goal", "1"), det("Yellow Card", "1")];

  test("summaryTries: rows that sum to the final score are checked", () => {
    assert.deepEqual(summaryTries(comp(ROWS), 12, 3), { counts: { home: 2, away: 0 }, checked: true });
  });

  test("summaryTries: rows short of the score give the labelled count, unchecked", () => {
    assert.deepEqual(summaryTries(comp(ROWS), 17, 3), { counts: { home: 2, away: 0 }, checked: false });
    assert.deepEqual(summaryTries(comp(ROWS), null, null), { counts: { home: 2, away: 0 }, checked: false }, "no score to check against");
  });

  test("summaryTries: a penalty try ESPN keeps in the running score and leaves out of the rows is counted (France v Fiji, 7 Nov 2026)", () => {
    // Home: try 5-0, then the score steps to 12-0 on a card row with no scoring row, then a penalty 15-0.
    const rows = [det("Try", "3", 5, 0), det("Yellow Card", "1", 12, 0), det("Penalty Goal", "3", 15, 0)];
    assert.deepEqual(countTries(rows, "3"), { home: 1, away: 0 }, "the labelled rows miss it");
    assert.deepEqual(summaryTries(comp(rows), 15, 0), { counts: { home: 2, away: 0 }, checked: true });
  });

  test("summaryTries: no rows, or no competitors, is null (the caller falls back or waits)", () => {
    assert.equal(summaryTries(comp([]), 12, 3), null);
    assert.equal(summaryTries({ details: ROWS }, 12, 3), null);
  });
}
