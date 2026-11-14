import { test } from "node:test";
import assert from "node:assert/strict";
import { liveEventsFrom, liveMinute, playFor, playMoved, PUBLISH_LIVE_EVENTS, MINUTE_STEP } from "./live-events.mjs";
import { applyEspnOverlay, fetchEspnNationsStates, makeOverlayPass } from "./espn-live-overlay.mjs";

// ESPN summary rows as fetch-stats.test.mjs records them. France (9) v Fiji (14).
const TEXT = { try: "Try", conversion: "Conversion", penalty: "Penalty Goal", penaltyTry: "Penalty Try", yellow: "Yellow Card", red: "Red Card", sub: "Substitution" };
const detail = ([min, side, type, name]) => ({
  type: { text: TEXT[type] }, clock: { value: min * 60, displayValue: `${min}'` },
  team: { id: side === "home" ? "9" : "14" }, athletesInvolved: name ? [{ displayName: name }] : [],
});
const summary = (rows) => ({ header: { competitions: [{
  competitors: [{ id: "9", homeAway: "home", team: { id: "9" } }, { id: "14", homeAway: "away", team: { id: "14" } }],
  details: rows.map(detail),
}] } });
const GAME = [
  [13, "away", "yellow", "Lood de Jager"],
  [15, "home", "try", "Louis Bielle-Biarrey"],
  [16, "home", "conversion", "Maxime Lucu"],
  [22, "home", "sub", "Someone"],
  [30, "away", "try", "Cobus Reinach"],
  [44, "away", "red", "A. Lock"],
  [51, "home", "penalty", "Maxime Lucu"],
];

test("liveEventsFrom: team, type and minute, oldest first, and never a name", () => {
  const events = liveEventsFrom(summary(GAME));
  assert.deepEqual(events, [
    { min: 13, team: "away", type: "yellow" },
    { min: 15, team: "home", type: "try" },
    { min: 16, team: "home", type: "conversion" },
    { min: 30, team: "away", type: "try" },
    { min: 44, team: "away", type: "red" },
    { min: 51, team: "home", type: "penalty" },
  ]);
  assert.ok(events.every((e) => Object.keys(e).join() === "min,team,type"), "exactly three fields");
  assert.doesNotMatch(JSON.stringify(events), /Lucu|Reinach|Jager|Bielle/);
});

test("liveEventsFrom: a body with no rows, a row for neither side and an unknown row give nothing invented", () => {
  assert.deepEqual(liveEventsFrom({}), []);
  assert.deepEqual(liveEventsFrom(null), []);
  const odd = summary([[10, "home", "try"]]);
  odd.header.competitions[0].details.push({ type: { text: "Try" }, clock: { value: 600 }, team: { id: "777" } });
  odd.header.competitions[0].details.push({ type: { text: "TMO review" }, clock: { value: 700 }, team: { id: "9" } });
  assert.deepEqual(liveEventsFrom(odd), [{ min: 10, team: "home", type: "try" }]);
});

test("liveMinute: believed only inside its half, and never behind the game's last event", () => {
  const st = (shortDetail, clock, extra = {}) => ({ type: { shortDetail }, clock, ...extra });
  assert.equal(liveMinute(st("2nd Half", 54 * 60)), 54);
  assert.equal(liveMinute(st("1st Half", 23 * 60 + 1)), 24, "the 1381st second is in the 24th minute");
  assert.equal(liveMinute(st("2nd Half", 60)), null, "the Ellis Park clock: 1' in the second half");
  assert.equal(liveMinute(st("2nd Half", 60), [{ min: 63 }]), 63, "the last event is a floor");
  assert.equal(liveMinute(st("1st Half", 70 * 60)), null);
  assert.equal(liveMinute(st("Halftime", 40 * 60)), null, "no minute at half time");
  assert.equal(liveMinute(st(undefined, undefined, { displayClock: "62'", period: 2 })), 62);
  assert.equal(liveMinute(undefined), null);
});

test("playFor and playMoved: published while live, republished on an event or a five-minute step", () => {
  assert.equal(PUBLISH_LIVE_EVENTS, true, "the fire escape is a one-word edit; this test fails when it is used, on purpose");
  const state = { live: true, minute: 54, events: [{ min: 15, team: "home", type: "try" }] };
  const play = playFor(state, "2026-11-21T15:30:00.000Z");
  assert.deepEqual(play, { minute: 54, at: "2026-11-21T15:30:00.000Z", events: state.events });
  assert.equal(playFor({ ...state, live: false }, "x"), null);
  assert.equal(playFor({ live: true, minute: 54 }, "x"), null, "no events answer, nothing to publish");
  assert.equal(playMoved(null, play), true);
  assert.equal(playMoved(play, null), true);
  assert.equal(playMoved(null, null), false);
  assert.equal(playMoved(play, { ...play, at: "later", minute: 54 + MINUTE_STEP - 1 }), false, "a clock that only ticked on");
  assert.equal(playMoved(play, { ...play, minute: 54 + MINUTE_STEP }), true);
  assert.equal(playMoved(play, { ...play, events: [...play.events, { min: 56, team: "away", type: "yellow" }] }), true);
  assert.equal(playMoved(play, { ...play, minute: null }), true);
});

// ---- on the row --------------------------------------------------------------

const row = (short, hs, as, extra = {}) => ({
  id: 53235, date: "2026-11-07T20:10:00+00:00", week: "4",
  status: { short, long: "x", live: ["1H", "HT", "2H"].includes(short) },
  home: { id: 387, name: "France", score: hs }, away: { id: 28, name: "Fiji", score: as }, ...extra,
});
const doc = (results, fixtures = []) => ({ updatedAt: "old", fixtures, results, log: [] });
const EVENTS = [{ min: 15, team: "home", type: "try" }, { min: 30, team: "away", type: "yellow" }];
const state = (over = {}) => ({ key: "FRA-FIJ", date: "2026-11-07T20:10Z", home: 26, away: 3, live: true, short: "2nd Half", minute: 52, events: EVENTS, ...over });
const NOW = "2026-11-07T21:13:00.000Z";

test("a live row carries the notes even when ESPN has nothing new on the score", () => {
  const before = doc([row("2H", 26, 3)]);
  const { doc: after, changes, notes } = applyEspnOverlay(before, [state()], { nowIso: NOW });
  assert.deepEqual(changes, [], "the score did not move");
  assert.equal(notes, 1);
  assert.deepEqual(after.results[0].play, { minute: 52, at: NOW, events: EVENTS });
  assert.equal(after.results[0].status.via, undefined, "api-sports still owns the score");
  // The same answer three minutes on: nothing to write.
  const again = applyEspnOverlay(after, [state({ minute: 55 })], { nowIso: "later" });
  assert.equal(again.doc, after);
  // A new event, or the api-sports pass having rewritten the row without them.
  assert.equal(applyEspnOverlay(after, [state({ events: [...EVENTS, { min: 56, team: "home", type: "penalty" }] })]).notes, 1);
  assert.equal(applyEspnOverlay(before, [state()]).notes, 1);
});

test("the notes leave with the whistle, and a neutral-venue game has its sides turned", () => {
  const live = doc([row("2H", 26, 3, { play: { minute: 78, at: NOW, events: EVENTS } })]);
  const ft = applyEspnOverlay(live, [state({ live: false, short: "FT", events: undefined, minute: undefined })]);
  assert.equal(ft.doc.results[0].status.short, "FT");
  assert.equal("play" in ft.doc.results[0], false);
  const flipped = applyEspnOverlay(doc([row("2H", 26, 3)]), [state({ key: "FIJ-FRA", home: 3, away: 26 })], { nowIso: NOW });
  assert.deepEqual(flipped.doc.results[0].play.events.map((e) => e.team), ["away", "home"]);
});

test("a summary that could not be read keeps the notes the row has; kickoff brings them with the first live score", () => {
  const live = doc([row("2H", 26, 3, { play: { minute: 52, at: NOW, events: EVENTS } })]);
  assert.equal(applyEspnOverlay(live, [state({ events: undefined, minute: undefined })]).doc, live);
  const upcoming = doc([], [row("NS", null, null)]);
  const { doc: after } = applyEspnOverlay(upcoming, [state({ home: 0, away: 0, short: "1st Half", minute: 2, events: [] })], { nowIso: NOW });
  assert.equal(after.fixtures.length, 0);
  assert.deepEqual(after.results[0].play, { minute: 2, at: NOW, events: [] });
});

test("the read and the pass: one summary per live game, a failed one costs nothing, and the pass reports a notes-only write", async () => {
  const board = { events: [{ id: 1, date: "2026-11-07T20:10Z", competitions: [{
    status: { type: { state: "in", shortDetail: "2nd Half" }, clock: 52 * 60 },
    competitors: [{ homeAway: "home", team: { id: "9" }, score: "26" }, { homeAway: "away", team: { id: "14" }, score: "3" }],
  }] }] };
  const nowMs = Date.parse("2026-11-07T21:13:00Z");
  const ok = await fetchEspnNationsStates({ nowMs, fetchJson: async (url) => (url.includes("summary") ? summary(GAME) : board) });
  assert.equal(ok[0].minute, 52);
  assert.equal(ok[0].events.length, 6);
  const failed = await fetchEspnNationsStates({ nowMs, fetchJson: async (url) => { if (url.includes("summary")) throw new Error("HTTP 500"); return board; } });
  assert.deepEqual(failed, [{ key: "FRA-FIJ", date: "2026-11-07T20:10Z", home: 26, away: 3, live: true, short: "2nd Half" }]);

  let text = JSON.stringify(doc([row("2H", 26, 3)]));
  const lines = [];
  const pass = makeOverlayPass({ fetchStates: async () => ok, read: async () => text, write: async (_p, t) => { text = t; }, log: (l) => lines.push(l), warn: () => {} });
  assert.equal(await pass(), 1, "a notes-only pass is still something to publish");
  assert.equal(JSON.parse(text).results[0].play.events.length, 6);
  assert.match(lines.join("\n"), /live notes updated on 1 game\(s\): FRA-FIJ 52' 6 event\(s\)/);
  assert.equal(await pass(), 0);
});
