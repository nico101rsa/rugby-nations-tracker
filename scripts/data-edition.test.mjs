import test from "node:test";
import assert from "node:assert/strict";
import {
  orderedGames, currentStreak, formSummary, lastMeeting, rankHistoryFact,
  scoringProfile, describeGame, angleFor, buildDataEdition, renderDataEdition, ANGLES,
} from "./data-edition.mjs";

// Fiji's real shape: four of eleven opponents sit outside the tracked 12 and
// carry `opponentCode: null`. This fixture exists to catch the exact regression
// docs/adr/0002 warns about.
const FIJI_GAMES = {
  1: { id: 1, date: "2026-07-11T00:00:00.000Z", opponent: "Scotland", opponentCode: "SCO", tracked: true, homeAway: "A", us: 17, them: 33, result: "L", tries: 2, league: "Nations Championship" },
  2: { id: 2, date: "2026-07-04T00:00:00.000Z", opponent: "England", opponentCode: "ENG", tracked: true, homeAway: "A", us: 8, them: 73, result: "L", tries: 1, league: "Nations Championship" },
  3: { id: 3, date: "2026-06-27T00:00:00.000Z", opponent: "Wales", opponentCode: "WAL", tracked: true, homeAway: "A", us: 24, them: 39, result: "L", tries: 3, league: "Nations Championship" },
  4: { id: 4, date: "2026-06-20T00:00:00.000Z", opponent: "Spain", opponentCode: null, tracked: false, homeAway: "H", us: 41, them: 33, result: "W", tries: 6, league: "International Friendly" },
  5: { id: 5, date: "2026-06-13T00:00:00.000Z", opponent: "Tonga", opponentCode: null, tracked: false, homeAway: "H", us: 36, them: 20, result: "W", tries: 5, league: "Pacific Nations Cup" },
};

test("orderedGames sorts newest-first and drops games without a result", () => {
  const withPending = { ...FIJI_GAMES, 9: { id: 9, date: "2026-08-01T00:00:00.000Z", opponent: "Samoa", result: null } };
  const ordered = orderedGames(withPending);
  assert.equal(ordered.length, 5);
  assert.equal(ordered[0].opponent, "Scotland");
  assert.equal(ordered.at(-1).opponent, "Tonga");
});

test("orderedGames survives an unparseable date by sorting it last", () => {
  const ordered = orderedGames({ ...FIJI_GAMES, 9: { id: 9, date: "not a date", opponent: "Samoa", result: "W" } });
  assert.equal(ordered.at(-1).opponent, "Samoa");
});

test("lastMeeting matches on opponent NAME, so untracked nations are not dropped", () => {
  const ordered = orderedGames(FIJI_GAMES);
  // The regression guard: Spain has opponentCode null. Keying off the code
  // would return null here and silently lose 4 of Fiji's 11 games.
  const spain = lastMeeting(ordered, "Spain");
  assert.ok(spain, "Spain must be findable despite a null opponentCode");
  assert.equal(spain.result, "W");
  assert.equal(spain.opponentCode, null);
});

test("lastMeeting normalises 'The Barbarians' against 'Barbarians'", () => {
  const ordered = orderedGames({ 1: { id: 1, date: "2026-05-01T00:00:00.000Z", opponent: "The Barbarians", opponentCode: null, tracked: false, homeAway: "H", us: 80, them: 31, result: "W" } });
  assert.ok(lastMeeting(ordered, "Barbarians"));
  assert.ok(lastMeeting(ordered, "The Barbarians"));
});

test("lastMeeting returns the MOST RECENT meeting when there are several", () => {
  const ordered = orderedGames({
    1: { id: 1, date: "2026-07-01T00:00:00.000Z", opponent: "Wales", opponentCode: "WAL", tracked: true, us: 20, them: 10, result: "W" },
    2: { id: 2, date: "2025-07-01T00:00:00.000Z", opponent: "Wales", opponentCode: "WAL", tracked: true, us: 5, them: 30, result: "L" },
  });
  assert.equal(lastMeeting(ordered, "Wales").result, "W");
});

test("lastMeeting returns null for an opponent never met, and for junk input", () => {
  const ordered = orderedGames(FIJI_GAMES);
  assert.equal(lastMeeting(ordered, "Japan"), null);
  assert.equal(lastMeeting(ordered, ""), null);
  assert.equal(lastMeeting(ordered, null), null);
});

test("currentStreak counts only the unbroken run, and a draw breaks it", () => {
  const ordered = orderedGames(FIJI_GAMES);
  assert.deepEqual(currentStreak(ordered), { type: "L", count: 3 });

  const drawFirst = orderedGames({
    1: { id: 1, date: "2026-07-11T00:00:00.000Z", opponent: "A", us: 10, them: 10, result: "D" },
    2: { id: 2, date: "2026-07-04T00:00:00.000Z", opponent: "B", us: 20, them: 10, result: "W" },
    3: { id: 3, date: "2026-06-27T00:00:00.000Z", opponent: "C", us: 20, them: 10, result: "W" },
  });
  // A draw must NOT be folded into the wins as a "3-game unbeaten run".
  assert.deepEqual(currentStreak(drawFirst), { type: "D", count: 1 });
});

test("currentStreak is null on an empty archive", () => {
  assert.equal(currentStreak([]), null);
});

test("formSummary tallies the window and names its span", () => {
  const form = formSummary(orderedGames(FIJI_GAMES));
  assert.equal(form.span, 5);
  assert.equal(form.won, 2);
  assert.equal(form.lost, 3);
  assert.deepEqual(form.sequence, ["L", "L", "L", "W", "W"]);
});

test("formSummary respects a shorter archive than the window", () => {
  const form = formSummary(orderedGames({ 1: FIJI_GAMES[1] }));
  assert.equal(form.span, 1);
  assert.equal(form.lost, 1);
});

// ---- the streak-first ranking contract --------------------------------------

const NZL_STATS = {
  best: { rank: 1, years: "2003, 2009–19" },
  worst: { rank: 5, years: "2022" },
  no1: { totalWeeks: 748, longestWeeks: 509, longestFrom: "2009-11-15", longestTill: "2019-08-19", spells: 9, currentSince: null },
};
const RSA_STATS = {
  best: { rank: 1, years: "2019, 2025–26" },
  worst: { rank: 7, years: "2017" },
  no1: { totalWeeks: 329, longestWeeks: 97, longestFrom: "2019-11-10", longestTill: "2021-09-20", spells: 8, currentSince: "2025-09-15" },
};
const FIJ_STATS = { best: { rank: 7, years: "2023" }, worst: { rank: 16, years: "2011, 2012" }, no1: null };

test("rankHistoryFact leads with the UNBROKEN streak, never the cumulative total", () => {
  const line = rankHistoryFact(NZL_STATS);
  assert.match(line, /509 weeks/);
  // The whole point of the rule: 748 is a sum of nine separate spells and reads
  // as a streak to any fan. It must not appear anywhere in the output.
  assert.doesNotMatch(line, /748/, "cumulative totalWeeks must never reach copy");
});

test("rankHistoryFact prefers a CURRENT No. 1 spell over the historical streak", () => {
  const line = rankHistoryFact(RSA_STATS);
  assert.match(line, /continuously since September 2025/);
  assert.doesNotMatch(line, /329/);
  assert.doesNotMatch(line, /97/);
});

test("rankHistoryFact falls back to best-ever rank for a team never No. 1", () => {
  const line = rankHistoryFact(FIJ_STATS);
  assert.match(line, /No\. 7/);
  assert.match(line, /2023/);
});

test("rankHistoryFact singularises a one-week spell", () => {
  const line = rankHistoryFact({ best: { rank: 1 }, no1: { totalWeeks: 1, longestWeeks: 1, longestFrom: "2022-07-11", longestTill: "2022-07-18", currentSince: null } });
  assert.match(line, /1 week\b/);
  assert.doesNotMatch(line, /1 weeks/);
});

test("rankHistoryFact returns null rather than guessing when stats are absent", () => {
  assert.equal(rankHistoryFact(null), null);
  assert.equal(rankHistoryFact({}), null);
  assert.equal(rankHistoryFact({ best: {}, no1: null }), null);
});

// ---- rendering ---------------------------------------------------------------

test("describeGame reports the score winner-first and marks home/away", () => {
  assert.match(describeGame(FIJI_GAMES[4]), /beat Spain 41-33 at home in June 2026/);
  // A loss reads "lost to X 33-17" — the winning score first, as a desk would.
  assert.match(describeGame(FIJI_GAMES[1]), /lost to Scotland 33-17 away/);
});

test("describeGame returns null for a missing game", () => {
  assert.equal(describeGame(null), null);
});

test("angleFor is stable for a team on a day and varies across teams", () => {
  assert.equal(angleFor("2026-07-21", "FIJ"), angleFor("2026-07-21", "FIJ"));
  const spread = new Set(["FIJ", "JPN", "ITA", "SCO", "ARG", "AUS", "WAL", "ENG"].map((t) => angleFor("2026-07-21", t)));
  assert.ok(spread.size > 1, "all twelve teams must not take the same angle on the same day");
});

test("angleFor eventually covers every angle across a run of days", () => {
  const seen = new Set();
  for (let d = 1; d <= 28; d++) seen.add(angleFor(`2026-07-${String(d).padStart(2, "0")}`, "FIJ"));
  assert.deepEqual([...seen].sort(), [...ANGLES].sort());
});

test("buildDataEdition returns facts with the angle named", () => {
  const ed = buildDataEdition({
    teamCode: "FIJ", teamName: "Fiji", games: FIJI_GAMES,
    rankingStats: FIJ_STATS, nextOpponent: "Scotland", dateISO: "2026-07-21",
  });
  assert.ok(ed);
  assert.ok(ANGLES.includes(ed.angle));
  assert.ok(ed.lines.length >= 1);
});

test("buildDataEdition attaches the no-aggregation guard to the lastMeeting angle", () => {
  // Force the angle by offering only that one.
  const ordered = orderedGames(FIJI_GAMES);
  const meeting = lastMeeting(ordered, "Scotland");
  assert.ok(meeting);
  // Sweep dates until lastMeeting is the chosen angle, then assert the guard.
  let found = null;
  for (let d = 1; d <= 31 && !found; d++) {
    const dateISO = `2026-07-${String(d).padStart(2, "0")}`;
    const ed = buildDataEdition({ teamCode: "FIJ", teamName: "Fiji", games: FIJI_GAMES, rankingStats: FIJ_STATS, nextOpponent: "Scotland", dateISO });
    if (ed.angle === "lastMeeting") found = ed;
  }
  assert.ok(found, "lastMeeting angle should be reachable");
  assert.ok(found.lines.some((l) => /not a head-to-head record/i.test(l)),
    "the anti-aggregation guard must travel with the fact");
});

test("buildDataEdition falls through when the preferred angle has no data", () => {
  // No next opponent and no ranking stats: only form/scoring can answer.
  const ed = buildDataEdition({
    teamCode: "FIJ", teamName: "Fiji", games: FIJI_GAMES,
    rankingStats: null, nextOpponent: null, dateISO: "2026-07-21",
  });
  assert.ok(ed);
  assert.ok(["form", "scoring"].includes(ed.angle));
});

test("buildDataEdition returns null on an empty archive — the signal to fall to the honest rung", () => {
  assert.equal(buildDataEdition({ teamCode: "FIJ", teamName: "Fiji", games: {}, rankingStats: FIJ_STATS, nextOpponent: "Wales", dateISO: "2026-07-21" }), null);
});

test("renderDataEdition bans meta-commentary and demands the window be stated", () => {
  const ed = buildDataEdition({ teamCode: "FIJ", teamName: "Fiji", games: FIJI_GAMES, rankingStats: FIJ_STATS, nextOpponent: "Scotland", dateISO: "2026-07-21" });
  const text = renderDataEdition(ed, "Fiji");
  assert.match(text, /Do NOT write about the absence of news/);
  assert.match(text, /never weld two of them together/);
  assert.match(text, /in their last five/);
});

test("renderDataEdition is empty for a null edition", () => {
  assert.equal(renderDataEdition(null, "Fiji"), "");
});
