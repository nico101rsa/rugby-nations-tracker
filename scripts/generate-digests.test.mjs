import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BANNED_COPY,
  validateDigest,
  buildFactCheckPrompt,
  parseVerdict,
  extractJson,
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
