import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES, DEFAULT_MODELS, MAX_TOKENS, modelPlan, createTally, createAnthropicCaller, withFallback, buildCallers, describePlan,
} from "./model-router.mjs";
import { MODELS } from "./compare-digest-models.mjs";

test("defaults: Haiku 5.5 writes and checks, Sonnet 5.5 reviews, housekeeping stays on Gemini, every paid default is priced", () => {
  assert.equal(DEFAULT_MODELS.writer, "claude-haiku-5-5");
  assert.equal(DEFAULT_MODELS.checker, "claude-haiku-5-5");
  assert.equal(DEFAULT_MODELS.review, "claude-sonnet-5-5");
  assert.equal(DEFAULT_MODELS.extract, "gemini");
  assert.equal(DEFAULT_MODELS.tune, "gemini");
  for (const role of ROLES) {
    const m = DEFAULT_MODELS[role];
    if (m !== "gemini") assert.ok(MODELS.some((p) => p.id === m), `${m} has a price`);
    assert.ok(MAX_TOKENS[role] >= 8000, `${role} has output headroom for thinking`);
  }
  assert.equal(MAX_TOKENS.writer, 12000, "production's own figure, which the shadow test matched");
});

test("modelPlan: both keys → the defaults; overrides win when priced; an unpriced override warns and falls back", () => {
  const both = { gemini: true, anthropic: true };
  assert.deepEqual(modelPlan({}, both).plan, DEFAULT_MODELS);
  const { plan, warnings } = modelPlan({ DIGEST_REVIEW_MODEL: "claude-opus-4-8", DIGEST_WRITER_MODEL: "claude-fable-9" }, both);
  assert.equal(plan.review, "claude-opus-4-8");
  assert.equal(plan.writer, "claude-haiku-5-5");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claude-fable-9/);
  assert.equal(modelPlan({ DIGEST_WRITER_MODEL: "gemini" }, both).plan.writer, "gemini", "a role can be sent back to the free ladder");
  assert.equal(modelPlan({ DIGEST_WRITER_MODEL: "  " }, both).plan.writer, "claude-haiku-5-5", "a blank variable is unset");
});

test("modelPlan: one key → everything on that provider; no key → nothing", () => {
  const geminiOnly = modelPlan({ DIGEST_REVIEW_MODEL: "claude-opus-4-8" }, { gemini: true, anthropic: false }).plan;
  for (const role of ROLES) assert.equal(geminiOnly[role], "gemini", role);
  const anthropicOnly = modelPlan({}, { gemini: false, anthropic: true }).plan;
  assert.equal(anthropicOnly.writer, "claude-haiku-5-5");
  assert.equal(anthropicOnly.review, "claude-sonnet-5-5");
  assert.equal(anthropicOnly.extract, "claude-haiku-5-5", "housekeeping rides the writer's model without a Gemini key");
  assert.equal(anthropicOnly.tune, "claude-haiku-5-5");
  const none = modelPlan({}, { gemini: false, anthropic: false }).plan;
  for (const role of ROLES) assert.equal(none[role], null, role);
  assert.equal(describePlan(anthropicOnly).split(", ").length, ROLES.length);
});

const fakeClient = (responses) => {
  const requests = [];
  return {
    requests,
    messages: {
      async create(req) {
        requests.push(req);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
};
const reply = (text, extra = {}) => ({
  stop_reason: "end_turn",
  content: [{ type: "text", text }],
  usage: { input_tokens: 1000, output_tokens: 200 },
  ...extra,
});

test("createAnthropicCaller: plain prompt in, text out, usage and cost tallied at the price table", async () => {
  const tally = createTally();
  const client = fakeClient([reply("{\"ok\":true}")]);
  const call = createAnthropicCaller(client, "claude-haiku-5-5", { maxTokens: 12000, tally });
  assert.equal(await call("hello"), "{\"ok\":true}");
  assert.equal(client.requests[0].model, "claude-haiku-5-5");
  assert.equal(client.requests[0].max_tokens, 12000);
  assert.deepEqual(client.requests[0].messages, [{ role: "user", content: "hello" }]);
  assert.equal(client.requests[0].thinking, undefined, "adaptive thinking is the model's default; nothing explicit to break on a model swap");
  const s = tally.summary();
  assert.equal(s.calls, 1);
  assert.equal(s.rows[0].input, 1000);
  assert.equal(s.rows[0].output, 200);
  // 1000 × 0.10 + 200 × 0.50 per million
  assert.ok(Math.abs(s.costUSD - 0.0002) < 1e-9, String(s.costUSD));
});

test("createAnthropicCaller: a refusal or a cut-off answer is an error, counted as failed", async () => {
  const tally = createTally();
  const client = fakeClient([
    reply("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } }),
    reply("{\"partial\":", { stop_reason: "max_tokens" }),
    Object.assign(new Error("overloaded"), { status: 529 }),
  ]);
  const call = createAnthropicCaller(client, "claude-sonnet-5-5", { maxTokens: 16000, tally, label: "review" });
  await assert.rejects(call("p"), /review: refusal \(general_harms\)/);
  await assert.rejects(call("p"), /cut off at max_tokens \(16000\)/);
  await assert.rejects(call("p"), /review: HTTP 529 overloaded/);
  assert.equal(tally.summary().failed, 3);
  assert.equal(tally.summary().calls, 2, "the two answered calls are still billed");
});

test("withFallback: the primary's failure goes to Gemini and is counted; no fallback means the error stands", async () => {
  const tally = createTally();
  const primary = async () => { throw new Error("boom"); };
  const gemini = async (p) => `gemini:${p}`;
  const routed = withFallback(primary, gemini, { tally, model: "claude-haiku-5-5", label: "writer" });
  assert.equal(await routed("x"), "gemini:x");
  assert.equal(tally.summary().fellBack, 1);
  const alone = withFallback(primary, null, { tally, model: "claude-haiku-5-5" });
  await assert.rejects(alone("x"), /boom/);
});

test("buildCallers: paid roles get a routed caller, gemini roles the Gemini call, missing providers no caller", async () => {
  const client = fakeClient([reply("w"), reply("r")]);
  const gemini = async () => "g";
  const { calls } = await buildCallers({
    plan: { writer: "claude-haiku-5-5", checker: "gemini", review: "claude-sonnet-5-5", world: "claude-haiku-5-5", extract: "gemini", tune: null },
    geminiCall: gemini,
    client,
  });
  assert.equal(await calls.writer("p"), "w");
  assert.equal(await calls.checker("p"), "g");
  assert.equal(await calls.review("p"), "r");
  assert.equal(calls.tune, undefined);
  assert.equal(client.requests[0].max_tokens, MAX_TOKENS.writer);
  assert.equal(client.requests[1].max_tokens, MAX_TOKENS.review);
  // Primary exhausted → the next writer call lands on Gemini.
  assert.equal(await calls.writer("p"), "g");

  const noGemini = await buildCallers({ plan: { writer: "gemini", checker: "claude-haiku-5-5" }, geminiCall: null, client: null });
  assert.deepEqual(Object.keys(noGemini.calls), []);
});
