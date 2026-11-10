import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradePoints, pointsToGrade, averageGrade, parseReview, firstSentence,
  previousWeek, summariseWeek, subjectFor, buildText, buildHtml, main,
} from "./email-news-weekly.mjs";

test("grades: letters to points and back", () => {
  assert.equal(gradePoints("B"), 3);
  assert.equal(gradePoints("C+"), 2.33);
  assert.equal(gradePoints("B-"), 2.67);
  assert.equal(gradePoints("nonsense"), null);
  assert.equal(pointsToGrade(3), "B");
  assert.equal(pointsToGrade(2.67), "B-");
  assert.equal(pointsToGrade(2.33), "C+");
  assert.deepEqual(averageGrade(["C+", "C+", "C+", "B-"]).grade, "C+");
  assert.deepEqual(averageGrade(["B", "B-", "B-"]).grade, "B-");
  assert.equal(averageGrade([]).grade, null);
});

test("parseReview: the grade with its verdict on the same line", () => {
  const md = `# Digest review — 2026-11-10

**Grade: B-.** Most editions are accurate and well attributed. The misses are two off-team leads.

**Classification:** 3 retrieval-starved (Fiji, Scotland, Japan), 2 badly-chosen (Argentina, Ireland).`;
  const r = parseReview(md);
  assert.equal(r.grade, "B-");
  assert.equal(r.summary, "Most editions are accurate and well attributed.");
  assert.deepEqual(r.starved, ["Fiji", "Scotland", "Japan"]);
  assert.deepEqual(r.badlyChosen, ["Argentina", "Ireland"]);
});

test("parseReview: the grade on its own line takes the next paragraph", () => {
  const md = `# Digest review — 2026-11-03

**Grade: C+**

Tally: 5 retrieval-starved (France, Ireland, Argentina, Japan, New Zealand), 3 badly-chosen (Italy, Scotland, Wales), 1 ladder-brief breach (Fiji).`;
  const r = parseReview(md);
  assert.equal(r.grade, "C+");
  const prose = parseReview("**Grade: C+.** By my count, 3 editions were retrieval-starved (France, Australia, Japan), 2 were badly chosen (England, Ireland).");
  assert.deepEqual(prose.starved, ["France", "Australia", "Japan"]);
  assert.deepEqual(prose.badlyChosen, ["England", "Ireland"]);
  assert.match(r.summary, /^Tally: 5 retrieval-starved/);
  assert.equal(r.starved.length, 5);
  assert.deepEqual(r.badlyChosen, ["Italy", "Scotland", "Wales"]);
});

test("parseReview: no grade line is no review", () => {
  assert.equal(parseReview("# nothing here"), null);
});

test("firstSentence keeps a short verdict whole and clips a long one", () => {
  assert.equal(firstSentence("All good. More detail."), "All good.");
  assert.equal(firstSentence("x".repeat(300), 20).length, 20);
});

test("previousWeek: the Monday–Sunday before, in Sydney dates", () => {
  // Mon 16 Nov 2026, 07:00 Sydney time = Sun 15 Nov 20:00 UTC.
  assert.deepEqual(previousWeek(new Date("2026-11-15T20:00:00Z")),
    ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
  // A late GitHub start on the Tuesday still reports the same week.
  assert.equal(previousWeek(new Date("2026-11-16T22:00:00Z"))[0], "2026-11-09");
});

const day = (date, grade, starved = [], badlyChosen = [], cost = 0.2) =>
  ({ date, review: grade ? { grade, summary: `${grade} day.`, starved, badlyChosen } : null, run: { model: { costUSD: cost, failed: 0, fellBack: 0 } } });

test("summariseWeek: average, trend, repeat offenders, spend", () => {
  const week = [day("2026-11-02", "C"), day("2026-11-03", "C+", ["Fiji", "Japan"], ["Italy"]), day("2026-11-04", "B", ["Fiji"]),
    day("2026-11-05", null), day("2026-11-06", "B-", ["Fiji"], ["Italy"]), day("2026-11-07", "B"), day("2026-11-08", "C+")];
  const before = [day("2026-10-26", "D+"), day("2026-10-27", "C"), day("2026-10-28", "C")];
  const w = summariseWeek(week, before);
  assert.equal(w.average.days, 6);
  assert.equal(w.average.grade, "B-"); // 2.56 is nearer B- (2.67) than C+ (2.33)
  assert.equal(w.previous.grade, "C-");
  assert.ok(w.trend > 0);
  assert.deepEqual(w.starved[0], ["Fiji", 3]);
  assert.deepEqual(w.badlyChosen, [["Italy", 2]]);
  assert.equal(w.best.review.grade, "B");
  assert.equal(Math.round(w.spend * 100), 140);
  assert.equal(subjectFor(w), "Rugby news, Mon 2 Nov – Sun 8 Nov: B- average, up from C-");
  const text = buildText(w);
  assert.match(text, /Thu 5 Nov: no review/);
  assert.match(text, /Fiji 3×/);
  const html = buildHtml(w);
  assert.match(html, /editorial\/reviews\/2026-11-03\.md/);
  assert.doesNotMatch(html, /<script/);
});

test("subjectFor: a week with no reviews says so", () => {
  const w = summariseWeek([day("2026-11-02", null)], []);
  assert.match(subjectFor(w), /no reviews this week/);
});

test("main: no key or no recipient skips the send, never throws", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.RESEND_API_KEY;
    let called = false;
    const r = await main({ now: new Date("2026-11-15T20:00:00Z"), fetchImpl: async () => { called = true; } });
    assert.equal(r.sent, false);
    assert.equal(called, false);
    process.env.RESEND_API_KEY = "test";
    delete process.env.DIGEST_EMAIL_TO;
    assert.equal((await main({ now: new Date("2026-11-15T20:00:00Z"), fetchImpl: async () => { called = true; } })).sent, false);
    assert.equal(called, false);
  } finally {
    process.env = saved;
  }
});

test("main: sends html and text to the configured recipient", async () => {
  const saved = { ...process.env };
  try {
    process.env.RESEND_API_KEY = "test";
    process.env.DIGEST_EMAIL_TO = "someone@example.com";
    let body = null;
    const r = await main({ now: new Date("2026-11-15T20:00:00Z"), fetchImpl: async (_u, o) => { body = JSON.parse(o.body); return { ok: true }; } });
    assert.equal(r.sent, true);
    assert.deepEqual(body.to, ["someone@example.com"]);
    assert.match(body.subject, /^Rugby news, Mon 9 Nov – Sun 15 Nov/);
    assert.ok(body.html && body.text);
  } finally {
    process.env = saved;
  }
});
