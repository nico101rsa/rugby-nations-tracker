// competitions.json — the registry every downstream surface reads (map #204).
// One entry per competition SEASON: what it is, when it runs, what shape its
// table has, and — crucially — WHEN IT IS THE DEFAULT SELECTION. The Fixtures
// dropdown and the Standings tab both read `defaultFrom`/`defaultUntil` from
// here so the +2-week handover rule is DATA, not date maths duplicated in two
// components.
//
// ⚠️ ESPN's own metadata is wrong in three separate ways, all verified live
// 2026-07-25. Nothing here trusts it:
//   1. Its `groups` endpoint reports RWC 2027 as 4 pools / 20 teams (the old
//      2023 format) while its fixtures describe the real 24-team, 6-pool draw.
//   2. The scoreboard's `leagues[0].season` for league 164205 reports year
//      **2023** with startDate 2023-09-08 / endDate 2023-10-29 — stale rows
//      from the previous World Cup. An earlier session recorded those as the
//      2027 dates. The real published fixtures run 2027-10-01 → 2027-10-17.
//   3. The core-API season record's span is a CALENDAR window, not the
//      competition window: league 17567 season 2026 reads 1 Jan → 1 Jan, and
//      244293 reads 20 Jul → 20 Jul. Only Six Nations happens to be honest.
// So the season record is used ONLY as a hint for where to look, and every
// published field — dates, structure, team set — is derived from the fixture
// records themselves.
//
// No pool/group LETTERS are emitted. ESPN carries none (`notes` is empty on
// every RWC event) and inventing "Pool A" would be a fabricated claim about
// the official draw. Groups come out ordered by earliest kickoff with
// `name: null`; naming them is the consuming tab's problem, not ours.

import { writeFile } from "node:fs/promises";
import { SEEDS, seededCompetition } from "./seed-competitions.mjs";

// The competitions the app tracks as competitions. "International Test Match"
// (league 289234) is deliberately absent — it is a bucket of one-off tests
// with no table, and build-fixtures.mjs already folds it into `kind: "test"`.
export const REGISTERED = [
  { prefix: "rnc", short: "RNC", name: "Nations Championship", espnLeagueId: 17567 },
  { prefix: "6n", short: "6N", name: "Six Nations", espnLeagueId: 180659 },
  { prefix: "trc", short: "TRC", name: "The Rugby Championship", espnLeagueId: 244293 },
  { prefix: "rwc", short: "RWC", name: "Rugby World Cup", espnLeagueId: 164205 },
];

// ESPN team id -> our 3-letter code. ESPN's own abbreviations disagree with
// ours for six nations (SOU/JAP/HON/SPA/ROM/TON), so the id is the join key —
// it is a fixed field, the abbreviation is presentation.
export const ESPN_CODES = {
  1: "ENG", 2: "SCO", 3: "IRE", 4: "WAL", 5: "RSA", 6: "AUS",
  8: "NZL", 9: "FRA", 10: "ARG", 14: "FIJ", 20: "ITA", 23: "JPN",
  11: "USA", 12: "ROU", 15: "SAM", 16: "TGA", 25: "CAN", 27: "POR",
  29: "URU", 81: "GEO", 289211: "ESP", 289243: "CHI", 289268: "HKG",
  289356: "ZIM",
};

// Used only to NAME the two sides of a conference once the graph has already
// proven the split. If any team in a side is unknown or the sides disagree,
// both names come out null rather than guessed.
const HEMISPHERE = {
  ENG: "North", SCO: "North", IRE: "North", WAL: "North", FRA: "North", ITA: "North",
  RSA: "South", AUS: "South", NZL: "South", ARG: "South", FIJ: "South", JPN: "South",
};

const iso = (d) => new Date(d).toISOString().slice(0, 10);
const addDays = (isoDate, n) => iso(new Date(isoDate + "T00:00:00Z").getTime() + n * 86400000);
const pairKey = (a, b) => [a, b].sort().join("|");

// ---------------------------------------------------------------------------
// The structure classifier
// ---------------------------------------------------------------------------
// Pure graph analysis over the fixture list. No model, so it cannot hallucinate
// a layout; when the graph doesn't match a known shape it returns UNKNOWN and
// the caller raises an issue rather than inventing a table.
//
//   complete graph                -> table       (Six Nations: 6 teams, 15 games)
//   complete bipartite graph      -> conference  (NC: 12 teams, 36 games, N v S)
//   N equal complete components   -> pools       (RWC: 24 teams, 36 games, 6x4)
//   anything else                 -> UNKNOWN
//
// `matches` is [{ teams: [idA, idB], date }]. Repeat meetings collapse to one
// edge: a double round robin is still a table, and multiplicity is not what
// distinguishes these three shapes.
export function classify(matches) {
  const nodes = [...new Set(matches.flatMap((m) => m.teams))];
  if (nodes.length < 2 || matches.length === 0) return { structure: "UNKNOWN", groups: null };

  const edges = new Set(matches.map((m) => pairKey(m.teams[0], m.teams[1])));
  const adj = new Map(nodes.map((n) => [n, new Set()]));
  for (const m of matches) {
    if (m.teams[0] === m.teams[1]) return { structure: "UNKNOWN", groups: null };
    adj.get(m.teams[0]).add(m.teams[1]);
    adj.get(m.teams[1]).add(m.teams[0]);
  }

  const components = connectedComponents(nodes, adj);
  const earliest = earliestByTeam(matches);
  const asGroup = (teams) => ({
    name: null,
    teams: [...teams].sort((a, b) => (earliest.get(a) ?? "") .localeCompare(earliest.get(b) ?? "")),
  });
  const orderGroups = (gs) =>
    gs
      .map(asGroup)
      .sort((a, b) => (earliest.get(a.teams[0]) ?? "").localeCompare(earliest.get(b.teams[0]) ?? ""));

  if (components.length === 1) {
    if (isComplete(nodes, edges)) return { structure: "table", groups: null };
    const sides = bipartition(nodes, adj);
    if (sides && isCompleteBipartite(sides, edges)) {
      return { structure: "conference", groups: orderGroups(sides) };
    }
    return { structure: "UNKNOWN", groups: null };
  }

  const size = components[0].length;
  const uniform = components.every((c) => c.length === size && isComplete(c, edges));
  if (uniform && size >= 3) return { structure: "pools", groups: orderGroups(components) };
  return { structure: "UNKNOWN", groups: null };
}

function connectedComponents(nodes, adj) {
  const seen = new Set();
  const out = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const comp = [];
    const stack = [n];
    seen.add(n);
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nb of adj.get(cur)) {
        if (!seen.has(nb)) (seen.add(nb), stack.push(nb));
      }
    }
    out.push(comp);
  }
  return out;
}

// Every pair among `group` has played.
function isComplete(group, edges) {
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (!edges.has(pairKey(group[i], group[j]))) return false;
    }
  }
  return true;
}

// Two-colour the graph; null if any edge joins same-coloured nodes (odd cycle).
function bipartition(nodes, adj) {
  const colour = new Map();
  for (const start of nodes) {
    if (colour.has(start)) continue;
    colour.set(start, 0);
    const stack = [start];
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of adj.get(cur)) {
        if (!colour.has(nb)) (colour.set(nb, 1 - colour.get(cur)), stack.push(nb));
        else if (colour.get(nb) === colour.get(cur)) return null;
      }
    }
  }
  const a = nodes.filter((n) => colour.get(n) === 0);
  const b = nodes.filter((n) => colour.get(n) === 1);
  return a.length && b.length ? [a, b] : null;
}

// Every cross-side pair has played (intra-side pairs are already ruled out by
// the two-colouring succeeding).
function isCompleteBipartite([a, b], edges) {
  for (const x of a) for (const y of b) if (!edges.has(pairKey(x, y))) return false;
  return true;
}

function earliestByTeam(matches) {
  const first = new Map();
  for (const m of [...matches].sort((x, y) => String(x.date).localeCompare(String(y.date)))) {
    for (const t of m.teams) if (!first.has(t)) first.set(t, String(m.date));
  }
  return first;
}

// ---------------------------------------------------------------------------
// The +2-week handover rule — the whole point of the registry
// ---------------------------------------------------------------------------
// A competition stays the default selection for TWO WEEKS after its last known
// fixture, then hands over to the next one. Chaining each comp's `defaultFrom`
// to the previous comp's `defaultUntil` means the calendar is PARTITIONED: no
// gaps (the between-seasons lull belongs to the competition coming up, so the
// app shows what's next rather than a blank) and no overlaps.
//
// Comps with no published fixtures are excluded — a default that resolves to
// an empty competition is a dead end. They stay in the registry so the watcher
// (#206) can notice the day their fixtures land.
export const TAIL_DAYS = 14;

export function chainDefaults(comps) {
  const dated = comps
    .filter((c) => c.startDate && c.endDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
  let prevUntil = null;
  for (const c of dated) {
    c.defaultFrom = prevUntil ?? c.startDate;
    c.defaultUntil = addDays(c.endDate, TAIL_DAYS);
    prevUntil = c.defaultUntil;
  }
  return comps;
}

// Which competition the app should show on a given day. Returns null when the
// date falls outside every window (before the first comp, or after the last).
export function defaultCompetition(comps, today = iso(Date.now())) {
  return comps.find((c) => c.defaultFrom && c.defaultFrom <= today && today < c.defaultUntil) ?? null;
}

// ---------------------------------------------------------------------------
// Registry assembly
// ---------------------------------------------------------------------------

// scheduled -> not started | live -> inside the window | complete -> finished
// announced -> a season record exists but ESPN has published no fixtures yet
// (Six Nations 2027 is in exactly this state, and is the watcher's first job).
export function statusFor(c, today) {
  if (!c.fixtureCount) return "announced";
  if (today < c.startDate) return "scheduled";
  if (today > c.endDate) return "complete";
  return "live";
}

// Raw scoreboard events -> one registry entry. Exported so the tests can drive
// it without the network.
export function entryFor(meta, season, events, today) {
  const matches = [];
  const teams = new Map(); // espn id -> code
  for (const e of events) {
    const comp = e.competitions?.[0];
    const sides = comp?.competitors ?? [];
    if (sides.length !== 2) continue;
    const ids = sides.map((s) => String(s.team?.id ?? ""));
    if (ids.some((id) => !id)) continue;
    for (const [i, id] of ids.entries()) {
      teams.set(id, ESPN_CODES[id] ?? sides[i].team?.abbreviation ?? id);
    }
    matches.push({ teams: ids, date: String(e.date ?? "").slice(0, 10) });
  }

  const dates = matches.map((m) => m.date).filter(Boolean).sort();
  const { structure, groups } = matches.length ? classify(matches) : { structure: "UNKNOWN", groups: null };
  const yy = String(season).slice(2);

  const entry = {
    key: `${meta.prefix}-${season}`,
    label: `${meta.short} '${yy}`,
    name: meta.name,
    espnLeagueId: meta.espnLeagueId,
    season,
    startDate: dates[0] ?? null,
    endDate: dates.at(-1) ?? null,
    structure: matches.length ? structure : null,
    groups: groups && groups.map((g) => ({ ...g, teams: g.teams.map((id) => teams.get(id) ?? id) })),
    teams: [...teams.values()].sort(),
    fixtureCount: matches.length,
    status: "announced",
  };
  entry.status = statusFor(entry, today);
  if (entry.structure === "conference" && entry.groups) nameConferences(entry.groups);
  return entry;
}

// Name the two conference sides only when every team in a side agrees on a
// hemisphere. A side with one unrecognised team stays null — the tab renders
// "Conference 1/2" rather than asserting a hemisphere it can't support.
function nameConferences(groups) {
  const named = groups.map((g) => {
    const hs = new Set(g.teams.map((t) => HEMISPHERE[t]));
    return hs.size === 1 && !hs.has(undefined) ? [...hs][0] : null;
  });
  if (named.every(Boolean) && new Set(named).size === groups.length) {
    groups.forEach((g, i) => (g.name = named[i]));
  }
}

const SITE = "https://site.api.espn.com/apis/site/v2/sports/rugby";
const CORE = "https://sports.core.api.espn.com/v2/sports/rugby/leagues";

async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// The season record tells us a season EXISTS and roughly where to look. Its
// dates are widened by 90 days either side because they are a calendar hint,
// not the competition window (see the header note) — and because the RWC
// knockout rounds will publish outside the pool-stage span once drawn.
const PAD_DAYS = 90;

async function seasonWindow(leagueId, season) {
  const rec = await getJson(`${CORE}/${leagueId}/seasons/${season}`);
  if (!rec?.startDate) return null;
  const from = addDays(iso(rec.startDate), -PAD_DAYS);
  const to = addDays(iso(rec.endDate ?? rec.startDate), PAD_DAYS);
  return { from, to };
}

const compact = (isoDate) => isoDate.replaceAll("-", "");

// The scoreboard accepts at most a 366-day range and answers HTTP 400 — not a
// truncated list — for anything longer (verified 2026-07-25: 20260101-20270101
// is 200, one day more is 400). The padded season windows exceed that, so the
// range is sliced and the events merged. Deduped by event id because a slice
// boundary can land inside a competition.
export const MAX_RANGE_DAYS = 366;

export function sliceRange(from, to, span = MAX_RANGE_DAYS) {
  const out = [];
  let cursor = from;
  while (cursor <= to) {
    const end = addDays(cursor, span - 1);
    out.push({ from: cursor, to: end < to ? end : to });
    cursor = addDays(end, 1);
  }
  return out;
}

async function fetchEvents(leagueId, win) {
  const byId = new Map();
  for (const slice of sliceRange(win.from, win.to)) {
    const board = await getJson(
      `${SITE}/${leagueId}/scoreboard?dates=${compact(slice.from)}-${compact(slice.to)}`,
    );
    // Guard the vendor's habit of answering with a stub body on HTTP 200: a
    // missing `events` array is not the same as an empty one.
    for (const e of Array.isArray(board?.events) ? board.events : []) {
      if (e?.id != null) byId.set(String(e.id), e);
    }
  }
  return [...byId.values()];
}

// Every registered competition across `seasons`, newest information wins.
export async function buildRegistry(seasons, today = iso(Date.now())) {
  const out = [];
  for (const meta of REGISTERED) {
    for (const season of seasons) {
      const win = await seasonWindow(meta.espnLeagueId, season);
      if (!win) continue; // no such season — not announced at all
      out.push(entryFor(meta, season, await fetchEvents(meta.espnLeagueId, win), today));
    }
  }
  // Substitute a seed for any competition the vendor has published nothing
  // for. Without this the handover chain skips it entirely — see
  // seed-competitions.mjs for why that is worse than it sounds.
  for (const [i, c] of out.entries()) {
    const seed = SEEDS[c.key];
    if (seed && c.fixtureCount === 0) out[i] = seededCompetition(seed);
  }

  out.sort((a, b) => (a.startDate ?? "9999").localeCompare(b.startDate ?? "9999") || a.key.localeCompare(b.key));
  return chainDefaults(out);
}

async function main() {
  const today = iso(Date.now());
  const year = new Date(today).getUTCFullYear();
  const seasons = [year, year + 1, year + 2];
  const competitions = await buildRegistry(seasons, today);
  const current = defaultCompetition(competitions, today);
  const out = {
    updatedAt: new Date().toISOString(),
    source: "espn",
    current: current?.key ?? null,
    competitions,
  };
  await writeFile("competitions.json", JSON.stringify(out, null, 1) + "\n");
  console.log(`competitions.json written — ${competitions.length} competitions, current=${out.current}`);
  for (const c of competitions) {
    console.log(
      `  ${c.key.padEnd(9)} ${String(c.structure ?? "-").padEnd(10)} ${String(c.fixtureCount).padStart(3)} games  ` +
        `${c.startDate ?? "—"}..${c.endDate ?? "—"}  ${c.status.padEnd(9)} ` +
        `default ${c.defaultFrom ?? "—"}..${c.defaultUntil ?? "—"}`,
    );
  }
  const unknown = competitions.filter((c) => c.structure === "UNKNOWN");
  if (unknown.length) console.log(`⚠️  UNKNOWN structure: ${unknown.map((c) => c.key).join(", ")}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
