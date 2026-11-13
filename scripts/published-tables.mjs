// Our tables against a table somebody else publishes.
//
// Every other check in this repo looks at an input (a score, a try count). A
// table can still be wrong for a reason none of them covers, and for four
// months in 2026 one was: Scotland sat on 10 points while every published
// table said 11, until a user wrote in (13 Nov 2026). Nico asked for the
// obvious thing: compare the finished table with another source.
//
// The other source is ESPN's standings endpoint (keyless, one request per
// competition): site.api.espn.com/apis/v2/sports/rugby/<league>/standings.
// ESPN computes that table itself, with its own try bonus and losing bonus
// columns, so it is not the try rows our counts are read from. The score
// vendor's table (api-sports /standings) is not on the free plan (probed
// 13 Nov 2026).
//
// What the probe of 13 Nov 2026 showed, and what the code does about it:
//   - `?season=<year>` is required. Without it the Six Nations answered with
//     the 2026 table under a 2027 season label.
//   - Before a season starts every row is zeros. A table of zeros says
//     nothing about ours, so it is skipped, never raised.
//   - The Nations Championship's two groups are both named "Northern
//     Hemisphere". Rows are matched by ESPN team id (ESPN_CODES), never by
//     group or by abbreviation (ESPN writes SOU, ROM, TON).
//   - Ranks are not compared: ESPN's tiebreaks are its own.
//
// A row is compared only when both tables have that team on the same number
// of games. One table a game ahead of the other is a result in flight, not a
// disagreement; it is raised on its own only once it has lasted two days.
//
// Nothing here decides who is right. A difference is raised (silently, for
// the Claude review) with both numbers and the team's games and try counts,
// which is where a difference has always come from so far.

import { ESPN_CODES } from "./build-competitions.mjs";

const SITE = "https://site.api.espn.com/apis/v2/sports/rugby";
export const FETCH_TIMEOUT_MS = 15_000;
const DAY_MS = 86400000;

// Our column -> ESPN's stat name.
export const FIELDS = [
  ["Pts", "points"], ["W", "gamesWon"], ["D", "gamesDrawn"], ["L", "gamesLost"],
  ["PF", "pointsFor"], ["PA", "pointsAgainst"],
  ["BPtry", "bonusPointsTry"], ["BPlose", "bonusPointsLosing"],
  ["TF", "triesFor"], ["TA", "triesAgainst"],
];

// ESPN's standings JSON -> Map(our code -> { P, Pts, W, ... }), plus the ESPN
// teams we have no code for. Pure.
export function espnTable(json) {
  const rows = new Map();
  const unknown = [];
  const groups = Array.isArray(json?.children) ? json.children : json?.standings ? [json] : [];
  for (const g of groups) {
    for (const e of g?.standings?.entries ?? []) {
      const code = ESPN_CODES[String(e?.team?.id ?? "")];
      if (!code) { unknown.push(e?.team?.abbreviation ?? String(e?.team?.id ?? "?")); continue; }
      const s = Object.fromEntries((e.stats ?? []).map((t) => [t.name, t.value]));
      const row = { P: s.gamesPlayed };
      for (const [ours, theirs] of FIELDS) row[ours] = s[theirs];
      rows.set(code, row);
    }
  }
  return { rows, unknown };
}

const num = (x) => typeof x === "number" && Number.isFinite(x);

// One standings.json entry against ESPN's table for the same season. Pure.
//
//   { comparable, diffs: [{ code, team, field, ours, espn }],
//     behind: [{ code, team, ours, espn }], skipped }
//
// `comparable` is false (with `skipped` saying why) when ESPN has no table to
// compare: no rows, or every row on zero games while ours has results.
// `behind` lists teams whose games-played count differs.
export function compareTable(entry, espn) {
  const ours = (entry?.groups ?? []).flatMap((g) => g?.rows ?? []);
  const theirs = espn?.rows ?? new Map();
  if (!ours.length) return { comparable: false, diffs: [], behind: [], skipped: "we have no table" };
  if (!theirs.size) return { comparable: false, diffs: [], behind: [], skipped: "ESPN returned no rows" };
  if ([...theirs.values()].every((r) => !(r.P > 0))) {
    return { comparable: false, diffs: [], behind: [], skipped: "ESPN's table for this season is empty" };
  }
  const diffs = [];
  const behind = [];
  let matched = 0;
  for (const r of ours) {
    const t = theirs.get(r.code);
    if (!t) continue;
    matched++;
    if (t.P !== r.P) { behind.push({ code: r.code, team: r.team, ours: r.P, espn: t.P }); continue; }
    for (const [field] of FIELDS) {
      if (!num(t[field]) || !num(r[field])) continue; // a column one side does not carry
      if (t[field] !== r[field]) diffs.push({ code: r.code, team: r.team, field, ours: r[field], espn: t[field] });
    }
  }
  if (!matched) return { comparable: false, diffs: [], behind: [], skipped: "no team in common" };
  return { comparable: true, diffs, behind, skipped: null };
}

const WORDS = {
  Pts: "points", W: "wins", D: "draws", L: "losses", PF: "points for", PA: "points against",
  BPtry: "try bonus points", BPlose: "losing bonus points", TF: "tries for", TA: "tries against",
};

// The competitions worth asking ESPN about: still offered, with an ESPN
// league, a season and a table that has results.
export function tablesToCheck(registry, standings, today) {
  const byKey = new Map((standings?.competitions ?? []).map((e) => [e.key, e]));
  return (registry?.competitions ?? []).filter((c) => {
    const e = byKey.get(c.key);
    return c?.espnLeagueId != null && c.season != null && !(c.defaultUntil && c.defaultUntil <= today) &&
      e && e.played > 0 && Array.isArray(e.groups) && e.groups.length && !e.frozen;
  }).map((c) => ({ comp: c, entry: byKey.get(c.key) }));
}

// The games of one team with the try counts our table used, for the issue:
// "SCO: 2026-07-18 FIJ 17-33 SCO (tries 3-3)".
function gamesLine(code, games) {
  const mine = (games ?? []).filter((g) => g.home?.code === code || g.away?.code === code);
  if (!mine.length) return null;
  return mine.map((g) => `${String(g.date).slice(0, 10)} ${g.home.code} ${g.homeScore}-${g.awayScore} ${g.away.code}` +
    (g.tries ? ` (tries ${g.tries.home}-${g.tries.away})` : " (tries not counted)")).join("; ");
}

// comparisons: [{ comp, entry, espn (espnTable result or null), games, newestMs }]
// -> problems in check-competitions' shape. Pure.
export function checkPublishedTables(comparisons, nowMs = Date.now()) {
  const problems = [];
  for (const { comp, entry, espn, games = [], newestMs = null } of comparisons) {
    if (!espn) continue; // ESPN did not answer: nothing learned, nothing raised
    const { comparable, diffs, behind } = compareTable(entry, espn);
    if (!comparable) continue;
    const label = `${comp.name ?? comp.key} ${comp.season ?? ""}`.trim();
    if (diffs.length) {
      const codes = [...new Set(diffs.map((d) => d.code))];
      problems.push({
        kind: "table-differs",
        title: `${comp.key}: our table differs from ESPN's (${codes.join(", ")})`,
        detail:
          `The ${label} table the app shows does not match the table ESPN publishes for the same games:\n\n` +
          diffs.map((d) => `- **${d.team ?? d.code}** ${WORDS[d.field] ?? d.field}: ours ${d.ours}, ESPN ${d.espn}`).join("\n") +
          `\n\nThe games behind those rows, with the try counts our table used:\n\n` +
          codes.map((c) => `- ${c}: ${gamesLine(c, games) ?? "no games found"}`).join("\n") +
          `\n\nNeither table is taken as right. Check the row against a match report or the competition's own table. ` +
          `A try bonus point or a tries column is settled in \`scripts/match-tries.json\` (Nations Championship) or ` +
          `\`scripts/match-tries-espn.json\` (set \`"checked": true, "source": "hand"\`); a score is the feed's to fix. ` +
          `If ESPN is the one that is wrong, close this with the evidence.`,
      });
    }
    if (behind.length && newestMs != null && nowMs - newestMs > 2 * DAY_MS) {
      problems.push({
        kind: "table-games-differ",
        title: `${comp.key}: our table and ESPN's count different games (${behind.map((b) => b.code).join(", ")})`,
        detail:
          `Two days after the last ${label} result, the two tables still disagree on games played:\n\n` +
          behind.map((b) => `- **${b.team ?? b.code}**: ours ${b.ours}, ESPN ${b.espn}`).join("\n") +
          `\n\nOne of them is missing a result, or counts a game the other leaves out of the table.`,
      });
    }
  }
  return problems;
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export const standingsUrl = (comp) => `${SITE}/${comp.espnLeagueId}/standings?season=${comp.season}`;

// One request per competition with results. A failure is logged and that
// competition is left out: a check that cannot reach ESPN says nothing.
// `gamesOf(comp)` -> the counted games (check-competitions passes gamesFor).
export async function fetchComparisons(registry, standings, today, { fetchJson = defaultFetchJson, gamesOf = () => [], log = console } = {}) {
  const out = [];
  for (const { comp, entry } of tablesToCheck(registry, standings, today)) {
    let espn = null;
    try {
      espn = espnTable(await fetchJson(standingsUrl(comp)));
      if (espn.unknown.length) log.log?.(`published-tables: ${comp.key}: no code for ESPN team(s) ${espn.unknown.join(", ")}`);
    } catch (e) {
      log.warn?.(`published-tables: ${comp.key} not checked (${e.message})`);
    }
    const games = gamesOf(comp);
    const newestMs = games.reduce((m, g) => Math.max(m, Date.parse(g.date) || 0), 0) || null;
    if (espn) {
      const c = compareTable(entry, espn);
      log.log?.(`published-tables: ${comp.key}: ${c.comparable ? `${c.diffs.length} difference(s), ${c.behind.length} team(s) on a different game count` : `not compared (${c.skipped})`}`);
    }
    out.push({ comp, entry, espn, games, newestMs });
  }
  return out;
}
