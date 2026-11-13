// The Nations Championship try cache, checked against the box scores.
//
// Two files in this repo count the same tries:
//
//   scripts/match-tries.json   the first read. scrape-tries.mjs counts the
//                              "try" rows of ESPN's summary minutes after full
//                              time, so the try bonus lands with the score. It
//                              is kept as read and was never asked again.
//   stats.json                 the checked read. fetch-stats.mjs publishes a
//                              match only when its scoring events sum exactly
//                              to the final score (`reconciled`), from a second
//                              vendor, with ESPN re-read as a fallback.
//
// Until 13 Nov 2026 the table used only the first. A user wrote in that
// Scotland were on 11 points while the app showed 10: the cache held 3 tries
// for Scotland in Fiji 17-33 Scotland (18 Jul), stats.json held 5, and the try
// bonus point had been missing for four months. Four more games disagreed
// (New Zealand v Ireland, Australia v Italy, Argentina v England, France v
// Fiji: each a try short on one side or both), none of them across the
// 4-try line. In France v Fiji the missing try was a penalty try ESPN keeps in
// the score and leaves out of the rows.
//
// The rule: **a reconciled match's count replaces the cached one.** A count
// whose events add up to the score beats a count of rows. A match stats.json
// has not reconciled keeps the first read, and fetch-stats raises its own
// issue for a match that will not reconcile.
//
// Where it runs:
//   - scrapeTries (every build of nations.json `log`), so the log never sees
//     an unchecked count once the checked one exists;
//   - `node scripts/try-counts.mjs` on every refresh-data tick, before
//     build-standings, so a stats.json that landed since the last tick
//     corrects the cache and standings.json on a quiet tick too.
// Both write the cache, so the correction is made to the input and every
// reader (computeLog, build-standings) keeps reading one file.
//
// A correction that moves a try bonus point changed the table fans were
// shown, so it files a silent issue (notify.mjs) for the Claude review. One
// that only moves tries for/against is logged and nothing more.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { postIssue } from "./notify.mjs";
import { espnGate } from "./fetch-stats.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_PATH = join(ROOT, "scripts", "match-tries.json");
export const STATS_PATH = join(ROOT, "stats.json");

// The Nations Championship's try bonus (competition-rules.mjs `rnc`).
const BONUS_AT = 4;
const TRY_TYPES = new Set(["try", "penaltyTry"]);

// ---- Reading tries from an ESPN summary -------------------------------------
//
// Every competition's first read comes through here (scrape-tries.mjs for the
// Nations Championship, espn-tries.mjs for the rest), so it is checked the
// same way everywhere.

// The rows typed "try" or "penalty try", by team. This is the count as ESPN
// labels it, and the one that was short in 2026.
export function countTries(details, homeId) {
  const t = { home: 0, away: 0 };
  for (const d of details || []) {
    if (!/^(penalty )?try$/i.test(d.type?.text || "")) continue;
    t[String(d.team?.id) === String(homeId) ? "home" : "away"]++;
  }
  return t;
}

const tally = (scoring) => {
  const c = { home: 0, away: 0 };
  for (const e of scoring) if (TRY_TYPES.has(e?.type) && (e.team === "home" || e.team === "away")) c[e.team]++;
  return c;
};

// One game's tries from ESPN's summary competition (`header.competitions[0]`),
// and whether the count is proven.
//
//   { counts: { home, away }, checked }      or null when there are no rows
//
// `checked: true` means ESPN's scoring rows sum exactly to the final score we
// hold from the score feed (fetch-stats.mjs espnGate, penalty tries the rows
// leave out included), and the count is the tries in that list. Otherwise the
// count is the labelled rows and nothing vouches for it: a missing try and a
// missing penalty goal look the same from here. Home and away are ESPN's.
export function summaryTries(comp, homeFinal, awayFinal) {
  const details = Array.isArray(comp?.details) ? comp.details : [];
  if (!details.length) return null;
  const ids = (side) => {
    const c = comp?.competitors?.find((x) => x.homeAway === side);
    return [c?.id, c?.team?.id].filter((x) => x != null);
  };
  if (!ids("home").length) return null;
  const labelled = countTries(details, String(ids("home").at(-1)));
  if (homeFinal == null || awayFinal == null) return { counts: labelled, checked: false };
  const gate = espnGate(details, ids("home"), ids("away"), homeFinal, awayFinal);
  return gate.ok ? { counts: tally(gate.scoring), checked: true } : { counts: labelled, checked: false };
}

// ---- The Nations Championship cache against the box scores ------------------

// stats.json -> { [apiSportsGameId]: { home, away } } for reconciled matches
// only. A penalty try is a try, as everywhere else in this repo.
export function reconciledTries(stats) {
  const out = {};
  for (const m of stats?.matches ?? []) {
    if (!m?.reconciled || m.id == null || !Array.isArray(m.scoring)) continue;
    out[m.id] = tally(m.scoring);
  }
  return out;
}

const bonus = (n) => n >= BONUS_AT;

// The cache with every reconciled count laid over it, and what changed.
//
//   { cache, corrections: [{ id, label, was, now, bonusMoved }] }
//
// `was` is null for a game the cache never had (ESPN gave no rows): the
// checked count fills it and the table stops waiting on it. `cache` is the
// same object when nothing changed. Pure.
export function checkTries(cache, stats) {
  const checked = reconciledTries(stats);
  const labels = new Map((stats?.matches ?? []).map((m) => [String(m.id), `${m.home?.name ?? "?"} v ${m.away?.name ?? "?"} (${String(m.date ?? "").slice(0, 10)})`]));
  const corrections = [];
  for (const [id, now] of Object.entries(checked)) {
    const was = cache?.[id] ?? null;
    if (was && was.home === now.home && was.away === now.away) continue;
    corrections.push({
      id,
      label: labels.get(String(id)) ?? `game ${id}`,
      was,
      now,
      bonusMoved: bonus(was?.home ?? 0) !== bonus(now.home) || bonus(was?.away ?? 0) !== bonus(now.away),
    });
  }
  if (!corrections.length) return { cache, corrections };
  const next = { ...cache };
  for (const c of corrections) next[c.id] = c.now;
  return { cache: next, corrections };
}

const pair = (t) => (t ? `${t.home}-${t.away}` : "none");
export const correctionLine = (c) =>
  `tries: ${c.label}, game ${c.id}: cache ${pair(c.was)}, box score ${pair(c.now)}${c.bonusMoved ? " (moves a try bonus point)" : ""}`;

// A filled gap (was null) is the table catching up, not a table that was
// wrong: only a count that was published and crossed the bonus line is raised.
export const worthRaising = (corrections) => corrections.filter((c) => c.was && c.bonusMoved);

export function issueFor(raised) {
  return {
    title: `Table corrected: a try bonus point moved (${raised.map((c) => c.label).join("; ")})`.slice(0, 240),
    body: [
      "The Nations Championship table was showing a wrong try bonus point. The try cache disagreed with the reconciled box score in stats.json, and the box score's events add up to the final score, so the cache was corrected.",
      "",
      ...raised.map((c) => `- ${correctionLine(c)}`),
      "",
      "The table is rebuilt from the corrected cache on the next refresh (standings.json at once, nations.json `log` at the next six-hourly sweep or live window).",
      "",
      "For the review: confirm the box score against a match report, and check whether fans were shown the wrong points for long enough to say so.",
    ].join("\n"),
  };
}

const readJson = (p) => readFile(p, "utf8").then(JSON.parse);

// stats.json as it is on disk, or null: a missing or broken file checks
// nothing and never stops a table being built.
export const readStats = (path = STATS_PATH) => readJson(path).catch(() => null);

async function main() {
  const stats = await readStats();
  if (!stats) { console.log("tries: no stats.json to check against"); return; }
  const before = await readJson(CACHE_PATH).catch(() => ({}));
  const { cache, corrections } = checkTries(before, stats);
  if (!corrections.length) { console.log(`tries: cache agrees with all ${Object.keys(reconciledTries(stats)).length} reconciled box scores`); return; }
  for (const c of corrections) console.log(correctionLine(c));
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
  const raised = worthRaising(corrections);
  if (raised.length && process.env.GH_TOKEN) {
    try { await postIssue(issueFor(raised)); } catch (e) { console.log(`::warning::could not file the correction issue: ${e.message}`); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
