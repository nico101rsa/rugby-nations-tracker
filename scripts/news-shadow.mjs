// News shadow test: one week, writer step only, publishes nothing.
//
// Nico's call (4 Oct 2026, docs/GROWTH_STRATEGY.md in the app repo, "Decisions
// for Nico" no. 3): before paying for a news writer, run the paid model beside
// production for a week and compare. This is the cheapest honest version:
//
//   - SAME INPUT. The production run (generate-digests.mjs) records each team's
//     exact first-draft writer prompt (template, editor notes, "already
//     reported" block and the day's source pack) in the runner's temp
//     directory (buildWriterInputs). This replays that prompt. Nothing is
//     re-fetched, so both writers saw the same pack, word for word; the sha256
//     of each prompt goes in the record to prove it.
//   - WRITER ONLY. One call per team: no fact-check, no revision, no roundup.
//     The comparison is first draft against first draft (production's Gemini
//     first draft is recorded too), with production's published edition
//     alongside for reference.
//   - NOTHING PUBLISHED. Output goes to editorial/shadow/<date>.json and nowhere
//     else. nations.json is never opened for writing here, and the workflow
//     step commits only editorial/shadow/. The app never reads that folder,
//     but the repo is public and GitHub Pages serves all of it (.nojekyll, so
//     no path can be left out), so every record opens with SHADOW_NOTICE:
//     these drafts were never fact-checked.
//   - BOUNDED. Sydney dates SHADOW_FIRST_DATE..SHADOW_LAST_DATE only, then it
//     stops itself; one run per date (the first production run of that date);
//     a per-run cap and a whole-window cap on spend, checked BEFORE every
//     request against that request's worst case. Retries are made here, not in
//     the SDK (maxRetries: 0), so each attempt is reserved on its own. Output is
//     capped hard by max_tokens, so a cap can only be passed if a prompt beats
//     the CHARS_PER_TOKEN_FLOOR over-count of its input, and from then on the
//     guard plans on the dearest call so far.
//
// Model: the Sonnet entry in compare-digest-models.mjs (its prices feed the
// spend guard), unless the repository variable SHADOW_MODEL names another
// model that has a verified price there. A model with no price is refused.
//
// editorial/shadow/README.md says how the weekly review grades the result.
//
// Usage (generate-digests.yml runs the first two):
//   node scripts/news-shadow.mjs --preflight   decide; writes run=true|false to $GITHUB_OUTPUT
//   node scripts/news-shadow.mjs               run the shadow writer (needs @anthropic-ai/sdk)
//   node scripts/news-shadow.mjs --grade DATE  print the production rubric for both sets, blind
//   node scripts/news-shadow.mjs --key DATE    say which blind set was which
import { readFile, writeFile, mkdir, readdir, appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  extractJson, validateDigest, buildReviewPrompt, sha256, WRITER_INPUTS_FILE, writerInputsDir,
} from "./generate-digests.mjs";
import { MODELS, SONNET, estCost } from "./compare-digest-models.mjs";
import { words } from "./copy-rules.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The window: seven Sydney edition dates ending Mon 12 Oct 2026. It covers a
// match weekend (New Zealand v Australia, Sat 10 Oct). Hard-coded on purpose,
// with no override: the test must stop itself whether or not anyone remembers.
export const SHADOW_FIRST_DATE = "2026-10-06";
export const SHADOW_LAST_DATE = "2026-10-12";

// Spend caps in US$. The growth strategy's estimate for this writer (US$12-24
// a month) works out at roughly US$0.40-0.80 a run, a few cents a team; the
// caps are for the run that goes wrong, and measuring the real figure is half
// the point of the test. The window cap keeps the whole test under US$10 even
// if every run came close to its own cap.
export const RUN_CAP_USD = 1.5;
export const WINDOW_CAP_USD = 9;

// Output ceiling per call. A finished edition is ~400 tokens of JSON; the rest
// is headroom for the model's thinking, which counts against max_tokens and
// bills as output. 12000 is production's own figure for this model
// (generate-digests.mjs MAX_TOKENS: its first live Sonnet run, at 4000, ran out
// before the JSON on 10 of 12 teams). Any lower and a long-thinking team stops
// at max_tokens with no JSON, is paid for anyway, and scores as "invalid", which
// would skew the reliability half of the comparison against the paid writer.
// It also bounds the worst case the spend guard plans for (US$0.12 of output a
// call at US$10/M).
export const MAX_TOKENS = 12000;

// Per-request client timeout. A request that writes the full MAX_TOKENS
// (thinking included) can take a few minutes, and the 2 minutes used until
// 4 Oct 2026 was close enough to that to turn a long answer into a timeout and
// a retry. Non-streaming is fine at this size: the SDK only insists on
// streaming for a request it expects to take more than 10 minutes.
export const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

// Attempts per team: the first plus two retries, the SDK's own default, but
// made here so each one gets its own spend reservation. Only an attempt that
// had no answer (timeout, dropped connection) or a retryable HTTP status
// (408, 409, 429, 5xx: the SDK's list) is retried.
export const MAX_ATTEMPTS = 3;

// The guard's upper bound on input tokens. English prose runs at ~4 characters
// a token and this pack's URLs and diacritics at no fewer than ~2.5, so
// dividing by 2 over-counts: the worst case it plans for is never too low.
export const CHARS_PER_TOKEN_FLOOR = 2;

// Production inputs older than this are not "this run's" pack.
export const MAX_INPUT_AGE_HOURS = 18;

// Wall-clock budget for one run. No new call starts after this, so with the
// client's own per-call timeout the step ends well inside its 25 minutes.
export const TIME_BUDGET_MS = 15 * 60 * 1000;

export const SHADOW_DIR = join("editorial", "shadow");

// The first field of every record. These files are public (see the header).
export const SHADOW_NOTICE =
  "Internal comparison of two news writers, not news. These are unedited machine drafts that were never " +
  "fact-checked and never published: they may be wrong about real people. The app never reads this file.";

export function sydneyDate(now) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

// ISO dates compare correctly as strings.
export const inWindow = (dateISO) =>
  typeof dateISO === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateISO) &&
  dateISO >= SHADOW_FIRST_DATE && dateISO <= SHADOW_LAST_DATE;

// The model to shadow with, and its verified price. No price, no run: the
// spend guard cannot bound a call it cannot price.
export function resolveModel(override, models = MODELS, fallback = SONNET) {
  const id = String(override ?? "").trim() || fallback?.id;
  const price = models.find((m) => m.id === id) ?? null;
  return price
    ? { id, price, reason: null }
    : { id, price: null, reason: `no verified price for "${id}" in compare-digest-models.mjs MODELS, so the spend guard cannot bound it; not running` };
}

// The most one call can cost: every input token at the over-counted estimate,
// plus a full MAX_TOKENS of output.
export function worstCaseCallUSD(promptChars, price, maxTokens = MAX_TOKENS) {
  const inputTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN_FLOOR);
  return (inputTokens * price.in + maxTokens * price.out) / 1e6;
}

const usd = (x) => `US$${x.toFixed(2)}`;

// Checked before EVERY request, retries included. `spentRun` includes the worst
// case of any request whose cost is unknown (it got no answer, and may have
// been billed).
export function spendGuard({ spentRun, spentWindow, nextWorstCase, runCap = RUN_CAP_USD, windowCap = WINDOW_CAP_USD }) {
  if (spentRun + nextWorstCase > runCap) {
    return { ok: false, reason: `per-run cap: ${usd(spentRun)} spent this run + up to ${usd(nextWorstCase)} for the next call would pass ${usd(runCap)}` };
  }
  if (spentWindow + spentRun + nextWorstCase > windowCap) {
    return { ok: false, reason: `window cap: ${usd(spentWindow + spentRun)} spent in the window + up to ${usd(nextWorstCase)} for the next call would pass ${usd(windowCap)}` };
  }
  return { ok: true, reason: null };
}

// Pure: should this run shadow at all? The same answer drives --preflight and
// the run itself, so calling the script directly is guarded too.
export function decideShadow({ now, inputs, hasKey, alreadyShadowed = false, spentWindow = 0, model }) {
  const skip = (reason, level = "notice") => ({ run: false, reason, level });
  // The hard stop comes first: after the window nothing else matters.
  if (sydneyDate(now) > SHADOW_LAST_DATE) {
    return skip(`the news shadow window ended on ${SHADOW_LAST_DATE} (Sydney); nothing to do, and the shadow steps can be removed from generate-digests.yml`);
  }
  if (!hasKey) return skip("ANTHROPIC_API_KEY not set; skipped");
  if (!inputs) return skip("no writer inputs from this run (DIGEST_PROMPTS_DIR unset, or production ran without a source pack)");
  if (!inWindow(inputs.date)) {
    return skip(`edition date ${inputs.date ?? "(none)"} is outside the shadow window ${SHADOW_FIRST_DATE} to ${SHADOW_LAST_DATE}`);
  }
  const made = Date.parse(inputs.generatedAt);
  if (!Number.isFinite(made) || now.getTime() - made > MAX_INPUT_AGE_HOURS * 3600000 || made - now.getTime() > 3600000) {
    return skip(`writer inputs dated ${inputs.generatedAt ?? "(none)"} are not from this run`);
  }
  if (alreadyShadowed) return skip(`${inputs.date} is already shadowed (one run per Sydney date)`);
  if (!Array.isArray(inputs.teams) || !inputs.teams.length) return skip("writer inputs list no teams");
  if (!model?.price) return skip(model?.reason ?? "no model", "warning");
  if (spentWindow >= WINDOW_CAP_USD) return skip(`window spend ${usd(spentWindow)} has reached the ${usd(WINDOW_CAP_USD)} cap`);
  return { run: true, reason: `shadowing ${inputs.teams.length} team(s) for ${inputs.date} on ${model.id}`, level: "notice" };
}

// ---- files -----------------------------------------------------------------------

export const shadowPath = (root, dateISO) => join(root, SHADOW_DIR, `${dateISO}.json`);

// Total recorded spend across the window's shadow files.
export async function windowSpend(root = ROOT) {
  let names = [];
  try {
    names = (await readdir(join(root, SHADOW_DIR))).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    try {
      const rec = JSON.parse(await readFile(join(root, SHADOW_DIR, name), "utf8"));
      total += Number(rec?.cost?.runUSD) || 0;
      total += Number(rec?.cost?.unaccountedUSD) || 0;
    } catch {
      // An unreadable record counts as a full run, so the window cap stays a cap.
      total += RUN_CAP_USD;
    }
  }
  return total;
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Has another run already committed this date's record? The checkout can be
// older than origin: a scheduled run queued behind a running one (the digests
// concurrency group) was checked out at the commit it was queued on, before
// that run's shadow commit. The workflow fetches origin/main first; any git
// failure reads as "no", and the working-tree check still applies.
async function shadowedUpstream(dateISO, root) {
  try {
    await promisify(execFile)("git", ["cat-file", "-e", `origin/main:editorial/shadow/${dateISO}.json`], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

export async function readWriterInputs(env = process.env, root = ROOT) {
  const { dir } = writerInputsDir(env.DIGEST_PROMPTS_DIR, root);
  if (!dir) return null;
  try {
    return JSON.parse(await readFile(join(dir, WRITER_INPUTS_FILE), "utf8"));
  } catch {
    return null;
  }
}

// ---- the run ---------------------------------------------------------------------

// The format contract is a 10-12 word heading and a 55-90 word body.
const draftWords = (d) => {
  const s = d?.sections?.[0];
  return s ? { heading: words(s.heading ?? ""), body: words(s.body ?? "") } : null;
};

async function callWriter(client, model, prompt) {
  const t0 = Date.now();
  // Same request shape as compare-digest-models.mjs: the prompt as one user
  // turn, the model's default thinking, no tools (production's writer has no
  // web access either: the pack is its only source).
  const resp = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });
  const u = resp.usage ?? {};
  return {
    text: (resp.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n"),
    stopReason: resp.stop_reason ?? null,
    usage: {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
    seconds: Math.round((Date.now() - t0) / 100) / 10,
  };
}

// A rejected key or an unknown model fails every call the same way: stop
// rather than spend the run proving it.
const isFatal = (err) => [400, 401, 403, 404].includes(err?.status);

// An HTTP status means the API answered, and an error answer is not billed.
// No status means no answer (timeout, dropped connection), which may have been.
const answered = (err) => Number.isInteger(err?.status);

// The SDK's own retry list: no answer at all, or 408, 409, 429 and 5xx.
export const isRetryable = (err) => !answered(err) || [408, 409, 429].includes(err.status) || err.status >= 500;

// Honour a retry-after header (seconds) up to 30s; otherwise 2s, then 8s.
export function retryDelayMs(err, attempt) {
  const header = err?.headers?.get?.("retry-after") ?? err?.headers?.["retry-after"];
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, 30000);
  return attempt <= 1 ? 2000 : 8000;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs the writer for every team in `inputs`, writes editorial/shadow/<date>.json
// under `root`, and returns the record. Writes nothing else.
// The record is rewritten before and after every request, so a step killed
// part-way still leaves what it may have spent on disk for the commit step
// (and the window cap).
//
// Every attempt, retries included, passes the time budget and the spend guard
// and reserves its own worst case first. A team that gets no answer at all on
// every attempt stops the run: that is the connection, not the team, and each
// such attempt keeps its worst case on the books.
export async function runShadow({
  root = ROOT, inputs, client, model, now = new Date(), log = console.log, spentWindow = null,
  clock = Date.now, timeBudgetMs = TIME_BUDGET_MS, sleep = realSleep, maxAttempts = MAX_ATTEMPTS,
}) {
  const window = spentWindow ?? (await windowSpend(root));
  const started = clock();
  let spentRun = 0; // known cost of answered calls
  let unaccounted = 0; // worst case of the request in flight, and of any that got no answer
  let aborted = null;
  let dearest = 0; // the most any answered call has cost this run
  const teams = [];
  const out = shadowPath(root, inputs.date);
  await mkdir(dirname(out), { recursive: true });
  const save = async () => {
    const record = buildRecord({ inputs, model, now, teams, spentRun, unaccounted, window, aborted });
    await writeFile(out, JSON.stringify(record, null, 1) + "\n");
    return record;
  };
  const round = (x) => Math.round(x * 1e5) / 1e5;

  for (const t of inputs.teams) {
    const base = {
      teamId: t.teamId,
      team: t.team,
      promptSha256: sha256(t.prompt),
      promptMatchesProduction: sha256(t.prompt) === t.promptSha256,
      promptChars: t.prompt.length,
      quiet: Boolean(t.quiet),
      rung: t.ladder?.rung ?? "news",
      ladder: t.ladder ?? null,
      shortlist: t.shortlist ?? [],
      production: t.production ?? null,
    };
    const failures = []; // this team's failed attempts, oldest first
    let unanswered = 0; // worst cases this team left on the books
    let reply = null;
    for (let attempt = 1; attempt <= maxAttempts && !aborted; attempt++) {
      if (clock() - started > timeBudgetMs) {
        aborted = `time budget: ${Math.round(timeBudgetMs / 60000)} minutes used`;
        break;
      }
      // The planned worst case, or the dearest call so far if that was more:
      // should the estimate ever be beaten, the guard learns rather than trusts it.
      const worst = Math.max(worstCaseCallUSD(t.prompt.length, model.price), dearest);
      const guard = spendGuard({ spentRun: spentRun + unaccounted, spentWindow: window, nextWorstCase: worst });
      if (!guard.ok) {
        aborted = `spend guard: ${guard.reason}`;
        log(`${t.team}: ${attempt === 1 ? "SKIPPED" : `no retry ${attempt}`}, ${aborted}`);
        break;
      }
      // Reserve the attempt's worst case on disk before making it: if the step
      // is killed mid-request, the record still carries what it may have cost.
      unaccounted += worst;
      teams.push({ ...base, shadow: { pending: true, attempt, costUpperBoundUSD: round(worst), ...(failures.length ? { failedAttempts: failures } : {}) } });
      await save();
      teams.pop();
      try {
        const r = await callWriter(client, model.id, t.prompt);
        const costUSD = estCost(model.price, r.usage);
        unaccounted -= worst;
        spentRun += costUSD;
        dearest = Math.max(dearest, costUSD);
        reply = { ...r, costUSD, attempt };
        break;
      } catch (err) {
        // An answer with an HTTP status is not billed, so its reservation is
        // released. A timeout or a dropped connection may have been billed, so
        // its worst case stays in `unaccounted`, which both caps count.
        const message = String(err?.message ?? err).slice(0, 300);
        if (answered(err)) unaccounted -= worst;
        else unanswered += worst;
        failures.push({ attempt, status: err?.status ?? null, error: message, ...(answered(err) ? {} : { costUpperBoundUSD: round(worst) }) });
        log(`${t.team}: attempt ${attempt} ERROR ${err?.status ?? ""} ${message}`);
        if (isFatal(err)) {
          aborted = `stopped after HTTP ${err.status}: ${message.slice(0, 120)}`;
          break;
        }
        if (!isRetryable(err)) break;
        if (attempt < maxAttempts) await sleep(retryDelayMs(err, attempt));
      }
    }

    if (reply) {
      const raw = extractJson(reply.text);
      const date = t.date ?? inputs.date;
      const v = raw ? validateDigest(raw, { dateISO: date }) : { ok: false, errors: ["no JSON object in the reply"] };
      const prodLead = t.production?.firstDraft?.lead?.candidate ?? null;
      const shadowLead = v.ok ? v.digest.lead?.candidate ?? null : null;
      teams.push({
        ...base,
        shadow: {
          draft: v.ok ? v.digest : null,
          valid: v.ok,
          errors: v.ok ? [] : v.errors,
          ...(v.ok ? {} : { rawTail: reply.text.slice(-1500) }),
          stopReason: reply.stopReason,
          words: v.ok ? draftWords(v.digest) : null,
          sameLeadAsProductionFirstDraft: prodLead != null && shadowLead != null ? prodLead === shadowLead : null,
          usage: reply.usage,
          costUSD: round(reply.costUSD),
          seconds: reply.seconds,
          attempts: reply.attempt,
          ...(failures.length ? { failedAttempts: failures } : {}),
          // On top of costUSD: what the unanswered attempts before it may have cost.
          ...(unanswered ? { unansweredUpperBoundUSD: round(unanswered) } : {}),
        },
      });
      log(`${t.team}: ${v.ok ? "valid" : `INVALID (${(v.errors ?? []).join("; ").slice(0, 160)})`}, in=${reply.usage.input} out=${reply.usage.output}, ${usd(reply.costUSD)}, ${reply.seconds}s, stop=${reply.stopReason}${reply.attempt > 1 ? `, attempt ${reply.attempt}` : ""}`);
    } else if (failures.length) {
      const last = failures[failures.length - 1];
      teams.push({
        ...base,
        shadow: {
          error: last.error,
          status: last.status,
          attempts: failures.length,
          failedAttempts: failures,
          ...(unanswered ? { costUpperBoundUSD: round(unanswered) } : {}),
          // A retry the time budget or the spend guard refused.
          ...(aborted && !isFatal(last) ? { retryRefused: aborted } : {}),
        },
      });
      if (!aborted && failures.length >= maxAttempts && failures.every((f) => f.status == null)) {
        aborted = `no answer from the API on ${failures.length} attempts in a row (timeout or dropped connection); stopping so their worst cases do not eat the window cap`;
      }
    } else {
      teams.push({ ...base, shadow: { skipped: aborted } });
    }
    await save();
  }
  return save();
}

function buildRecord({ inputs, model, now, teams, spentRun, unaccounted, window, aborted }) {
  const shadowed = teams.filter((x) => x.shadow?.usage);
  return {
    kind: "news-shadow-test",
    notice: SHADOW_NOTICE,
    date: inputs.date,
    publishes: false,
    window: { first: SHADOW_FIRST_DATE, last: SHADOW_LAST_DATE },
    production: { provider: inputs.provider ?? null, servedBy: inputs.servedBy ?? null, generatedAt: inputs.generatedAt ?? null },
    shadow: {
      model: model.id,
      pricesUSDPerMTok: { input: model.price.in, output: model.price.out },
      maxTokens: MAX_TOKENS,
      maxAttempts: MAX_ATTEMPTS,
      ranAt: now.toISOString(),
    },
    counts: {
      teams: teams.length,
      valid: teams.filter((x) => x.shadow?.valid).length,
      invalid: teams.filter((x) => x.shadow?.valid === false).length,
      errors: teams.filter((x) => x.shadow?.error).length,
      skipped: teams.filter((x) => x.shadow?.skipped).length,
      // Non-zero only in a record left by a step killed mid-call.
      pending: teams.filter((x) => x.shadow?.pending).length,
      productionFailed: teams.filter((x) => x.production?.failed).length,
      // Teams production could not publish today where the shadow writer
      // produced a valid draft: the reliability half of the question.
      shadowValidWhereProductionFailed: teams.filter((x) => x.production?.failed && x.shadow?.valid).length,
    },
    usage: {
      input: shadowed.reduce((n, x) => n + x.shadow.usage.input, 0),
      output: shadowed.reduce((n, x) => n + x.shadow.usage.output, 0),
    },
    cost: {
      runUSD: Math.round(spentRun * 1e5) / 1e5,
      unaccountedUSD: Math.round(unaccounted * 1e5) / 1e5,
      windowBeforeUSD: Math.round(window * 1e5) / 1e5,
      windowAfterUSD: Math.round((window + spentRun + unaccounted) * 1e5) / 1e5,
      perTeamUSD: shadowed.length ? Math.round((spentRun / shadowed.length) * 1e5) / 1e5 : null,
      runCapUSD: RUN_CAP_USD,
      windowCapUSD: WINDOW_CAP_USD,
    },
    aborted,
    complete: teams.length === (inputs.teams ?? []).length,
    teams,
  };
}

// ---- grading (for the weekly review) -----------------------------------------------
//
// The daily editorial review's own rubric (buildReviewPrompt), applied to both
// writers' first drafts. The sets are labelled X and Y, assigned from the date
// so the label says nothing about the writer; --key reveals it.

export function blindKey(dateISO) {
  return parseInt(sha256(`shadow:${dateISO}`).slice(0, 2), 16) % 2 === 0
    ? { X: "production", Y: "shadow" }
    : { X: "shadow", Y: "production" };
}

export function gradingPrompts(record) {
  const key = blindKey(record.date);
  const draftOf = (t, side) => (side === "production" ? t.production?.firstDraft : t.shadow?.draft) ?? null;
  const set = (side) => {
    const editions = [];
    const missing = [];
    for (const t of record.teams ?? []) {
      const digest = draftOf(t, side);
      if (!digest) {
        missing.push(t.team);
        continue;
      }
      editions.push({ team: t.team, digest, shortlist: t.shortlist ?? [], quiet: Boolean(t.quiet), ladder: t.ladder ?? null });
    }
    return { prompt: buildReviewPrompt(editions, record.date), missing, count: editions.length };
  };
  return { key, X: set(key.X), Y: set(key.Y) };
}

// ---- entrypoint --------------------------------------------------------------------

async function decide(now, env = process.env, root = ROOT) {
  const inputs = await readWriterInputs(env, root);
  const model = resolveModel(env.SHADOW_MODEL);
  const decision = decideShadow({
    now,
    inputs,
    hasKey: Boolean(env.ANTHROPIC_API_KEY),
    alreadyShadowed: inputs?.date
      ? (await exists(shadowPath(root, inputs.date))) || (await shadowedUpstream(inputs.date, root))
      : false,
    spentWindow: await windowSpend(root),
    model,
  });
  return { inputs, model, decision };
}

async function main(argv = process.argv.slice(2)) {
  const now = new Date();
  const mode = argv[0] ?? "";

  if (mode === "--grade" || mode === "--key") {
    const date = argv[1];
    if (!date) throw new Error(`${mode} needs a date, e.g. ${mode} ${SHADOW_FIRST_DATE}`);
    const record = JSON.parse(await readFile(shadowPath(ROOT, date), "utf8"));
    const g = gradingPrompts(record);
    if (mode === "--key") {
      console.log(`${date}: X = ${g.key.X}, Y = ${g.key.Y}`);
      return;
    }
    for (const label of ["X", "Y"]) {
      console.log(`\n${"=".repeat(70)}\n== SET ${label}: ${g[label].count} edition(s)${g[label].missing.length ? `; no draft for ${g[label].missing.join(", ")}` : ""}\n${"=".repeat(70)}\n`);
      console.log(g[label].prompt);
    }
    console.log(`\nGrade both sets before running: node scripts/news-shadow.mjs --key ${date}`);
    return;
  }

  const { inputs, model, decision } = await decide(now);
  const say = `::${decision.level}::news shadow test: ${decision.reason}`;
  if (mode === "--preflight") {
    console.log(say);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
    return;
  }
  if (!decision.run) {
    console.log(say);
    return;
  }
  console.log(decision.reason);
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // No SDK retries: runShadow retries itself, so that every attempt passes the
  // spend guard and reserves its own worst case. No new request starts after
  // TIME_BUDGET_MS, and one in flight ends by REQUEST_TIMEOUT_MS, so the step
  // ends inside ~20 of its 25 minutes.
  const client = new Anthropic({ maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  const record = await runShadow({ inputs, client, model, now });
  console.log(
    `shadow ${record.date}: ${record.counts.valid}/${record.counts.teams} valid, ${record.counts.errors} error(s), ${record.counts.skipped} skipped; ` +
      `${usd(record.cost.runUSD)} this run (${record.cost.perTeamUSD == null ? "n/a" : usd(record.cost.perTeamUSD)} a team), ` +
      `${usd(record.cost.windowAfterUSD)} of ${usd(WINDOW_CAP_USD)} in the window` +
      (record.aborted ? `; ABORTED: ${record.aborted}` : ""),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
