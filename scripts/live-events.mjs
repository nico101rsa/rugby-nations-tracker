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
import { parseEspnDetails, espnMinute } from "./fetch-stats.mjs";
import { phaseOf } from "./espn-live-overlay.mjs";

export const PUBLISH_LIVE_EVENTS = true;

// A clock is believed only inside its half: ESPN's has sat at 1' twenty
// minutes into a game (Ellis Park, 22 Aug 2026), and a wrong minute on a live
// card reads as a broken app. Stoppage time runs past 40 and 80.
const HALF = { "1H": [1, 55], "2H": [41, 100] };

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

// The minute now, or null when the clock can't be trusted. `status` is the
// scoreboard's competitions[0].status; `events` raise a clock that is behind
// the game's own last event.
export function liveMinute(status, events = []) {
  const phase = phaseOf(status?.type?.shortDetail) ?? phaseOf(status?.type?.description) ?? (status?.period === 1 ? "1H" : status?.period === 2 ? "2H" : null);
  const range = HALF[phase];
  if (!range) return null;
  const clock = espnMinute({ value: status?.clock, displayValue: status?.displayClock });
  const last = Math.max(0, ...events.map((e) => e.min ?? 0));
  const minute = Math.max(clock ?? 0, last);
  return minute >= range[0] && minute <= range[1] ? minute : null;
}

// The published block for one live row, or null to carry none.
//   { minute, at, events }   `at` is when `minute` was read (ISO), so the app
// can run the clock on between refreshes.
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
