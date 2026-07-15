// scripts/fetch-stats.mjs
//
// Box-score stats pipeline. Harvests scoring events + cards for finished
// Nations Championship matches from the sports-data vendor, publishes only
// matches whose events sum EXACTLY to the final score already in nations.json
// (the arithmetic gate), and opens a per-match GitHub issue when one won't
// reconcile. Runs daily from .github/workflows/stats.yml; zero manual steps.

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

// One issue per match: create on first failure, close on recovery, never spam.
export function decideAlert(existingIssue, reconciled) {
  if (reconciled) return existingIssue ? "close" : "noop";
  return existingIssue ? "noop" : "create";
}
