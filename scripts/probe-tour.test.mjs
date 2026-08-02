import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeDue, matchTourGame, runTourProbe, loadStore } from "./probe-tour.mjs";
import { tourFixtures } from "./seed-tour.mjs";

const EMPTY = { probed: {}, results: {} };
const STORMERS = tourFixtures()[0]; // 2026-08-07T17:10:00Z

// api-sports game shape (same fields fetch-nations.mjs reads).
const game = (home, away, hs, as, short = "FT") => ({
  id: 9001,
  status: { short, long: short === "FT" ? "Finished" : "Not Started" },
  league: { id: 999, name: "Tour Match" },
  teams: { home: { name: home }, away: { name: away } },
  scores: { home: hs, away: as },
});

const tmpStore = async () => join(await mkdtemp(join(tmpdir(), "tour-probe-")), "tour-results.json");

test("probeDue: only on a tour match day, after the settle window, once", () => {
  assert.equal(probeDue("2026-08-06T20:00:00Z", EMPTY), null); // not a match day
  assert.equal(probeDue("2026-08-07T18:00:00Z", EMPTY), null); // in play — too early
  assert.equal(probeDue("2026-08-07T19:40:00Z", EMPTY)?.id, "seed-tour-nzl2026-sto"); // ko+150min
  assert.equal(probeDue("2026-08-07T23:00:00Z", { probed: { "2026-08-07": {} }, results: {} }), null); // spent
  assert.equal(probeDue("2026-08-25T21:00:00Z", EMPTY)?.id, "seed-tour-nzl2026-lio");
});

test("matchTourGame: finds the game whichever way round, franchise by substring", () => {
  const g = game("DHL Stormers", "New Zealand", 19, 31);
  assert.equal(matchTourGame([g], STORMERS), g);
  const flipped = game("All Blacks", "Stormers", 31, 19);
  assert.equal(matchTourGame([flipped], STORMERS), flipped);
  // NZ must match EXACTLY — a lookalike side is not the All Blacks.
  assert.equal(matchTourGame([game("Stormers", "New Zealand XV", 1, 2)], STORMERS), null);
  assert.equal(matchTourGame([game("Bulls", "New Zealand", 1, 2)], STORMERS), null); // wrong opponent
});

test("runTourProbe: finished game auto-fills the result, franchise-home orientation", async () => {
  const file = await tmpStore();
  const r = await runTourProbe({
    now: new Date("2026-08-07T20:00:00Z"),
    key: "k",
    fetchGames: async () => [game("New Zealand", "DHL Stormers", 31, 19)], // NZ listed home by vendor
    file,
  });
  assert.deepEqual(r, { probed: true, found: true, result: { home: 19, away: 31 } });
  const store = await loadStore(file);
  assert.deepEqual(store.results["seed-tour-nzl2026-sto"], { home: 19, away: 31 });
  assert.equal(store.probed["2026-08-07"].found, true);
});

test("runTourProbe: absent game marks the day probed (1-request cap) with found:false", async () => {
  const file = await tmpStore();
  const calls = [];
  const fetchGames = async (d) => (calls.push(d), []);
  const r1 = await runTourProbe({ now: new Date("2026-08-07T20:00:00Z"), key: "k", fetchGames, file });
  assert.deepEqual(r1, { probed: true, found: false, result: null });
  // Second tick the same evening: the ledger blocks a second spend.
  const r2 = await runTourProbe({ now: new Date("2026-08-07T21:00:00Z"), key: "k", fetchGames, file });
  assert.equal(r2.probed, false);
  assert.equal(calls.length, 1);
});

test("runTourProbe: no key degrades to a logged skip and does NOT burn the day", async () => {
  const file = await tmpStore();
  const r = await runTourProbe({ now: new Date("2026-08-07T20:00:00Z"), key: undefined, file });
  assert.deepEqual(r, { probed: false, reason: "no key" });
  assert.deepEqual(await loadStore(file), EMPTY);
});

test("runTourProbe: a failed request leaves the day unprobed for a retry", async () => {
  const file = await tmpStore();
  const r = await runTourProbe({
    now: new Date("2026-08-07T20:00:00Z"),
    key: "k",
    fetchGames: async () => { throw new Error("boom"); },
    file,
  });
  assert.equal(r.probed, false);
  assert.deepEqual(await loadStore(file), EMPTY);
});

test("loadStore: corrupt file falls back to the empty state", async () => {
  const file = await tmpStore();
  await writeFile(file, "not json");
  assert.deepEqual(await loadStore(file), EMPTY);
  assert.equal(typeof (await readFile(file, "utf8")), "string"); // untouched
});
