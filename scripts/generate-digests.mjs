// Daily team-briefing generator: one Claude call per team (Haiku + server-side
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
import { buildShortlist, isQuiet, renderShortlist } from "./news-sources.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "nations.json");

const MODEL = process.env.DIGEST_MODEL || "claude-haiku-4-5";
// Haiku 4.5 only supports the basic web-search tool; the _20260209 variant
// (dynamic filtering) needs Opus 4.6+ / Sonnet 5 / Sonnet 4.6. Keep both so a
// DIGEST_MODEL override back to Sonnet still works.
const WEB_SEARCH_TYPE = MODEL.startsWith("claude-haiku")
  ? "web_search_20250305"
  : "web_search_20260209";
const TZ = "Australia/Sydney"; // editions are dated for the reader's day

// Teamsheets (the app's "Squad · next game" card) are PAUSED — 2026-07-15.
// The only authoritative source is ESPN's match summary, and republishing an
// official numbered XV is the single highest-signal ESPN exposure (see the
// options paper: docs/DATA_RIGHTS.md in the app repo — decision was Option A,
// stay free, but pull the most-visible borrowed surface). This flag is the
// whole switch: false = no teamsheet is fetched, and any teamsheet already in
// nations.json is stripped on the next write, so squads vanish for every user
// (the live app reads this feed). Flip to true to restore — no app release
// needed, since SquadCard still ships and just shows its "not announced" state.
export const PUBLISH_TEAMSHEETS = false;

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

// The edition is ONE section. Its `kicker` is a short topical label the writer
// chooses ("Coaching scrutiny", "Injury blow", "Team news") — the app renders
// it verbatim above the heading. It was a fixed enum when editions had four
// fixed sections; pinning it to a literal after the single-story switch made
// 9/12 teams fail validation on 2026-07-20 (the model naturally labels the
// story it wrote), so the contract is now shape-only.
export const SECTION_COUNT = 1;
const KICKER_MAX = 30;

const TEMPLATE = `You write **{MASTHEAD}**, the daily {TEAM_NAME} briefing inside Rugby Nations
Tracker, an iOS app covering men's international rugby (all competitions —
Nations Championship, test series, tours, Rugby Championship, Six Nations,
World Cup). Your reader is a knowledgeable {TEAM_NAME} fan who checks the app
once a day. Today is {DAY_NAME} {DATE_LONG}.

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

## Format — ONE section: heading + one paragraph

The edition is a single story: the most interesting, talked-about {TEAM_NAME}
story in today's coverage, from ANY current men's 15s competition — never
limit yourself to one tournament. A selection bombshell, an injury to a key
man, a coach's barb before a big test, a rivalry series storyline — pick the
one a fan would text a mate about.

- **Kicker:** a 1–3 word topical label for the story, ≤30 characters, rendered
  in small caps above the heading ("Coaching scrutiny", "Injury blow",
  "Selection call", "Team news"). Label THIS story — don't reuse a generic
  default when something sharper fits.
- **Heading: 10-12 words.** It must (a) NAME someone — a player, a coach, or
  the team — and (b) state WHAT HAPPENED. A heading that names nobody, or that
  describes a situation rather than an event, has failed: "Moving up the table",
  "Questions persist over long-term identity" and "Squad managing end-of-season
  toll" are all real headings from this brief and all three are unusable.
  You MAY carry a short quoted fragment when the pack gives you one worth
  carrying ("Rassie Erasmus' honest 'pressure' admission over certain
  Springboks") — permitted, never required, and never manufactured to seem
  livelier than the story is.
- **Angle it at {TEAM_NAME}.** Big incidents involve two nations, and the other
  side's edition is written from the same pack — so a heading that would serve
  either team equally has failed. Write it from {TEAM_NAME}'s stake in the
  story. After the England-Argentina press-room row on 2026-07-20 BOTH editions
  ran the identical heading "Felipe Contepomi storms out of press conference
  accusing England of disrespect". That is Argentina's story; England's edition
  needed Borthwick's side of it.
- **Body: one paragraph, 55–90 words.** Lead with the story, then the one or
  two supporting facts that give it weight. If the story is match-pinned,
  say which match ("Saturday's second test"), never a vague "this season".
- Standings claims stay **edition-relative** ("goes into the weekend top of
  the log") — earlier kickoffs can move the live table while your copy is up.
- At most **one direct coach quote** per edition, verbatim and sourced.
- Register: knowing fan, dry, confident sports desk. Second reference to a
  well-known coach may be informal ("Rassie", "Razor") if that's how the
  team's press corps writes. No manufactured hype, no "mouth-watering clash".
- Re-read for name echoes across sentences (two different Gregors back-to-back
  reads like a glitch).

## Style

**British English (en-GB) throughout** — "prioritise", "organised",
"defence", "criticised", "favourite". This is a British-register rugby desk and
US spellings read as a different publication ("prioritize" reached a live
edition on 2026-07-20).

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
  "lead": { "candidate": <the shortlist number you led with>, "why": "<one short sentence: why this one>" },
  "sections": [
    { "kicker": "<1-3 word topical label>", "heading": "…", "body": "…" }
  ],
  "teamsheet": {
    "starters": [{ "no": 1, "name": "…" }, … exactly 15, jerseys 1-15 …],
    "bench": [{ "no": 16, "name": "…" }, … the named replacements, 16 upward …]
  }
}
\`\`\`

\`teamsheet\` is OPTIONAL and held to a hard rule: include it ONLY if a source
in your pack prints an explicit numbered {TEAM_NAME} lineup for the next
fixture (1-15, usually with replacements 16-23). Copy names verbatim,
diacritics intact. NEVER reconstruct a lineup from prose mentions, and never
carry over a previous match's team — if today's pack has no numbered lineup,
omit the \`teamsheet\` key entirely.

Omit \`venue\`/\`referee\`/\`teamsheet\` keys rather than guessing. Output no prose
outside the JSON object.`;

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

// Shape gate before anything reaches the app: exactly today's date, the
// expected kickers in order, sane word counts. Returns a *clean* object (unknown keys
// dropped) so the published JSON is exactly the shape digestFor() expects.
export function validateDigest(raw, { dateISO }) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not an object"] };
  if (raw.date !== dateISO) errors.push(`date ${raw.date} !== ${dateISO}`);
  if (typeof raw.edition !== "string" || !raw.edition.trim()) errors.push("missing edition");
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  if (sections.length !== SECTION_COUNT) errors.push(`expected ${SECTION_COUNT} section(s), got ${sections.length}`);
  else {
    sections.forEach((s, i) => {
      const kicker = typeof s?.kicker === "string" ? s.kicker.trim() : "";
      if (!kicker) errors.push(`section ${i} missing kicker`);
      else if (kicker.length > KICKER_MAX) errors.push(`section ${i} kicker "${kicker}" over ${KICKER_MAX} chars`);
      if (typeof s?.heading !== "string" || !s.heading.trim()) errors.push(`section ${i} missing heading`);
      const n = typeof s?.body === "string" ? words(s.body) : 0;
      if (n < 20 || n > 120) errors.push(`section ${i} body ${n} words (want ~55-90)`);
      for (const [re, label] of BANNED_COPY) {
        const copy = `${s?.heading ?? ""} ${s?.body ?? ""}`;
        if (re.test(copy)) errors.push(`section ${i} contains ${label}`);
      }
    });
  }
  // Teamsheet is OPTIONAL — absence must never fail an edition. When present
  // it must be a real numbered lineup: exactly 15 starters wearing 1-15, and
  // an optional bench of unique numbers from 16 up. A malformed teamsheet
  // fails the edition (better a retry than a wrong lineup in the app).
  let teamsheet = null;
  if (raw.teamsheet != null) {
    const t = raw.teamsheet;
    const player = (p) => p && typeof p === "object" && Number.isInteger(p.no) && typeof p.name === "string" && p.name.trim();
    const starters = Array.isArray(t?.starters) ? t.starters : [];
    const bench = Array.isArray(t?.bench) ? t.bench : [];
    if (starters.length !== 15) errors.push(`teamsheet has ${starters.length} starters (want 15)`);
    if (![...starters, ...bench].every(player)) errors.push("teamsheet has malformed players");
    else {
      const startNos = starters.map((p) => p.no);
      if (new Set(startNos).size !== 15 || startNos.some((n) => n < 1 || n > 15)) errors.push("starter jerseys must be unique 1-15");
      const benchNos = bench.map((p) => p.no);
      if (new Set(benchNos).size !== benchNos.length || benchNos.some((n) => n < 16)) errors.push("bench jerseys must be unique, 16 up");
    }
    if (!errors.length) {
      const clean = (list) => list.slice().sort((a, b) => a.no - b.no).map((p) => ({ no: p.no, name: p.name.trim() }));
      teamsheet = { starters: clean(starters) };
      if (bench.length) teamsheet.bench = clean(bench);
    }
  }
  if (errors.length) return { ok: false, errors };
  const digest = {
    date: raw.date,
    edition: raw.edition.trim(),
    sections: sections.map((s) => ({ kicker: s.kicker.trim(), heading: s.heading.trim(), body: s.body.trim() })),
  };
  // `lead` records WHICH shortlist candidate the writer led with and why. It is
  // never published to the app — it exists so the daily review can tell a
  // retrieval famine from a badly-chosen lead, which it could not do while it
  // saw only finished editions (and so spent three days prescribing style
  // patches for a retrieval problem). Missing `lead` never fails an edition.
  const candidate = Number(raw.lead?.candidate);
  if (Number.isInteger(candidate) && candidate > 0) {
    digest.lead = { candidate, why: typeof raw.lead?.why === "string" ? raw.lead.why.trim().slice(0, 200) : "" };
  }
  const match = {};
  if (typeof raw.match?.venue === "string" && raw.match.venue.trim()) match.venue = raw.match.venue.trim();
  if (typeof raw.match?.referee === "string" && raw.match.referee.trim()) match.referee = raw.match.referee.trim();
  if (Object.keys(match).length) digest.match = match;
  if (teamsheet) digest.teamsheet = teamsheet;
  return { ok: true, digest, errors: [] };
}

// A team that failed today keeps yesterday's edition (its dated masthead makes
// the staleness visible) rather than falling back to the placeholder.
export function mergeDigests(existing = {}, generated = {}) {
  return { ...existing, ...generated };
}

// Drop the `teamsheet` key from every digest. Runs at the write boundary when
// PUBLISH_TEAMSHEETS is off, so a teamsheet already published for a team we did
// NOT regenerate this run (e.g. SA's XV from a prior round) is removed too —
// generation-side guards alone would leave it stranded in nations.json.
// `lead` is editorial telemetry for the daily review, not app content. Strip it
// at the write boundary so it never reaches nations.json (which the live app
// reads) — same pattern as stripTeamsheets, and for the same reason: a
// generation-side guard alone would strand it for any team not regenerated.
export function stripLeads(digests = {}) {
  return Object.fromEntries(
    Object.entries(digests).map(([id, d]) => {
      if (!d || d.lead == null) return [id, d];
      const { lead, ...rest } = d;
      return [id, rest];
    }),
  );
}

// The hourly harvest's pool. Absent or unreadable is survivable — the widener
// still runs, which is exactly the position Japan and Fiji are in every day.
export async function readNewsPool(path = join(ROOT, "editorial", "news-pool.json")) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.items) ? parsed.items : [];
  } catch {
    return [];
  }
}

export function stripTeamsheets(digests = {}) {
  return Object.fromEntries(
    Object.entries(digests).map(([id, d]) => {
      if (!d || d.teamsheet == null) return [id, d];
      const { teamsheet, ...rest } = d;
      return [id, rest];
    }),
  );
}

// ---- API call ---------------------------------------------------------------

const MAX_CONTINUATIONS = 5; // pause_turn resumes (server-side web search loop)
// Cost cap. 8 was the launch value; the first live run (2026-07-10) showed the
// search-result context compounds quadratically with each extra search — 4 is
// plenty for a daily briefing and cuts token spend by well over half.
const MAX_SEARCHES = 4;
// Haiku 4.5 runs without thinking, but keep 12000 for search-loop headroom —
// and because a DIGEST_MODEL override to Sonnet 5 re-enables adaptive thinking,
// which counts against max_tokens (the first live run at 4000 exhausted it on
// 10/12 teams before the JSON). Actual JSON output is <1k tokens.
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
      tools: [{ type: WEB_SEARCH_TYPE, name: "web_search", max_uses: MAX_SEARCHES }],
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
const ARTICLE_CHARS = 3000; // per-article cap in the model PACK keeps prompt ~15-20K tokens
// Lineup detection + code extraction scan a larger window than the pack: a
// numbered XV often sits below 3000 chars of preamble (rugbypass prints SA's at
// ~2600 and it runs ~700 more), so the pack slice truncates it mid-list. The
// model still sees only ARTICLE_CHARS; the code parser gets the whole XV.
const LINEUP_SCAN_CHARS = 12000;

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

// Detect an explicit numbered lineup in article text: at least 10 distinct
// "jersey-number Name" hits (e.g. "15 Aphelele Fassi" / "9. Grant Williams").
// Code-level ground truth for whether a teamsheet is actually available —
// the writer's judgement is checked against this, never trusted alone.
export function hasNumberedLineup(text) {
  const hits = String(text).match(/\b(1[0-5]|[1-9])[.\s]+(?=[A-Z][A-Za-zÀ-ž'’-]+\s+[A-Z])/g) || [];
  return new Set(hits.map((h) => parseInt(h, 10))).size >= 10;
}

// Code-side teamsheet parser — the deterministic fallback for when a numbered XV
// is verifiably in the pack but the writer model won't transcribe it (England +
// Argentina were "lineup in pack but NOT extracted" on 2026-07-14). Pulls
// "N Name" pairs directly and returns { starters, bench? } ONLY when all of 1-15
// are present; an incomplete parse yields null, honouring the same "never a
// partial / never reconstructed" contract the whole feature is built on.
const _PARTICLE = "(?:van|von|der|den|de|del|di|du|da|dos|le|la|el|bin|al)";
const _NAMEWORD = "[A-ZÀ-Ý][A-Za-zÀ-ÿ'’.\\-]*";
// "N Name" — the name is 1-4 words (Capitalised, with optional lowercase
// particles), stopping at the next number, a club parenthetical or a delimiter.
const _LINEUP_RE = new RegExp(
  `\\b(\\d{1,2})[.\\)]?\\s+(${_NAMEWORD}(?:\\s+(?:${_PARTICLE}\\s+){0,2}${_NAMEWORD}){0,3})`,
  "g",
);
// A printed XV is compact (~700 chars for 15) and prints full names. Numbers
// scattered through prose satisfy neither — these two thresholds are what stops
// extractLineup inventing a squad (see the gates in extractLineup).
const MAX_XV_SPAN = 1200;
const MIN_FULL_NAMES = 13; // of 15 must be "First Last", not a bare word

// Trailing tokens that are list labels / page chrome, not part of a name.
const _NAME_STOP = /^(Replacements?|Reserves?|Bench|Substitutes?|Subs|Starters?|Captain|Coach|Date|Comments?|Share|Watch|Read|More|Related|News|Rugby|Team|Squad|XV|FT|HT|AEST|SAST|GMT|BST|CET|CEST|[A-Z]{2,})$/;

function _cleanName(raw) {
  const words = raw.replace(/[\s.,;:]+$/, "").replace(/\s+/g, " ").trim().split(" ");
  while (words.length > 1 && _NAME_STOP.test(words[words.length - 1])) words.pop();
  // Strip again: popping a trailing label ("… Steenekamp. Replacements") can
  // re-expose punctuation that was interior a moment ago.
  return words.join(" ").replace(/[\s.,;:]+$/, "");
}

export function extractLineup(text) {
  // Candidate "N Name" hits with their positions. Real articles carry numeric
  // noise (scoreboards, dates, nav) so we don't trust the whole page — we find
  // the tightest character-span window that contains all of 1-15, which is the
  // actual XV block, and read starters/bench from there (first mention wins).
  const cands = [];
  for (const m of String(text).matchAll(_LINEUP_RE)) {
    const no = parseInt(m[1], 10);
    const name = _cleanName(m[2]);
    if (no >= 1 && no <= 23 && name) cands.push({ no, name, idx: m.index });
  }

  // Minimum window over candidates covering distinct jerseys 1-15.
  const count = new Map();
  let have = 0, l = 0, best = null;
  for (let r = 0; r < cands.length; r++) {
    const nr = cands[r].no;
    if (nr <= 15) { count.set(nr, (count.get(nr) || 0) + 1); if (count.get(nr) === 1) have++; }
    while (have === 15) {
      const span = cands[r].idx - cands[l].idx;
      if (!best || span < best.span) best = { l, r, span, start: cands[l].idx, end: cands[r].idx };
      const nl = cands[l].no;
      if (nl <= 15) { count.set(nl, count.get(nl) - 1); if (count.get(nl) === 0) have--; }
      l++;
    }
  }
  if (!best) return null; // never a full XV present → honest blank, not a guess

  // Two gates against hallucinating a lineup out of prose. On 2026-07-15 the
  // parser shipped a fabricated Wales XV ("4 Can, 5 Tidy, 6 Got, 7 The") by
  // finding numbers beside capitalised sentence-openers. A printed XV is (a)
  // COMPACT — 15 players inside ~700 chars — and (b) made of REAL NAMES, i.e.
  // "First Last". Prose satisfies neither. A false positive is worse than a
  // blank card, so anything that fails these is discarded outright.
  if (best.span > MAX_XV_SPAN) return null;

  const byNo = new Map();
  for (const c of cands.slice(best.l, best.r + 1)) if (!byNo.has(c.no)) byNo.set(c.no, c.name);
  const starters = [];
  for (let n = 1; n <= 15; n++) starters.push({ no: n, name: byNo.get(n) });
  if (starters.filter((p) => p.name.includes(" ")).length < MIN_FULL_NAMES) return null;

  // Bench 16-23 immediately follows the starters block (within ~800 chars).
  const bench = [];
  for (let n = 16; n <= 23; n++) {
    const c = cands.find((c) => c.no === n && c.idx >= best.start && c.idx <= best.end + 800);
    if (c) bench.push({ no: n, name: c.name });
  }
  const sheet = { starters };
  if (bench.length) sheet.bench = bench;
  return sheet;
}

// Teamsheet precedence. The model's free-text transcription is the weak link:
// once SA's article fetch was repaired (2026-07-14) the writer produced the XV
// itself and shipped it with jerseys 4/5 and 11/14 swapped. extractLineup reads
// the jerseys verbatim from the article, so a successful code parse OVERRIDES
// the model rather than merely backfilling it. The model's sheet is kept only
// when no numbered XV can be parsed at all.
// Age-grade / non-senior sides print numbered XVs too, and a "Wales U20 team
// named" piece answers the same lineup query as the senior one — on 2026-07-15
// the parser lifted a Wales U20 side into the senior squad card. Never parse a
// lineup out of one of these.
const NON_SENIOR = /\b(u-?\d{2}|under[- ]?\d{2}|women|women's|academy|schools?|sevens|7s|development|barbarians)\b/i;

// ESPN's match summary carries the OFFICIAL announced lineup with jersey numbers
// — structured, keyless, uncapped debutants included, and EMPTY until a squad is
// actually named. It cannot fabricate an XV the way prose parsing can (which on
// 2026-07-15 invented "4 Can, 5 Tidy, 6 Got, 7 The" and lifted a U20 side), so
// it outranks every other source. Absence here is a truthful "not named yet".
export function espnTeamsheet(summary, teamName) {
  const entry = (summary?.rosters || []).find((r) => r?.team?.displayName === teamName);
  if (!entry) return null;
  const byNo = new Map();
  for (const p of entry.roster || []) {
    const no = parseInt(p?.jersey, 10);
    const name = p?.athlete?.displayName?.trim();
    if (!Number.isInteger(no) || no < 1 || no > 23 || !name) continue;
    if (!byNo.has(no)) byNo.set(no, name);
  }
  const starters = [];
  for (let n = 1; n <= 15; n++) {
    if (!byNo.has(n)) return null; // not named yet (or partial) → honest blank
    starters.push({ no: n, name: byNo.get(n) });
  }
  const bench = [];
  for (let n = 16; n <= 23; n++) if (byNo.has(n)) bench.push({ no: n, name: byNo.get(n) });
  const sheet = { starters };
  if (bench.length) sheet.bench = bench;
  return sheet;
}

export function resolveTeamsheet(modelSheet, lineupArticles = [], espnSheet = null) {
  // ESPN is authoritative; the prose parser and the model are fallbacks for when
  // it hasn't published yet.
  if (espnSheet) return { sheet: espnSheet, note: ", teamsheet from ESPN (official)" };
  const senior = (lineupArticles || []).filter((a) => !NON_SENIOR.test(a.title || ""));
  const parsed = senior.map((a) => extractLineup(a.text)).find(Boolean) || null;
  if (parsed) {
    const corrected = modelSheet && JSON.stringify(modelSheet) !== JSON.stringify(parsed);
    return { sheet: parsed, note: corrected ? ", teamsheet parsed in code (model transcription corrected)" : ", teamsheet parsed in code" };
  }
  if (modelSheet) return { sheet: modelSheet, note: ", teamsheet (model, unverified)" };
  return { sheet: null, note: "" };
}

// Fetch ordering: float likely team-selection headlines to the front so the
// article that prints the numbered XV always gets a body pulled. SA's XV was
// published but its run got "0 articles" (2026-07-14) because Bing ranked local
// outlets that fail to fetch above the planetrugby/rugbypass lineup piece, which
// then sat past the fetch cutoff. Array.sort is stable, so non-lineup items keep
// their recency order.
const _LINEUP_TITLE =
  /\b(team (named|to (face|play|meet)|announced)|side to (face|play)|xv to (face|play)|line[- ]?up|starting (xv|line)|name[ds]?\s+(his |the |their )?(side|team|xv)|team news)\b/i;

export function prioritiseByLineup(items) {
  return [...items].sort(
    (a, b) => (_LINEUP_TITLE.test(b.title) ? 1 : 0) - (_LINEUP_TITLE.test(a.title) ? 1 : 0),
  );
}

// The safeguard that was missing: which teams play inside the match-week window
// with no published squad. Pure so both the generator's end-of-run audit and the
// daily watchdog email share one definition (the old check warned only within
// 48h and only to the unread Actions log).
export function teamsheetGaps(fixtures, digests = {}, now = new Date(), windowMs = 5 * 24 * 60 * 60 * 1000) {
  const nowMs = now.getTime();
  const seen = new Set();
  const gaps = [];
  for (const f of Array.isArray(fixtures) ? fixtures : []) {
    const dt = Date.parse(f?.date) - nowMs;
    if (!(dt > 0 && dt < windowMs)) continue;
    for (const side of [f?.home, f?.away]) {
      const id = side?.id;
      if (id == null || seen.has(id)) continue;
      seen.add(id);
      if (!digests?.[id]?.teamsheet) gaps.push({ teamId: id, kickoff: f.date });
    }
  }
  return gaps;
}

// ESPN lineup retrieval. The Nations Championship is league 17567 (the same one
// the ratings harvester uses). Two hops: the scoreboard for the fixture's UTC
// date gives the event id, the summary gives the announced rosters. Summaries
// are cached per run — 6 events cover all 12 teams.
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/rugby/17567";
const _espnCache = new Map();

async function espnJson(url) {
  if (_espnCache.has(url)) return _espnCache.get(url);
  const res = await fetchWithTimeout(url);
  const json = res.ok ? await res.json() : null;
  _espnCache.set(url, json);
  return json;
}

export async function fetchEspnTeamsheet(teamName, fixtureDateISO) {
  try {
    if (!fixtureDateISO) return null;
    const ymd = new Date(fixtureDateISO).toISOString().slice(0, 10).replace(/-/g, "");
    const board = await espnJson(`${ESPN}/scoreboard?dates=${ymd}`);
    const event = (board?.events || []).find((e) =>
      (e?.competitions?.[0]?.competitors || []).some((c) => c?.team?.displayName === teamName),
    );
    if (!event) return null;
    const summary = await espnJson(`${ESPN}/summary?event=${event.id}`);
    return espnTeamsheet(summary, teamName);
  } catch {
    return null; // ESPN is best-effort; the prose fallback still applies
  }
}

// The WIDENER (docs/adr/0001 in the app repo). The publisher spine sets the
// agenda; this catches what its five-outlet roster misses, and for teams the
// roster does not cover it is the only source at all — Japan and Fiji drew 0 of
// 99 spine headlines on 2026-07-20.
//
// ONE query, team-anchored. The previous three were all anchored on the NEXT
// FIXTURE'S OPPONENT, which made a team's biggest current story structurally
// unreachable unless it happened to concern that opponent, and two of the three
// hunted numbered lineups for a feature that is switched off
// (PUBLISH_TEAMSHEETS). That is why the 2026-07-20 Bok edition led with the log
// table while the press led with Erasmus on Feinberg-Mngomezulu's fitness.
async function fetchTeamNews(teamName) {
  const queries = [`${teamName} rugby news`];
  const seen = new Set();
  const items = [];
  // Two passes: Bing's RSS intermittently returns empty (cost NZ its edition
  // on 2026-07-11); one retry after a pause rescues the transient case.
  for (let pass = 0; pass < 2 && !items.length; pass++) {
    if (pass) await sleep(10000);
    for (const query of queries) {
      try {
        const res = await fetchWithTimeout(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`);
        if (!res.ok) continue;
        for (const item of parseRss(await res.text())) {
          const k = item.title.toLowerCase();
          if (!seen.has(k)) {
            seen.add(k);
            items.push(item);
          }
        }
      } catch {
        // timeout — next query / next pass
      }
    }
  }
  // The widener is best-effort. An empty Bing response is no longer fatal —
  // the spine pool carries the edition. It WAS fatal when Bing was the only
  // source (it cost NZ its edition on 2026-07-11).
  return items.slice(0, NEWS_ITEMS).map((item, n) => ({
    title: item.title,
    link: item.link,
    desc: item.desc,
    date: item.date,
    feedId: "search",
    feedName: "Web search",
    // Search results sit BELOW the spine on position: a hit ranked third by Bing
    // is not the editorial signal that third in Planet Rugby's feed is.
    position: n + 12,
  }));
}

// Build the source pack for one team: spine pool + widener, ranked into a
// shortlist, with article bodies for the top candidates.
//
// The writer may only lead with something on this shortlist. That constraint is
// the point of the redesign, not a detail — handed an unranked pack, a cheap
// model retreats to the safest thing in the prompt (the fixture, the log), which
// is what three days of style notes failed to fix.
export async function buildSourcePack(teamId, teamName, now, pool = []) {
  let widened = [];
  try {
    widened = await fetchTeamNews(teamName);
  } catch {
    // Spine-only is a perfectly good pack; carry on.
  }
  const shortlist = buildShortlist([...pool, ...widened], teamId, now);
  const quiet = isQuiet(shortlist);

  // Bodies for the top candidates only. The old code fetched every headline and
  // re-sorted for numbered lineups (prioritiseByLineup) — dead weight while
  // teamsheets are paused, and it pushed the actual story down the pack.
  const articles = [];
  for (const candidate of shortlist.slice(0, NEWS_ARTICLES)) {
    try {
      const a = await fetchWithTimeout(candidate.link);
      if (!a.ok) continue;
      const full = htmlToText(await a.text());
      if (full.length > 400) articles.push({ title: candidate.title, url: a.url, text: full.slice(0, ARTICLE_CHARS) });
    } catch {
      // paywalled/slow publishers just drop out of the pack
    }
  }

  const bodies = articles.map((a, n) => `### Article ${n + 1}: ${a.title}\n(${a.url})\n${a.text}`);
  const pack = `## Source pack — today's coverage (your ONLY factual sources)

You have no web access. The shortlist and articles below are your entire fact
sheet. Every factual claim in your edition must trace to this pack or to the
trusted app data. If the pack doesn't cover something, say so honestly rather
than guessing; never invent or assume "no news".

Quotes: quotation marks are a verbatim contract — only use words that appear
inside quotation marks in the pack, character for character. If the pack only
paraphrases what someone said, paraphrase too, without quote marks.

Where the pack is silent, attribute the silence to the COVERAGE — "no coverage
of that in today's press" — never to reality ("the camp is clean", "everyone is
available"). You know what was reported, not what is true in camp. Never pad an
edition with unsourced routine ("recovery protocols", "training intensity") to
fill space.

## Today's shortlist — lead with ONE of these

Ranked by how much the rugby press is actually making of each story:
corroboration across outlets first, then where the outlet placed it, then how
fresh it is. **You must lead with one of these candidates.** Pick the one a fan
would text a mate about — not the most routine one, and not the league table.
Record which you picked in the \`lead\` field.

${renderShortlist(shortlist)}
${quiet ? `
**Coverage of this team is thin today.** Write the best real story on the
shortlist, shorter and plainer than usual, and do not inflate it.

NEVER write ABOUT the thinness. The reader does not know or care what our news
cycle looked like — references to the day, the week, the volume of coverage or
the state of the sport are meta-commentary and are banned outright: no "on a
quiet Monday of reflection", no "today's quiet French rugby landscape", no
"with the window wrapped up". Open on the story itself.
` : ""}
${bodies.join("\n\n")}`;

  return { pack, shortlist, quiet, articleCount: articles.length, poolCount: pool.length, widenedCount: widened.length };
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
// checkerNotes: standing calibration notes maintained by the post-run tuner
// (editorial/checker-notes.md) — the lever that keeps strictness balanced.
export function buildFactCheckPrompt(params, digest, sourcePack, checkerNotes = "") {
  const notesBlock = checkerNotes
    ? `\n\n## Standing calibration notes (from previous runs' reviews — follow them)\n${checkerNotes}`
    : "";
  return `You are the fact-checker for **${params.MASTHEAD}**, a daily ${params.TEAM_NAME}
rugby briefing. Today is ${params.DAY_NAME} ${params.DATE_LONG}. Below is a draft edition.${notesBlock}

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
- stale news presented as this week's development;
- a \`teamsheet\` entry (name or jersey number) that does not match an explicit
  numbered lineup printed in the pack, or a teamsheet included when the pack
  prints no numbered lineup at all (each wrong name/number is one issue).

Do NOT flag — these are never issues:
- honest absence statements attributed to the coverage ("no fresh injury news
  in today's coverage") when the pack is indeed silent on the topic;
- accurate paraphrase, compression or reordering of source prose;
- tense/deixis adjustments ("this weekend" rendered as "today" when the dates
  agree), synonyms, or stylistic word choices;
- opinion, colour and tactical reading;
- anything you would describe as "technically true but could be phrased
  closer to the source";
- claims drawn from the TRUSTED APP DATA (log position, points, records, last
  result) — trusted data needs no corroboration from the pack, and a pack
  article contradicting trusted data is a defect of the pack, not the draft;
- disagreements BETWEEN pack sources: if ANY pack source supports the draft's
  version of a claim, the claim passes — prefer the most recent and most
  specific article; never fail a draft for a conflict among its own sources;
- incompleteness: a true fact the draft left out (a fourth debutant, an
  unexplained points system) is not an error.

Teamsheet rule: if the draft's teamsheet matches ANY explicit numbered lineup
printed in the pack, it passes in full. If sources print conflicting lineups,
flag ONLY the specific disputed entries (severity "minor", fix = the most
recent lineup article's version) — never fail the whole edition over a
disputed jersey.

One more rule: **the source pack is the authority.** If the draft accurately
reflects what the pack says, it passes — even if you suspect the pack itself
is wrong about the real world. You are checking draft-against-pack, not
pack-against-reality.

## Output — strict JSON, nothing else
{"issues": [{"kicker": "<section kicker>", "claim": "<the claim>", "problem": "<what is wrong>", "fix": "<corrected wording, or 'cut'>", "severity": "material" | "minor"}]}
severity "material" = a reader would be misinformed (invented fact, wrong
number/score/name, fake verbatim quote, stale news as fresh). severity
"minor" = everything else (phrasing preferences, incompleteness, could-be-
closer-to-source). When unsure, or when your reasoning contains "however" /
"actually" / "while not strictly false", the severity is "minor". Empty
issues array if the draft is clean.`;
}

// The verdict is computed here, not trusted from the model: only material
// issues fail an edition (Flash's own global verdicts contradicted its
// per-issue reasoning in testing). Minor issues are dropped.
export function parseVerdict(raw) {
  if (!raw || typeof raw !== "object") return { verdict: "fail", issues: [{ problem: "checker returned no JSON" }] };
  const all = Array.isArray(raw.issues) ? raw.issues.filter((i) => i && typeof i === "object") : [];
  const issues = all.filter((i) => i.severity === "material");
  return { verdict: issues.length ? "fail" : "pass", issues };
}

export async function generateOneGemini(apiKey, data, teamId, now, editorNotes, checkerNotes = "", pool = []) {
  const params = buildParams(data, teamId, now);
  const { pack, shortlist, quiet, articleCount, poolCount, widenedCount } = await buildSourcePack(teamId, params.TEAM_NAME, now, pool);
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
  const issueList = (issues) => issues
    .map((i) => `- [${i.kicker ?? "?"}] ${i.claim ?? ""}: ${i.problem ?? ""} → ${i.fix ?? "cut"}`)
    .join("\n");

  let digest = await draft();
  let check = parseVerdict(extractJson(await geminiCall(apiKey, buildFactCheckPrompt(params, digest, pack, checkerNotes))));
  let revisions = 0;

  while (check.verdict !== "pass" && revisions < MAX_REVISIONS) {
    revisions++;
    const feedback = `## Fact-check failures in your previous draft — fix all of these
${issueList(check.issues)}
Rewrite the full edition. Drop or soften any claim the source pack does not
support. If a quote was flagged, either use the exact verbatim wording the
fact-checker cites or remove the quotation marks and paraphrase — do not
re-word a quote a third way. Output the complete JSON again.`;
    digest = await draft(feedback);
    check = parseVerdict(extractJson(await geminiCall(apiKey, buildFactCheckPrompt(params, digest, pack, checkerNotes))));
  }

  if (check.verdict !== "pass") {
    // Last resort before failing the team: a maximally conservative rewrite.
    // Plainer copy that ships beats colourful copy that doesn't.
    revisions++;
    const feedback = `## STRICT MODE — your drafts kept failing fact-check. Final attempt.
Unresolved issues:
${issueList(check.issues)}
Rewrite the edition with zero flair: remove every flagged claim entirely, use
no quotation marks anywhere, no records or streaks, no assumptions about
availability or camp mood. Drop the "teamsheet" field entirely. State only
what headlines and articles in the source pack plainly report, plus the
trusted app data. Bodies may run short (around 50 words). Output the complete
JSON again.`;
    digest = await draft(feedback);
    check = parseVerdict(extractJson(await geminiCall(apiKey, buildFactCheckPrompt(params, digest, pack, checkerNotes))));
  }
  if (check.verdict !== "pass") {
    const remaining = check.issues.map((i) => i.problem).join("; ");
    throw new Error(`fact-check failed after ${revisions} revisions: ${remaining}`);
  }

  // Teamsheet: only ESPN's official XV, and only when teamsheets are published.
  //
  // The pack-scanning half of this is GONE with the old retrieval — the source
  // pack no longer fetches every headline looking for a printed numbered lineup
  // (prioritiseByLineup / hasNumberedLineup / LINEUP_SCAN_CHARS), because that
  // machinery served a feature switched off since 2026-07-15 and it pushed the
  // day's actual story down the pack. If PUBLISH_TEAMSHEETS is ever flipped back
  // on, lineup scanning has to be re-added to buildSourcePack — flipping the
  // flag alone now yields ESPN-only squads, not the prose fallback.
  let sheetNote = "";
  if (PUBLISH_TEAMSHEETS) {
    const espnSheet = await fetchEspnTeamsheet(params.TEAM_NAME, params.KICKOFF_ISO);
    const resolved = resolveTeamsheet(digest.teamsheet, [], espnSheet);
    sheetNote = resolved.note;
    if (resolved.sheet) digest = { ...digest, teamsheet: resolved.sheet };
  }

  // Attribution. Agreed mitigation for leaning the product on a five-outlet
  // spine we have no relationship with: name the outlet in the card. Derived
  // from the candidate the writer actually led with, never from the model — it
  // would guess, and a wrong byline is worse than none.
  const chosen = digest.lead ? shortlist[digest.lead.candidate - 1] : null;
  if (chosen?.feedName && chosen.feedId !== "search") {
    digest = { ...digest, source: { name: chosen.feedName } };
  }

  const lead = digest.lead ? `, led with #${digest.lead.candidate}` : ", NO lead recorded";
  return {
    digest,
    pack,
    shortlist,
    quiet,
    note: `${shortlist.length} candidates (${poolCount} pooled, ${widenedCount} searched), ${articleCount} articles${lead}${quiet ? ", QUIET" : ""}, fact-checked${revisions ? ` after ${revisions} revision(s)` : ""}${sheetNote}`,
  };
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
  const blocks = editions.map(({ team, digest, shortlist = [], quiet = false }) => {
    const candidates = shortlist.length
      ? shortlist.map((s, n) => `  ${n + 1}. [score ${s.score}${s.corroboration > 1 ? `, ${s.corroboration} outlets` : ""}] ${s.title}`).join("\n")
      : "  (none — the press carried nothing about this team today)";
    const led = digest.lead ? `led with #${digest.lead.candidate}: "${digest.lead.why}"` : "did not record a pick";
    return `### ${team}${quiet ? " — QUIET DAY" : ""}
What retrieval offered:
${candidates}
The writer ${led}.
Published edition:
${JSON.stringify({ ...digest, lead: undefined }, null, 1)}`;
  });

  return `You are the reviewing editor for a suite of daily rugby team briefings
(men's international rugby, all competitions). Below are today's editions (${dateISO}).

For each team you are shown THREE things: the ranked shortlist retrieval offered
the writer, which candidate the writer chose and why, and what it published.

${blocks.join("\n\n")}

## Classify before you prescribe

Every weak edition is one of two things, and they need OPPOSITE fixes:

- **RETRIEVAL-STARVED** — the shortlist was empty, thin, or all match reports.
  The writer had nothing and did the best available. Nothing the writer could
  have done differently would have helped.
- **BADLY-CHOSEN** — the shortlist held a genuinely interesting story and the
  writer led with a duller one, or buried the interesting one in the body.

You MUST classify each weak edition before commenting on it. **A note for the
WRITER may only address a BADLY-CHOSEN defect or a craft defect (heading, prose,
structure).** Never write a writer note about a retrieval famine: telling a
writer to stop saying "no fresh injury news" when the pack genuinely contained
none does not conjure news, it licenses invention. That exact note ran for three
days in July 2026 and produced fabricated "recovery protocols" copy.

Retrieval problems go in \`source_notes\` instead, which humans read — they are
not injected into any prompt.

## Review criteria
1. **Facts**: internal contradictions between editions (two teams describing
   the same match differently), impossible claims, hedges masquerading as facts.
2. **Choice**: did the writer lead with the best story on offer? Is the kicker
   about the right team? A story that merely MENTIONS this team is not a story
   about it.
3. **Quality**: flat or repetitive headings, filler, manufactured hype, name
   echoes. A heading must name someone and say what happened.
4. **Sources**: invented colour presented as reported fact, missing attribution.

## Output — strict JSON, nothing else
{
  "report": "<markdown, max 300 words: today's grade (A-F), the 2-3 most important observations with one example each. Say how many editions were retrieval-starved vs badly-chosen.>",
  "prompt_notes": ["<up to 2 short imperative notes for the WRITER prompt, addressing CHOICE or CRAFT defects seen in MULTIPLE editions. Empty array if today's weakness was retrieval.>"],
  "source_notes": ["<up to 2 notes about RETRIEVAL for human readers — which teams the press ignored, which outlets are missing, whether the ranking mis-ordered. Empty array if retrieval was fine.>"]
}
Only propose a prompt note for a defect visible in MULTIPLE editions; one-off
slips don't earn a standing rule. Notes must work WITHIN the format contract —
every edition is a single section: a short topical kicker, one heading of 10-12
words, one 55-90 word paragraph — so never propose adding sections or consulting
resources the writer doesn't have (its only inputs are the shortlist, the source
pack and the app data).`;
}

// Standing notes expire. Without this the file only ever grows: it reached eight
// entries in nine days in July 2026, several of them restating the same fix in
// slightly different words, and a note for a defect that was long since fixed
// kept steering the writer anyway. A rule that still matters gets re-proposed
// and its date refreshed; one that doesn't, ages out.
export const NOTE_TTL_DAYS = 14;

export function expireNotes(lines, dateISO, ttlDays = NOTE_TTL_DAYS) {
  const today = Date.parse(`${dateISO}T00:00:00Z`);
  return lines.filter((line) => {
    const stamp = line.match(/_\(added (\d{4}-\d{2}-\d{2})\)_/)?.[1];
    if (!stamp) return true; // hand-written note, never auto-expired
    const age = (today - Date.parse(`${stamp}T00:00:00Z`)) / 86_400_000;
    return Number.isNaN(age) ? true : age < ttlDays;
  });
}

// A re-proposed note replaces its older twin rather than sitting beside it —
// that duplication is how "stop saying no fresh injury news" ended up in the
// file three times in three days.
export function dedupeNotes(lines) {
  // Word-set overlap, not a prefix: the review rewords the TAIL of a repeated
  // note ("…filler sentences" vs "…filler sentences entirely"), so a fixed-length
  // prefix key treats twins as distinct. Newest wins — earlier entries in the
  // list are the fresher ones.
  const words = (line) =>
    new Set(
      line.replace(/_\(added \d{4}-\d{2}-\d{2}\)_/, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 3),
    );
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    return shared / Math.min(a.size, b.size);
  };
  const kept = [];
  for (const line of lines) {
    const w = words(line);
    if (kept.some((k) => overlap(w, k.words) >= 0.75)) continue;
    kept.push({ line, words: w });
  }
  return kept.map((k) => k.line);
}

async function reviewRun(apiKey, editions, dateISO) {
  const raw = extractJson(await geminiCall(apiKey, buildReviewPrompt(editions, dateISO)));
  if (!raw || typeof raw.report !== "string") throw new Error("review returned no usable JSON");
  const clean = (list) => (Array.isArray(list) ? list : []).filter((n) => typeof n === "string" && n.trim()).slice(0, 2);
  const notes = clean(raw.prompt_notes);
  // Retrieval findings are for humans, never for the writer prompt — the writer
  // cannot fix a famine, it can only paper over one.
  const sourceNotes = clean(raw.source_notes);

  const { mkdir } = await import("node:fs/promises");
  await mkdir(REVIEWS_DIR, { recursive: true });
  const sourceBlock = sourceNotes.length ? `\n\n## Retrieval notes (not injected into any prompt)\n${sourceNotes.map((n) => `- ${n.trim()}`).join("\n")}\n` : "";
  await writeFile(join(REVIEWS_DIR, `${dateISO}.md`), `# Digest review — ${dateISO}\n\n${raw.report}\n${sourceBlock}`);

  let existing = [];
  try {
    existing = (await readFile(NOTES_FILE, "utf8")).split("\n").filter((l) => l.startsWith("- "));
  } catch {
    // first run: no notes file yet
  }
  const merged = dedupeNotes([
    ...notes.map((n) => `- ${n.trim()} _(added ${dateISO})_`),
    ...expireNotes(existing, dateISO),
  ]).slice(0, MAX_NOTES);
  const expired = existing.length - expireNotes(existing, dateISO).length;
  await writeFile(
    NOTES_FILE,
    `# Standing editor notes\n\nInjected into the writer prompt daily; curated by the post-run review.\nNotes age out after ${NOTE_TTL_DAYS} days unless re-earned. Prune freely.\n\n${merged.join("\n")}\n`,
  );
  return { notes, sourceNotes, expired };
}

const CHECKER_NOTES_FILE = join(ROOT, "editorial", "checker-notes.md");
const MAX_CHECKER_NOTES = 6;

async function loadCheckerNotes() {
  try {
    return (await readFile(CHECKER_NOTES_FILE, "utf8")).split("\n").filter((l) => l.startsWith("- ")).join("\n");
  } catch {
    return "";
  }
}

// Post-run CHECKER tuner (mirrors the writer's editor-notes loop): when
// editions failed fact-check, one call reviews the failure reasons against the
// calibration contract — accuracy is non-negotiable, but a checker that blocks
// good editions is also a defect. It may propose up to 2 standing notes for
// the CHECKER prompt; notes live in editorial/checker-notes.md (newest first,
// capped) so every calibration change is in git.
export function buildCheckerTunePrompt(failures, publishedCount, existingNotes) {
  const lines = failures.map((f) => `- ${f.team}: ${f.reason}`).join("\n");
  return `You calibrate the FACT-CHECKER of a suite of 12 daily rugby team
briefings. The writer drafts each edition from a pack of same-day news; the
fact-checker passes or fails it. A failed edition means the app shows
YESTERDAY'S briefing — so a wrong pass misinforms readers, and a wrong fail
hides fresh, accurate news. Target: publish 10+/12 daily while never passing
an invented fact, wrong number/name, or fake quote.

Today the checker passed ${publishedCount}/12. The failures and the checker's
stated reasons:
${lines}

${existingNotes ? `Current standing calibration notes:\n${existingNotes}` : "No standing calibration notes yet."}

## Your job
Judge each failure reason: was it a LEGITIMATE block (draft asserted something
no source supports, wrong name/number, fake verbatim quote) or an OVER-STRICT
block (claim came from trusted app data; sources conflicting with each other;
incompleteness; phrasing preference; demanding corroboration the contract does
not require)? For recurring over-strict patterns, propose up to 2 short
imperative notes for the CHECKER prompt that would prevent them, e.g.
"A log-points claim matching the trusted app data is never an issue, even if
no pack article mentions points." Never propose weakening the invented-fact,
wrong-number or fake-quote rules.

## Output — strict JSON, nothing else
{"assessment": "<max 120 words: which failures were legitimate vs over-strict>",
 "checker_notes": ["<up to 2 notes, or empty array>"]}`;
}

async function checkerTuneRun(apiKey, failures, publishedCount, dateISO) {
  const existing = await loadCheckerNotes();
  const raw = extractJson(await geminiCall(apiKey, buildCheckerTunePrompt(failures, publishedCount, existing)));
  if (!raw || typeof raw.assessment !== "string") throw new Error("checker tuner returned no usable JSON");
  const notes = (Array.isArray(raw.checker_notes) ? raw.checker_notes : [])
    .filter((n) => typeof n === "string" && n.trim())
    .slice(0, 2);
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(REVIEWS_DIR, { recursive: true });
  await appendFile(join(REVIEWS_DIR, `${dateISO}.md`), `\n## Checker calibration — ${dateISO}\n\n${raw.assessment}\n`);
  if (notes.length) {
    const prior = existing ? existing.split("\n") : [];
    const merged = [...notes.map((n) => `- ${n.trim()} _(added ${dateISO})_`), ...prior].slice(0, MAX_CHECKER_NOTES);
    await writeFile(CHECKER_NOTES_FILE, `# Standing checker calibration notes\n\nInjected into the fact-check prompt daily; curated by the post-run tuner. Prune freely.\n\n${merged.join("\n")}\n`);
  }
  return { notes, assessment: raw.assessment };
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
  // set; Claude Haiku as the fallback path; skip cleanly when neither key is.
  const geminiKey = process.env.GEMINI_API_KEY;
  let generateFor;
  if (geminiKey) {
    console.log(`provider: gemini (${GEMINI_MODEL}, RSS source pack + fact-check pass)`);
    const editorNotes = await loadEditorNotes();
    if (editorNotes) console.log(`standing editor notes:\n${editorNotes}`);
    const checkerNotes = await loadCheckerNotes();
    if (checkerNotes) console.log(`standing checker notes:\n${checkerNotes}`);
    // The spine pool, harvested hourly (harvest-news.yml). Read ONCE and shared
    // across all 12 teams — it is one file covering every team, which is the
    // whole reason the publisher spine replaced 36 per-team queries.
    const pool = await readNewsPool();
    console.log(`news pool: ${pool.length} items`);
    generateFor = (teamId) => generateOneGemini(geminiKey, data, teamId, now, editorNotes, checkerNotes, pool);
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
  const retrieval = {}; // shortlist + quiet flag per team, for the review
  const failed = [];
  for (const teamId of Object.keys(TEAMS).map(Number)) {
    try {
      const { digest, note, shortlist = [], quiet = false } = await generateFor(teamId);
      generated[teamId] = digest;
      retrieval[teamId] = { shortlist, quiet };
      console.log(`${TEAMS[teamId].name}: ok (${digest.edition}${note ? `, ${note}` : ""})`);
    } catch (e) {
      failed.push({ team: TEAMS[teamId].name, reason: e.message.slice(0, 300) });
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
  if (!PUBLISH_TEAMSHEETS) fresh.digests = stripTeamsheets(fresh.digests);
  fresh.digests = stripLeads(fresh.digests);
  fresh.counts = { ...(fresh.counts || {}), digests: Object.keys(fresh.digests).length };
  const payload = JSON.stringify(fresh, null, 2);
  await writeFile(OUT, payload);
  // The CDN serves the site-ROOT nations.json; the workflow used to be the only
  // thing mirroring it, so a local run published squads nobody could see
  // (2026-07-11, the RSA teamsheet). Write both copies here, unconditionally.
  await writeFile(join(ROOT, "nations.json"), payload);
  console.log(`wrote ${Object.keys(generated).length}/12 editions${failed.length ? ` (failed: ${failed.map((f) => f.team).join(", ")})` : ""}`);

  // Teamsheet coverage audit across the whole match week (unions name teams from
  // early in the week — SA's 2026-07-14 XV was out 4 days pre-kickoff, but the
  // old 48h window stayed silent). Loud on purpose; the daily watchdog turns the
  // same evaluator into an email so a gap can't hide in the Actions log.
  // Skip the coverage audit while teamsheets are paused — otherwise every named
  // XV reads as a "gap" and the daily watchdog would alert on the feature we
  // deliberately turned off (see PUBLISH_TEAMSHEETS).
  const gaps = PUBLISH_TEAMSHEETS ? teamsheetGaps(fresh.fixtures, fresh.digests, now) : [];
  for (const g of gaps) {
    console.warn(`⚠️ TEAMSHEET GAP: ${TEAMS[g.teamId]?.name ?? g.teamId} play ${g.kickoff} but no squad is published`);
  }

  // Post-run editorial review (Gemini path only): grade the batch, persist the
  // report, and let it add standing notes to tomorrow's writer prompt. A review
  // failure never fails the run — the editions are already published.
  if (geminiKey && Object.keys(generated).length) {
    try {
      const dateISO = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
      const editions = Object.entries(generated).map(([id, digest]) => ({
        team: TEAMS[id].name,
        digest,
        ...(retrieval[id] ?? {}),
      }));
      const { notes, sourceNotes, expired } = await reviewRun(geminiKey, editions, dateISO);
      console.log(
        `review written (editorial/reviews/${dateISO}.md)` +
          `${notes.length ? `; new prompt notes: ${notes.join(" | ")}` : "; no new prompt notes"}` +
          `${sourceNotes.length ? `; retrieval notes: ${sourceNotes.join(" | ")}` : ""}` +
          `${expired ? `; ${expired} note(s) aged out` : ""}`,
      );
    } catch (e) {
      console.warn(`review step failed (editions unaffected): ${e.message}`);
    }
    // Checker tuner: only fact-check failures teach it anything (rss/network
    // failures are not calibration signals).
    const checkFails = failed.filter((f) => /fact-check failed/i.test(f.reason));
    if (checkFails.length) {
      try {
        const dateISO = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
        const { notes } = await checkerTuneRun(geminiKey, checkFails, Object.keys(generated).length, dateISO);
        console.log(notes.length ? `checker calibration notes added: ${notes.join(" | ")}` : "checker calibration reviewed; no new notes");
      } catch (e) {
        console.warn(`checker tuner failed (editions unaffected): ${e.message}`);
      }
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
