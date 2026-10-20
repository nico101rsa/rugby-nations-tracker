import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exchange, tableComplete, rankAfter, stakesFor, rankTrajectory, describeMove, renderStakes, renderTrajectory, ordinal,
} from "./rankings-stakes.mjs";

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.006, `${msg}: ${a} vs ${b}`);

// Five real weeks from rankings.json's history, every game between app
// nations in the app's own records. The published tables moved by exactly
// these amounts (two decimals), with no home advantage anywhere in them.
test("exchange reproduces the 2026 tables: no home advantage, x1.5 over 15", () => {
  // 5→12 Oct: NZL 50-19 AUS, NZL home. 91.15 / 85.55 → +0.66 / −0.66
  near(exchange({ a: 91.15, b: 85.55, result: "W", margin: 31 }), 0.66, "stronger side wins big");
  // 12→19 Oct: AUS 21-43 NZL, AUS home. 84.89 / 91.81 → −0.46 / +0.46
  near(exchange({ a: 84.89, b: 91.81, result: "L", margin: 22 }), -0.46, "weaker host loses big");
  // 14→28 Sep: JPN 20-15 FIJ. 76.09 / 78.00 → +1.19 / −1.19
  near(exchange({ a: 76.09, b: 78.0, result: "W", margin: 5 }), 1.19, "weaker side wins");
  // 14→28 Sep: AUS 42-38 RSA, AUS home. 83.55 / 95.09 → +2.00 (gap capped at 10)
  near(exchange({ a: 83.55, b: 95.09, result: "W", margin: 4 }), 2.0, "gap cap");
  // 31 Aug→7 Sep: ARG 28-28 AUS. 82.08 / 83.71 → +0.16 / −0.16
  near(exchange({ a: 82.08, b: 83.71, result: "D" }), 0.163, "draw favours the weaker side");
  near(exchange({ a: 83.71, b: 82.08, result: "D" }), -0.163, "draw costs the stronger side");
  // 13→20 Jul, hosts at home: NZL 40-21 IRE (91.04/89.32 → +1.24), ARG 24-31 ENG (84.06/84.75 → −0.93)
  near(exchange({ a: 91.04, b: 89.32, result: "W", margin: 19 }), 1.242, "July: NZ v Ireland");
  near(exchange({ a: 84.06, b: 84.75, result: "L", margin: 7 }), -0.931, "July: Argentina v England");
  // With a +3 home weighting the same week would read 0.79 and -1.23 — the published table says otherwise.
  near(exchange({ a: 91.04 + 3, b: 89.32, result: "W", margin: 19 }), 0.792, "the home-advantage variant, for the record");
});

test("exchange: world cup doubles, equal ratings swap exactly 1 (or 0 for a draw)", () => {
  near(exchange({ a: 80, b: 80, result: "W" }), 1, "equal win");
  near(exchange({ a: 80, b: 80, result: "D" }), 0, "equal draw");
  near(exchange({ a: 80, b: 80, result: "W", worldCup: true }), 2, "world cup");
  near(exchange({ a: 80, b: 80, result: "W", margin: 16, worldCup: true }), 3, "world cup big win");
  assert.throws(() => exchange({ a: 1, b: 2, result: "X" }));
});

const TABLE = {
  RSA: { rank: 1, points: 93.09 }, NZL: { rank: 2, points: 92.27 }, IRE: { rank: 3, points: 88.08 },
  FRA: { rank: 4, points: 87.43 }, ENG: { rank: 5, points: 85.68 }, SCO: { rank: 6, points: 84.78 },
  AUS: { rank: 7, points: 84.43 }, ARG: { rank: 8, points: 82.24 }, JPN: { rank: 9, points: 77.28 },
  FIJ: { rank: 10, points: 76.81 }, WAL: { rank: 11, points: 76.38 }, ITA: { rank: 12, points: 76.3 },
};
const NAMES = { JPN: "Japan", FIJ: "Fiji", WAL: "Wales", ITA: "Italy" };

test("tableComplete: ranks 1..N with no gap", () => {
  assert.equal(tableComplete(TABLE), true);
  assert.equal(tableComplete({ ...TABLE, ITA: { rank: 13, points: 76.3 } }), false);
  assert.equal(tableComplete({}), false);
});

test("rankAfter: exact at or above the floor, a best case below it", () => {
  const up = rankAfter(TABLE, { code: "FIJ", points: 77.86, other: "JPN", otherPoints: 76.23 });
  assert.deepEqual(up, { rank: 9, exact: true, passed: ["JPN"], passedBy: [] });
  const down = rankAfter(TABLE, { code: "JPN", points: 76.23, other: "FIJ", otherPoints: 77.86 });
  assert.equal(down.exact, false, "below Italy's 76.30 the rank is a best case");
  assert.equal(down.rank, 12);
  assert.deepEqual(down.passedBy, ["FIJ", "WAL", "ITA"]);
  const stay = rankAfter(TABLE, { code: "JPN", points: 78.23, other: "FIJ", otherPoints: 75.86 });
  assert.deepEqual(stay, { rank: 9, exact: true, passed: [], passedBy: [] });
  // an incomplete table (an untracked nation inside the top twelve) settles no rank, only who passes whom
  const gappy = { ...TABLE, ITA: { rank: 13, points: 76.3 } };
  const g = rankAfter(gappy, { code: "FIJ", points: 77.86, other: "JPN", otherPoints: 76.23 });
  assert.deepEqual(g, { rank: null, exact: false, passed: ["JPN"], passedBy: [] });
  assert.equal(describeMove(10, g, NAMES), "above Japan");
  assert.equal(describeMove(9, { rank: null, exact: false, passed: [], passedBy: ["FIJ"] }, NAMES), "below Fiji");
  assert.equal(describeMove(9, { rank: null, exact: false, passed: [], passedBy: [] }), "order unchanged");
});

test("stakesFor: Japan v Fiji, 19 Oct 2026 table", () => {
  const s = stakesFor({ asOf: "19 October 2026", rankings: TABLE }, "JPN", "FIJ");
  assert.equal(s.complete, true);
  assert.deepEqual(s.scenarios.map((x) => x.key), ["home-win-big", "home-win", "draw", "away-win", "away-win-big"]);
  const homeWin = s.scenarios.find((x) => x.key === "home-win");
  assert.deepEqual([homeWin.home.points, homeWin.home.delta, homeWin.home.rank, homeWin.home.exact], [78.23, 0.95, 9, true]);
  assert.deepEqual([homeWin.away.points, homeWin.away.delta, homeWin.away.rank, homeWin.away.exact], [75.86, -0.95, 12, false]);
  const awayWin = s.scenarios.find((x) => x.key === "away-win");
  assert.deepEqual([awayWin.away.points, awayWin.away.rank, awayWin.away.exact, awayWin.away.passed], [77.86, 9, true, ["JPN"]]);
  assert.deepEqual([awayWin.home.points, awayWin.home.rank, awayWin.home.exact], [76.23, 12, false]);
  const draw = s.scenarios.find((x) => x.key === "draw");
  assert.deepEqual([draw.home.delta, draw.away.delta, draw.home.rank, draw.away.rank], [-0.05, 0.05, 9, 10]);
  assert.equal(stakesFor({ rankings: TABLE }, "JPN", "USA"), null, "an untracked side has no row");
});

test("renderStakes and describeMove read as the writer will see them", () => {
  const s = stakesFor({ asOf: "19 October 2026", rankings: TABLE }, "JPN", "FIJ");
  const lines = renderStakes(s, NAMES);
  assert.equal(lines.length, 5);
  assert.equal(lines[1], "- Japan win by 15 or fewer: Japan +0.95 to 78.23 (stay 9th); Fiji −0.95 to 75.86 (below Wales and Italy; 12th at best).");
  assert.equal(lines[3], "- Fiji win by 15 or fewer: Fiji +1.05 to 77.86 (up to 9th, above Japan); Japan −1.05 to 76.23 (below Fiji, Wales and Italy; 12th at best).");
  assert.match(lines[2], /^- Draw: Japan −0\.05 to 77\.23 \(stay 9th\); Fiji \+0\.05 to 76\.86 \(stay 10th\)\.$/);
  assert.equal(describeMove(9, { rank: 11, exact: true, passed: [], passedBy: ["FIJ", "WAL"] }, NAMES), "down to 11th, below Fiji and Wales");
  assert.deepEqual(renderStakes(null), []);
});

test("rankTrajectory: since when, what before, the range; rendered", () => {
  const rankings = {
    asOf: "19 October 2026",
    rankings: { JPN: { rank: 9, points: 77.28, move: 0 }, SCO: { rank: 6, points: 84.78, move: 1 } },
    history: [
      { asOf: "13 July 2026", rankings: { JPN: { rank: 11, points: 76.42 }, SCO: { rank: 6, points: 84.09 } } },
      { asOf: "14 September 2026", rankings: { JPN: { rank: 12, points: 76.09 }, SCO: { rank: 6, points: 84.78 } } },
      { asOf: "28 September 2026", rankings: { JPN: { rank: 9, points: 77.28 }, SCO: { rank: 7, points: 84.78 } } },
      { asOf: "12 October 2026", rankings: { JPN: { rank: 9, points: 77.28 }, SCO: { rank: 7, points: 84.78 } } },
    ],
  };
  const j = rankTrajectory(rankings, "JPN");
  assert.deepEqual(j, { rank: 9, points: 77.28, move: 0, since: "28 September 2026", previous: { rank: 12, asOf: "14 September 2026" }, best: 9, worst: 12, firstAsOf: "13 July 2026", snapshots: 5 });
  assert.equal(renderTrajectory(j), "9th (77.28 pts), 9th since 28 September 2026 (12th before that), range since 13 July 2026: 9th–12th");
  const s = rankTrajectory(rankings, "SCO");
  assert.equal(renderTrajectory(s), "6th (84.78 pts), up 1 this week, 6th since 19 October 2026 (7th before that), range since 13 July 2026: 6th–7th");
  assert.equal(rankTrajectory(rankings, "USA"), null);
  assert.equal(renderTrajectory(rankTrajectory({ asOf: "x", rankings: { JPN: { rank: 9, points: 77.28 } } }, "JPN")), "9th (77.28 pts)");
  assert.equal(ordinal(12), "12th");
  assert.equal(ordinal(22), "22nd");
});
