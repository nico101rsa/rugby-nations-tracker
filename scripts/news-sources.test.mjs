import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mentionsTeam,
  TEAM_ALIASES,
  significantTokens,
  titleSimilarity,
  clusterStories,
  ageHours,
  scoreStory,
  isMatchReport,
  isFresh,
  firstSeenAt,
  FRESH_HOURS,
  buildShortlist,
  isQuiet,
  renderShortlist,
  QUIET_THRESHOLD,
  subjectWeight,
} from "./news-sources.mjs";

const NOW = new Date("2026-07-20T10:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toUTCString();

// Real Planet Rugby / BBC headlines pulled 2026-07-20 — the day the Bok edition
// led with the log table while these were on the wire.
const item = (title, over = {}) => ({
  title,
  link: "https://example.test/x",
  desc: "",
  date: hoursAgo(4),
  feedId: "planetrugby",
  feedName: "Planet Rugby",
  position: 0,
  ...over,
});

// Real mis-filings from the 2026-07-20 live run, when aboutness was tested
// against title + description. Every one of these is a story about ANOTHER team
// that merely mentions this one in passing.
test("buildShortlist: a passing mention in the description is not aboutness", () => {
  const wrongTeamStories = [
    [391, item("Watch: Boks' new bash brothers", { desc: "…after the win over Wales" })],
    [28, item("Room for improvement but Scotland heading in right direction", { desc: "Scotland beat Fiji" })],
    [389, item("Readers reply: why is there no rugby culture in Germany?", { desc: "unlike Italy and France" })],
    [460, item("Feyi-Waboso gives England more bite", { desc: "ahead of the Argentina tour" })],
  ];
  for (const [teamId, story] of wrongTeamStories) {
    assert.deepEqual(buildShortlist([story], teamId, NOW), [], `${story.title} is not a story about team ${teamId}`);
  }
});

test("buildShortlist: the team in the title IS aboutness, even unflatteringly", () => {
  const list = buildShortlist([item("Scotland flirt with defeat before overpowering Fiji")], 28, NOW);
  assert.equal(list.length, 1, "a Fiji defeat is still a Fiji story");
});

test("mentionsTeam: matches team names, nicknames and coaches", () => {
  const boks = TEAM_ALIASES[467];
  assert.ok(mentionsTeam("Rassie Erasmus provides Sacha Feinberg-Mngomezulu fitness update", boks));
  assert.ok(mentionsTeam("South Africa sweep the southern leg", boks));
  assert.ok(mentionsTeam("Springboks bolter named in Team of the Week", boks));
});

// The extractor is only proven by inputs that must NOT match. Verifying it on
// text containing the target says nothing about false positives.
test("mentionsTeam: negative cases", () => {
  assert.equal(mentionsTeam("New South Wales Waratahs sign a lock", TEAM_ALIASES[391]), false);
  assert.equal(mentionsTeam("Wales U20 fall short in Italy", TEAM_ALIASES[391]), false);
  assert.equal(mentionsTeam("Tonga hold on against Samoa", TEAM_ALIASES[463]), false);
  assert.equal(mentionsTeam("Georgia push for Six Nations promotion", TEAM_ALIASES[389]), false);
  assert.equal(mentionsTeam("Englander named in Barbarians squad", TEAM_ALIASES[386]), false);
  assert.equal(mentionsTeam("", TEAM_ALIASES[467]), false);
});

test("mentionsTeam: accented aliases match at a word boundary", () => {
  assert.ok(mentionsTeam("Fabien Galthié names his side", TEAM_ALIASES[387]));
  assert.ok(mentionsTeam("Galthie under pressure", TEAM_ALIASES[387]));
});

test("significantTokens: strips stopwords and punctuation, keeps names", () => {
  const t = significantTokens("Rassie Erasmus' honest 'pressure' admission over certain Springboks");
  assert.ok(t.has("erasmus"));
  assert.ok(t.has("springboks"));
  assert.ok(!t.has("the"));
  assert.ok(!t.has("over"));
});

test("titleSimilarity: same story across outlets scores high", () => {
  const a = "Rassie Erasmus provides Sacha Feinberg-Mngomezulu fitness update and reveals Handre Pollard pulled his hamstring";
  const b = "Erasmus gives Feinberg-Mngomezulu fitness update as Pollard suffers hamstring blow";
  assert.ok(titleSimilarity(a, b) >= 0.34, `expected a cluster, got ${titleSimilarity(a, b)}`);
});

test("titleSimilarity: different stories about the same team score low", () => {
  const a = "Rassie Erasmus provides Sacha Feinberg-Mngomezulu fitness update";
  const b = "Nick Mallett: Really stupid development ex-Springboks boss feels is a blight on rugby";
  assert.ok(titleSimilarity(a, b) < 0.34, `expected no cluster, got ${titleSimilarity(a, b)}`);
});

test("clusterStories: counts distinct outlets, keeps the best-placed item", () => {
  const clusters = clusterStories([
    item("Erasmus provides Feinberg-Mngomezulu fitness update", { feedId: "planetrugby", position: 3 }),
    item("Erasmus gives Feinberg-Mngomezulu fitness update", { feedId: "bbc", feedName: "BBC", position: 1 }),
    item("Nick Mallett calls development a blight on rugby", { feedId: "planetrugby", position: 5 }),
  ]);
  assert.equal(clusters.length, 2);
  const lead = clusters[0];
  assert.equal(lead.corroboration, 2);
  assert.equal(lead.position, 1, "cluster takes the earliest feed position");
  assert.equal(lead.feedName, "BBC", "representative is the outlet that led with it");
  assert.equal(clusters[1].corroboration, 1);
});

test("clusterStories: two items from the SAME outlet do not inflate corroboration", () => {
  const [c] = clusterStories([
    item("Erasmus provides Feinberg-Mngomezulu fitness update", { feedId: "planetrugby", position: 1 }),
    item("Erasmus gives Feinberg-Mngomezulu his fitness update", { feedId: "planetrugby", position: 6 }),
  ]);
  assert.equal(c.corroboration, 1);
});

test("ageHours: parses pubDate, tolerates rubbish", () => {
  assert.equal(Math.round(ageHours(hoursAgo(6), NOW)), 6);
  assert.equal(ageHours("not a date", NOW), null);
  assert.equal(ageHours(undefined, NOW), null);
});

test("scoreStory: corroboration outranks a well-placed solo story", () => {
  const solo = scoreStory({ corroboration: 1, position: 0, date: hoursAgo(2) }, NOW);
  const corroborated = scoreStory({ corroboration: 3, position: 4, date: hoursAgo(8) }, NOW);
  assert.ok(corroborated > solo, `${corroborated} should beat ${solo}`);
});

test("scoreStory: fresh beats stale, all else equal", () => {
  const fresh = scoreStory({ corroboration: 2, position: 2, date: hoursAgo(3) }, NOW);
  const stale = scoreStory({ corroboration: 2, position: 2, date: hoursAgo(72) }, NOW);
  assert.ok(fresh > stale);
});

test("scoreStory: a missing pubDate is neutral-old, not zero", () => {
  const undated = scoreStory({ corroboration: 2, position: 1, date: null }, NOW);
  const ancient = scoreStory({ corroboration: 2, position: 1, date: hoursAgo(240) }, NOW);
  assert.ok(undated > ancient, "a broken pubDate must not bury a good story");
});

test("isMatchReport: scorelines, ratings and listicles", () => {
  assert.ok(isMatchReport("South Africa 43-0 Wales: Boks run riot"));
  assert.ok(isMatchReport("Player ratings: England v Argentina"));
  assert.ok(isMatchReport("Nations Championship Team of the Week"));
  assert.equal(isMatchReport("Rassie Erasmus provides fitness update"), false);
});

// The case that started all of this: on 2026-07-20 the Bok briefing led with the
// log table while these were the actual stories.
test("buildShortlist: the Bok case — team news outranks the log-table recap", () => {
  const feed = [
    item("Nations Championship Team of the Week: Springboks bolter and England stars", { position: 0 }),
    item("Rassie Erasmus provides Sacha Feinberg-Mngomezulu fitness update and reveals Handre Pollard pulled his hamstring", { position: 1 }),
    item("Erasmus gives Feinberg-Mngomezulu fitness update as Pollard suffers hamstring blow", { position: 2, feedId: "bbc", feedName: "BBC" }),
    item("Nick Mallett: Really stupid development ex-Springboks boss feels is a blight on rugby", { position: 5, date: hoursAgo(9) }),
    item("Joe Schmidt makes blunt revelation on Wallabies progress", { position: 6 }),
  ];
  const list = buildShortlist(feed, 467, NOW);
  assert.match(list[0].title, /Feinberg-Mngomezulu/, "the corroborated fitness story must lead");
  assert.equal(list[0].corroboration, 2);
  assert.ok(!list.some((s) => /Wallabies progress/.test(s.title)), "a pure Australia story is not a Bok candidate");
  assert.ok(list.some((s) => /Mallett/.test(s.title)), "the Mallett story stays a candidate");
});

test("buildShortlist: caps the list and sorts by score", () => {
  // Genuinely unrelated Bok stories — an earlier version of this test used
  // near-identical filler titles, which correctly clustered into ONE story and
  // proved nothing about the cap.
  const feed = [
    "Rassie Erasmus hails his bolter after the Wales sweep",
    "Nick Mallett brands the breakdown ruling a blight on rugby",
    "Handre Pollard faces a spell out with a hamstring strain",
    "Springboks confirm Argentina tour venues for next month",
    "Sacha Feinberg-Mngomezulu cleared to return in Turin",
    "South Africa announce a new defence coach on a two-year deal",
    "Bok prop signs a contract extension until 2029",
    "Erasmus opens up on the pressure of an unbeaten run",
    "Springbok sevens graduate earns a first senior call-up",
  ].map((title, n) => item(title, { position: n }));
  const list = buildShortlist(feed, 467, NOW);
  assert.equal(list.length, 5);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].score >= list[i].score);
});

test("buildShortlist: a team with no coverage gets an empty list, not a throw", () => {
  const feed = [item("Rassie Erasmus provides a fitness update")];
  assert.deepEqual(buildShortlist(feed, 28, NOW), []);
});

test("buildShortlist: unknown team id throws rather than silently returning nothing", () => {
  assert.throws(() => buildShortlist([], 999, NOW), /no aliases/);
});

test("isQuiet: empty, weak and strong days", () => {
  assert.equal(isQuiet([]), true);
  assert.equal(isQuiet([{ score: QUIET_THRESHOLD - 1 }]), true);
  assert.equal(isQuiet([{ score: QUIET_THRESHOLD }]), false);
});

test("isQuiet: one stale uncorroborated item does not pass as a lead", () => {
  const list = buildShortlist([item("South Africa squad continue their training block", { position: 7, date: hoursAgo(60) })], 467, NOW);
  assert.equal(isQuiet(list), true);
});

test("renderShortlist: numbers candidates and shows why each scored", () => {
  const list = buildShortlist(
    [
      item("Rassie Erasmus provides Feinberg-Mngomezulu fitness update", { position: 1 }),
      item("Erasmus gives Feinberg-Mngomezulu fitness update", { position: 2, feedId: "bbc", feedName: "BBC" }),
    ],
    467,
    NOW,
  );
  const out = renderShortlist(list);
  assert.match(out, /^1\. \[NEW · score /);
  assert.match(out, /2 outlets \(planetrugby, bbc\)/);
  assert.match(renderShortlist([]), /coverage is silent/);
});

// The Springbok briefing led on "Kiwi confidence" on 2026-07-20 because a New
// Zealand story named the Boks in a subordinate clause of its headline.
test("subjectWeight: a team leading the headline is the subject", () => {
  assert.equal(subjectWeight("Springboks name their side for Argentina", TEAM_ALIASES[467]), 1);
  assert.equal(subjectWeight("Rassie Erasmus provides a fitness update", TEAM_ALIASES[467]), 1);
});

test("subjectWeight: a team after an opposition marker is a mention, not the subject", () => {
  const t = "All Blacks great hails statement shift from forward who will be needed against Springboks";
  assert.equal(subjectWeight(t, TEAM_ALIASES[467]), 0.35, "'against Springboks' is a mention");
});

// Demoted, not dismissed: it IS a Fiji story, just told from Scotland's side.
// Only the explicit opposition construction drops to the floor.
test("subjectWeight: a team named late without an opposition marker is demoted, not dismissed", () => {
  assert.equal(subjectWeight("Scotland flirt with defeat before overpowering Fiji", TEAM_ALIASES[28]), 0.55);
});

test("subjectWeight: the New Zealand story still reads as a NZ subject", () => {
  const t = "All Blacks great hails statement shift from forward who will be needed against Springboks";
  assert.equal(subjectWeight(t, TEAM_ALIASES[465]), 1, "it is a New Zealand story");
});

test("buildShortlist: a genuine team story outranks a passing mention in a bigger one", () => {
  const list = buildShortlist(
    [
      item("All Blacks great hails statement shift from forward who will be needed against Springboks", { position: 0 }),
      item("Rassie Erasmus provides Feinberg-Mngomezulu fitness update", { position: 3 }),
    ],
    467,
    NOW,
  );
  assert.match(list[0].title, /Erasmus provides/, "the Bok briefing must lead on a Bok story");
});

// The Esterhuizen case: Planet Rugby's Springbok team announcement sat at feed
// position 0 on 22 Sep 2026 and, three days later, still out-scored every
// fresh story and led the edition for the third day running. A story that
// broke since the last edition now ranks above anything older, whatever the
// scores say; older stories stay on the list, printed as background.
test("buildShortlist: a story that broke since the last edition outranks a higher-scoring older one", () => {
  const feed = [
    item("Springboks team: Rassie Erasmus rotates for Wallabies showdown with new captain named", {
      position: 0,
      date: hoursAgo(70),
      firstSeen: new Date(NOW.getTime() - 70 * 3_600_000).toISOString(),
    }),
    item("Rassie Erasmus addresses Cameron Hanekom's absence as Springboks have 'security'", {
      position: 6,
      date: hoursAgo(10),
      firstSeen: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
    }),
  ];
  const list = buildShortlist(feed, 467, NOW);
  assert.equal(list.length, 2);
  assert.match(list[0].title, /Hanekom/, "the fresh story leads");
  assert.equal(list[0].fresh, true);
  assert.match(list[1].title, /rotates/);
  assert.equal(list[1].fresh, false);
  assert.ok(list[1].score > list[0].score, "the test only means something if the old story out-scores the new one");
  const out = renderShortlist(list);
  assert.match(out, /^1\. \[NEW · /);
  assert.match(out, /2\. \[BACKGROUND \(first seen 3 days ago\) · /);
  // Quiet is judged on the strongest candidate, not the first one printed.
  assert.equal(isQuiet(list), false);
});

test("isFresh: the pool's firstSeen wins, the outlet's pubDate stands in, nothing means stale", () => {
  const fresh = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
  const stale = new Date(NOW.getTime() - (FRESH_HOURS + 1) * 3_600_000).toISOString();
  assert.equal(isFresh({ items: [{ firstSeen: fresh }] }, NOW), true);
  assert.equal(isFresh({ items: [{ firstSeen: stale, date: hoursAgo(1) }] }, NOW), false, "firstSeen outranks a newer pubDate");
  assert.equal(isFresh({ items: [{ date: hoursAgo(2) }] }, NOW), true, "a widener hit has only its pubDate");
  assert.equal(isFresh({ items: [{ date: "rubbish" }] }, NOW), false);
  assert.equal(isFresh({ date: hoursAgo(2) }, NOW), true, "a bare story with no items falls back to its own date");
});

test("firstSeenAt: a cluster is as old as its EARLIEST sighting", () => {
  const a = new Date(NOW.getTime() - 50 * 3_600_000).toISOString();
  const b = new Date(NOW.getTime() - 2 * 3_600_000).toISOString();
  assert.equal(firstSeenAt([{ firstSeen: b }, { firstSeen: a }]), Date.parse(a));
  assert.equal(firstSeenAt([]), null);
  // A second outlet picking a story up today does not make it new.
  const list = buildShortlist(
    [
      item("Rassie Erasmus rotates for Wallabies showdown", { position: 0, firstSeen: a, date: hoursAgo(50) }),
      item("Erasmus rotates Springboks for Wallabies showdown", { position: 1, firstSeen: b, date: hoursAgo(2), feedId: "bbc", feedName: "BBC" }),
    ],
    467,
    NOW,
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].fresh, false);
});
