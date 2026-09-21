// "Around the world" — the roundup that closes every team's daily briefing
// (Nico's ask, 2026-09-21): the notable stories from the OTHER nations, so a
// reader on the Boks tab still learns that Japan lifted the Pacific Nations
// Cup or that Italy's coach was banned without switching tabs.
//
// How it works, and why this way:
//
// - ONE model call for all twelve teams, not twelve. The input is the day's
//   already-published editions; the roundup is a compression of them, so the
//   per-team view is just "everything except me" (worldSection). One call
//   also keeps the twelve tabs consistent — every reader sees the same take on
//   the same story.
// - It is written FROM THE FACT-CHECKED EDITIONS, never from the raw source
//   pack. The writer + checker loop already vetted every claim in those, so
//   the roundup's only job is to shorten, and the prompt forbids adding
//   anything. Code-side guards then enforce the cheap half of that: every
//   number in a highlight must appear in the edition it summarises, and the
//   same banned-copy rules as the editions apply.
// - "Nothing notable" is a valid answer for a team. The prompt sets a bar
//   (would a fan of a DIFFERENT team care?) and the roundup routinely covers
//   only a handful of nations. Data editions (stat notes written when the press
//   carried nothing) are never candidates — a defensive-metrics note is not
//   news anyone else needs.
// - It is appended as a SECOND `sections` entry with a fixed kicker. The app
//   renders every entry in `sections` (DigestCard maps over the array), so
//   this reaches every installed copy with no app build.
//
// Pure helpers; the model call is injected so everything tests offline.
import { bannedCopyIn, words } from "./copy-rules.mjs";

export const WORLD_KICKER = "Around the world";
export const WORLD_MAX_ITEMS = 8;
const ITEM_MIN_WORDS = 4;
const ITEM_MAX_WORDS = 35;

// The editions the roundup may draw on: today's, story-rung only. `teams` is
// the generator's id → { name } map; `generated` its id → digest map.
export function roundupCandidates(teams, generated) {
  return Object.entries(generated)
    .filter(([, d]) => d && d.rung !== "data" && d.sections?.[0]?.heading)
    .map(([id, d]) => ({
      teamId: Number(id),
      team: teams[id]?.name ?? String(id),
      heading: d.sections[0].heading,
      body: d.sections[0].body ?? "",
    }));
}

export function buildWorldPrompt(candidates, dateISO) {
  const blocks = candidates
    .map((c) => `### ${c.team}\n${c.heading}\n${c.body}`)
    .join("\n\n");
  return `You are the wire editor for Rugby Nations Tracker, an iOS app covering men's
international rugby. Each of the ${candidates.length} nations below has a daily
briefing, already written and fact-checked (${dateISO}). You write the
"Around the world" roundup that closes each briefing: the notable stories from
the OTHER nations, one short line per nation.

## Today's briefings (your ONLY source — add nothing)

${blocks}

## Rules

- **Selective.** Include a nation ONLY if its story would interest a fan of a
  DIFFERENT team: a result or trophy, a selection bombshell, a serious injury
  to a key player, a coach hired, sacked, banned or publicly under pressure, a
  governance shake-up, a big-name signing or retirement. Leave out anything
  routine or parochial — a coach's mild quote, a pundit's opinion, a debate
  piece, incremental rotation, generic "building for the weekend" copy.
  Typically three to seven nations clear the bar; on a dead day fewer do, and
  an empty list is an honest answer. Never pad.
- **One line per nation, at most 25 words.** A complete sentence that names
  the people involved and states what happened. Do NOT start with the
  nation's name — it is printed as a label in front of your line.
- **Compress, never add.** Every fact, name and number must come from that
  nation's briefing above. No outside knowledge, no inference about what a
  story "means", no numbers the briefing does not contain. Names and
  diacritics verbatim. If a briefing quotes someone, paraphrase — no
  quotation marks in the roundup.
- **One story, once.** Two briefings often cover the same match or incident
  from each side (a final, a press-room row). Write it ONCE, under the nation
  it belongs to most — the winner of a match, the side the incident concerns —
  and leave the other nation out unless it has a separate story of its own.
- **Most important first.** Order the list by how much the wider rugby world
  would care.
- British English (en-GB). No kickoff times, dates or timezones. Dry sports
  desk register — no hype.

## Output — strict JSON, nothing else

{"highlights": [{"team": "<nation exactly as headed above>", "text": "<one sentence, ≤25 words>"}]}`;
}

const terminal = (s) => (/[.!?…”"']$/.test(s) ? s : `${s}.`);

// Shape + fidelity gate. Anything the model got wrong is dropped, never
// repaired: a missing nation in the roundup costs nothing, a wrong one
// misinforms twelve tabs at once.
export function parseWorldHighlights(raw, candidates) {
  const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
  const byName = new Map(candidates.map((c) => [c.team.toLowerCase(), c]));
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const c = byName.get(String(item.team ?? "").trim().toLowerCase());
    if (!c || seen.has(c.teamId)) continue;
    let text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    // Strip a leading "England —" / "England:" the prompt asked it not to write;
    // the app body prints the label itself.
    text = text.replace(new RegExp(`^${c.team}\\s*[—–:-]\\s*`, "i"), "");
    const n = words(text);
    if (n < ITEM_MIN_WORDS || n > ITEM_MAX_WORDS) continue;
    if (bannedCopyIn(text)) continue;
    // Numbers are the cheapest fabrication to catch: a score, a cap count or a
    // points total that the source edition never printed is invented.
    const sourceNums = new Set(`${c.heading} ${c.body}`.match(/\d+/g) ?? []);
    if ((text.match(/\d+/g) ?? []).some((num) => !sourceNums.has(num))) continue;
    seen.add(c.teamId);
    out.push({ teamId: c.teamId, team: c.team, text: terminal(text) });
    if (out.length >= WORLD_MAX_ITEMS) break;
  }
  return out;
}

// The per-team section: everyone's highlights except this team's own, or null
// when nothing is left (the reader's own story is already the edition).
export function worldSection(highlights, teamId) {
  const others = (highlights ?? []).filter((h) => h.teamId !== Number(teamId));
  if (!others.length) return null;
  const names = others.map((h) => h.team);
  const named = names.length <= 3 ? names : names.slice(0, 3);
  const rest = names.length - named.length;
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  const heading = rest ? `Headlines from ${named.join(", ")} and ${rest} more` : `Headlines from ${list}`;
  return {
    kicker: WORLD_KICKER,
    heading,
    body: others.map((h) => `${h.team} — ${h.text}`).join(" "),
  };
}

// Append the roundup to each of today's editions. Only TODAY's — a team whose
// edition failed keeps yesterday's, and yesterday's roundup belongs with it.
export function attachWorldSections(generated, highlights) {
  return Object.fromEntries(
    Object.entries(generated).map(([id, digest]) => {
      const section = digest?.sections ? worldSection(highlights, id) : null;
      if (!section) return [id, digest];
      // Idempotent: a re-run over a digest that already carries one replaces it.
      const own = digest.sections.filter((s) => s?.kicker !== WORLD_KICKER);
      return [id, { ...digest, sections: [...own, section] }];
    }),
  );
}

// The one model call. `callModel(prompt) → text`; `extractJson(text) → object`.
// Throws on an unusable answer; the caller treats that as "no roundup today".
export async function worldRoundup(callModel, extractJson, candidates, dateISO) {
  if (candidates.length < 2) return [];
  const raw = extractJson(await callModel(buildWorldPrompt(candidates, dateISO)));
  if (!raw || !Array.isArray(raw.highlights)) throw new Error("roundup returned no usable JSON");
  return parseWorldHighlights(raw, candidates);
}
