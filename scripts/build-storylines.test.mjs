import { test } from "node:test";
import assert from "node:assert/strict";
import {
  upcomingFixtures, sydneyKickoff, teamForm, previousMeetings, newsFor, buildPack, packHashes,
  renderPack, buildWriterPrompt, buildCheckerPrompt, validateStory, writeStory, decide,
  buildStorylines, sameStories, storylinesFile, streakText, logFor, logTable, storylineEnv, stripCitations,
  fixtureQueries, widenFixture,
  SCHEMA_VERSION, HEADLINE_MAX, NEWS_REFRESH_HOURS, STORYLINE_DEFAULT_WRITER,
} from "./build-storylines.mjs";
import { LEAGUE_CHECK_RULE } from "./generate-digests.mjs";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const DAY = 86_400_000;

const fixture = (over = {}) => ({
  id: "espn-604593",
  date: "2026-10-24T05:50:00.000Z",
  timeTBC: false,
  home: { code: "JPN", name: "Japan", tracked: true },
  away: { code: "FIJ", name: "Fiji", tracked: true },
  comp: { key: "test", label: "TEST", kind: "test" },
  venue: "Prince Chichibu Memorial Stadium, Tokyo",
  ...over,
});

const g = (id, date, opponent, opponentCode, homeAway, us, them, league = "Pacific Nations Cup, Knockout Stage") => ({
  id, date, league, opponent, opponentCode, tracked: opponentCode != null, homeAway, us, them,
  result: us > them ? "W" : us < them ? "L" : "D", tries: null, cards: null,
});

const teamEvents = {
  teams: {
    JPN: {
      last: [
        g(1, "2026-08-15T05:15:00.000Z", "Australia", "AUS", "A", 17, 56, "International Friendlies"),
        g(2, "2026-09-05T05:50:00.000Z", "Canada", null, "H", 57, 12, "International Friendlies"),
        g(3, "2026-09-12T10:05:00.000Z", "USA", null, "H", 63, 14),
        // the 2026 final, same ground as the fixture under test
        { ...g(17085293, "2026-09-19T10:05:00.000Z", "Fiji", "FIJ", "H", 20, 15), venue: "Prince Chichibu Memorial Stadium, Tokyo", stage: "final" },
      ],
      next: [
        { id: "espn-604593", date: "2026-10-24T05:50Z", opponent: "Fiji", opponentCode: "FIJ", homeAway: "H", us: null, them: null },
        { id: 16098048, date: "2026-11-07T16:40:00.000Z", league: "Nations Championship, Group Stage", opponent: "Wales", opponentCode: "WAL", homeAway: "A" },
      ],
    },
    FIJ: {
      last: [
        // the 2025 final in Salt Lake City, as host-overrides.mjs marks it
        { ...g(4, "2025-09-21T01:35:00.000Z", "Japan", "JPN", "A", 33, 27), neutral: true, venue: "America First Field, Salt Lake City", stage: "final" },
        g(5, "2026-07-11T13:10:00.000Z", "England", "ENG", "H", 8, 73, "Nations Championship, Group Stage"),
        g(6, "2026-09-12T07:00:00.000Z", "Canada", null, "H", 45, 29),
        g(17085293, "2026-09-19T10:05:00.000Z", "Japan", "JPN", "A", 15, 20),
      ],
      next: [],
    },
  },
};
const rankings = { asOf: "19 October 2026", rankings: { JPN: { rank: 9, points: 77.28 }, FIJ: { rank: 10, points: 76.81 } } };

const item = (title, date, extra = {}) => ({ title, link: `https://example.com/${encodeURIComponent(title)}`, desc: "", date, feedName: "Outlet", ...extra });
const POOL = [
  item("World Cup-winning coach White takes reins at Fiji", "Tue, 13 Oct 2026 13:30:00 +0000"),
  item("Pollock scores hat-trick as 11-try England thrash Fiji", "Sat, 11 Jul 2026 17:25:32 GMT"),
  item("Fiji Bati name squad for Kumuls clash", "Mon, 19 Oct 2026 01:00:00 +0000"),
  item("Japan women beat Hong Kong", "Mon, 19 Oct 2026 01:00:00 +0000"),
  item("Japan v Fiji: Brave Blossoms name side", "Mon, 19 Oct 2026 04:00:00 +0000"),
  item("All Blacks name squad for Europe", "Mon, 19 Oct 2026 04:00:00 +0000"),
  item("No date on this Fiji story", ""),
];

// ---- window ----------------------------------------------------------------------

test("window: next 14 days, a tracked side, not started, not scored", () => {
  const rows = [
    fixture(),
    fixture({ id: "played", date: "2026-10-18T05:00:00Z", homeScore: 20, awayScore: 10 }),
    fixture({ id: "past-unscored", date: "2026-10-20T09:00:00Z" }),
    fixture({ id: "scored-early", homeScore: 3, awayScore: 0 }),
    fixture({ id: "live", status: { live: true } }),
    fixture({ id: "too-far", date: "2026-11-07T16:40:00Z" }),
    fixture({ id: "edge", date: new Date(NOW + 14 * DAY).toISOString() }),
    fixture({ id: "untracked", home: { code: "GEO", name: "Georgia", tracked: false }, away: { code: "SAM", name: "Samoa", tracked: false } }),
    fixture({ id: "tracked-v-untracked", away: { code: "GEO", name: "Georgia", tracked: false }, date: "2026-10-22T05:00:00Z" }),
  ];
  assert.deepEqual(upcomingFixtures(rows, NOW).map((f) => f.id), ["tracked-v-untracked", "espn-604593", "edge"]);
});

test("kickoff in Sydney time, AEDT", () => {
  assert.equal(sydneyKickoff("2026-10-24T05:50:00.000Z"), "Sat 24 Oct 2026, 4:50 pm Sydney time");
  assert.equal(sydneyKickoff("2026-10-24T05:50:00.000Z", true), "Sat 24 Oct 2026, time TBC");
});

// ---- pack -----------------------------------------------------------------------

test("form: newest first, current run and year record counted in code", () => {
  const f = teamForm(teamEvents, "JPN", Date.parse("2026-10-24T05:50:00Z"));
  assert.equal(f.results[0].opponent, "Fiji");
  assert.equal(f.results[0].side, "home");
  assert.equal(f.results[0].score, "20–15");
  assert.deepEqual(f.streak, { result: "W", games: 3, complete: true });
  assert.deepEqual(f.year, { year: 2026, played: 4, W: 3, D: 0, L: 1 });
  assert.equal(streakText(f.streak), "3 straight wins");
  assert.equal(streakText({ result: "L", games: 1, complete: true }), "lost their last game");
  assert.equal(streakText({ result: "W", games: 10, complete: false }), "at least 10 straight wins");
});

test("meetings: one row per game from either side, host's view, newest first, archive included", () => {
  const archive = { games: { FIJ: { 9: g(9, "2024-09-21T05:00:00Z", "Japan", "JPN", "H", 41, 17) } } };
  const m = previousMeetings({ teamEvents, archive, home: "JPN", away: "FIJ", names: { JPN: "Japan", FIJ: "Fiji" }, beforeMs: Date.parse("2026-10-24T05:50:00Z") });
  assert.deepEqual(m.map((x) => x.score), ["Japan 20–15 Fiji", "Japan 27–33 Fiji", "Fiji 41–17 Japan"]);
  assert.equal(m[0].host, "Japan");
  assert.equal(m[1].winner, "Fiji");
  assert.deepEqual([m[1].neutral, m[1].host, m[1].venue], [true, null, "America First Field, Salt Lake City"], "a neutral final has no host");
  assert.equal(m[2].neutral, false);
});

test("logTable: the whole Nations Championship table, ranked, only for an rnc-* game", () => {
  const nations = { log: [{ rank: 2, id: 28, team: "Fiji", P: 3, W: 2, D: 0, L: 1, PD: 10, Pts: 9 }, { rank: 1, id: 463, team: "Japan", P: 3, W: 3, D: 0, L: 0, PD: 36, Pts: 14 }, { rank: 3, id: 391, team: "Wales", P: 3, W: 1, D: 0, L: 2, PD: -20, Pts: 5 }] };
  assert.equal(logTable(nations, { key: "test" }), null);
  const t = logTable(nations, { key: "rnc-2026" });
  assert.deepEqual(t.map((r) => [r.rank, r.code, r.Pts]), [[1, "JPN", 14], [2, "FIJ", 9], [3, "WAL", 5]]);
  const pack = buildPack(fixture({ comp: { key: "rnc-2026", label: "Nations Championship", kind: "competition" } }), { teamEvents, rankings, nations, newsItems: [], now: NOW });
  const text = renderPack(pack);
  assert.match(text, /## Nations Championship table \(trusted; after 3 of 6 pool rounds/);
  assert.match(text, /- 1\. Japan: P3 W3 D0 L0, PD 36, 14 pts ←/);
  assert.match(text, /- Fiji: 5 points behind Japan \(1st\), 4 points ahead of Wales \(3rd\)\. A win is 4 points/);
  assert.match(text, /- Japan: 5 points ahead of Fiji \(2nd\)\./);
});

test("news: title-matched, league and women's dropped, old items marked BACKGROUND, both-team items first", () => {
  const n = newsFor(POOL, { home: "JPN", away: "FIJ", names: { JPN: "Japan", FIJ: "Fiji" }, now: NOW });
  const titles = n.map((x) => x.title);
  assert.equal(titles[0], "Japan v Fiji: Brave Blossoms name side");
  assert.ok(!titles.some((t) => /Bati|Kumuls/.test(t)), "league dropped");
  assert.ok(!titles.some((t) => /women/.test(t)), "women's dropped");
  assert.ok(!titles.includes("All Blacks name squad for Europe"), "other teams dropped");
  const by = Object.fromEntries(n.map((x) => [x.title, x]));
  assert.equal(by["World Cup-winning coach White takes reins at Fiji"].background, false);
  assert.equal(by["Pollock scores hat-trick as 11-try England thrash Fiji"].background, true);
  assert.equal(by["No date on this Fiji story"].background, true, "undated is background");
});

test("log only for an rnc-* game", () => {
  const nations = { log: [{ rank: 4, id: 463, P: 3, W: 1, D: 0, L: 2, PD: -36, Pts: 5 }, { rank: 11, id: 28, P: 3, W: 0, D: 0, L: 3, PD: -96, Pts: 1 }] };
  assert.equal(logFor(nations, { key: "test" }, "JPN", "FIJ"), null);
  assert.deepEqual(logFor(nations, { key: "rnc-2026" }, "JPN", "FIJ").FIJ, { rank: 11, P: 3, W: 0, D: 0, L: 3, PD: -96, Pts: 1 });
});

test("pack: fixture, rankings, form, meetings, next, news; rendered with CURRENT/BACKGROUND labels", () => {
  const pack = buildPack(fixture(), { teamEvents, rankings, newsItems: POOL, now: NOW });
  assert.equal(pack.fixture.kickoffSydney, "Sat 24 Oct 2026, 4:50 pm Sydney time");
  assert.deepEqual(pack.rankings.JPN, { rank: 9, points: 77.28 });
  assert.equal(pack.next.JPN.opponent, "Wales", "the game itself is not 'next'");
  assert.equal(pack.next.FIJ, null);
  assert.equal(pack.meetings.length, 2);
  const text = renderPack(pack);
  assert.match(text, /Japan are the home side/);
  assert.match(text, /Japan 9th \(77\.28 pts\); Fiji 10th \(76\.81 pts\)\./);
  assert.match(text, /NOT a complete head-to-head/);
  assert.match(text, /\] CURRENT 2026-10-13 · Outlet · World Cup-winning coach White/);
  assert.match(text, /\] BACKGROUND 2026-07-11/);
  // the stakes, computed; this two-team table settles no rank, so only the order between the sides is stated
  assert.match(text, /## Rankings at stake \(trusted; computed/);
  assert.match(text, /- Fiji win by 15 or fewer: Fiji \+1\.05 to 77\.86 \(above Japan\); Japan −1\.05 to 76\.23 \(below Fiji\)\./);
  assert.match(text, /- Draw: Japan −0\.05 to 77\.23 \(order unchanged\); Fiji \+0\.05 to 76\.86 \(order unchanged\)\./);
  assert.equal(pack.stakes.scenarios.length, 5);
  // a full table gives ranks and names the nations passed
  const full = { asOf: "19 October 2026", rankings: { RSA: { rank: 1, points: 93.09 }, NZL: { rank: 2, points: 92.27 }, IRE: { rank: 3, points: 88.08 }, FRA: { rank: 4, points: 87.43 }, ENG: { rank: 5, points: 85.68 }, SCO: { rank: 6, points: 84.78 }, AUS: { rank: 7, points: 84.43 }, ARG: { rank: 8, points: 82.24 }, JPN: { rank: 9, points: 77.28 }, FIJ: { rank: 10, points: 76.81 }, WAL: { rank: 11, points: 76.38 }, ITA: { rank: 12, points: 76.3 } } };
  const fullText = renderPack(buildPack(fixture(), { teamEvents, rankings: full, newsItems: [], now: NOW }));
  assert.match(fullText, /- Fiji win by 15 or fewer: Fiji \+1\.05 to 77\.86 \(up to 9th, above Japan\); Japan −1\.05 to 76\.23 \(below Fiji, Wales and Italy; 12th at best\)\./);
  // meetings: weeks before the game on the latest, the stage, the same ground; neutral ground named as such
  assert.match(text, /- 2026-09-19 \(5 weeks before this game\): Japan 20–15 Fiji \(Pacific Nations Cup, Knockout Stage, the final\), Prince Chichibu Memorial Stadium, Tokyo; Japan were at home — the same ground as this game\./);
  assert.match(text, /- 2025-09-21: Japan 27–33 Fiji \(Pacific Nations Cup, Knockout Stage, the final\); neutral venue \(America First Field, Salt Lake City\), neither side at home\./);
  assert.match(text, /2025-09-21 W 33–27 v Japan \(neutral venue, Pacific/);
  // a rank history renders where rankings.json carries one
  const withHistory = { ...rankings, history: [{ asOf: "14 September 2026", rankings: { JPN: { rank: 12, points: 76.09 }, FIJ: { rank: 9, points: 78 } } }] };
  assert.match(renderPack(buildPack(fixture(), { teamEvents, rankings: withHistory, newsItems: [], now: NOW })), /Japan 9th \(77\.28 pts\), 9th since 19 October 2026 \(12th before that\), range since 14 September 2026: 9th–12th; Fiji 10th/);
});

test("hashes: the facts hash ignores news; the pack hash moves with a new item and not with a reworded snippet", () => {
  const base = buildPack(fixture(), { teamEvents, rankings, newsItems: POOL, now: NOW });
  const more = buildPack(fixture(), { teamEvents, rankings, newsItems: [...POOL, item("Fiji name three uncapped players", "Mon, 19 Oct 2026 06:00:00 +0000")], now: NOW });
  const reworded = buildPack(fixture(), { teamEvents, rankings, newsItems: POOL.map((i) => ({ ...i, desc: "different" })), now: NOW });
  const ranked = buildPack(fixture(), { teamEvents, rankings: { ...rankings, rankings: { ...rankings.rankings, FIJ: { rank: 11, points: 76 } } }, newsItems: POOL, now: NOW });
  const h = packHashes(base);
  assert.equal(packHashes(more).factsHash, h.factsHash);
  assert.notEqual(packHashes(more).packHash, h.packHash);
  assert.equal(packHashes(reworded).packHash, h.packHash);
  assert.notEqual(packHashes(ranked).factsHash, h.factsHash);
  // Run-to-run stable: same inputs a day later (items not crossing the line) → same hashes.
  assert.deepEqual(packHashes(buildPack(fixture(), { teamEvents, rankings, newsItems: POOL, now: NOW + 3600e3 })), h);
});

// ---- prompts and gates ------------------------------------------------------------

test("prompts: pack-only, no head-to-head unless sourced, staleness and the shared league rule", () => {
  const w = buildWriterPrompt("PACK");
  assert.match(w, /ONLY source/);
  assert.match(w, /Never state a\s+head-to-head total/);
  assert.match(w, /Never present a BACKGROUND item as current/);
  assert.match(w, /Form list is complete for the dates it covers/, "a result the form list lacks is another team's");
  assert.match(w, /"neutral venue" was hosted by neither side/);
  assert.match(w, /Rankings arithmetic comes only from "Rankings at stake"/);
  assert.match(buildWriterPrompt("PACK", { voice: "preview" }), /what the result CHANGES/);
  assert.match(w, /about 150\s+words/, "the target");
  assert.match(w, /170 words at most/, "the stated ceiling sits under the enforced one");
  assert.ok(!/200 words/.test(w), "the enforced ceiling is not the writer's business");
  assert.match(w, /## The voice/, "the default brief is the dry one");
  const p = buildWriterPrompt("PACK", { voice: "preview" });
  assert.match(p, /## What to write\nA headline/, "the preview brief is the checklist");
  assert.ok(!/## The voice/.test(p));
  assert.match(p, /rematch five weeks on/, "the preview sample");
  // the dry brief: one angle, a voice, places not points, the same rules and gate
  const d = buildWriterPrompt("PACK", { voice: "dry" });
  assert.equal(d, w);
  assert.match(d, /## The voice\nYou are the friend who knows the game: dry, exact, a touch of wit/);
  assert.match(d, /First find the one angle/);
  assert.match(d, /never rating points or\s+decimals/);
  assert.match(d, /No exclamation\s+marks/);
  assert.match(d, /3 to 5 beats/);
  assert.match(d, /170 words at most/);
  assert.match(d, /ONLY source/, "the rules are shared");
  assert.match(d, /Say the obvious plainly/);
  assert.match(d, /the one that got away/, "the dry sample");
  assert.ok(!/17-5/.test(d) && !/Salt Lake/.test(d), "no real facts in the sample");
  assert.equal(buildWriterPrompt("PACK", { voice: "shouty" }), w, "an unknown voice is the default (dry)");
  assert.match(buildWriterPrompt("PACK", { voice: "dry", revision: [{ claim: "x", problem: "y" }], previousDraft: {} }), /## Revise your draft/);
  assert.match(buildCheckerPrompt("PACK", { headline: "h", beats: [] }), /Colour, understatement and dry phrasing are not claims/);
  assert.match(buildWriterPrompt("PACK", { revision: [{ claim: "format", problem: "232 words > 200" }], previousDraft: {} }), /232 words > 200/, "a revision hears the real count");
  assert.match(buildCheckerPrompt("PACK", { headline: "h", beats: [] }), /clipped\s+conditional/);
  assert.ok(!/17 wins/.test(w), "the approved sample's real facts are not in the prompt");
  assert.ok(!/17-5/.test(w), "nor the head-to-head the first sample carried");
  const c = buildCheckerPrompt("PACK", { headline: "h", beats: [] });
  assert.ok(c.includes(LEAGUE_CHECK_RULE), "same league rule text as the digest checker");
  assert.match(c, /STALENESS/);
  assert.match(c, /head-to-head total/);
  assert.match(c, /Form list \(complete\s+for the dates it covers\) does not show/);
  assert.match(c, /differs from "Rankings at\s+stake"/);
});

test("widener: the week's news and the previews, one list, a failed query dropped", async () => {
  assert.deepEqual(fixtureQueries(fixture()), ["Japan Fiji", "Japan v Fiji preview"]);
  const asked = [];
  const search = async (q) => { asked.push(q); if (/preview/.test(q)) throw new Error("bing empty"); return [item(`hit for ${q}`, "Mon, 19 Oct 2026 01:00:00 +0000")]; };
  const items = await widenFixture(fixture(), search);
  assert.deepEqual(asked, ["Japan Fiji", "Japan v Fiji preview"]);
  assert.deepEqual(items.map((i) => i.title), ["hit for Japan Fiji"]);
});

test("storylineEnv: the storyline writer is Opus 5.5 unless STORYLINE_WRITER_MODEL says otherwise; the checker is the digests'", () => {
  assert.equal(STORYLINE_DEFAULT_WRITER, "claude-opus-5-5");
  assert.equal(storylineEnv({ DIGEST_WRITER_MODEL: "claude-haiku-5-5" }).DIGEST_WRITER_MODEL, "claude-opus-5-5", "the digests' writer does not carry over");
  assert.equal(storylineEnv({ DIGEST_WRITER_MODEL: "claude-haiku-5-5", STORYLINE_WRITER_MODEL: "  " }).DIGEST_WRITER_MODEL, "claude-opus-5-5", "blank = unset");
  const env = storylineEnv({ DIGEST_WRITER_MODEL: "claude-haiku-5-5", DIGEST_CHECKER_MODEL: "x", STORYLINE_WRITER_MODEL: "claude-sonnet-5-5" });
  assert.deepEqual([env.DIGEST_WRITER_MODEL, env.DIGEST_CHECKER_MODEL], ["claude-sonnet-5-5", "x"]);
  assert.equal(storylineEnv({ STORYLINE_WRITER_MODEL: "gemini" }).DIGEST_WRITER_MODEL, "gemini");
});

test("validateStory: citation marks are stripped, copy about the app or its records fails the gate", () => {
  const story = { headline: "Scotland host the All Blacks [2]", beats: ["Josh Kerr delivers the match ball [2].", "Barrett is in form [8][12].", "Five of eight in 2026 [1, 3].", "Any win lifts them to 5th."], sources: [2] };
  const v = validateStory(story, [item("a", ""), item("b", "")]);
  assert.equal(v.ok, true, v.errors);
  assert.equal(v.story.headline, "Scotland host the All Blacks");
  assert.deepEqual(v.story.beats, ["Josh Kerr delivers the match ball.", "Barrett is in form.", "Five of eight in 2026.", "Any win lifts them to 5th."]);
  assert.equal(stripCitations("a win [12] here"), "a win here");
  const meta = validateStory({ ...story, beats: ["The only meeting the app holds was in 2025.", "b", "c", "d"] }, []);
  assert.equal(meta.ok, false);
  assert.match(meta.errors[0], /mentions the app or its records \("the app"\)/);
  assert.equal(validateStory({ ...story, beats: ["Their last meeting, on 15 November 2025, went 24–23.", "b", "c", "d"] }, []).ok, true);
  // the dry brief's gate: three beats are enough, rating points are not copy
  const three = { headline: "h", beats: ["a", "b", "c"], sources: [] };
  assert.equal(validateStory(three, [], { voice: "dry" }).ok, true);
  assert.equal(validateStory(three, [], { voice: "preview" }).ok, true, "three beats pass the preview gate too");
  const pts = validateStory({ ...three, beats: ["A win lifts them to 85.56, above England.", "b", "c"] }, []);
  assert.equal(pts.ok, false, "the default gate is the dry one");
  assert.match(pts.errors[0], /rating points in the copy \("85\.56"\)/);
  assert.equal(validateStory({ ...three, beats: ["A win lifts them to 85.56, above England.", "b", "c"] }, [], { voice: "preview" }).ok, true, "the preview brief may print them");
  assert.equal(validateStory({ ...three, beats: ["They won 24–23 on 15 November 2025.", "b", "c"] }, [], { voice: "dry" }).ok, true, "scores and dates are not rating points");
});

test("writeStory: the voice reaches the writer prompt, draft and revision alike", async () => {
  const prompts = [];
  const draft = { headline: "h", beats: ["a", "b", "c"], sources: [] };
  const answers = [JSON.stringify(draft), JSON.stringify({ issues: [{ claim: "a", problem: "wrong", severity: "material" }] }), JSON.stringify({ ...draft, headline: "h2" }), JSON.stringify({ issues: [] })];
  let i = 0;
  const writer = async (p) => { prompts.push(p); return answers[i++]; };
  const checker = async () => answers[i++];
  const s = await writeStory({ writer, checker }, { news: [] }, "PACK", { voice: "dry" });
  assert.equal(s.headline, "h2");
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((p) => /## The voice/.test(p)), "both writer calls carry the dry brief");
});

test("writeStory: the trace records draft, gate, verdicts and the revision, and changes nothing", async () => {
  const draft = { headline: "h", beats: ["a", "b", "c", "d"], sources: [] };
  const answers = [JSON.stringify(draft), JSON.stringify({ issues: [{ claim: "a", problem: "wrong", severity: "material" }] }), JSON.stringify({ ...draft, headline: "h2" }), JSON.stringify({ issues: [] })];
  let i = 0;
  const call = async () => answers[i++];
  const trace = [];
  const s = await writeStory({ writer: call, checker: call }, { news: [] }, "PACK", { trace });
  assert.deepEqual([s.headline, s.revised], ["h2", true]);
  assert.deepEqual(trace.map((t) => t.step), ["draft", "gate", "check", "revision", "gate", "check"]);
  assert.equal(trace[0].raw.headline, "h");
  assert.equal(trace[2].verdict, "fail");
  assert.equal(trace[2].issues.length, 1);
  assert.equal(trace[5].verdict, "pass");
  i = 0;
  const plain = await writeStory({ writer: call, checker: call }, { news: [] }, "PACK");
  assert.equal(plain.headline, "h2", "no trace, same result");
});

const okStory = {
  headline: "White's first test: a Tokyo rematch",
  beats: [
    "Japan beat Fiji 20–15 on 19 September.",
    "Fiji beat Japan 33–27 in the 2025 Pacific Nations Cup final.",
    "Jake White has been appointed Fiji coach.",
    "Japan have won three straight; Fiji have won 1 of 5 this year.",
    "Ninth v tenth in the world rankings.",
  ],
  sources: [2, 99, "x", 2],
};

test("validateStory: shape gate, sources mapped from the pack's own items only", () => {
  const news = [{ title: "A", url: "https://a" }, { title: "B", url: "https://b" }];
  const v = validateStory(okStory, news);
  assert.ok(v.ok, v.errors?.join());
  assert.deepEqual(v.story.sources, [{ title: "B", url: "https://b" }]);
  assert.ok(!validateStory({ ...okStory, headline: "x".repeat(HEADLINE_MAX + 1) }, news).ok);
  assert.ok(!validateStory({ ...okStory, beats: okStory.beats.slice(0, 2) }, news).ok, "two beats is not a story");
  assert.ok(!validateStory({ ...okStory, beats: [...okStory.beats, "a", "b"] }, news).ok);
  assert.ok(!validateStory({ ...okStory, beats: [...okStory.beats.slice(0, 4), "Kick-off is at 4:50 pm."] }, news).ok, "clock time banned");
});

const callsFrom = (writer, checker) => {
  const log = { writer: [], checker: [] };
  return {
    log,
    calls: {
      writer: async (p) => { log.writer.push(p); return JSON.stringify(writer.shift()); },
      checker: async (p) => { log.checker.push(p); return JSON.stringify(checker.shift()); },
    },
  };
};

test("writeStory: pass first time = 2 calls", async () => {
  const pack = { news: [] };
  const { calls, log } = callsFrom([okStory], [{ issues: [{ severity: "minor", problem: "style" }] }]);
  const s = await writeStory(calls, pack, "PACK");
  assert.equal(s.revised, false);
  assert.equal(log.writer.length + log.checker.length, 2);
});

test("writeStory: a material issue gets one revision carrying the issues, then passes", async () => {
  const { calls, log } = callsFrom([okStory, okStory], [{ issues: [{ severity: "material", claim: "17 wins", problem: "head-to-head total not in pack" }] }, { issues: [] }]);
  const s = await writeStory(calls, { news: [] }, "PACK");
  assert.equal(s.revised, true);
  assert.match(log.writer[1], /head-to-head total not in pack/);
});

test("writeStory: fails twice → throws (the caller keeps any previous story)", async () => {
  const bad = { issues: [{ severity: "material", problem: "stale item as current" }] };
  const { calls } = callsFrom([okStory, okStory], [bad, bad]);
  await assert.rejects(writeStory(calls, { news: [] }, "PACK"), /fact-check failed twice/);
});

// ---- cache and the run ------------------------------------------------------------

test("decide: write when new, facts moved or the brief changed; keep while fresh; check news once stale", () => {
  const prev = { factsHash: "f", packHash: "p", generatedAt: new Date(NOW - 2 * 3600e3).toISOString(), voice: "dry" };
  assert.equal(decide(null, "f", NOW), "write");
  assert.equal(decide(prev, "g", NOW), "write");
  assert.equal(decide(prev, "f", NOW), "keep");
  assert.equal(decide({ ...prev, generatedAt: new Date(NOW - (NEWS_REFRESH_HOURS + 1) * 3600e3).toISOString() }, "f", NOW), "check");
  // a story written under another brief is rewritten; one with no brief recorded was the preview's
  assert.equal(decide({ ...prev, voice: "preview" }, "f", NOW), "write");
  const { voice, ...unbriefed } = prev;
  assert.equal(decide(unbriefed, "f", NOW), "write");
  assert.equal(decide(unbriefed, "f", NOW, NEWS_REFRESH_HOURS, "preview"), "keep");
});

const runArgs = (over = {}) => ({
  fixtures: [fixture(), fixture({ id: "gone", date: "2026-10-17T05:00:00Z", homeScore: 10, awayScore: 20 })],
  teamEvents, rankings, nations: null, archive: null, pool: POOL, now: NOW, log: () => {}, ...over,
});

test("buildStorylines: writes the story with the output shape, drops played games", async () => {
  let writes = 0;
  const write = async () => { writes++; return { headline: "H", beats: ["a", "b", "c", "d"], sources: [], model: "claude-haiku-5-5" }; };
  const previous = { stories: { gone: { home: "X", away: "Y" } } };
  const { stories, report } = await buildStorylines(runArgs({ write, previous }));
  assert.equal(writes, 1);
  assert.deepEqual(Object.keys(stories), ["espn-604593"]);
  assert.deepEqual(report.dropped, ["gone"]);
  const s = stories["espn-604593"];
  assert.deepEqual(Object.keys(s).sort(), ["away", "beats", "factsHash", "generatedAt", "headline", "home", "kickoff", "model", "packHash", "sources", "voice"].sort());
  assert.equal(s.voice, "dry", "the brief it was written under");
  assert.equal(s.home, "JPN");
  assert.equal(s.kickoff, "2026-10-24T05:50:00.000Z");
  assert.equal(s.generatedAt, new Date(NOW).toISOString());
  const file = storylinesFile(stories, NOW);
  assert.equal(file.schemaVersion, SCHEMA_VERSION);
  assert.equal(file.updatedAt, new Date(NOW).toISOString());
});

test("buildStorylines: an unchanged pack costs nothing — no widener, no model call, same object", async () => {
  const write = async () => ({ headline: "H", beats: ["a", "b", "c", "d"], sources: [], model: "m" });
  const first = await buildStorylines(runArgs({ write }));
  let widened = 0;
  let wrote = 0;
  const again = await buildStorylines(runArgs({
    previous: { stories: first.stories }, now: NOW + 3600e3,
    widen: async () => { widened++; return []; },
    write: async () => { wrote++; return {}; },
  }));
  assert.equal(widened, 0);
  assert.equal(wrote, 0);
  assert.ok(sameStories(again.stories, first.stories));
});

test("buildStorylines: past the refresh age, same news → kept after one widener call; new news → rewritten", async () => {
  const write = async () => ({ headline: "H", beats: ["a", "b", "c", "d"], sources: [], model: "m" });
  const first = await buildStorylines(runArgs({ write }));
  const later = NOW + (NEWS_REFRESH_HOURS + 1) * 3600e3;
  let wrote = 0;
  const w2 = async () => { wrote++; return { headline: "H2", beats: ["a", "b", "c", "d"], sources: [], model: "m" }; };
  const same = await buildStorylines(runArgs({ previous: { stories: first.stories }, now: later, write: w2 }));
  assert.equal(wrote, 0);
  assert.deepEqual(same.report.checked.length, 1);
  const fresh = await buildStorylines(runArgs({
    previous: { stories: first.stories }, now: later, write: w2,
    widen: async () => [item("Fiji name three uncapped players for Japan test", new Date(later - 3600e3).toUTCString())],
  }));
  assert.equal(wrote, 1);
  assert.equal(fresh.stories["espn-604593"].headline, "H2");
});

test("buildStorylines: a changed result rewrites at once; a failed write keeps the previous story", async () => {
  const write = async () => ({ headline: "H", beats: ["a", "b", "c", "d"], sources: [], model: "m" });
  const first = await buildStorylines(runArgs({ write }));
  const moved = { ...rankings, rankings: { ...rankings.rankings, JPN: { rank: 8, points: 78 } } };
  const failing = async () => { throw new Error("fact-check failed twice"); };
  const r = await buildStorylines(runArgs({ previous: { stories: first.stories }, now: NOW + 3600e3, rankings: moved, write: failing }));
  assert.equal(r.report.failed.length, 1);
  assert.equal(r.stories["espn-604593"], first.stories["espn-604593"]);
});

test("buildStorylines: no model key → nothing written, played games still dropped", async () => {
  const previous = { stories: { gone: { home: "X" } } };
  const r = await buildStorylines(runArgs({ previous, write: null }));
  assert.deepEqual(r.stories, {});
  assert.deepEqual(r.report.skipped.length, 1);
  assert.deepEqual(r.report.dropped, ["gone"]);
});

test("buildStorylines: per-run cap on stories written", async () => {
  let wrote = 0;
  const write = async () => { wrote++; return { headline: "H", beats: ["a", "b", "c", "d"], sources: [], model: "m" }; };
  const many = Array.from({ length: 5 }, (_, i) => fixture({ id: `f${i}`, date: new Date(NOW + (i + 1) * DAY).toISOString() }));
  const r = await buildStorylines(runArgs({ fixtures: many, write, maxGenerate: 2 }));
  assert.equal(wrote, 2);
  assert.equal(r.report.skipped.length, 3);
});

test("sameStories ignores key order", () => {
  assert.ok(sameStories({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } }));
  assert.ok(!sameStories({ a: { x: 1 } }, { a: { x: 2 } }));
});
