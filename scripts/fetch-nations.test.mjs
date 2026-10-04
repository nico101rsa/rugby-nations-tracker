// nations.json `triesPending`: how many finished games the log counted
// without their try counts. The app's "what they need" line trusts the table
// to the point only when this is 0, so it must count exactly the games whose
// 4+ try bonus computeLog could not award, and survive every later writer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeLog, countTriesPending, applyNews, preserveDigests } from "./fetch-nations.mjs";

const team = (id, name) => ({ id, name, logo: "" });
const IRE = team(388, "Ireland"), ARG = team(460, "Argentina");
const FRA = team(387, "France"), FIJ = team(28, "Fiji");
const game = (id, home, away, hs, as) => ({
  id, date: "2026-11-07T12:00:00+00:00", week: "4",
  status: { short: "FT", long: "Finished" },
  teams: { home, away }, scores: { home: hs, away: as },
});

test("triesPending: a finished game with no scraped tries is pending", () => {
  const finished = [game(1, IRE, ARG, 38, 10), game(2, FRA, FIJ, 45, 12)];
  assert.equal(countTriesPending(finished, { 1: { home: 5, away: 1 } }), 1);
  assert.equal(countTriesPending(finished, {}), 2);
  assert.equal(countTriesPending(finished, { 1: { home: 5, away: 1 }, 2: { home: 6, away: 2 } }), 0);
});

test("triesPending: a scraped 0-0 try count is scraped, not pending", () => {
  // An all-penalties game: {home: 0, away: 0} is a real answer.
  assert.equal(countTriesPending([game(1, IRE, ARG, 9, 6)], { 1: { home: 0, away: 0 } }), 0);
});

test("triesPending: a game without both scores is not in the log, so not pending", () => {
  const finished = [{ ...game(1, IRE, ARG, null, null) }, { ...game(2, FRA, FIJ, 20, null) }];
  assert.equal(countTriesPending(finished, {}), 0);
  assert.equal(computeLog(finished, {}).length, 0);
});

test("triesPending: counts exactly the games whose try bonus the log is missing", () => {
  const finished = [game(1, IRE, ARG, 38, 10), game(2, FRA, FIJ, 45, 12)];
  const tries = { 1: { home: 5, away: 1 }, 2: { home: 6, away: 2 } };
  const full = computeLog(finished, tries);
  const partial = computeLog(finished, { 1: tries[1] });
  const pts = (log, id) => log.find((r) => r.id === id).Pts;
  // France's try bonus waits on game 2's scrape; everything else still adds up.
  assert.equal(pts(full, FRA.id), 5);
  assert.equal(pts(partial, FRA.id), 4);
  for (const r of partial) assert.equal(r.Pts, 4 * r.W + 2 * r.D + r.BP);
  assert.equal(countTriesPending(finished, { 1: tries[1] }), 1);
  assert.equal(countTriesPending(finished, tries), 0);
});

test("triesPending: survives the news-only refresh and the digest carry-forward", () => {
  const out = { log: [], triesPending: 2, counts: {} };
  const news = [{ title: "t", link: "l", source: "s", published: "p" }];
  assert.equal(applyNews(out, news, new Date("2026-11-07T00:00:00Z")).triesPending, 2);
  assert.equal(preserveDigests(out, { digests: { 388: {} } }).triesPending, 2);
  assert.equal(preserveDigests(out, null).triesPending, 2);
});
