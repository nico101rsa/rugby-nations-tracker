import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  classify,
  chainDefaults,
  defaultCompetition,
  statusFor,
  entryFor,
  namePools,
  sliceRange,
  yearsBetween,
  inWindow,
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

// --- per-year fetching (ESPN dropped day ranges, 18 Sep 2026) --------------

test("yearsBetween lists every calendar year a window touches", () => {
  assert.deepEqual(yearsBetween("2026-07-04", "2026-11-21"), ["2026"]);
  assert.deepEqual(yearsBetween("2025-10-03", "2027-04-01"), ["2025", "2026", "2027"]);
});

test("inWindow keeps only events dated inside the window", () => {
  const win = { from: "2026-07-04", to: "2026-11-21" };
  assert.equal(inWindow({ date: "2026-08-15T05:05Z" }, win), true);
  assert.equal(inWindow({ date: "2026-07-04T23:00Z" }, win), true);
  assert.equal(inWindow({ date: "2026-11-22T00:00Z" }, win), false);
  assert.equal(inWindow({}, win), false);
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
  // None of these three sets is a drawn RWC 2027 pool (each mixes two pools),
  // so nothing may letter them — letters only come from an exact draw match.
  const pools = [
    [10, 25, 14, 8], // ARG CAN FIJ + NZL (Pool C has ESP, not NZL)
    [6, 289243, 289268, 289211], // AUS CHI HKG + ESP
    [1, 16, 4, 12], // ENG TGA WAL + ROU (Pool F has ZIM)
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
  assert.deepEqual(new Set(e.groups.map((g) => g.pool)), new Set([null]));
});

// --- pool letters from the official draw (competition-rules.mjs) ----------
// The letter goes in `groups[].pool` and `name` stays null: every installed
// app up to 1.3.9 renders a group heading as `g.name ?? "Pool ${i + 1}"` next
// to "the official pool letters aren't published in our data source"
// (LogTab.jsx LineUp), so a pool `name` of "A" would put a bare "A" on every
// phone under a sentence that is then false (review of PR #146).
//
// competitions.json's six rwc-2027 groups in registry order (earliest kickoff).
const RWC_2027_GROUPS = () => [
  { name: null, teams: ["AUS", "HKG", "CHI", "NZL"] },
  { name: null, teams: ["WAL", "ENG", "TGA", "ZIM"] },
  { name: null, teams: ["FRA", "USA", "SAM", "JPN"] },
  { name: null, teams: ["RSA", "ROU", "GEO", "ITA"] },
  { name: null, teams: ["SCO", "URU", "POR", "IRE"] },
  { name: null, teams: ["FIJ", "ARG", "CAN", "ESP"] },
];

test("namePools letters the six RWC 2027 pools A, F, E, B, D, C in registry order", () => {
  const groups = namePools("rwc-2027", RWC_2027_GROUPS());
  assert.deepEqual(groups.map((g) => g.pool), ["A", "F", "E", "B", "D", "C"]);
  // Order and members untouched.
  assert.deepEqual(groups.map((g) => g.teams), RWC_2027_GROUPS().map((g) => g.teams));
});

test("namePools never writes a pool's name: the shipped app prints `name` as the bare heading", () => {
  const groups = namePools("rwc-2027", RWC_2027_GROUPS());
  assert.deepEqual(groups.map((g) => g.name), [null, null, null, null, null, null]);
  // What the 1.3.9 LineUp renders from these groups (LogTab.jsx:116 on app
  // main): still "Pool 1".."Pool 6", exactly as before the letters existed.
  const shippedLabel = (g, i) => g.name ?? `Pool ${i + 1}`;
  assert.deepEqual(groups.map(shippedLabel), ["Pool 1", "Pool 2", "Pool 3", "Pool 4", "Pool 5", "Pool 6"]);
});

test("namePools leaves a group's letter null when its team set differs by one code", () => {
  const groups = RWC_2027_GROUPS();
  groups[0].teams = ["AUS", "HKG", "CHI", "FIJ"]; // NZL swapped out
  namePools("rwc-2027", groups);
  assert.equal(groups[0].pool, null);
  assert.equal(groups[0].name, null);
  assert.equal(groups[1].pool, "F");
});

test("namePools needs the exact size: a 3-team or 5-team group gets no letter", () => {
  const three = [{ name: null, teams: ["NZL", "AUS", "CHI"] }];
  const five = [{ name: null, teams: ["NZL", "AUS", "CHI", "HKG", "FIJ"] }];
  assert.equal(namePools("rwc-2027", three)[0].pool, null);
  assert.equal(namePools("rwc-2027", five)[0].pool, null);
});

test("namePools leaves competitions with no recorded draw untouched", () => {
  const groups = RWC_2027_GROUPS();
  namePools("rwc-2031", groups);
  assert.deepEqual(groups, RWC_2027_GROUPS(), "no pool field, names still null");
  const conf = [{ name: "North", teams: ["ENG"] }];
  namePools("rnc-2026", conf);
  assert.deepEqual(conf, [{ name: "North", teams: ["ENG"] }]);
});

test("entryFor letters drawn pools for rwc-2027 and only for it, names stay null", () => {
  const ids = Object.fromEntries(Object.entries({
    1: "ENG", 2: "SCO", 3: "IRE", 4: "WAL", 5: "RSA", 6: "AUS", 8: "NZL", 9: "FRA", 10: "ARG", 14: "FIJ",
    20: "ITA", 23: "JPN", 11: "USA", 12: "ROU", 15: "SAM", 16: "TGA", 25: "CAN", 27: "POR", 29: "URU",
    81: "GEO", 289211: "ESP", 289243: "CHI", 289268: "HKG", 289356: "ZIM",
  }).map(([id, c]) => [c, Number(id)]));
  const events = [];
  let d = 0;
  for (const g of RWC_2027_GROUPS()) {
    const p = g.teams.map((c) => ids[c]);
    for (let i = 0; i < p.length; i++) {
      for (let j = i + 1; j < p.length; j++) events.push(espnEvent(dayAfter("2027-10-01", d++), p[i], p[j]));
    }
  }
  const e = entryFor(META, 2027, events, "2026-10-12");
  assert.equal(e.structure, "pools");
  assert.deepEqual(e.groups.map((g) => g.pool), ["A", "F", "E", "B", "D", "C"]);
  assert.deepEqual(e.groups.map((g) => g.name), [null, null, null, null, null, null]);
  // The same draw under a different season is not the 2027 draw.
  const later = entryFor(META, 2031, events.map((ev) => ({ ...ev, date: ev.date.replace("2027", "2031") })), "2026-10-12");
  assert.deepEqual(new Set(later.groups.map((g) => g.name)), new Set([null]));
  assert.ok(later.groups.every((g) => !("pool" in g)));
});

// The committed file is what Pages serves to every installed phone. This only
// asserts what code alone controls (no vendor change can set a pool's name),
// so it can't fail on a legitimate data change — the suite gates the digest
// and competitions jobs. Lift it only once no supported app build renders a
// pool's `name` bare (an app that reads `pool` never needs `name` set).
test("committed competitions.json: every pool's name is null (its letter, if any, is in `pool`)", async () => {
  const reg = JSON.parse(await readFile(new URL("../competitions.json", import.meta.url), "utf8"));
  for (const c of reg.competitions ?? []) {
    if (c.structure !== "pools" || !Array.isArray(c.groups)) continue;
    for (const g of c.groups) {
      assert.equal(g.name, null, `${c.key}: a pool group has name ${JSON.stringify(g.name)}; the shipped app would print it bare`);
      assert.ok(g.pool === undefined || g.pool === null || /^[A-Z]$/.test(g.pool), `${c.key}: pool ${JSON.stringify(g.pool)} is not a letter`);
    }
  }
});

// --- side competitions (the Pacific Nations Cup) ----------------------------
// Japan v USA, the 2026 PNC semi-final, never reached the app: nothing knew
// the league. The PNC runs INSIDE the Nations Championship's window, is a
// knockout (none of the classifier's shapes), and ESPN numbers its seasons by
// the following year. Each of those needed a flag on the registry meta.

const PNC = {
  prefix: "pnc", short: "PNC", name: "Pacific Nations Cup", espnLeagueId: 256449,
  structure: "knockout", headline: false, seasonFromFixtures: true,
};

test("a declared structure is published as stated, not classified", () => {
  // Semis + final + 3rd place form a 4-cycle, which the graph would call a
  // two-team-a-side "conference". The meta says knockout, so it is knockout.
  const events = [
    espnEvent("2026-09-11", 14, 25), // FIJ v CAN
    espnEvent("2026-09-12", 23, 11), // JPN v USA
    espnEvent("2026-09-19", 23, 14), // final
    espnEvent("2026-09-19", 11, 25), // 3rd place
  ];
  const e = entryFor(PNC, 2027, events, "2026-09-12");
  assert.equal(e.structure, "knockout");
  assert.equal(e.groups, null);
  assert.deepEqual(e.teams, ["CAN", "FIJ", "JPN", "USA"]);
  assert.equal(e.headline, false);
});

test("seasonFromFixtures keys the entry by the fixtures' year, not ESPN's season number", () => {
  const events = [espnEvent("2026-09-12", 23, 11), espnEvent("2026-09-19", 23, 14)];
  const e = entryFor(PNC, 2027, events, "2026-09-12");
  assert.equal(e.key, "pnc-2026");
  assert.equal(e.label, "PNC '26");
  assert.equal(e.season, 2026);
  // With nothing published there is no year to read; the vendor's number stands.
  assert.equal(entryFor(PNC, 2027, [], "2026-09-12").key, "pnc-2027");
});

test("the four headline competitions are untouched by the new flags", () => {
  const e = entryFor(META, 2027, [espnEvent("2027-10-01", 6, 289268)], "2026-07-25");
  assert.equal(e.key, "rwc-2027");
  assert.equal("headline" in e, false);
});

test("a side competition gets its own window but stays out of the chain", () => {
  const comps = chainDefaults([
    { key: "rnc-2026", startDate: "2026-07-04", endDate: "2026-11-21" },
    { key: "pnc-2026", startDate: "2026-09-11", endDate: "2026-09-19", headline: false },
    { key: "6n-2027", startDate: "2027-01-31", endDate: "2027-03-17" },
  ]);
  const [rnc, pnc, six] = comps;
  // Offered for its own span plus the tail — that is what the dropdown expires on.
  assert.equal(pnc.defaultFrom, "2026-09-11");
  assert.equal(pnc.defaultUntil, "2026-10-03");
  // The chain runs past it as if it were not there: RNC hands to the Six
  // Nations on 5 Dec, not the PNC to the Six Nations on 3 Oct.
  assert.equal(rnc.defaultUntil, "2026-12-05");
  assert.equal(six.defaultFrom, "2026-12-05");
});

test("a side competition never becomes the app's default, even mid-tournament", () => {
  const comps = chainDefaults([
    { key: "rnc-2026", startDate: "2026-07-04", endDate: "2026-11-21" },
    { key: "pnc-2026", startDate: "2026-09-11", endDate: "2026-09-19", headline: false },
  ]);
  assert.equal(defaultCompetition(comps, "2026-09-12").key, "rnc-2026");
  assert.equal(defaultCompetition(comps, "2026-09-25").key, "rnc-2026"); // inside the PNC tail
  // Even with nothing else on, a side comp is not promoted.
  assert.equal(defaultCompetition([comps[1]], "2026-09-12"), null);
});
