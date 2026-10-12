// Per-match TRY COUNTS for every ESPN-scored competition game, cached in
// scripts/match-tries-espn.json — what build-standings.mjs needs for the try
// bonus and for the try-based tiebreaks (Six Nations tries scored, World Cup
// try difference). Keyless ESPN, zero api-sports / SportsAPI Pro quota.
//
// The Nations Championship is NOT here: its tries come from scrape-tries.mjs
// into scripts/match-tries.json keyed by api-sports game id, untouched. This
// cache is keyed by the fixtures.json row id ("espn-<eventId>"), so no
// scoreboard matching is needed — the id IS the ESPN event.
//
// For each finished, uncached competition row (oldest first):
//   1. GET site.api.espn.com/apis/site/v2/sports/rugby/<league>/summary?event=<n>.
//      It must say completed; tries are counted from the scoring `details`
//      with scrape-tries.mjs countTries ("try" and "penalty try", by team).
//   2. No details -> each competitor's `statistics.$ref` on the core-API
//      event, read with fetch-form-stats.mjs extractEspnStats (the path
//      verified for the Six Nations on 2026-07-16).
//   3. Neither -> stays uncached and a later run tries again.
// Never more than `max` summary fetches a run; an HTTP or JSON error is
// logged and skipped, never thrown. A run with nothing new scored makes ZERO
// requests — the no-op path costs nothing (CLAUDE.md).
//
// Who runs it, and how often a miss is retried. It runs before every
// build-standings: the daily team-events job (full backlog), every
// refresh-data tick and every 3-minute fixtures-burst pass (both with
// --recent). A game ESPN never gives try counts for — a league whose summary
// has no scoring details and whose statistics have no tries — would otherwise
// be re-asked on all of those, every 15 minutes (or 3) for as long as its
// result stays in fixtures.json. So --recent retries a miss only while the
// game is within RECENT_HOURS of kickoff (ESPN fills the details live, so the
// counts are normally there at full time); after that only the daily run
// asks again, at most `max` games a day.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countTries } from "./scrape-tries.mjs";
import { extractEspnStats } from "./fetch-form-stats.mjs";
import { ESPN_CODES } from "./build-competitions.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CACHE_PATH = join(ROOT, "scripts", "match-tries-espn.json");

const SITE = "https://site.api.espn.com/apis/site/v2/sports/rugby";
const CORE = "https://sports.core.api.espn.com/v2/sports/rugby/leagues";

export const RECENT_HOURS = 6;

const eventIdOf = (id) => (/^espn-(\d+)$/.exec(String(id ?? "")) ?? [])[1] ?? null;

// fixtures.json rows that need a fetch: competition games other than the
// Nations Championship, ESPN-keyed, with a final score, not live, not cached,
// in a registered competition that names its ESPN league. Oldest first, so a
// backlog drains in kickoff order under the `max` cap.
// `since` (epoch ms, optional): skip games that kicked off before it (--recent).
export function tryCandidates(fixtures, registry, cache = {}, { since = null } = {}) {
  const leagues = new Map((registry?.competitions ?? []).map((c) => [c.key, c.espnLeagueId]));
  const rows = Array.isArray(fixtures) ? fixtures : fixtures?.fixtures ?? [];
  const out = [];
  for (const f of rows) {
    if (f?.comp?.kind !== "competition") continue;
    if (String(f.comp.key ?? "").startsWith("rnc-")) continue;
    const n = eventIdOf(f.id);
    if (!n) continue; // seed-* rows have no ESPN event yet
    if (f.homeScore == null || f.awayScore == null) continue;
    if (f.status?.live) continue;
    if (Object.hasOwn(cache, f.id)) continue;
    if (since != null && !(Date.parse(f.date) >= since)) continue;
    const league = leagues.get(f.comp.key);
    if (league == null) continue;
    out.push({ row: f, eventId: n, league });
  }
  return out.sort((a, b) => String(a.row.date).localeCompare(String(b.row.date)) || (a.row.id < b.row.id ? -1 : 1));
}

async function defaultFetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const competitorTeamId = (c) => String(c?.team?.id ?? c?.id ?? "");

export async function fetchEspnTries({
  fixtures, registry, cache = {}, fetchJson = defaultFetchJson, max = 20,
  log = console, now = () => new Date(), recentHours = null,
} = {}) {
  const next = { ...cache };
  const since = recentHours == null ? null : now().getTime() - recentHours * 3600000;
  let fetched = 0;
  let summaries = 0;
  let cached = 0;
  for (const { row, eventId, league } of tryCandidates(fixtures, registry, cache, { since })) {
    if (summaries >= max) break;
    summaries++;
    fetched++;
    let summary;
    try {
      summary = await fetchJson(`${SITE}/${league}/summary?event=${eventId}`);
    } catch (e) {
      log.warn?.(`espn-tries: ${row.id} summary failed (${e.message}) — will retry next run`);
      continue;
    }
    const comp = summary?.header?.competitions?.[0];
    if (!comp?.status?.type?.completed) continue; // not final yet
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    if (!home || !away) continue;

    let counts = null;
    let source = null;
    if (Array.isArray(comp.details) && comp.details.length) {
      counts = countTries(comp.details, competitorTeamId(home));
      source = "summary";
    } else {
      try {
        fetched++;
        const ev = await fetchJson(`${CORE}/${league}/events/${eventId}`);
        const bySide = {};
        for (const c of ev?.competitions?.[0]?.competitors ?? []) {
          if (!c?.statistics?.$ref || (c.homeAway !== "home" && c.homeAway !== "away")) continue;
          fetched++;
          const tries = extractEspnStats(await fetchJson(c.statistics.$ref)).tries;
          if (typeof tries === "number") bySide[c.homeAway] = tries;
        }
        if (bySide.home != null && bySide.away != null) {
          counts = { home: bySide.home, away: bySide.away };
          source = "statistics";
        }
      } catch (e) {
        log.warn?.(`espn-tries: ${row.id} statistics failed (${e.message}) — will retry next run`);
      }
    }
    if (!counts) continue;

    // fixtures.json lists home/away as ESPN does, so this is a guard, not a
    // routine step: if ESPN's home side is our away side, swap.
    const espnHome = ESPN_CODES[competitorTeamId(home)];
    const espnAway = ESPN_CODES[competitorTeamId(away)];
    const flipped = espnHome && espnAway && espnHome === row.away?.code && espnAway === row.home?.code;
    const [h, a] = flipped ? [counts.away, counts.home] : [counts.home, counts.away];
    next[row.id] = { home: h, away: a, league, source, at: now().toISOString() };
    cached++;
    log.log?.(`espn-tries: ${row.id} ${row.home?.code} ${h}-${a} ${row.away?.code} tries (${source})`);
  }
  return { cache: next, fetched, cached };
}

// Sorted keys, so the file diff is only ever the new games.
export const serialiseCache = (cache) =>
  JSON.stringify(Object.fromEntries(Object.entries(cache).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))), null, 2) + "\n";

async function main() {
  const read = (p) => readFile(p, "utf8").then(JSON.parse);
  const [fixtures, registry] = await Promise.all([read(join(ROOT, "fixtures.json")), read(join(ROOT, "competitions.json"))]);
  const cache = await read(CACHE_PATH).catch(() => ({}));
  const recent = process.argv.includes("--recent");
  const { cache: next, fetched, cached } = await fetchEspnTries({ fixtures, registry, cache, recentHours: recent ? RECENT_HOURS : null });
  if (cached) await writeFile(CACHE_PATH, serialiseCache(next));
  console.log(`espn-tries: ${cached} new, ${fetched} fetches${recent ? ` (games from the last ${RECENT_HOURS}h)` : ""}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never fails the job: a missed run only delays a try bonus by one tick.
  main().catch((err) => console.error(`espn-tries: skipped — ${err.message}`));
}
