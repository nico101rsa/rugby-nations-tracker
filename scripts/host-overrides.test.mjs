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

test("fix: the override puts Japan at home on both sides, scores untouched", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] }, FIJ: { lastEvents: [PNC_FINAL], nextEvents: [] } });
  const lines = [];
  const out = applyHostOverrides(vendor, { log: (l) => lines.push(l) });
  assert.equal(out.JPN.last[0].homeAway, "H");
  assert.equal(out.FIJ.last[0].homeAway, "A");
  assert.deepEqual([out.JPN.last[0].us, out.JPN.last[0].them, out.JPN.last[0].result], [20, 15, "W"]);
  assert.deepEqual([out.FIJ.last[0].us, out.FIJ.last[0].them, out.FIJ.last[0].result], [15, 20, "L"]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /host override applied: JPN 2026-09-19 FIJ-JPN → H/);
});

test("fix: idempotent — a corrected row keys the other way and is left alone", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] } });
  const once = applyHostOverrides(vendor, { log: quiet });
  const twice = applyHostOverrides(once, { log: quiet });
  assert.equal(twice.JPN, once.JPN, "no change → same object");
});

test("fix: a mirrored side follows the corrected source", () => {
  const vendor = buildTeamEvents({ JPN: { lastEvents: [PNC_FINAL], nextEvents: [] }, FIJ: { lastEvents: [], nextEvents: [] } });
  const out = applyHostOverrides(mirrorMissingResults(vendor), { log: quiet });
  assert.equal(out.JPN.last[0].homeAway, "H");
  assert.equal(out.FIJ.last[0].homeAway, "A");
  assert.equal(out.FIJ.last[0].mirroredFrom, "JPN");
});

test("vendor guard: once the vendor lists the host itself, the row does nothing", () => {
  const fixed = { ...PNC_FINAL, homeTeam: PNC_FINAL.awayTeam, awayTeam: PNC_FINAL.homeTeam, homeScore: PNC_FINAL.awayScore, awayScore: PNC_FINAL.homeScore };
  const vendor = buildTeamEvents({ JPN: { lastEvents: [fixed], nextEvents: [] } });
  assert.equal(applyHostOverrides(vendor, { log: quiet }).JPN, vendor.JPN);
});

test("other games and other days are untouched", () => {
  const row = { id: 1, date: "2025-09-21T01:35:00.000Z", opponent: "Japan", opponentCode: "JPN", homeAway: "A", us: 33, them: 27 };
  assert.equal(overrideHost(row, "FIJ"), row);
});

test("table rules: every key is '<UTC day> HOME-AWAY' and its host is one of the two sides", () => {
  for (const [key, o] of Object.entries(HOST_OVERRIDES)) {
    const m = key.match(/^(\d{4}-\d{2}-\d{2}) ([A-Z]{3})-([A-Z]{3})$/);
    assert.ok(m, `bad key ${key}`);
    assert.ok([m[2], m[3]].includes(o.host), `${key}: host ${o.host} plays in neither side`);
    assert.notEqual(o.host, m[2], `${key}: host already the vendor's home side — a no-op row`);
  }
});

test("the committed team-events.json comes out with Japan at home for the PNC final", () => {
  const te = JSON.parse(readFileSync(new URL("../team-events.json", import.meta.url), "utf8"));
  const out = applyHostOverrides(te.teams, { log: quiet });
  const jpn = out.JPN.last.find((g) => g.id === 17085293);
  const fij = out.FIJ.last.find((g) => g.id === 17085293);
  if (jpn) assert.equal(jpn.homeAway, "H");
  if (fij) assert.equal(fij.homeAway, "A");
});
