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
// Four, not eight. The first live edition (2026-09-21) ran six 20-word
// sentences as one 130-word paragraph — a wall on a phone. Nico's brief:
// less is more. Top story is the heading, the rest a two-or-three-line body.
export const WORLD_MAX_ITEMS = 4;
// The gate and the checker see up to this many lines; the publish cap is
// applied AFTER checking, so a good line further down fills a gap left by a
// bad one above it. The 22:26 run on 2026-09-21 wrote ten lines, the gate kept
// the first four, the checker removed three, and six perfectly good lines
// were never looked at.
export const PARSE_CAP = 10;
const ITEM_MIN_WORDS = 4;
const ITEM_MAX_WORDS = 16; // the prompt asks for ≤12; this is the hard gate

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

// Men's senior internationals are the app's default, so any other story must
// say what it is. Shared by the code guard below and the checker prompt.
export const NON_MENS = /\b(women'?s?|Red Roses|Black Ferns|Wallaroos|WXV|U-?20s?|under[- ]?20s?|sevens|7s|academy|schools?)\b/i;

// What counts as the LABEL on a roundup line: a generic qualifier, or the
// subject nation's own women's-side name. "Wallaroos" in a France line names
// the opponent, not the side the story is about, so it is not France's label
// — the 20:23 run on 2026-09-21 let exactly that through to the checker.
const GENERIC_LABEL = /\b(women'?s?|U-?20s?|under[- ]?20s?|sevens|7s|academy|schools?)\b/i;
const WOMENS_SIDE = { England: /\bRed Roses\b/i, "New Zealand": /\bBlack Ferns\b/i, Australia: /\bWallaroos\b/i };
export function labelledNonMens(text, team) {
  return GENERIC_LABEL.test(text) || Boolean(WOMENS_SIDE[team]?.test(text));
}

// `notes` are the standing roundup notes the nightly review keeps
// (editorial/world-notes.md) — the same self-tuning loop the writer has.
export function buildWorldPrompt(candidates, dateISO, notes = "") {
  const blocks = candidates
    .map((c) => `### ${c.team}\n${c.heading}\n${c.body}`)
    .join("\n\n");
  const notesBlock = notes
    ? `\n\n## Standing notes (from previous days' reviews — follow them)\n${notes}`
    : "";
  return `You are the wire editor for Rugby Nations Tracker, an iOS app covering men's
international rugby. Each of the ${candidates.length} nations below has a daily
briefing, already written and fact-checked (${dateISO}). You write the
"Around the world" roundup that closes each briefing: the notable stories from
the OTHER nations, one short line per nation.

## Today's briefings (your ONLY source — add nothing)

${blocks}

## Rules

Less is more. The reader is on their phone; the roundup must scan in five
seconds. At most FOUR lines are published, best first. Offer up to six
candidates in order of importance — only the top four that pass checking
appear, so a fifth and sixth are the spares that fill a gap, never padding
the reader sees. Zero is fine on a dead day.

- **Only news a fan of ANOTHER team would text a mate about**: a result or
  trophy, a selection bombshell, a serious injury to a key player, a coach
  hired, sacked or banned, a big-name signing or retirement. NEVER a pundit's
  or ex-player's opinion, a coach's mild quote, a debate piece, rotation
  news, or "building for the weekend" copy — if the story is somebody
  saying something rather than something happening, leave it out.
- **Headline register, at most 12 words.** Write it like a back-page
  headline, not a sentence from the body: subject, verb, what happened.
  Name the nation or its team in the line ("Japan beat Fiji…", "Wallabies
  recall Petaia…", "England's 39-match run ends…"). No subordinate clauses,
  no venue unless the venue is the story, no more than one number (a
  scoreline counts as one). Present tense, no full stop needed.
- **Compress, never add.** Every fact, name and number must come from that
  nation's briefing above. No outside knowledge, no numbers the briefing
  does not contain. Names and diacritics verbatim. No quotation marks.
- **Men's senior internationals are the default.** If a story is about
  women's rugby, an age-grade side, sevens or a club, the line must say so
  ("England women's 39-match run ends…", "Red Roses…", "France U20…"). A
  reader who sees "England drew with Canada" assumes the men. Never
  drop the label to save words.
- **One story, once.** Two briefings often cover the same match from each
  side. Write it ONCE, under the winner or the side the incident concerns.
- **Most important first.** The first line becomes the section heading.
- British English (en-GB). No kickoff times, dates or timezones. No hype.

## Output — strict JSON, nothing else

{"highlights": [{"team": "<nation exactly as headed above>", "text": "<headline, ≤12 words>"}]}${notesBlock}`;
}

const terminal = (s) => (/[.!?…”"']$/.test(s) ? s : `${s}.`);

// Shape + fidelity gate. Anything the model got wrong is dropped, never
// repaired: a missing nation in the roundup costs nothing, a wrong one
// misinforms twelve tabs at once.
export function parseWorldHighlights(raw, candidates) {
  return parseWorldHighlightsDetailed(raw, candidates).kept.slice(0, WORLD_MAX_ITEMS);
}

// Same gate, but it also says WHY each line failed — the revision feedback
// and the run report both need the reason, not just the absence.
export function parseWorldHighlightsDetailed(raw, candidates) {
  const list = Array.isArray(raw?.highlights) ? raw.highlights : [];
  const byName = new Map(candidates.map((c) => [c.team.toLowerCase(), c]));
  const seen = new Set();
  const kept = [];
  const rejected = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const teamRaw = String(item.team ?? "").trim();
    const c = byName.get(teamRaw.toLowerCase());
    let text = typeof item.text === "string" ? item.text.replace(/\s+/g, " ").trim() : "";
    const reject = (problem) => rejected.push({ team: c?.team ?? teamRaw, text, problem });
    if (!c) { reject("not one of today's briefings"); continue; }
    if (seen.has(c.teamId)) { reject("second line for the same nation"); continue; }
    if (!text) { reject("empty line"); continue; }
    // A label the model wrote itself ("England — …", "England: …") is
    // redundant with the one labelled() adds; strip it.
    text = text.replace(new RegExp(`^${c.team}\\s*[—–:]\\s*`, "i"), "");
    const n = words(text);
    if (n < ITEM_MIN_WORDS || n > ITEM_MAX_WORDS) { reject(`${n} words (want 4-${ITEM_MAX_WORDS}, aim for 12)`); continue; }
    const banned = bannedCopyIn(text);
    if (banned) { reject(`contains ${banned}`); continue; }
    // Numbers are the cheapest fabrication to catch: a score, a cap count or a
    // points total that the source edition never printed is invented.
    const source = `${c.heading} ${c.body}`;
    const sourceNums = new Set(source.match(/\d+/g) ?? []);
    const badNum = (text.match(/\d+/g) ?? []).find((num) => !sourceNums.has(num));
    if (badNum) { reject(`the number ${badNum} is not in the ${c.team} briefing`); continue; }
    // A briefing that says it is about the women's side / U20s / sevens must
    // not be shortened into a line that reads as the men's team.
    if (NON_MENS.test(source) && !labelledNonMens(text, c.team)) {
      reject(`the ${c.team} briefing is about the women's / age-grade side and the line does not say so`);
      continue;
    }
    if (kept.length >= PARSE_CAP) { reject(`over the ${PARSE_CAP}-line parse cap`); continue; }
    seen.add(c.teamId);
    kept.push({ teamId: c.teamId, team: c.team, text: terminal(text) });
  }
  return { kept, rejected };
}

// The per-team section: everyone's highlights except this team's own, or null
// when nothing is left (the reader's own story is already the edition).
//
// Shape follows the app's own story card: the biggest story elsewhere IS the
// heading (the bold line a scanning thumb stops on), and the remaining one to
// three headlines make the body. The first live edition put a list-of-names
// heading over a six-sentence paragraph and read as a wall; this is the
// opposite of that.
// How a nation is named in copy: the country, or the side's nickname. Used
// both to decide whether a line already says whose story it is (no prefix
// needed for "Wallabies recall Petaia…") and to spot a line about the reader.
const NICKNAMES = {
  "South Africa": ["Springboks", "Boks"],
  Australia: ["Wallabies"],
  "New Zealand": ["All Blacks"],
  Argentina: ["Pumas"],
  Italy: ["Azzurri"],
  France: ["Les Bleus", "Bleus"],
  Japan: ["Brave Blossoms"],
  Fiji: ["Flying Fijians"],
  England: ["Red Roses"],
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function mentionsTeam(text, team) {
  if (!team) return false;
  const names = [team, ...(NICKNAMES[team] ?? [])].map(esc).join("|");
  return new RegExp(`\\b(?:${names})(?:['’]s)?\\b`, "i").test(text);
}

// `teamName` and `ownStory` (the reader's own edition text), when given, also
// drop a line that is the reader's own story told from the other side: the
// line names the reader AND the reader's edition names that nation. "Japan
// beat Fiji 20-15" sits under Fiji's own account of the final, so it goes;
// "Wallabies recall Petaia for Springboks Test" on the Boks tab stays, since
// the Boks edition that day was about Du Toit going home, not the Wallabies.
export function worldSection(highlights, teamId, teamName = "", ownStory = "") {
  const others = (highlights ?? []).filter((h) =>
    h.teamId !== Number(teamId) && !(mentionsTeam(h.text, teamName) && mentionsTeam(ownStory, h.team)));
  if (!others.length) return null;
  const [top, ...rest] = others.map(labelled);
  return {
    kicker: WORLD_KICKER,
    heading: top.replace(/\.$/, ""),
    body: rest.join(" "),
  };
}

// The prompt asks every line to name its nation or team. When the model
// forgets ("Defence coach Shaun Edwards confirms a 2027 return"), the reader
// must still be told whose story it is, so the nation is prefixed. A line
// that already carries the name — "Japan", "England's", "New Zealand's" —
// is left alone: the first live run printed "Japan — Japan secured…" for
// half its list, which is exactly the doubling this avoids.
function labelled(h) {
  return mentionsTeam(h.text, h.team) ? h.text : `${h.team}: ${h.text}`;
}

// Append the roundup to each of today's editions. Only TODAY's — a team whose
// edition failed keeps yesterday's, and yesterday's roundup belongs with it.
export function attachWorldSections(generated, highlights, teams = {}) {
  return Object.fromEntries(
    Object.entries(generated).map(([id, digest]) => {
      const own = digest?.sections?.[0] ? `${digest.sections[0].heading ?? ""} ${digest.sections[0].body ?? ""}` : "";
      const section = digest?.sections ? worldSection(highlights, id, teams[id]?.name ?? "", own) : null;
      if (!section) return [id, digest];
      // Idempotent: a re-run over a digest that already carries one replaces it.
      const story = digest.sections.filter((s) => s?.kicker !== WORLD_KICKER);
      return [id, { ...digest, sections: [...story, section] }];
    }),
  );
}

// Fact-check of the roundup, in a fresh context, against the editions it was
// cut from. Same posture as the edition checker: only a material error costs
// a line, and the remedy is to DROP the line, never rewrite it — a missing
// nation costs nothing, a wrong one misinforms every tab.
export function buildWorldCheckPrompt(highlights, candidates, dateISO) {
  const byId = new Map(candidates.map((c) => [c.teamId, c]));
  const pairs = highlights.map((h) => {
    const c = byId.get(h.teamId);
    return `### ${h.team}\nRoundup line: ${h.text}\nSource briefing: ${c?.heading ?? ""} — ${c?.body ?? ""}`;
  }).join("\n\n");
  return `You are the fact-checker for the "Around the world" roundup in Rugby Nations
Tracker, an iOS app covering MEN'S international rugby (${dateISO}). Each
roundup line below was cut from that nation's daily briefing, which is its
ONLY permitted source. Check each line against its briefing.

${pairs}

## Material errors — flag these
- a fact, name, score or number in the line that the briefing does not
  contain, or that the briefing contradicts;
- the line attributed to the wrong nation or side;
- a rumour or expectation in the briefing stated as settled fact in the line.

## Not errors — never flag these
- compression, paraphrase, present tense, a dropped venue or detail;
- a line that names the team by nickname (Wallabies, Boks, All Blacks);
- whether the line carries a "women's" / "U20" / "sevens" label — that is
  checked in code before you see it, and every line here already passed;
  never flag a line for a missing or a present label;
- style, word choice, or a line you would merely have written differently.

One more rule: **the briefing is the authority.** You are checking
line-against-briefing, not briefing-against-reality. If the briefing names a
coach, a score or a date, the line may repeat it, whatever you believe to be
true — the briefing already passed its own fact-check against the day's
press, and your knowledge is older than the press. Never reject a line on
outside knowledge: on 2026-09-22 a line was wrongly removed because the
checker "knew" Les Kiss was not the Wallabies coach; the briefing said he
was, and it was right.

## Output — strict JSON, nothing else
{"issues": [{"team": "<nation>", "problem": "<what is wrong>", "severity": "material" | "minor"}]}
Empty issues array if every line is clean. When unsure, severity is "minor".`;
}

// Drop every highlight the checker flagged as material. Minor issues are
// dropped on the floor, as they are for editions.
export function applyWorldCheck(highlights, raw) {
  const issues = (Array.isArray(raw?.issues) ? raw.issues : [])
    .filter((i) => i && typeof i === "object" && i.severity === "material" && typeof i.team === "string");
  const bad = new Map(issues.map((i) => [i.team.trim().toLowerCase(), String(i.problem ?? "").slice(0, 200)]));
  const kept = [];
  const dropped = [];
  for (const h of highlights) {
    const problem = bad.get(h.team.toLowerCase());
    if (problem == null) kept.push(h);
    else dropped.push({ team: h.team, text: h.text, problem });
  }
  return { kept, dropped };
}

// The roundup: write, gate, check, then publish the top four survivors —
// and ONE revision when something failed AND fewer than four survived,
// carrying every reason back to the writer (the same bounded loop the
// editions get). Without it the 20:23 run on 2026-09-21 published a
// one-line roundup: the checker removed three of four lines for a missing
// "women" label the writer could have added in a second pass. Whatever still
// fails after the revision is dropped, never rewritten by hand. Survivors
// below the cut are not failures; they are reported as `unused`.
//
// `callModel(prompt) → text`; `extractJson(text) → object`. Throws when the
// WRITER answers nothing usable (the caller treats that as "no roundup
// today"); a checker that answers nothing usable is logged and the roundup
// ships unchecked, since every line was cut from copy that already passed
// its own fact-check.
export async function worldRoundup(callModel, extractJson, candidates, dateISO, { notes = "" } = {}) {
  if (candidates.length < 2) return { highlights: [], dropped: [], unused: [], checked: false, revised: false };
  const prompt = buildWorldPrompt(candidates, dateISO, notes);

  // One pass: write (with optional feedback), gate in code, fact-check.
  const pass = async (feedback) => {
    const raw = extractJson(await callModel(feedback ? `${prompt}\n\n${feedback}` : prompt));
    if (!raw || !Array.isArray(raw.highlights)) throw new Error("roundup returned no usable JSON");
    const { kept, rejected } = parseWorldHighlightsDetailed(raw, candidates);
    if (!kept.length) return { kept, dropped: rejected, checked: false };
    const verdict = extractJson(await callModel(buildWorldCheckPrompt(kept, candidates, dateISO)));
    if (!verdict || !Array.isArray(verdict.issues)) return { kept, dropped: rejected, checked: false };
    const checked = applyWorldCheck(kept, verdict);
    return { kept: checked.kept, dropped: [...rejected, ...checked.dropped], checked: true };
  };

  let result = await pass();
  let revised = false;
  if (result.dropped.length && result.kept.length < WORLD_MAX_ITEMS) {
    const feedback = `## Your previous draft — these lines failed and were removed. Fix ALL of them.
${result.dropped.map((d) => `- ${d.team}: "${d.text}" — ${d.problem}`).join("\n")}
Rewrite the full roundup. Keep every line that was not listed above as it
was. For a listed line, either fix the exact problem (add the missing
"women" / "U20" label, remove the number the briefing does not contain, cut
the claim) or leave that nation out. Output the complete JSON again.`;
    try {
      result = await pass(feedback);
      revised = true;
    } catch {
      // The revision answered nothing usable — the first pass's survivors
      // still ship, and the run log says what was dropped.
    }
  }
  return {
    highlights: result.kept.slice(0, WORLD_MAX_ITEMS),
    unused: result.kept.slice(WORLD_MAX_ITEMS),
    dropped: result.dropped,
    checked: result.checked,
    revised,
  };
}
