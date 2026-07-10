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

// Copy defects a cheaper model is prone to: leaked citation markup, and clock
// times/timezones in the copy (the app renders kickoff lines itself). Scores
// like "45-21" have no colon, so they pass.
export const BANNED_COPY = [
  [/<\/?cite/i, "citation markup"],
  [/\b\d{1,2}:\d{2}\b/, "clock time"],
  [/\b(AEST|AEDT|SAST|GMT|BST|UTC|CET|CEST)\b/, "timezone"],
];

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
      for (const [re, label] of BANNED_COPY) {
        const copy = `${s?.heading ?? ""} ${s?.body ?? ""}`;
        if (re.test(copy)) errors.push(`section ${i} contains ${label}`);
      }
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
// Cost cap. 8 was the launch value; the first live run (2026-07-10) showed the
// search-result context compounds quadratically with each extra search — 4 is
// plenty for a daily briefing and cuts token spend by well over half.
const MAX_SEARCHES = 4;
// Sonnet 5 runs adaptive thinking by default and it counts against max_tokens.
// The first live run had this at 4000: 10/12 teams exhausted it mid-research
// (stop_reason max_tokens) and never emitted the JSON. 12000 leaves room for
// thinking across the whole search loop; actual JSON output is <1k tokens.
const MAX_TOKENS = 12000;

async function generateOne(client, data, teamId, now) {
  const params = buildParams(data, teamId, now);
  const prompt = fillTemplate(TEMPLATE, params);
  const request = (messages) =>
    client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // Auto-cache the last cacheable block: pause_turn continuations then
      // re-read the accumulated prefix (prompt + search results) at ~0.1x
      // instead of full input price.
      cache_control: { type: "ephemeral" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: MAX_SEARCHES }],
      messages,
    });
  let messages = [{ role: "user", content: prompt }];
  let resp = await request(messages);
  // Server-side tool loop can pause; re-send with the assistant turn appended
  // and the server resumes where it left off.
  for (let i = 0; resp.stop_reason === "pause_turn" && i < MAX_CONTINUATIONS; i++) {
    messages = [...messages, { role: "assistant", content: resp.content }];
    resp = await request(messages);
  }
  if (resp.stop_reason === "refusal") throw new Error("refusal");
  const text = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const raw = extractJson(text);
  const { ok, digest, errors } = validateDigest(raw, { dateISO: params.DATE_ISO });
  if (!ok) {
    // Diagnosable failures: stop_reason distinguishes truncation (max_tokens)
    // from a malformed answer; the text tail shows what the model last wrote.
    const tail = text.slice(-200).replace(/\s+/g, " ");
    throw new Error(`invalid edition (stop=${resp.stop_reason}): ${errors.join("; ")} | tail: …${tail}`);
  }
  return digest;
}

// ---- source pack (free news retrieval) ---------------------------------------
//
// Model-side web search is a paid feature on both vendors (it sank the Sonnet
// budget, and Gemini's grounding is paid-tier for new accounts). So the news
// comes to the model instead: Bing News RSS (free, direct publisher links,
// no key) plus the top article bodies. This also fixes the 2026-07-10 "no team
// announced" failure mode — the model can't miss an announcement that's in its
// prompt, and the fact-checker rejects claims that go beyond the pack.

const NEWS_ITEMS = 12; // headlines + snippets per team
const NEWS_ARTICLES = 5; // full article bodies fetched (most recent first)
const ARTICLE_CHARS = 3000; // per-article cap keeps the prompt ~15-20K tokens

export function parseRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const g = (tag) => (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] ?? "";
    const strip = (s) =>
      s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&")
        .replace(/&#8216;|&#8217;|&apos;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"')
        .replace(/&#8211;|&#8212;/g, "–").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    return { title: strip(g("title")), link: strip(g("link")), desc: strip(g("description")), date: g("pubDate") };
  }).filter((i) => i.title && i.link);
}

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#8216;|&#8217;|&apos;/g, "'").replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&nbsp;/g, " ").replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

async function fetchWithTimeout(url, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { headers: UA, redirect: "follow", signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function fetchTeamNews(teamName, opponentName) {
  const q = encodeURIComponent(`${teamName} rugby ${opponentName && opponentName !== "TBC" ? opponentName : "team news"}`);
  const res = await fetchWithTimeout(`https://www.bing.com/news/search?q=${q}&format=rss`);
  if (!res.ok) throw new Error(`news rss ${res.status}`);
  const items = parseRss(await res.text()).slice(0, NEWS_ITEMS);

  const articles = [];
  for (const item of items.slice(0, NEWS_ARTICLES)) {
    try {
      const a = await fetchWithTimeout(item.link);
      if (!a.ok) continue;
      const text = htmlToText(await a.text());
      if (text.length > 400) articles.push({ title: item.title, url: a.url, text: text.slice(0, ARTICLE_CHARS) });
    } catch {
      // paywalled/slow publishers just drop out of the pack
    }
  }

  const lines = items.map((i, n) => `${n + 1}. [${i.date}] ${i.title}${i.desc ? ` — ${i.desc}` : ""}`);
  const bodies = articles.map((a, n) => `### Article ${n + 1}: ${a.title}\n(${a.url})\n${a.text}`);
  const pack = `## Source pack — today's coverage (your ONLY factual sources)

You have no web access. The headlines and articles below are your entire fact
sheet — they replace the research step. Every factual claim in your edition
must trace to this pack or to the trusted app data. If the pack doesn't cover
something (e.g. no team announcement yet), say so honestly rather than
guessing; never invent or assume "no news".

Quotes: quotation marks are a verbatim contract — only use words that appear
inside quotation marks in the pack, character for character. If the pack only
paraphrases what someone said, paraphrase too, without quote marks.

When the pack is silent on a topic the format requires (usually the injury
desk), attribute the silence to the coverage — "no fresh injury news in
today's coverage" — never to reality ("the camp is clean", "everyone is
available"): you know what was reported, not what is true in camp.

### Headlines
${lines.join("\n")}

${bodies.join("\n\n")}`;
  return { pack, headlineCount: items.length, articleCount: articles.length };
}

// ---- Gemini provider (free tier) ----------------------------------------------
//
// Flash is cheaper than Sonnet but sloppier, so every edition passes a second
// fact-check call (fresh context, same source pack) before it's accepted, with
// one bounded revision loop. Worst case 4 calls/team = 48/day, well inside the
// free quota; a ~7s pause between calls respects the free-tier RPM cap.

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const GEMINI_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const GEMINI_PAUSE_MS = 7000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free-tier traffic is shed first under load (503) and rate-limited hard
// (429). Retry with backoff, then fall back down the flash family — a sibling
// model beats a failed edition.
const GEMINI_FALLBACKS = [GEMINI_MODEL, "gemini-3-flash-preview", "gemini-3.1-flash-lite"];
// Sticky start index: once a model serves a request, later calls skip straight
// to it instead of re-burning the retry ladder on a throttled sibling.
let geminiStickyIdx = 0;

async function geminiCall(apiKey, prompt) {
  const waits = [15000, 45000];
  let lastErr;
  for (let mi = geminiStickyIdx; mi < GEMINI_FALLBACKS.length; mi++) {
    const model = GEMINI_FALLBACKS[mi];
    for (let attempt = 0; attempt <= waits.length; attempt++) {
      await sleep(GEMINI_PAUSE_MS);
      const res = await fetch(GEMINI_URL(model), {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] }),
      });
      if (res.ok) {
        geminiStickyIdx = mi;
        const body = await res.json();
        return (body.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n");
      }
      lastErr = new Error(`gemini(${model}) ${res.status}: ${(await res.text()).slice(0, 200)}`);
      if (res.status !== 429 && res.status !== 503) throw lastErr;
      if (attempt < waits.length) {
        console.warn(`  gemini(${model}) ${res.status}, retrying in ${waits[attempt] / 1000}s`);
        await sleep(waits[attempt]);
      }
    }
    console.warn(`  ${model} exhausted, trying next model`);
  }
  throw lastErr;
}

// The checker gets the same trusted data and source pack the writer had, in a
// fresh context — its job is to catch claims the pack doesn't actually support.
export function buildFactCheckPrompt(params, digest, sourcePack) {
  return `You are the fact-checker for **${params.MASTHEAD}**, a daily ${params.TEAM_NAME}
rugby briefing. Today is ${params.DAY_NAME} ${params.DATE_LONG}. Below is a draft edition.

## Trusted app data (the draft must not contradict this)
- Next fixture: ${params.HOME_TEAM} v ${params.AWAY_TEAM}, Round ${params.ROUND}.
- Log: ${params.TEAM_NAME} are ${params.RANK} of 12 — P${params.P} W${params.W} D${params.D} L${params.L}, PF ${params.PF}, PA ${params.PA}, PD ${params.PD}.
- Last result: ${params.LAST_RESULT}.

${sourcePack}

## Draft edition
${JSON.stringify(digest, null, 2)}

## Your job
Check every factual claim in the draft against the source pack and trusted
data above. **Only material errors fail an edition** — a reader must be
misinformed for you to flag it. Material errors:
- an invented fact: a claim (selection, injury, result, record, milestone)
  nothing in the pack supports, or that a source contradicts;
- a wrong number, score, name or attribution (check against trusted data);
- words inside quotation marks that are not character-for-character in the
  pack (an accurate paraphrase WITHOUT quote marks is fine and never an issue);
- a rumour or expectation asserted as settled fact;
- stale news presented as this week's development.

Do NOT flag — these are never issues:
- honest absence statements attributed to the coverage ("no fresh injury news
  in today's coverage") when the pack is indeed silent on the topic;
- accurate paraphrase, compression or reordering of source prose;
- tense/deixis adjustments ("this weekend" rendered as "today" when the dates
  agree), synonyms, or stylistic word choices;
- opinion, colour and tactical reading;
- anything you would describe as "technically true but could be phrased
  closer to the source".

## Output — strict JSON, nothing else
{"verdict": "pass" | "fail", "issues": [{"kicker": "<section kicker>", "claim": "<the claim>", "problem": "<what is wrong>", "fix": "<corrected wording, or 'cut'>"}]}
List ONLY material errors in issues. "fail" only if issues is non-empty; if
you find yourself writing "however, this is supported" or "while not strictly
false", the claim passes — delete it from issues.`;
}

export function parseVerdict(raw) {
  if (!raw || typeof raw !== "object") return { verdict: "fail", issues: [{ problem: "checker returned no JSON" }] };
  const verdict = raw.verdict === "pass" ? "pass" : "fail";
  const issues = Array.isArray(raw.issues) ? raw.issues.filter((i) => i && typeof i === "object") : [];
  return { verdict, issues };
}

export async function generateOneGemini(apiKey, data, teamId, now, editorNotes) {
  const params = buildParams(data, teamId, now);
  const opponent = params.HOME_TEAM === params.TEAM_NAME ? params.AWAY_TEAM : params.HOME_TEAM;
  const { pack, headlineCount, articleCount } = await fetchTeamNews(params.TEAM_NAME, opponent);
  const notesBlock = editorNotes
    ? `\n\n## Standing editor notes (distilled from previous editions' reviews — follow them)\n${editorNotes}`
    : "";
  const prompt = `${fillTemplate(TEMPLATE, params)}${notesBlock}\n\n${pack}`;

  const draft = async (feedback) => {
    const text = await geminiCall(apiKey, feedback ? `${prompt}\n\n${feedback}` : prompt);
    const raw = extractJson(text);
    const { ok, digest, errors } = validateDigest(raw, { dateISO: params.DATE_ISO });
    if (!ok) throw new Error(`invalid edition: ${errors.join("; ")} | tail: …${text.slice(-200).replace(/\s+/g, " ")}`);
    return digest;
  };

  const MAX_REVISIONS = 2;
  let digest = await draft();
  let check = parseVerdict(extractJson(await geminiCall(apiKey, buildFactCheckPrompt(params, digest, pack))));
  let revisions = 0;

  while (check.verdict !== "pass" && revisions < MAX_REVISIONS) {
    revisions++;
    const issueList = check.issues
      .map((i) => `- [${i.kicker ?? "?"}] ${i.claim ?? ""}: ${i.problem ?? ""} → ${i.fix ?? "cut"}`)
      .join("\n");
    const feedback = `## Fact-check failures in your previous draft — fix all of these
${issueList}
Rewrite the full edition. Drop or soften any claim the source pack does not
support. If a quote was flagged, either use the exact verbatim wording the
fact-checker cites or remove the quotation marks and paraphrase — do not
re-word a quote a third way. Output the complete JSON again.`;
    digest = await draft(feedback);
    check = parseVerdict(extractJson(await geminiCall(apiKey, buildFactCheckPrompt(params, digest, pack))));
  }
  if (check.verdict !== "pass") {
    const remaining = check.issues.map((i) => i.problem).join("; ");
    throw new Error(`fact-check failed after ${revisions} revisions: ${remaining}`);
  }

  return { digest, pack, note: `${headlineCount} headlines, ${articleCount} articles, fact-checked${revisions ? ` after ${revisions} revision(s)` : ""}` };
}

// ---- post-run editorial review -------------------------------------------------
//
// After the day's editions are written, one review call grades the batch on
// facts, quality and sourcing, and may propose up to 2 standing notes for the
// writer prompt. Notes accumulate in editorial/editor-notes.md (newest first,
// capped) so the prompt tunes itself gradually and every change is in git.

const NOTES_FILE = join(ROOT, "editorial", "editor-notes.md");
const REVIEWS_DIR = join(ROOT, "editorial", "reviews");
const MAX_NOTES = 8;

export function buildReviewPrompt(editions, dateISO) {
  const blocks = editions.map(({ team, digest }) => `### ${team}\n${JSON.stringify(digest, null, 1)}`);
  return `You are the reviewing editor for a suite of daily rugby team briefings
(2026 Nations Championship). Below are today's published editions (${dateISO}).
Each was written from a per-team pack of same-day news and fact-checked.

${blocks.join("\n\n")}

## Review criteria
1. **Facts**: internal contradictions between editions (two teams describing
   the same match differently), impossible claims, hedges masquerading as facts.
2. **Quality**: flat or repetitive headings, filler sentences, manufactured
   hype, name echoes, sections that fail the skim test (heading + first
   sentence must carry the story).
3. **Sources**: over-reliance on one storyline, claims that read as invented
   colour rather than reported fact, missing attribution on quotes.

## Output — strict JSON, nothing else
{
  "report": "<markdown, max 300 words: today's grade (A-F), the 2-3 most important observations, one example each>",
  "prompt_notes": ["<up to 2 short imperative notes for the WRITER prompt that would prevent today's recurring defects, e.g. 'Vary heading verbs across sections — three of four editions led with =names=', or empty array if nothing systematic>"]
}
Only propose a prompt note for a defect visible in MULTIPLE editions today;
one-off slips don't earn a standing rule.`;
}

async function reviewRun(apiKey, editions, dateISO) {
  const raw = extractJson(await geminiCall(apiKey, buildReviewPrompt(editions, dateISO)));
  if (!raw || typeof raw.report !== "string") throw new Error("review returned no usable JSON");
  const notes = (Array.isArray(raw.prompt_notes) ? raw.prompt_notes : [])
    .filter((n) => typeof n === "string" && n.trim())
    .slice(0, 2);

  const { mkdir } = await import("node:fs/promises");
  await mkdir(REVIEWS_DIR, { recursive: true });
  await writeFile(join(REVIEWS_DIR, `${dateISO}.md`), `# Digest review — ${dateISO}\n\n${raw.report}\n`);

  if (notes.length) {
    let existing = [];
    try {
      existing = (await readFile(NOTES_FILE, "utf8")).split("\n").filter((l) => l.startsWith("- "));
    } catch {
      // first run: no notes file yet
    }
    const merged = [...notes.map((n) => `- ${n.trim()} _(added ${dateISO})_`), ...existing].slice(0, MAX_NOTES);
    await writeFile(NOTES_FILE, `# Standing editor notes\n\nInjected into the writer prompt daily; curated by the post-run review. Prune freely.\n\n${merged.join("\n")}\n`);
  }
  return { notes };
}

async function loadEditorNotes() {
  try {
    return (await readFile(NOTES_FILE, "utf8")).split("\n").filter((l) => l.startsWith("- ")).join("\n");
  } catch {
    return "";
  }
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

  // Provider: Gemini Flash (free tier, fact-checked) when GEMINI_API_KEY is
  // set; Claude Sonnet as the fallback path; skip cleanly when neither key is.
  const geminiKey = process.env.GEMINI_API_KEY;
  let generateFor;
  if (geminiKey) {
    console.log(`provider: gemini (${GEMINI_MODEL}, RSS source pack + fact-check pass)`);
    const editorNotes = await loadEditorNotes();
    if (editorNotes) console.log(`standing editor notes:\n${editorNotes}`);
    generateFor = (teamId) => generateOneGemini(geminiKey, data, teamId, now, editorNotes);
  } else if (process.env.ANTHROPIC_API_KEY) {
    console.log(`provider: anthropic (${MODEL})`);
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    generateFor = async (teamId) => ({ digest: await generateOne(client, data, teamId, now), note: "" });
  } else {
    console.log("GEMINI_API_KEY / ANTHROPIC_API_KEY not set — skipping digest generation");
    return { skipped: "no-key" };
  }

  const generated = {};
  const failed = [];
  for (const teamId of Object.keys(TEAMS).map(Number)) {
    try {
      const { digest, note } = await generateFor(teamId);
      generated[teamId] = digest;
      console.log(`${TEAMS[teamId].name}: ok (${digest.edition}${note ? `, ${note}` : ""})`);
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

  // Post-run editorial review (Gemini path only): grade the batch, persist the
  // report, and let it add standing notes to tomorrow's writer prompt. A review
  // failure never fails the run — the editions are already published.
  if (geminiKey && Object.keys(generated).length) {
    try {
      const dateISO = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const editions = Object.entries(generated).map(([id, digest]) => ({ team: TEAMS[id].name, digest }));
      const { notes } = await reviewRun(geminiKey, editions, dateISO);
      console.log(`review written (editorial/reviews/${dateISO}.md)${notes.length ? `; new prompt notes: ${notes.join(" | ")}` : "; no new prompt notes"}`);
    } catch (e) {
      console.warn(`review step failed (editions unaffected): ${e.message}`);
    }
  }

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
