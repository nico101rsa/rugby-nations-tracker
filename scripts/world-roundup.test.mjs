import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORLD_KICKER,
  WORLD_MAX_ITEMS,
  roundupCandidates,
  buildWorldPrompt,
  parseWorldHighlights,
  worldSection,
  attachWorldSections,
  worldRoundup,
} from "./world-roundup.mjs";
import { extractJson } from "./generate-digests.mjs";

const TEAMS = { 386: { name: "England" }, 387: { name: "France" }, 463: { name: "Japan" }, 467: { name: "South Africa" }, 460: { name: "Argentina" } };
const story = (heading, body) => ({ date: "2026-09-21", edition: "Monday 21 September", sections: [{ kicker: "News", heading, body }] });
const generated = {
  386: story("Shaun Edwards confirms interest in joining Borthwick's England staff", "Edwards said he would welcome a call after 14 years with Wales."),
  387: story("Fabien Galthié secures protected status for Antoine Dupont", "The LNR agreed a 25-player list ahead of the 2027 World Cup."),
  463: story("Eddie Jones guides Japan to Pacific Nations Cup triumph over Fiji", "Japan won 27-24 in Denver with a late try."),
  467: story("Rassie Erasmus releases Pieter-Steph du Toit early", "Du Toit and de Allende go home before Sunday's Test."),
  460: { ...story("Argentina concede 346 points across 11 matches", "A stat note."), rung: "data" },
};
const candidates = roundupCandidates(TEAMS, generated);

test("roundupCandidates takes today's story editions and skips data editions", () => {
  assert.deepEqual(candidates.map((c) => c.team), ["England", "France", "Japan", "South Africa"]);
  assert.equal(candidates[0].teamId, 386);
  assert.equal(candidates[2].heading, "Eddie Jones guides Japan to Pacific Nations Cup triumph over Fiji");
});

test("buildWorldPrompt carries every candidate edition and the JSON contract", () => {
  const p = buildWorldPrompt(candidates, "2026-09-21");
  for (const c of candidates) assert.ok(p.includes(`### ${c.team}\n${c.heading}\n${c.body}`));
  assert.ok(p.includes('{"highlights": ['));
  assert.ok(!p.includes("Argentina"));
});

test("parseWorldHighlights keeps well-formed lines and drops unknown teams", () => {
  const out = parseWorldHighlights({ highlights: [
    { team: "japan", text: "Eddie Jones' side beat Fiji 27-24 to lift the Pacific Nations Cup" },
    { team: "Wales", text: "Something about a team not in today's set." },
    { team: "England", text: "Shaun Edwards says he would welcome a call from Steve Borthwick." },
  ] }, candidates);
  assert.deepEqual(out.map((h) => h.teamId), [463, 386]);
  assert.equal(out[0].team, "Japan");
  // Terminal punctuation is added, and the team name is normalised.
  assert.equal(out[0].text, "Eddie Jones' side beat Fiji 27-24 to lift the Pacific Nations Cup.");
});

test("parseWorldHighlights drops a number the source edition never printed", () => {
  const out = parseWorldHighlights({ highlights: [
    { team: "Japan", text: "Japan beat Fiji 27-24 for a 3rd title." },
    { team: "Japan", text: "Japan beat Fiji 31-24 in Denver." },
    { team: "France", text: "Dupont is one of 25 protected players for 2027." },
  ] }, candidates);
  // 3 and 31 are not in Japan's edition; 25 and 2027 are in France's.
  assert.deepEqual(out.map((h) => h.team), ["France"]);
});

test("parseWorldHighlights strips a leading team label, dedupes, and enforces copy rules", () => {
  const out = parseWorldHighlights({ highlights: [
    { team: "England", text: "England — Shaun Edwards says he would welcome a call from Steve Borthwick." },
    { team: "England", text: "A second England line that must be dropped as a duplicate." },
    { team: "France", text: "Kickoff moved to 20:45 CET for Dupont's return." },
    { team: "South Africa", text: "Too short." },
    { team: "Japan", text: Array(40).fill("word").join(" ") },
  ] }, candidates);
  assert.deepEqual(out.map((h) => h.team), ["England"]);
  assert.equal(out[0].text, "Shaun Edwards says he would welcome a call from Steve Borthwick.");
});

test("parseWorldHighlights caps the list and tolerates junk", () => {
  const many = { highlights: Array(20).fill(0).map((_, i) => ({ team: candidates[i % 4].team, text: `Line number one for a nation ${i}.` })) };
  // Numbers are checked against the source, so use a digit-free line.
  many.highlights = many.highlights.map((h) => ({ ...h, text: "A perfectly ordinary highlight line for this nation." }));
  assert.ok(parseWorldHighlights(many, candidates).length <= WORLD_MAX_ITEMS);
  assert.deepEqual(parseWorldHighlights(null, candidates), []);
  assert.deepEqual(parseWorldHighlights({ highlights: [null, 4, "x", {}] }, candidates), []);
});

const highlights = [
  { teamId: 463, team: "Japan", text: "Eddie Jones' side beat Fiji to lift the Pacific Nations Cup." },
  { teamId: 386, team: "England", text: "Shaun Edwards says he would welcome a call from Steve Borthwick." },
  { teamId: 467, team: "South Africa", text: "Rassie Erasmus sends Du Toit and De Allende home early." },
];

test("worldSection excludes the reader's own team and labels each line", () => {
  const s = worldSection(highlights, 467);
  assert.equal(s.kicker, WORLD_KICKER);
  assert.equal(s.heading, "Headlines from Japan and England");
  assert.equal(s.body, "Japan — Eddie Jones' side beat Fiji to lift the Pacific Nations Cup. England — Shaun Edwards says he would welcome a call from Steve Borthwick.");
  assert.ok(!s.body.includes("South Africa"));
  // String ids (Object.entries) resolve the same way.
  assert.equal(worldSection(highlights, "467").body, s.body);
});

test("worldSection drops the label when the line already opens with the nation", () => {
  const s = worldSection([
    { teamId: 463, team: "Japan", text: "Japan secured the Pacific Nations Cup title by beating Fiji." },
    { teamId: 386, team: "England", text: "England's winning run ended in a draw with Canada." },
    { teamId: 465, team: "New Zealand", text: "New Zealand’s scrum is under scrutiny after the series." },
    { teamId: 390, team: "Scotland", text: "Defence coach Shaun Edwards confirmed a 2027 return." },
    // "Japanese" is not "Japan" — the label stays.
    { teamId: 28, team: "Fiji", text: "Fijian fatigue told late in Tokyo." },
  ], 467);
  assert.equal(
    s.body,
    "Japan secured the Pacific Nations Cup title by beating Fiji. " +
      "England's winning run ended in a draw with Canada. " +
      "New Zealand’s scrum is under scrutiny after the series. " +
      "Scotland — Defence coach Shaun Edwards confirmed a 2027 return. " +
      "Fiji — Fijian fatigue told late in Tokyo.",
  );
});

test("worldSection heading names up to three nations then counts the rest", () => {
  const five = [...highlights, { teamId: 387, team: "France", text: "Line one for France." }, { teamId: 391, team: "Wales", text: "Line one for Wales." }];
  assert.equal(worldSection(five, 460).heading, "Headlines from Japan, England, South Africa and 2 more");
  assert.equal(worldSection(five, 391).heading, "Headlines from Japan, England, South Africa and 1 more");
  assert.equal(worldSection(highlights.slice(0, 1), 386).heading, "Headlines from Japan");
});

test("worldSection is null when nothing is left for this reader", () => {
  assert.equal(worldSection(highlights.slice(0, 1), 463), null);
  assert.equal(worldSection([], 463), null);
});

test("attachWorldSections appends after the story, only where there is something to say", () => {
  const out = attachWorldSections(generated, highlights.slice(0, 1));
  assert.equal(out[467].sections.length, 2);
  assert.equal(out[467].sections[0].kicker, "News");
  assert.equal(out[467].sections[1].kicker, WORLD_KICKER);
  // Japan's only highlight is its own story → untouched.
  assert.equal(out[463].sections.length, 1);
  assert.equal(out[463], generated[463]);
  // Inputs are not mutated.
  assert.equal(generated[467].sections.length, 1);
});

test("attachWorldSections replaces an existing roundup rather than stacking", () => {
  const once = attachWorldSections(generated, highlights);
  const twice = attachWorldSections(once, highlights.slice(0, 2));
  assert.equal(twice[467].sections.length, 2);
  assert.equal(twice[467].sections[1].heading, "Headlines from Japan and England");
});

test("worldRoundup runs the injected model and returns parsed highlights", async () => {
  const prompts = [];
  const call = async (p) => { prompts.push(p); return 'Sure:\n```json\n{"highlights":[{"team":"Japan","text":"Eddie Jones guides Japan past Fiji to the Pacific Nations Cup."}]}\n```'; };
  const out = await worldRoundup(call, extractJson, candidates, "2026-09-21");
  assert.equal(prompts.length, 1);
  assert.deepEqual(out.map((h) => h.teamId), [463]);
});

test("worldRoundup throws on an unusable answer and skips the call with one edition", async () => {
  await assert.rejects(() => worldRoundup(async () => "no json here", extractJson, candidates, "2026-09-21"), /no usable JSON/);
  let called = 0;
  assert.deepEqual(await worldRoundup(async () => { called++; return "{}"; }, extractJson, candidates.slice(0, 1), "2026-09-21"), []);
  assert.equal(called, 0);
});
