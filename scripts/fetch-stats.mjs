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
