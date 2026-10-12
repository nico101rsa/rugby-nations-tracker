// standings.json — a points table for every registered competition, computed
// from results already in this repo. Zero network, zero vendor calls: it reads
// competitions.json (what exists, its structure and groups), nations.json (the
// Nations Championship's results), fixtures.json (every ESPN-scored
// competition's results), the two try caches (scripts/match-tries.json for the
// Nations Championship by api-sports id, scripts/match-tries-espn.json for the
// rest by fixture id) and the previous standings.json.
//
// Provable, not plausible. Every number is arithmetic on results, and where
// the inputs cannot prove an order the file says so instead of guessing:
//   - a try bonus is only ever awarded from a game's try counts, never
//     assumed; a game without them is `pending` on both rows and counted in
//     `triesPending`, and TF/TA publish null (never a partial sum, never a 0
//     for unknown);
//   - tiebreaks walk the competition's official chain (competition-rules.mjs)
//     over clusters of level teams. A criterion that needs data we do not
//     have (tries not in yet; the World Rugby rankings, which are never
//     computed here — the app repo's docs/DATA_RIGHTS.md rule 1) stops the
//     walk: the cluster is published as a shared rank ("2=") and listed in
//     `unresolved` with what it `needs`.
// Rows are published pre-sorted; consumers must never re-sort them.
//
// Byte-stable: no run timestamp. `updatedAt` is the last time any table
// CHANGED, and the file is written only when its content minus `updatedAt`
// differs, so a quiet run commits nothing and triggers no Pages build.
//
// The Nations Championship entry mirrors nations.json `log` (computeLog in
// fetch-nations.mjs) on every number — the daily integrity check asserts it —
// and its tiebreak is computeLog's Pts > W > PD > PF, flagged unverified.
// It counts the POOL STAGE only: finals weekend (27-29 Nov 2026, Twickenham;
// first kickoff Fri 27 Nov 16:40 UTC = Sat 28 Nov 03:40 Sydney time) pairs
// sides that have already met, so every finals game is excluded (see
// rncPoolStage) rather than inflating P and Pts.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rulesFor } from "./competition-rules.mjs";
import { API_SPORTS_NATIONS } from "./static-fixtures.mjs";
import { HAND_FINALS } from "./build-fixtures.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PATHS = {
  registry: join(ROOT, "competitions.json"),
  nations: join(ROOT, "nations.json"),
  fixtures: join(ROOT, "fixtures.json"),
  rncTries: join(ROOT, "scripts", "match-tries.json"),
  espnTries: join(ROOT, "scripts", "match-tries-espn.json"),
  out: join(ROOT, "standings.json"),
};

const CODE_BY_API_ID = new Map(Object.entries(API_SPORTS_NATIONS).map(([code, t]) => [String(t.id), code]));
const API_ID_BY_CODE = Object.fromEntries(Object.entries(API_SPORTS_NATIONS).map(([code, t]) => [code, t.id]));

export const TABLE_STRUCTURES = new Set(["table", "conference", "pools"]);

const byCode = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
const byDateThenId = (a, b) =>
  (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const validTries = (t) =>
  t && Number.isFinite(t.home) && Number.isFinite(t.away) ? { home: t.home, away: t.away } : null;

// ---------------------------------------------------------------------------
// Inputs -> games
// ---------------------------------------------------------------------------
// Game shape: { id, date, home: { code, id, name }, away: {…}, homeScore,
// awayScore, tries: { home, away } | null }.

// The Nations Championship pool stage, over date-sorted finished games in
// either the raw api-sports shape (teams.home.id) or nations.json's slim one
// (home.id). Each side plays every opposing-conference side exactly once in
// weeks 1-6; finals weekend then pairs the conferences place for place, so
// every finals game repeats a pool pairing. Kept: the FIRST meeting of each
// unordered pair, in a numeric week 1-6 or an unlabelled one. Excluded, with
// a reason: a numeric week outside 1-6, a week label naming a final or
// play-off, and any later meeting of a pair. Same rules as the pool-stage
// filter on nations.json's own log, so the two tables count the same games
// (the parity test pins them together whenever that filter is exported).
const FINALS_WEEK = /final|play-?off|place|semi|quarter|knock/i;
export function rncPoolStage(finished) {
  const kept = [];
  const excluded = [];
  const met = new Set();
  for (const g of finished) {
    const week = g.week == null ? "" : String(g.week).trim();
    const n = week === "" ? NaN : Number(week);
    if (Number.isFinite(n) && (n < 1 || n > 6)) {
      excluded.push({ id: g.id, reason: `week ${week} is outside the pool stage (1-6)` });
      continue;
    }
    if (!Number.isFinite(n) && FINALS_WEEK.test(week)) {
      excluded.push({ id: g.id, reason: `week "${week}" is a finals-weekend game` });
      continue;
    }
    const h = g.teams?.home?.id ?? g.home?.id;
    const a = g.teams?.away?.id ?? g.away?.id;
    const pair = [h, a].map(String).sort().join("-");
    if (met.has(pair)) {
      excluded.push({ id: g.id, reason: `repeat pairing ${pair} (first meeting already counted)` });
      continue;
    }
    met.add(pair);
    kept.push(g);
  }
  return { kept, excluded };
}

// Same "finished" test as fetch-nations.mjs isFinished, on the slim shape,
// plus the skip computeLog applies (both scores present) and never in play.
const rncFinished = (g) =>
  ((g.status?.short ?? "") === "FT" || /finish/i.test(g.status?.long ?? "")) &&
  !g.status?.live &&
  g.home?.score != null &&
  g.away?.score != null;

// nations.json results -> pool-stage games with registry codes and tries.
export function normaliseRncGames(nations, tries = {}) {
  const finished = (nations?.results ?? []).filter(rncFinished).sort(byDateThenId);
  const pool = rncPoolStage(finished);
  const excluded = pool.excluded.map((x) => ({ id: String(x.id), reason: x.reason }));
  const games = [];
  for (const g of pool.kept) {
    const h = CODE_BY_API_ID.get(String(g.home.id));
    const a = CODE_BY_API_ID.get(String(g.away.id));
    if (!h || !a) {
      excluded.push({ id: String(g.id), reason: `team id ${h ? g.away.id : g.home.id} is not a Nations Championship team` });
      continue;
    }
    games.push({
      id: String(g.id),
      date: g.date,
      home: { code: h, id: g.home.id, name: g.home.name ?? null },
      away: { code: a, id: g.away.id, name: g.away.name ?? null },
      homeScore: Number(g.home.score),
      awayScore: Number(g.away.score),
      tries: validTries(tries?.[String(g.id)]),
    });
  }
  return { games, excluded };
}

// fixtures.json rows of one competition with a final score. A 0-0 is ESPN's
// "no score" placeholder (build-fixtures isPlaceholderFinal) unless a person
// entered it in HAND_FINALS. Tries by fixture id from match-tries-espn.json.
export function normaliseFixtureGames(key, fixtures, espnTries = {}, handFinals = HAND_FINALS) {
  const rows = Array.isArray(fixtures) ? fixtures : fixtures?.fixtures ?? [];
  const side = (s) => ({ code: s?.code ?? null, id: API_ID_BY_CODE[s?.code] ?? null, name: s?.name ?? null });
  const games = [];
  const excluded = [];
  for (const f of rows) {
    if (f?.comp?.key !== key) continue;
    if (f.homeScore == null || f.awayScore == null || f.status?.live) continue;
    if (Number(f.homeScore) === 0 && Number(f.awayScore) === 0 && !Object.hasOwn(handFinals ?? {}, f.id)) {
      excluded.push({ id: String(f.id), reason: "0-0 at full time is the vendor's no-score placeholder" });
      continue;
    }
    games.push({
      id: String(f.id),
      date: f.date,
      home: side(f.home),
      away: side(f.away),
      homeScore: Number(f.homeScore),
      awayScore: Number(f.awayScore),
      tries: validTries(espnTries?.[f.id]),
    });
  }
  return { games: games.sort(byDateThenId), excluded };
}

// Which of a competition's games are TABLE games. Both sides must be in the
// registry line-up; a pools game must be within one pool and a conference
// game across the two; and where each pair meets once (rules.meetings === 1)
// a later meeting is not a table game — the World Cup's knockouts and the
// Nations Championship's finals are filed under the same key as the pool
// stage. Everything dropped is listed with its reason.
export function tableGames(comp, games, rules) {
  const groupOf = new Map();
  if (comp.structure === "table") for (const t of comp.teams ?? []) groupOf.set(t, 0);
  else (comp.groups ?? []).forEach((g, i) => (g.teams ?? []).forEach((t) => groupOf.set(t, i)));
  const kept = [];
  const excluded = [];
  const met = new Set();
  for (const g of games) {
    const h = groupOf.get(g.home.code);
    const a = groupOf.get(g.away.code);
    let reason = null;
    if (h === undefined || a === undefined) reason = `${h === undefined ? g.home.code : g.away.code} is not in the ${comp.key} line-up`;
    else if (g.home.code === g.away.code) reason = "a team cannot play itself";
    else if (comp.structure === "pools" && h !== a) reason = "not a pool game (the sides are in different pools)";
    else if (comp.structure === "conference" && h === a) reason = "not a conference game (both sides are in one conference)";
    else if (rules?.meetings === 1) {
      const pair = [g.home.code, g.away.code].sort().join("-");
      if (met.has(pair)) reason = `repeat pairing ${pair} (the table counts the first meeting)`;
      else met.add(pair);
    }
    if (reason) excluded.push({ id: g.id, reason });
    else kept.push(g);
  }
  return { games: kept, excluded };
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

function tryBonus(own, opp, rules) {
  const tb = rules.tryBonus;
  if (!tb) return false;
  if (tb.type === "differential") return own - opp >= tb.min;
  return own >= tb.min;
}

// games -> one row per team code (a zero row for a team yet to play), in
// `teamCodes` order. Pts = win·W + draw·D + loss·L + BP + GS, always.
export function tally(games, rules, teamCodes, names = {}) {
  const acc = new Map(
    teamCodes.map((code) => [code, {
      code, id: API_ID_BY_CODE[code] ?? null, team: names[code] ?? null,
      P: 0, W: 0, D: 0, L: 0, PF: 0, PA: 0, tf: 0, ta: 0, BPtry: 0, BPlose: 0, pending: 0, form: [],
    }]),
  );
  for (const g of games) {
    const h = acc.get(g.home.code);
    const a = acc.get(g.away.code);
    if (!h || !a) continue; // tableGames has already said why
    if (h.id == null && g.home.id != null) h.id = g.home.id;
    if (a.id == null && g.away.id != null) a.id = g.away.id;
    h.team ??= g.home.name;
    a.team ??= g.away.name;
    const hs = g.homeScore;
    const as = g.awayScore;
    h.P++; a.P++;
    h.PF += hs; h.PA += as; a.PF += as; a.PA += hs;
    if (hs > as) { h.W++; a.L++; h.form.push("W"); a.form.push("L"); }
    else if (as > hs) { a.W++; h.L++; a.form.push("W"); h.form.push("L"); }
    else { h.D++; a.D++; h.form.push("D"); a.form.push("D"); }
    const margin = Math.abs(hs - as);
    if (rules.losingBonus && margin > 0 && margin <= rules.losingBonus.within) (hs > as ? a : h).BPlose++;
    if (g.tries) {
      h.tf += g.tries.home; h.ta += g.tries.away;
      a.tf += g.tries.away; a.ta += g.tries.home;
      if (tryBonus(g.tries.home, g.tries.away, rules)) h.BPtry++;
      if (tryBonus(g.tries.away, g.tries.home, rules)) a.BPtry++;
    } else {
      h.pending++; a.pending++;
    }
  }
  const all = teamCodes.length - 1;
  return [...acc.values()].map((r) => {
    const BP = r.BPtry + r.BPlose;
    const GS = rules.grandSlam && r.W === all && r.P === all ? rules.grandSlam : 0;
    return {
      rank: null, tied: false, code: r.code, id: r.id, team: r.team ?? r.code,
      P: r.P, W: r.W, D: r.D, L: r.L, PF: r.PF, PA: r.PA, PD: r.PF - r.PA,
      TF: r.pending > 0 ? null : r.tf, TA: r.pending > 0 ? null : r.ta,
      BPtry: r.BPtry, BPlose: r.BPlose, BP, GS,
      Pts: rules.win * r.W + rules.draw * r.D + rules.loss * r.L + BP + GS,
      pending: r.pending, form: r.form, decidedBy: null, q: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Rank: cluster recursion over the official chain — never a comparator
// ---------------------------------------------------------------------------

const among = (games, codes) => games.filter((g) => codes.has(g.home.code) && codes.has(g.away.code));

function evaluate(token, set, games) {
  const values = (fn) => ({ kind: "values", values: new Map(set.map((r) => [r.code, fn(r)])) });
  const triesUnknown = set.some((r) => r.pending > 0);
  switch (token) {
    case "pts": return values((r) => r.Pts);
    case "w": return values((r) => r.W);
    case "pd": return values((r) => r.PD);
    case "pf": return values((r) => r.PF);
    case "tf": return triesUnknown ? { kind: "unprovable", needs: "tries" } : values((r) => r.TF);
    case "td": return triesUnknown ? { kind: "unprovable", needs: "tries" } : values((r) => r.TF - r.TA);
    case "h2h": {
      // The rule names "the match between the tied teams": two teams only.
      if (set.length !== 2) return { kind: "inapplicable" };
      const meet = among(games, new Set(set.map((r) => r.code)));
      if (!meet.length) return { kind: "inapplicable" };
      const wins = new Map(set.map((r) => [r.code, 0]));
      for (const g of meet) {
        if (g.homeScore > g.awayScore) wins.set(g.home.code, wins.get(g.home.code) + 1);
        else if (g.awayScore > g.homeScore) wins.set(g.away.code, wins.get(g.away.code) + 1);
      }
      const [x, y] = set.map((r) => wins.get(r.code));
      return x === y ? { kind: "inapplicable" } : { kind: "values", values: wins };
    }
    case "h2hW":
    case "h2hPd": {
      const meet = among(games, new Set(set.map((r) => r.code)));
      if (!meet.length) return { kind: "inapplicable" };
      const v = new Map(set.map((r) => [r.code, 0]));
      for (const g of meet) {
        const d = g.homeScore - g.awayScore;
        if (token === "h2hPd") {
          v.set(g.home.code, v.get(g.home.code) + d);
          v.set(g.away.code, v.get(g.away.code) - d);
        } else if (d > 0) v.set(g.home.code, v.get(g.home.code) + 1);
        else if (d < 0) v.set(g.away.code, v.get(g.away.code) + 1);
      }
      return { kind: "values", values: v };
    }
    case "ranking": return { kind: "unprovable", needs: "ranking" };
    case "shared": return { kind: "shared" };
    default: return { kind: "unprovable", needs: "rule" };
  }
}

const tiedSegment = (rows, criterion, needs) => ({ rows: [...rows].sort(byCode), tied: true, criterion, needs });

function order(set, ti, rules, games) {
  if (set.length === 1) return [{ rows: set, tied: false }];
  const chain = rules.tiebreak;
  if (ti >= chain.length) return [tiedSegment(set, null, "rule")];
  const token = chain[ti];
  const ev = evaluate(token, set, games);
  if (ev.kind === "inapplicable") return order(set, ti + 1, rules, games);
  if (ev.kind === "unprovable") return [tiedSegment(set, token, ev.needs)];
  if (ev.kind === "shared") return [tiedSegment(set, "shared", "shared")];
  const levels = [...new Set(ev.values.values())]
    .sort((a, b) => b - a)
    .map((v) => set.filter((r) => ev.values.get(r.code) === v));
  if (levels.length === 1) return order(set, ti + 1, rules, games);
  const out = [];
  levels.forEach((level, i) => {
    // A World Cup split restarts the chain for each level set still tied
    // ("the process restarts at (1)"); elsewhere the walk carries on.
    const sub = level.length === 1 ? [{ rows: level, tied: false }] : order(level, rules.restart ? 0 : ti + 1, rules, games);
    if (i > 0) sub[0].decidedBy = token;
    out.push(...sub);
  });
  return out;
}

const joinNames = (names) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

// One plain sentence per unresolved level set; the app may print it verbatim.
export function noteFor({ rows, rank, criterion, needs }) {
  const names = joinNames(rows.map((r) => r.team ?? r.code));
  const pts = rows[0].Pts;
  const pd = rows[0].PD;
  const samePd = rows.every((r) => r.PD === pd);
  const pdText = pd === 0 ? "a points difference of 0" : pd > 0 ? `+${pd}` : String(pd);
  const level = `level on ${pts} point${pts === 1 ? "" : "s"}${samePd ? ` and ${pdText}` : ""}`;
  switch (needs) {
    case "tries":
      return criterion === "td"
        ? `${names} are ${level}; try difference decides and the try counts are not in yet.`
        : `${names} are ${level}; tries decide and are not in yet.`;
    case "shared":
      return `${names} share ${ordinal(rank)} place under the rules.`;
    case "ranking":
      return `${names} are ${level} and inseparable on every criterion we can compute; the World Rugby rankings decide, and we don't apply them.`;
    default:
      return `${names} are ${level} and the competition's published tiebreaks do not separate them.`;
  }
}

// rows of one table -> ranked rows (1-2-2-4 numbering, tied rows in code
// order), the level sets the chain could not split, and their notes.
// `decidedBy` names the criterion that placed a row below the one above it
// ("pts" when points differ; null for the top row and inside a tie).
export function rankRows(rows, games, rules) {
  const segments = order(rows, 0, rules, games);
  const ranked = [];
  const unresolved = [];
  const notes = [];
  let pos = 1;
  for (const seg of segments) {
    seg.rows.forEach((r, j) => {
      ranked.push({ ...r, rank: pos, tied: !!seg.tied, decidedBy: j === 0 ? seg.decidedBy ?? null : null });
    });
    if (seg.tied) {
      unresolved.push({ codes: seg.rows.map((r) => r.code), rank: pos, criterion: seg.criterion, needs: seg.needs });
      notes.push(noteFor({ rows: seg.rows, rank: pos, criterion: seg.criterion, needs: seg.needs }));
    }
    pos += seg.rows.length;
  }
  return { rows: ranked, unresolved, notes };
}

// ---------------------------------------------------------------------------
// Groups and entries
// ---------------------------------------------------------------------------

const groupDefs = (comp) =>
  comp.structure === "table" ? [{ name: null, teams: comp.teams ?? [] }] : (comp.groups ?? []).map((g) => ({ name: g.name ?? null, teams: g.teams ?? [] }));

// table -> one group {name:null}; conference/pools -> one group per registry
// group, in registry order, names copied from the registry (null until it
// has one). Every game is credited to both sides wherever they live, and each
// group is ranked on its own. Knockouts, competitions without a table rule
// and anything not yet played -> groups null.
export function groupStandings(comp, games, rules, names = {}) {
  const none = { groups: null, unresolved: [], notes: [] };
  if (!rules || rules.table === false || !TABLE_STRUCTURES.has(comp?.structure) || !games.length) return none;
  const defs = groupDefs(comp);
  if (!defs.length || defs.some((g) => !g.teams.length)) return none;
  const codes = defs.flatMap((g) => g.teams);
  const rows = new Map(tally(games, rules, codes, names).map((r) => [r.code, r]));
  const groups = [];
  const unresolved = [];
  const notes = [];
  for (const def of defs) {
    const ranked = rankRows(def.teams.map((c) => rows.get(c)), games, rules);
    groups.push({ name: def.name, rows: ranked.rows });
    for (const u of ranked.unresolved) unresolved.push(comp.structure === "table" ? u : { ...u, group: def.name });
    notes.push(...ranked.notes);
  }
  return { groups, unresolved, notes };
}

// Games a complete table holds: the registry's fixture count, except where
// each pair meets once and the structure fixes the number (so the World
// Cup's table completes at 36 even once its 16 knockouts are published).
export function tableTotal(comp, rules) {
  if (!rules || rules.meetings !== 1 || !TABLE_STRUCTURES.has(comp.structure)) return comp.fixtureCount ?? 0;
  const defs = groupDefs(comp);
  if (comp.structure === "table") {
    const n = defs[0].teams.length;
    return (n * (n - 1)) / 2;
  }
  if (comp.structure === "conference" && defs.length === 2) return defs[0].teams.length * defs[1].teams.length;
  if (comp.structure === "pools" && defs.length) return defs.reduce((s, g) => s + (g.teams.length * (g.teams.length - 1)) / 2, 0);
  return comp.fixtureCount ?? 0;
}

// The published rules object: the rules module's row minus its internal note.
function publicRules(rules) {
  if (!rules || rules.table === false) return null;
  const { note, ...rest } = rules;
  return JSON.parse(JSON.stringify(rest));
}

// Display names by code: the api-sports twelve, then whatever fixtures.json
// calls everyone else (Chile, Hong Kong China, …). First seen wins.
export function teamNames(fixtures) {
  const names = Object.fromEntries(Object.entries(API_SPORTS_NATIONS).map(([code, t]) => [code, t.name]));
  const rows = Array.isArray(fixtures) ? fixtures : fixtures?.fixtures ?? [];
  for (const f of rows) for (const s of [f?.home, f?.away]) if (s?.code && s.name && !names[s.code]) names[s.code] = s.name;
  return names;
}

// The games a competition's table counts, and everything seen but dropped.
// The Nations Championship reads nations.json when its name and season match
// (api-sports is its live feed); every other competition reads fixtures.json.
// Exported so the integrity check counts exactly what the build counts.
export function gamesFor(comp, { nations = null, fixtures = null, rncTries = {}, espnTries = {} } = {}) {
  const rules = rulesFor(comp.key);
  const tableRules = rules && rules.table !== false ? rules : null;
  const fromNations =
    String(comp.key).startsWith("rnc-") &&
    nations?.competition?.name === comp.name &&
    Number(nations?.competition?.season) === Number(comp.season);
  const raw = fromNations ? normaliseRncGames(nations, rncTries) : normaliseFixtureGames(comp.key, fixtures, espnTries);
  const table = tableRules && TABLE_STRUCTURES.has(comp.structure)
    ? tableGames(comp, raw.games, tableRules)
    : { games: raw.games, excluded: [] };
  return { games: table.games, excluded: [...raw.excluded, ...table.excluded], rules: tableRules, fromNations };
}

// One competition's entry, from scratch (no carry-forward).
export function competitionEntry(comp, { nations, fixtures, rncTries = {}, espnTries = {}, names = {}, before = null, now = new Date() }) {
  const { games, excluded, rules: tableRules } = gamesFor(comp, { nations, fixtures, rncTries, espnTries });
  const played = games.length;
  const total = tableTotal(comp, tableRules);
  const complete = total > 0 && played === total;
  const { groups, unresolved, notes } = groupStandings(comp, games, tableRules, names);
  return {
    key: comp.key,
    label: comp.label ?? null,
    name: comp.name ?? null,
    season: comp.season ?? null,
    structure: comp.structure ?? null,
    rules: publicRules(tableRules),
    played,
    total,
    complete,
    completedAt: complete ? (before?.complete && before.completedAt ? before.completedAt : now.toISOString()) : null,
    triesPending: tableRules ? games.filter((g) => !g.tries).length : 0,
    provable: unresolved.length === 0,
    frozen: false,
    qualify: tableRules?.qualify ?? null,
    groups,
    unresolved,
    notes,
    excluded,
    qualification: null,
  };
}

export const serialise = (out) => JSON.stringify(out, null, 1) + "\n";

// Did any table change? Compares everything except `updatedAt`.
export function changed(prev, next) {
  if (!prev) return true;
  return serialise({ ...prev, updatedAt: null }) !== serialise({ ...next, updatedAt: null });
}

// The whole file. Registry order; registry entries with no fixtures omitted.
// Two guards against publishing less than we had:
//   - never backwards: a still-offered competition (defaultUntil > today)
//     whose played count would DROP keeps its previous entry, and `warn` says
//     so (a feed lost results; the integrity check names it too);
//   - carry-forward: an expired competition whose results have left the feeds
//     (fixtures.json keeps a competition's results only while it is offered —
//     keepsResults) keeps its last table verbatim, marked `frozen: true`.
export function buildStandings({
  registry, nations = null, fixtures = null, rncTries = {}, espnTries = {}, prev = null,
  now = new Date(), warn = () => {},
}) {
  const today = isoDay(now);
  const names = teamNames(fixtures);
  const prevByKey = new Map((prev?.competitions ?? []).map((e) => [e.key, e]));
  const competitions = [];
  for (const comp of registry?.competitions ?? []) {
    if (!comp?.fixtureCount) continue;
    const before = prevByKey.get(comp.key) ?? null;
    const fresh = competitionEntry(comp, { nations, fixtures, rncTries, espnTries, names, before, now });
    if (before && (before.played ?? 0) > fresh.played) {
      const offered = !(comp.defaultUntil && comp.defaultUntil <= today);
      if (offered) {
        warn(`${comp.key}: played would drop from ${before.played} to ${fresh.played} — keeping the published table`);
        competitions.push(before);
      } else {
        competitions.push(before.frozen ? before : { ...before, frozen: true });
      }
      continue;
    }
    competitions.push(fresh);
  }
  const out = { updatedAt: now.toISOString(), source: "computed", competitions };
  if (prev && !changed(prev, out)) out.updatedAt = prev.updatedAt;
  return out;
}

// Registry codes a table must hold exactly once.
export const lineUp = (comp) =>
  comp.structure === "table" ? comp.teams ?? [] : (comp.groups ?? []).flatMap((g) => g.teams ?? []);

// The invariants a consumer relies on. Any problem -> main() writes nothing.
export function selfCheck(entry, comp) {
  const problems = [];
  const k = entry.key;
  if (entry.played > entry.total) problems.push(`${k}: played ${entry.played} > total ${entry.total}`);
  if (entry.complete && entry.played !== entry.total) problems.push(`${k}: complete but played ${entry.played} of ${entry.total}`);
  if (!entry.groups) return problems;
  const r = entry.rules;
  if (!r) return [...problems, `${k}: groups without rules`];
  let sumP = 0;
  const seen = new Map();
  for (const g of entry.groups) {
    for (const row of g.rows ?? []) {
      sumP += row.P;
      seen.set(row.code, (seen.get(row.code) ?? 0) + 1);
      const pts = r.win * row.W + r.draw * row.D + r.loss * row.L + row.BP + row.GS;
      if (row.Pts !== pts) problems.push(`${k} ${row.code}: Pts ${row.Pts} but ${r.win}·W + ${r.draw}·D + BP + GS = ${pts}`);
      if (row.BP !== row.BPtry + row.BPlose) problems.push(`${k} ${row.code}: BP ${row.BP} != BPtry ${row.BPtry} + BPlose ${row.BPlose}`);
      if (row.P !== row.W + row.D + row.L) problems.push(`${k} ${row.code}: P ${row.P} != W + D + L`);
      if (row.PD !== row.PF - row.PA) problems.push(`${k} ${row.code}: PD ${row.PD} != PF - PA`);
      if ((row.TF === null) !== (row.pending > 0) || (row.TA === null) !== (row.pending > 0)) {
        problems.push(`${k} ${row.code}: TF/TA must be null exactly when tries are pending`);
      }
    }
  }
  if (sumP !== 2 * entry.played) problems.push(`${k}: rows hold ${sumP} appearances for ${entry.played} games`);
  if (comp) {
    const expected = lineUp(comp);
    for (const code of expected) {
      const n = seen.get(code) ?? 0;
      if (n !== 1) problems.push(`${k}: ${code} appears ${n} times`);
    }
    for (const code of seen.keys()) if (!expected.includes(code)) problems.push(`${k}: ${code} is not in the registry line-up`);
  }
  return problems;
}

async function main() {
  const read = (p) => readFile(p, "utf8").then(JSON.parse);
  const registry = await read(PATHS.registry);
  const [fixtures, nations, rncTries, espnTries] = await Promise.all([
    read(PATHS.fixtures).catch(() => null),
    read(PATHS.nations).catch(() => null),
    read(PATHS.rncTries).catch(() => ({})),
    read(PATHS.espnTries).catch(() => ({})),
  ]);
  const prev = await read(PATHS.out).catch(() => null);
  const warnings = [];
  const out = buildStandings({ registry, nations, fixtures, rncTries, espnTries, prev, warn: (w) => warnings.push(w) });
  for (const w of warnings) console.log(`::warning::standings: ${w}`);
  for (const e of out.competitions) {
    console.log(
      `  ${e.key.padEnd(9)} ${String(e.structure ?? "-").padEnd(10)} ${String(e.played).padStart(2)}/${String(e.total).padEnd(2)} ` +
        `triesPending ${e.triesPending}  ${e.provable ? "provable" : `unresolved: ${e.unresolved.map((u) => `${u.codes.join("/")} needs ${u.needs}`).join("; ")}`}` +
        `${e.frozen ? "  frozen" : ""}${e.excluded.length ? `  excluded ${e.excluded.length}` : ""}`,
    );
  }
  const problems = out.competitions.flatMap((e) => selfCheck(e, registry.competitions.find((c) => c.key === e.key)));
  if (problems.length) {
    for (const p of problems) console.log(`::warning::standings self-check: ${p}`);
    console.log("standings.json NOT written — self-check failed");
    return;
  }
  if (!changed(prev, out)) {
    console.log("standings.json unchanged");
    return;
  }
  await writeFile(PATHS.out, serialise(out));
  console.log(`standings.json written (${out.competitions.length} competitions)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Never fails the job: a missed run leaves yesterday's tables, nothing worse.
  main().catch((err) => console.error(`standings: skipped — ${err.stack ?? err.message}`));
}
