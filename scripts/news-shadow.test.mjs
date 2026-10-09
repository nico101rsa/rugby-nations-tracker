import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHADOW_FIRST_DATE, SHADOW_LAST_DATE, RUN_CAP_USD, WINDOW_CAP_USD, MAX_TOKENS, CHARS_PER_TOKEN_FLOOR,
  REQUEST_TIMEOUT_MS, MAX_ATTEMPTS, TIME_BUDGET_MS, SHADOW_NOTICE,
  inWindow, decideShadow, resolveModel, worstCaseCallUSD, spendGuard, runShadow, windowSpend,
  shadowPath, blindKey, gradingPrompts, sydneyDate, readWriterInputs, isRetryable, retryDelayMs,
} from "./news-shadow.mjs";
import { MODELS, SONNET } from "./compare-digest-models.mjs";
import { buildWriterInputs, writerInputsDir, sha256, WRITER_INPUTS_FILE } from "./generate-digests.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const noSleep = async () => {};
const PRICE = { id: "test-model", in: 2, out: 10 }; // US$ per million tokens, input / output
const MODEL = { id: PRICE.id, price: PRICE, reason: null };

// 7 Oct 2026, 07:30 AEDT: a morning run inside the window.
const NOW = new Date("2026-10-06T20:30:00Z");

const body = (n = 60) => Array.from({ length: n }, (_, i) => (i % 7 === 0 ? "Springboks" : "rugby")).join(" ") + ".";
const digestFor = (date, heading = "Rassie Erasmus names Siya Kolisi to lead the Springboks again", lead = 1) => ({
  date,
  edition: "Wednesday 7 October",
  lead: { candidate: lead, why: "the day's biggest story" },
  sections: [{ kicker: "Selection call", heading, body: body() }],
});

function inputsFor(date = "2026-10-07", teams = 3, { promptChars = 4000, generatedAt = NOW.toISOString() } = {}) {
  const names = ["South Africa", "New Zealand", "Japan", "Fiji", "Italy", "Wales"];
  const ids = [467, 465, 463, 28, 389, 391];
  return {
    kind: "digest-writer-inputs",
    date,
    generatedAt,
    provider: "gemini",
    servedBy: "the-free-model",
    teams: Array.from({ length: teams }, (_, i) => {
      const prompt = `prompt for ${names[i]} `.padEnd(promptChars, "x");
      return {
        teamId: ids[i],
        team: names[i],
        date,
        prompt,
        promptSha256: sha256(prompt),
        quiet: i === 2,
        ladder: i === 2 ? { rung: "data", angle: "scoring" } : null,
        shortlist: [{ title: `${names[i]} headline`, link: `https://example.com/${i}`, score: 3, corroboration: 2, outlets: ["A", "B"] }],
        production: {
          firstDraft: digestFor(date, `${names[i]} coach confirms the squad for the next test match`, 1),
          firstCheck: { verdict: "pass", materialIssues: 0 },
          revisions: 0,
          published: digestFor(date, `${names[i]} coach confirms the squad for the next test match`, 1),
          failed: null,
        },
      };
    }),
  };
}

// A stand-in for the Anthropic client: answers with a valid edition, or
// whatever `reply` returns, and counts calls.
function fakeClient(reply = (req, n) => ({ text: JSON.stringify(digestFor("2026-10-07")), input: 1500, output: 900 })) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (req) => {
        calls.push(req);
        const r = await reply(req, calls.length);
        return {
          content: [{ type: "thinking", thinking: "" }, { type: "text", text: r.text }],
          stop_reason: r.stop ?? "end_turn",
          usage: { input_tokens: r.input, output_tokens: r.output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        };
      },
    },
  };
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "shadow-"));
  await mkdir(join(root, "public"), { recursive: true });
  await mkdir(join(root, "editorial", "runs"), { recursive: true });
  const nations = JSON.stringify({ digests: { 467: { edition: "published" } }, fixtures: [] }, null, 2);
  await writeFile(join(root, "nations.json"), nations);
  await writeFile(join(root, "public", "nations.json"), nations);
  return { root, nations };
}

async function tree(dir, prefix = "") {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await tree(join(dir, e.name), p)));
    else out.push(p);
  }
  return out.sort();
}

// ---- the date guard --------------------------------------------------------------

test("window: seven Sydney edition dates, 6 to 12 Oct 2026 inclusive", () => {
  assert.equal(SHADOW_FIRST_DATE, "2026-10-06");
  assert.equal(SHADOW_LAST_DATE, "2026-10-12");
  assert.equal(inWindow("2026-10-05"), false);
  assert.equal(inWindow("2026-10-06"), true);
  assert.equal(inWindow("2026-10-12"), true);
  assert.equal(inWindow("2026-10-13"), false);
  assert.equal(inWindow("2027-10-07"), false);
  for (const junk of [undefined, null, "", "7 Oct", "2026-10-7", 20261007]) assert.equal(inWindow(junk), false);
});

test("decideShadow: runs inside the window with this run's inputs, a key and a priced model", () => {
  const d = decideShadow({ now: NOW, inputs: inputsFor(), hasKey: true, model: MODEL });
  assert.equal(d.run, true, d.reason);
});

test("decideShadow: stops itself once the last Sydney date is over, whatever the inputs say", () => {
  const lastMinute = new Date("2026-10-12T12:59:00Z"); // 23:59 AEDT on Mon 12 Oct
  const afterwards = new Date("2026-10-12T13:00:00Z"); // 00:00 AEDT on Tue 13 Oct
  assert.equal(sydneyDate(lastMinute), "2026-10-12");
  assert.equal(sydneyDate(afterwards), "2026-10-13");
  const fresh = (now) => inputsFor("2026-10-12", 3, { generatedAt: now.toISOString() });
  assert.equal(decideShadow({ now: lastMinute, inputs: fresh(lastMinute), hasKey: true, model: MODEL }).run, true);
  const ended = decideShadow({ now: afterwards, inputs: fresh(afterwards), hasKey: true, model: MODEL });
  assert.equal(ended.run, false);
  assert.match(ended.reason, /window ended on 2026-10-12/);
  // Months later, with no inputs and no key: still a clean skip that says why.
  const later = decideShadow({ now: new Date("2027-02-06T20:00:00Z"), inputs: null, hasKey: false, model: MODEL });
  assert.equal(later.run, false);
  assert.match(later.reason, /window ended/);
});

test("decideShadow: an edition dated outside the window never runs, even on a date inside it", () => {
  const early = new Date("2026-10-05T20:00:00Z"); // Tue 6 Oct 07:00 AEDT
  assert.equal(decideShadow({ now: early, inputs: inputsFor("2026-10-05", 3, { generatedAt: early.toISOString() }), hasKey: true, model: MODEL }).run, false);
  assert.match(decideShadow({ now: NOW, inputs: inputsFor("2026-10-13"), hasKey: true, model: MODEL }).reason, /outside the shadow window/);
});

test("decideShadow: every other guard is a skip with its reason", () => {
  const base = { now: NOW, inputs: inputsFor(), hasKey: true, model: MODEL };
  const cases = [
    [{ hasKey: false }, /ANTHROPIC_API_KEY not set/, "notice"],
    [{ inputs: null }, /no writer inputs/, "notice"],
    [{ inputs: inputsFor("2026-10-07", 3, { generatedAt: "2026-10-05T20:00:00Z" }) }, /not from this run/, "notice"],
    [{ inputs: inputsFor("2026-10-07", 3, { generatedAt: "garbage" }) }, /not from this run/, "notice"],
    [{ alreadyShadowed: true }, /already shadowed/, "notice"],
    [{ inputs: inputsFor("2026-10-07", 0) }, /no teams/, "notice"],
    [{ model: resolveModel("not-a-priced-model") }, /no verified price/, "warning"],
    [{ spentWindow: WINDOW_CAP_USD }, /reached the US\$9\.00 cap/, "notice"],
  ];
  for (const [over, re, level] of cases) {
    const d = decideShadow({ ...base, ...over });
    assert.equal(d.run, false, JSON.stringify(Object.keys(over)));
    assert.match(d.reason, re);
    assert.equal(d.level, level);
  }
});

// ---- the model ---------------------------------------------------------------------

test("resolveModel: defaults to the existing Sonnet constant, with its price; overrides must be priced", () => {
  assert.ok(SONNET && /sonnet/.test(SONNET.id));
  const def = resolveModel(undefined);
  assert.equal(def.id, SONNET.id);
  assert.deepEqual(def.price, SONNET);
  assert.equal(resolveModel("  ").id, SONNET.id); // an empty repository variable is "unset"
  const other = MODELS.find((m) => m !== SONNET);
  assert.deepEqual(resolveModel(other.id).price, other);
  const unknown = resolveModel("some-unpriced-model");
  assert.equal(unknown.price, null);
  assert.match(unknown.reason, /no verified price/);
});

// ---- the spend guard ---------------------------------------------------------------

test("worstCaseCallUSD: over-counts input at 2 chars a token and assumes a full MAX_TOKENS of output", () => {
  assert.equal(CHARS_PER_TOKEN_FLOOR, 2);
  // 30,000 chars -> 15,000 tokens x $2/M = $0.03, plus 12,000 x $10/M = $0.12.
  assert.equal(MAX_TOKENS, 12000);
  assert.ok(Math.abs(worstCaseCallUSD(30000, PRICE) - 0.15) < 1e-9);
  assert.ok(Math.abs(worstCaseCallUSD(0, PRICE) - 0.12) < 1e-9);
});

test("MAX_TOKENS: never below production's figure for this model, and still allowed without streaming", () => {
  // Thinking counts against max_tokens. At 8000 a long-thinking team stopped
  // at max_tokens with no JSON, was paid for, and scored "invalid": a false
  // verdict against the paid writer. Production settled on 12000 for it
  // (generate-digests.mjs MAX_TOKENS). A literal, not an import, on purpose:
  // this suite gates the digest run, so a later production change must not
  // be able to fail it through a finished experiment's test.
  assert.ok(MAX_TOKENS >= 12000, `shadow MAX_TOKENS ${MAX_TOKENS} is below production's 12000`);
  // The SDK refuses a non-streaming request it expects to take over 10
  // minutes: 60 min x max_tokens / 128,000.
  assert.ok((60 * MAX_TOKENS) / 128000 <= 10);
  // The client timeout leaves room for a full MAX_TOKENS answer (2 minutes did
  // not), and one stuck request plus the time budget fit the step's 25 minutes.
  assert.ok(REQUEST_TIMEOUT_MS >= 5 * 60000);
  assert.ok(TIME_BUDGET_MS + REQUEST_TIMEOUT_MS <= 22 * 60000);
});

test("spendGuard: refuses the call that could pass either cap, allows the one that cannot", () => {
  assert.equal(RUN_CAP_USD, 1.5);
  assert.equal(WINDOW_CAP_USD, 9);
  assert.equal(spendGuard({ spentRun: 1.3, spentWindow: 0, nextWorstCase: 0.15 }).ok, true);
  const run = spendGuard({ spentRun: 1.4, spentWindow: 0, nextWorstCase: 0.15 });
  assert.equal(run.ok, false);
  assert.match(run.reason, /per-run cap/);
  const week = spendGuard({ spentRun: 0.5, spentWindow: 8.4, nextWorstCase: 0.15 });
  assert.equal(week.ok, false);
  assert.match(week.reason, /window cap/);
});

test("runShadow: the spend guard stops the run before the cap, never after it", async () => {
  const { root } = await sandbox();
  try {
    // A dear model: 40k-char prompts plan for at most $0.80 a call (20k in at
    // $10/M + 12k out at $50/M) and each answer costs $0.55. Two calls ($1.10)
    // fit; a third could reach $1.90, so it is never made.
    const dear = { id: "dear", price: { id: "dear", in: 10, out: 50 } };
    const client = fakeClient(() => ({ text: JSON.stringify(digestFor("2026-10-07")), input: 15000, output: 8000 }));
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 6, { promptChars: 40000 }), client, model: dear, now: NOW, log: () => {} });
    assert.equal(client.calls.length, 2);
    assert.ok(Math.abs(rec.cost.runUSD - 1.1) < 1e-9);
    assert.ok(rec.cost.runUSD + rec.cost.unaccountedUSD <= RUN_CAP_USD);
    assert.equal(rec.counts.skipped, 4);
    assert.match(rec.aborted, /^spend guard: per-run cap/);
    assert.equal(rec.complete, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: if a call ever costs more than its planned worst case, the guard plans for the dearest call so far", async () => {
  const { root } = await sandbox();
  try {
    // Unrealistic on purpose: 100k input tokens from a 4k-char prompt, so each
    // answer ($0.40) beats the planned worst case (~$0.09).
    const client = fakeClient(() => ({ text: JSON.stringify(digestFor("2026-10-07")), input: 100000, output: 20000 }));
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 6), client, model: MODEL, now: NOW, log: () => {} });
    assert.equal(client.calls.length, 3); // $1.20; a 4th at $0.40 would pass $1.50
    assert.ok(rec.cost.runUSD <= RUN_CAP_USD);
    assert.match(rec.aborted, /^spend guard: per-run cap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: the window cap holds across days (spend already recorded counts)", async () => {
  const { root } = await sandbox();
  try {
    await mkdir(join(root, "editorial", "shadow"), { recursive: true });
    await writeFile(join(root, "editorial", "shadow", "2026-10-06.json"), JSON.stringify({ cost: { runUSD: 8.9, unaccountedUSD: 0.05 } }));
    assert.ok(Math.abs((await windowSpend(root)) - 8.95) < 1e-9);
    const client = fakeClient();
    const rec = await runShadow({ root, inputs: inputsFor(), client, model: MODEL, now: NOW, log: () => {} });
    assert.equal(client.calls.length, 0);
    assert.match(rec.aborted, /window cap/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("windowSpend: an unreadable record counts as a full run, so the cap stays a cap", async () => {
  const { root } = await sandbox();
  try {
    await mkdir(join(root, "editorial", "shadow"), { recursive: true });
    await writeFile(join(root, "editorial", "shadow", "2026-10-06.json"), "{ not json");
    await writeFile(join(root, "editorial", "shadow", "README.md"), "# not a record");
    assert.equal(await windowSpend(root), RUN_CAP_USD);
    assert.equal(await windowSpend(join(root, "nowhere")), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: a rejected key stops the run after one call; a dropped connection keeps its worst case on the books", async () => {
  const { root } = await sandbox();
  try {
    const denied = fakeClient(() => { throw Object.assign(new Error("invalid x-api-key"), { status: 401 }); });
    const rec = await runShadow({ root, inputs: inputsFor(), client: denied, model: MODEL, now: NOW, log: () => {} });
    assert.equal(denied.calls.length, 1);
    assert.equal(rec.counts.errors, 1);
    assert.equal(rec.counts.skipped, 2);
    assert.equal(rec.cost.unaccountedUSD, 0); // an HTTP error is not billed

    const dropped = fakeClient(() => { throw new Error("socket hang up"); });
    const rec2 = await runShadow({ root, inputs: inputsFor("2026-10-08"), client: dropped, model: MODEL, now: NOW, log: () => {}, sleep: noSleep });
    assert.equal(dropped.calls.length, 3);
    assert.ok(rec2.cost.unaccountedUSD > 0);
    assert.ok(Math.abs(rec2.cost.unaccountedUSD - 3 * worstCaseCallUSD(4000, PRICE)) < 1e-4);
    // The three are one team's attempts, each reserved; then the run stops,
    // because no answer at all on every attempt is the connection, not the team.
    assert.equal(rec2.teams[0].shadow.attempts, MAX_ATTEMPTS);
    assert.ok(Math.abs(rec2.teams[0].shadow.costUpperBoundUSD - 3 * worstCaseCallUSD(4000, PRICE)) < 1e-4);
    assert.match(rec2.aborted, /no answer from the API on 3 attempts/);
    assert.equal(rec2.counts.skipped, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: the time budget stops new calls", async () => {
  const { root } = await sandbox();
  try {
    let t = 0;
    const client = fakeClient(() => { t += 10 * 60000; return { text: JSON.stringify(digestFor("2026-10-07")), input: 1000, output: 500 }; });
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 4), client, model: MODEL, now: NOW, log: () => {}, clock: () => t, timeBudgetMs: 15 * 60000 });
    assert.equal(client.calls.length, 2);
    assert.match(rec.aborted, /time budget/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- retries: made here, one reservation each -------------------------------------
//
// The SDK used to retry inside one messages.create (maxRetries: 2), so a
// timed-out call could be billed up to three times against ONE reservation.
// Now the client never retries and runShadow does, guarding each attempt.

const fail = (status, message = `HTTP ${status}`, headers = undefined) => Object.assign(new Error(message), status == null ? {} : { status }, headers ? { headers } : {});
const valid = (input = 1500, output = 900) => ({ text: JSON.stringify(digestFor("2026-10-07")), input, output });

test("main: the SDK client is built with no retries of its own and the longer timeout", async () => {
  const src = await readFile(join(ROOT, "scripts", "news-shadow.mjs"), "utf8");
  assert.match(src, /new Anthropic\(\{ maxRetries: 0, timeout: REQUEST_TIMEOUT_MS \}\)/);
  assert.equal(MAX_ATTEMPTS, 3);
});

test("isRetryable / retryDelayMs: the SDK's retry list, and its retry-after header", () => {
  for (const err of [fail(null, "socket hang up"), fail(null, "Request timed out."), fail(408), fail(409), fail(429), fail(500), fail(529)]) {
    assert.equal(isRetryable(err), true, err.message);
  }
  for (const status of [400, 401, 403, 404, 413, 422]) assert.equal(isRetryable(fail(status)), false, String(status));
  assert.equal(retryDelayMs(fail(500), 1), 2000);
  assert.equal(retryDelayMs(fail(500), 2), 8000);
  assert.equal(retryDelayMs(fail(429, "slow down", new Headers({ "retry-after": "5" })), 1), 5000);
  assert.equal(retryDelayMs(fail(429, "slow down", new Headers({ "retry-after": "600" })), 1), 30000);
  assert.equal(retryDelayMs(fail(429, "slow down", new Headers({ "retry-after": "soon" })), 2), 8000);
});

test("runShadow: an overloaded answer is retried and costs nothing; the team still gets its draft", async () => {
  const { root } = await sandbox();
  try {
    const sleeps = [];
    const client = fakeClient((req, n) => { if (n === 1) throw fail(529, "Overloaded"); return valid(); });
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 2), client, model: MODEL, now: NOW, log: () => {}, sleep: async (ms) => sleeps.push(ms) });
    assert.equal(client.calls.length, 3); // team 1 twice, team 2 once
    assert.deepEqual(sleeps, [2000]);
    const first = rec.teams[0].shadow;
    assert.equal(first.valid, true);
    assert.equal(first.attempts, 2);
    assert.deepEqual(first.failedAttempts.map((f) => [f.attempt, f.status]), [[1, 529]]);
    assert.equal(first.unansweredUpperBoundUSD, undefined); // it answered: nothing billed
    assert.equal(rec.teams[1].shadow.attempts, 1);
    assert.equal(rec.cost.unaccountedUSD, 0);
    assert.ok(Math.abs(rec.cost.runUSD - 2 * (1500 * 2 + 900 * 10) / 1e6) < 1e-9);
    assert.equal(rec.aborted, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: every unanswered attempt keeps its own worst case on the books", async () => {
  const { root } = await sandbox();
  try {
    const client = fakeClient((req, n) => { if (n <= 2) throw fail(null, "Request timed out."); return valid(); });
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 1), client, model: MODEL, now: NOW, log: () => {}, sleep: noSleep });
    const worst = worstCaseCallUSD(4000, PRICE);
    assert.equal(client.calls.length, 3);
    const t = rec.teams[0].shadow;
    assert.equal(t.valid, true);
    assert.equal(t.attempts, 3);
    assert.ok(Math.abs(t.unansweredUpperBoundUSD - 2 * worst) < 1e-4);
    // Two timeouts that may have been billed, reserved one each (the old
    // single reservation would have carried one worst case for all three).
    assert.ok(Math.abs(rec.cost.unaccountedUSD - 2 * worst) < 1e-4);
    assert.equal(rec.aborted, null); // it got an answer in the end: the connection works
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: a retry that could pass the run cap is never made, so the cap holds through timeouts", async () => {
  const { root } = await sandbox();
  try {
    // A dear model whose worst case is $0.80 an attempt: one timed-out attempt
    // fits under $1.50, a second reservation ($1.60) would not.
    const dear = { id: "dear", price: { id: "dear", in: 10, out: 50 } };
    const client = fakeClient(() => { throw fail(null, "Request timed out."); });
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 3, { promptChars: 40000 }), client, model: dear, now: NOW, log: () => {}, sleep: noSleep });
    assert.equal(client.calls.length, 1);
    assert.ok(rec.cost.runUSD + rec.cost.unaccountedUSD <= RUN_CAP_USD);
    assert.ok(Math.abs(rec.cost.unaccountedUSD - 0.8) < 1e-9);
    assert.match(rec.teams[0].shadow.retryRefused, /^spend guard: per-run cap/);
    assert.equal(rec.counts.errors, 1);
    assert.equal(rec.counts.skipped, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runShadow: a retry waits for the time budget too; a non-retryable answer is not retried and the run goes on", async () => {
  const { root } = await sandbox();
  try {
    let t = 0;
    const slow = fakeClient(() => { t += 10 * 60000; throw fail(null, "Request timed out."); });
    const rec = await runShadow({ root, inputs: inputsFor("2026-10-07", 2), client: slow, model: MODEL, now: NOW, log: () => {}, clock: () => t, timeBudgetMs: 15 * 60000, sleep: noSleep });
    assert.equal(slow.calls.length, 2); // at 0 and 10 minutes; the third would start at 20
    assert.match(rec.teams[0].shadow.retryRefused, /^time budget/);
    assert.equal(rec.teams[1].shadow.skipped, rec.aborted);

    const tooBig = fakeClient((req, n) => { if (n === 1) throw fail(413, "request too large"); return valid(); });
    const rec2 = await runShadow({ root, inputs: inputsFor("2026-10-07", 2), client: tooBig, model: MODEL, now: NOW, log: () => {}, sleep: noSleep });
    assert.equal(tooBig.calls.length, 2); // one for each team: a 413 is not retried
    assert.equal(rec2.teams[0].shadow.status, 413);
    assert.equal(rec2.teams[0].shadow.costUpperBoundUSD, undefined); // an answer, so never billed
    assert.equal(rec2.teams[1].shadow.valid, true);
    assert.equal(rec2.cost.unaccountedUSD, 0);
    assert.equal(rec2.aborted, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- nothing reaches nations.json ----------------------------------------------------

test("runShadow: writes editorial/shadow/<date>.json and nothing else; nations.json is untouched", async () => {
  const { root, nations } = await sandbox();
  try {
    const before = await tree(root);
    const client = fakeClient((req, n) => (n === 2
      ? { text: "Sorry, here is some prose and no JSON at all.", input: 1200, output: 300 }
      : { text: JSON.stringify(digestFor("2026-10-07")), input: 1500, output: 900 }));
    const inputs = inputsFor();
    const rec = await runShadow({ root, inputs, client, model: MODEL, now: NOW, log: () => {} });

    assert.deepEqual(await tree(root), [...before, "editorial/shadow/2026-10-07.json"].sort());
    assert.equal(await readFile(join(root, "nations.json"), "utf8"), nations);
    assert.equal(await readFile(join(root, "public", "nations.json"), "utf8"), nations);
    const onDisk = JSON.parse(await readFile(shadowPath(root, "2026-10-07"), "utf8"));
    assert.deepEqual(onDisk, rec);
    assert.equal(rec.publishes, false);
    // The folder is public (GitHub Pages serves the whole repo, .nojekyll), so
    // the first thing in every record says what these drafts are.
    assert.equal(Object.keys(onDisk)[1], "notice");
    assert.equal(rec.notice, SHADOW_NOTICE);
    assert.match(SHADOW_NOTICE, /never fact-checked/);
    assert.match(SHADOW_NOTICE, /not news/);

    // The request is the recorded production prompt, verbatim, writer only.
    assert.equal(client.calls.length, 3);
    client.calls.forEach((req, i) => {
      assert.equal(req.model, MODEL.id);
      assert.equal(req.max_tokens, MAX_TOKENS);
      assert.deepEqual(req.messages, [{ role: "user", content: inputs.teams[i].prompt }]);
      assert.equal(req.tools, undefined);
    });
    assert.ok(rec.teams.every((t) => t.promptMatchesProduction));
    // No prompt (and so no publisher article text) is committed: hashes only.
    assert.ok(!JSON.stringify(rec).includes(inputs.teams[0].prompt));

    assert.deepEqual(rec.counts, { teams: 3, valid: 2, invalid: 1, errors: 0, skipped: 0, pending: 0, productionFailed: 0, shadowValidWhereProductionFailed: 0 });
    assert.equal(rec.teams[1].shadow.valid, false);
    assert.match(rec.teams[1].shadow.rawTail, /no JSON/);
    assert.equal(rec.teams[0].shadow.sameLeadAsProductionFirstDraft, true);
    assert.deepEqual(rec.teams[0].shadow.words, { heading: 10, body: 60 });
    // 2 x (1,500 in + 900 out) + (1,200 in + 300 out) at $2 / $10 per million.
    assert.ok(Math.abs(rec.cost.runUSD - (2 * (1500 * 2 + 900 * 10) + (1200 * 2 + 300 * 10)) / 1e6) < 1e-6);
    assert.equal(rec.cost.unaccountedUSD, 0);
    assert.equal(rec.usage.input, 4200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- the workflow ------------------------------------------------------------------
//
// scripts/*.test.mjs runs at the top of generate-digests.yml (and of two other
// workflows) with nothing to catch a failure first, so this check must pass
// in EVERY harmless state of the workflow: with the shadow steps, after the
// documented cleanup (steps and DIGEST_PROMPTS_DIR gone), and after a partial
// one. Until 4 Oct 2026 it demanded exactly three shadow steps, so following
// the README's cleanup would have failed every digest run before it wrote
// anything. It only fails on states that could do harm: a shadow step that
// could delay or fail publication, touch nations.json or commit anything but
// editorial/shadow/, a prompts folder inside the checkout, or a model
// identifier hard-coded where the repository variable belongs.

const PUBLISH_STEP = "Commit and push if changed";
const SHADOW_STEPS = [
  "News shadow test (decide)",
  "News shadow test (paid writer only; publishes nothing)",
  "News shadow test (commit editorial/shadow only)",
];
const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const splitSteps = (yml) => yml.split(/\n(?=      - name: )/);
const stepName = (step) => (/^      - name: (.*)$/m.exec(step) ?? [])[1] ?? null;

function shadowWorkflowProblems(yml) {
  const problems = [];
  const steps = splitSteps(yml);
  const names = steps.map(stepName);
  const publish = names.indexOf(PUBLISH_STEP);
  // A shadow step by name, or anything that runs the script or commits its folder.
  const isShadow = (step) => /^News shadow test/.test(stepName(step) ?? "") || /news-shadow\.mjs|editorial\/shadow/.test(code(step));
  const shadow = steps.map((step, i) => ({ step, i, name: stepName(step) })).filter(({ step }) => isShadow(step));
  if (shadow.length && publish < 0) problems.push(`shadow steps present but no "${PUBLISH_STEP}" step to order them after`);
  for (const { step, i, name } of shadow) {
    const body = code(step);
    if (i < publish) problems.push(`${name}: runs before publication`);
    if (!/^\s*continue-on-error: true\s*$/m.test(body)) problems.push(`${name}: can fail the job (no continue-on-error: true)`);
    if (/nations\.json/.test(body)) problems.push(`${name}: mentions nations.json`);
    for (const add of body.match(/git add .*/g) ?? []) {
      if (add.trim() !== "git add editorial/shadow/") problems.push(`${name}: ${add.trim()} (only editorial/shadow/ may be committed)`);
    }
    if (/node scripts\/news-shadow\.mjs(?! --preflight)/.test(body) && !/steps\.shadow\.outputs\.run == 'true'/.test(body)) {
      problems.push(`${name}: runs the paid writer without the preflight's go-ahead`);
    }
  }
  // Wherever these are still set, in any step: the prompts carry publishers'
  // article text, so they stay outside the checkout; and no model id is written here.
  for (const m of code(yml).matchAll(/^\s*DIGEST_PROMPTS_DIR:\s*(.*)$/gm)) {
    if (!/^\$\{\{ runner\.temp \}\}\//.test(m[1].trim())) problems.push(`DIGEST_PROMPTS_DIR is ${m[1].trim()}, not under runner.temp`);
  }
  for (const m of code(yml).matchAll(/^\s*SHADOW_MODEL:\s*(.*)$/gm)) {
    if (m[1].trim() !== "${{ vars.SHADOW_MODEL }}") problems.push(`SHADOW_MODEL is ${m[1].trim()}, not the repository variable`);
  }
  return { problems, shadow: shadow.map((x) => x.name) };
}

// The README's "After the week": delete the three steps and DIGEST_PROMPTS_DIR.
function cleanedUp(yml, { keepPromptsDir = false } = {}) {
  let out = splitSteps(yml).filter((step) => !/^News shadow test/.test(stepName(step) ?? "")).join("\n");
  if (!keepPromptsDir) out = out.split("\n").filter((l) => !/^\s*DIGEST_PROMPTS_DIR:/.test(l)).join("\n");
  return out;
}

const liveWorkflow = () => readFile(join(ROOT, ".github", "workflows", "generate-digests.yml"), "utf8");

test("generate-digests.yml: the shadow steps come after publication, never fail the job, and commit only editorial/shadow/", async () => {
  const yml = await liveWorkflow();
  const { problems, shadow } = shadowWorkflowProblems(yml);
  assert.deepEqual(problems, []);
  // Today the three steps are there, in order. (After the cleanup this list is
  // empty and the check above still holds: see the next test.)
  if (shadow.length) assert.deepEqual(shadow, SHADOW_STEPS);
});

test("generate-digests.yml: the documented cleanup, and a half-done one, leave this suite green", async () => {
  const yml = await liveWorkflow();
  const done = cleanedUp(yml);
  assert.doesNotMatch(code(done), /News shadow test|news-shadow\.mjs|DIGEST_PROMPTS_DIR/); // the simulation really removed them
  assert.match(done, new RegExp(`- name: ${PUBLISH_STEP}`)); // ...and nothing else
  assert.deepEqual(shadowWorkflowProblems(done), { problems: [], shadow: [] });
  // Steps gone but DIGEST_PROMPTS_DIR left behind: production keeps writing
  // prompts to the runner's temp dir, which is thrown away. Harmless, so not a failure.
  assert.deepEqual(shadowWorkflowProblems(cleanedUp(yml, { keepPromptsDir: true })).problems, []);
  // Only the commit step deleted: harmless too.
  const partial = splitSteps(yml).filter((step) => stepName(step) !== SHADOW_STEPS[2]).join("\n");
  assert.deepEqual(shadowWorkflowProblems(partial).problems, []);
});

test("generate-digests.yml check: still catches every state that could do harm", async () => {
  const yml = await liveWorkflow();
  const bad = {
    "can fail the job": yml.replace(/(- name: News shadow test \(decide\)\n        id: shadow\n)        continue-on-error: true\n/, "$1"),
    "mentions nations.json": yml.replace("git add editorial/shadow/", "git add editorial/shadow/ nations.json"),
    "only editorial/shadow/ may be committed": yml.replace("git add editorial/shadow/", "git add editorial/"),
    "not under runner.temp": yml.replace(/DIGEST_PROMPTS_DIR: \$\{\{ runner\.temp \}\}\/digest-writer-inputs/, "DIGEST_PROMPTS_DIR: editorial/prompts"),
    "not the repository variable": yml.replace(/SHADOW_MODEL: \$\{\{ vars\.SHADOW_MODEL \}\}/, "SHADOW_MODEL: some-model"),
    "without the preflight's go-ahead": yml.replace("        if: steps.shadow.outputs.run == 'true'\n", ""),
  };
  for (const [want, variant] of Object.entries(bad)) {
    assert.notEqual(variant, yml, `the "${want}" variant changed nothing`);
    const { problems } = shadowWorkflowProblems(variant);
    assert.ok(problems.some((p) => p.includes(want)), `${want}: ${JSON.stringify(problems)}`);
  }
  // A shadow step moved above the publish step, even under another name.
  const steps = splitSteps(yml);
  const pub = steps.findIndex((s) => stepName(s) === PUBLISH_STEP);
  const run = steps.findIndex((s) => stepName(s) === SHADOW_STEPS[1]);
  const moved = [...steps];
  const [step] = moved.splice(run, 1);
  moved.splice(pub, 0, step.replace(SHADOW_STEPS[1], "Try the other writer"));
  assert.ok(shadowWorkflowProblems(moved.join("\n")).problems.some((p) => p.startsWith("Try the other writer: runs before publication")));
});

// ---- the production side: recording the writer's inputs ----------------------------------

test("writerInputsDir: off when unset, refused anywhere inside the repo, accepted outside it", () => {
  assert.equal(writerInputsDir(undefined).dir, null);
  assert.equal(writerInputsDir("  ").dir, null);
  for (const inside of [ROOT, join(ROOT, "editorial"), join(ROOT, "editorial", "shadow"), join(ROOT, "public", "x"), join(ROOT, "..odd-name")]) {
    const r = writerInputsDir(inside, ROOT);
    assert.equal(r.dir, null, inside);
    assert.match(r.reason, /inside the repo/);
  }
  const outside = join(tmpdir(), "digest-writer-inputs");
  assert.equal(writerInputsDir(outside, ROOT).dir, outside);
  assert.equal(writerInputsDir(`${ROOT}-sibling`, ROOT).dir, `${ROOT}-sibling`); // a prefix is not "inside"
});

test("buildWriterInputs: one entry per traced team (failed ones too), with the exact prompt and its hash", () => {
  const traces = {
    467: { dateISO: "2026-10-07", prompt: "P-RSA", shortlist: [{ title: "t", link: "l", score: 2, corroboration: 1, outlets: ["A"], feedName: "x", snippet: "drop me" }], quiet: false, ladder: null, firstDraft: { a: 1 }, firstCheck: { verdict: "fail", materialIssues: 2 }, revisions: 3 },
    463: { dateISO: "2026-10-07", prompt: "P-JPN", shortlist: [], quiet: true, ladder: { rung: "storyline", storyline: { subject: "s", resolution: "r", extra: 1 }, freshCount: 2, block: "long" } },
    28: {}, // generateFor threw before the prompt existed: nothing to replay
  };
  const out = buildWriterInputs({
    dateISO: "2026-10-07", generatedAt: "2026-10-06T20:30:00.000Z", servedBy: "m",
    traces, generated: { 463: { edition: "ok" } }, failed: [{ team: "South Africa", reason: "fact-check failed after 3 revisions: x" }],
  });
  assert.equal(out.date, "2026-10-07");
  assert.deepEqual(out.teams.map((t) => t.team), ["Japan", "South Africa"]);
  const rsa = out.teams.find((t) => t.teamId === 467);
  assert.equal(rsa.prompt, "P-RSA");
  assert.equal(rsa.promptSha256, sha256("P-RSA"));
  assert.deepEqual(rsa.shortlist, [{ title: "t", link: "l", score: 2, corroboration: 1, outlets: ["A"] }]);
  assert.deepEqual(rsa.production, { firstDraft: { a: 1 }, firstCheck: { verdict: "fail", materialIssues: 2 }, revisions: 3, published: null, failed: "fact-check failed after 3 revisions: x" });
  const jpn = out.teams.find((t) => t.teamId === 463);
  assert.deepEqual(jpn.ladder, { rung: "storyline", freshCount: 2, storyline: { subject: "s", resolution: "r" } });
  assert.deepEqual(jpn.production.published, { edition: "ok" });
  assert.equal(WRITER_INPUTS_FILE, "writer-inputs.json");
});

test("readWriterInputs: reads the file the production run left in DIGEST_PROMPTS_DIR, and never from inside the repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "prompts-"));
  try {
    await writeFile(join(dir, WRITER_INPUTS_FILE), JSON.stringify(inputsFor()));
    assert.equal((await readWriterInputs({ DIGEST_PROMPTS_DIR: dir }, ROOT)).date, "2026-10-07");
    assert.equal(await readWriterInputs({}, ROOT), null);
    assert.equal(await readWriterInputs({ DIGEST_PROMPTS_DIR: join(ROOT, "editorial") }, ROOT), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- grading ---------------------------------------------------------------------

test("gradingPrompts: both writers' first drafts through the production review rubric, labelled blind", async () => {
  const { root } = await sandbox();
  try {
    const inputs = inputsFor();
    inputs.teams[1].production.firstDraft = null; // Gemini's first draft never validated
    const client = fakeClient(() => ({ text: JSON.stringify(digestFor("2026-10-07", "Kolisi returns as captain for the Springboks against the Wallabies")), input: 1000, output: 500 }));
    const rec = await runShadow({ root, inputs, client, model: MODEL, now: NOW, log: () => {} });
    const g = gradingPrompts(rec);
    assert.deepEqual(new Set(Object.values(g.key)), new Set(["production", "shadow"]));
    assert.deepEqual(blindKey("2026-10-07"), g.key); // deterministic per date
    const prod = g[g.key.X === "production" ? "X" : "Y"];
    const shadow = g[g.key.X === "shadow" ? "X" : "Y"];
    assert.equal(prod.count, 2);
    assert.deepEqual(prod.missing, ["New Zealand"]);
    assert.equal(shadow.count, 3);
    assert.match(shadow.prompt, /Kolisi returns as captain/);
    assert.match(prod.prompt, /South Africa coach confirms the squad/);
    assert.match(prod.prompt, /reviewing editor/); // the daily review's own rubric
    for (const p of [prod.prompt, shadow.prompt]) assert.doesNotMatch(p, /shadow|production/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- a second writer (SHADOW_ALSO, 9 Oct 2026) -------------------------------------

test("shadowModels: SHADOW_MODEL first, then each SHADOW_ALSO id once; blanks dropped", async () => {
  const { shadowModels, recordName } = await import("./news-shadow.mjs");
  const ids = shadowModels({ SHADOW_ALSO: " claude-haiku-5-5, ,claude-haiku-5-5" }).map((m) => m.id);
  assert.deepEqual(ids, [SONNET.id, "claude-haiku-5-5"]);
  assert.deepEqual(shadowModels({}).map((m) => m.id), [SONNET.id]);
  assert.ok(shadowModels({ SHADOW_ALSO: "claude-haiku-5-5" })[1].price, "Haiku 5.5 is priced, so it can run");
  assert.equal(recordName("2026-10-10"), "2026-10-10.json");
  assert.equal(recordName("2026-10-10", "claude-haiku-5-5"), "2026-10-10.claude-haiku-5-5.json");
});

test("windowSpend: a further writer's files are its own window, and never count in Sonnet's", async () => {
  const root = await mkdtemp(join(tmpdir(), "shadow-also-"));
  try {
    await mkdir(join(root, "editorial", "shadow"), { recursive: true });
    await writeFile(join(root, "editorial", "shadow", "2026-10-10.json"), JSON.stringify({ cost: { runUSD: 0.7, unaccountedUSD: 0 } }));
    await writeFile(join(root, "editorial", "shadow", "2026-10-10.claude-haiku-5-5.json"), JSON.stringify({ cost: { runUSD: 0.04, unaccountedUSD: 0 } }));
    assert.ok(Math.abs((await windowSpend(root)) - 0.7) < 1e-9);
    assert.ok(Math.abs((await windowSpend(root, "claude-haiku-5-5")) - 0.04) < 1e-9);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
