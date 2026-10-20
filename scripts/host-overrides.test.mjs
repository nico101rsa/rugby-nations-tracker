import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HOST_OVERRIDES, overrideHost, applyHostOverrides } from "./host-overrides.mjs";
import { buildTeamEvents, mirrorMissingResults } from "./fetch-team-events.mjs";

const quiet = () => {};

// The 2026 PNC final exactly as SportsAPI Pro served it: Fiji as homeTeam,
// though Japan hosted in Tokyo.
const PNC_FINAL = {
  id: 17085293,
  startTimestamp: Date.parse("2026-09-19T10:05:00Z") / 1000,
  tournament: { name: "Pacific Nations Cup, Knockout Stage" },
  homeTeam: { id: 1, name: "Fiji" },
  awayTeam: { id: 2, name: "Japan" },
  homeScore: { current: 15 },
  awayScore: { current: 20 },
  status: { type: "finished" },
};

test("cause: normalizeEvent takes the vendor's homeTeam as the host — Japan reads A", () => {
  const teams = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] }, FIJ: { lastEvents: [PNC_FINAL], nextEvents: [] } });
  assert.equal(teams.JPN.last[0].homeAway, "A");
  assert.equal(teams.FIJ.last[0].homeAway, "H");
});

test("fix: the override puts Japan at home on both sides with the venue and stage, scores untouched", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] }, FIJ: { lastEvents: [PNC_FINAL], nextEvents: [] } });
  const lines = [];
  const out = applyHostOverrides(vendor, { log: (l) => lines.push(l) });
  assert.equal(out.JPN.last[0].homeAway, "H");
  assert.equal(out.FIJ.last[0].homeAway, "A");
  assert.deepEqual([out.JPN.last[0].us, out.JPN.last[0].them, out.JPN.last[0].result], [20, 15, "W"]);
  assert.deepEqual([out.FIJ.last[0].us, out.FIJ.last[0].them, out.FIJ.last[0].result], [15, 20, "L"]);
  assert.deepEqual([out.JPN.last[0].venue, out.JPN.last[0].stage], ["Prince Chichibu Memorial Stadium, Tokyo", "final"]);
  assert.equal(out.FIJ.last[0].stage, "final");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /host override applied: JPN 2026-09-19 FIJ-JPN → H, venue, final/);
});

test("fix: idempotent — a corrected row is matched the other way round and left alone", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] } });
  const once = applyHostOverrides(vendor, { log: quiet });
  const twice = applyHostOverrides(once, { log: quiet });
  assert.equal(twice.JPN, once.JPN, "no change → same object");
});

test("fix: a row already corrected by an earlier pass (the committed file) still gains the venue and stage", () => {
  const corrected = { id: 17085293, date: "2026-09-19T10:05:00.000Z", opponent: "Fiji", opponentCode: "FIJ", homeAway: "H", us: 20, them: 15, result: "W" };
  const lines = [];
  const out = applyHostOverrides({ JPN: { last: [corrected], next: [] } }, { log: (l) => lines.push(l) });
  assert.deepEqual(out.JPN.last[0], { ...corrected, venue: "Prince Chichibu Memorial Stadium, Tokyo", stage: "final" });
  assert.match(lines[0], /host override applied: JPN 2026-09-19 JPN-FIJ → venue, final/);
});

test("fix: a mirrored side follows the corrected source", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] }, FIJ: { lastEvents: [], nextEvents: [] } });
  const out = applyHostOverrides(mirrorMissingResults(vendor), { log: quiet });
  assert.equal(out.JPN.last[0].homeAway, "H");
  assert.equal(out.FIJ.last[0].homeAway, "A");
  assert.equal(out.FIJ.last[0].mirroredFrom, "JPN");
});

test("vendor guard: once the vendor lists the host itself, the side is left as it is (the venue and stage still land)", () => {
  const fixed = { ...PNC_FINAL, homeTeam: PNC_FINAL.awayTeam, awayTeam: PNC_FINAL.homeTeam, homeScore: PNC_FINAL.awayScore, awayScore: PNC_FINAL.homeScore };
  const vendor = buildTeamEvents({ JPN: { lastEvents: [fixed], nextEvents: [] } });
  const out = applyHostOverrides(vendor, { log: quiet });
  assert.equal(out.JPN.last[0].homeAway, "H", "never flipped back");
  assert.deepEqual([out.JPN.last[0].us, out.JPN.last[0].them], [20, 15]);
  assert.deepEqual([out.JPN.last[0].venue, out.JPN.last[0].stage], ["Prince Chichibu Memorial Stadium, Tokyo", "final"]);
  const bare = { ...vendor.JPN.last[0], venue: "Prince Chichibu Memorial Stadium, Tokyo", stage: "final" };
  assert.equal(overrideHost(bare, "JPN"), bare, "with the venue and stage already on it, nothing applies");
});

test("other games and other days are untouched", () => {
  const row = { id: 1, date: "2025-09-14T01:35:00.000Z", opponent: "Japan", opponentCode: "JPN", homeAway: "A", us: 33, them: 27 };
  assert.equal(overrideHost(row, "FIJ"), row);
});

// The 2025 PNC final in Salt Lake City, as the vendor serves it: Japan home.
test("neutral: the row marks both sides' copies neutral with the venue, homeAway untouched, idempotent", () => {
  const jpn = { id: 2, date: "2025-09-21T01:35:00.000Z", opponent: "Fiji", opponentCode: "FIJ", homeAway: "H", us: 27, them: 33 };
  const fij = { id: 2, date: "2025-09-21T01:35:00.000Z", opponent: "Japan", opponentCode: "JPN", homeAway: "A", us: 33, them: 27 };
  const lines = [];
  const out = applyHostOverrides({ JPN: { last: [jpn], next: [] }, FIJ: { last: [fij], next: [] } }, { log: (l) => lines.push(l) });
  assert.deepEqual(out.JPN.last[0], { ...jpn, neutral: true, venue: "America First Field, Salt Lake City", stage: "final" });
  assert.deepEqual(out.FIJ.last[0], { ...fij, neutral: true, venue: "America First Field, Salt Lake City", stage: "final" });
  assert.equal(out.JPN.last[0].homeAway, "H", "the vendor's side stays; the app's badge has no neutral state");
  assert.match(lines[0], /host override applied: JPN 2025-09-21 JPN-FIJ → neutral, venue, final/);
  const twice = applyHostOverrides(out, { log: quiet });
  assert.equal(twice.JPN, out.JPN, "already marked → same object");
});

test("table rules: every key is '<UTC day> HOME-AWAY'; a row names a host from the two sides, or is neutral", () => {
  for (const [key, o] of Object.entries(HOST_OVERRIDES)) {
    const m = key.match(/^(\d{4}-\d{2}-\d{2}) ([A-Z]{3})-([A-Z]{3})$/);
    assert.ok(m, `bad key ${key}`);
    for (const k of Object.keys(o)) assert.ok(["host", "neutral", "venue", "stage"].includes(k), `${key}: unknown field ${k}`);
    if (o.neutral) {
      assert.equal(o.host, undefined, `${key}: a neutral row names no host`);
      continue;
    }
    assert.ok([m[2], m[3]].includes(o.host), `${key}: host ${o.host} plays in neither side`);
    assert.notEqual(o.host, m[2], `${key}: host already the vendor's home side — a no-op row`);
  }
});

test("the committed team-events.json gains the 2026 final's venue and stage even though its rows are already corrected", () => {
  const te = JSON.parse(readFileSync(new URL("../team-events.json", import.meta.url), "utf8"));
  const out = applyHostOverrides(te.teams, { log: quiet });
  const jpn = out.JPN.last.find((g) => g.id === 17085293);
  if (jpn) assert.deepEqual([jpn.homeAway, jpn.venue, jpn.stage], ["H", "Prince Chichibu Memorial Stadium, Tokyo", "final"]);
});

test("the committed team-events.json comes out with Japan at home for the PNC final", () => {
  const te = JSON.parse(readFileSync(new URL("../team-events.json", import.meta.url), "utf8"));
  const out = applyHostOverrides(te.teams, { log: quiet });
  const jpn = out.JPN.last.find((g) => g.id === 17085293);
  const fij = out.FIJ.last.find((g) => g.id === 17085293);
  if (jpn) assert.equal(jpn.homeAway, "H");
  if (fij) assert.equal(fij.homeAway, "A");
});
