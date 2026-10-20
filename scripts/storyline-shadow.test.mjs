import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sydneyStamp, worstCaseUSD, resolveWriter, foldTrace, shadowStory, runShadow, totalsOf, packRecord, renderMarkdown, NOTICE,
} from "./storyline-shadow.mjs";
import { MAX_TOKENS, createTally } from "./model-router.mjs";
import { buildPack, renderPack } from "./build-storylines.mjs";

const NOW = Date.parse("2026-10-20T20:45:00Z"); // Wed 21 Oct 2026 07:45 AEDT

const fixture = {
  id: "espn-604593", date: "2026-10-24T05:50:00.000Z", timeTBC: false,
  home: { code: "JPN", name: "Japan", tracked: true }, away: { code: "FIJ", name: "Fiji", tracked: true },
  comp: { key: "test", label: "TEST", kind: "test" }, venue: "Prince Chichibu Memorial Stadium, Tokyo",
};
const rankings = { asOf: "19 October 2026", rankings: { JPN: { rank: 9, points: 77.28 }, FIJ: { rank: 10, points: 76.81 } } };
const pool = [{ title: "World Cup-winning coach White takes reins at Fiji", link: "https://example.com/white", desc: "Jake White appointed.", date: "Tue, 13 Oct 2026 13:30:00 +0000", feedName: "Outlet" }];
const pack = buildPack(fixture, { teamEvents: { teams: {} }, archive: null, rankings, nations: null, newsItems: pool, now: NOW });
const packText = renderPack(pack);

const GOOD = JSON.stringify({ headline: "White's Fiji debut in Tokyo", beats: ["Japan beat Fiji 20-15 in September.", "Fiji have a new coach.", "Form favours Japan.", "Win and Fiji go 9th."], sources: [1] });
const BAD = JSON.stringify({ headline: "Fiji own this fixture 17-5", beats: ["Fiji lead the head-to-head 17-5.", "Japan beat Fiji 20-15 in September.", "Fiji have a new coach.", "Form favours Japan."], sources: [1] });
const PASS = JSON.stringify({ issues: [] });
const FAIL = JSON.stringify({ issues: [{ claim: "17-5", problem: "no item states a head-to-head total", fix: "cut", severity: "material" }] });

// A writer whose calls answer from a script, with a tally like the SDK caller's.
const scripted = (id, answers, { price = { id, in: 1, out: 5 }, usage = { input_tokens: 1000, output_tokens: 200 }, fail = false } = {}) => ({
  id,
  price,
  make: () => {
    const tally = createTally();
    let i = 0;
    return {
      tally,
      call: async () => {
        if (fail) { tally.failed(id); throw new Error("HTTP 529 overloaded"); }
        tally.record(id, usage);
        return answers[Math.min(i++, answers.length - 1)];
      },
    };
  },
});

test("sydneyStamp: Sydney date and time of the run", () => {
  assert.equal(sydneyStamp(NOW), "2026-10-21-0745");
  assert.equal(sydneyStamp(Date.parse("2026-10-20T13:05:00Z")), "2026-10-21-0005");
});

test("worstCaseUSD: input at two characters a token, output at the role ceilings; free writer costs nothing", () => {
  const haiku = { in: 0.1, out: 0.5 };
  const expected = ((10000 / 2) * 0.1 + MAX_TOKENS.writer * 0.5) / 1e6 + ((10000 / 2) * 0.1 + MAX_TOKENS.checker * 0.5) / 1e6;
  assert.ok(Math.abs(worstCaseUSD(10000, haiku, haiku) - expected) < 1e-9);
  assert.equal(worstCaseUSD(10000, null, null), 0);
});

test("resolveWriter: unpriced or keyless writers are refused with a reason, not run", () => {
  assert.match(resolveWriter("claude-nope-9", { client: {} }).error, /no price/);
  assert.match(resolveWriter("claude-haiku-5-5", {}).error, /ANTHROPIC_API_KEY/);
  assert.match(resolveWriter("gemini", {}).error, /GEMINI_API_KEY/);
  const g = resolveWriter("gemini", { geminiKey: "k" });
  assert.equal(g.price, null);
  assert.equal(typeof g.make, "function");
  const h = resolveWriter("claude-haiku-5-5", { client: {} });
  assert.deepEqual(h.price, { id: "claude-haiku-5-5", in: 0.1, out: 0.5 });
});

test("foldTrace: draft, gate, first verdict, revision", () => {
  const f = foldTrace([
    { step: "draft", raw: JSON.parse(BAD) }, { step: "gate", ok: true },
    { step: "check", verdict: "fail", issues: [{ claim: "17-5", problem: "unsourced total", severity: "material" }] },
    { step: "revision", raw: JSON.parse(GOOD) }, { step: "gate", ok: true }, { step: "check", verdict: "pass", issues: [] },
  ]);
  assert.equal(f.draft.headline, "Fiji own this fixture 17-5");
  assert.equal(f.draft.sources, 1);
  assert.deepEqual(f.check1, { verdict: "fail", material: 1, issues: [{ claim: "17-5", problem: "unsourced total", fix: null }] });
  assert.equal(f.revised, true);
  assert.equal(f.check2.verdict, "pass");
  assert.deepEqual(foldTrace([]), { draft: null, gate: null, check1: null, revised: false, revisionGate: null, check2: null });
});

test("shadowStory: pass first time — 1 writer call, 1 checker call, cost from both tallies", async () => {
  let t = 0;
  const r = await shadowStory({ writer: scripted("w", [GOOD]), checker: scripted("c", [PASS], { price: { in: 0.1, out: 0.5 }, usage: { input_tokens: 2000, output_tokens: 100 } }), pack, packText, now: () => (t += 1500) });
  assert.equal(r.ok, true);
  assert.equal(r.revised, false);
  assert.equal(r.final.headline, "White's Fiji debut in Tokyo");
  assert.equal(r.final.sources[0].url, "https://example.com/white", "sources resolved from the pack");
  assert.deepEqual([r.usage.writerCalls, r.usage.checkerCalls, r.usage.writerInput, r.usage.writerOutput], [1, 1, 1000, 200]);
  assert.equal(r.usage.writerCostUSD, 0.002);
  assert.equal(r.usage.checkerCostUSD, 0.00025);
  assert.equal(r.costUSD, 0.00225);
  assert.equal(r.seconds, 1.5);
  assert.equal(r.check1.verdict, "pass");
});

test("shadowStory: a material issue gets one revision; a writer that errors is a recorded failure", async () => {
  const r = await shadowStory({ writer: scripted("w", [BAD, GOOD]), checker: scripted("c", [FAIL, PASS]), pack, packText });
  assert.equal(r.ok, true);
  assert.equal(r.revised, true);
  assert.equal(r.check1.material, 1);
  assert.equal(r.draft.headline, "Fiji own this fixture 17-5");
  assert.equal(r.final.headline, "White's Fiji debut in Tokyo");
  assert.equal(r.usage.writerCalls, 2);
  const bad = await shadowStory({ writer: scripted("w", [GOOD], { fail: true }), checker: scripted("c", [PASS]), pack, packText });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /529/);
  assert.equal(bad.final, null);
});

test("runShadow: every writer on every fixture under the cap; a dear writer skips a fixture, the cheap ones carry on", async () => {
  // the dear writer thinks at length: 6,000 output tokens a story, US$0.32
  const dear = scripted("fable", [GOOD], { price: { in: 10, out: 50 }, usage: { input_tokens: 2000, output_tokens: 6000 } });
  const cheap = scripted("haiku", [GOOD], { price: { in: 0.1, out: 0.5 } });
  const broken = { id: "gemini", price: null, error: "GEMINI_API_KEY not set" };
  const checker = scripted("c", [PASS], { price: { in: 0.1, out: 0.5 } });
  const packs = [{ fixture, pack, packText }, { fixture: { ...fixture, id: "x2" }, pack: { ...pack, fixture: { ...pack.fixture, id: "x2" } }, packText }];
  const lines = [];
  const { results, skipped, spentUSD } = await runShadow({ packs, writers: [dear, cheap, broken], checker, cap: 1.5, log: (l) => lines.push(l) });
  // fable's worst case per round is about US$1.25 (12,000 output tokens at $50/M, twice): it fits the first
  // fixture (nothing spent yet) and not the second (US$0.32 actually spent + 1.25 > 1.5).
  assert.deepEqual(results.map((r) => `${r.writer}@${r.fixture}`), ["fable@espn-604593", "haiku@espn-604593", "haiku@x2"]);
  assert.equal(skipped.filter((s) => s.writer === "gemini").length, 2);
  const capped = skipped.find((s) => s.writer === "fable");
  assert.equal(capped.fixture, "x2");
  assert.match(capped.reason, /cap/);
  assert.ok(spentUSD > 0.32 && spentUSD < 0.33, `actual spend, not the reservation: ${spentUSD}`);
  assert.ok(lines.some((l) => /fable skipped/.test(l)));
});

test("totalsOf, packRecord and renderMarkdown: the record a reader sees", async () => {
  const writers = [scripted("w1", [GOOD], { price: { in: 1, out: 5 } }), scripted("w2", [BAD, GOOD], { price: { in: 2, out: 10 } })];
  const checker = scripted("c", [FAIL, PASS], { price: { in: 0.1, out: 0.5 } });
  // w1's checker answers FAIL first too (scripted per story), so both revise.
  const { results, skipped, spentUSD } = await runShadow({ packs: [{ fixture, pack, packText }], writers, checker, cap: 8, log: () => {} });
  const totals = totalsOf(results, writers);
  assert.equal(totals[0].writer, "w1");
  assert.deepEqual([totals[0].stories, totals[0].passed, totals[0].revised, totals[0].materialIssuesFirstDraft], [1, 1, 1, 1]);
  assert.equal(totals[0].perStoryUSD, totals[0].costUSD);
  const rec = packRecord(pack, packText);
  assert.equal(rec.news[0].title, pool[0].title);
  assert.equal(rec.news[0].desc, undefined, "snippets and bodies are not recorded");
  assert.equal(rec.promptChars, packText.length);
  assert.ok(rec.stakes, "trusted facts are");
  const doc = {
    startedSydney: "Wed 21 Oct 2026 07:45", writers: writers.map((w) => ({ id: w.id, price: w.price })), checker: "c", days: 20, capUSD: 8, spentUSD,
    fixtures: [{ id: fixture.id, pack: rec }], results, skipped, totals,
  };
  const md = renderMarkdown(doc);
  assert.match(md, /^# Storyline shadow run — Wed 21 Oct 2026 07:45 Sydney time/);
  assert.ok(md.includes(NOTICE));
  assert.match(md, /\| w1 \| 1 \| 1 \| 0 \| 1 \| 0 \| 1 \|/);
  assert.match(md, /## 1\. Japan v Fiji — Sat 24 Oct 2026, 4:50 pm Sydney time/);
  assert.match(md, /### w2 — passed after one revision · first check: fail \(1 material\) · first draft \d+ words/);
  assert.match(md, /\*\*White's Fiji debut in Tokyo\*\*/);
  assert.match(md, /First draft headline: \*\*Fiji own this fixture 17-5\*\*/);
  assert.match(md, /"17-5": no item states a head-to-head total \(fix: cut\)/);
});
