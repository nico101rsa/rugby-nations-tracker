// World Rugby rating points at stake in one fixture, worked out from
// rankings.json so the storyline writer (build-storylines.mjs) never does the
// arithmetic itself, and a reader gets "win and Fiji go 9th; lose and Japan
// drop out of the top 12" instead of "Japan are 9th and Fiji 10th".
//
// The exchange formula, fitted to rankings.json's own history on 21 Oct 2026
// over every week where the app holds all the games between its nations
// (13→20 Jul, 31 Aug→7 Sep, 14→28 Sep, 5→12 Oct and 12→19 Oct 2026; worst
// residual 0.006 points, and rankings-stakes.test.mjs pins those weeks):
//   gap   the stronger side's rating minus the weaker side's, capped at 10
//   win by the stronger side   1 − gap/10
//   win by the weaker side     1 + gap/10
//   draw                       gap/10, from the stronger side to the weaker
//   winning margin over 15     ×1.5
//   Rugby World Cup            ×2 (from 2027; not exercised yet)
// The winner gains the exchange and the loser loses the same amount.
// NO home advantage. Explainers describe a +3 weighting for the home side;
// the 2026 numbers do not carry one — the July tour week, with every host at
// home, misses by 0.3–0.7 points under it and fits to 0.004 without. If World
// Rugby changes the formula, the real-week tests fail before a storyline is
// wrong.
//
// Ranks after the game are only stated where the table settles them. The
// app's table holds its twelve nations; every nation outside it has at most
// the points of the lowest-ranked nation in it (the ranks are 1–12 today), so
// a side that stays at or above that floor has an exact new rank, and a side
// that falls below it gets a best case ("12th at best").

export const GAP_CAP = 10;
export const BIG_MARGIN = 15; // "over 15": a margin of 16 or more

const round2 = (n) => Math.round(n * 100) / 100;

// Rating points side A gains (negative: loses). `result` is A's: W, D or L.
export function exchange({ a, b, result, margin = 0, worldCup = false }) {
  const gap = Math.min(GAP_CAP, Math.abs(a - b));
  const aStronger = a > b;
  let p;
  if (result === "D") p = (aStronger ? -1 : 1) * (gap / 10);
  else if (result === "W") p = aStronger ? 1 - gap / 10 : 1 + gap / 10;
  else if (result === "L") p = -(aStronger ? 1 + gap / 10 : 1 - gap / 10);
  else throw new Error(`exchange: result must be W, D or L, got ${result}`);
  if (result !== "D" && margin > BIG_MARGIN) p *= 1.5;
  if (worldCup) p *= 2;
  return p;
}

// Do the table's ranks run 1..N with no gap? Then every nation outside it is
// at or below the table's lowest points.
export function tableComplete(table) {
  const ranks = Object.values(table ?? {}).map((r) => r?.rank).filter(Number.isInteger).sort((x, y) => x - y);
  return ranks.length > 0 && ranks.every((r, i) => r === i + 1);
}

// Where `code` stands once it has `points`, with its opponent `other` on
// `otherPoints` and everyone else unmoved. `exact` is false below the floor;
// `rank` is null when the table is incomplete (then only who it passes, or
// is passed by, among the table's nations can be said).
export function rankAfter(table, { code, points, other, otherPoints }) {
  const rows = Object.entries(table ?? {}).filter(([c, r]) => c !== code && r && Number.isFinite(r.points));
  const after = (c, r) => (c === other ? otherPoints : r.points);
  const above = rows.filter(([c, r]) => after(c, r) > points + 1e-9).length;
  const complete = tableComplete(table);
  const floor = complete ? Math.min(...Object.values(table).map((r) => r.points)) : Infinity;
  const before = table[code]?.points;
  const passed = rows.filter(([c, r]) => r.points > before && after(c, r) < points - 1e-9).map(([c]) => c);
  const passedBy = rows.filter(([c, r]) => r.points < before && after(c, r) > points + 1e-9).map(([c]) => c);
  return { rank: complete ? above + 1 : null, exact: complete && points >= floor - 1e-9, passed, passedBy };
}

// The five results a writer might want: each side winning by up to 15 or by
// 16+, and a draw. Null when either side is missing from the table.
export const SCENARIOS = [
  { key: "home-win-big", side: "home", result: "W", margin: 16 },
  { key: "home-win", side: "home", result: "W", margin: 1 },
  { key: "draw", side: null, result: "D", margin: 0 },
  { key: "away-win", side: "away", result: "W", margin: 1 },
  { key: "away-win-big", side: "away", result: "W", margin: 16 },
];

export function stakesFor(rankings, home, away, { worldCup = false } = {}) {
  const table = rankings?.rankings ?? {};
  const h = table[home];
  const a = table[away];
  if (!h || !a || !Number.isFinite(h.points) || !Number.isFinite(a.points)) return null;
  const scenarios = SCENARIOS.map((s) => {
    const homeResult = s.result === "D" ? "D" : s.side === "home" ? "W" : "L";
    const dh = exchange({ a: h.points, b: a.points, result: homeResult, margin: s.margin, worldCup });
    const hp = round2(h.points + dh);
    const ap = round2(a.points - dh);
    return {
      key: s.key,
      side: s.side,
      bigWin: s.margin > BIG_MARGIN,
      home: { points: hp, delta: round2(dh), ...rankAfter(table, { code: home, points: hp, other: away, otherPoints: ap }) },
      away: { points: ap, delta: round2(-dh), ...rankAfter(table, { code: away, points: ap, other: home, otherPoints: hp }) },
    };
  });
  return {
    asOf: rankings.asOf ?? null,
    worldCup,
    complete: tableComplete(table),
    size: Object.keys(table).length,
    home: { code: home, rank: h.rank, points: h.points },
    away: { code: away, rank: a.rank, points: a.points },
    scenarios,
  };
}

// How a side got to where it is: its rank now, since when, what it was
// before that, this week's move and the range over the stored history.
export function rankTrajectory(rankings, code) {
  const now = rankings?.rankings?.[code];
  if (!now) return null;
  const snaps = (rankings.history ?? [])
    .filter((s) => s?.asOf && Number.isInteger(s.rankings?.[code]?.rank))
    .map((s) => ({ asOf: s.asOf, t: Date.parse(`${s.asOf} 12:00:00 UTC`), rank: s.rankings[code].rank, points: s.rankings[code].points }))
    .filter((s) => Number.isFinite(s.t))
    .sort((x, y) => x.t - y.t);
  const all = [...snaps, { asOf: rankings.asOf ?? null, rank: now.rank, points: now.points }];
  let i = all.length - 1;
  while (i > 0 && all[i - 1].rank === now.rank) i--;
  const since = all[i].asOf;
  const previous = i > 0 ? { rank: all[i - 1].rank, asOf: all[i - 1].asOf } : null;
  const ranks = all.map((s) => s.rank);
  return {
    rank: now.rank,
    points: now.points,
    move: Number.isFinite(now.move) ? now.move : null,
    since,
    previous,
    best: Math.min(...ranks),
    worst: Math.max(...ranks),
    firstAsOf: all[0].asOf,
    snapshots: all.length,
  };
}

export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

const signed = (n) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(2)}`;

const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

// "stay 9th" / "up to 9th, above Japan" / "below Wales and Italy; 12th at best".
// The "at best" case is explained once, in the pack's section note.
export function describeMove(before, after, names = {}) {
  const nm = (c) => names[c] ?? c;
  if (after.rank == null) {
    if (after.passed.length) return `above ${list(after.passed.map(nm))}`;
    if (after.passedBy.length) return `below ${list(after.passedBy.map(nm))}`;
    return "order unchanged";
  }
  if (!after.exact) {
    const below = after.passedBy.length ? `below ${list(after.passedBy.map(nm))}; ` : "";
    return `${below}${ordinal(after.rank)} at best`;
  }
  if (after.rank === before) return `stay ${ordinal(after.rank)}`;
  if (after.rank < before) return `up to ${ordinal(after.rank)}${after.passed.length ? `, above ${list(after.passed.map(nm))}` : ""}`;
  return `down to ${ordinal(after.rank)}${after.passedBy.length ? `, below ${list(after.passedBy.map(nm))}` : ""}`;
}

// The pack lines, one per scenario, the winner first. `names` maps codes to
// team names.
export function renderStakes(stakes, names = {}) {
  if (!stakes) return [];
  const nm = (c) => names[c] ?? c;
  const H = stakes.home.code;
  const A = stakes.away.code;
  const side = (c, s) => `${nm(c)} ${signed(s.delta)} to ${s.points.toFixed(2)} (${describeMove(stakes[c === H ? "home" : "away"].rank, s, names)})`;
  return stakes.scenarios.map((s) => {
    const what = s.side === null ? "Draw" : `${nm(s.side === "home" ? H : A)} win by ${s.bigWin ? "16 or more" : "15 or fewer"}`;
    const order = s.side === "away" ? [[A, s.away], [H, s.home]] : [[H, s.home], [A, s.away]];
    return `- ${what}: ${order.map(([c, x]) => side(c, x)).join("; ")}.`;
  });
}

// "9th (77.28 pts), 9th since 28 September 2026 (12th before that); range since 13 July 2026: 9th–12th".
export function renderTrajectory(tr) {
  if (!tr) return null;
  const parts = [`${ordinal(tr.rank)} (${tr.points} pts)`];
  if (tr.move) parts.push(`${tr.move > 0 ? "up" : "down"} ${Math.abs(tr.move)} this week`);
  if (tr.previous) parts.push(`${ordinal(tr.rank)} since ${tr.since} (${ordinal(tr.previous.rank)} before that)`);
  else if (tr.snapshots > 1) parts.push(`${ordinal(tr.rank)} in every table since ${tr.firstAsOf}`);
  if (tr.snapshots > 1 && tr.best !== tr.worst) parts.push(`range since ${tr.firstAsOf}: ${ordinal(tr.best)}–${ordinal(tr.worst)}`);
  return parts.join(", ");
}
