import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBestWorst, parseLeaderSpells, leaderStats } from "./fetch-ranking-stats.mjs";

const BEST_WORST = `
|-
| align=left| {{ru|ARG}}
! 3
| 2007–08
! 12
| 2014
|-
|align=left| {{ru|RSA}}
! 1
| 2007–08, 2008, 2009, 2019, 2019–21,<br />2021, 2023
! 7
| 2017, 2018
|-
|align=left| {{ru|GEO}}
! 11
| 2016
! 23
| 2004
|-
|align=left| {{ru|TON}}
! 9
| 2011
! 20
|align=center|2005, 2006, 2026
|-
|align=left| {{nowrap|{{ru|ZIM}}}}
! 24
| 2025
! 57
| 2007
|}`;

test("parseBestWorst: tracked teams only, br-joined years cleaned", () => {
  const out = parseBestWorst(BEST_WORST);
  assert.deepEqual(out.ARG, { best: { rank: 3, years: "2007–08" }, worst: { rank: 12, years: "2014" } });
  assert.equal(out.RSA.best.rank, 1);
  assert.equal(out.RSA.best.years, "2007–08, 2008, 2009, 2019, 2019–21, 2021, 2023");
  assert.equal(out.GEO, undefined);
  assert.equal(out.ZIM, undefined);
});

const TIMELINE = `PlotData=
  from:05/10/2003 till:09/11/2003 shift:(20,-10) text:"[[England national rugby union team|England]]" color:ENG
  from:09/11/2003 till:16/11/2003 shift:(20,-3) text:"[[New Zealand national rugby union team|New Zealand]]" color:NZL
  from:13/06/2004 till:21/10/2007 shift:(20,-3) text:"[[New Zealand national rugby union team|New Zealand]]" color:NZL
  from:04/05/2026 till:end shift:(20,0) text:"[[South Africa national rugby union team|South Africa]]" color:RSA
`;

test("parseLeaderSpells: dates to ISO, $now/end to null, names to codes", () => {
  const spells = parseLeaderSpells(TIMELINE);
  assert.deepEqual(spells[0], { code: "ENG", from: "2003-10-05", till: "2003-11-09" });
  assert.deepEqual(spells[3], { code: "RSA", from: "2026-05-04", till: null });
  assert.equal(spells.length, 4);
});

test("leaderStats: totals, longest stretch, spell count, current streak", () => {
  const now = new Date("2026-07-13T00:00:00Z").getTime();
  const stats = leaderStats(parseLeaderSpells(TIMELINE), now);
  assert.deepEqual(stats.ENG, { totalWeeks: 5, longestWeeks: 5, spells: 1, currentSince: null });
  assert.equal(stats.NZL.spells, 2);
  assert.equal(stats.NZL.totalWeeks, 1 + 175);
  assert.equal(stats.NZL.longestWeeks, 175);
  assert.deepEqual(stats.RSA, { totalWeeks: 10, longestWeeks: 10, spells: 1, currentSince: "2026-05-04" });
});
