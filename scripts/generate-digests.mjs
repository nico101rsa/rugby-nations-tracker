// Daily team-briefing generator: one Claude call per team (Sonnet + server-side
// web search), publishing a `digests` block into public/nations.json that the
// app's digestFor() prefers over the bundled fallback. Model + daily cadence are
// Nico's locked call (2026-07-10). Pure helpers are exported for node:test; the
// API call is isolated in generateOne() so everything else tests offline.
//
// Template source of truth: docs/news-digest-generation-prompt.md (private repo,
// v1 dry-run validated 2026-07-09). The public repo has no docs/, so the template
// is embedded here — keep the two in sync when the editorial rules change.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "nations.json");

const MODEL = process.env.DIGEST_MODEL || "claude-sonnet-5";
const TZ = "Australia/Sydney"; // editions are dated for the reader's day

// api-sports team id → names + masthead (mirrors src/teams.js + src/digest.js;
// duplicated because the public repo has no src/).
export const TEAMS = {
  386: { name: "England", masthead: "Rose Watch" },
  387: { name: "France", masthead: "Bleus Watch" },
  388: { name: "Ireland", masthead: "Shamrock Watch" },
  389: { name: "Italy", masthead: "Azzurri Watch" },
  390: { name: "Scotland", masthead: "Thistle Watch" },
  391: { name: "Wales", masthead: "Dragon Watch" },
  460: { name: "Argentina", masthead: "Puma Watch" },
  461: { name: "Australia", masthead: "Wallaby Watch" },
  463: { name: "Japan", masthead: "Blossom Watch" },
  465: { name: "New Zealand", masthead: "All Blacks Watch" },
  467: { name: "South Africa", masthead: "Bok Watch" },
  28: { name: "Fiji", masthead: "Flying Fijians Watch" },
};

export const KICKERS = ["Team news", "Injury desk", "The opposition", "The stakes"];

const TEMPLATE = `You write **{MASTHEAD}**, the daily {TEAM_NAME} briefing inside Rugby Nations
Tracker, an iOS app covering the 2026 Nations Championship. Your reader is a
knowledgeable {TEAM_NAME} fan who checks the app once a day. Today is
{DAY_NAME} {DATE_LONG}.

## App data (trusted — do not re-verify, do not contradict)

- Next fixture: {HOME_TEAM} v {AWAY_TEAM}, Round {ROUND}, kickoff {KICKOFF_ISO}.
- Log: {TEAM_NAME} are {RANK} of 12 — P{P} W{W} D{D} L{L}, PF {PF}, PA {PA}, PD {PD}.
- Last result: {LAST_RESULT}.
- The app renders the kickoff line (opponent, local time, countdown), the log
  table and fixtures from live data right next to your copy. **Never write
  kickoff times, kickoff dates or timezones into section bodies.**

## Process — fact sheet first

1. **Research before writing.** Web-search the team's current news: squad/team
   announcement, injuries and availability, coach quotes, the next opponent's
   news and form, notable player storylines. Build an internal fact sheet;
   every fact you intend to use must have a source you actually read today.
2. **Write only what the sheet supports, or softer.** Opinion-voice colour is
   fine ("a bench built for the final quarter"); factual claims must trace to
   the sheet. Expectations and rumours stay attributed ("Townsend expects…"),
   never asserted. No unverifiable superlatives ("biggest ever", "first on
   record") and no uncorroborated statistics (cap counts, streaks) — cut or
   soften anything you cannot source.
3. **Lead with the day's actual story.** Check what outlets covering this team
   led with today — if they led with a player's return, so do you, not the
   routine rotation count.

## Format — exactly four sections

| # | kicker | Job | Rules |
|---|---|---|---|
| 1 | Team news | The day's biggest team story | Announcement-day colour ("named on Monday") only on Mon/Tue editions |
| 2 | Injury desk | Who is out, pinned to the match | "ruled out of Saturday's Test" — match-specific, never season-vague. If genuinely nothing new, say what changed since yesterday or that the camp is clean |
| 3 | The opposition | Threat assessment of the next opponent | Mon–Thu: recent form is fine. **Fri onwards: lead with the opposition's named team if announced.** Include one forward-looking fact when available |
| 4 | The stakes | Log position + what the next result means | **Edition-relative phrasing** ("goes into the weekend top of the log"), because earlier kickoffs can move the live table while your copy is still up. Match-day editions: no absolute standings claims anywhere, headings included |

- Section bodies **50–70 words** (the closer may run short).
- **Skim test:** heading + first sentence of each section must deliver the
  story on their own. Headings carry information, not just attitude — at most
  one attitude-heading per edition.
- At most **one direct coach quote** per edition, verbatim and sourced.
- Register: knowing fan, dry, confident sports desk. Second reference to a
  well-known coach may be informal ("Rassie", "Razor") if that's how the
  team's press corps writes. No manufactured hype, no "mouth-watering clash".
- Re-read for name echoes across sentences (two different Gregors back-to-back
  reads like a glitch).

## Style

Words for one–nine and any heading/sentence-initial number; numerals for 10+;
numerals always for scores and splits ("45-21", "6-2"); "No. 1" fixed form.
Hyphen in scores; spaced em dash for asides. Terminal punctuation inside
quotes. Diacritics correct (Handré, Nché, Córdoba) — they are the easiest
thing to mangle.

## Output — strict JSON, nothing else

\`\`\`json
{
  "date": "{DATE_ISO}",
  "edition": "{DAY_NAME} {DAY_NUMBER} {MONTH}",
  "match": { "venue": "<venue, City — only if verified today>", "referee": "<name — only if verified today>" },
  "sections": [
    { "kicker": "Team news", "heading": "…", "body": "…" },
    { "kicker": "Injury desk", "heading": "…", "body": "…" },
    { "kicker": "The opposition", "heading": "…", "body": "…" },
    { "kicker": "The stakes", "heading": "…", "body": "…" }
  ]
}
\`\`\`

Omit \`venue\`/\`referee\` keys rather than guessing. Output no prose outside the
JSON object.`;

// ---- pure helpers -----------------------------------------------------------

// Sydney-local date parts for "today", independent of the runner's timezone
// (GitHub runners are UTC; a 20:00 UTC run is already the next AEST day).
function sydneyDateParts(now) {
  const get = (opts) => new Intl.DateTimeFormat("en-AU", { timeZone: TZ, ...opts }).format(now);
  const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return {
    DATE_ISO: iso,
    DAY_NAME: get({ weekday: "long" }),
    DAY_NUMBER: String(Number(get({ day: "numeric" }))),
    MONTH: get({ month: "long" }),
    DATE_LONG: `${Number(get({ day: "numeric" }))} ${get({ month: "long" })} ${get({ year: "numeric" })}`,
  };
}

// Earliest upcoming fixture for the team (2h in-play window, like src/digest.js).
function nextFixtureFor(fixtures, teamId, now) {
  const IN_PLAY_MS = 2 * 60 * 60 * 1000;
  return (Array.isArray(fixtures) ? fixtures : [])
    .filter((f) => f?.home?.id === teamId || f?.away?.id === teamId)
    .filter((f) => Date.parse(f.date) + IN_PLAY_MS > now.getTime())
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0] || null;
}

function lastResultFor(results, teamId) {
  const r = (Array.isArray(results) ? results : [])
    .filter((g) => g?.home?.id === teamId || g?.away?.id === teamId)
    .filter((g) => g?.status?.short === "FT")
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  if (!r) return "no completed match yet this season";
  const home = r.home.id === teamId;
  const us = home ? r.home : r.away;
  const them = home ? r.away : r.home;
  const verb = us.score > them.score ? "beat" : us.score < them.score ? "lost to" : "drew with";
  return `${verb} ${them.name} ${us.score}-${them.score} (Round ${r.week})`;
}

export function buildParams(data, teamId, now = new Date()) {
  const team = TEAMS[teamId];
  const fixture = nextFixtureFor(data?.fixtures, teamId, now);
  const row = (data?.log || []).find((l) => l.id === teamId) || {};
  const pd = row.PD ?? 0;
  return {
    ...sydneyDateParts(now),
    MASTHEAD: team.masthead,
    TEAM_NAME: team.name,
    HOME_TEAM: fixture?.home?.name ?? "TBC",
    AWAY_TEAM: fixture?.away?.name ?? "TBC",
    ROUND: fixture?.week ?? "TBC",
    KICKOFF_ISO: fixture?.date ?? "TBC",
    RANK: String(row.rank ?? "?"),
    P: String(row.P ?? 0), W: String(row.W ?? 0), D: String(row.D ?? 0), L: String(row.L ?? 0),
    PF: String(row.PF ?? 0), PA: String(row.PA ?? 0),
    PD: pd > 0 ? `+${pd}` : String(pd),
    LAST_RESULT: lastResultFor(data?.results, teamId),
  };
}

export function fillTemplate(template, params) {
  const out = template.replace(/\{([A-Z_]+)\}/g, (_, key) => {
    if (!(key in params)) throw new Error(`unfilled placeholder: ${key}`);
    return params[key];
  });
  return out;
}

// The prompt demands bare JSON, but tolerate a fence or stray prose around it.
export function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

// Shape gate before anything reaches the app: exactly today's date, the four
// kickers in order, sane word counts. Returns a *clean* object (unknown keys
// dropped) so the published JSON is exactly the shape digestFor() expects.
export function validateDigest(raw, { dateISO }) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not an object"] };
  if (raw.date !== dateISO) errors.push(`date ${raw.date} !== ${dateISO}`);
  if (typeof raw.edition !== "string" || !raw.edition.trim()) errors.push("missing edition");
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  if (sections.length !== KICKERS.length) errors.push(`expected 4 sections, got ${sections.length}`);
  else {
    sections.forEach((s, i) => {
      if (s?.kicker !== KICKERS[i]) errors.push(`section ${i} kicker "${s?.kicker}" !== "${KICKERS[i]}"`);
      if (typeof s?.heading !== "string" || !s.heading.trim()) errors.push(`section ${i} missing heading`);
      const n = typeof s?.body === "string" ? words(s.body) : 0;
      if (n < 20 || n > 100) errors.push(`section ${i} body ${n} words (want ~50-70)`);
    });
  }
  if (errors.length) return { ok: false, errors };
  const digest = {
    date: raw.date,
    edition: raw.edition.trim(),
    sections: sections.map((s) => ({ kicker: s.kicker, heading: s.heading.trim(), body: s.body.trim() })),
  };
  const match = {};
  if (typeof raw.match?.venue === "string" && raw.match.venue.trim()) match.venue = raw.match.venue.trim();
  if (typeof raw.match?.referee === "string" && raw.match.referee.trim()) match.referee = raw.match.referee.trim();
  if (Object.keys(match).length) digest.match = match;
  return { ok: true, digest, errors: [] };
}

// A team that failed today keeps yesterday's edition (its dated masthead makes
// the staleness visible) rather than falling back to the placeholder.
export function mergeDigests(existing = {}, generated = {}) {
  return { ...existing, ...generated };
}

// ---- API call ---------------------------------------------------------------

const MAX_CONTINUATIONS = 5; // pause_turn resumes (server-side web search loop)
const MAX_SEARCHES = 8; // per edition — cost cap; dry-runs used 5-8 searches

async function generateOne(client, data, teamId, now) {
  const params = buildParams(data, teamId, now);
  const prompt = fillTemplate(TEMPLATE, params);
  let messages = [{ role: "user", content: prompt }];
  let resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
    messages,
  });
  // Server-side tool loop can pause; re-send with the assistant turn appended
  // and the server resumes where it left off.
  for (let i = 0; resp.stop_reason === "pause_turn" && i < MAX_CONTINUATIONS; i++) {
    messages = [...messages, { role: "assistant", content: resp.content }];
    resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
      messages,
    });
  }
  if (resp.stop_reason === "refusal") throw new Error("refusal");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = extractJson(text);
  const { ok, digest, errors } = validateDigest(raw, { dateISO: params.DATE_ISO });
  if (!ok) throw new Error(`invalid edition: ${errors.join("; ")}`);
  return digest;
}

// ---- entrypoint --------------------------------------------------------------

export async function main({ dryRun = false } = {}) {
  const data = JSON.parse(await readFile(OUT, "utf8"));
  const now = new Date();

  if (dryRun) {
    // Plumbing check without an API call: print one filled prompt.
    console.log(fillTemplate(TEMPLATE, buildParams(data, 467, now)));
    return { dryRun: true };
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("ANTHROPIC_API_KEY not set — skipping digest generation");
    return { skipped: "no-key" };
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  const generated = {};
  const failed = [];
  for (const teamId of Object.keys(TEAMS).map(Number)) {
    try {
      generated[teamId] = await generateOne(client, data, teamId, now);
      console.log(`${TEAMS[teamId].name}: ok (${generated[teamId].edition})`);
    } catch (e) {
      failed.push(TEAMS[teamId].name);
      console.warn(`${TEAMS[teamId].name}: FAILED — ${e.message}`);
    }
  }

  if (Object.keys(generated).length === 0) {
    console.error("every edition failed — leaving nations.json untouched");
    process.exitCode = 1;
    return { failed };
  }

  // Re-read before writing: the refresh cron may have republished nations.json
  // during the ~minutes this run spent on 12 API calls.
  const fresh = JSON.parse(await readFile(OUT, "utf8"));
  fresh.digests = mergeDigests(fresh.digests, generated);
  fresh.counts = { ...(fresh.counts || {}), digests: Object.keys(fresh.digests).length };
  await writeFile(OUT, JSON.stringify(fresh, null, 2));
  console.log(`wrote ${Object.keys(generated).length}/12 editions${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`);
  return { generated: Object.keys(generated).length, failed };
}

// pathToFileURL, not `file://${argv[1]}` — paths with spaces percent-encode in
// import.meta.url and the naive comparison never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main({ dryRun: process.argv.includes("--dry-run") }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
