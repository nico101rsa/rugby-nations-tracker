// Enriches each team's `last` games in team-events.json with per-game TRIES
// and CARDS so the app's Team page can average all four stat tiles over the
// same last-10 window (Nico's ask, 2026-07-16). Two sources, no new secrets:
//
// - Nations Championship games: our own stats.json (same SportsAPI vendor —
//   its `eventId` matches team-events game ids; tries from the reconciled
//   `scoring` events, cards from the `cards` list). Unreconciled stubs are
//   skipped rather than trusted.
// - Rugby Championship / Six Nations (and any other league that carries
//   them): ESPN's keyless core API — the competitor `statistics` $ref.
//   Verified coverage 2026-07-16: TRC ✓, 6N ✓, NC ✗, Nov/Jul test windows ✗
//   (those games keep null tries/cards and the app drops them from those
//   averages — never fabricate a zero).

import { ESPN_TEAM_IDS } from "./fetch-espn-fixtures.mjs";

const ESPN_LEAGUES = [289234, 244293, 180659]; // tests, TRC, 6N

// Competitor statistics JSON -> { tries, cards } (null when absent).
export function extractEspnStats(statsJson) {
  const vals = {};
  for (const cat of statsJson?.splits?.categories ?? []) {
    for (const st of cat.stats ?? []) vals[st.name] = st.value;
  }
  const has = (k) => typeof vals[k] === "number";
  return {
    tries: has("tries") ? vals.tries + (has("penaltyTries") ? vals.penaltyTries : 0) : null,
    cards: has("yellowCards") || has("redCards") ? (vals.yellowCards ?? 0) + (vals.redCards ?? 0) : null,
  };
}

// stats.json -> Map(eventId -> { home: {tries,cards}, away: {...} }).
export function ncStatsByEventId(statsJson) {
  const map = new Map();
  for (const m of statsJson?.matches ?? []) {
    if (!m.reconciled || m.eventId == null) continue;
    const side = (s) => ({
      tries: (m.scoring ?? []).filter((e) => e.team === s && e.type === "try").length,
      cards: (m.cards ?? []).filter((e) => e.team === s).length,
    });
    map.set(m.eventId, { home: side("home"), away: side("away") });
  }
  return map;
}

// Mutates teams: sets tries/cards on every `last` game (null when no source).
export function enrichLast(teams, ncByEventId, espnByCodeDay) {
  for (const [code, t] of Object.entries(teams)) {
    for (const g of t.last ?? []) {
      const nc = ncByEventId.get(g.id);
      const espn = espnByCodeDay?.[code]?.get(String(g.date).slice(0, 10));
      const src = nc ? nc[g.homeAway === "H" ? "home" : "away"] : espn;
      g.tries = src?.tries ?? null;
      g.cards = src?.cards ?? null;
    }
  }
}

const BASE = "https://sports.core.api.espn.com/v2/sports/rugby/leagues";

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ESPN per-game stats for the days each team actually played:
// { RSA: Map("2025-09-27" -> { tries, cards }), ... }. Event JSONs are cached
// across teams (every fixture appears from both sides); stats are fetched
// only for needed days that have a statistics $ref.
export async function fetchEspnFormStats(neededDaysByCode, now = Date.now()) {
  const year = new Date(now).getUTCFullYear();
  const seasons = [year - 1, year];
  const eventCache = new Map();

  const out = {};
  for (const [code, teamId] of Object.entries(ESPN_TEAM_IDS)) {
    const needed = neededDaysByCode[code];
    out[code] = new Map();
    if (!needed || needed.size === 0) continue;
    for (const league of ESPN_LEAGUES) {
      for (const season of seasons) {
        const list = await getJson(`${BASE}/${league}/seasons/${season}/teams/${teamId}/events?limit=100`);
        for (const item of list?.items ?? []) {
          let event = eventCache.get(item.$ref);
          if (event === undefined) {
            event = await getJson(item.$ref);
            eventCache.set(item.$ref, event);
          }
          const day = event?.date?.slice(0, 10);
          if (!day || !needed.has(day) || out[code].has(day)) continue;
          const ours = event.competitions?.[0]?.competitors?.find(
            (c) => (c.team?.$ref ?? "").includes(`/teams/${teamId}?`),
          );
          if (!ours?.statistics?.$ref) continue;
          const stats = await getJson(ours.statistics.$ref);
          if (stats) out[code].set(day, extractEspnStats(stats));
        }
      }
    }
  }
  return out;
}
