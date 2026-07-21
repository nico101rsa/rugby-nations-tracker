import test from "node:test";
import assert from "node:assert/strict";
import {
  extractionCandidates, buildExtractionPrompt, parseStorylines, storylineId,
  mergeBacklog, candidatesFor, pickStoryline, markUsed, retire,
  renderStorylineEdition, recheckQuery, ageDays, isFixtureShaped, MAX_AGE_DAYS, MAX_USES,
} from "./storylines.mjs";

const NOW = new Date("2026-07-21T06:00:00Z");
const TODAY = "2026-07-21";

const ITEMS = [
  { title: "Rassie Erasmus confirms Handré Pollard hamstring injury before Argentina tour", link: "https://a/1", desc: "Pollard is a doubt.", feedName: "SA Rugby Magazine" },
  { title: "Wales begin search for permanent head coach after Tandy exit", link: "https://a/2", desc: "", feedName: "BBC Rugby Union" },
  { title: "South Africa 43-0 Wales: player ratings from a one-sided afternoon", link: "https://a/3", desc: "", feedName: "Planet Rugby" },
  { title: "Ireland v New Zealand: as it happened", link: "https://a/4", desc: "", feedName: "Guardian Rugby Union" },
];

test("extractionCandidates keeps open threads and bars match reports", () => {
  const kept = extractionCandidates(ITEMS);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((i) => !/player ratings|as it happened/i.test(i.title)));
});

test("extractionCandidates survives a null pool and untitled items", () => {
  assert.deepEqual(extractionCandidates(null), []);
  assert.deepEqual(extractionCandidates([{ desc: "no title" }, null]), []);
});

test("buildExtractionPrompt covers all teams in ONE call and numbers the headlines", () => {
  const prompt = buildExtractionPrompt(extractionCandidates(ITEMS), { 467: "South Africa", 391: "Wales" }, TODAY);
  assert.match(prompt, /467 = South Africa/);
  assert.match(prompt, /391 = Wales/);
  assert.match(prompt, /1\. \[SA Rugby Magazine\]/);
  assert.match(prompt, /2\. \[BBC Rugby Union\]/);
  // The resolution condition is the contract — the prompt must demand it.
  assert.match(prompt, /resolution condition/i);
  assert.match(prompt, /"until/);
});

// ---- parsing: the resolution condition is load-bearing ------------------------

const items = extractionCandidates(ITEMS);

test("parseStorylines accepts a well-formed storyline and stamps it", () => {
  const [s] = parseStorylines({
    storylines: [{
      subject: "Handré Pollard's hamstring injury and his availability for the Argentina tour",
      teams: [467], resolution: "until South Africa confirm whether Pollard travels", sourceIndexes: [1],
    }],
  }, items, TODAY);
  assert.equal(s.teams[0], 467);
  assert.equal(s.firstSeen, TODAY);
  assert.equal(s.uses, 0);
  assert.equal(s.sources[0].feedName, "SA Rugby Magazine");
  assert.ok(s.id);
});

test("parseStorylines rejects a storyline with no 'until' resolution", () => {
  const out = parseStorylines({
    storylines: [{
      subject: "Handré Pollard's hamstring injury and the Argentina tour squad",
      teams: [467], resolution: "Pollard is injured", sourceIndexes: [1],
    }],
  }, items, TODAY);
  // Without an open question it is an article, not a Storyline (ADR 0002).
  assert.equal(out.length, 0);
});

test("parseStorylines rejects unknown teams, empty teams, and unsourced claims", () => {
  const base = { subject: "A perfectly reasonable subject line about a coach", resolution: "until someone decides" };
  assert.equal(parseStorylines({ storylines: [{ ...base, teams: [9999], sourceIndexes: [1] }] }, items, TODAY).length, 0);
  assert.equal(parseStorylines({ storylines: [{ ...base, teams: [], sourceIndexes: [1] }] }, items, TODAY).length, 0);
  // A storyline citing no real headline is the model inventing one.
  assert.equal(parseStorylines({ storylines: [{ ...base, teams: [467], sourceIndexes: [] }] }, items, TODAY).length, 0);
  assert.equal(parseStorylines({ storylines: [{ ...base, teams: [467], sourceIndexes: [99] }] }, items, TODAY).length, 0);
});

test("parseStorylines rejects a too-short subject and tolerates junk input", () => {
  assert.equal(parseStorylines({ storylines: [{ subject: "Pollard", teams: [467], resolution: "until it resolves", sourceIndexes: [1] }] }, items, TODAY).length, 0);
  assert.deepEqual(parseStorylines(null, items, TODAY), []);
  assert.deepEqual(parseStorylines({ storylines: "nope" }, items, TODAY), []);
});

// ---- the fixture bar ---------------------------------------------------------
// Every string below is verbatim from the first live extraction (2026-07-21).

test("isFixtureShaped rejects a fixture dressed up with an 'until' condition", () => {
  assert.equal(
    isFixtureShaped(
      "The upcoming four-Test series between South Africa and New Zealand",
      "until all four matches of the series between the Springboks and the All Blacks are completed",
    ),
    true,
  );
});

test("isFixtureShaped does NOT eat real storylines that merely resolve at a match", () => {
  // A discipline problem is a genuine open question even though it closes when
  // a game is played. Rejecting this would gut the backlog.
  assert.equal(
    isFixtureShaped(
      "Steve Borthwick's efforts to resolve England's persistent yellow card and discipline issues",
      "until England play a Test match without receiving multiple yellow cards",
    ),
    false,
  );
  assert.equal(
    isFixtureShaped(
      "Louis Rees-Zammit's quest to find his feet and make an impact in Welsh rugby",
      "until Louis Rees-Zammit plays his first competitive rugby match of the 2026-27 season",
    ),
    false,
  );
  assert.equal(
    isFixtureShaped(
      "Handré Pollard's hamstring injury and his availability for the Argentina tour",
      "until South Africa name their matchday squad for the first Test",
    ),
    false,
  );
  assert.equal(
    isFixtureShaped(
      "Australia's transition to a new coaching regime under Les Kiss",
      "until Australia play their first international match under Les Kiss",
    ),
    false,
  );
});

test("parseStorylines drops the fixture-shaped entry end to end", () => {
  const out = parseStorylines({
    storylines: [
      { subject: "The upcoming four-Test series between South Africa and New Zealand", teams: [467, 465], resolution: "until all four matches of the series are completed", sourceIndexes: [1] },
      { subject: "Handré Pollard's hamstring injury and his availability for the tour", teams: [467], resolution: "until South Africa name their matchday squad", sourceIndexes: [1] },
    ],
  }, items, TODAY);
  assert.equal(out.length, 1);
  assert.match(out[0].subject, /Pollard/);
});

test("buildExtractionPrompt teaches the fixture rule, not just the until rule", () => {
  const prompt = buildExtractionPrompt(items, { 467: "South Africa" }, TODAY);
  assert.match(prompt, /never a Storyline/i);
  assert.match(prompt, /fixture list/i);
});

test("storylineId is stable across rephrasing of case and punctuation", () => {
  assert.equal(storylineId("Pollard's hamstring"), storylineId("Pollard's hamstring"));
  assert.notEqual(storylineId("Pollard's hamstring"), storylineId("Wales head coach search"));
});

// ---- merge -------------------------------------------------------------------

const POLLARD = {
  id: "pollard-hamstring-a", subject: "Handré Pollard's hamstring injury and the Argentina tour",
  teams: [467], resolution: "until South Africa confirm whether Pollard travels",
  sources: [{ title: "t1", link: "https://a/1", feedName: "SA Rugby Magazine" }],
  firstSeen: "2026-07-14", lastSeen: "2026-07-14", uses: 0,
};

test("mergeBacklog keeps the ORIGINAL firstSeen when a thread is re-seen", () => {
  const fresh = { ...POLLARD, id: "different-id", firstSeen: TODAY, lastSeen: TODAY, sources: [{ title: "t2", link: "https://a/9", feedName: "BBC" }] };
  const [merged] = mergeBacklog([POLLARD], [fresh], TODAY, NOW);
  assert.equal(merged.firstSeen, "2026-07-14", "a still-open thread keeps its original first-seen date");
  assert.equal(merged.lastSeen, TODAY);
  assert.equal(merged.sources.length, 2);
});

test("mergeBacklog dedupes a rephrased subject rather than storing it twice", () => {
  const rephrased = {
    id: "x", subject: "Handré Pollard hamstring injury latest and the Argentina tour squad",
    teams: [467], resolution: "until the squad is named",
    sources: [{ title: "t", link: "https://a/2", feedName: "BBC" }],
    firstSeen: TODAY, lastSeen: TODAY, uses: 0,
  };
  const merged = mergeBacklog([POLLARD], [rephrased], TODAY, NOW);
  assert.equal(merged.length, 1, "one open question must not become two records");
});

test("mergeBacklog adds a genuinely different thread", () => {
  const wales = {
    id: "wales-coach", subject: "Wales' search for a permanent head coach after Tandy's exit",
    teams: [391], resolution: "until Wales appoint a permanent head coach",
    sources: [{ title: "t", link: "https://a/2", feedName: "BBC" }],
    firstSeen: TODAY, lastSeen: TODAY, uses: 0,
  };
  assert.equal(mergeBacklog([POLLARD], [wales], TODAY, NOW).length, 2);
});

test("mergeBacklog prunes on the housekeeping floor, use cap, and retirement", () => {
  const stale = { ...POLLARD, id: "stale", subject: "A thread nobody has mentioned in a month at all", lastSeen: "2026-06-01" };
  const spent = { ...POLLARD, id: "spent", subject: "A thread that has already carried three editions now", uses: MAX_USES };
  const dead = { ...POLLARD, id: "dead", subject: "A thread the recheck found resolved last week ok", retired: true };
  const kept = mergeBacklog([stale, spent, dead, POLLARD], [], TODAY, NOW);
  assert.deepEqual(kept.map((s) => s.id), ["pollard-hamstring-a"]);
});

test("mergeBacklog keeps a thread that is old but was re-seen today", () => {
  const old = { ...POLLARD, firstSeen: "2026-05-01", lastSeen: TODAY };
  assert.equal(mergeBacklog([old], [], TODAY, NOW).length, 1);
});

test("ageDays returns null for an unparseable date rather than a wrong number", () => {
  assert.equal(ageDays("not a date", NOW), null);
  assert.equal(Math.round(ageDays("2026-07-14T06:00:00Z", NOW)), 7);
});

// ---- selection ---------------------------------------------------------------

test("candidatesFor returns only this team's live threads, freshest first", () => {
  const backlog = [
    { ...POLLARD, id: "old", subject: "An older Bok thread still technically open", lastSeen: "2026-07-08" },
    { ...POLLARD, id: "new", subject: "A fresher Bok thread seen only yesterday", lastSeen: "2026-07-20" },
    { ...POLLARD, id: "wales", teams: [391], subject: "A Wales thread that must not appear here" },
  ];
  const got = candidatesFor(backlog, 467, NOW);
  assert.deepEqual(got.map((s) => s.id), ["new", "old"]);
});

test("candidatesFor excludes spent and retired threads", () => {
  const backlog = [
    { ...POLLARD, id: "spent", uses: MAX_USES },
    { ...POLLARD, id: "dead", retired: true },
  ];
  assert.deepEqual(candidatesFor(backlog, 467, NOW), []);
  assert.equal(pickStoryline(backlog, 467, NOW), null);
});

test("candidatesFor prefers an unused thread over one already used", () => {
  const backlog = [
    { ...POLLARD, id: "used", uses: 2, lastSeen: TODAY },
    { ...POLLARD, id: "unused", uses: 0, lastSeen: TODAY, subject: "A different open Bok thread not yet used" },
  ];
  assert.equal(pickStoryline(backlog, 467, NOW).id, "unused");
});

test("pickStoryline returns null for a team with an empty backlog", () => {
  assert.equal(pickStoryline([], 463, NOW), null);
  assert.equal(pickStoryline(null, 463, NOW), null);
});

test("markUsed and retire touch only the named storyline", () => {
  const backlog = [POLLARD, { ...POLLARD, id: "other" }];
  const used = markUsed(backlog, "pollard-hamstring-a", TODAY);
  assert.equal(used[0].uses, 1);
  assert.equal(used[0].lastUsed, TODAY);
  assert.equal(used[1].uses, 0);

  const dead = retire(backlog, "other", TODAY);
  assert.equal(dead[1].retired, true);
  assert.ok(!dead[0].retired);
});

// ---- the re-check ------------------------------------------------------------

test("renderStorylineEdition tells the writer to decide from the SEARCH, not the dates", () => {
  const text = renderStorylineEdition(POLLARD, [{ title: "Springboks name squad for Argentina", link: "https://b/1", feedName: "Planet Rugby" }], "South Africa");
  assert.match(text, /Decide from the search results, NOT from the dates/);
  // A resolved thread must be framed as today's story, not as a dead end.
  assert.match(text, /resolved storyline is a better story/);
  assert.match(text, /Springboks name squad for Argentina/);
  assert.match(text, /until South Africa confirm whether Pollard travels/);
});

test("renderStorylineEdition handles an empty search without pretending", () => {
  const text = renderStorylineEdition(POLLARD, [], "South Africa");
  assert.match(text, /search returned nothing new/);
  assert.match(text, /say so\s+honestly/);
  assert.doesNotMatch(text, /quiet news cycle.{0,40}write about/i);
});

test("renderStorylineEdition bans meta-commentary about the news cycle", () => {
  const text = renderStorylineEdition(POLLARD, [], "South Africa");
  assert.match(text, /Do NOT write about the quiet news cycle/);
});

test("recheckQuery anchors a player-only subject to the team", () => {
  const q = recheckQuery({ subject: "Handré Pollard hamstring" }, "South Africa");
  assert.match(q, /Pollard/);
  assert.match(q, /South Africa/);
  assert.match(q, /rugby/);
});
