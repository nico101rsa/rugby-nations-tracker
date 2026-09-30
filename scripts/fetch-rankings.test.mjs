import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRankings, parseWorldRugby, isoToAsOf, buildRankingsJson, withHistory, parseAsOfDate, isRegression, isFutureDated } from "./fetch-rankings.mjs";

// Trimmed real wikitext from Template:World_Rugby_Rankings (13 Jul 2026).
const WIKITEXT = `{{sticky header}}
{| class="wikitable floatright sticky-header" style="font-size:90%;"
|+ {{navbar-header|Men's [[World Rugby Rankings]]|World Rugby Rankings}} Top {{#ifeq: {{{short|}}}| yes | 20 | 30 }} as of 13 July 2026<ref name="runion rankings">...</ref>
|-
! scope="col" width=12px| Rank !! scope="col" width=12px| Change !! Team !! Points
|-{{#ifeq: {{{1|}}} |South Africa |style{{=}}background:#F5DEB3| }}
! scope="row"| 1
| align=center| {{steady}}|| {{ru|RSA}} || {{0}}93.96
|-
! scope="row"| 2
| align=center| {{steady}} || {{ru|NZL}} || {{0}}91.04
|-
! scope="row"| 5
| align=center| {{increase}}1 || {{ru|ENG}} || {{0}}84.75
|-
! scope="row"| 12
| align=center| {{decrease}}1 || {{ru|WAL}} || {{0}}76.38
|-
! scope="row"| 13
| align=center| {{steady}} || {{ru|GEO}} || {{0}}73.30
|}`;

test("parseRankings: rank, code, points, movement per row", () => {
  const rows = parseRankings(WIKITEXT);
  assert.deepEqual(rows[0], { rank: 1, code: "RSA", points: 93.96, move: 0 });
  assert.deepEqual(rows[2], { rank: 5, code: "ENG", points: 84.75, move: 1 });
  assert.deepEqual(rows[3], { rank: 12, code: "WAL", points: 76.38, move: -1 });
  assert.equal(rows.length, 5);
});

test("parseRankings: extracts the as-of date", () => {
  const rows = parseRankings(WIKITEXT);
  assert.equal(rows.asOf, "13 July 2026");
});

test("buildRankingsJson: keeps only competition codes, keyed by code", () => {
  const out = buildRankingsJson(parseRankings(WIKITEXT), "2026-07-15T00:00:00Z", { min: 4 });
  assert.equal(out.rankings.RSA.rank, 1);
  assert.equal(out.rankings.WAL.points, 76.38);
  assert.equal(out.rankings.GEO, undefined); // not a competition team
  assert.equal(out.asOf, "13 July 2026");
  assert.equal(out.updatedAt, "2026-07-15T00:00:00Z");
  assert.equal(out.source, "wikipedia:World_Rugby_Rankings");
});

test("buildRankingsJson: throws when too few competition teams parsed (guards a template rewrite)", () => {
  assert.throws(() => buildRankingsJson(parseRankings("junk"), "2026-07-15T00:00:00Z"), /parsed only/);
});

const snap = (asOf, rank) => ({
  updatedAt: "x", asOf, source: "wikipedia:World_Rugby_Rankings",
  rankings: { RSA: { rank, points: 90, move: 0 } },
});

test("withHistory: first run starts an empty history", () => {
  const out = withHistory(null, snap("13 July 2026", 1));
  assert.deepEqual(out.history, []);
  assert.equal(out.rankings.RSA.rank, 1);
});

test("withHistory: same asOf keeps the previous history untouched", () => {
  const prev = { ...snap("13 July 2026", 1), history: [{ asOf: "6 July 2026", rankings: { RSA: { rank: 2 } } }] };
  const out = withHistory(prev, snap("13 July 2026", 1));
  assert.equal(out.history.length, 1);
  assert.equal(out.history[0].asOf, "6 July 2026");
});

test("withHistory: new asOf archives the previous snapshot", () => {
  const prev = { ...snap("13 July 2026", 1), history: [] };
  const out = withHistory(prev, snap("20 July 2026", 2));
  assert.equal(out.history.length, 1);
  assert.deepEqual(out.history[0], { asOf: "13 July 2026", rankings: prev.rankings });
  assert.equal(out.rankings.RSA.rank, 2);
});

test("parseAsOfDate: template caption dates, garbage to null", () => {
  assert.equal(parseAsOfDate("24 August 2026"), Date.UTC(2026, 7, 24));
  assert.equal(parseAsOfDate("1 January 2003"), Date.UTC(2003, 0, 1));
  assert.equal(parseAsOfDate("Smarch 2026"), null);
  assert.equal(parseAsOfDate(null), null);
});

test("isRegression: a stale template must not clobber a fresher published table", () => {
  // 24 Aug 2026: the template still said "as of 20 July" two days after NZ
  // took No. 1 — a hand-corrected rankings.json has to survive the nightly.
  assert.equal(isRegression("24 August 2026", "20 July 2026"), true);
  assert.equal(isRegression("20 July 2026", "24 August 2026"), false);
  assert.equal(isRegression("24 August 2026", "24 August 2026"), false);
  // an unparseable side proves nothing, so it never blocks the write
  assert.equal(isRegression(null, "24 August 2026"), false);
  assert.equal(isRegression("24 August 2026", "garbled"), false);
});

test("isFutureDated: a future caption is a typo, not a release", () => {
  // 27 Aug 2026: the template's update finally landed captioned
  // "as of 24 September 2026" — a month typo the forward-only rule accepted.
  const now = Date.UTC(2026, 7, 27);
  assert.equal(isFutureDated("24 September 2026", now), true);
  assert.equal(isFutureDated("24 August 2026", now), false);
  // two days of slack: a Sunday-UTC cron may legitimately see Monday's date
  assert.equal(isFutureDated("28 August 2026", now), false);
  assert.equal(isFutureDated("30 August 2026", now), true);
  // unparseable proves nothing, so it never blocks the write
  assert.equal(isFutureDated("garbled", now), false);
  assert.equal(isFutureDated(null, now), false);
});

// Shape of world.rugby's rankings feed (api.wr-rims-prod.pulselive.com/rugby/v3/rankings/mru).
const WR = {
  label: "Mens Rugby Union",
  effective: { millis: Date.UTC(2026, 8, 28), gmtOffset: 0, label: "2026-09-28" },
  entries: [
    { pos: 1, previousPos: 1, pts: 95.094, previousPts: 95.09, team: { abbreviation: "RSA", name: "South Africa" } },
    { pos: 2, previousPos: 3, pts: 90.1, team: { abbreviation: "IRE", name: "Ireland" } },
    { pos: 3, previousPos: 2, pts: 89.9, team: { abbreviation: "NZL", name: "New Zealand" } },
    { pos: 11, previousPos: 12, pts: 76.5, team: { abbreviation: "XJP", name: "Japan" } },
    { pos: 13, previousPos: 13, pts: 73.3, team: { abbreviation: "GEO", name: "Georgia" } },
  ],
};

test("parseWorldRugby: rank, code, points and movement from previousPos", () => {
  const rows = parseWorldRugby(WR);
  assert.deepEqual(rows[0], { rank: 1, code: "RSA", points: 95.09, move: 0 });
  assert.deepEqual(rows[1], { rank: 2, code: "IRE", points: 90.1, move: 1 });
  assert.deepEqual(rows[2], { rank: 3, code: "NZL", points: 89.9, move: -1 });
  assert.equal(rows.length, 5);
});

test("parseWorldRugby: an unfamiliar abbreviation falls back to the team name", () => {
  assert.equal(parseWorldRugby(WR)[3].code, "JPN");
});

test("parseWorldRugby: effective date becomes the Wikipedia-style asOf", () => {
  assert.equal(parseWorldRugby(WR).asOf, "28 September 2026");
  assert.equal(parseWorldRugby({ ...WR, effective: { millis: Date.UTC(2026, 8, 21) } }).asOf, "21 September 2026");
  assert.equal(parseWorldRugby({ entries: [] }).asOf, null);
});

test("isoToAsOf: ISO date to caption format that parseAsOfDate reads back", () => {
  assert.equal(isoToAsOf("2026-09-07"), "7 September 2026");
  assert.equal(parseAsOfDate(isoToAsOf("2026-09-28")), Date.UTC(2026, 8, 28));
  assert.equal(isoToAsOf("garbled"), null);
  assert.equal(isoToAsOf("2026-13-01"), null);
});

test("buildRankingsJson: records world.rugby as the source", () => {
  const out = buildRankingsJson(parseWorldRugby(WR), "x", { min: 3, source: "world.rugby" });
  assert.equal(out.source, "world.rugby");
  assert.equal(out.asOf, "28 September 2026");
  assert.equal(out.rankings.GEO, undefined);
});

test("buildRankingsJson: a short world.rugby feed throws so the Wikipedia fallback runs", () => {
  assert.throws(() => buildRankingsJson(parseWorldRugby({ entries: [] }), "x", { source: "world.rugby" }), /parsed only/);
});
