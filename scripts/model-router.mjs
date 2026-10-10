// Which model answers which editorial call, and the Anthropic text call itself.
//
// The digest pipeline makes six kinds of model call: the WRITER (one draft per
// team, plus revisions), the CHECKER (one fact-check per draft), the daily
// REVIEW (one call over the twelve editions, which steers tomorrow's writer
// prompt and proposes news sources), the WORLD roundup (write + check), the
// storyline EXTRACT and the checker TUNE. Until 11 Oct 2026 all six ran on
// Gemini's free tier, and the run completed on the last rung of that ladder
// most days. The news shadow test (editorial/shadow/, 6-12 Oct) measured the
// alternatives on production's own prompts: Haiku 5.5 passed the format gate
// on 36 of 36 drafts at about US$0.03 a run; Sonnet 5 at about US$0.65 a run,
// above the US$24-a-month ceiling in the growth strategy.
//
// So: the user-facing calls (writer, checker, world) go to Haiku 5.5; the
// review, where the free model was visibly noisy (eight near-duplicate editor
// notes in two days), goes to Sonnet 5.5; the two cheap housekeeping calls
// stay on Gemini while a key is set. Every Anthropic call falls back to Gemini
// on failure when a Gemini key exists, so the free ladder is the spare, not
// the engine. Each role is overridable by a repository variable, so a model
// can be swapped for a week without a code change.
//
// Pure helpers (modelPlan, tally) test offline; the SDK is loaded only by
// createAnthropicCaller, from the caller that holds a key.
import { MODELS } from "./compare-digest-models.mjs";

export const ROLES = ["writer", "checker", "review", "world", "extract", "tune"];

// Defaults when an Anthropic key is set. `gemini` means the Gemini ladder.
export const DEFAULT_MODELS = {
  writer: "claude-haiku-5-5",
  checker: "claude-haiku-5-5",
  review: "claude-sonnet-5-5",
  world: "claude-haiku-5-5",
  extract: "gemini",
  tune: "gemini",
};

// Repository variables that override a role. Any value naming a model with a
// price in compare-digest-models.mjs, or the word "gemini".
export const ROLE_ENV = {
  writer: "DIGEST_WRITER_MODEL",
  checker: "DIGEST_CHECKER_MODEL",
  review: "DIGEST_REVIEW_MODEL",
  world: "DIGEST_WORLD_MODEL",
  extract: "DIGEST_EXTRACT_MODEL",
  tune: "DIGEST_TUNE_MODEL",
};

// Output ceilings per role. A finished edition or verdict is well under 1,000
// tokens of JSON; the rest is headroom for thinking, which counts against
// max_tokens and bills as output. The writer's 12,000 is production's own
// figure (its first Sonnet run at 4,000 ran out before the JSON on 10 of 12
// teams). The review writes a 300-word report plus notes over twelve editions
// and gets more room.
export const MAX_TOKENS = { writer: 12000, checker: 8000, review: 16000, world: 12000, extract: 12000, tune: 8000 };

export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

export const priceFor = (model) => MODELS.find((m) => m.id === model) ?? null;

// Decide the model for every role from the environment and the keys at hand.
// Returns { plan: { role: modelId | "gemini" }, warnings: [] }. A role whose
// override names an unpriced model falls back to the default with a warning;
// a role that resolves to an Anthropic model without an Anthropic key, or to
// Gemini without a Gemini key, moves to whichever provider has a key.
export function modelPlan(env = {}, { gemini = false, anthropic = false } = {}) {
  const warnings = [];
  const plan = {};
  for (const role of ROLES) {
    let model = (env[ROLE_ENV[role]] || "").trim() || DEFAULT_MODELS[role];
    if (model !== "gemini" && !priceFor(model)) {
      warnings.push(`${ROLE_ENV[role]}=${model} has no price in compare-digest-models.mjs; using ${DEFAULT_MODELS[role]}`);
      model = DEFAULT_MODELS[role];
    }
    if (model === "gemini" && !gemini) {
      // No Gemini key: the housekeeping roles ride the writer's model.
      const own = DEFAULT_MODELS[role] === "gemini" ? DEFAULT_MODELS.writer : DEFAULT_MODELS[role];
      model = anthropic ? own : null;
    }
    if (model && model !== "gemini" && !anthropic) model = gemini ? "gemini" : null;
    plan[role] = model;
  }
  return { plan, warnings };
}

// Per-model call tally for the run report: calls, tokens, cost at the price
// table, and how many calls fell back to Gemini.
export function createTally() {
  const rows = new Map();
  const row = (model) => {
    if (!rows.has(model)) rows.set(model, { model, calls: 0, failed: 0, fellBack: 0, input: 0, output: 0, costUSD: 0 });
    return rows.get(model);
  };
  return {
    record(model, usage) {
      const r = row(model);
      r.calls++;
      r.input += usage?.input_tokens ?? 0;
      r.output += usage?.output_tokens ?? 0;
      const p = priceFor(model);
      if (p) r.costUSD = round(r.costUSD + ((usage?.input_tokens ?? 0) * p.in + (usage?.output_tokens ?? 0) * p.out) / 1e6);
    },
    failed(model) {
      row(model).failed++;
    },
    fellBack(model) {
      row(model).fellBack++;
    },
    summary() {
      const list = [...rows.values()];
      return {
        rows: list,
        calls: list.reduce((n, r) => n + r.calls, 0),
        failed: list.reduce((n, r) => n + r.failed, 0),
        fellBack: list.reduce((n, r) => n + r.fellBack, 0),
        costUSD: round(list.reduce((n, r) => n + r.costUSD, 0)),
      };
    },
  };
}

const round = (n) => Math.round(n * 1e5) / 1e5;

// One Anthropic text call: prompt in, text out. A refusal or a cut-off answer
// is an error, so the caller's fallback (Gemini) gets its turn; the SDK's own
// retries cover 429/5xx. `client` is an @anthropic-ai/sdk client.
export function createAnthropicCaller(client, model, { maxTokens = 12000, tally = null, label = model } = {}) {
  return async function anthropicCall(prompt) {
    let resp;
    try {
      resp = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      });
    } catch (e) {
      tally?.failed(model);
      throw new Error(`${label}: ${e?.status ? `HTTP ${e.status} ` : ""}${String(e?.message ?? e).slice(0, 200)}`);
    }
    tally?.record(model, resp.usage);
    if (resp.stop_reason === "refusal") {
      tally?.failed(model);
      throw new Error(`${label}: refusal${resp.stop_details?.category ? ` (${resp.stop_details.category})` : ""}`);
    }
    const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if (resp.stop_reason === "max_tokens") {
      tally?.failed(model);
      throw new Error(`${label}: cut off at max_tokens (${maxTokens}) | tail: …${text.slice(-120).replace(/\s+/g, " ")}`);
    }
    return text;
  };
}

// primary(prompt) → text, else fallback(prompt) → text. The fallback is only
// tried when there is one; the primary's error is logged either way so a run
// that quietly ran on the spare is visible in the log.
export function withFallback(primary, fallback, { label = "model", tally = null, model = null, onFallback = null } = {}) {
  if (!fallback) return primary;
  return async function routedCall(prompt) {
    try {
      return await primary(prompt);
    } catch (e) {
      if (model) tally?.fellBack(model);
      console.warn(`  ${label} failed (${String(e.message).slice(0, 160)}); falling back to gemini`);
      onFallback?.(e);
      return fallback(prompt);
    }
  };
}

// Build the per-role callers. `geminiCall(prompt)` may be null (no Gemini
// key); `client` may be null (no Anthropic key). Returns { calls, tally,
// plan } where calls[role](prompt) → text.
export async function buildCallers({ plan, geminiCall = null, client = null, tally = createTally() }) {
  const calls = {};
  for (const role of ROLES) {
    const model = plan[role];
    if (!model) continue;
    if (model === "gemini") {
      if (geminiCall) calls[role] = geminiCall;
      continue;
    }
    if (!client) continue;
    const primary = createAnthropicCaller(client, model, { maxTokens: MAX_TOKENS[role], tally, label: `${role} (${model})` });
    calls[role] = withFallback(primary, geminiCall, { label: `${role} (${model})`, tally, model });
  }
  return { calls, tally, plan };
}

export function describePlan(plan) {
  return ROLES.filter((r) => plan[r]).map((r) => `${r}=${plan[r]}`).join(", ");
}
