// Supplements team-events.json's `next` fixtures with ESPN's keyless core
// API. SportsAPI Pro's next-events feed misses whole competitions (seen live:
// RSA's Aug–Sep 2026 tests vs NZL/ARG/AUS were absent while the 2027 World
// Cup was present), so upcoming fixtures come from BOTH vendors, merged and
// deduped per team. ESPN is keyless — no quota impact on the SportsAPI tier.
//
// Endpoint shape (verified 2026-07-16): only PER-TEAM season events work —
//   sports.core.api.espn.com/v2/sports/rugby/leagues/{lg}/seasons/{y}/teams/{id}/events
// (league-wide /seasons/{y}/events 404s). Each item is a $ref to the event;
// event fetches are cached across teams since every fixture appears twice.
// Scores are never fetched — this module only supplies FUTURE fixtures.

// ESPN team ids differ from every other vendor's; fixed field, so hardcoded.
export const ESPN_TEAM_IDS = {
  ENG: 1, SCO: 2, IRE: 3, WAL: 4, RSA: 5, AUS: 6,
  NZL: 8, FRA: 9, ARG: 10, FIJ: 14, ITA: 20, JPN: 23,
};

const CODE_NAMES = {
  ENG: "England", SCO: "Scotland", IRE: "Ireland", WAL: "Wales",
  RSA: "South Africa", AUS: "Australia", NZL: "New Zealand", FRA: "France",
  ARG: "Argentina", FIJ: "Fiji", ITA: "Italy", JPN: "Japan",
};

const ID_TO_CODE = Object.fromEntries(Object.entries(ESPN_TEAM_IDS).map(([c, id]) => [String(id), c]));

// Leagues that carry internationals ESPN-side. The Nations Championship
// (17567) IS included even though SportsAPI Pro covers those fixtures:
// its duplicates are dropped by mergeNext's dedupe, but their venue is
// backfilled onto the kept vendor entry (the vendor feed has no venues).
const ESPN_LEAGUES = {
  17567: "Nations Championship",
  289234: "International Test Match",
  244293: "The Rugby Championship",
  180659: "Six Nations",
};

const teamIdFromRef = (ref) => (String(ref ?? "").match(/\/teams\/(\d+)/) ?? [])[1] ?? null;

// One ESPN event -> our published fixture shape, from `code`'s side.
// Returns null when the event doesn't involve that team. `resolveName`
// supplies a display name for opponent ids outside the 12 tracked nations.
export function espnEntry(event, code, leagueName, resolveName) {
  const comp = event.competitions?.[0];
  if (!comp) return null;
  const sides = {};
  for (const c of comp.competitors ?? []) {
    sides[c.homeAway] = teamIdFromRef(c.team?.$ref);
  }
  const ourId = String(ESPN_TEAM_IDS[code]);
  const home = sides.home === ourId;
  if (!home && sides.away !== ourId) return null;
  const oppId = home ? sides.away : sides.home;
  const oppCode = ID_TO_CODE[oppId] ?? null;
  const v = comp.venue;
  const venue = v?.fullName
    ? v.address?.city && v.address.city !== v.fullName
      ? `${v.fullName}, ${v.address.city}`
      : v.fullName
    : null;
  return {
    venue,
    id: `espn-${event.id}`,
    date: event.date,
    league: leagueName,
    opponent: oppCode ? CODE_NAMES[oppCode] : resolveName(oppId),
    opponentCode: oppCode,
    tracked: oppCode != null,
    homeAway: home ? "H" : "A",
    us: null,
    them: null,
    result: null,
  };
}

// Vendor `next` + ESPN fixtures -> one future-only, deduped, sorted list.
// Dedupe key is UTC day + opponent (case-insensitive) so the same fixture
// from both vendors collapses; the vendor entry wins (stable ids, and its
// league strings match the rest of the file).
export function mergeNext(vendorNext, espnEntries, now = Date.now(), cap = 10) {
  const key = (e) => `${String(e.date).slice(0, 10)}|${(e.opponent ?? "").toLowerCase()}`;
  const vendorByKey = new Map(vendorNext.map((e) => [key(e), e]));
  const extra = [];
  for (const e of espnEntries) {
    const dup = vendorByKey.get(key(e));
    // Duplicate of a vendor fixture: keep the vendor entry but backfill the
    // venue (the vendor feed has none).
    if (dup) {
      if (dup.venue == null && e.venue != null) dup.venue = e.venue;
    } else {
      extra.push(e);
    }
  }
  return [...vendorNext, ...extra]
    .filter((e) => new Date(e.date).getTime() >= now)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .slice(0, cap);
}

const BASE = "https://sports.core.api.espn.com/v2/sports/rugby/leagues";

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null; // no such season/team combo — empty
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Raw future ESPN events across all supplement leagues, deduped by event id
// (each fixture appears in both teams' feeds): { events, names } where
// events = [{ event, leagueName }] and names maps untracked ESPN team ids
// to display names. Covers the current + next calendar year.
export async function fetchEspnEvents(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const seasons = [year, year + 1];
  const eventCache = new Map(); // event $ref -> event JSON
  const byId = new Map(); // event id -> { event, leagueName }
  const names = new Map(); // untracked ESPN team id -> displayName

  for (const teamId of Object.values(ESPN_TEAM_IDS)) {
    for (const [league, leagueName] of Object.entries(ESPN_LEAGUES)) {
      for (const season of seasons) {
        const list = await getJson(`${BASE}/${league}/seasons/${season}/teams/${teamId}/events?limit=100`);
        for (const item of list?.items ?? []) {
          let event = eventCache.get(item.$ref);
          if (!event) {
            event = await getJson(item.$ref);
            eventCache.set(item.$ref, event);
          }
          if (!event || new Date(event.date).getTime() < now) continue;
          if (!byId.has(event.id)) byId.set(event.id, { event, leagueName });
          // Resolve display names for any untracked side once.
          for (const c of event.competitions?.[0]?.competitors ?? []) {
            const id = teamIdFromRef(c.team?.$ref);
            if (id && !ID_TO_CODE[id] && !names.has(id)) {
              const team = await getJson(c.team.$ref);
              if (team?.displayName) names.set(id, team.displayName);
            }
          }
        }
      }
    }
  }
  return { events: [...byId.values()], names };
}

// All future ESPN fixtures per tracked-team code: { RSA: [entry, ...], ... }.
export async function fetchEspnFixtures(now = Date.now(), prefetched = null) {
  const { events, names } = prefetched ?? (await fetchEspnEvents(now));
  const byCode = Object.fromEntries(Object.keys(ESPN_TEAM_IDS).map((c) => [c, []]));
  for (const code of Object.keys(ESPN_TEAM_IDS)) {
    for (const { event, leagueName } of events) {
      const entry = espnEntry(event, code, leagueName, (oppId) => names.get(oppId) ?? null);
      if (!entry) continue;
      if (!entry.tracked && entry.opponent == null) entry.opponent = "Unknown";
      byCode[code].push(entry);
    }
  }
  return byCode;
}
