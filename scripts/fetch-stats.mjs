// scripts/fetch-stats.mjs
//
// Box-score stats pipeline. Harvests scoring events + cards for finished
// Nations Championship matches from the sports-data vendor, publishes only
// matches whose events sum EXACTLY to the final score already in nations.json
// (the arithmetic gate), and opens a per-match GitHub issue when one won't
// reconcile. Runs daily from .github/workflows/stats.yml; zero manual steps.
//
// Two sources, one gate. SportsAPI Pro's incident list is tried first; when
// it won't add up (or carries a class we don't know), ESPN's keyless event
// summary is parsed into the same shape and put through the same gate, and a
// match that reconciles that way is published with `source: "espn"`. See
// "Second source" below for why.

const GOAL_TYPES = {
  try: "try",
  twoPoints: "conversion",
  threePoints: "penalty",
  dropGoal: "dropGoal",
  drop: "dropGoal",
  penaltyTry: "penaltyTry",
};
const CARD_TYPES = { yellow: "yellow", red: "red", yellowRed: "red" };

export function parseIncidents(incidents = []) {
  const scoring = [];
  const cards = [];
  const unknown = [];
  for (const i of incidents) {
    if (i.incidentType === "goal") {
      const type = GOAL_TYPES[i.incidentClass];
      if (!type) { unknown.push(`goal:${i.incidentClass}`); continue; }
      scoring.push({
        min: i.time,
        team: i.isHome ? "home" : "away",
        type,
        player: i.player?.name ?? null,
        after: [i.homeScore, i.awayScore],
      });
    } else if (i.incidentType === "card") {
      const type = CARD_TYPES[i.incidentClass];
      if (!type) { unknown.push(`card:${i.incidentClass}`); continue; }
      cards.push({ min: i.time, team: i.isHome ? "home" : "away", type, player: i.player?.name ?? null });
    }
    // substitutions, periods: intentionally skipped
  }
  // Within the same minute (a try + its conversion), the running-score total
  // orders events truly chronologically; input order can't be trusted.
  const total = (s) => (s.after?.[0] ?? 0) + (s.after?.[1] ?? 0);
  return {
    scoring: scoring.sort((a, b) => a.min - b.min || total(a) - total(b)),
    cards: cards.sort((a, b) => a.min - b.min),
    unknown,
  };
}

export const POINTS = { try: 5, conversion: 2, penalty: 3, dropGoal: 3, penaltyTry: 7 };

// The publish gate: a match ships only when its parsed scoring events sum
// exactly to the final score fetched independently via api-sports.
export function reconcile(scoring, homeFinal, awayFinal) {
  const computed = { home: 0, away: 0 };
  for (const s of scoring) computed[s.team] += POINTS[s.type] ?? 0;
  return {
    ok: computed.home === homeFinal && computed.away === awayFinal,
    home: { expected: homeFinal, computed: computed.home },
    away: { expected: awayFinal, computed: computed.away },
  };
}

export function buildAggregates(matches) {
  const done = matches.filter((m) => m.reconciled);
  const players = new Map(); // "player|team" -> {player, team, t, c, p, d}
  const teams = new Map();   // team -> {tries, cons, pens, drops, pointsFor, yellow, red}

  const team = (name) => {
    if (!teams.has(name)) teams.set(name, { tries: 0, cons: 0, pens: 0, drops: 0, pointsFor: 0, yellow: 0, red: 0 });
    return teams.get(name);
  };
  const player = (name, teamName) => {
    const k = `${name}|${teamName}`;
    if (!players.has(k)) players.set(k, { player: name, team: teamName, t: 0, c: 0, p: 0, d: 0 });
    return players.get(k);
  };

  for (const m of done) {
    const names = { home: m.home.name, away: m.away.name };
    team(names.home).pointsFor += m.home.score;
    team(names.away).pointsFor += m.away.score;
    for (const s of m.scoring) {
      const t = team(names[s.team]);
      if (s.type === "try" || s.type === "penaltyTry") t.tries += 1;
      if (s.type === "conversion") t.cons += 1;
      if (s.type === "penalty") t.pens += 1;
      if (s.type === "dropGoal") t.drops += 1;
      if (!s.player) continue; // penalty tries have no player
      const p = player(s.player, names[s.team]);
      if (s.type === "try") p.t += 1;
      if (s.type === "conversion") p.c += 1;
      if (s.type === "penalty") p.p += 1;
      if (s.type === "dropGoal") p.d += 1;
    }
    for (const c of m.cards) team(names[c.team])[c.type] += 1;
  }

  const byThen = (key) => (a, b) => b[key] - a[key] || a.player?.localeCompare?.(b.player) || a.team?.localeCompare?.(b.team) || 0;
  const all = [...players.values()].map((p) => ({ ...p, points: p.t * 5 + p.c * 2 + p.p * 3 + p.d * 3 }));

  return {
    topTryScorers: all.filter((p) => p.t > 0).map(({ player, team, t }) => ({ player, team, tries: t }))
      .sort((a, b) => b.tries - a.tries || a.player.localeCompare(b.player)),
    topPointsScorers: all.filter((p) => p.points > 0).map(({ player, team, points, t, c, p: pen, d }) => ({ player, team, points, t, c, p: pen, d }))
      .sort(byThen("points")),
    discipline: [...teams.entries()].map(([team, v]) => ({ team, yellow: v.yellow, red: v.red }))
      .sort((a, b) => (b.yellow + b.red * 2) - (a.yellow + a.red * 2) || a.team.localeCompare(b.team)),
    teamTotals: [...teams.entries()].map(([team, v]) => ({ team, tries: v.tries, cons: v.cons, pens: v.pens, drops: v.drops, pointsFor: v.pointsFor }))
      .sort((a, b) => b.pointsFor - a.pointsFor || a.team.localeCompare(b.team)),
  };
}

// Order-strict on purpose: a vendor home/away swap would corrupt running
// scores, so it must fail loudly via the reconcile gate, not silently match.
export function findEvent(events = [], homeName, awayName) {
  return events.find((e) => e.homeTeam?.name === homeName && e.awayTeam?.name === awayName) ?? null;
}

// ---- Second source: ESPN's keyless site API (league 17567) -----------------
//
// The vendor's incident list is sometimes one scoring event short. Issue #48:
// Argentina 24-31 England (18 Jul 2026) summed Argentina to 22 — a missing
// conversion, or a penalty try delivered as a plain try — and the gate held
// the match for months while every nightly retry spent one of the day's 100
// vendor calls on the same answer. ESPN's event summary carries the same box
// score as `header.competitions[0].details`, the array scrape-tries.mjs has
// been counting tries from in production since round 1 (and it had this very
// match: 2 tries v 5). So when the vendor's list won't reconcile, that array
// is parsed into the shape below and run through the same arithmetic gate.
//
// What scrape-tries relies on is ground truth: `type.text`, `team.id`, and
// the competitor ids/`homeAway` on the summary header. Everything else
// (`clock`, `athletesInvolved`, a running score) is read defensively and
// only the gate decides. A `type.text` we don't recognise holds the match
// exactly as an unknown vendor class does, and the raw details are logged so
// the Actions log of the next run shows the real payload.

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/rugby/17567";

const ESPN_SCORING = [
  [/^penalty try$/i, "penaltyTry"],
  [/^try$/i, "try"],
  [/^conversion( goal| kick)?$/i, "conversion"],
  [/^penalty( goal| kick)?$/i, "penalty"],
  [/^drop(ped)? (goal|kick)$/i, "dropGoal"],
];
const ESPN_CARDS = [[/^yellow card$/i, "yellow"], [/^red card$/i, "red"]];
// Non-scoring, non-card rows ESPN lists in the same array — skipped like the
// vendor's substitutions and periods, never counted, never held against.
const ESPN_SKIP = /^(substitution|kick[ -]?off|half[ -]?time|full[ -]?time|(start|end) of (the )?(period|half|match|game))$/i;

// clock.value is seconds of play; the 1234th second is in the 21st minute.
// displayValue ("21'", "40'+2'") is the fallback when value is absent.
export function espnMinute(clock) {
  const v = Number(clock?.value);
  if (Number.isFinite(v) && v > 0) return Math.ceil(v / 60);
  const m = String(clock?.displayValue ?? "").match(/^\s*(\d+)'?(?:\s*\+\s*(\d+))?/);
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// ESPN summary details -> the same { scoring, cards, unknown } parseIncidents
// returns, so reconcile() and buildAggregates() see no difference. homeIds and
// awayIds are the competitor ids each side may appear under (competitor id
// and team id, which ESPN usually keeps equal); a row for neither is unknown.
export function parseEspnDetails(details = [], homeIds = [], awayIds = []) {
  const home = new Set(homeIds.map(String));
  const away = new Set(awayIds.map(String));
  const side = (team) => {
    const id = String(team?.id ?? "");
    return home.has(id) ? "home" : away.has(id) ? "away" : null;
  };
  const scoring = [];
  const cards = [];
  const unknown = [];
  for (const d of details) {
    const text = String(d?.type?.text ?? "").trim();
    const goal = ESPN_SCORING.find(([re]) => re.test(text))?.[1] ?? null;
    const card = ESPN_CARDS.find(([re]) => re.test(text))?.[1]
      ?? (d?.redCard === true ? "red" : d?.yellowCard === true ? "yellow" : null);
    if (!goal && !card) {
      if (!ESPN_SKIP.test(text)) unknown.push(text || "(untyped)");
      continue;
    }
    const team = side(d.team);
    if (!team) { unknown.push(`${text} for team ${d.team?.id ?? "?"}`); continue; }
    const min = espnMinute(d.clock);
    const player = d.athletesInvolved?.[0]?.displayName ?? null;
    if (goal) {
      const hs = finite(d.homeScore);
      const as = finite(d.awayScore);
      scoring.push({ min, team, type: goal, player, after: hs != null && as != null ? [hs, as] : null });
    } else {
      cards.push({ min, team, type: card, player });
    }
  }
  // Chronological: by minute, then by ESPN's running total where it gives one,
  // then a conversion after the try it follows. Rows without a minute keep
  // their arrival order at the end.
  const at = (e) => e.min ?? Number.MAX_SAFE_INTEGER;
  const total = (s) => s.after[0] + s.after[1];
  const rank = (s) => (s.type === "conversion" ? 1 : 0);
  scoring.sort((a, b) => at(a) - at(b) || (a.after && b.after ? total(a) - total(b) : 0) || rank(a) - rank(b));
  cards.sort((a, b) => at(a) - at(b));
  // Running score: ESPN's own where present, else accumulated from the points
  // table, so `after` means the same thing from either source.
  let run = [0, 0];
  for (const s of scoring) {
    if (s.after) { run = s.after; continue; }
    run = [...run];
    run[s.team === "home" ? 0 : 1] += POINTS[s.type];
    s.after = run;
  }
  return { scoring, cards, unknown };
}

const kickoffMinute = (iso) => {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 16);
};
const normName = (s) => String(s ?? "").toLowerCase().trim();
const espnHome = (e) => e?.competitions?.[0]?.competitors?.find((c) => c.homeAway === "home");

// The key scrape-tries.mjs matches on: kickoff to the UTC minute + home team
// name. Order-strict for the same reason findEvent is.
export function findEspnEvent(events = [], dateIso, homeName) {
  const minute = kickoffMinute(dateIso);
  const home = normName(homeName);
  if (!minute || !home) return null;
  return events.find((e) => kickoffMinute(e?.date) === minute && normName(espnHome(e)?.team?.displayName) === home) ?? null;
}

// One issue per match: create on first failure, close on recovery, never spam.
export function decideAlert(existingIssue, reconciled) {
  if (reconciled) return existingIssue ? "close" : "noop";
  return existingIssue ? "noop" : "create";
}

const BASE = "https://api.sportsapipro.com/v2/rugby";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { "x-api-key": process.env.SPORTSAPIPRO_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Keyless, so no quota and no pacing; injected separately so tests can prove
// which source was called.
async function defaultEspnJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function dayShift(dateIso, days) {
  const d = new Date(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const reasonFor = (gate, unknown, label) =>
  `did not reconcile: home ${gate.home.computed}/${gate.home.expected}, away ${gate.away.computed}/${gate.away.expected}` +
  (unknown.length ? `; unknown ${label}: ${unknown.join(", ")}` : "");

// Second-source attempt for one match: ESPN scoreboard (match day, then ±1 —
// kickoffs cross the UTC date line) -> event summary -> the same gate.
// Returns { ok, scoring, cards, espnEventId } or { ok: false, reason }; the
// caller folds the reason into the vendor's so a held match reports both.
async function reconcileFromEspn(r, fetchEspn, scoreboard) {
  let ev = null;
  for (const shift of [0, 1, -1]) {
    const day = dayShift(r.date, shift);
    const events = await scoreboard(day);
    ev = findEspnEvent(events, r.date, r.home.name);
    if (ev) break;
    console.log(`ESPN scoreboard ${day}: ${events.map((e) => `${e.id} ${e.date} ${espnHome(e)?.team?.displayName ?? "?"}`).join("; ") || "no events"}`.slice(0, 1000));
  }
  if (!ev) return { ok: false, reason: `no ESPN event for ${r.home.name} at ${r.date}` };

  const summary = await fetchEspn(`${ESPN}/summary?event=${ev.id}`);
  const comp = summary?.header?.competitions?.[0];
  const ids = (side) => {
    const c = comp?.competitors?.find((x) => x.homeAway === side);
    return [c?.id, c?.team?.id].filter((x) => x != null);
  };
  const details = Array.isArray(comp?.details) ? comp.details : [];
  const { scoring, cards, unknown } = parseEspnDetails(details, ids("home"), ids("away"));
  const gate = reconcile(scoring, r.home.score, r.away.score);
  if (gate.ok && !unknown.length) return { ok: true, scoring, cards, espnEventId: ev.id };

  // The follow-up needs the real payload and the Actions log is the only
  // place it can be seen; bounded so a long match can't flood the log.
  console.log(`ESPN event ${ev.id} details for match ${r.id} (${details.length} rows): ${JSON.stringify(details).slice(0, 4000)}`);
  return { ok: false, reason: `ESPN event ${ev.id} ${reasonFor(gate, unknown, "event types")}` };
}

// Core pipeline, network-injectable for tests. Reads finished matches from
// nations.json, fetches + gates each unreconciled one, returns the new
// stats.json object plus a failure list for alerting.
// sleepMs 6500 keeps a full first-run harvest (~18 calls: incidents + schedule
// discovery) at ~9.2 req/min, under the vendor's 10/min free-tier ceiling —
// ~2 min total runtime is irrelevant for a daily job. Tests inject sleepMs: 0.
export async function runPipeline({ nations, prevStats, fetchJson = defaultFetchJson, fetchEspn = defaultEspnJson, sleepMs = 6500 }) {
  const prev = new Map((prevStats?.matches ?? []).map((m) => [m.id, m]));
  const finished = (nations.results ?? []).filter((r) => r.status?.short === "FT");
  const matches = [];
  const failures = [];
  const scheduleCache = new Map(); // date -> events[]
  const scoreboardCache = new Map(); // date -> ESPN events[] (keyless: no pacing)

  const schedule = async (date) => {
    if (!scheduleCache.has(date)) {
      await sleep(sleepMs);
      scheduleCache.set(date, (await fetchJson(`${BASE}/api/schedule/${date}`)).events ?? []);
    }
    return scheduleCache.get(date);
  };
  const scoreboard = async (date) => {
    if (!scoreboardCache.has(date)) {
      const sb = await fetchEspn(`${ESPN}/scoreboard?dates=${date.replaceAll("-", "")}`);
      scoreboardCache.set(date, Array.isArray(sb?.events) ? sb.events : []);
    }
    return scoreboardCache.get(date);
  };

  for (const r of finished) {
    const kept = prev.get(r.id);
    if (kept?.reconciled) { matches.push(kept); continue; }

    // Stubs carry empty scoring/cards so every entry has the same shape —
    // `reconciled` is the trust flag, not key presence. Real data overwrites
    // them via Object.assign on success.
    const entry = { id: r.id, round: r.week, date: r.date,
      home: { id: r.home.id, name: r.home.name, score: r.home.score },
      away: { id: r.away.id, name: r.away.name, score: r.away.score },
      eventId: kept?.eventId ?? null, reconciled: false, scoring: [], cards: [] };

    try {
      if (!entry.eventId) {
        // vendor calendar dates vs UTC kickoffs can differ → try day, then ±1
        for (const shift of [0, 1, -1]) {
          const ev = findEvent(await schedule(dayShift(r.date, shift)), r.home.name, r.away.name);
          if (ev) { entry.eventId = ev.id; break; }
        }
        if (!entry.eventId) throw new Error(`no event found for ${r.home.name} v ${r.away.name} around ${r.date.slice(0, 10)}`);
      }
      await sleep(sleepMs);
      const payload = await fetchJson(`${BASE}/api/match/${entry.eventId}/incidents`);
      const { scoring, cards, unknown } = parseIncidents(payload?.data?.incidents ?? []);
      const gate = reconcile(scoring, r.home.score, r.away.score);
      if (gate.ok && !unknown.length) {
        Object.assign(entry, { reconciled: true, scoring, cards });
      } else {
        // Second source. Only a vendor list that arrived but won't add up gets
        // here: a vendor outage or a failed schedule lookup still throws above
        // and is retried next run as before.
        const vendorReason = reasonFor(gate, unknown, "incident classes");
        const espn = await reconcileFromEspn(r, fetchEspn, scoreboard)
          .catch((e) => ({ ok: false, reason: `ESPN: ${e.message}` }));
        if (!espn.ok) throw new Error(`${vendorReason}; ${espn.reason}`);
        console.log(`match ${r.id} (${r.home.name} v ${r.away.name}): vendor ${vendorReason}; reconciled from ESPN event ${espn.espnEventId}`);
        Object.assign(entry, { reconciled: true, source: "espn", scoring: espn.scoring, cards: espn.cards });
      }
    } catch (err) {
      failures.push({ id: r.id, title: `Stats: ${r.home.name} v ${r.away.name} (match ${r.id}) not publishing`, reason: err.message });
    }
    matches.push(entry);
  }

  return {
    stats: {
      updatedAt: new Date().toISOString(),
      source: "aggregated",
      matches,
      aggregates: buildAggregates(matches),
    },
    failures,
  };
}

async function gh(args) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("gh", args);
  return stdout;
}

// Best-effort per-match alert sync: create on first failure, close on recovery.
// The issue is silent (no @mention, no assignee — notify.mjs decides): a box
// score that won't reconcile is a data ticket for the Claude weekly review,
// not something to ping Nico about.
export async function syncAlerts(matches, failures) {
  try {
    const open = JSON.parse(await gh(["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title"]));
    const failed = new Map(failures.map((f) => [f.title, f]));

    for (const [title, f] of failed) {
      const existing = open.find((i) => i.title === title) ?? null;
      if (decideAlert(existing, false) === "create") {
        const { issueCreateArgs } = await import("./notify.mjs");
        await gh(issueCreateArgs({ title, body: `${f.reason}\n\nHeld out of stats.json; retried automatically on every run.` }));
        console.log(`Opened alert: ${title}`);
      }
    }
    for (const m of matches.filter((m) => m.reconciled)) {
      const title = `Stats: ${m.home.name} v ${m.away.name} (match ${m.id}) not publishing`;
      const existing = open.find((i) => i.title === title) ?? null;
      if (decideAlert(existing, true) === "close") {
        await gh(["issue", "close", String(existing.number), "--comment", "Reconciled on a later run — resolved automatically."]);
        console.log(`Closed alert: ${title}`);
      }
    }
  } catch (err) {
    console.error(`::warning::alert sync failed (harvest unaffected): ${err.message}`);
  }
}

async function main() {
  if (!process.env.SPORTSAPIPRO_KEY) {
    console.error("SPORTSAPIPRO_KEY is not set");
    process.exit(1);
  }
  const { readFile, writeFile } = await import("node:fs/promises");
  const nations = JSON.parse(await readFile("nations.json", "utf8"));
  const prevStats = await readFile("stats.json", "utf8").then(JSON.parse).catch(() => null);

  const { stats, failures } = await runPipeline({ nations, prevStats });
  await writeFile("stats.json", JSON.stringify(stats, null, 2) + "\n");
  console.log(`stats.json: ${stats.matches.filter((m) => m.reconciled).length}/${stats.matches.length} matches reconciled, ${failures.length} failure(s)`);

  await syncAlerts(stats.matches, failures);
}

// Only run main when invoked directly (not when imported by the test).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
