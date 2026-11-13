// Scrapes try counts per match from ESPN's free JSON API (no key needed) —
// the api-sports plan doesn't expose tries, and the log needs them for the
// 4-try bonus point. League id 17567 is the Nations Championship (verified
// in the data-harvester spec, docs/superpowers/specs/).
//
// Counts arrive from the event summary's scoring details: entries typed
// "try" or "penalty try" (both count toward the bonus). Results are cached
// in scripts/match-tries.json keyed by *api-sports* game id, so already-
// scraped matches never refetch and offline rebuilds keep working.
//
// This is the FIRST read, and it can be short: ESPN's rows missed a try in
// five of the first 24 games of 2026. try-counts.mjs lays the reconciled box
// score over it as soon as stats.json has one.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkTries, readStats } from "./try-counts.mjs";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/rugby/17567";
const CACHE = join(dirname(fileURLToPath(import.meta.url)), "match-tries.json");

const utcDay = (iso) => iso.slice(0, 10).replaceAll("-", ""); // YYYYMMDD
const minute = (iso) => new Date(iso).toISOString().slice(0, 16); // match key
const norm = (name) => name.toLowerCase().trim();

async function espn(path) {
  const r = await fetch(`${ESPN}/${path}`);
  if (!r.ok) throw new Error(`ESPN ${path}: ${r.status}`);
  return r.json();
}

// Exported for espn-tries.mjs, which counts every other competition's tries
// from the same ESPN summary shape — one counting rule, not two.
export function countTries(details, homeId) {
  const t = { home: 0, away: 0 };
  for (const d of details || []) {
    if (!/^(penalty )?try$/i.test(d.type?.text || "")) continue;
    t[String(d.team?.id) === String(homeId) ? "home" : "away"]++;
  }
  return t;
}

// finished: slim/raw api-sports games (needs id, date, home team name).
// Returns { [apiSportsGameId]: { home, away } }, updating the JSON cache.
export async function scrapeTries(finished) {
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch { /* first run */ }

  const todo = finished.filter((g) => !cache[g.id]);
  const byDay = {};
  for (const g of todo) (byDay[utcDay(g.date)] ??= []).push(g);

  for (const [day, games] of Object.entries(byDay)) {
    try {
      const sb = await espn(`scoreboard?dates=${day}`);
      for (const g of games) {
        const homeName = norm(g.teams?.home?.name ?? g.home?.name ?? "");
        const ev = (sb.events || []).find((e) => {
          const home = e.competitions?.[0]?.competitors?.find((c) => c.homeAway === "home");
          return minute(e.date) === minute(g.date) && norm(home?.team?.displayName || "") === homeName;
        });
        if (!ev || !ev.status?.type?.completed) continue;
        const summary = await espn(`summary?event=${ev.id}`);
        const comp = summary.header?.competitions?.[0];
        const homeId = comp?.competitors?.find((c) => c.homeAway === "home")?.id;
        const details = comp?.details;
        if (!details?.length || homeId == null) continue;
        cache[g.id] = countTries(details, homeId);
        console.log(`tries: game ${g.id} (${g.teams?.home?.name ?? g.home?.name}) → ${cache[g.id].home}-${cache[g.id].away} (ESPN ${ev.id})`);
      }
    } catch (e) {
      console.warn(`try scrape failed for ${day}: ${e.message} — using cached counts`);
    }
  }

  await writeFile(CACHE, JSON.stringify(cache, null, 2));
  // The log is built from the checked counts: where stats.json has a
  // reconciled box score, its count replaces the row count above
  // (try-counts.mjs has the why). The file keeps the first read here; the
  // `node scripts/try-counts.mjs` step that follows in refresh-data writes the
  // correction and raises it, so one place does both.
  return checkTries(cache, await readStats()).cache;
}
