// League-wide fixture ingest for REGISTERED competitions (map #205).
//
// Why this exists: the per-team core-API ingest in fetch-espn-fixtures.mjs
// structurally cannot see a pool match between two untracked nations. It walks
// `.../teams/{id}/events` for the 12 tracked nations, so RWC 2027's Chile v
// Hong Kong is invisible to it — not filtered out, never fetched.
//
// This module goes the other way: for every competition in competitions.json,
// fetch that league's scoreboard across the competition's own window and take
// EVERY match in it. The site-API scoreboard is the endpoint that works
// league-wide; the core API's `/seasons/{y}/events` 404s, which is exactly why
// the other module is per-team.
//
// It also costs far less: the site API carries `team.id`, `displayName` and
// the venue inline, so there is no follow-up fetch per event and no per-team
// name resolution. One request per competition per 366-day slice.
//
// Events come out in the same `{ event, leagueName, comp, registered }` shape
// buildFixtures consumes, with `comp` taken FROM THE REGISTRY rather than
// re-derived from the fixture's calendar year — a competition whose fixtures
// cross a new year would otherwise be tagged with two different comp keys and
// no longer match the registry the app filters by.

import { readFile } from "node:fs/promises";
import { sliceRange } from "./build-competitions.mjs";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/rugby";
const compact = (isoDate) => isoDate.replaceAll("-", "");

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// A competition's ingest window: its own fixture span, padded so fixtures
// added after the registry was last built (a knockout draw, a rescheduled
// game) are still picked up before the weekly rebuild notices them.
export const PAD_DAYS = 30;

const addDays = (isoDate, n) =>
  new Date(new Date(isoDate + "T00:00:00Z").getTime() + n * 86400000).toISOString().slice(0, 10);

export function windowFor(comp, pad = PAD_DAYS) {
  if (!comp.startDate || !comp.endDate) return null; // announced, no fixtures yet
  return { from: addDays(comp.startDate, -pad), to: addDays(comp.endDate, pad) };
}

// Registry -> the competitions worth fetching. `announced` entries have no
// fixtures to fetch; that gap is the watcher's job (#206), not this module's.
export function ingestable(registry) {
  return (registry?.competitions ?? []).filter((c) => c.fixtureCount > 0 && c.startDate && c.endDate);
}

// All matches in every registered competition, as buildFixtures tuples.
// Deduped by event id across competitions and slices.
//
// `since` keeps this to FUTURE fixtures, matching what fetchEspnEvents already
// does and what fixtures.json documents itself to be. Without it the league
// scoreboard also returns every completed match in the window — 33 of them
// today — which the app filters out client-side anyway (`upcomingFixtures`),
// so they would only triple the payload every user downloads. The one real
// behaviour change here is untracked-vs-untracked matches in registered
// competitions, not a change of what the file covers in time.
export async function fetchLeagueFixtures(registry, fetchJson = getJson, since = Date.now()) {
  const byId = new Map();
  const names = new Map(); // espn team id -> display name
  for (const comp of ingestable(registry)) {
    const win = windowFor(comp);
    for (const slice of sliceRange(win.from, win.to)) {
      const board = await fetchJson(
        `${SITE}/${comp.espnLeagueId}/scoreboard?dates=${compact(slice.from)}-${compact(slice.to)}`,
      );
      // A missing `events` array is not an empty one — ESPN answers 200 with a
      // stub body on several of these endpoints.
      for (const event of Array.isArray(board?.events) ? board.events : []) {
        if (event?.id == null || byId.has(String(event.id))) continue;
        if (new Date(event.date).getTime() < since) continue;
        for (const c of event.competitions?.[0]?.competitors ?? []) {
          const id = String(c.team?.id ?? "");
          if (id && c.team?.displayName) names.set(id, c.team.displayName);
        }
        byId.set(String(event.id), {
          event,
          leagueName: comp.name,
          // From the registry, not re-derived from the fixture's year.
          comp: { key: comp.key, label: comp.label, kind: "competition" },
          registered: true,
        });
      }
    }
  }
  return { events: [...byId.values()], names };
}

export async function loadRegistry(path = "competitions.json") {
  return JSON.parse(await readFile(path, "utf8"));
}
