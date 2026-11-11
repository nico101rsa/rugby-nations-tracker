// ESPN's running score, laid over nations.json between the api-sports polls.
//
// Why it exists. nations.json is the live feed for the Nations Championship,
// and its burst is paced by QUOTA: one api-sports fetch every 12 minutes
// against a 100-call/day free tier (refresh.mjs). Round 4 (7-8 Nov 2026) read
// off this repo's own history, minutes after kickoff at which the published
// score moved:
//   France v Fiji      +27 (10-0), +51, +63, then 26-3 until +99 (40-10)
//   England v Australia +15, +27, +39, +51 (19-10), then nothing until +87
//   Ireland v Argentina first live score at +27; full time at +124, 36 min
//                      after the previous change
// So a phone was 12 minutes behind at best and 24-36 at worst, and a 1-star
// review on 9 Nov said scores are "well behind". fixtures.json has had a
// keyless 3-minute ESPN burst since August; the Nations Championship was the
// one competition without it, in the three weeks it has the most viewers.
//
// What it does. Every 3 minutes inside a live burst (and straight after each
// api-sports pass) it reads ESPN's league scoreboard, keyless, and lifts any
// Nations Championship row ESPN is ahead on: score, phase, and the final
// whistle. api-sports stays the record: the table (`log`), try counts and
// every finished row are still its own, and a row it has called FT is never
// touched. Data only: the app already reads these fields, so no build.
//
// The rules that keep two vendors from fighting over one row:
//   - A score never goes backwards on ESPN's word. ESPN is taken only when it
//     is level or ahead on BOTH sides and ahead on a side or a phase.
//   - The exception is a row ESPN wrote: if ESPN then corrects itself (a try
//     chalked off), its newer number replaces its older one.
//   - After every api-sports pass the overlay is laid again before the
//     publish, so a slower vendor answer cannot drag a fresher score back.
//   - Anything going wrong here is logged and skipped. It can never fail a
//     pass: the api-sports feed must keep publishing with ESPN down.

import { readFile, writeFile } from "node:fs/promises";
import { fetchLiveStates } from "./build-fixtures.mjs";
import { ESPN_TEAM_IDS } from "./fetch-espn-fixtures.mjs";
import { API_SPORTS_CODE_BY_ID } from "./static-fixtures.mjs";

const SITE = "https://site.api.espn.com/apis/site/v2/sports/rugby";
export const ESPN_NATIONS_LEAGUE = 17567;
export const OVERLAY_INTERVAL_MS = 3 * 60000;   // the fixtures burst's cadence
const MATCH_WINDOW_MS = 24 * 3600 * 1000;       // same pairing, same day
const ESPN_CODE_BY_ID = Object.fromEntries(Object.entries(ESPN_TEAM_IDS).map(([code, id]) => [String(id), code]));

// ESPN says "1st Half" / "Halftime" / "2nd Half"; nations.json has always
// carried api-sports' 1H / HT / 2H, and the app prints `status.short` as it
// arrives. Keep one vocabulary so the label doesn't flip between passes.
// Anything unrecognised returns null and the row keeps the phase it had.
export function phaseOf(short) {
  const s = String(short ?? "").trim();
  if (/^(ft|full.?time|final)$/i.test(s)) return "FT";
  if (/^(ht|half.?time)$/i.test(s)) return "HT";
  if (/^(1h|1st)/i.test(s)) return "1H";
  if (/^(2h|2nd)/i.test(s)) return "2H";
  return null;
}
const PHASE_RANK = { "1H": 1, HT: 2, "2H": 3, FT: 4 };
const LONG = { "1H": "First Half", HT: "Halftime", "2H": "Second Half", LIVE: "In Progress", FT: "Finished" };

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ESPN's in-play and finished Nations Championship games near `nowMs`, as
// [{ key: "FRA-FIJ", date, home, away, live, short }]. One request: the
// year form is the one ESPN still answers (day ranges stopped on 18 Sep
// 2026; see fetch-league-fixtures.mjs). Games not yet kicked off are left out
// by fetchLiveStates, as is ESPN's "post, 0-0" placeholder.
export async function fetchEspnNationsStates({ fetchJson = getJson, nowMs = Date.now() } = {}) {
  const year = new Date(nowMs).getUTCFullYear();
  const board = await fetchJson(`${SITE}/${ESPN_NATIONS_LEAGUE}/scoreboard?dates=${year}`);
  const out = [];
  for (const event of Array.isArray(board?.events) ? board.events : []) {
    const t = Date.parse(event?.date);
    if (!Number.isFinite(t) || Math.abs(t - nowMs) > MATCH_WINDOW_MS) continue;
    const sides = {};
    for (const c of event.competitions?.[0]?.competitors ?? []) {
      sides[c.homeAway] = ESPN_CODE_BY_ID[String(c.team?.id ?? "")];
    }
    if (!sides.home || !sides.away) continue;
    const state = (await fetchLiveStates([{ event }], fetchJson))[`espn-${event.id}`];
    if (!state) continue;
    out.push({ key: `${sides.home}-${sides.away}`, date: event.date, ...state });
  }
  return out;
}

const scoreStr = (h, a) => `${h ?? 0}-${a ?? 0}`;

// Pure. Lays ESPN's states over a nations.json document and returns
// { doc, changes }: a new document when something moved, the same object
// when nothing did. `owned` (key -> "h-a") remembers the scores this module
// wrote, across passes of one burst; it is updated in place.
export function applyEspnOverlay(doc, states, { owned = new Map() } = {}) {
  const byKey = new Map((states ?? []).map((s) => [s.key, s]));
  const changes = [];
  const lift = (row) => {
    const key = `${API_SPORTS_CODE_BY_ID[row.home?.id]}-${API_SPORTS_CODE_BY_ID[row.away?.id]}`;
    // ESPN may list a neutral-venue game (finals weekend) the other way round.
    const [h, a] = key.split("-");
    const flipped = byKey.get(`${a}-${h}`);
    const s = byKey.get(key) ?? (flipped && { ...flipped, home: flipped.away, away: flipped.home });
    if (!s) return row;
    if (Math.abs(Date.parse(s.date) - Date.parse(row.date)) > MATCH_WINDOW_MS) return row;

    const rowPhase = phaseOf(row.status?.short);
    // api-sports' final is the record; ESPN never reopens or rescores it.
    if (rowPhase === "FT" && !row.status?.via) return row;

    const rh = row.home?.score ?? 0, ra = row.away?.score ?? 0;
    const phase = s.live ? phaseOf(s.short) ?? (row.status?.live ? row.status.short : "LIVE") : "FT";
    const sameScore = s.home === rh && s.away === ra;
    if (sameScore && phase === row.status?.short) return row;

    const ours = owned.get(key) === scoreStr(row.home?.score, row.away?.score) && row.status?.via === "espn";
    const ahead =
      s.home >= rh && s.away >= ra &&
      (!sameScore || (PHASE_RANK[phase] ?? 0) > (PHASE_RANK[rowPhase] ?? 0) || !row.status?.live);
    if (!ours && !ahead) return row;

    changes.push({ key, from: `${row.status?.short ?? "?"} ${scoreStr(row.home?.score, row.away?.score)}`, to: `${phase} ${scoreStr(s.home, s.away)}` });
    owned.set(key, scoreStr(s.home, s.away));
    return {
      ...row,
      status: { short: phase, long: LONG[phase] ?? row.status?.long ?? "In Progress", live: !!s.live, via: "espn" },
      home: { ...row.home, score: s.home },
      away: { ...row.away, score: s.away },
    };
  };

  const results = (doc.results ?? []).map(lift);
  // A game api-sports still lists as upcoming moves to `results` the moment
  // ESPN has it in play: the app's fast poll looks for a live row there.
  const fixtures = [];
  for (const row of doc.fixtures ?? []) {
    const next = lift(row);
    if (next === row) fixtures.push(row);
    else results.push(next);
  }
  if (!changes.length) return { doc, changes };
  results.sort((a, b) => new Date(a.date) - new Date(b.date));
  return {
    doc: {
      ...doc,
      updatedAt: new Date().toISOString(),
      counts: doc.counts ? { ...doc.counts, fixtures: fixtures.length, results: results.length } : doc.counts,
      fixtures,
      results,
    },
    changes,
  };
}

// One pass for the burst: fetch, lay over the file on disk, write only when a
// row moved. Returns the number of rows changed. NEVER throws. When ESPN
// can't be reached the last good states are laid again, which is what stops
// an api-sports pass from pulling a score back while ESPN is down.
export function makeOverlayPass({
  path = "public/nations.json",
  fetchStates = fetchEspnNationsStates,
  read = (p) => readFile(p, "utf8"),
  write = (p, text) => writeFile(p, text),
  log = console.log,
  warn = console.warn,
} = {}) {
  const owned = new Map();
  let last = [];
  return async function overlayPass() {
    try {
      try {
        last = await fetchStates();
      } catch (err) {
        warn(`[espn-overlay] ESPN unreachable (${err.message}); keeping the last ${last.length} state(s)`);
      }
      if (!last.length) return 0;
      const { doc, changes } = applyEspnOverlay(JSON.parse(await read(path)), last, { owned });
      if (!changes.length) return 0;
      await write(path, JSON.stringify(doc, null, 2));
      for (const c of changes) log(`[espn-overlay] ${c.key}: ${c.from} -> ${c.to}`);
      return changes.length;
    } catch (err) {
      warn(`[espn-overlay] pass skipped: ${err.message}`);
      return 0;
    }
  };
}
