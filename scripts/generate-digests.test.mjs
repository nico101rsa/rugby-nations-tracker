import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANNED_COPY,
  validateDigest,
  buildFactCheckPrompt,
  parseVerdict,
  extractJson,
  extractLineup,
  prioritiseByLineup,
  teamsheetGaps,
  resolveTeamsheet,
} from "./generate-digests.mjs";

const body50 = Array(50).fill("word").join(" ");
const goodDigest = (overrides = {}) => ({
  date: "2026-07-11",
  edition: "Saturday 11 July",
  sections: [
    { kicker: "Team news", heading: "H", body: body50 },
    { kicker: "Injury desk", heading: "H", body: body50 },
    { kicker: "The opposition", heading: "H", body: body50 },
    { kicker: "The stakes", heading: "H", body: body50 },
  ],
  ...overrides,
});

test("validateDigest accepts a clean edition", () => {
  const { ok } = validateDigest(goodDigest(), { dateISO: "2026-07-11" });
  assert.equal(ok, true);
});

test("validateDigest rejects leaked citation markup", () => {
  const d = goodDigest();
  d.sections[0].body = `<cite index="1-2">Erasmus made 10 changes</cite> ${body50}`;
  const { ok, errors } = validateDigest(d, { dateISO: "2026-07-11" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("citation markup")), errors.join("; "));
});

test("validateDigest rejects clock times and timezones but allows scores", () => {
  const withTime = goodDigest();
  withTime.sections[3].body = `kickoff at 17:40 tonight ${body50}`;
  assert.equal(validateDigest(withTime, { dateISO: "2026-07-11" }).ok, false);

  const withTz = goodDigest();
  withTz.sections[3].heading = "Kickoff 5pm SAST";
  assert.equal(validateDigest(withTz, { dateISO: "2026-07-11" }).ok, false);

  const withScore = goodDigest();
  withScore.sections[0].body = `beat England 45-21 with a 6-2 bench ${body50}`;
  assert.equal(validateDigest(withScore, { dateISO: "2026-07-11" }).ok, true);
});

test("BANNED_COPY patterns are anchored to realistic leaks", () => {
  const [[cite], [clock], [tz]] = BANNED_COPY;
  assert.ok(cite.test('<cite index="3">'));
  assert.ok(clock.test("kicks off at 15:40"));
  assert.ok(!clock.test("won 45-21"));
  assert.ok(tz.test("8pm AEST"));
});

test("buildFactCheckPrompt embeds trusted data and the draft", () => {
  const params = {
    MASTHEAD: "Bok Watch", TEAM_NAME: "South Africa", DAY_NAME: "Saturday",
    DATE_LONG: "11 July 2026", HOME_TEAM: "South Africa", AWAY_TEAM: "Scotland",
    ROUND: 2, RANK: "1", P: "1", W: "1", D: "0", L: "0", PF: "45", PA: "21",
    PD: "+24", LAST_RESULT: "beat England 45-21 (Round 1)",
  };
  const prompt = buildFactCheckPrompt(params, goodDigest());
  assert.ok(prompt.includes("Bok Watch"));
  assert.ok(prompt.includes("beat England 45-21"));
  assert.ok(prompt.includes("severity"));
  assert.ok(prompt.includes("Team news"));
});

test("parseVerdict computes the verdict from material issues only", () => {
  assert.equal(parseVerdict(null).verdict, "fail");
  assert.equal(parseVerdict({ issues: [] }).verdict, "pass");
  assert.equal(parseVerdict({ issues: [{ problem: "x", severity: "minor" }] }).verdict, "pass");
  const v = parseVerdict({ issues: [{ problem: "x", severity: "material" }, { problem: "y", severity: "minor" }, "junk", null] });
  assert.equal(v.verdict, "fail");
  assert.equal(v.issues.length, 1); // minor + junk dropped
  // an issue without a severity label is treated as minor (never fails alone)
  assert.equal(parseVerdict({ issues: [{ problem: "unlabeled" }] }).verdict, "pass");
});

test("extractJson digs a JSON object out of fenced prose", () => {
  const obj = extractJson('Here you go:\n```json\n{"a": 1}\n```\nthanks');
  assert.deepEqual(obj, { a: 1 });
});

// ---- source pack + review helpers ----

import { parseRss, htmlToText, buildReviewPrompt } from "./generate-digests.mjs";

test("parseRss extracts items and strips CDATA/entities", () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Boks name squad &amp; bench]]></title><link>https://x.test/a</link><description>Ten changes</description><pubDate>Fri, 10 Jul 2026 10:00:00 GMT</pubDate></item>
    <item><title>No link item</title><link></link></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Boks name squad & bench");
  assert.equal(items[0].desc, "Ten changes");
});

test("htmlToText drops script/nav and collapses whitespace", () => {
  const html = `<html><nav>menu menu</nav><script>var x=1;</script><p>Erasmus  made <b>10</b>\n changes.</p></html>`;
  const text = htmlToText(html);
  assert.equal(text, "Erasmus made 10 changes.");
});

test("buildReviewPrompt includes every edition and the criteria", () => {
  const prompt = buildReviewPrompt(
    [{ team: "South Africa", digest: { edition: "Saturday 11 July" } }],
    "2026-07-11",
  );
  assert.ok(prompt.includes("South Africa"));
  assert.ok(prompt.includes("prompt_notes"));
  assert.ok(prompt.includes("Facts"));
});

// ---- teamsheet (optional field) ----------------------------------------------

const sheet = () => ({
  starters: Array.from({ length: 15 }, (_, i) => ({ no: i + 1, name: `Player ${i + 1}` })),
  bench: Array.from({ length: 8 }, (_, i) => ({ no: i + 16, name: `Sub ${i + 16}` })),
});

test("validateDigest passes without a teamsheet (absence never fails)", () => {
  const { ok, digest } = validateDigest(goodDigest(), { dateISO: "2026-07-11" });
  assert.equal(ok, true);
  assert.equal("teamsheet" in digest, false);
});

test("validateDigest copies a valid teamsheet into the clean digest", () => {
  const { ok, digest } = validateDigest(goodDigest({ teamsheet: sheet() }), { dateISO: "2026-07-11" });
  assert.equal(ok, true);
  assert.equal(digest.teamsheet.starters.length, 15);
  assert.equal(digest.teamsheet.bench.length, 8);
  assert.deepEqual(digest.teamsheet.starters[0], { no: 1, name: "Player 1" });
});

test("teamsheet without a bench is fine; bench key omitted when empty", () => {
  const t = sheet();
  delete t.bench;
  const { ok, digest } = validateDigest(goodDigest({ teamsheet: t }), { dateISO: "2026-07-11" });
  assert.equal(ok, true);
  assert.equal("bench" in digest.teamsheet, false);
});

test("teamsheet with wrong starter count fails the edition", () => {
  const t = sheet();
  t.starters.pop();
  const { ok, errors } = validateDigest(goodDigest({ teamsheet: t }), { dateISO: "2026-07-11" });
  assert.equal(ok, false);
  assert.ok(errors.some((e) => e.includes("14 starters")), errors.join("; "));
});

test("teamsheet with duplicate or out-of-range jerseys fails", () => {
  const dup = sheet();
  dup.starters[1].no = 1; // two number 1s
  assert.equal(validateDigest(goodDigest({ teamsheet: dup }), { dateISO: "2026-07-11" }).ok, false);

  const benchLow = sheet();
  benchLow.bench[0].no = 15; // bench jersey below 16
  assert.equal(validateDigest(goodDigest({ teamsheet: benchLow }), { dateISO: "2026-07-11" }).ok, false);
});

test("teamsheet starters are sorted by jersey and names trimmed", () => {
  const t = sheet();
  t.starters.reverse();
  t.starters[0].name = "  Handré Pollard  ";
  const { digest } = validateDigest(goodDigest({ teamsheet: t }), { dateISO: "2026-07-11" });
  assert.equal(digest.teamsheet.starters[0].no, 1);
  assert.equal(digest.teamsheet.starters.at(-1).name, "Handré Pollard"); // was no 15 after reverse
});

test("hasNumberedLineup detects a real numbered XV and rejects prose", async () => {
  const { hasNumberedLineup } = await import("./generate-digests.mjs");
  const xv = "Springboks: 15 Aphelele Fassi, 14 Cheslin Kolbe, 13 Jesse Kriel, 12 Damian de Allende, 11 Kurt-Lee Arendse, 10 Handré Pollard, 9 Grant Williams, 8 Jasper Wiese, 7 Pieter-Steph du Toit, 6 Siya Kolisi, 5 RG Snyman, 4 Eben Etzebeth, 3 Thomas du Toit, 2 Malcolm Marx, 1 Ox Nché";
  assert.equal(hasNumberedLineup(xv), true);
  assert.equal(hasNumberedLineup("Rassie made 10 changes and named 5 Bulls. The 9 Grant Williams pick surprised."), false);
  assert.equal(hasNumberedLineup("beat England 45-21 with a 6-2 bench split"), false);
});

test("buildFactCheckPrompt injects standing checker notes and calibration rules", async () => {
  const { buildFactCheckPrompt } = await import("./generate-digests.mjs");
  const params = { MASTHEAD: "Bok Watch", TEAM_NAME: "South Africa", DAY_NAME: "Saturday", DATE_LONG: "11 July 2026",
    HOME_TEAM: "South Africa", AWAY_TEAM: "Scotland", ROUND: "2", RANK: "1", P: "1", W: "1", D: "0", L: "0",
    PF: "45", PA: "21", PD: "+24", LAST_RESULT: "beat England 45-21 (Round 1)" };
  const withNotes = buildFactCheckPrompt(params, goodDigest(), "pack", "- never flag trusted-data claims");
  assert.ok(withNotes.includes("Standing calibration notes"));
  assert.ok(withNotes.includes("never flag trusted-data claims"));
  assert.ok(withNotes.includes("disagreements BETWEEN pack sources"));
  assert.ok(withNotes.includes("Teamsheet rule"));
  const without = buildFactCheckPrompt(params, goodDigest(), "pack");
  assert.ok(!without.includes("Standing calibration notes"));
});

test("buildCheckerTunePrompt embeds failures, publish rate and hard limits", async () => {
  const { buildCheckerTunePrompt } = await import("./generate-digests.mjs");
  const p = buildCheckerTunePrompt(
    [{ team: "Scotland", reason: "fact-check failed: sources disagree on no 12" }], 7, "- existing note");
  assert.ok(p.includes("Scotland"));
  assert.ok(p.includes("7/12"));
  assert.ok(p.includes("existing note"));
  assert.ok(p.includes("Never propose weakening"));
});

// ---- extractLineup: code-side teamsheet parser -------------------------------
// The 2026-07-11 fix asks the writer model to copy the XV; on 2026-07-14 England
// and Argentina had "lineup in pack but NOT extracted" — the model was handed a
// numbered XV and still dropped it. This deterministic parser is the fallback.

const SA_XV =
  "Springboks team to face Wales: 15 Aphelele Fassi, 14 Jaco Williams, 13 Jesse Kriel, " +
  "12 Damian de Allende, 11 Kurt-Lee Arendse, 10 Vusi Moyo, 9 Cobus Reinach, 8 Jasper Wiese, " +
  "7 Pieter-Steph du Toit, 6 Paul de Villiers, 5 Ruben van Heerden, 4 Cobus Wiese, 3 Carlu Sadie, " +
  "2 Malcolm Marx, 1 Gerhard Steenekamp. Replacements: 16 Bongi Mbonambi, 17 Boan Venter, " +
  "18 Wilco Louw, 19 Franco Mostert, 20 Marco van Staden, 21 Grant Williams, 22 Handré Pollard, " +
  "23 Canan Moodie.";

test("extractLineup parses a comma-separated 15→1 XV plus an 8-man bench", () => {
  const sheet = extractLineup(SA_XV);
  assert.equal(sheet.starters.length, 15);
  assert.deepEqual(sheet.starters.find((p) => p.no === 10), { no: 10, name: "Vusi Moyo" });
  // multi-word surnames with lowercase particles must survive intact
  assert.deepEqual(sheet.starters.find((p) => p.no === 7), { no: 7, name: "Pieter-Steph du Toit" });
  assert.deepEqual(sheet.starters.find((p) => p.no === 5), { no: 5, name: "Ruben van Heerden" });
  assert.equal(sheet.starters[0].no, 1); // returned sorted low→high
  assert.equal(sheet.bench.length, 8);
  assert.deepEqual(sheet.bench.find((p) => p.no === 22), { no: 22, name: "Handré Pollard" });
});

test("extractLineup parses a newline '1. Name' list and omits an empty bench", () => {
  const nl =
    "England XV to face Argentina:\n1. Ellis Genge\n2. Jamie George\n3. Will Stuart\n4. Maro Itoje\n" +
    "5. George Martin\n6. Tom Curry\n7. Sam Underhill\n8. Ben Earl\n9. Raffi Quirke\n10. Marcus Smith\n" +
    "11. Tommy Freeman\n12. Fraser Dingwall\n13. Ollie Lawrence\n14. Immanuel Feyi-Waboso\n15. Freddie Steward";
  const sheet = extractLineup(nl);
  assert.equal(sheet.starters.length, 15);
  assert.deepEqual(sheet.starters.find((p) => p.no === 14), { no: 14, name: "Immanuel Feyi-Waboso" });
  assert.equal("bench" in sheet, false); // no reserves in the text → key omitted
});

test("extractLineup returns null for prose without a full numbered XV", () => {
  assert.equal(extractLineup("Rassie made 10 changes and named 4 debutants including Vusi Moyo at 10."), null);
});

test("extractLineup returns null when a starter jersey is missing (never partial)", () => {
  const missing3 = SA_XV.replace("3 Carlu Sadie, ", ""); // now only 14 starters
  assert.equal(extractLineup(missing3), null);
});

test("extractLineup ignores page-chrome noise, club tags and boundary labels (real-page shape)", () => {
  // Mirrors rugbypass/planetrugby: leading scoreboard + date noise ("13 July",
  // "14 AEST", "10 Scotland"), per-player club parentheticals, a "Replacements:"
  // label butting the last starter, and a trailing "Date" after the bench.
  const MESSY =
    "Rugby News 6 Nations U20 Watch FT South Africa 43 10 Scotland 13 July 2026 14 AEST " +
    "Rassie Erasmus named four debutants. Springboks XV: 15 Aphelele Fassi (Toshiba); " +
    "14 Jaco Williams (Hollywoodbets Sharks), 13 Jesse Kriel (Canon Eagles), " +
    "12 Damian de Allende (Wild Knights), 11 Kurt-Lee Arendse (Dynaboars); 10 Vusi Moyo (Sharks), " +
    "9 Cobus Reinach (Stormers); 1 Gerhard Steenekamp (Bulls), 2 Malcolm Marx (Spears), " +
    "3 Carlu Sadie (Bordeaux), 4 Cobus Wiese (Bulls), 5 Ruben van Heerden (Montpellier), " +
    "6 Paul de Villiers (Stormers), 7 Pieter-Steph du Toit (Verblitz, captain), 8 Jasper Wiese (Toulon) " +
    "Replacements: 16 Andre-Hugo Venter, 17 Jan-Hendrik Wessels, 18 Wilco Louw, 19 Ben-Jason Dixon, " +
    "20 Marco van Staden, 21 Herschel Jantjies, 22 Manie Libbok, 23 Damian Willemse Date published 13 July";
  const sheet = extractLineup(MESSY);
  assert.equal(sheet.starters.length, 15);
  assert.deepEqual(sheet.starters.find((p) => p.no === 1), { no: 1, name: "Gerhard Steenekamp" }); // not "…Replacements"
  assert.deepEqual(sheet.starters.find((p) => p.no === 4), { no: 4, name: "Cobus Wiese" }); // not page noise
  assert.deepEqual(sheet.starters.find((p) => p.no === 13), { no: 13, name: "Jesse Kriel" }); // not "July"
  assert.deepEqual(sheet.starters.find((p) => p.no === 14), { no: 14, name: "Jaco Williams" }); // not "AEST"
  assert.equal(sheet.bench.length, 8);
  assert.deepEqual(sheet.bench.find((p) => p.no === 23), { no: 23, name: "Damian Willemse" }); // not "…Date"
});

// ---- resolveTeamsheet: the deterministic parse outranks the model ------------
// 2026-07-14 (post-fix): with SA's article fetch repaired, the MODEL produced the
// teamsheet and got it wrong — jerseys 4/5 and 11/14 swapped. The code parse of
// the same article is verbatim, so it must OVERRIDE the model, not just backfill.

test("resolveTeamsheet overrides a model teamsheet that disagrees with the printed XV", () => {
  const modelSheet = {
    starters: [
      { no: 1, name: "Gerhard Steenekamp" }, { no: 2, name: "Malcolm Marx" }, { no: 3, name: "Carlu Sadie" },
      { no: 4, name: "Ruben van Heerden" }, // swapped with 5
      { no: 5, name: "Cobus Wiese" },
      { no: 6, name: "Paul de Villiers" }, { no: 7, name: "Pieter-Steph du Toit" }, { no: 8, name: "Jasper Wiese" },
      { no: 9, name: "Cobus Reinach" }, { no: 10, name: "Vusi Moyo" },
      { no: 11, name: "Jaco Williams" }, // swapped with 14
      { no: 12, name: "Damian de Allende" }, { no: 13, name: "Jesse Kriel" },
      { no: 14, name: "Kurt-Lee Arendse" }, { no: 15, name: "Aphelele Fassi" },
    ],
  };
  const { sheet, note } = resolveTeamsheet(modelSheet, [{ text: SA_XV }]);
  assert.deepEqual(sheet.starters.find((p) => p.no === 4), { no: 4, name: "Cobus Wiese" });
  assert.deepEqual(sheet.starters.find((p) => p.no === 5), { no: 5, name: "Ruben van Heerden" });
  assert.deepEqual(sheet.starters.find((p) => p.no === 11), { no: 11, name: "Kurt-Lee Arendse" });
  assert.deepEqual(sheet.starters.find((p) => p.no === 14), { no: 14, name: "Jaco Williams" });
  assert.match(note, /corrected/);
});

test("resolveTeamsheet keeps the model sheet when no XV can be parsed, and yields null when neither exists", () => {
  const modelSheet = { starters: [{ no: 1, name: "Someone" }] };
  assert.equal(resolveTeamsheet(modelSheet, [{ text: "prose only, no lineup" }]).sheet, modelSheet);
  assert.equal(resolveTeamsheet(null, [{ text: "prose only" }]).sheet, null);
});

// ---- extractLineup must not hallucinate a lineup out of prose ----------------
// 2026-07-15: the parser shipped a FABRICATED Wales XV live — "4 Can, 5 Tidy,
// 6 Got, 7 The" — by finding numbers next to capitalised words scattered through
// prose, and it lifted a Wales U20 side as the senior team. A false positive is
// worse than a blank card, so the bar is now: real names, tightly listed, senior.

test("extractLineup leaves no stray punctuation when a label follows the last starter", () => {
  // "… 1 Gerhard Steenekamp. Replacements: 16 …" — popping "Replacements"
  // re-exposes the full stop, which used to ship as "Gerhard Steenekamp."
  const s = extractLineup(SA_XV.replace("1 Gerhard Steenekamp.", "1 Gerhard Steenekamp. Replacements"));
  assert.deepEqual(s.starters.find((p) => p.no === 1), { no: 1, name: "Gerhard Steenekamp" });
});

test("extractLineup rejects prose that merely has numbers beside capitalised words", () => {
  const JUNK =
    "Wales build-up: 1 George Tuckley impressed. 2 Tom Howe is fit. 3 Jac Pritchard returns. " +
    "4 Can the pack hold? 5 Tidy work at the breakdown. 6 Got to be sharper. 7 The lineout wobbled. " +
    "8 Evan Minto starts. 9 Sion Davies is named. 10 Carwyn Leggatt-Jones kicks. 11 Tom Bowen wide. " +
    "12 Steffan Emanuel centre. 13 Osian Darwin-Lewis outside. 14 Rhys Cummings wing. 15 Lewis Edwards full-back.";
  assert.equal(extractLineup(JUNK), null); // single-word "names" → not a lineup
});

test("extractLineup rejects a lineup spread too far apart to be a printed XV", () => {
  const filler = " lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(3);
  const spread = Array.from({ length: 15 }, (_, i) => `${i + 1} Player Name${filler}`).join(" ");
  assert.equal(extractLineup(spread), null); // > span limit → prose, not a team list
});

test("resolveTeamsheet ignores age-grade and non-senior lineup articles", () => {
  const u20 = [{ title: "Wales U20 team named to face Ireland", text: SA_XV }];
  assert.equal(resolveTeamsheet(null, u20).sheet, null);
  const women = [{ title: "Wales Women name side", text: SA_XV }];
  assert.equal(resolveTeamsheet(null, women).sheet, null);
  // the senior article still parses
  assert.ok(resolveTeamsheet(null, [{ title: "Springbok team to face Wales", text: SA_XV }]).sheet);
});

// ---- prioritiseByLineup: fetch ordering --------------------------------------
// SA's 2026-07-14 run got "12 headlines, 0 articles": Bing ranked local SA
// outlets (which fail to fetch) first, so the planetrugby/rugbypass piece that
// prints the XV sat past the body-fetch cutoff. Fetch lineup-titled items first.

test("prioritiseByLineup floats team-selection headlines ahead, order-stable otherwise", () => {
  const items = [
    { title: "Wales v South Africa: five talking points for Durban" },
    { title: "Injury latest from the Springbok camp" },
    { title: "Springbok team to face Wales named as Erasmus picks four debutants" },
  ];
  const out = prioritiseByLineup(items);
  assert.equal(out[0].title, items[2].title); // the "team named" piece leads
  assert.equal(out[1].title, items[0].title); // non-lineup items keep their order
  assert.equal(out[2].title, items[1].title);
});

// ---- teamsheetGaps: the safeguard that was missing ---------------------------
// The old audit only warned within 48h and only to the Actions log. This pure
// evaluator (used by the generator audit AND the daily watchdog email) flags a
// team playing inside the match-week window that has no published squad.

test("teamsheetGaps flags an imminent team with no squad, ignores covered and distant teams", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const WINDOW = 5 * 24 * 60 * 60 * 1000;
  const fixtures = [
    { date: "2026-07-18T15:40:00+00:00", home: { id: 467 }, away: { id: 391 } }, // 4d out
    { date: "2026-11-06T12:00:00+00:00", home: { id: 386 }, away: { id: 460 } }, // months out
  ];
  const digests = { 391: { teamsheet: { starters: [] } } }; // Wales covered, SA not
  const gaps = teamsheetGaps(fixtures, digests, now, WINDOW);
  assert.deepEqual(gaps.map((g) => g.teamId), [467]);
});
