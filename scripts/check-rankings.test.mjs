import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNo1, checkYearsAgree, checkTableFreshness, lastYearIn } from "./check-rankings.mjs";

const rankings = (top, others = {}) => ({
  rankings: { [top]: { rank: 1, points: 93.96, move: 0 }, ...others },
});
const stats = (entries) => ({
  teams: Object.fromEntries(
    Object.entries(entries).map(([code, since]) => [
      code,
      { no1: since === null ? null : { totalWeeks: 40, longestWeeks: 30, currentSince: since } },
    ]),
  ),
});

test("the healthy case: live No. 1 and the open spell agree", () => {
  assert.equal(checkNo1(rankings("RSA", { NZL: { rank: 2 } }), stats({ RSA: "2025-09-15", NZL: null })), null);
});

test("a nation that has never held No. 1 carries a null no1 and is not a fault", () => {
  assert.equal(checkNo1(rankings("RSA"), stats({ RSA: "2025-09-15", ITA: null, FIJ: null })), null);
});

test("THE failure: timeline still open for the previous holder", () => {
  // RSA lost No. 1 to NZL; Wikipedia's template hasn't closed RSA's spell, so
  // the app keeps counting RSA's streak upward against today.
  const p = checkNo1(rankings("NZL", { RSA: { rank: 2 } }), stats({ RSA: "2025-09-15", NZL: null }));
  assert.equal(p.kind, "stale-timeline");
  assert.match(p.title, /timeline still has RSA at No\. 1, live table says NZL/);
  assert.match(p.detail, /ticking upward/);
  assert.match(p.detail, /streak-first/);
});

test("no open spell at all is reported, and named as the benign direction", () => {
  const p = checkNo1(rankings("RSA"), stats({ RSA: null, NZL: null }));
  assert.equal(p.kind, "no-current-holder");
  assert.match(p.detail, /benign direction/);
});

test("two open spells is a parse fault, not a data lag", () => {
  const p = checkNo1(rankings("RSA"), stats({ RSA: "2025-09-15", NZL: "2024-01-01" }));
  assert.equal(p.kind, "multiple-holders");
  assert.match(p.detail, /parse fault/);
});

test("no live No. 1 is reported, and names the untracked-nation explanation", () => {
  // We only carry 12 nations; a 13th topping the table looks empty from here.
  const p = checkNo1({ rankings: { RSA: { rank: 2 }, NZL: { rank: 3 } } }, stats({ RSA: "2025-09-15" }));
  assert.equal(p.kind, "no-live-no1");
  assert.match(p.detail, /UNTRACKED nation/);
});

test("two teams at rank 1 is reported", () => {
  const p = checkNo1(
    { rankings: { RSA: { rank: 1 }, NZL: { rank: 1 } } },
    stats({ RSA: "2025-09-15" }),
  );
  assert.equal(p.kind, "no-live-no1");
  assert.match(p.title, /more than one/);
});

test("empty or missing files are reported rather than silently passing", () => {
  assert.equal(checkNo1({}, {}).kind, "no-live-no1");
  assert.equal(checkNo1(null, null).kind, "no-live-no1");
});

// --- checkYearsAgree: the best/worst section vouching for the slower sources ---

test("lastYearIn: Wikipedia's years convention, trailing range ends in the later year", () => {
  assert.equal(lastYearIn("2003, 2004–07, 2025–26"), 2026);
  assert.equal(lastYearIn("2019, 2021, 2025, 2026"), 2026);
  assert.equal(lastYearIn("1999–00"), 2000); // century comes from the start year
  assert.equal(lastYearIn(""), null);
});

const yearsStats = (bestYears, latestYear, bestRank = 1) => ({
  teams: { NZL: { best: { rank: bestRank, years: bestYears }, no1: { latestYear } } },
});

test("THE 22 Aug 2026 failure: best-years already credit this year, timeline doesn't", () => {
  // Overnight after Ellis Park, NZ's best years gained "2026" while the
  // leaders timeline (and the live table) still lagged the result.
  const p = checkYearsAgree(yearsStats("2003, 2021, 2025, 2026", 2025));
  assert.equal(p.kind, "years-ahead-of-timeline");
  assert.match(p.title, /NZL with No\. 1 in 2026, timeline stops at 2025/);
  assert.match(p.detail, /both stale/);
});

test("checkYearsAgree: agreement, timeline ahead, and non-#1 nations all pass", () => {
  assert.equal(checkYearsAgree(yearsStats("2021, 2025, 2026", 2026)), null);
  assert.equal(checkYearsAgree(yearsStats("2021, 2025", 2026)), null); // timeline fresher than the years column
  assert.equal(checkYearsAgree(yearsStats("2007–08", 0, 3)), null); // best rank isn't 1
});

test("checkYearsAgree: a hand-edited stats file without latestYear is skipped, not a fault", () => {
  assert.equal(checkYearsAgree({ teams: { NZL: { best: { rank: 1, years: "2026" }, no1: { totalWeeks: 5 } } } }), null);
  assert.equal(checkYearsAgree({ teams: { ITA: { best: { rank: 11, years: "2016" }, no1: null } } }), null);
  assert.equal(checkYearsAgree(null), null);
});

// --- checkTableFreshness: an upset the table cannot have ignored ---

const AS_OF_20_JUL = Date.UTC(2026, 6, 20);
const table = { asOf: "20 July 2026", rankings: { RSA: { rank: 1 }, NZL: { rank: 2 }, ARG: { rank: 7 } } };
const game = (code, opponentCode, date, us, them) => ({ teams: { [code]: { last: [{ opponentCode, date, us, them }] } } });
const ellisPark = game("RSA", "NZL", "2026-08-22T15:10:00.000Z", 16, 33);

test("THE Ellis Park failure: higher-ranked RSA lost after the table's as-of, grace passed", () => {
  const p = checkTableFreshness(table, ellisPark, AS_OF_20_JUL, Date.UTC(2026, 7, 27));
  assert.equal(p.kind, "stale-table");
  assert.match(p.title, /RSA 16–33 NZL \(2026-08-22\)/);
  assert.match(p.detail, /as of 20 July 2026/);
  assert.match(p.detail, /NZL.*beat higher-ranked.*RSA/s);
});

test("checkTableFreshness: quiet inside the grace window, loud after it", () => {
  assert.equal(checkTableFreshness(table, ellisPark, AS_OF_20_JUL, Date.UTC(2026, 7, 24)), null);
  assert.notEqual(checkTableFreshness(table, ellisPark, AS_OF_20_JUL, Date.UTC(2026, 7, 27)), null);
});

test("a favourite winning proves nothing: it can exchange zero points", () => {
  // SA beat ARG on 8 Aug 2026 and the table legitimately stayed "as of 20 July".
  const p = checkTableFreshness(table, game("RSA", "ARG", "2026-08-08T19:00:00.000Z", 17, 10), AS_OF_20_JUL, Date.UTC(2026, 7, 27));
  assert.equal(p, null);
});

test("a draw across a rank gap always exchanges points, so it counts", () => {
  const p = checkTableFreshness(table, game("RSA", "NZL", "2026-08-22T15:10:00.000Z", 20, 20), AS_OF_20_JUL, Date.UTC(2026, 7, 27));
  assert.equal(p.kind, "stale-table");
  assert.match(p.detail, /drew with/);
});

test("checkTableFreshness: results already inside the as-of date, unknown opponents, and missing feeds pass", () => {
  assert.equal(checkTableFreshness(table, game("RSA", "NZL", "2026-07-18T15:00:00.000Z", 16, 33), AS_OF_20_JUL, Date.UTC(2026, 7, 27)), null);
  assert.equal(checkTableFreshness(table, game("RSA", "GEO", "2026-08-22T15:10:00.000Z", 16, 33), AS_OF_20_JUL, Date.UTC(2026, 7, 27)), null);
  assert.equal(checkTableFreshness(table, null, AS_OF_20_JUL), null);
  assert.equal(checkTableFreshness(table, ellisPark, null), null); // unparseable as-of proves nothing
});
