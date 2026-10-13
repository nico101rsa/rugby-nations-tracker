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

// ---- Penalty tries the label hides (issue #143) ----------------------------
//
// A penalty try is the only single scoring event worth 7: no conversion is
// taken. Neither source labels it reliably. Argentina 24-31 England (18 Jul
// 2026) had one, awarded to Argentina for Alex Coles' deliberate knock-on
// (Sky, TNT, AP), and the 12 Oct run saw the vendor sum Argentina to 22 (two
// short: the penalty try worth 5) and ESPN to 17 (seven short: no row for it
// at all — its 20 non-substitution rows are 13 scores and the 7 yellow cards
// the reports count). Both sources do carry a running score, so each gets a
// second reading that types a penalty try from it.
//
// That reading is never the first one. A list that reconciles as labelled
// publishes as labelled; the second reading is tried only on a list that has
// already failed the gate, and it publishes only if it then passes the same
// gate against the api-sports final.
//
// Nor does the vendor's reading pre-empt ESPN (PR #150 review). A 7-point
// step is also what a LOST CONVERSION looks like: the vendor drops the
// conversion incident but keeps the true running score, and the next try by
// the same side then jumps 5 + 2. That is the #48 class of gap ("one scoring
// event short"), and it explains a 2-point shortfall like 22/24 as well as a
// mistyped penalty try does. So a failed vendor list goes to ESPN first, as
// labelled and with ESPN's own penalty-try reading; ESPN is keyless and costs
// no quota. The vendor's 7-point reading is the last resort, tried only once
// ESPN has answered and could not reconcile either, and never against ESPN's
// word (vendorPenaltyTries and espnSaysConverted below).

// A penalty try is never converted: the next scoring event after one can't be
// a conversion by the same side. A list that reads that way has mistaken a
// try, and its lost or merged conversion, for a penalty try.
const sameSide = (x, s, type) => x?.type === type && x.team === s.team;
export function penaltyTryConverted(scoring = []) {
  return scoring.some((s, k) => s.type === "penaltyTry" && sameSide(scoring[k + 1], s, "conversion"));
}

// Vendor: every goal incident carries the score after it. A `try` incident
// that moves its own side by exactly 7, with the other side unchanged, is a
// penalty try the vendor delivered as a plain try — unless the list around
// it says otherwise:
//   - the scoring event just before it is a try by the same side: that try's
//     conversion may be the lost 2 (try 5-0, conversion lost, try 12-0), so
//     the step proves nothing;
//   - the scoring event just after it is a conversion by the same side: a
//     penalty try is never converted (penaltyTryConverted).
//
// The vendor can also credit a penalty try as 5 (issue #143, the 13 Oct run:
// Argentina's 55' try, no player, 10 -> 15, the list ending on 22 of 24).
// A 5-point step is what every ordinary try looks like, so that reading
// needs two more things the ordinary try doesn't have, and the final:
//   - no player: a penalty try is awarded to the team, and the vendor sent
//     every other try in the match with its scorer;
//   - the vendor's own running score for that side ends exactly 2 short of
//     the final for each such try. A LOST CONVERSION does not do that: the
//     vendor drops the incident but keeps the true score (the #48 class), so
//     its last running score still equals the final.
// Without `finals` the 5-point reading is never tried.
// Returns the retyped list, or null when no try reads that way. Penalty
// tries credit no player, as buildAggregates expects.
export function vendorPenaltyTries(scoring = [], finals = null) {
  const scoreOf = (s) => Array.isArray(s.after) && s.after.every((x) => typeof x === "number" && Number.isFinite(x)) ? s.after : null;
  let prev = [0, 0];
  let changed = false;
  const fives = { home: 0, away: 0 };
  const out = scoring.map((s, k) => {
    const after = scoreOf(s);
    let next = s;
    if (after && prev && s.type === "try") {
      const i = s.team === "home" ? 0 : 1;
      const step = after[i] - prev[i];
      const alone = after[1 - i] === prev[1 - i];
      const lostConversion = sameSide(scoring[k - 1], s, "try");
      const converted = sameSide(scoring[k + 1], s, "conversion");
      const five = step === 5 && alone && s.player == null && finals != null;
      if (((step === 7 && alone) || five) && !lostConversion && !converted) {
        next = { ...s, type: "penaltyTry", player: null, ...(five ? { fivePoint: true } : {}) };
        if (five) fives[s.team]++;
        changed = true;
      }
    }
    prev = after; // an incident without a score breaks the chain until the next one with it
    return next;
  });
  if (!changed) return null;
  // A 5-point reading stands only if the vendor's last running score for that
  // side is short of the final by exactly 2 per such try; otherwise those
  // tries go back to plain tries (a 7-point reading is unaffected).
  for (const team of ["home", "away"]) {
    if (!fives[team]) continue;
    const i = team === "home" ? 0 : 1;
    const last = [...scoring].reverse().map(scoreOf).find(Boolean);
    if (!(last && last[i] === finals[team] - 2 * fives[team])) {
      for (let k = 0; k < out.length; k++) if (out[k].fivePoint && out[k].team === team) out[k] = scoring[k];
    }
  }
  const final = out.map(({ fivePoint, ...rest }) => rest);
  return final.some((x, k) => x.type !== scoring[k].type) ? final : null;
}

// ESPN, read but not reconciled, can still contradict a vendor penalty try:
// a try by the same side within 3 minutes of it, which ESPN follows with that
// side's conversion, is a converted try, and the vendor's 7 is that try and
// its conversion. `espnScoring` is ESPN's list as labelled.
export function espnSaysConverted(penaltyTry, espnScoring = []) {
  return espnScoring.some((s, k) => s.type === "try" && s.team === penaltyTry.team &&
    s.min != null && penaltyTry.min != null && Math.abs(s.min - penaltyTry.min) <= 3 &&
    sameSide(espnScoring[k + 1], s, "conversion"));
}

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
// (Issue #143, the first real run: that match's gap is a penalty try, and
// ESPN has no row for it either — its "2 tries" leaves it out. See "Penalty
// tries the label hides" above.)
//
// What scrape-tries relies on is ground truth: `type.text`, `team.id`, and
// the competitor ids/`homeAway` on the summary header. Everything else
// (`clock`, the player, a running score) is read defensively and only the
// gate decides. A `type.text` we don't recognise holds the match exactly as
// an unknown vendor class does, and every row is logged in one compact line
// so the Actions log of the next run shows the real payload.
//
// The real payload, first seen on the 12 Oct run (issue #143): `type.text`
// is lower case ("try", "conversion", "penalty goal", "yellow card",
// "player substituted", "substitute on"), the player is
// `participants[0].athlete.displayName` (not `athletesInvolved`, which is the
// soccer shape the #142 tests assumed), and EVERY row, substitutions and
// cards included, carries `homeScore`/`awayScore` — the score at that moment.

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
// "player substituted" + "substitute on" are the pair ESPN writes for each
// replacement (20 pairs in ARG v ENG).
const ESPN_SKIP = /^(substitution|player substituted|substitute (on|off)|kick[ -]?off|half[ -]?time|full[ -]?time|(start|end) of (the )?(period|half|match|game))$/i;

// clock.value is seconds of play; the 1234th second is in the 21st minute.
// displayValue ("21'", "40'+2'") is the fallback when value is absent.
export function espnMinute(clock) {
  const v = Number(clock?.value);
  if (Number.isFinite(v) && v > 0) return Math.ceil(v / 60);
  const m = String(clock?.displayValue ?? "").match(/^\s*(\d+)'?(?:\s*\+\s*(\d+))?/);
  return m ? Number(m[1]) + Number(m[2] ?? 0) : null;
}

const finite = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

// One detail row -> what it is, read the same way by the parser and by the
// penalty-try reading below. `side` maps an ESPN team id to "home"/"away".
function espnRow(d, side) {
  const text = String(d?.type?.text ?? "").trim();
  const goal = ESPN_SCORING.find(([re]) => re.test(text))?.[1] ?? null;
  const card = ESPN_CARDS.find(([re]) => re.test(text))?.[1]
    ?? (d?.redCard === true ? "red" : d?.yellowCard === true ? "yellow" : null);
  const hs = finite(d?.homeScore);
  const as = finite(d?.awayScore);
  return {
    text, goal, card,
    team: side(d?.team),
    min: espnMinute(d?.clock),
    player: d?.participants?.[0]?.athlete?.displayName ?? d?.athletesInvolved?.[0]?.displayName ?? null,
    score: hs != null && as != null ? [hs, as] : null,
  };
}

function espnSide(homeIds, awayIds) {
  const home = new Set(homeIds.map(String));
  const away = new Set(awayIds.map(String));
  return (team) => {
    const id = String(team?.id ?? "");
    return home.has(id) ? "home" : away.has(id) ? "away" : null;
  };
}

// Chronological: by minute, then by the running total where there is one,
// then a conversion after the try it follows. Rows without a minute keep
// their arrival order at the end.
const at = (e) => e.min ?? Number.MAX_SAFE_INTEGER;
const runTotal = (s) => s.after[0] + s.after[1];
const convLast = (s) => (s.type === "conversion" ? 1 : 0);
const byPlay = (a, b) => at(a) - at(b) || (a.after && b.after ? runTotal(a) - runTotal(b) : 0) || convLast(a) - convLast(b);

// ESPN summary details -> the same { scoring, cards, unknown } parseIncidents
// returns, so reconcile() and buildAggregates() see no difference. homeIds and
// awayIds are the competitor ids each side may appear under (competitor id
// and team id, which ESPN usually keeps equal); a row for neither is unknown.
export function parseEspnDetails(details = [], homeIds = [], awayIds = []) {
  const side = espnSide(homeIds, awayIds);
  const scoring = [];
  const cards = [];
  const unknown = [];
  for (const d of details) {
    const { text, goal, card, team, min, player, score } = espnRow(d, side);
    if (!goal && !card) {
      if (!ESPN_SKIP.test(text)) unknown.push(text || "(untyped)");
      continue;
    }
    if (!team) { unknown.push(`${text} for team ${d.team?.id ?? "?"}`); continue; }
    if (goal) scoring.push({ min, team, type: goal, player, after: score });
    else cards.push({ min, team, type: card, player });
  }
  scoring.sort(byPlay);
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

// ESPN: the penalty try has no row at all, but the score on the rows after it
// includes it. Walk every row that carries a score (substitutions and cards
// too) in play order, and keep the gap between ESPN's score and the sum of
// the scoring rows listed so far. For a side, an unlisted penalty try is a
// gap that steps up by exactly 7 from one row to the next and never falls
// back below that for the rest of the match; it is placed at the first row
// that shows it. Anything else — a final gap that isn't a multiple of 7, or
// one that arrives 5 then 2 (a lost try and its conversion with a row in
// between) — is left alone and the gate holds the match. Returns the
// penalty-try events to add (possibly none).
//
// The blind spot, unguarded and accepted: if ESPN drops BOTH a try row and
// its conversion row, and no other row carrying a score falls between them,
// the gap steps 0 to 7 in one go and reads as a penalty try. Every ESPN row
// carries a score (substitutions and cards too), so it takes two adjacent
// rows missing, against a vendor list that has already failed. Nothing
// independent counts the tries (scrape-tries reads this same array), so the
// only check is the impossible shape: a merged list in which a penalty try is
// followed by its side's conversion is not published (penaltyTryConverted).
export function espnPenaltyTries(details = [], homeIds = [], awayIds = []) {
  const side = espnSide(homeIds, awayIds);
  const seconds = (d, min) => {
    const v = Number(d?.clock?.value);
    return Number.isFinite(v) && v > 0 ? v : min != null ? min * 60 : Number.MAX_SAFE_INTEGER;
  };
  const rows = [];
  (Array.isArray(details) ? details : []).forEach((d, idx) => {
    const r = espnRow(d, side);
    if (!r.score) return;
    const pts = [0, 0];
    if (r.goal && r.team) pts[r.team === "home" ? 0 : 1] = POINTS[r.goal];
    rows.push({ t: seconds(d, r.min), idx, min: r.min, score: r.score, pts });
  });
  rows.sort((a, b) => a.t - b.t || (a.score[0] + a.score[1]) - (b.score[0] + b.score[1]) || a.idx - b.idx);
  if (!rows.length) return [];

  const listed = [0, 0];
  const gap = rows.map((r) => {
    listed[0] += r.pts[0];
    listed[1] += r.pts[1];
    return [r.score[0] - listed[0], r.score[1] - listed[1]];
  });

  const out = [];
  for (const [i, team] of [[0, "home"], [1, "away"]]) {
    const g = gap.map((x) => x[i]);
    const last = g.at(-1);
    if (!(last > 0 && last % 7 === 0)) continue;
    const floor = new Array(g.length); // floor[j] = the lowest gap from row j to the end
    for (let j = g.length - 1, lo = Infinity; j >= 0; j--) floor[j] = lo = Math.min(lo, g[j]);
    const found = [];
    for (let level = 7; level <= last; level += 7) {
      const j = floor.findIndex((x) => x >= level);
      const before = j > 0 ? g[j - 1] : 0;
      if (before !== level - 7 || g[j] !== level) { found.length = 0; break; } // not one clean 7-point step
      const after = [...(j > 0 ? rows[j - 1].score : [0, 0])];
      after[i] += 7;
      found.push({ min: rows[j].min, team, type: "penaltyTry", player: null, after });
    }
    out.push(...found);
  }
  return out;
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

// "player substituted ×20", not the same words twenty times (issue #143's body).
const tally = (list) => {
  const n = new Map();
  for (const x of list) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n].map(([x, k]) => (k > 1 ? `${x} ×${k}` : x)).join(", ");
};

const reasonFor = (gate, unknown, label) =>
  `did not reconcile: home ${gate.home.computed}/${gate.home.expected}, away ${gate.away.computed}/${gate.away.expected}` +
  (unknown.length ? `; unknown ${label}: ${tally(unknown)}` : "");

// A list that fails is logged whole, one short entry per row, so the next
// failure can be diagnosed from the Actions log alone. #142 logged ESPN's raw
// JSON cut at 4000 characters, which the substitution rows filled before the
// second half began: the rows that mattered for #143 were never seen.
const score = (h, a) => `${finite(h) ?? "?"}-${finite(a) ?? "?"}`;
export function vendorIncidentsLine(incidents = []) {
  return incidents
    .filter((i) => i?.incidentType === "goal" || i?.incidentType === "card")
    .map((i) => `${i.time ?? "?"}' ${i.incidentType}:${i.incidentClass} ${i.isHome ? "home" : "away"}` +
      (i.incidentType === "goal" ? ` ${score(i.homeScore, i.awayScore)}` : "") + ` ${i.player?.name ?? "(no player)"}`)
    .join("; ");
}
export function espnRowsLine(details = []) {
  return details.map((d) => {
    const text = String(d?.type?.text ?? "").trim() || "(untyped)";
    const who = ESPN_SKIP.test(text) ? "" : ` ${d?.participants?.[0]?.athlete?.displayName ?? d?.athletesInvolved?.[0]?.displayName ?? "(no player)"}`;
    return `${espnMinute(d?.clock) ?? "?"}' ${text} t${d?.team?.id ?? "?"} ${score(d?.homeScore, d?.awayScore)}${who}`;
  }).join("; ");
}
const LOG_LIMIT = 8000;

// Second-source attempt for one match: ESPN scoreboard (match day, then ±1 —
// kickoffs cross the UTC date line) -> event summary -> the same gate.
// Returns { ok, scoring, cards, espnEventId } or { ok: false, reason, scoring }
// (ESPN's list as labelled, empty when there was no event); the caller folds
// the reason into the vendor's so a held match reports both. A fetch that
// fails throws: ESPN has not answered, which is not the same as a "no".
async function reconcileFromEspn(r, fetchEspn, scoreboard) {
  let ev = null;
  for (const shift of [0, 1, -1]) {
    const day = dayShift(r.date, shift);
    const events = await scoreboard(day);
    ev = findEspnEvent(events, r.date, r.home.name);
    if (ev) break;
    console.log(`ESPN scoreboard ${day}: ${events.map((e) => `${e.id} ${e.date} ${espnHome(e)?.team?.displayName ?? "?"}`).join("; ") || "no events"}`.slice(0, 1000));
  }
  if (!ev) return { ok: false, reason: `no ESPN event for ${r.home.name} at ${r.date}`, scoring: [] };

  const summary = await fetchEspn(`${ESPN}/summary?event=${ev.id}`);
  const comp = summary?.header?.competitions?.[0];
  const ids = (side) => {
    const c = comp?.competitors?.find((x) => x.homeAway === side);
    return [c?.id, c?.team?.id].filter((x) => x != null);
  };
  const details = Array.isArray(comp?.details) ? comp.details : [];
  const { scoring: listed, cards, unknown } = parseEspnDetails(details, ids("home"), ids("away"));
  let scoring = listed;
  let gate = reconcile(scoring, r.home.score, r.away.score);
  // Second reading, only for a list that failed: a penalty try ESPN left out
  // of the rows but kept in the score (issue #143).
  if (!gate.ok && !unknown.length) {
    const added = espnPenaltyTries(details, ids("home"), ids("away"));
    if (added.length) {
      const withPenaltyTries = [...listed, ...added].sort(byPlay);
      const reread = reconcile(withPenaltyTries, r.home.score, r.away.score);
      const converted = penaltyTryConverted(withPenaltyTries);
      console.log(`ESPN event ${ev.id} for match ${r.id}: the running score shows ${added.length} penalty try(s) with no row (${added.map((p) => `${p.team} ${p.min ?? "?"}'`).join(", ")}); with them ${converted ? "a penalty try is followed by its side's conversion, which can't happen: not used" : reread.ok ? "it reconciles" : `still home ${reread.home.computed}/${reread.home.expected}, away ${reread.away.computed}/${reread.away.expected}`}`);
      if (reread.ok && !converted) { scoring = withPenaltyTries; gate = reread; }
    }
  }
  if (gate.ok && !unknown.length) return { ok: true, scoring, cards, espnEventId: ev.id };

  // The follow-up needs the real payload and the Actions log is the only
  // place it can be seen: every row in one line, plus the raw JSON of any row
  // we could not read. Bounded so a long match can't flood the log.
  console.log(`ESPN event ${ev.id} rows for match ${r.id} (${details.length}): ${espnRowsLine(details)}`.slice(0, LOG_LIMIT));
  const side = espnSide(ids("home"), ids("away"));
  const unread = details.filter((d) => {
    const row = espnRow(d, side);
    return (!row.goal && !row.card) ? !ESPN_SKIP.test(row.text) : !row.team;
  });
  if (unread.length) console.log(`ESPN event ${ev.id} rows not recognised: ${JSON.stringify(unread)}`.slice(0, LOG_LIMIT));
  return { ok: false, reason: `ESPN event ${ev.id} ${reasonFor(gate, unknown, "event types")}`, scoring: listed };
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
      const incidents = payload?.data?.incidents ?? [];
      const { scoring, cards, unknown } = parseIncidents(incidents);
      const gate = reconcile(scoring, r.home.score, r.away.score);
      if (gate.ok && !unknown.length) {
        Object.assign(entry, { reconciled: true, scoring, cards });
      } else {
        // Second source. Only a vendor list that arrived but won't add up gets
        // here: a vendor outage or a failed schedule lookup still throws above
        // and is retried next run as before.
        const vendorReason = reasonFor(gate, unknown, "incident classes");
        console.log(`vendor incidents for match ${r.id} (${incidents.length}): ${vendorIncidentsLine(incidents)}`.slice(0, LOG_LIMIT));
        let espnAnswered = true;
        const espn = await reconcileFromEspn(r, fetchEspn, scoreboard)
          .catch((e) => { espnAnswered = false; return { ok: false, reason: `ESPN: ${e.message}`, scoring: [] }; });
        if (espn.ok) {
          console.log(`match ${r.id} (${r.home.name} v ${r.away.name}): vendor ${vendorReason}; reconciled from ESPN event ${espn.espnEventId}`);
          Object.assign(entry, { reconciled: true, source: "espn", scoring: espn.scoring, cards: espn.cards });
        } else {
          // Last resort: the vendor's own list with a 7-point "try" read as a
          // penalty try (issue #143; same payload, no call). Only once ESPN has
          // answered and could not reconcile either — ESPN unreachable holds
          // the match for the next run instead, since a published match is
          // never fetched again — and never where ESPN shows a converted try.
          const retyped = espnAnswered && !unknown.length ? vendorPenaltyTries(scoring, { home: r.home.score, away: r.away.score }) : null;
          const added = retyped ? retyped.filter((x, k) => x.type !== scoring[k].type) : [];
          const reread = retyped && reconcile(retyped, r.home.score, r.away.score);
          const against = added.filter((pt) => espnSaysConverted(pt, espn.scoring));
          const where = added.map((x) => `${x.team} ${x.min}'`).join(", ");
          if (reread?.ok && against.length) {
            console.log(`match ${r.id} (${r.home.name} v ${r.away.name}): the vendor reconciles reading a try as a penalty try (${where}), but ESPN lists a converted try there; held`);
          }
          if (!reread?.ok || against.length) throw new Error(`${vendorReason}; ${espn.reason}`);
          console.log(`match ${r.id} (${r.home.name} v ${r.away.name}): vendor ${vendorReason} as labelled; ${espn.reason}; the vendor reconciles reading the try(s) as penalty try (${where})`);
          Object.assign(entry, { reconciled: true, scoring: retyped, cards });
        }
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
