// One-off model comparison for the news digest: generates the South Africa
// (Bok Watch) edition on several models with the identical prompt and web-search
// setup as production, printing each digest plus token usage and approximate
// cost. Does NOT touch public/nations.json — output goes to stdout only.
//
// Usage: ANTHROPIC_API_KEY=... node scripts/compare-digest-models.mjs
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractJson, validateDigest } from "./generate-digests.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// USD per million tokens (input, output). Sonnet 5 at intro pricing to 2026-08-31.
const MODELS = [
  { id: "claude-haiku-4-5", in: 1, out: 5 },
  { id: "claude-sonnet-5", in: 2, out: 10 },
  { id: "claude-opus-4-8", in: 5, out: 25 },
  { id: "claude-fable-5", in: 10, out: 50 },
];

// Haiku 4.5 predates the dynamic-filtering web-search variant; the current
// models use the same version production does.
const searchToolFor = (model) => ({
  type: model === "claude-haiku-4-5" ? "web_search_20250305" : "web_search_20260209",
  name: "web_search",
  max_uses: 8,
});

const MAX_CONTINUATIONS = 5;

function sydneyISO(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

async function runModel(client, model, prompt) {
  const tool = searchToolFor(model);
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const addUsage = (u) => {
    usage.input += u.input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
  };

  let messages = [{ role: "user", content: prompt }];
  let resp = await client.messages.create({ model, max_tokens: 16000, tools: [tool], messages });
  addUsage(resp.usage);
  for (let i = 0; resp.stop_reason === "pause_turn" && i < MAX_CONTINUATIONS; i++) {
    messages = [...messages, { role: "assistant", content: resp.content }];
    resp = await client.messages.create({ model, max_tokens: 16000, tools: [tool], messages });
    addUsage(resp.usage);
  }
  if (resp.stop_reason === "refusal") throw new Error("refusal (safety classifiers)");

  const searches = resp.content.filter((b) => b.type === "server_tool_use").length;
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = extractJson(text);
  const { ok, digest, errors } = validateDigest(raw, { dateISO: sydneyISO() });
  return { digest: ok ? digest : raw, valid: ok, errors, usage, searches, stopReason: resp.stop_reason };
}

function estCost(m, u) {
  // Cache writes bill at 1.25x input, reads at 0.1x.
  return ((u.input + u.cacheWrite * 1.25 + u.cacheRead * 0.1) * m.in + u.output * m.out) / 1e6;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set");
    process.exit(1);
  }

  // Reuse the production prompt verbatim: --dry-run prints the filled South
  // Africa (467) prompt from live nations.json data.
  const dry = spawnSync("node", [join(ROOT, "scripts", "generate-digests.mjs"), "--dry-run"], { encoding: "utf8" });
  if (dry.status !== 0) throw new Error(`dry-run failed: ${dry.stderr}`);
  const prompt = dry.stdout;

  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const summary = [];
  for (const m of MODELS) {
    console.log(`\n${"=".repeat(70)}\n== ${m.id}\n${"=".repeat(70)}`);
    const t0 = Date.now();
    try {
      const r = await runModel(client, m.id, prompt);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(JSON.stringify(r.digest, null, 2));
      if (!r.valid) console.log(`⚠️  failed validation: ${r.errors?.join("; ") ?? "no JSON found"}`);
      const cost = estCost(m, r.usage);
      console.log(`\ntokens in=${r.usage.input} out=${r.usage.output} cacheW=${r.usage.cacheWrite} cacheR=${r.usage.cacheRead} | searches=${r.searches} | ${secs}s | ~US$${cost.toFixed(3)}`);
      summary.push({ model: m.id, valid: r.valid, cost: `US$${cost.toFixed(3)}`, seconds: secs });
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      summary.push({ model: m.id, valid: false, cost: "-", seconds: "-", error: e.message });
    }
  }

  console.log(`\n${"=".repeat(70)}\n== Summary\n${"=".repeat(70)}`);
  console.table(summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
