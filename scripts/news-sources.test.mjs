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
  sameHeadline,
  FEEDS,
  RUGBY_LEAGUE,
  isRugbyLeague,
  dropLeague,
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

// The Ospreylia case (Wales, 11 Oct 2026): BBC's "How Welsh club turned to a
// land down under" carried a 17 Sep pubDate but entered the pool on 10 Oct,
// so the pool's firstSeen made a 23-day-old feature NEW and it ranked above a
// two-outlet Scarlets/WRU story from 28 Sep. A late sighting is not a story
// breaking: the earlier of firstSeen and pubDate decides.
test("buildShortlist: a stale article the feed surfaced late is BACKGROUND, not NEW", () => {
  const feed = [
    item("Ospreylia: How Welsh club turned to a land down under", {
      feedId: "bbc", feedName: "BBC Rugby Union", position: 36,
      date: hoursAgo(23 * 24), // the real pubDate was 23 days before the 10 Oct sighting
      firstSeen: new Date(NOW.getTime() - 10 * 3_600_000).toISOString(),
    }),
    item("Scarlets and WRU agree deal to keep Wales region in Llanelli", {
      feedId: "guardian", feedName: "Guardian Rugby Union", position: 4,
      date: hoursAgo(2 * 24), firstSeen: new Date(NOW.getTime() - 2 * 24 * 3_600_000).toISOString(),
    }),
    item("Scarlets and WRU agree deal to keep Wales region in Llanelli", {
      feedId: "search", feedName: "Search", position: 2, date: hoursAgo(2 * 24), firstSeen: undefined,
    }),
    item("Wales name side for Argentina Test as Sherratt rings the changes", {
      position: 0, date: hoursAgo(3), firstSeen: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    }),
    item("Tandy backs Wales bench to finish the job in Buenos Aires", {
      position: 1, date: hoursAgo(5), firstSeen: new Date(NOW.getTime() - 5 * 3_600_000).toISOString(),
    }),
  ];
  const list = buildShortlist(feed, 391, NOW);
  const ospreylia = list.find((s) => /Ospreylia/.test(s.title));
  assert.equal(ospreylia.fresh, false);
  assert.equal(list[list.length - 1], ospreylia, "it is last");
  assert.match(renderShortlist(list), /BACKGROUND \(first seen 23 days ago\) · score [\d.]+ · 1 outlet \(bbc\)\] Ospreylia/);
  assert.equal(isFresh({ items: [{ firstSeen: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), date: hoursAgo(10 * 24) }] }, NOW), false);
});

// The Edwards case (Argentina, 11 Oct 2026): five outlets' versions of one
// signing, Jaccard 0.10–0.30 between the short and the long headlines, so
// corroboration read 1–2 where it was four outlets.
test("clusterStories: the Edwards case — five outlets' versions of one signing are one story", () => {
  const feed = [
    item("Defence guru Shaun Edwards joins the Pumas as Felipe Contepomi bolsters Los Pumas backroom", { feedId: "planetrugby", position: 0 }),
    item("Edwards joins Argentina as defence coach", { feedId: "bbc", feedName: "BBC Rugby Union", position: 1 }),
    item("Argentina snap up defence guru Edwards", { feedId: "sarugbymag", feedName: "SA Rugby Magazine", position: 2 }),
    item("Shaun Edwards joins Argentina coaching staff as defence coach", { feedId: "search", feedName: "Search", position: 5 }),
    item("Felipe Contepomi bolsters Los Pumas backroom with Shaun Edwards", { feedId: "search", feedName: "Search", position: 7 }),
  ];
  const clusters = clusterStories(feed);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].corroboration, 4);
  assert.match(clusters[0].title, /^Defence guru Shaun Edwards/);
  assert.equal(sameHeadline("Argentina beat Wales in Buenos Aires", "Wales name team to face Argentina"), false);
  assert.equal(sameHeadline("Springboks confirm Argentina tour venues for next month", "South Africa announce a new defence coach on a two-year deal"), false);
  assert.equal(sameHeadline("Edwards joins Argentina as defence coach", "Argentina snap up defence guru Edwards"), true);
});

test("FEEDS: FBC News is in the spine for Fiji, with a rugby topic filter", () => {
  const fbc = FEEDS.find((f) => f.id === "fbcnews");
  assert.ok(fbc);
  assert.equal(new URL(fbc.url).hostname.replace(/^www\./, ""), "fbcnews.com.fj");
  assert.ok(fbc.topic instanceof RegExp);
  assert.equal(fbc.topic.test("Flying Fijians name squad for November"), true);
  assert.equal(fbc.topic.test("Drua sign two props for next season"), true);
  assert.equal(fbc.topic.test("Fiji records budget surplus"), false);
  assert.deepEqual(FEEDS.filter((f) => f.topic).map((f) => f.id), ["fbcnews", "the42"], "only the general-news sites need a topic");
});

test("FEEDS: The42 and RTÉ Sport are in the spine for Ireland; The42's whole-site feed keeps rugby only", () => {
  const the42 = FEEDS.find((f) => f.id === "the42");
  const rte = FEEDS.find((f) => f.id === "rte");
  assert.equal(new URL(the42.url).hostname.replace(/^www\./, ""), "the42.ie");
  assert.equal(new URL(rte.url).hostname.replace(/^www\./, ""), "rte.ie");
  assert.equal(rte.topic, undefined, "RTÉ's feed is already its rugby section");
  assert.equal(the42.topic.test("Andy Farrell names Ireland squad for November"), true);
  assert.equal(the42.topic.test("Leinster's Lowe ruled out of Champions Cup opener"), true);
  assert.equal(the42.topic.test("Ireland rugby: three things we learned"), true);
  assert.equal(the42.topic.test("Ireland's footballers draw with Portugal in World Cup qualifier"), false);
  assert.equal(the42.topic.test("Kerry name All-Ireland final team"), false);
  assert.ok(mentionsTeam("Andy Farrell names Ireland squad for November", TEAM_ALIASES[388]));
});

// 19 Oct 2026: the New Zealand edition led with a Rugby League World Cup game
// as All Blacks news. Real titles from that day's shortlists and the pool.
test("buildShortlist: rugby league headlines never reach a union team's shortlist", () => {
  const league = [
    [28, "How to watch Fiji vs Cook Islands for FREE: Live streams for Rugby League World Cup 2026 game"],
    [28, "New Zealand narrowly escape with win over impressive Rugby League World Cup debutants Fiji"],
    [465, "New Zealand narrowly escape with win over impressive Rugby League World Cup debutants Fiji"],
    [28, "Prop ready to do Fiji proud at RLWC"],
    [465, "What time do the Kangaroos play New Zealand? Start time, TV channel, live stream details for 2026 Rugby League World Cup match"],
  ];
  for (const [teamId, title] of league) {
    assert.ok(mentionsTeam(title, TEAM_ALIASES[teamId]), `${title} names team ${teamId}`);
    assert.deepEqual(buildShortlist([item(title)], teamId, NOW), [], `${title} is rugby league`);
  }
});

test("buildShortlist: union stories that brush against league are kept", () => {
  const union = [
    // Title only: the description says "Australian Rugby League Commission".
    [465, item("New Zealand Rugby dealt early setback in legal action against ARLC over Chiefs name", {
      desc: "New Zealand Rugby suffered a major setback when its application for an interim injunction against the Australian Rugby League Commission regarding the usage of the Chiefs name was turned down in court",
    })],
    // Bare "Kiwis" is union shorthand for New Zealanders.
    [460, item("Reado: Pumas show Kiwis 'edge' over Boks")],
    [467, item("Kiwis brace for Springbok bench as Rennie names side")],
    // Bare "NRL": a union story about a code-switcher.
    [461, item("Wallabies veteran relishing 'freak' Mark Nawaqanitawase's return after sensational NRL stint")],
    // Japan Rugby League One is the top UNION competition in Japan.
    [463, item("Japan Rugby League One Amends Proposed Player Categories – Outlines Updated Eligibility for 2026-2027 Season")],
  ];
  for (const [teamId, story] of union) {
    assert.equal(buildShortlist([story], teamId, NOW).length, 1, `${story.title} is a union story`);
  }
});

test("RUGBY_LEAGUE: the league markers, and what it leaves alone", () => {
  for (const t of ["Toa Samoa stun England", "Mate Ma'a Tonga name squad", "Mate Ma’a Tonga name squad",
    "PNG Kumuls fall short", "State of Origin III preview", "Women's Rugby League World Cup: England score 70"]) {
    assert.equal(RUGBY_LEAGUE.test(t), true, t);
  }
  for (const t of ["NTT Japan Rugby League One Division One 2026-2027 Fixtures Released",
    "Rugby World Cup 2027: what we know so far", "Kiwis edge it", "Racing 92 star returns to NRL"]) {
    assert.equal(RUGBY_LEAGUE.test(t), false, t);
  }
});

// dropLeague is the one filter on every path into a writer prompt: the
// shortlist, the search widener (generate-digests' fetchTeamNews, which also
// feeds the storyline re-check) and storyline extraction. Real items from the
// run records unless marked.
const bing = (article) =>
  `http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=6ad542de0c4249458d02ead7f98fec2f&url=${encodeURIComponent(article)}&c=1&mkt=en-us`;
test("dropLeague: league titles, league publishers, and the code-switch exemption", () => {
  const league = [
    // The official tournament tag is RLWC2026; \bRLWC\b misses it (synthetic title).
    { title: "Fiji Bati name RLWC2026 squad", link: "https://example.test/x" },
    // Women's league sides (Fiji #2 on 8 Oct, nrl.com).
    { title: "All in the family for young gun Laing after Fiji Bulikula call-up", link: "https://www.nrl.com/news/2026/10/08/all-in-the-family-for-young-gun-laing/" },
    { title: "Kiwi Ferns edge Jillaroos in thriller", link: "https://example.test/x" },
    // No union World Cup in 2026 (5 Sep, no link kept).
    { title: "Fiji names powerful 2026 World Cup squad packed with NRL stars", link: "" },
    // No marker in the title; the publisher is nrl.com (New Zealand #2, 14 Oct).
    { title: "'Best in the world': New Zealand pack eye statement victory", link: "https://www.nrl.com/news/2026/10/14/best-in-the-world-new-zealand-pack/" },
    // The Fiji lead on 6 Oct, through Bing, from loverugbyleague.com.
    { title: "New Warrington recruit among 4 Super League stars in Fiji squad", link: bing("https://www.loverugbyleague.com/post/fiji-world-cup-squad-05-10-2026") },
    // A /rugby-league/ section (Wales, 18 Oct).
    { title: "England score 70 in emphatic win over Wales", link: "https://www.bbc.com/sport/rugby-league/live/cvy0zje32k35t" },
    // A league side or competition beats a union name in the same title (synthetic).
    { title: "Former Wallabies wing stars as Kangaroos beat Fiji", link: "https://example.test/x" },
    { title: "Fiji rugby league captain retires after stroke", link: "https://example.test/x" },
  ];
  const union = [
    // Code-switch stories: "rugby league" named, with a union side or body.
    { title: "Les Kiss reveals whether Zac Lomax will still be considered for Wallabies selection after confirmation of rugby league return", link: "https://www.planetrugby.com/news/les-kiss-reveals-zac-lomax" },
    { title: "Five Welsh-qualified rugby league stars identified as WRU targets new recruits", link: "https://example.test/x" },
    { title: "Japan Rugby League One Amends Proposed Player Categories", link: "https://example.test/x" },
    { title: "New Zealand avoid World Cup scare as All Blacks tune up", link: bing("https://www.planetrugby.com/news/all-blacks-tune-up") },
    { title: "Rugby World Cup 2027: what we know so far", link: "not a url" },
  ];
  for (const i of league) assert.equal(isRugbyLeague(i), true, i.title);
  for (const i of union) assert.equal(isRugbyLeague(i), false, i.title);
  assert.deepEqual(dropLeague([...league, ...union]).map((i) => i.title), union.map((i) => i.title));
  assert.deepEqual(dropLeague(null), []);
  // buildShortlist goes through it, publisher test included.
  assert.deepEqual(buildShortlist([item(league[4].title, { link: league[4].link })], 465, NOW), []);
  assert.equal(buildShortlist([item(union[0].title, { link: union[0].link })], 461, NOW).length, 1);
});
