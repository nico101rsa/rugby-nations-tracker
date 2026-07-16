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
// (17567) is deliberately absent — SportsAPI Pro already covers it, and
// duplicating it would only exercise the dedupe path.
const ESPN_LEAGUES = {
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
  return {
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
  const seen = new Set(vendorNext.map(key));
  const extra = espnEntries.filter((e) => !seen.has(key(e)));
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

// All future ESPN fixtures per tracked-team code: { RSA: [entry, ...], ... }.
// Covers the current + next calendar year in each supplement league.
export async function fetchEspnFixtures(now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const seasons = [year, year + 1];
  const eventCache = new Map(); // event $ref -> event JSON (each fixture appears for both teams)
  const nameCache = new Map(); // untracked ESPN team id -> displayName

  const byCode = Object.fromEntries(Object.keys(ESPN_TEAM_IDS).map((c) => [c, []]));
  for (const [code, teamId] of Object.entries(ESPN_TEAM_IDS)) {
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
          const entry = espnEntry(event, code, leagueName, (oppId) => nameCache.get(oppId) ?? null);
          if (!entry) continue;
          if (!entry.tracked && entry.opponent == null) {
            const oppRef = event.competitions[0].competitors.find(
              (c) => teamIdFromRef(c.team?.$ref) !== String(teamId),
            )?.team?.$ref;
            const team = oppRef ? await getJson(oppRef) : null;
            const oppId = teamIdFromRef(oppRef);
            if (team?.displayName && oppId) nameCache.set(oppId, team.displayName);
            entry.opponent = team?.displayName ?? "Unknown";
          }
          byCode[code].push(entry);
        }
      }
    }
  }
  return byCode;
}
