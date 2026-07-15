import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRankings, buildRankingsJson, withHistory } from "./fetch-rankings.mjs";

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
