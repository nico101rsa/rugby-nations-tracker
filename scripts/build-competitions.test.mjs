import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  chainDefaults,
  defaultCompetition,
  statusFor,
  entryFor,
  sliceRange,
  TAIL_DAYS,
  MAX_RANGE_DAYS,
} from "./build-competitions.mjs";

// Round robin among `teams`, one game a day from 2026-01-01.
const roundRobin = (teams, from = "2026-01-01") => {
  const out = [];
  let day = 0;
  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      out.push({ teams: [teams[i], teams[j]], date: dayAfter(from, day++) });
    }
  }
  return out;
};
const cross = (a, b, from = "2026-01-01") => {
  const out = [];
  let day = 0;
  for (const x of a) for (const y of b) out.push({ teams: [x, y], date: dayAfter(from, day++) });
  return out;
};
const dayAfter = (iso, n) =>
  new Date(new Date(iso + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

// --- the three real shapes ------------------------------------------------

test("complete graph classifies as a table (Six Nations: 6 teams, 15 games)", () => {
  const m = roundRobin(["1", "2", "3", "4", "9", "20"]);
  assert.equal(m.length, 15);
  assert.equal(classify(m).structure, "table");
});

test("complete bipartite classifies as a conference (NC: 12 teams, 36 games)", () => {
  const north = ["1", "2", "3", "4", "9", "20"];
  const south = ["5", "6", "8", "10", "14", "23"];
  const m = cross(north, south);
  assert.equal(m.length, 36);
  const { structure, groups } = classify(m);
  assert.equal(structure, "conference");
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((g) => g.teams.length),
    [6, 6],
  );
});

test("N equal complete components classify as pools (RWC: 24 teams, 36 games, 6x4)", () => {
  const pools = [
    ["10", "25", "14", "289211"],
    ["6", "289243", "289268", "8"],
    ["1", "16", "4", "289356"],
    ["9", "23", "15", "11"],
    ["81", "20", "12", "5"],
    ["3", "27", "2", "29"],
  ];
  const m = pools.flatMap((p, i) => roundRobin(p, dayAfter("2027-10-01", i)));
  assert.equal(m.length, 36);
  const { structure, groups } = classify(m);
  assert.equal(structure, "pools");
  assert.equal(groups.length, 6);
  assert.deepEqual(new Set(groups.map((g) => g.teams.length)), new Set([4]));
});

// --- negative cases: the shapes it must REFUSE ----------------------------
// A classifier verified only on inputs that match proves nothing about false
// positives, and a fabricated layout is exactly the failure this replaces.

test("an incomplete round robin is UNKNOWN, not a table", () => {
  const m = roundRobin(["1", "2", "3", "4"]).slice(0, 5); // one game missing
  assert.equal(classify(m).structure, "UNKNOWN");
});

test("a bipartite graph with a missing cross fixture is UNKNOWN, not a conference", () => {
  const m = cross(["1", "2", "3"], ["5", "6", "8"]).slice(0, 8);
  assert.equal(classify(m).structure, "UNKNOWN");
});

test("unequal pool sizes are UNKNOWN, not pools", () => {
  const m = [...roundRobin(["1", "2", "3", "4"]), ...roundRobin(["5", "6", "8"], "2026-03-01")];
  assert.equal(classify(m).structure, "UNKNOWN");
});

test("equal-sized but incomplete components are UNKNOWN", () => {
  const m = [
    ...roundRobin(["1", "2", "3", "4"]).slice(0, 5),
    ...roundRobin(["5", "6", "8", "10"], "2026-03-01").slice(0, 5),
  ];
  assert.equal(classify(m).structure, "UNKNOWN");
});

test("a knockout bracket is UNKNOWN — it is not any of the three shapes", () => {
  const m = [
    { teams: ["1", "2"], date: "2027-10-20" },
    { teams: ["3", "4"], date: "2027-10-21" },
    { teams: ["1", "3"], date: "2027-10-28" },
  ];
  assert.equal(classify(m).structure, "UNKNOWN");
});

test("empty and single-team inputs are UNKNOWN, never a table", () => {
  assert.equal(classify([]).structure, "UNKNOWN");
  assert.equal(classify([{ teams: ["1", "1"], date: "2026-01-01" }]).structure, "UNKNOWN");
});

test("a repeat meeting collapses to one edge — a double round robin is still a table", () => {
  const single = roundRobin(["1", "2", "3", "4"]);
  const m = [...single, ...single.map((g) => ({ ...g, date: dayAfter(g.date, 60) }))];
  assert.equal(m.length, 12);
  assert.equal(classify(m).structure, "table");
});

// --- the +2-week handover rule -------------------------------------------

test("chainDefaults partitions the calendar: no gaps, no overlaps, 14-day tail", () => {
  const comps = chainDefaults([
    { key: "a", startDate: "2026-07-04", endDate: "2026-11-21" },
    { key: "b", startDate: "2027-01-31", endDate: "2027-03-17" },
    { key: "c", startDate: "2027-10-01", endDate: "2027-10-17" },
  ]);
  assert.equal(comps[0].defaultFrom, "2026-07-04"); // first comp starts at its own start
  assert.equal(comps[0].defaultUntil, "2026-12-05"); // 21 Nov + 14
  assert.equal(comps[1].defaultFrom, "2026-12-05"); // the gap belongs to what's next
  assert.equal(comps[1].defaultUntil, "2027-03-31");
  assert.equal(comps[2].defaultFrom, "2027-03-31");
  assert.equal(comps[2].defaultUntil, "2027-10-31");
  assert.equal(TAIL_DAYS, 14);
});

test("chainDefaults skips competitions with no published fixtures", () => {
  const empty = { key: "6n-2027", startDate: null, endDate: null };
  const comps = chainDefaults([{ key: "rnc-2026", startDate: "2026-07-04", endDate: "2026-11-21" }, empty]);
  assert.equal(empty.defaultFrom, undefined);
  assert.equal(comps.find((c) => c.key === "rnc-2026").defaultUntil, "2026-12-05");
});

test("defaultCompetition: live comp, its 2-week tail, the gap, and off the ends", () => {
  const comps = chainDefaults([
    { key: "rnc-2026", startDate: "2026-07-04", endDate: "2026-11-21" },
    { key: "6n-2027", startDate: "2027-01-31", endDate: "2027-03-17" },
  ]);
  assert.equal(defaultCompetition(comps, "2026-09-01").key, "rnc-2026"); // mid-competition
  assert.equal(defaultCompetition(comps, "2026-11-28").key, "rnc-2026"); // inside the tail
  assert.equal(defaultCompetition(comps, "2026-12-20").key, "6n-2027"); // gap -> what's next
  assert.equal(defaultCompetition(comps, "2027-02-14").key, "6n-2027");
  assert.equal(defaultCompetition(comps, "2026-01-01"), null); // before everything
  assert.equal(defaultCompetition(comps, "2028-01-01"), null); // after everything
});

test("the handover happens exactly 14 days after the last fixture", () => {
  const comps = chainDefaults([
    { key: "rnc-2026", startDate: "2026-07-04", endDate: "2026-11-21" },
    { key: "6n-2027", startDate: "2027-01-31", endDate: "2027-03-17" },
  ]);
  assert.equal(defaultCompetition(comps, "2026-12-04").key, "rnc-2026"); // day 13
  assert.equal(defaultCompetition(comps, "2026-12-05").key, "6n-2027"); // day 14
});

// --- the 366-day scoreboard cap -------------------------------------------
// ESPN answers HTTP 400 for a longer range rather than truncating, so an
// unsliced padded window fails the whole build rather than quietly returning
// fewer fixtures.

test("sliceRange leaves a short window whole", () => {
  assert.deepEqual(sliceRange("2026-01-01", "2026-06-01"), [{ from: "2026-01-01", to: "2026-06-01" }]);
});

test("sliceRange never emits a slice longer than the cap, and covers the range exactly", () => {
  const slices = sliceRange("2025-10-03", "2027-04-01");
  assert.ok(slices.length > 1);
  assert.equal(slices[0].from, "2025-10-03");
  assert.equal(slices.at(-1).to, "2027-04-01");
  const days = (a, b) => (new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000 + 1;
  for (const s of slices) assert.ok(days(s.from, s.to) <= MAX_RANGE_DAYS, `${s.from}..${s.to} too long`);
  // Contiguous: each slice starts the day after the previous one ends.
  for (let i = 1; i < slices.length; i++) assert.equal(days(slices[i - 1].to, slices[i].from), 2);
});

test("sliceRange handles a range exactly at the cap", () => {
  const slices = sliceRange("2026-01-01", "2027-01-01");
  assert.equal(slices.length, 1);
});

// --- status ---------------------------------------------------------------

test("statusFor covers announced / scheduled / live / complete", () => {
  const c = { fixtureCount: 36, startDate: "2026-07-04", endDate: "2026-11-21" };
  assert.equal(statusFor({ ...c, fixtureCount: 0 }, "2026-08-01"), "announced");
  assert.equal(statusFor(c, "2026-05-01"), "scheduled");
  assert.equal(statusFor(c, "2026-08-01"), "live");
  assert.equal(statusFor(c, "2026-12-01"), "complete");
});

// --- entry assembly -------------------------------------------------------

const META = { prefix: "rwc", short: "RWC", name: "Rugby World Cup", espnLeagueId: 164205 };
const espnEvent = (date, homeId, awayId) => ({
  date: `${date}T10:45Z`,
  competitions: [
    {
      competitors: [
        { team: { id: String(homeId), abbreviation: "H" } },
        { team: { id: String(awayId), abbreviation: "A" } },
      ],
    },
  ],
});

test("entryFor derives dates from the FIXTURES, never from vendor season metadata", () => {
  // ESPN reports this league's season as 2023-09-08..2023-10-29. The fixtures
  // say 2027-10-01..2027-10-17, and the fixtures win.
  const events = [espnEvent("2027-10-01", 6, 289268), espnEvent("2027-10-17", 1, 4)];
  const e = entryFor(META, 2027, events, "2026-07-25");
  assert.equal(e.startDate, "2027-10-01");
  assert.equal(e.endDate, "2027-10-17");
  assert.equal(e.key, "rwc-2027");
  assert.equal(e.label, "RWC '27");
  assert.equal(e.fixtureCount, 2);
  assert.equal(e.status, "scheduled");
});

test("entryFor maps ESPN ids to our codes, not ESPN's abbreviations", () => {
  // ESPN calls these SOU / JAP / HON / SPA / ROM / TON.
  const events = [espnEvent("2027-10-01", 5, 23), espnEvent("2027-10-02", 289268, 289211)];
  const e = entryFor(META, 2027, events, "2026-07-25");
  assert.deepEqual(e.teams, ["ESP", "HKG", "JPN", "RSA"]);
});

test("entryFor on a season with no published fixtures: announced, null structure", () => {
  const e = entryFor({ prefix: "6n", short: "6N", name: "Six Nations", espnLeagueId: 180659 }, 2027, [], "2026-07-25");
  assert.equal(e.status, "announced");
  assert.equal(e.fixtureCount, 0);
  assert.equal(e.structure, null);
  assert.equal(e.startDate, null);
});

test("entryFor names conference sides only when every team agrees on a hemisphere", () => {
  const north = [1, 2, 3, 4, 9, 20];
  const south = [5, 6, 8, 10, 14, 23];
  const events = [];
  let d = 0;
  for (const x of north) for (const y of south) events.push(espnEvent(dayAfter("2026-07-04", d++), x, y));
  const meta = { prefix: "rnc", short: "RNC", name: "Nations Championship", espnLeagueId: 17567 };
  const e = entryFor(meta, 2026, events, "2026-07-20"); // inside the 4 Jul–8 Aug span
  assert.equal(e.structure, "conference");
  assert.deepEqual(e.groups.map((g) => g.name).sort(), ["North", "South"]);
  assert.equal(e.status, "live");
});

test("an unrecognised team leaves both conference names null rather than guessing", () => {
  const north = [1, 2, 3, 4, 9, 20];
  const south = [5, 6, 8, 10, 14, 999999]; // 999999 has no hemisphere
  const events = [];
  let d = 0;
  for (const x of north) for (const y of south) events.push(espnEvent(dayAfter("2026-07-04", d++), x, y));
  const meta = { prefix: "rnc", short: "RNC", name: "Nations Championship", espnLeagueId: 17567 };
  const e = entryFor(meta, 2026, events, "2026-09-01");
  assert.equal(e.structure, "conference");
  assert.deepEqual(e.groups.map((g) => g.name), [null, null]);
});

test("pool groups carry no invented letters", () => {
  const pools = [
    [10, 25, 14, 289211],
    [6, 289243, 289268, 8],
    [1, 16, 4, 289356],
  ];
  const events = [];
  let d = 0;
  for (const p of pools) {
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) events.push(espnEvent(dayAfter("2027-10-01", d++), p[i], p[j]));
    }
  }
  const e = entryFor(META, 2027, events, "2026-07-25");
  assert.equal(e.structure, "pools");
  assert.equal(e.groups.length, 3);
  assert.deepEqual(new Set(e.groups.map((g) => g.name)), new Set([null]));
});
