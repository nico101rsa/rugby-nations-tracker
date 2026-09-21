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
  buildWorldCheckPrompt,
  applyWorldCheck,
  parseWorldHighlightsDetailed,
  labelledNonMens,
  NON_MENS,
  PARSE_CAP,
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

test("buildWorldPrompt carries every candidate edition, the JSON contract and the standing notes", () => {
  const p = buildWorldPrompt(candidates, "2026-09-21");
  for (const c of candidates) assert.ok(p.includes(`### ${c.team}\n${c.heading}\n${c.body}`));
  assert.ok(p.includes('{"highlights": ['));
  assert.ok(!p.includes("Argentina"));
  assert.ok(!p.includes("Standing notes"));
  assert.match(p, /Men's senior internationals are the default/);
  const withNotes = buildWorldPrompt(candidates, "2026-09-21", "- Never lead with an opinion piece.");
  assert.match(withNotes, /Standing notes[\s\S]*Never lead with an opinion piece/);
});

test("parseWorldHighlights drops a line that loses the women's / age-grade label", () => {
  const cands = [
    { teamId: 386, team: "England", heading: "England women end 39-match run in draw with Canada", body: "The Red Roses drew 26-26 at Sandy Park." },
    { teamId: 387, team: "France", heading: "France U20 beat Italy", body: "A 40-10 win in Treviso." },
    { teamId: 463, team: "Japan", heading: "Japan lift the Pacific Nations Cup", body: "Japan beat Fiji 20-15." },
  ];
  const out = parseWorldHighlights({ highlights: [
    { team: "England", text: "England's 39-match winning run ends in a draw with Canada." },
    { team: "France", text: "France U20 beat Italy 40-10 in Treviso." },
    { team: "Japan", text: "Japan beat Fiji 20-15 to lift the Pacific Nations Cup." },
  ] }, cands);
  assert.deepEqual(out.map((h) => h.team), ["France", "Japan"]);
  assert.ok(NON_MENS.test("the Red Roses") && NON_MENS.test("Wallaroos") && !NON_MENS.test("the Wallabies"));
  // The label must be about the SUBJECT nation: "Wallaroos" labels an
  // Australia line, not a France line about beating them.
  assert.equal(labelledNonMens("France recover to beat the Wallaroos.", "France"), false);
  assert.equal(labelledNonMens("Wallaroos collapse from 19-0 up in Aix.", "Australia"), true);
  assert.equal(labelledNonMens("Red Roses' 39-match run ends.", "England"), true);
  assert.equal(labelledNonMens("France women recover to beat Australia.", "France"), true);
  const { rejected } = parseWorldHighlightsDetailed({ highlights: [
    { team: "England", text: "England's 39-match winning run ends in a draw with Canada." },
    { team: "Wales", text: "A line for a nation not in today's set." },
    { team: "Japan", text: "Japan beat Fiji 27-24 for the title." },
  ] }, cands);
  assert.deepEqual(rejected.map((r) => [r.team, r.problem]), [
    ["England", "the England briefing is about the women's / age-grade side and the line does not say so"],
    ["Wales", "not one of today's briefings"],
    ["Japan", "the number 27 is not in the Japan briefing"],
  ]);
});

test("buildWorldCheckPrompt pairs every line with its source briefing", () => {
  const hl = [{ teamId: 463, team: "Japan", text: "Japan beat Fiji 27-24 to lift the Pacific Nations Cup." }];
  const p = buildWorldCheckPrompt(hl, candidates, "2026-09-21");
  assert.match(p, /### Japan\nRoundup line: Japan beat Fiji 27-24[\s\S]*Source briefing: Eddie Jones guides Japan/);
  // Labels are the code gate's job; the checker is told to leave them alone.
  assert.match(p, /never flag a line for a missing or a present label/);
  assert.doesNotMatch(p, /Material errors[\s\S]*and the line does not say so/);
  assert.ok(p.includes('{"issues": ['));
});

test("applyWorldCheck drops only material issues, matched by nation", () => {
  const hl = [
    { teamId: 463, team: "Japan", text: "A." },
    { teamId: 386, team: "England", text: "B." },
    { teamId: 387, team: "France", text: "C." },
  ];
  const { kept, dropped } = applyWorldCheck(hl, { issues: [
    { team: "england", problem: "Red Roses match not labelled", severity: "material" },
    { team: "France", problem: "could be closer to source", severity: "minor" },
    { team: "Wales", problem: "not in the list", severity: "material" },
    null,
  ] });
  assert.deepEqual(kept.map((h) => h.team), ["Japan", "France"]);
  assert.deepEqual(dropped, [{ team: "England", text: "B.", problem: "Red Roses match not labelled" }]);
  assert.equal(applyWorldCheck(hl, null).kept.length, 3);
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
    { team: "Japan", text: Array(20).fill("word").join(" ") },
  ] }, candidates);
  assert.deepEqual(out.map((h) => h.team), ["England"]);
  assert.equal(out[0].text, "Shaun Edwards says he would welcome a call from Steve Borthwick.");
});

test("parseWorldHighlights caps the list at four and tolerates junk", () => {
  const many = { highlights: Array(20).fill(0).map((_, i) => ({ team: candidates[i % 4].team, text: `Line number one for a nation ${i}.` })) };
  // Numbers are checked against the source, so use a digit-free line.
  many.highlights = many.highlights.map((h) => ({ ...h, text: "A perfectly ordinary highlight line for this nation." }));
  assert.equal(WORLD_MAX_ITEMS, 4);
  assert.equal(parseWorldHighlights(many, candidates).length, 4);
  // The detailed gate keeps more than the publish cap (one per nation here),
  // so the checker sees every candidate line and the cap is applied after.
  assert.equal(PARSE_CAP, 10);
  assert.equal(parseWorldHighlightsDetailed(many, candidates).kept.length, 4);
  assert.deepEqual(parseWorldHighlights(null, candidates), []);
  assert.deepEqual(parseWorldHighlights({ highlights: [null, 4, "x", {}] }, candidates), []);
});

const highlights = [
  { teamId: 463, team: "Japan", text: "Japan beat Fiji 20-15 to win the Pacific Nations Cup." },
  { teamId: 386, team: "England", text: "England's 39-match winning run ends in a draw with Canada." },
  { teamId: 467, team: "South Africa", text: "Rassie Erasmus sends Du Toit and De Allende home early." },
  { teamId: 390, team: "Scotland", text: "Shaun Edwards confirms a 2027 Six Nations return." },
];

test("worldSection makes the top story the heading and the rest the body, minus the reader's own", () => {
  const s = worldSection(highlights, 467);
  assert.equal(s.kicker, WORLD_KICKER);
  // No trailing full stop on a heading.
  assert.equal(s.heading, "Japan beat Fiji 20-15 to win the Pacific Nations Cup");
  assert.equal(
    s.body,
    "England's 39-match winning run ends in a draw with Canada. " +
      "Scotland: Shaun Edwards confirms a 2027 Six Nations return.",
  );
  assert.ok(!s.body.includes("South Africa") && !s.heading.includes("South Africa"));
  // String ids (Object.entries) resolve the same way.
  assert.equal(worldSection(highlights, "467").body, s.body);
});

test("worldSection prefixes the nation only when the line does not name it", () => {
  const s = worldSection([
    { teamId: 463, team: "Japan", text: "Eddie Jones guides Japan to the Pacific Nations Cup." },
    { teamId: 465, team: "New Zealand", text: "New Zealand’s scrum under scrutiny after the series." },
    { teamId: 390, team: "Scotland", text: "Shaun Edwards confirms a 2027 Six Nations return." },
    // "Fijian" is not "Fiji" — the reader is told whose story it is.
    { teamId: 28, team: "Fiji", text: "Fijian fatigue tells late in Tokyo." },
  ], 467);
  assert.equal(s.heading, "Eddie Jones guides Japan to the Pacific Nations Cup");
  assert.equal(
    s.body,
    "New Zealand’s scrum under scrutiny after the series. " +
      "Scotland: Shaun Edwards confirms a 2027 Six Nations return. " +
      "Fiji: Fijian fatigue tells late in Tokyo.",
  );
});

test("worldSection with one story left is heading only", () => {
  const s = worldSection(highlights.slice(0, 2), 386);
  assert.equal(s.heading, "Japan beat Fiji 20-15 to win the Pacific Nations Cup");
  assert.equal(s.body, "");
});

test("worldSection is null when nothing is left for this reader", () => {
  assert.equal(worldSection(highlights.slice(0, 1), 463), null);
  assert.equal(worldSection([], 463), null);
});

test("worldSection also drops a line that names the reader's team", () => {
  // Japan's cup-final line on the Fiji tab sits under Fiji's own account of it.
  const s = worldSection(highlights, 28, "Fiji");
  assert.equal(s.heading, "England's 39-match winning run ends in a draw with Canada");
  assert.ok(!s.body.includes("Japan beat Fiji"));
  // Without the name, only the id filter applies.
  assert.match(worldSection(highlights, 28).heading, /Japan beat Fiji/);
  // attachWorldSections passes the name through from the teams map.
  const out = attachWorldSections({ 28: { sections: [{ kicker: "K", heading: "H", body: "B" }] } }, highlights, { 28: { name: "Fiji" } });
  assert.ok(!out[28].sections[1].heading.includes("Fiji"));
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
  assert.equal(twice[467].sections[1].body, "England's 39-match winning run ends in a draw with Canada.");
});

test("worldRoundup writes, fact-checks, and ships without a revision when everything passes", async () => {
  const prompts = [];
  const call = async (p) => {
    prompts.push(p);
    if (prompts.length === 1) {
      return 'Sure:\n```json\n{"highlights":[{"team":"Japan","text":"Eddie Jones guides Japan past Fiji to the Pacific Nations Cup."}]}\n```';
    }
    return '{"issues":[]}';
  };
  const out = await worldRoundup(call, extractJson, candidates, "2026-09-21", { notes: "- Keep it short." });
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Keep it short/);
  assert.match(prompts[1], /Roundup line: Eddie Jones guides Japan/);
  assert.deepEqual(out.highlights.map((h) => h.teamId), [463]);
  assert.deepEqual(out, { ...out, checked: true, revised: false, dropped: [], unused: [] });
});

test("worldRoundup checks every gated line, publishes the top four survivors, and does not revise when four survive", async () => {
  // Six nations' worth of candidates so six lines can pass the gate.
  const six = [
    ...candidates,
    { teamId: 391, team: "Wales", heading: "Wales cut regions to three", body: "The WRU confirmed the plan." },
    { teamId: 461, team: "Australia", heading: "Wallabies recall Petaia", body: "Les Kiss named him for the Boks Test." },
  ];
  const prompts = [];
  const call = async (p) => {
    prompts.push(p);
    if (prompts.length === 1) {
      return JSON.stringify({ highlights: [
        { team: "Japan", text: "Eddie Jones guides Japan past Fiji to the Pacific Nations Cup." },
        { team: "England", text: "Shaun Edwards says he would welcome a call from Borthwick." },
        { team: "France", text: "Galthié secures protected status for Dupont." },
        { team: "South Africa", text: "Erasmus sends Du Toit and De Allende home before Sunday's Test." },
        { team: "Wales", text: "The WRU confirms Wales will cut regions to three." },
        { team: "Australia", text: "Wallabies recall Petaia for the Boks Test." },
      ] });
    }
    // The checker sees all six and removes one from the top four.
    assert.match(p, /### Australia\nRoundup line: Wallabies recall Petaia/);
    return '{"issues":[{"team":"England","problem":"not in the briefing","severity":"material"}]}';
  };
  const out = await worldRoundup(call, extractJson, six, "2026-09-21");
  assert.equal(prompts.length, 2, "no revision: four good lines survived");
  assert.deepEqual(out.highlights.map((h) => h.team), ["Japan", "France", "South Africa", "Wales"]);
  assert.deepEqual(out.unused.map((h) => h.team), ["Australia"]);
  assert.deepEqual(out.dropped.map((d) => d.team), ["England"]);
  assert.equal(out.revised, false);
});

test("worldRoundup revises once with every reason, then drops what still fails", async () => {
  const prompts = [];
  const call = async (p) => {
    prompts.push(p);
    switch (prompts.length) {
      case 1: // first draft: a bad number (code gate) and a claim the checker will reject
        return '{"highlights":[{"team":"Japan","text":"Japan beat Fiji 31-24 to lift the Pacific Nations Cup."},{"team":"England","text":"Shaun Edwards says he would welcome a call from Borthwick."},{"team":"France","text":"Galthié secures protected status for Dupont."}]}';
      case 2: // check of the first draft's survivors (England, France)
        return '{"issues":[{"team":"England","problem":"Edwards did not say that","severity":"material"}]}';
      case 3: // revision: Japan fixed, England still wrong, France kept
        assert.match(p, /these lines failed and were removed/);
        assert.match(p, /Japan: "Japan beat Fiji 31-24 to lift the Pacific Nations Cup\." — the number 31 is not in the Japan briefing/);
        assert.match(p, /England: "Shaun Edwards says he would welcome a call from Borthwick\." — Edwards did not say that/);
        return '{"highlights":[{"team":"Japan","text":"Japan beat Fiji 27-24 to lift the Pacific Nations Cup."},{"team":"England","text":"Shaun Edwards says he would welcome a call from Borthwick."},{"team":"France","text":"Galthié secures protected status for Dupont."}]}';
      default: // check of the revision
        return '{"issues":[{"team":"England","problem":"still not in the briefing","severity":"material"}]}';
    }
  };
  const out = await worldRoundup(call, extractJson, candidates, "2026-09-21");
  assert.equal(prompts.length, 4);
  assert.deepEqual(out.highlights.map((h) => h.team), ["Japan", "France"]);
  assert.equal(out.revised, true);
  assert.equal(out.checked, true);
  assert.deepEqual(out.dropped.map((d) => d.team), ["England"]);
});

test("worldRoundup keeps the first pass when the revision answers nothing usable", async () => {
  let n = 0;
  const call = async () => {
    n++;
    if (n === 1) return '{"highlights":[{"team":"Japan","text":"Japan beat Fiji 27-24 to lift the Pacific Nations Cup."},{"team":"France","text":"Galthié secures protected status for Dupont."}]}';
    if (n === 2) return '{"issues":[{"team":"Japan","problem":"wrong score","severity":"material"}]}';
    return "sorry";
  };
  const out = await worldRoundup(call, extractJson, candidates, "2026-09-21");
  assert.equal(n, 3);
  assert.deepEqual(out.highlights.map((h) => h.team), ["France"]);
  assert.equal(out.revised, false);
  assert.equal(out.dropped[0].team, "Japan");
});

test("worldRoundup ships unchecked when the checker answers nothing usable", async () => {
  let n = 0;
  const call = async () => (++n === 1 ? '{"highlights":[{"team":"Japan","text":"Japan lift the Pacific Nations Cup in Tokyo."}]}' : "sorry");
  const out = await worldRoundup(call, extractJson, candidates, "2026-09-21");
  assert.equal(out.highlights.length, 1);
  assert.equal(out.checked, false);
});

test("worldRoundup throws on an unusable writer answer and skips the call with one edition", async () => {
  await assert.rejects(() => worldRoundup(async () => "no json here", extractJson, candidates, "2026-09-21"), /no usable JSON/);
  let called = 0;
  const out = await worldRoundup(async () => { called++; return "{}"; }, extractJson, candidates.slice(0, 1), "2026-09-21");
  assert.deepEqual(out.highlights, []);
  assert.equal(called, 0);
});

test("attachWorldSections passes no name when no teams map is given", () => {
  const out = attachWorldSections(generated, highlights);
  assert.equal(out[467].sections[1].heading, "Japan beat Fiji 20-15 to win the Pacific Nations Cup");
});
