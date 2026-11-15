// What has happened in a game that is still on: tries, kicks and cards with
// the minute each came in, and roughly what minute it is now.
//
// Nico, Sun 15 Nov 2026: "When it shows live score we should have a game
// card... tries, minutes passed, yellow (min), red (min)." Until then a live
// game in the app was a score and a phase; the box score arrived the next
// morning (fetch-stats.mjs, daily).
//
// Source and rights. ESPN's keyless event summary, the same rows fetch-stats
// reads after the game, asked once per live game on each overlay pass
// (espn-live-overlay.mjs, every 3 minutes). This is a live surface built on
// ESPN's data, the exposure the app repo's docs/DATA_RIGHTS.md flags most, so
// Nico was asked and chose it on 15 Nov 2026 with two limits:
//
//   - NO PLAYER NAMES. A row here is { min, team, type } and nothing else.
//     Who scored is in stats.json after the game, as before.
//   - ONE SWITCH. PUBLISH_LIVE_EVENTS = false strips `play` from every row at
//     the next refresh, on every installed copy, with no app build. That is
//     the fire escape if a letter ever arrives.
//
// Nothing here is gated the way the box score is: these rows have not been
// summed against a final score, because there isn't one yet. So the app
// shows them as the game's running notes, never as a count that feeds the
// table. Try counts for the table still come from match-tries.json.
import { parseEspnDetails } from "./fetch-stats.mjs";
import { phaseOf } from "./espn-live-overlay.mjs";

export const PUBLISH_LIVE_EVENTS = true;

// The minute is an ESTIMATE from the wall clock, and the app prints it with
// a "~". ESPN's own clock is no use: in this module's first live game
// (Scotland v Australia, Mon 16 Nov 2026) it read 1' at kickoff and never
// moved, as it had at Ellis Park on 22 Aug, so the published "minute" was
// only ever the minute of the last event: 44' for half an hour of the second
// half while the game went on to the 70th. Now:
//
//   first half    minutes since the listed kickoff, up to 40
//   second half   40 + minutes since the pass that first saw the second half
//                 (remembered for the burst; a burst that starts mid-half
//                 assumes it began SECOND_HALF_AFTER_MIN after kickoff)
//   half time     none
//
// and never behind the game's own last event. Stoppages make the wall clock
// run ahead of the referee's by a few minutes; a late kickoff does the same.
// That is what the "~" is for.
export const SECOND_HALF_AFTER_MIN = 60;
const FIRST_HALF_WINDOW_MIN = 50;
const MIN_MS = 60_000;

// ESPN summary -> [{ min, team, type }], oldest first. `type` is one of try,
// penaltyTry, conversion, penalty, dropGoal, yellow, red. Rows for neither
// side, and anything unrecognised, are left out: a live card can miss a row,
// it must not invent one.
export function liveEventsFrom(summary) {
  const comp = summary?.header?.competitions?.[0];
  const ids = (side) => {
    const c = comp?.competitors?.find((x) => x.homeAway === side);
    return [c?.id, c?.team?.id].filter((x) => x != null);
  };
  const details = Array.isArray(comp?.details) ? comp.details : [];
  const { scoring, cards } = parseEspnDetails(details, ids("home"), ids("away"));
  const rows = [
    ...scoring.map((s, i) => ({ min: s.min, team: s.team, type: s.type, i })),
    ...cards.map((c, i) => ({ min: c.min, team: c.team, type: c.type, i: scoring.length + i })),
  ];
  const at = (e) => e.min ?? Number.MAX_SAFE_INTEGER;
  // Same minute: scores keep the order the parser gave them, cards follow.
  return rows.sort((a, b) => at(a) - at(b) || a.i - b.i).map(({ min, team, type }) => ({ min: min ?? null, team, type }));
}

// The half a live state is in: its own word for it, else the first half
// while the kickoff is under FIRST_HALF_WINDOW_MIN ago (ESPN's label at
// kickoff is a bare minute), else unknown.
export function halfOf(state, nowMs) {
  const phase = phaseOf(state?.short);
  if (phase === "1H" || phase === "2H" || phase === "HT") return phase;
  const since = (nowMs - Date.parse(state?.date)) / MIN_MS;
  return since >= 0 && since < FIRST_HALF_WINDOW_MIN ? "1H" : null;
}

// The estimated minute for one live state, or null (half time, a half we
// can't name). `secondHalfAt` (ms) is when the second half was first seen.
export function estimateMinute(state, nowMs, secondHalfAt = null) {
  const half = halfOf(state, nowMs);
  const kickoff = Date.parse(state?.date);
  if (!Number.isFinite(kickoff) || (half !== "1H" && half !== "2H")) return null;
  const last = Math.max(0, ...(state.events ?? []).map((e) => e.min ?? 0));
  if (half === "1H") return Math.max(1, Math.min(40, Math.ceil((nowMs - kickoff) / MIN_MS)), last);
  const from = secondHalfAt ?? kickoff + SECOND_HALF_AFTER_MIN * MIN_MS;
  return Math.max(41, 40 + Math.ceil((nowMs - from) / MIN_MS), last);
}

// Live states with their minute for this pass. `halves` (key -> ms) is the
// burst's memory of when each game's second half was first seen; it is
// updated in place.
export function withMinutes(states, halves, nowMs) {
  return (states ?? []).map((s) => {
    if (!s.live) return s;
    if (halfOf(s, nowMs) === "2H" && !halves.has(s.key)) {
      // First sight of the second half. If this pass is also the first sight
      // of the game (a burst that began mid-half), there is nothing to time
      // it from: fall back to the usual gap after kickoff.
      halves.set(s.key, halves.has(`seen ${s.key}`) ? nowMs : null);
    }
    halves.set(`seen ${s.key}`, true);
    return { ...s, minute: estimateMinute(s, nowMs, halves.get(s.key) ?? null) };
  });
}

// The published block for one live row, or null to carry none.
//   { minute, at, events }   `at` is when `minute` was estimated (ISO), so
// the app can run it on between refreshes.
export function playFor(state, nowIso) {
  if (!PUBLISH_LIVE_EVENTS || !state?.live || !Array.isArray(state.events)) return null;
  return { minute: state.minute ?? null, at: nowIso, events: state.events };
}

// Has the block changed enough to publish? Events always count; a minute
// that has only ticked on does not, until it is five or more ahead, so a
// quiet stretch costs one publish in six minutes and not one in three.
export const MINUTE_STEP = 5;
export function playMoved(prev, next) {
  if (!prev || !next) return !!prev !== !!next;
  if (JSON.stringify(prev.events) !== JSON.stringify(next.events)) return true;
  if ((prev.minute == null) !== (next.minute == null)) return true;
  return next.minute != null && Math.abs(next.minute - prev.minute) >= MINUTE_STEP;
}
