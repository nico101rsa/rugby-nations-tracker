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
  assert.ok(prompt.includes('"verdict"'));
  assert.ok(prompt.includes("Team news"));
});

test("parseVerdict tolerates malformed checker output", () => {
  assert.equal(parseVerdict(null).verdict, "fail");
  assert.equal(parseVerdict({ verdict: "pass", issues: [] }).verdict, "pass");
  assert.equal(parseVerdict({ verdict: "PASS" }).verdict, "fail"); // strict
  const v = parseVerdict({ verdict: "fail", issues: [{ problem: "x" }, "junk", null] });
  assert.equal(v.issues.length, 1);
});

test("extractJson digs a JSON object out of fenced prose", () => {
  const obj = extractJson('Here you go:\n```json\n{"a": 1}\n```\nthanks');
  assert.deepEqual(obj, { a: 1 });
});
