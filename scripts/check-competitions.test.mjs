import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIntegrity, expectedFixtures, checkStandings } from "./check-competitions.mjs";
import { buildStandings } from "./build-standings.mjs";
import { POOL_NAMES } from "./competition-rules.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SEEDS, applicableSeeds, seededCompetition } from "./seed-competitions.mjs";

const TODAY = "2026-07-25";

const comp = (over = {}) => ({
  key: "rnc-2026", name: "Nations Championship", season: 2026,
  structure: "conference", fixtureCount: 36,
  teams: ["ARG", "AUS", "ENG", "FIJ", "FRA", "IRE", "ITA", "JPN", "NZL", "RSA", "SCO", "WAL"],
  groups: [
    { name: "North", teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"] },
    { name: "South", teams: ["ARG", "AUS", "FIJ", "JPN", "NZL", "RSA"] },
  ],
  startDate: "2026-07-04", endDate: "2026-11-21",
  defaultFrom: "2026-03-28", defaultUntil: "2026-12-05",
  ...over,
});
const fixture = (key, home, away, date = "2026-08-01T00:00:00Z") => ({
  id: `${key}-${home}-${away}`, date,
  home: { code: home }, away: { code: away },
  comp: { key, kind: "competition" },
});
const reg = (comps, current = "rnc-2026") => ({ current, competitions: comps });

// --- expected fixture counts (pure arithmetic) ----------------------------

test("expectedFixtures knows each shape's arithmetic", () => {
  assert.equal(expectedFixtures({ structure: "table", teams: Array(6) }), 15);
  assert.equal(
    expectedFixtures({ structure: "conference", teams: Array(12), groups: [{ teams: Array(6) }, { teams: Array(6) }] }),
    36,
  );
  assert.equal(
    expectedFixtures({ structure: "pools", teams: Array(24), groups: Array.from({ length: 6 }, () => ({ teams: Array(4) })) }),
    36,
  );
});

test("an UNKNOWN structure asserts nothing rather than guessing", () => {
  assert.equal(expectedFixtures({ structure: "UNKNOWN", teams: Array(24) }), null);
  assert.equal(expectedFixtures({ structure: null, teams: Array(6) }), null);
});

// --- THE defect that prompted this check ----------------------------------

test("a healthy registry raises nothing", () => {
  const fixtures = { fixtures: [fixture("rnc-2026", "ENG", "RSA")] };
  assert.deepEqual(checkIntegrity(reg([comp()]), fixtures, TODAY), []);
});

test("an EXPIRED competition as the app's default is raised", () => {
  // Six Nations 2026 finished 14 March; by late July it was still on offer.
  const six = comp({
    key: "6n-2026", name: "Six Nations", structure: "table", fixtureCount: 15,
    teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"], groups: null,
    startDate: "2026-02-05", endDate: "2026-03-14", defaultUntil: "2026-03-28",
  });
  const p = checkIntegrity(reg([six], "6n-2026"), { fixtures: [fixture("6n-2026", "ENG", "FRA")] }, TODAY);
  assert.equal(p[0].kind, "stale-current");
  assert.match(p[0].title, /has expired/);
  assert.match(p[0].detail, /seed-competitions/);
});

test("no current competition at all is raised", () => {
  const p = checkIntegrity(reg([comp()], null), { fixtures: [fixture("rnc-2026", "ENG", "RSA")] }, TODAY);
  assert.equal(p.some((x) => x.kind === "no-current"), true);
});

// --- arithmetic catches an incomplete list --------------------------------

test("a table missing one fixture is caught by arithmetic", () => {
  // 6 teams must be 15 matches; 14 still classifies as nothing suspicious.
  const six = comp({
    key: "6n-2027", name: "Six Nations", season: 2027, structure: "table",
    fixtureCount: 14, teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"], groups: null,
    startDate: "2027-02-05", endDate: "2027-03-13", defaultUntil: "2027-03-27",
  });
  const p = checkIntegrity(reg([six], "rnc-2026"), { fixtures: [fixture("6n-2027", "ENG", "FRA")] }, TODAY);
  const hit = p.find((x) => x.kind === "fixture-count-mismatch");
  assert.ok(hit);
  assert.match(hit.title, /14 fixtures, expected 15/);
});

test("a duplicated fixture is caught the same way", () => {
  const p = checkIntegrity(reg([comp({ fixtureCount: 37 })]), { fixtures: [fixture("rnc-2026", "ENG", "RSA")] }, TODAY);
  assert.equal(p.some((x) => x.kind === "fixture-count-mismatch"), true);
});

// --- registry and fixtures must agree -------------------------------------

test("the exact failure the check found on its first live run", () => {
  // A competition the registry offers, with nothing behind it in fixtures.json.
  const six = comp({
    key: "6n-2027", name: "Six Nations", season: 2027, structure: "table",
    fixtureCount: 15, teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"], groups: null,
    startDate: "2027-02-05", endDate: "2027-03-13", defaultUntil: "2027-03-27",
  });
  const p = checkIntegrity(reg([comp(), six]), { fixtures: [fixture("rnc-2026", "ENG", "RSA")] }, TODAY);
  const hit = p.find((x) => x.kind === "empty-competition");
  assert.ok(hit);
  assert.match(hit.title, /selectable but has no fixtures/);
});

test("a fixture whose comp the registry doesn't know is raised", () => {
  const p = checkIntegrity(reg([comp()]), { fixtures: [fixture("rnc-2027", "ENG", "RSA")] }, TODAY);
  assert.equal(p.some((x) => x.kind === "orphaned-fixtures"), true);
});

test("an EXPIRED competition is not expected to still carry fixtures", () => {
  // fixtures.json is future-only, so a finished competition legitimately has
  // none — that must not be reported as an empty competition.
  const done = comp({ key: "6n-2026", endDate: "2026-03-14", defaultUntil: "2026-03-28", fixtureCount: 15,
    structure: "table", teams: ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"], groups: null });
  const p = checkIntegrity(reg([done, comp()]), { fixtures: [fixture("rnc-2026", "ENG", "RSA")] }, TODAY);
  assert.equal(p.some((x) => x.kind === "empty-competition"), false);
});

test("an empty registry is a finding, not a silent pass", () => {
  const p = checkIntegrity({ competitions: [] }, { fixtures: [] }, TODAY);
  assert.equal(p[0].kind, "empty-registry");
  assert.equal(checkIntegrity(null, null, TODAY)[0].kind, "empty-registry");
});

// --- structure drift ------------------------------------------------------

test("a structure that disagrees with its own fixtures is raised", () => {
  // Registry claims a table; the fixtures are two disjoint pairs.
  const c = comp({ key: "x-2026", structure: "table", fixtureCount: 2, teams: ["A", "B", "C", "D"], groups: null });
  const fixtures = { fixtures: [fixture("x-2026", "A", "B"), fixture("x-2026", "C", "D")] };
  const p = checkIntegrity(reg([c], "rnc-2026"), fixtures, TODAY);
  assert.equal(p.some((x) => x.kind === "structure-drift"), true);
});

// --- the seed -------------------------------------------------------------

test("the Six Nations 2027 seed is a complete, well-formed table", () => {
  const seed = SEEDS["6n-2027"];
  assert.equal(seed.fixtures.length, 15);
  const c = seededCompetition(seed);
  assert.equal(c.structure, "table");
  assert.equal(c.teams.length, 6);
  assert.equal(c.fixtureCount, expectedFixtures(c));
  assert.equal(c.startDate, "2027-02-05");
  assert.equal(c.endDate, "2027-03-13");
});

test("every seeded fixture is marked TBC — the times are not confirmed", () => {
  // Two sources disagree on Scotland v Wales and the union says most kickoff
  // times are unconfirmed, so the app must render "TBC", never a wrong time.
  assert.equal(SEEDS["6n-2027"].fixtures.every((f) => f.timeTBC === true), true);
});

test("every pair meets exactly once in the seed", () => {
  const seen = new Set();
  for (const f of SEEDS["6n-2027"].fixtures) {
    const key = [f.home.code, f.away.code].sort().join("-");
    assert.equal(seen.has(key), false, `${key} appears twice`);
    seen.add(key);
  }
  assert.equal(seen.size, 15);
});

test("a seed applies only while the registry entry is still SEEDED", () => {
  // The flag, not the fixture count — the count reads 15 once the seed has
  // been substituted, which made the first version skip itself.
  const seededEntry = { key: "6n-2027", fixtureCount: 15, seeded: true };
  const liveEntry = { key: "6n-2027", fixtureCount: 15 };
  assert.equal(applicableSeeds({ competitions: [seededEntry] }).length, 1);
  assert.equal(applicableSeeds({ competitions: [liveEntry] }).length, 0);
  assert.equal(applicableSeeds({ competitions: [] }).length, 0);
});

// --- declared structures ----------------------------------------------------

test("a declared knockout is not reported as drifting from its fixtures", () => {
  // The classifier cannot produce "knockout", so recomputing would always
  // disagree. Fixture-count arithmetic has nothing to say about it either.
  const pnc = comp({
    key: "pnc-2026", name: "Pacific Nations Cup", structure: "knockout", fixtureCount: 4,
    teams: ["CAN", "FIJ", "JPN", "USA"], groups: null, headline: false,
    startDate: "2026-09-11", endDate: "2026-09-19", defaultFrom: "2026-09-11", defaultUntil: "2026-10-03",
  });
  assert.equal(expectedFixtures(pnc), null);
  const fixtures = { fixtures: [
    fixture("rnc-2026", "ENG", "RSA"),
    fixture("pnc-2026", "FIJ", "CAN", "2026-09-11T08:00:00Z"),
    fixture("pnc-2026", "JPN", "USA", "2026-09-12T10:05:00Z"),
    fixture("pnc-2026", "JPN", "FIJ", "2026-09-19T10:05:00Z"),
    fixture("pnc-2026", "USA", "CAN", "2026-09-19T07:00:00Z"),
  ] };
  assert.deepEqual(checkIntegrity(reg([comp(), pnc]), fixtures, "2026-09-12"), []);
});

// --- standings.json (checkStandings) ----------------------------------------

const S_ID = { ENG: 386, FRA: 387, IRE: 388, ITA: 389, SCO: 390, WAL: 391, ARG: 460, AUS: 461, JPN: 463, NZL: 465, RSA: 467, FIJ: 28 };
const S_NAME = { ENG: "England", FRA: "France", IRE: "Ireland", ITA: "Italy", SCO: "Scotland", WAL: "Wales", ARG: "Argentina", AUS: "Australia", JPN: "Japan", NZL: "New Zealand", RSA: "South Africa", FIJ: "Fiji" };
const SIX = ["ENG", "FRA", "IRE", "ITA", "SCO", "WAL"];
const S_TODAY = "2027-02-10";
const S_NOW = Date.parse("2027-02-10T00:00:00Z");

const sixNations = (over = {}) => ({
  key: "6n-2027", label: "6N '27", name: "Six Nations", season: 2027, structure: "table", teams: SIX,
  fixtureCount: 15, startDate: "2027-02-05", endDate: "2027-03-13", defaultFrom: "2026-12-05", defaultUntil: "2027-03-27", ...over,
});
const rnc = (over = {}) => ({ ...comp(), label: "RNC '26", ...over });
const sixRow = (id, home, away, hs, as, date) => ({
  id, date, home: { code: home, name: S_NAME[home] }, away: { code: away, name: S_NAME[away] },
  comp: { key: "6n-2027", kind: "competition" }, homeScore: hs, awayScore: as,
});
const S_FIXTURES = {
  fixtures: [
    sixRow("espn-1", "IRE", "ENG", 24, 20, "2027-02-05T20:10:00Z"),
    sixRow("espn-2", "SCO", "ITA", 22, 18, "2027-02-06T14:10:00Z"),
    sixRow("espn-3", "FRA", "WAL", 24, 20, "2027-02-06T16:40:00Z"),
  ],
};
const S_TRIES = { "espn-1": { home: 4, away: 2 }, "espn-3": { home: 3, away: 2 } };
const slimResult = (id, home, away, hs, as, date) => ({
  id, date, week: "1", status: { short: "FT", long: "Finished", live: false },
  home: { id: S_ID[home], name: S_NAME[home], score: hs }, away: { id: S_ID[away], name: S_NAME[away], score: as },
});
// nations.json with its computeLog-shaped `log` (rows by api-sports id).
const S_NATIONS = {
  competition: { id: 145, name: "Nations Championship", season: 2026 },
  results: [slimResult(1, "NZL", "FRA", 34, 32, "2026-07-04T07:10:00Z"), slimResult(2, "RSA", "ENG", 40, 10, "2026-07-04T15:40:00Z")],
  log: [
    { rank: 1, id: 467, team: "South Africa", P: 1, W: 1, D: 0, L: 0, PF: 40, PA: 10, PD: 30, TF: 6, TA: 1, BP: 1, Pts: 5 },
    { rank: 2, id: 465, team: "New Zealand", P: 1, W: 1, D: 0, L: 0, PF: 34, PA: 32, PD: 2, TF: 5, TA: 4, BP: 1, Pts: 5 },
    { rank: 3, id: 387, team: "France", P: 1, W: 0, D: 0, L: 1, PF: 32, PA: 34, PD: -2, TF: 4, TA: 5, BP: 2, Pts: 2 },
    { rank: 4, id: 386, team: "England", P: 1, W: 0, D: 0, L: 1, PF: 10, PA: 40, PD: -30, TF: 1, TA: 6, BP: 0, Pts: 0 },
  ],
};
const S_RNC_TRIES = { 1: { home: 5, away: 4 }, 2: { home: 6, away: 1 } };
const S_REGISTRY = () => ({ current: "6n-2027", competitions: [rnc(), sixNations()] });
const consistent = () => buildStandings({
  registry: S_REGISTRY(), nations: S_NATIONS, fixtures: S_FIXTURES, rncTries: S_RNC_TRIES, espnTries: S_TRIES,
  now: new Date("2027-02-07T00:00:00Z"),
});
const check = (standings, { registry = S_REGISTRY(), fixtures = S_FIXTURES, nations = S_NATIONS, today = S_TODAY, now = S_NOW } = {}) =>
  checkStandings(registry, standings, fixtures, nations, today, { now });
const kinds = (ps) => ps.map((p) => p.kind);
const entry = (s, key) => s.competitions.find((e) => e.key === key);
const rowOf = (s, key, code) => entry(s, key).groups.flatMap((g) => g.rows).find((r) => r.code === code);

test("checkStandings: a consistent synthetic file against its own inputs has no problems", () => {
  const s = consistent();
  assert.equal(entry(s, "rnc-2026").played, 2);
  assert.equal(entry(s, "6n-2027").played, 3);
  assert.deepEqual(check(s), []);
});

test("checkStandings: Pts off by one -> standings-arithmetic", () => {
  const s = consistent();
  rowOf(s, "6n-2027", "IRE").Pts += 1;
  const ps = check(s);
  assert.deepEqual(kinds(ps), ["standings-arithmetic"]);
  assert.equal(ps[0].title, "standings.json 6n-2027: the table's points don't add up");
});

test("checkStandings: a missing code -> standings-teams", () => {
  const s = consistent();
  const g = entry(s, "6n-2027").groups[0];
  const wal = g.rows.find((r) => r.code === "WAL");
  g.rows = g.rows.filter((r) => r !== wal);
  // (ΣP no longer matches either; that is the arithmetic check's line.)
  const ps = check(s).filter((p) => p.kind === "standings-teams");
  assert.equal(ps.length, 1);
  assert.match(ps[0].detail, /missing WAL/);
});

test("checkStandings: an rnc row disagreeing with the nations.json log -> standings-parity", () => {
  const nations = structuredClone(S_NATIONS);
  nations.log.find((r) => r.id === 465).Pts = 4;
  const ps = check(consistent(), { nations });
  assert.deepEqual(kinds(ps), ["standings-parity"]);
  assert.match(ps[0].detail, /NZL Pts: standings 5, log 4/);
  assert.equal(ps[0].title, "standings.json rnc-2026: table disagrees with nations.json log");
});

test("checkStandings: parity skips TF/TA for a row with tries pending (the log carries a partial sum)", () => {
  const s = buildStandings({
    registry: S_REGISTRY(), nations: S_NATIONS, fixtures: S_FIXTURES, rncTries: { 1: { home: 5, away: 4 } }, espnTries: S_TRIES,
    now: new Date("2027-02-07T00:00:00Z"),
  });
  const nations = structuredClone(S_NATIONS);
  // computeLog without game 2's tries: no try bonus for RSA, TF/TA 0.
  Object.assign(nations.log.find((r) => r.id === 467), { TF: 0, TA: 0, BP: 0, Pts: 4 });
  Object.assign(nations.log.find((r) => r.id === 386), { TF: 0, TA: 0 });
  assert.deepEqual(check(s, { nations }), []);
});

test("checkStandings: frozen on a still-offered key -> standings-results-missing", () => {
  const s = consistent();
  entry(s, "6n-2027").frozen = true;
  const ps = check(s);
  assert.deepEqual(kinds(ps), ["standings-results-missing"]);
  assert.equal(ps[0].title, "standings.json 6n-2027: results missing from the feeds");
  // The same freeze after the window closed is the carry-forward working.
  assert.deepEqual(check(s, { today: "2027-04-01", now: Date.parse("2027-04-01T00:00:00Z") }), []);
});

test("checkStandings: the table holding more games than the feeds -> standings-results-missing", () => {
  const fixtures = { fixtures: S_FIXTURES.fixtures.slice(0, 2) };
  const ps = check(consistent(), { fixtures });
  assert.ok(kinds(ps).includes("standings-results-missing"));
  assert.match(ps.find((p) => p.kind === "standings-results-missing").detail, /counts 3 game\(s\) while the feeds carry 2/);
});

test("checkStandings: a result two days old that the table never took -> standings-stale", () => {
  const s = consistent(); // tables last changed 7 Feb
  const fixtures = { fixtures: [...S_FIXTURES.fixtures, sixRow("espn-4", "ENG", "ITA", 30, 10, "2027-02-07T15:10:00Z")] };
  assert.deepEqual(kinds(check(s, { fixtures, now: Date.parse("2027-02-08T12:00:00Z") })).filter((k) => k === "standings-stale"), [],
    "inside 48 hours it is not stale yet");
  const ps = check(s, { fixtures, now: Date.parse("2027-02-10T00:00:00Z") });
  assert.ok(kinds(ps).includes("standings-stale"));
  assert.equal(ps.find((p) => p.kind === "standings-stale").title, "standings.json 6n-2027: results are in but the table has not moved");
});

test("checkStandings: complete with tries pending 8 days after completedAt -> standings-tries-pending", () => {
  const s = consistent();
  Object.assign(entry(s, "6n-2027"), { complete: true, completedAt: "2027-02-02T00:00:00.000Z", triesPending: 1, played: 3, total: 3 });
  const ps = check(s).filter((p) => p.kind === "standings-tries-pending");
  assert.equal(ps.length, 1);
  Object.assign(entry(s, "6n-2027"), { completedAt: "2027-02-05T00:00:00.000Z" });
  assert.equal(check(s).filter((p) => p.kind === "standings-tries-pending").length, 0, "6 days is still waiting");
});

test("checkStandings: decidedBy 'pf' on a Six Nations row -> standings-tiebreak", () => {
  const s = consistent();
  // IRE 5, then FRA and SCO level on 4 (FRA placed below IRE on points).
  const row = rowOf(s, "6n-2027", "FRA");
  assert.equal(row.decidedBy, "pts");
  row.decidedBy = "pf";
  const ps = check(s);
  assert.deepEqual(kinds(ps), ["standings-tiebreak"]);
  assert.match(ps[0].detail, /placed by "pf"/);
});

test("checkStandings: a tied row in no unresolved set -> standings-tiebreak", () => {
  const s = consistent();
  entry(s, "6n-2027").unresolved = [];
  assert.deepEqual(kinds(check(s)), ["standings-tiebreak"]);
});

test("checkStandings: teams yet to play may share a rank without an unresolved set", () => {
  const s = consistent();
  // rnc-2026 has two games in, so eight of its twelve teams have P 0.
  const idle = entry(s, "rnc-2026").groups.flatMap((g) => g.rows).filter((r) => r.P === 0);
  assert.ok(idle.length >= 2 && idle.every((r) => r.tied));
  assert.deepEqual(entry(s, "rnc-2026").unresolved, []);
  assert.deepEqual(check(s), []);
});

test("checkStandings: a bracket slot after the registry endDate -> standings-stage-past-end", () => {
  const s = consistent();
  entry(s, "6n-2027").qualification = { bracket: [{ stage: "FINAL", n: 1, date: "2027-11-13" }] };
  assert.deepEqual(kinds(check(s)), ["standings-stage-past-end"]);
});

// A whole World Cup pool stage, places fixed by the scores; each pool's third
// beats its fourth by `margin[letter]`, so the margins pick the best thirds.
const RWC_LETTERS = ["A", "F", "E", "B", "D", "C"];
const rwcRegistry = (endDate) => ({
  current: "rwc-2027",
  competitions: [{
    key: "rwc-2027", label: "RWC '27", name: "Rugby World Cup", season: 2027, structure: "pools", fixtureCount: 36,
    startDate: "2027-10-01", endDate, defaultFrom: "2027-03-27", defaultUntil: "2027-10-31",
    groups: RWC_LETTERS.map((l) => ({ name: null, teams: [...POOL_NAMES["rwc-2027"][l]], pool: l })),
  }],
});
function rwcFeeds(margin) {
  const fixtures = [];
  const tries = {};
  RWC_LETTERS.forEach((l, p) => {
    const [a, b, c, d] = POOL_NAMES["rwc-2027"][l];
    [[a, b, 30, 10], [a, c, 30, 10], [a, d, 50, 0], [b, c, 30, 10], [b, d, 40, 0], [c, d, 10 + margin[l], 10]].forEach(([h, w, hs, as], i) => {
      const id = `espn-${l}${i}`;
      fixtures.push({ id, date: `2027-10-${String(1 + 2 * p).padStart(2, "0")}T0${i}:00:00Z`, home: { code: h }, away: { code: w }, comp: { key: "rwc-2027", kind: "competition" }, homeScore: hs, awayScore: as });
      tries[id] = { home: 2, away: 1 };
    });
  });
  return { fixtures: { fixtures }, tries };
}

test("checkStandings: a built World Cup entry (q, best thirds, bracket) holds every invariant; a bracket past endDate is named", () => {
  const now = new Date("2027-10-18T00:00:00Z");
  for (const [margin, provable] of [
    [{ A: 15, B: 14, C: 13, D: 12, E: 11, F: 10 }, true],    // thirds A-D: the fixed rule fills the Round of 16
    [{ A: 15, B: 14, E: 13, F: 12, C: 11, D: 10 }, false],   // E3 and F3 both through: two slots need the permutation table
  ]) {
    const { fixtures, tries } = rwcFeeds(margin);
    const s = buildStandings({ registry: rwcRegistry("2027-11-13"), fixtures, espnTries: tries, now });
    const e = entry(s, "rwc-2027");
    assert.equal(e.played, 36);
    assert.equal(e.provable, provable);
    assert.equal(e.qualification.bracket.length, 16);
    if (!provable) assert.deepEqual(e.unresolved.map((u) => u.needs), ["thirds-rule"]);
    const opts = { registry: rwcRegistry("2027-11-13"), fixtures, nations: null, today: "2027-10-18", now: now.getTime() };
    assert.deepEqual(check(s, opts), [], JSON.stringify(margin));
    // Before ESPN publishes the knockouts the registry ends with the pool
    // stage, and the bracket outlives it: named, not hidden.
    assert.deepEqual(kinds(check(s, { ...opts, registry: rwcRegistry("2027-10-17") })), ["standings-stage-past-end"]);
  }
});

test("checkStandings: missing file is a problem only when there are results", () => {
  assert.deepEqual(kinds(check(null)), ["standings-missing"]);
  const quiet = check(null, { fixtures: { fixtures: [] }, nations: null });
  assert.deepEqual(quiet, []);
  const s = consistent();
  s.competitions = s.competitions.filter((e) => e.key !== "6n-2027");
  const ps = check(s);
  assert.deepEqual(kinds(ps), ["standings-missing"]);
  assert.equal(ps[0].title, "standings.json has no table for 6n-2027");
});

test("checkStandings: titles are deterministic across runs and days", () => {
  const s = consistent();
  rowOf(s, "6n-2027", "IRE").Pts += 1;
  entry(s, "6n-2027").frozen = true;
  const a = check(s).map((p) => p.title);
  const b = check(structuredClone(s), { now: S_NOW + 3 * 86400000, today: "2027-02-13" }).map((p) => p.title);
  assert.deepEqual(a, b);
  assert.ok(a.every((tl) => !/\d+ game/.test(tl)), "no counts in titles");
});

test("check-competitions main() exits 0 with no standings.json when no competition has results", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-comp-"));
  try {
    const teams = SIX;
    const fixtures = [];
    let d = 0;
    for (let i = 0; i < teams.length; i++) {
      for (let j = i + 1; j < teams.length; j++) {
        fixtures.push({ id: `seed-${d}`, date: new Date(Date.UTC(2027, 1, 5) + d++ * 86400000).toISOString(), home: { code: teams[i] }, away: { code: teams[j] }, comp: { key: "6n-2027", kind: "competition" } });
      }
    }
    writeFileSync(join(dir, "competitions.json"), JSON.stringify({ current: "6n-2027", competitions: [sixNations({ defaultUntil: "2099-01-01", endDate: "2099-01-01" })] }));
    writeFileSync(join(dir, "fixtures.json"), JSON.stringify({ fixtures }));
    const script = join(dirname(fileURLToPath(import.meta.url)), "check-competitions.mjs");
    const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", env: { ...process.env, GH_TOKEN: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /integrity OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
