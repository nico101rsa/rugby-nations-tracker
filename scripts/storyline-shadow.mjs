// Storyline shadow run: the same fact packs written by several models, for an
// editorial read of quality against price (Nico, 21 Oct 2026: "prepare the
// storylines using various models, then review the output; what is the price
// difference vs quality").
//
// Nothing here reaches the app. For every upcoming fixture the pack is built
// once, exactly as production builds it (build-storylines.mjs: repo data, the
// news pool, the search widener and the article text), and each writer gets
// production's exact prompt. Production's own checker (the checker role of
// model-router.mjs, Haiku 5.5 unless DIGEST_CHECKER_MODEL says otherwise)
// fact-checks every draft under the same one-revision rule, so a writer is
// judged on what it would have published, and its first draft's verdict is
// recorded as a quality signal that costs no human time.
//
// What is kept, per writer and fixture: the first draft, the format gate, the
// first fact-check verdict, the revision if any, the final story, tokens,
// cost at list price (compare-digest-models.mjs) and wall time. What is NOT
// kept: the pack text and the article bodies — publishers' copy in a public
// repo. The trusted facts (fixture, rankings, stakes, form, meetings) and the
// news items' titles and links are already public in the repo, so they are.
//
// Spend. A writer without a price in compare-digest-models.mjs is refused.
// Before each fixture the run reserves every writer's worst case (input at
// two characters a token, output at the role ceiling, writer and checker,
// twice for a revision) against the cap; a writer that would break it skips
// that fixture and the cheaper ones carry on. Actual spend, from the SDK's
// usage, replaces the reservation once the fixture is done.
//
// Usage (the workflow .github/workflows/storyline-shadow.yml runs it; by hand
// it needs ANTHROPIC_API_KEY and, for "gemini", GEMINI_API_KEY):
//   node scripts/storyline-shadow.mjs [--models gemini,claude-haiku-5-5,...]
//        [--days 20] [--fixture espn-604593|JPN-FIJ] [--cap 8] [--out editorial/shadow-storylines]
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadInputs, onlyFixture, upcomingFixtures, buildPack, packHashes, renderPack, writeStory, fetchBodies, widenFixture, sha256,
  WINDOW_DAYS, VOICES, STORYLINE_DEFAULT_VOICE,
} from "./build-storylines.mjs";
import { MAX_TOKENS, REQUEST_TIMEOUT_MS, modelPlan, createAnthropicCaller, createTally, priceFor } from "./model-router.mjs";
import { geminiCall, GEMINI_MODEL } from "./generate-digests.mjs";
import { words } from "./copy-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_DIR = join(ROOT, "editorial", "shadow-storylines");
export const DEFAULT_WRITERS = ["gemini", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
export const DEFAULT_DAYS = 20;
export const DEFAULT_CAP_USD = 8;
export const NOTICE =
  "Shadow run. Nothing here was published or shown in the app. Each draft was fact-checked against the app's own data only, never against the world, so any story may be wrong about real people and events.";

// "2026-10-21-0745": the Sydney date and time the run started.
export function sydneyStamp(now = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour === "24" ? "00" : parts.hour}${parts.minute}`;
}

export function sydneyLabel(now = Date.now()) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now).replace(/,/g, "");
}

// Worst case of one writer-plus-checker round, in US$: input over-counted at
// two characters a token (English prose runs at about four), output at the
// role ceiling. Gemini (no price) costs nothing.
export function worstCaseUSD(promptChars, writerPrice, checkerPrice) {
  const one = (price, maxTokens) => (price ? ((promptChars / 2) * price.in + maxTokens * price.out) / 1e6 : 0);
  return one(writerPrice, MAX_TOKENS.writer) + one(checkerPrice, MAX_TOKENS.checker);
}

const round = (n) => Math.round(n * 1e5) / 1e5;

// A writer id to a caller factory. Each story gets its own tally, so parallel
// stories never share a usage row. "gemini" is the free ladder; a model id
// goes to the SDK with no fallback — a failure is a finding here, not
// something to paper over.
export function resolveWriter(id, { client = null, geminiKey = null } = {}) {
  if (id === "gemini") {
    if (!geminiKey) return { id, price: null, error: "GEMINI_API_KEY not set" };
    return { id, price: null, make: () => ({ call: (p) => geminiCall(geminiKey, p), tally: null }) };
  }
  const price = priceFor(id);
  if (!price) return { id, price: null, error: `no price in compare-digest-models.mjs, so the spend guard cannot bound it` };
  if (!client) return { id, price, error: "ANTHROPIC_API_KEY not set" };
  return {
    id,
    price,
    make: () => {
      const tally = createTally();
      return { call: createAnthropicCaller(client, id, { maxTokens: MAX_TOKENS.writer, tally, label: `writer (${id})` }), tally };
    },
  };
}

// The trace writeStory fills, folded into the record's fields.
export function foldTrace(trace) {
  const steps = trace ?? [];
  const story = (raw) => (raw && typeof raw === "object" ? { headline: raw.headline ?? null, beats: Array.isArray(raw.beats) ? raw.beats : [], sources: Array.isArray(raw.sources) ? raw.sources.length : 0 } : null);
  const draft = steps.find((s) => s.step === "draft");
  const gates = steps.filter((s) => s.step === "gate");
  const checks = steps.filter((s) => s.step === "check");
  const revision = steps.find((s) => s.step === "revision");
  const verdict = (c) => (c ? { verdict: c.verdict, material: c.issues?.length ?? 0, issues: (c.issues ?? []).map((i) => ({ claim: i.claim ?? null, problem: i.problem ?? null, fix: i.fix ?? null })) } : null);
  return {
    draft: story(draft?.raw),
    gate: gates[0] ?? null,
    check1: verdict(checks[0]),
    revised: !!revision,
    revisionGate: revision ? gates[1] ?? null : null,
    check2: revision ? verdict(checks[1]) : null,
  };
}

// One writer on one fixture: production's writeStory with that writer and the
// run's checker, traced and timed.
export async function shadowStory({ writer, checker, pack, packText, voice = STORYLINE_DEFAULT_VOICE, now = () => Date.now() }) {
  const w = writer.make();
  const c = checker.make();
  const trace = [];
  const t0 = now();
  let final = null;
  let error = null;
  try {
    const s = await writeStory({ writer: w.call, checker: c.call }, pack, packText, { trace, voice });
    final = { headline: s.headline, beats: s.beats, sources: s.sources, revised: s.revised };
  } catch (e) {
    error = String(e?.message ?? e).slice(0, 300);
  }
  const seconds = Math.round((now() - t0) / 100) / 10;
  const usage = { writer: w.tally?.summary() ?? null, checker: c.tally?.summary() ?? null };
  const tokens = (u) => ({
    calls: u?.calls ?? 0,
    input: (u?.rows ?? []).reduce((n, r) => n + r.input, 0),
    output: (u?.rows ?? []).reduce((n, r) => n + r.output, 0),
  });
  // Priced here from the writer's own price row (the tally prices by model id
  // from the same table; this keeps a scripted test writer honest too).
  const cost = (u, price) => (price ? (u.input * price.in + u.output * price.out) / 1e6 : 0);
  const wt = tokens(usage.writer);
  const ct = tokens(usage.checker);
  const writerCostUSD = round(cost(wt, writer.price));
  const checkerCostUSD = round(cost(ct, checker.price));
  return {
    writer: writer.id,
    fixture: pack.fixture.id,
    ok: !!final,
    error,
    ...foldTrace(trace),
    final,
    seconds,
    usage: { writerCalls: wt.calls, writerInput: wt.input, writerOutput: wt.output, writerCostUSD, checkerCalls: ct.calls, checkerCostUSD },
    costUSD: round(writerCostUSD + checkerCostUSD),
  };
}

// Every writer on every fixture, fixture by fixture (the writers of one
// fixture in parallel), under the cap. `packs` is [{ fixture, pack, packText }].
export async function runShadow({ packs, writers, checker, voice = STORYLINE_DEFAULT_VOICE, cap = DEFAULT_CAP_USD, log = console.log, now = () => Date.now() }) {
  const results = [];
  const skipped = [];
  let spent = 0;
  for (const { fixture, pack, packText } of packs) {
    const label = `${fixture.home.code} v ${fixture.away.code}`;
    let reserved = 0;
    const running = [];
    for (const writer of writers) {
      if (writer.error) {
        skipped.push({ fixture: fixture.id, writer: writer.id, reason: writer.error });
        continue;
      }
      const worst = 2 * worstCaseUSD(packText.length, writer.price, checker.price);
      if (spent + reserved + worst > cap) {
        skipped.push({ fixture: fixture.id, writer: writer.id, reason: `cap: US$${(spent + reserved).toFixed(2)} spent or reserved, this round could cost US$${worst.toFixed(2)}, cap US$${cap}` });
        log(`  ${label}: ${writer.id} skipped — would pass the US$${cap} cap`);
        continue;
      }
      reserved += worst;
      running.push(shadowStory({ writer, checker, pack, packText, voice, now }));
    }
    const done = await Promise.all(running);
    for (const r of done) {
      results.push(r);
      spent += r.costUSD;
      log(`  ${label}: ${r.writer} ${r.ok ? (r.revised ? "passed after one revision" : "passed first time") : `FAILED (${r.error})`}${r.check1 ? `, first check ${r.check1.verdict}${r.check1.material ? ` (${r.check1.material} material)` : ""}` : ""}, US$${r.costUSD.toFixed(4)}, ${r.seconds}s`);
    }
  }
  return { results, skipped, spentUSD: round(spent) };
}

export function totalsOf(results, writers) {
  return writers.map((w) => {
    const rows = results.filter((r) => r.writer === w.id);
    const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
    return {
      writer: w.id,
      price: w.price,
      stories: rows.length,
      passed: rows.filter((r) => r.ok).length,
      passedFirstTime: rows.filter((r) => r.ok && !r.revised).length,
      revised: rows.filter((r) => r.revised).length,
      failed: rows.filter((r) => !r.ok).length,
      gateFailures: rows.filter((r) => r.gate && !r.gate.ok).length,
      materialIssuesFirstDraft: sum((r) => r.check1?.material ?? 0),
      writerInput: sum((r) => r.usage.writerInput),
      writerOutput: sum((r) => r.usage.writerOutput),
      costUSD: round(sum((r) => r.costUSD)),
      writerCostUSD: round(sum((r) => r.usage.writerCostUSD)),
      perStoryUSD: rows.length ? round(sum((r) => r.costUSD) / rows.length) : null,
      secondsPerStory: rows.length ? Math.round((sum((r) => r.seconds) / rows.length) * 10) / 10 : null,
    };
  });
}

// What the JSON record keeps of a pack: the trusted facts and the news list
// without snippets. Never the article text.
export function packRecord(pack, packText) {
  const { news, ...facts } = pack;
  return {
    ...facts,
    news: (news ?? []).map(({ title, url, outlet, published, background, about }) => ({ title, url, outlet, published, background, about })),
    promptChars: packText.length,
    packSha256: sha256(packText),
  };
}

const usd = (n) => `US$${Number(n ?? 0).toFixed(n >= 1 ? 2 : 3)}`;

export function renderMarkdown(doc) {
  const L = [];
  L.push(`# Storyline shadow run — ${doc.startedSydney} Sydney time`);
  L.push("");
  L.push(`> ${NOTICE}`);
  L.push("");
  L.push(`Writers: ${doc.writers.map((w) => w.id).join(", ")}. Checker: ${doc.checker}. Voice: ${doc.voice ?? "preview"}. Window: ${doc.days} days, ${doc.fixtures.length} fixture${doc.fixtures.length === 1 ? "" : "s"}. Cap ${usd(doc.capUSD)}; spent ${usd(doc.spentUSD)}.`);
  L.push("");
  L.push("## Totals");
  L.push("");
  L.push("| Writer | Stories | Passed | First time | Revised | Failed | Material issues on first draft | Writer tokens in / out | Cost | Per story | Seconds per story |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const t of doc.totals) {
    L.push(`| ${t.writer} | ${t.stories} | ${t.passed} | ${t.passedFirstTime} | ${t.revised} | ${t.failed} | ${t.materialIssuesFirstDraft} | ${t.writerInput} / ${t.writerOutput} | ${usd(t.costUSD)} | ${t.perStoryUSD == null ? "—" : usd(t.perStoryUSD)} | ${t.secondsPerStory ?? "—"} |`);
  }
  if (doc.skipped.length) {
    L.push("");
    L.push("Skipped: " + doc.skipped.map((s) => `${s.writer} on ${s.fixture} (${s.reason})`).join("; ") + ".");
  }
  doc.fixtures.forEach((f, i) => {
    L.push("");
    L.push(`## ${i + 1}. ${f.pack.fixture.home.name} v ${f.pack.fixture.away.name} — ${f.pack.fixture.kickoffSydney}`);
    L.push("");
    const r = f.pack.rankings;
    const rk = r ? `Rankings: ${f.pack.fixture.home.name} ${r[f.pack.fixture.home.code]?.rank ?? "—"}, ${f.pack.fixture.away.name} ${r[f.pack.fixture.away.code]?.rank ?? "—"}. ` : "";
    const current = f.pack.news.filter((n) => !n.background).length;
    L.push(`${rk}${f.pack.comp?.label ? `${f.pack.comp.label}. ` : ""}News items: ${f.pack.news.length} (${current} current). Previous meetings on record: ${f.pack.meetings.length}. Prompt ${f.pack.promptChars} characters.`);
    for (const w of doc.writers) {
      const res = doc.results.find((x) => x.fixture === f.id && x.writer === w.id);
      L.push("");
      if (!res) {
        const s = doc.skipped.find((x) => x.fixture === f.id && x.writer === w.id);
        L.push(`### ${w.id} — not run${s ? ` (${s.reason})` : ""}`);
        continue;
      }
      const verdict = res.ok ? (res.revised ? "passed after one revision" : "passed first time") : `FAILED: ${res.error}`;
      const check = res.check1 ? `first check: ${res.check1.verdict}${res.check1.material ? ` (${res.check1.material} material)` : ""}` : "no first check";
      // Why the revision happened matters as much as that it did: the first
      // run's revisions were mostly length, not facts, so the first draft's
      // word count is in the header too.
      const gate = res.gate && !res.gate.ok ? ` · first draft failed the gate: ${res.gate.errors.join("; ")}` : "";
      const draftWords = res.draft ? ` · first draft ${words([res.draft.headline ?? "", ...(res.draft.beats ?? [])].join(" "))} words` : "";
      L.push(`### ${w.id} — ${verdict} · ${check}${gate}${draftWords} · ${usd(res.costUSD)} · ${res.seconds} s · writer tokens ${res.usage.writerInput} in / ${res.usage.writerOutput} out`);
      L.push("");
      const story = res.final ?? res.draft;
      if (story) {
        L.push(`**${story.headline ?? "(no headline)"}**`);
        L.push("");
        for (const b of story.beats ?? []) L.push(`- ${b}`);
        const n = Array.isArray(story.sources) ? story.sources.length : story.sources ?? 0;
        L.push("");
        L.push(`_Sources cited: ${n} of ${f.pack.news.length}${res.final ? "" : " (first draft; no story survived)"}_`);
      } else {
        L.push("_No draft parsed._");
      }
      if (res.check1?.issues?.length) {
        L.push("");
        L.push("First-draft issues the checker flagged:");
        for (const i of res.check1.issues) L.push(`- ${i.claim ? `"${i.claim}": ` : ""}${i.problem ?? ""}${i.fix ? ` (fix: ${i.fix})` : ""}`);
      }
      if (res.revised && res.draft && res.final) {
        L.push("");
        L.push(`First draft headline: **${res.draft.headline ?? ""}**`);
      }
    }
  });
  L.push("");
  return L.join("\n");
}

const arg = (name, argv = process.argv) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};

export async function main(argv = process.argv) {
  const now = Date.now();
  const writerIds = (arg("--models", argv) ?? DEFAULT_WRITERS.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const days = Number(arg("--days", argv)) || DEFAULT_DAYS;
  const cap = Number(arg("--cap", argv)) || DEFAULT_CAP_USD;
  const only = arg("--fixture", argv);
  const outDir = arg("--out", argv) ?? OUT_DIR;
  const voiceArg = arg("--voice", argv);
  if (voiceArg && !VOICES.includes(voiceArg)) throw new Error(`--voice must be one of ${VOICES.join(", ")}`);
  const voice = voiceArg ?? STORYLINE_DEFAULT_VOICE;

  const geminiKey = process.env.GEMINI_API_KEY || null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || null;
  let client = null;
  if (anthropicKey) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  }
  const writers = writerIds.map((id) => resolveWriter(id, { client, geminiKey }));
  for (const w of writers) if (w.error) console.log(`writer ${w.id}: not run — ${w.error}`);

  // Production's checker, whatever the variables say today.
  const { plan } = modelPlan(process.env, { gemini: !!geminiKey, anthropic: !!anthropicKey });
  const checkerId = plan.checker;
  if (!checkerId) throw new Error("no checker model available (set ANTHROPIC_API_KEY or GEMINI_API_KEY)");
  const checker = resolveWriter(checkerId, { client, geminiKey });
  if (checker.error) throw new Error(`checker ${checkerId}: ${checker.error}`);
  checker.make = checkerId === "gemini"
    ? checker.make
    : () => {
        const tally = createTally();
        return { call: createAnthropicCaller(client, checkerId, { maxTokens: MAX_TOKENS.checker, tally, label: `checker (${checkerId})` }), tally };
      };

  const loaded = await loadInputs();
  const fixtures = upcomingFixtures(onlyFixture(loaded.fixtures, only), now, days);
  console.log(`storyline shadow: ${fixtures.length} fixture(s) in the next ${days} days; writers ${writerIds.join(", ")}; checker ${checkerId}${checkerId === "gemini" ? ` (${GEMINI_MODEL} ladder)` : ""}; voice ${voice}; cap US$${cap}`);

  const packs = [];
  for (const fixture of fixtures) {
    let extra = [];
    try {
      extra = await widenFixture(fixture);
    } catch (e) {
      console.log(`  ${fixture.home.code} v ${fixture.away.code}: search widener failed (${String(e.message).slice(0, 100)}); pool only`);
    }
    const pack = buildPack(fixture, { teamEvents: loaded.teamEvents, archive: loaded.archive, rankings: loaded.rankings, nations: loaded.nations, newsItems: [...loaded.pool, ...extra], now });
    let bodies = [];
    try {
      bodies = await fetchBodies(pack.news);
    } catch {
      // snippets alone are a fine pack
    }
    const packText = renderPack(pack, bodies);
    packs.push({ fixture, pack, packText });
    console.log(`  ${fixture.home.code} v ${fixture.away.code}: ${pack.news.length} news items (${pack.news.filter((n) => !n.background).length} current), ${bodies.length} article bodies, prompt ${packText.length} chars`);
  }

  const { results, skipped, spentUSD } = await runShadow({ packs, writers, checker, voice, cap });
  const usable = writers.filter((w) => !w.error);
  const totals = totalsOf(results, usable);
  const doc = {
    notice: NOTICE,
    startedAt: new Date(now).toISOString(),
    startedSydney: sydneyLabel(now),
    writers: usable.map((w) => ({ id: w.id, price: w.price })),
    checker: checkerId,
    voice,
    days,
    capUSD: cap,
    spentUSD,
    fixtures: packs.map(({ fixture, pack, packText }) => ({ id: fixture.id, ...packHashes(pack), pack: packRecord(pack, packText) })),
    results,
    skipped,
    totals,
  };
  await mkdir(outDir, { recursive: true });
  const stamp = sydneyStamp(now);
  await writeFile(join(outDir, `${stamp}.json`), JSON.stringify(doc, null, 1) + "\n");
  await writeFile(join(outDir, `${stamp}.md`), renderMarkdown(doc));
  console.log(`\nstoryline shadow: ${results.length} stories, US$${spentUSD.toFixed(4)} spent; written to ${join(outDir, stamp)}.{json,md}`);
  console.table(totals.map((t) => ({ writer: t.writer, stories: t.stories, passed: t.passed, firstTime: t.passedFirstTime, revised: t.revised, failed: t.failed, material1: t.materialIssuesFirstDraft, cost: `US$${t.costUSD.toFixed(3)}`, perStory: t.perStoryUSD == null ? "-" : `US$${t.perStoryUSD.toFixed(3)}`, secs: t.secondsPerStory })));
  return doc;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`storyline shadow failed: ${e.stack ?? e}`);
    process.exit(1);
  });
}
