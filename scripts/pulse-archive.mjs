// The full-time pulse, kept and put to work.
//
// The fans worker (fans-worker/) counts the votes and answers GET /pulse with
// the last six days of games. That is all the app needs, and it is all the
// worker gives: older games stop being returned. This script copies what the
// worker says into editorial/pulse.json and never forgets a game, so the repo
// holds every pulse there has been, and two readers have one file to read:
//
//   - the news writer: `pulseLine()` adds the fans' verdict to a team's "Last
//     result" fact (generate-digests.mjs, buildParams), so an edition can say
//     how the app's own readers took the game;
//   - Nico's morning email, in the app repo (scripts/owner_brief.py), which
//     checks this repo out and reads the same file.
//
// Run by .github/workflows/pulse-archive.yml every two hours. It writes only
// when a count changed, so a quiet week commits nothing.
//
//   node scripts/pulse-archive.mjs            fetch, merge, write if changed
//
// The counts are public already (anyone can ask the worker), so the file adds
// nothing private to a public repo. It holds counts only: the worker stores
// no names, addresses or install numbers, and none could reach here.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PULSE_FILE = join(ROOT, "editorial", "pulse.json");
export const PULSE_URL = "https://rugby-tracker-fans.4jc94jpbb7.workers.dev/pulse";

const MOODS = ["up", "flat", "down"];
const KEY_RE = /^\d{4}-\d{2}-\d{2} [A-Z]{3}-[A-Z]{3}$/;
const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

// Only what a pulse is made of survives: a well-formed key, three-letter
// sides, three whole counts. Anything else the worker (or a bad day) sends is
// dropped, so the file can't be made to carry text.
export function cleanMatches(matches) {
  const out = {};
  for (const [key, teams] of Object.entries(matches ?? {})) {
    if (!KEY_RE.test(key) || !teams || typeof teams !== "object") continue;
    const sides = {};
    for (const [code, c] of Object.entries(teams)) {
      if (!/^[A-Z]{3}$/.test(code) || !key.slice(11).split("-").includes(code)) continue;
      const row = Object.fromEntries(MOODS.map((m) => [m, count(c?.[m])]));
      if (MOODS.some((m) => row[m] > 0)) sides[code] = row;
    }
    if (Object.keys(sides).length) out[key] = sides;
  }
  return out;
}

// The worker's answer laid over what the file holds. A game the worker still
// returns takes the worker's counts (a changed mind can lower one); a game it
// has stopped returning keeps its last counts for good. Keys come out sorted,
// so the file is stable and a no-change run is byte-identical.
export function mergePulse(existing, fetched) {
  const merged = { ...cleanMatches(existing?.matches), ...cleanMatches(fetched) };
  return Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
}

export const total = (c) => MOODS.reduce((n, m) => n + count(c?.[m]), 0);

// Whole percentages that add to exactly 100 (largest remainder): the same
// sum the app shows, so the email and the news never disagree with a phone.
export function percentages(c) {
  const n = MOODS.map((m) => count(c?.[m]));
  const t = n.reduce((a, b) => a + b, 0);
  if (!t) return null;
  const exact = n.map((v) => (v * 100) / t);
  const floor = exact.map(Math.floor);
  let left = 100 - floor.reduce((a, b) => a + b, 0);
  for (const [, i] of exact.map((v, i) => [v - floor[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1])) {
    if (left <= 0) break;
    floor[i] += 1;
    left -= 1;
  }
  return Object.fromEntries(MOODS.map((m, i) => [m, floor[i]]));
}

export const pulseKey = (dateIso, homeCode, awayCode) => {
  const t = Date.parse(dateIso);
  return Number.isNaN(t) ? null : `${new Date(t).toISOString().slice(0, 10)} ${homeCode}-${awayCode}`;
};

// A newsroom needs more answers than a result card does. The app shows a
// split from five; an edition may only quote one from this many, or "fans
// were furious" would rest on a handful of taps.
export const NEWS_MIN_VOTES = 30;
const WORDS = { up: "buzzing", flat: "meh", down: "fuming" };

// One sentence for the writer's trusted facts, or "" when there is nothing
// solid to say. It names the number who answered and where they answered, so
// the copy can't dress it up as a poll of the nation.
export function pulseLine(pulse, key, code, teamName) {
  const c = pulse?.matches?.[key]?.[code];
  const n = total(c);
  if (!key || n < NEWS_MIN_VOTES) return "";
  const p = percentages(c);
  const parts = MOODS.filter((m) => p[m] > 0).sort((a, b) => p[b] - p[a]).map((m) => `${p[m]}% ${WORDS[m]}`);
  return `In the app's full-time pulse (a one-tap answer from the app's own ${teamName} followers, not a poll), ${n} answered: ${parts.join(", ")}. If you mention it, say it is how fans in the app took it and give the number who answered`;
}

export async function readPulse(file = PULSE_FILE) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  let fetched;
  try {
    const res = await fetch(PULSE_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    fetched = (await res.json())?.matches;
    if (!fetched || typeof fetched !== "object") throw new Error("no matches in the answer");
  } catch (e) {
    // Silent tier: the pulse is decoration. The file keeps what it had.
    console.log(`pulse archive skipped: ${e.message}`);
    return;
  }
  const existing = await readPulse();
  const matches = mergePulse(existing, fetched);
  if (JSON.stringify(matches) === JSON.stringify(existing?.matches ?? {})) {
    console.log(`pulse archive: no change (${Object.keys(matches).length} games held)`);
    return;
  }
  await mkdir(dirname(PULSE_FILE), { recursive: true });
  await writeFile(PULSE_FILE, `${JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), matches }, null, 1)}\n`);
  const votes = Object.values(matches).reduce((n, teams) => n + Object.values(teams).reduce((a, c) => a + total(c), 0), 0);
  console.log(`pulse archive: wrote ${Object.keys(matches).length} games, ${votes} answers in all`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
