import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEspnOverlay, fetchEspnNationsStates, makeOverlayPass, phaseOf, ESPN_NATIONS_LEAGUE } from "./espn-live-overlay.mjs";

// api-sports ids: France 387, Fiji 28, England 386, Australia 461.
const row = (id, home, away, date, short, hs, as, live = ["1H", "HT", "2H"].includes(short)) => ({
  id, date, week: "4",
  status: { short, long: short === "NS" ? "Not Started" : short === "FT" ? "Finished" : "x", live },
  home: { id: home, name: `team-${home}`, logo: "h.png", score: hs },
  away: { id: away, name: `team-${away}`, logo: "a.png", score: as },
});
const KO = "2026-11-07T20:10:00+00:00";
const doc = (results, fixtures = []) => ({
  updatedAt: "2026-11-07T21:13:25.992Z",
  counts: { fixtures: fixtures.length, results: results.length, teams: 12, news: 0 },
  fixtures, results, log: [{ team: "kept" }], digests: { kept: true },
});
const espn = (over = {}) => ({ key: "FRA-FIJ", date: "2026-11-07T20:10Z", home: 40, away: 10, live: true, short: "2nd Half", ...over });

test("phaseOf speaks api-sports' vocabulary for ESPN's words", () => {
  assert.equal(phaseOf("1st Half"), "1H");
  assert.equal(phaseOf("Halftime"), "HT");
  assert.equal(phaseOf("2nd Half"), "2H");
  assert.equal(phaseOf("FT"), "FT");
  assert.equal(phaseOf("2H"), "2H");
  assert.equal(phaseOf("52'"), null);
  assert.equal(phaseOf(undefined), null);
});

test("the Round 4 case: api-sports sits on 26-3 while ESPN has 40-10", () => {
  const before = doc([row(53235, 387, 28, KO, "2H", 26, 3)]);
  const { doc: after, changes } = applyEspnOverlay(before, [espn()]);
  assert.deepEqual(changes, [{ key: "FRA-FIJ", from: "2H 26-3", to: "2H 40-10" }]);
  const r = after.results[0];
  assert.equal(r.home.score, 40);
  assert.equal(r.away.score, 10);
  assert.deepEqual(r.status, { short: "2H", long: "Second Half", live: true, via: "espn" });
  // Everything that isn't the row is carried through untouched.
  assert.equal(r.home.logo, "h.png");
  assert.deepEqual(after.log, before.log);
  assert.deepEqual(after.digests, before.digests);
  assert.notEqual(after.updatedAt, before.updatedAt);
  // And the input is not mutated.
  assert.equal(before.results[0].home.score, 26);
});

test("nothing ahead, nothing written: the same document comes back", () => {
  const before = doc([row(53235, 387, 28, KO, "2H", 40, 10)]);
  const out = applyEspnOverlay(before, [espn()]);
  assert.equal(out.doc, before);
  assert.deepEqual(out.changes, []);
});

test("a score never goes backwards on ESPN's word", () => {
  // api-sports already has the later try; ESPN is the slow one this time.
  const before = doc([row(53235, 387, 28, KO, "2H", 47, 10)]);
  assert.equal(applyEspnOverlay(before, [espn()]).doc, before);
  // Ahead on one side but behind on the other is not "ahead".
  const mixed = doc([row(53235, 387, 28, KO, "2H", 33, 17)]);
  assert.equal(applyEspnOverlay(mixed, [espn()]).doc, mixed);
});

test("ESPN may correct a score ESPN itself wrote (a try chalked off)", () => {
  const owned = new Map();
  const first = applyEspnOverlay(doc([row(53235, 387, 28, KO, "2H", 26, 3)]), [espn({ home: 33 })], { owned }).doc;
  assert.equal(first.results[0].home.score, 33);
  const second = applyEspnOverlay(first, [espn({ home: 26, away: 3 })], { owned });
  assert.equal(second.doc.results[0].home.score, 26, "ESPN's newer number replaces its older one");
  // But once api-sports has rewritten the row, ESPN is back to "ahead only".
  const vendor = doc([row(53235, 387, 28, KO, "2H", 33, 3)]);
  assert.equal(applyEspnOverlay(vendor, [espn({ home: 26, away: 3 })], { owned }).doc, vendor);
});

test("api-sports' full time is the record: ESPN never touches it", () => {
  const before = doc([row(53235, 387, 28, KO, "FT", 54, 17)]);
  assert.equal(applyEspnOverlay(before, [espn({ home: 61, away: 17 })]).doc, before);
});

test("ESPN's final whistle lands without waiting for the next api-sports poll", () => {
  // Ireland v Argentina, 7 Nov: FT reached the feed 36 minutes after the
  // previous change.
  const before = doc([row(53235, 387, 28, KO, "2H", 40, 10)]);
  const { doc: after } = applyEspnOverlay(before, [espn({ home: 54, away: 17, live: false, short: "FT" })]);
  assert.deepEqual(after.results[0].status, { short: "FT", long: "Finished", live: false, via: "espn" });
  assert.equal(after.results[0].home.score, 54);
  assert.deepEqual(after.log, before.log, "the table stays api-sports' own");
  // Laid again after a slower api-sports pass put the row back to 2H.
  const { doc: again } = applyEspnOverlay(before, [espn({ home: 54, away: 17, live: false, short: "FT" })]);
  assert.equal(again.results[0].status.short, "FT");
});

test("kickoff: a row api-sports still calls upcoming moves to results, live", () => {
  // First live score reached phones 27 minutes after kickoff on 7 Nov.
  const before = doc([], [row("static-r4-387", 387, 28, KO, "NS", null, null)]);
  const { doc: after, changes } = applyEspnOverlay(before, [espn({ home: 0, away: 0, short: "1st Half" })]);
  assert.equal(changes.length, 1);
  assert.equal(after.fixtures.length, 0);
  assert.equal(after.results.length, 1);
  assert.deepEqual(after.results[0].status, { short: "1H", long: "First Half", live: true, via: "espn" });
  assert.equal(after.results[0].home.score, 0);
  assert.deepEqual(after.counts, { fixtures: 0, results: 1, teams: 12, news: 0 });
});

test("a later phase at the same score is taken; an unknown ESPN label keeps the row's phase", () => {
  const ht = doc([row(53235, 387, 28, KO, "HT", 26, 3)]);
  const { doc: after } = applyEspnOverlay(ht, [espn({ home: 26, away: 3, short: "2nd Half" })]);
  assert.equal(after.results[0].status.short, "2H");
  // An earlier phase at the same score is ESPN lagging, not news.
  const twoH = doc([row(53235, 387, 28, KO, "2H", 26, 3)]);
  assert.equal(applyEspnOverlay(twoH, [espn({ home: 26, away: 3, short: "Halftime" })]).doc, twoH);
  // "52'" tells us nothing about the half: same score, same row.
  assert.equal(applyEspnOverlay(twoH, [espn({ home: 26, away: 3, short: "52'" })]).doc, twoH);
  // ...and with a new score it keeps the row's own label.
  assert.equal(applyEspnOverlay(twoH, [espn({ short: "52'" })]).doc.results[0].status.short, "2H");
});

test("only the same pairing on the same day is matched", () => {
  const july = doc([row(1, 387, 28, "2026-07-04T19:10:00+00:00", "2H", 0, 0)]);
  assert.equal(applyEspnOverlay(july, [espn()]).doc, july, "the July meeting of the same two is not this game");
  const other = doc([row(53236, 386, 461, KO, "2H", 5, 3)]);
  assert.equal(applyEspnOverlay(other, [espn()]).doc, other);
});

test("a neutral-venue game ESPN lists the other way round still matches, scores swapped", () => {
  const before = doc([row(53235, 387, 28, KO, "2H", 26, 3)]);
  const { doc: after } = applyEspnOverlay(before, [espn({ key: "FIJ-FRA", home: 10, away: 40 })]);
  assert.equal(after.results[0].home.score, 40);
  assert.equal(after.results[0].away.score, 10);
});

// ---- the ESPN read -----------------------------------------------------------

const event = (id, date, state, detail, home, away) => ({
  id, date,
  competitions: [{
    status: { type: { state, shortDetail: detail } },
    competitors: [
      { homeAway: "home", team: { id: String(home[0]) }, score: String(home[1]) },
      { homeAway: "away", team: { id: String(away[0]) }, score: String(away[1]) },
    ],
  }],
});

test("fetchEspnNationsStates: one keyless request, in-play and finished games near now only", async () => {
  const urls = [];
  const nowMs = Date.parse("2026-11-07T21:30:00Z");
  const states = await fetchEspnNationsStates({
    nowMs,
    fetchJson: async (url) => {
      urls.push(url);
      return { events: [
        event(1, "2026-11-07T20:10Z", "in", "2nd Half", [9, 40], [14, 10]),   // FRA v FIJ, live
        event(2, "2026-11-07T16:40Z", "post", "FT", [4, 28], [23, 21]),       // WAL v JPN, final
        event(3, "2026-11-08T15:10Z", "pre", "Sun", [1, 0], [6, 0]),          // not started
        event(4, "2026-07-04T19:10Z", "post", "FT", [9, 30], [14, 3]),        // months ago
        event(5, "2026-11-07T14:10Z", "post", "FT", [2, 0], [8, 0]),          // ESPN's 0-0 placeholder
        event(6, "2026-11-07T20:10Z", "in", "1st Half", [999, 3], [9, 0]),    // a side we don't track
      ] };
    },
  });
  assert.deepEqual(urls, [`https://site.api.espn.com/apis/site/v2/sports/rugby/${ESPN_NATIONS_LEAGUE}/scoreboard?dates=2026`]);
  assert.deepEqual(states, [
    { key: "FRA-FIJ", date: "2026-11-07T20:10Z", home: 40, away: 10, live: true, short: "2nd Half" },
    { key: "WAL-JPN", date: "2026-11-07T16:40Z", home: 28, away: 21, live: false, short: "FT" },
  ]);
});

test("fetchEspnNationsStates: a stub body with no events array is an empty answer", async () => {
  assert.deepEqual(await fetchEspnNationsStates({ fetchJson: async () => ({}) }), []);
});

// ---- the pass the burst runs -------------------------------------------------

function memoryFile(initial) {
  let text = JSON.stringify(initial);
  const writes = [];
  return { read: async () => text, write: async (_p, t) => { text = t; writes.push(t); }, writes, get doc() { return JSON.parse(text); } };
}
const quiet = { log: () => {}, warn: () => {} };

test("overlay pass: writes only when a row moved", async () => {
  const f = memoryFile(doc([row(53235, 387, 28, KO, "2H", 26, 3)]));
  const pass = makeOverlayPass({ fetchStates: async () => [espn()], read: f.read, write: f.write, ...quiet });
  assert.equal(await pass(), 1);
  assert.equal(await pass(), 0, "the second pass has nothing new");
  assert.equal(f.writes.length, 1);
  assert.equal(f.doc.results[0].home.score, 40);
});

test("overlay pass: ESPN down keeps the last states, so a slower api-sports pass can't pull the score back", async () => {
  const f = memoryFile(doc([row(53235, 387, 28, KO, "2H", 26, 3)]));
  let up = true;
  const pass = makeOverlayPass({
    fetchStates: async () => { if (!up) throw new Error("HTTP 503"); return [espn()]; },
    read: f.read, write: f.write, ...quiet,
  });
  await pass();
  // api-sports rewrites the file with its older answer; ESPN goes down.
  await f.write("", JSON.stringify(doc([row(53235, 387, 28, KO, "2H", 26, 3)])));
  up = false;
  assert.equal(await pass(), 1);
  assert.equal(f.doc.results[0].home.score, 40);
});

test("overlay pass: never throws, whatever breaks", async () => {
  const down = makeOverlayPass({ fetchStates: async () => { throw new Error("ENOTFOUND"); }, read: async () => "{}", write: async () => {}, ...quiet });
  assert.equal(await down(), 0);
  const badFile = makeOverlayPass({ fetchStates: async () => [espn()], read: async () => "not json", write: async () => {}, ...quiet });
  assert.equal(await badFile(), 0);
  const badWrite = makeOverlayPass({
    fetchStates: async () => [espn()],
    read: async () => JSON.stringify(doc([row(53235, 387, 28, KO, "2H", 26, 3)])),
    write: async () => { throw new Error("EROFS"); }, ...quiet,
  });
  assert.equal(await badWrite(), 0);
});
