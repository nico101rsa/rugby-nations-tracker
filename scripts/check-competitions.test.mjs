import { test } from "node:test";
import assert from "node:assert/strict";
import { checkIntegrity, expectedFixtures } from "./check-competitions.mjs";
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
