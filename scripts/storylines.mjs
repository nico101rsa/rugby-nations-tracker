// The Storyline Backlog — the middle rung of the quiet-day ladder.
// See docs/adr/0002 in the app repo.
//
// A team with no coverage today usually still has an OPEN QUESTION from last
// week: a fitness scare with no verdict yet, a squad not yet named, a coach's
// contract unresolved. The Backlog remembers those so a quiet day can return to
// one instead of publishing filler.
//
// Two things make this a Storyline store and not an article cache:
//
//   1. A Storyline carries a **resolution condition** in plain English ("until
//      South Africa name the Argentina squad"). An article carries no such
//      thing, which is why "is this still relevant?" is unanswerable from one.
//   2. Relevance is **re-checked at use time by a fresh search on the subject**,
//      never by trusting a stored date. A stored guess about staleness is a
//      guess; a search returning "squad named yesterday" is a fact. The dates
//      kept here are for housekeeping and ordering — they never decide whether
//      a Storyline is still live.
//
// Everything in this module is pure. The extraction call and the re-check
// search live in generate-digests.mjs.

import { isMatchReport, titleSimilarity, TEAM_ALIASES } from "./news-sources.mjs";

// Housekeeping floor only. A Storyline older than this is dropped from the file
// to stop it growing without bound — NOT because age proves it resolved. The
// search at use time is what decides that.
export const MAX_AGE_DAYS = 21;

// A Storyline that has already carried an edition three times is retired even
// if still live, so a dark team cycles rather than re-running one thread.
export const MAX_USES = 3;

const dayMs = 86_400_000;

export function ageDays(iso, now) {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / dayMs;
}

// ---- extraction --------------------------------------------------------------

// Candidate items for extraction: anything in the pool that is about a tracked
// team and is NOT a match report.
//
// Match reports are barred by ADR 0002 — the log and the fixture list already
// show a result, so a "storyline" that is really a scoreline would send a quiet
// day back to re-narrating a game the reader watched. This is the same demotion
// the salience layer applies, but here it is a hard exclusion rather than a
// weight: a match report has no open question in it by definition.
export function extractionCandidates(items) {
  return (items || []).filter((i) => i?.title && !isMatchReport(i.title));
}

// ONE extraction call covers all twelve teams — the pool is a single shared
// spine, so per-team calls would re-read the same ~120 headlines twelve times
// for no extra signal (ADR 0002).
export function buildExtractionPrompt(items, teamNames, dateISO) {
  const list = items
    .map((i, n) => `${n + 1}. [${i.feedName}] ${i.title}${i.desc ? `\n   ${i.desc.slice(0, 200)}` : ""}`)
    .join("\n");
  const teams = Object.entries(teamNames).map(([id, name]) => `${id} = ${name}`).join(", ");

  return `You are building an editorial BACKLOG for a rugby app's daily team briefings.
Today is ${dateISO}.

Below are today's rugby headlines. Identify the OPEN STORYLINES in them — the
threads that are not finished yet and that a fan would still want an answer to
next week.

A Storyline is NOT an event that has already concluded. It is an open question:

  GOOD: "Handré Pollard's hamstring injury and whether he makes the Argentina tour"
        → resolution: "until South Africa confirm whether Pollard travels"
  GOOD: "Wales' vacant head coach position"
        → resolution: "until Wales appoint a permanent head coach"
  BAD:  "South Africa beat Wales 43-0"        (finished — the app already shows results)
  BAD:  "Round three fixtures announced"      (administrative, no open question)
  BAD:  "The upcoming four-Test series between South Africa and New Zealand"
        (a FIXTURE, not a question — "until the series is completed" is a diary
         entry. The app already shows every fixture next to your copy.)

Rules:
- A Storyline MUST have a plain-English resolution condition starting with
  "until" — the concrete event that would close it. If you cannot write one,
  it is not a Storyline; leave it out.
- A match, series, tour or tournament simply TAKING PLACE is never a Storyline.
  If the resolution amounts to "until the games are played", you have described
  the fixture list. The open question must be about a PERSON or a DECISION —
  who is picked, who is fit, who gets the job, what a coach does about a
  problem — not about a scheduled event running its course.
- Assign each Storyline to the team(s) it genuinely concerns, by id. A team
  mentioned in passing is not concerned by it.
- Never invent a Storyline that is not supported by the headlines below.
- Prefer few, real, specific threads over many vague ones. Ten good ones across
  all teams is a better answer than thirty thin ones.
- \`subject\` must be searchable on its own: name the people and the thing at
  issue, so a search on it a week from now returns the latest state.

Team ids: ${teams}

## Headlines

${list}

## Output — strict JSON, nothing else

{
  "storylines": [
    {
      "subject": "<specific, searchable — names the people and the issue>",
      "teams": [<team id>, …],
      "resolution": "until <the concrete event that closes this>",
      "sourceIndexes": [<the headline numbers above that support it>]
    }
  ]
}`;
}

const asArray = (v) => (Array.isArray(v) ? v : []);

// A FIXTURE is not a Storyline, and it is the failure mode the "until" rule
// does not catch on its own.
//
// The first live extraction (2026-07-21) returned "The upcoming four-Test series
// between South Africa and New Zealand", resolving "until all four matches of
// the series are completed". That passes every shape check — it is specific,
// it names teams, its resolution starts with "until" — and it is still just the
// fixture list, which the app already renders next to the copy. Worse, being a
// series it was carried by 8 outlets, so it scored highest of anything in the
// backlog and would have been the FIRST pick for two teams.
//
// The test is on the SUBJECT, not the resolution: a discipline storyline may
// legitimately resolve "until England play a Test without a yellow card", and
// that is a real open question about a team, not a diary entry.
const FIXTURE_SUBJECT =
  /^(the\s+)?(upcoming|forthcoming|opening|first|second|third|next)?\s*\b(\w+[-\s])?(test\s+)?(series|tour|fixture|match|game|clash|encounter|tie|round|championship|tournament|competition|season)\b/i;
const FIXTURE_RESOLUTION =
  /until\s+(the\s+|all\s+|both\s+)?[\w\s-]*\b(match(es)?|test(s)?|game(s)?|fixture(s)?|series|round|tournament|competition|season)\b[\w\s-]*\b(is|are|has|have)?\s*(be)?(en\s+)?(complete|completed|played|finished|concluded|over|done|decided|ends?|concludes?)\b/i;

// True when the "storyline" is really a scheduled event running its course.
export function isFixtureShaped(subject, resolution) {
  return FIXTURE_SUBJECT.test(String(subject || "").trim()) &&
    FIXTURE_RESOLUTION.test(String(resolution || ""));
}

// Validate and normalise the model's extraction. Anything malformed is dropped
// rather than repaired: a Storyline with no resolution condition is exactly the
// article-shaped thing this store exists to avoid holding.
export function parseStorylines(raw, items, dateISO, knownTeamIds = Object.keys(TEAM_ALIASES).map(Number)) {
  const out = [];
  for (const s of asArray(raw?.storylines)) {
    const subject = String(s?.subject || "").trim();
    const resolution = String(s?.resolution || "").trim();
    if (subject.length < 12 || subject.length > 200) continue;
    // The resolution condition is the load-bearing field — enforce its shape,
    // not just its presence, or the model drifts back to restating the subject.
    if (!/^until\s+\S/i.test(resolution) || resolution.length > 200) continue;
    if (isFixtureShaped(subject, resolution)) continue;

    const teams = [...new Set(asArray(s?.teams).map(Number))].filter((id) => knownTeamIds.includes(id));
    if (!teams.length) continue;

    const sources = asArray(s?.sourceIndexes)
      .map((n) => items[Number(n) - 1])
      .filter(Boolean)
      .map((i) => ({ title: i.title, link: i.link, feedName: i.feedName }));
    if (!sources.length) continue;

    out.push({
      id: storylineId(subject),
      subject,
      teams,
      resolution,
      sources: sources.slice(0, 3),
      firstSeen: dateISO,
      lastSeen: dateISO,
      uses: 0,
    });
  }
  return out;
}

// Stable id from the subject, so the same thread re-extracted tomorrow lands on
// the same record and keeps its firstSeen.
export function storylineId(subject) {
  const norm = String(subject).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let h = 5381;
  for (const ch of norm) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `${norm.split("-").slice(0, 4).join("-")}-${h.toString(36)}`;
}

const SAME_STORYLINE = 0.5;

// Merge a fresh extraction into the stored backlog.
//
// Dedupe is by subject similarity, not by id alone: the model rephrases the same
// thread from one day to the next ("Pollard hamstring doubt" vs "Handré Pollard
// injury latest"), and two records for one thread would both surface and read as
// a repeat. The threshold is higher than the news clusterer's because these are
// longer, more specific strings.
//
// A re-seen Storyline keeps its ORIGINAL firstSeen and its use count, and takes
// the newer lastSeen and any new sources — it is the same open question, still
// open, which is precisely the thing worth knowing about it.
export function mergeBacklog(existing, incoming, dateISO, now = new Date()) {
  const merged = asArray(existing).map((s) => ({ ...s }));

  for (const fresh of incoming) {
    const hit = merged.find(
      (s) => s.id === fresh.id || titleSimilarity(s.subject, fresh.subject) >= SAME_STORYLINE,
    );
    if (hit) {
      hit.lastSeen = dateISO;
      // Union the sources, newest first, capped.
      const seen = new Set(hit.sources.map((x) => x.link));
      hit.sources = [...fresh.sources.filter((x) => !seen.has(x.link)), ...hit.sources].slice(0, 3);
      // Keep the longer subject: the more specific phrasing searches better.
      if (fresh.subject.length > hit.subject.length) hit.subject = fresh.subject;
      hit.teams = [...new Set([...hit.teams, ...fresh.teams])];
    } else {
      merged.push(fresh);
    }
  }

  // Housekeeping prune only — see MAX_AGE_DAYS.
  return merged.filter((s) => {
    if (s.retired) return false;
    if (s.uses >= MAX_USES) return false;
    const age = ageDays(s.lastSeen || s.firstSeen, now);
    return age == null || age <= MAX_AGE_DAYS;
  });
}

// ---- selection ---------------------------------------------------------------

// Live candidates for a team, best first.
//
// "Best" is deliberately simple: prefer a thread that is FRESH (recently
// re-seen, so the press is still on it), CORROBORATED (more sources), and
// UNUSED. There is no cleverness here because the real relevance test is the
// search that follows — this only decides what to spend that search on.
export function candidatesFor(backlog, teamId, now = new Date()) {
  return asArray(backlog)
    .filter((s) => s.teams?.includes(teamId) && (s.uses || 0) < MAX_USES && !s.retired)
    .map((s) => {
      const age = ageDays(s.lastSeen || s.firstSeen, now) ?? MAX_AGE_DAYS;
      const freshness = Math.max(0, 1 - age / MAX_AGE_DAYS);
      const score = freshness * 60 + Math.min(s.sources?.length || 0, 3) * 10 - (s.uses || 0) * 15;
      return { ...s, score: Math.round(score * 10) / 10 };
    })
    .sort((a, b) => b.score - a.score);
}

export function pickStoryline(backlog, teamId, now = new Date()) {
  return candidatesFor(backlog, teamId, now)[0] || null;
}

// Record a use. Called only when a Storyline actually carried an edition.
export function markUsed(backlog, storylineId, dateISO) {
  return asArray(backlog).map((s) =>
    s.id === storylineId ? { ...s, uses: (s.uses || 0) + 1, lastUsed: dateISO } : s,
  );
}

// Retire a Storyline the re-check found resolved. Kept as an explicit flag
// rather than deleted so a same-day re-run doesn't resurrect it.
export function retire(backlog, storylineId, dateISO) {
  return asArray(backlog).map((s) =>
    s.id === storylineId ? { ...s, retired: true, retiredOn: dateISO } : s,
  );
}

// ---- the re-check ------------------------------------------------------------

// The prompt block for a Storyline edition.
//
// The writer is handed the remembered thread AND a fresh search on its subject,
// and must reconcile them. Crucially, a RESOLVED storyline is not a failure —
// it is today's story ("South Africa have named the squad"), and it is usually a
// better one than the open thread was. That is why the re-check is a search
// rather than a date comparison: a date can only tell you a thread is old, while
// a search tells you what happened to it.
export function renderStorylineEdition(storyline, freshItems, teamName) {
  const fresh = (freshItems || []).length
    ? freshItems.map((i, n) => `${n + 1}. [${i.feedName || "search"}] ${i.title}\n   ${i.link || ""}`).join("\n")
    : "(the search returned nothing new on this subject)";

  return `## Returning to an open storyline

Today's press carries no new ${teamName} story, so this edition returns to a
thread we have been following. It was open when we last saw it:

- **Subject:** ${storyline.subject}
- **Stays open:** ${storyline.resolution}
- **First seen:** ${storyline.firstSeen}
- **Where we saw it:** ${storyline.sources.map((s) => `${s.feedName} — ${s.title}`).join("; ")}

### A fresh search on that subject, run just now

${fresh}

### What to write

Decide from the search results, NOT from the dates above:

- **If the thread has moved on or resolved** — the squad was named, the player
  was ruled out, the appointment was made — then THAT is your edition. A
  resolved storyline is a better story than an open one, so lead with the
  resolution and say plainly what happened.
- **If it is still open**, write the current state of it: what is unresolved,
  what has to happen for it to close, and what was last actually reported.
- **If the search shows nothing and you cannot say anything new**, say so
  honestly and briefly rather than restating the old headline as if it were
  today's news. Do not dress up a week-old fact as fresh.

Every factual claim must come from the search results above or from the sources
listed with the storyline. Do not fill from memory. Date any fact that is not
from today ("reported last week"), so nothing old reads as breaking.

Do NOT write about the quiet news cycle, the week, or the app's coverage. Open
on the story.`;
}

// Search query for the re-check. The subject is already written to be
// searchable; the team name anchors it in case the subject names only a player.
export function recheckQuery(storyline, teamName) {
  return `${storyline.subject} ${teamName} rugby`.replace(/\s+/g, " ").trim();
}
