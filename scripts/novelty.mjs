// Novelty — is today's lead the story the reader already saw yesterday?
//
// The generator compared today's edition with yesterday's in exactly one
// place: the FAILURE path, where a team that fails fact-check keeps its
// previous edition. Nothing on the success path asked whether the new lead
// was new. During a week without a match the team-naming story keeps winning
// the shortlist, so South Africa led with André Esterhuizen's captaincy on
// 23, 24 and 25 September 2026 — three editions, three dates, one story.
// That was not a Springbok quirk: across 782 consecutive-day pairs in the run
// reports, the same story led a team on the following day roughly one time
// in six (Vunilagi four days for Fiji, Albornoz five for Argentina, the
// Pacific Nations Cup final four in Japan's roundup line).
//
// Everything here is pure and tested offline; the I/O (reading the run
// reports, calling the model) stays in generate-digests.mjs. Three parts:
//
//   1. a similarity measure, calibrated on those 782 pairs;
//   2. "what did we already report" — the published edition plus the recent
//      run reports, per team;
//   3. the same question for the "Around the world" roundup lines.
//
// Roundup lines live in world-roundup.mjs, which the generator imports; this
// module imports neither, so nothing here can form a cycle.

// ---- 1. similarity ----------------------------------------------------------

// Words that carry no signal when asking whether two EDITIONS are the same
// story. Broader than the shortlist's clustering stopwords on purpose: those
// decide whether two OUTLETS cover one story (where over-stripping inflates
// corroboration), while this decides whether two DAYS do — and every edition
// about a team shares "side", "team", "against" and the like.
const STOPWORDS = new Set(
  ("a an the and or but of to in on at for with from by as is are was were be been " +
   "his her their its this that these those he she they it after before over under " +
   "who whom what which why how when where new says say said reveals reveal make makes " +
   "rugby union test match against side team ahead following v vs into out has have had " +
   "will with as for").split(" "),
);

// Diacritics off (André / Andre are one man), then a crude plural/verb
// stem so "captain" meets "captains" and "change" meets "changes". Crude is
// fine: the thresholds below were calibrated with exactly this stem, and a
// real stemmer would only move them.
function stem(word) {
  let w = word.normalize("NFD").replace(/\p{M}/gu, "");
  if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  return w;
}

export function storyTokens(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .map(stem)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

// Jaccard overlap on story tokens: 0 (nothing shared) to 1 (identical).
export function storySimilarity(a, b) {
  const A = storyTokens(a);
  const B = storyTokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

// Thresholds, calibrated on every consecutive-day pair in editorial/runs
// (2026-07-21 → 2026-09-25, 782 pairs, read by eye):
//
//   HEADING   heading-only overlap ≥ 0.34 was the same story in every pair
//             but one (a preview followed by the result — see below).
//   STORY     heading+body overlap ≥ 0.28 was the same story in all but two
//             (both data editions, whose bodies share the same stat names).
//   BOTH      the Esterhuizen pair itself scored 0.31 / 0.22 — under both
//             lines alone. Requiring a moderate overlap on BOTH catches it,
//             and every other pair in that band was a repeat too
//             (Contepomi's "lack of respect", Schoeman's "top three side",
//             Matt Williams on Ireland, the Albornoz ban).
//
// A preview followed by the result ("Eddie Jones backs experience as Japan
// prepare" → "Eddie Jones' Japan defeat Fiji to secure the Cup") reads as a
// repeat here. That is accepted: the gate costs one revision, and the app's
// log and fixtures already carry the result.
export const HEADING_REPEAT = 0.34;
export const STORY_REPEAT = 0.28;
export const BOTH_HEADING = 0.25;
export const BOTH_STORY = 0.2;

// The link is the strongest signal of all — the same article led three
// Springbok editions running — but outlets append tracking parameters, so
// compare origin + path only. Same rule as the news pool's itemKey.
export function normaliseLink(link) {
  const raw = String(link || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`.replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

// Are two editions ({ heading, body?, link? }) the same story? Returns the
// reason (for the run log) or null. Reasons are short and stable so the
// watchdog and the daily email can print them as-is.
export function sameStory(a, b) {
  if (!a || !b) return null;
  const la = normaliseLink(a.link);
  const lb = normaliseLink(b.link);
  if (la && lb && la === lb) return "same source article";
  const heading = storySimilarity(a.heading, b.heading);
  const story = storySimilarity(`${a.heading ?? ""} ${a.body ?? ""}`, `${b.heading ?? ""} ${b.body ?? ""}`);
  const r = (n) => n.toFixed(2);
  if (heading >= HEADING_REPEAT) return `heading overlap ${r(heading)}`;
  if (story >= STORY_REPEAT) return `story overlap ${r(story)}`;
  if (heading >= BOTH_HEADING && story >= BOTH_STORY) return `heading ${r(heading)} + story ${r(story)}`;
  return null;
}

// The first previously-reported edition today's draft repeats, or null.
// `previous` is newest-first, so the match reported is the most recent one.
export function findRepeat(draft, previous = []) {
  for (const entry of previous) {
    const reason = sameStory(draft, entry);
    if (reason) return { entry, reason };
  }
  return null;
}

// ---- 2. what has already been reported ----------------------------------------

export const WORLD_KICKER = "Around the world";

// The story section of a published digest — the writer's own section, never
// the roundup appended after it.
export function storySectionOf(digest) {
  const sections = Array.isArray(digest?.sections) ? digest.sections : [];
  return sections.find((s) => s && s.kicker !== WORLD_KICKER) ?? null;
}

// Everything the reader of this team's tab has already been shown, newest
// first: the edition currently published in nations.json (which is what they
// see right now), then the leads recorded in the recent run reports. The
// published edition is the authority for the heading; the run report adds
// the source link the writer led from, when its row is the same edition.
//
// `runs` are run reports newest-first, as readRecentRunReports returns them;
// their rows are keyed by team NAME, hence `teamName`.
export function previousLeadsFor(data, runs, teamId, teamName, { max = 3 } = {}) {
  const out = [];
  const seen = new Set();
  const key = (h) => String(h || "").trim().toLowerCase();
  const push = (entry) => {
    if (!entry.heading || seen.has(key(entry.heading))) return;
    seen.add(key(entry.heading));
    out.push(entry);
  };

  const published = data?.digests?.[teamId] ?? data?.digests?.[String(teamId)];
  const story = storySectionOf(published);
  if (story?.heading) {
    const row = (runs ?? [])
      .flatMap((r) => (Array.isArray(r?.teams) ? r.teams : []))
      .find((t) => t?.team === teamName && key(t.heading) === key(story.heading));
    push({ date: published.date ?? null, heading: story.heading, body: story.body ?? "", link: row?.leadLink ?? null });
  }
  for (const run of runs ?? []) {
    const row = (Array.isArray(run?.teams) ? run.teams : []).find((t) => t?.team === teamName);
    if (row?.heading) push({ date: run.date ?? null, heading: row.heading, body: row.body ?? "", link: row.leadLink ?? null });
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

// "Fri 25 Sep" from a calendar-day ISO date, rendered in UTC so the day
// cannot slip — the same rule the app's fmtEdition holds to.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "an earlier edition");
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  // Fixed tables, not toLocaleDateString: Node's ICU renders en-AU as
  // "Thu, 24 Sept", and the runner's locale data is not ours to rely on.
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

// The prompt block. The rule is stated the way the gate enforces it: a
// different story, unless something MATERIAL happened to the same one. A
// fresh quote or a new angle on the same event is the exact thing the three
// Esterhuizen editions were, so it is named as not counting.
export function renderAlreadyReported(previous = []) {
  if (!previous.length) return "";
  const lines = previous.map((p) => `- ${shortDate(p.date)}: "${p.heading}"`).join("\n");
  return `## Already reported — do not lead with these again

The reader has already seen these editions on this tab:
${lines}

**Today's lead must be a DIFFERENT story.** The one exception is a material
new development on the same story that the pack reports today — an injury, a
late change, a ban, a result. A new quote about it, a pundit's take on it or
a fuller retelling of it is NOT a development: that is the same story, and
it has been read. If the shortlist offers nothing else, lead with the
strongest genuinely new item even if it is smaller.`;
}

// The feedback for the one revision the gate allows. Deliberately blunt: the
// writer has just been told the rule and led with the repeat anyway.
export function buildNoveltyFeedback(repeat) {
  return `## Your draft repeats a story the reader has already seen — rewrite it
Your lead ("${repeat.entry.heading}", ${shortDate(repeat.entry.date)}) is the same
story as your draft's heading (${repeat.reason}). Lead with a DIFFERENT
story from the shortlist — prefer a candidate marked NEW. Keep every rule
from the brief: only facts the pack supports, one section, strict JSON.
Output the complete JSON again.`;
}

// ---- 3. the "Around the world" roundup ----------------------------------------

// Every roundup line in the recent run reports, newest first.
export function previousWorldLines(runs = [], { max = 3 } = {}) {
  return (runs ?? [])
    .slice(0, max)
    .flatMap((r) => (Array.isArray(r?.world) ? r.world : []).map((w) => ({ date: r.date ?? null, team: w.team, text: w.text })));
}

// A line repeats when the SAME nation's earlier line reads as the same story.
// Same-nation only: "Japan beat Fiji" under Japan and "Fiji lose to Japan"
// under Fiji are one story told twice, but the roundup already prevents that
// within a day, and across days each nation's own line is what the reader
// re-reads.
export function worldLineRepeat(line, previous = []) {
  for (const p of previous) {
    if (p.team !== line?.team) continue;
    if (storySimilarity(line.text, p.text) >= HEADING_REPEAT) return { date: p.date, text: p.text };
  }
  return null;
}

export function renderPreviousWorld(previous = []) {
  if (!previous.length) return "";
  const lines = previous.map((p) => `- ${p.team} (${shortDate(p.date)}): ${p.text}`).join("\n");
  return `## Already in the roundup on previous days — do not repeat these

${lines}

A story listed here is used up. Include that nation again ONLY if today's
briefing carries a new development on it (a result, an injury, a ban, a
sacking) — never the same event in new words.`;
}
