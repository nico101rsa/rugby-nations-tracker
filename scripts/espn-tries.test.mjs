import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchEspnTries, tryCandidates, serialiseCache, RECENT_HOURS, FETCH_TIMEOUT_MS } from "./espn-tries.mjs";

const REGISTRY = {
  competitions: [
    { key: "6n-2027", espnLeagueId: 180659 },
    { key: "rwc-2027", espnLeagueId: 164205 },
    { key: "rnc-2026", espnLeagueId: 17567 },
    { key: "trc-2027" }, // no league id
  ],
};

// IRE (ESPN 3) v ENG (ESPN 1), a finished Six Nations game.
const row = (id, over = {}) => ({
  id, date: "2027-02-05T20:10:00.000Z",
  home: { code: "IRE" }, away: { code: "ENG" },
  comp: { key: "6n-2027", kind: "competition" },
  homeScore: 24, awayScore: 20,
  ...over,
});

const det = (type, team) => ({ type: { text: type }, team: { id: team } });
const summary = ({ completed = true, details, homeId = "3", awayId = "1" } = {}) => ({
  header: {
    competitions: [{
      status: { type: { completed } },
      competitors: [
        { id: homeId, homeAway: "home", team: { id: homeId } },
        { id: awayId, homeAway: "away", team: { id: awayId } },
      ],
      details: details ?? [
        det("Try", "3"), det("Try", "3"), det("Try", "3"), det("Penalty Try", "3"), det("Conversion", "3"),
        det("Try", "1"), det("Try", "1"), det("Penalty Goal", "1"),
      ],
    }],
  },
});

// Records every URL; answers from `routes` (a function of the URL).
function stub(routes) {
  const urls = [];
  const fetchJson = async (url) => {
    urls.push(url);
    const r = routes(url);
    if (r instanceof Error) throw r;
    return r;
  };
  return { urls, fetchJson };
}
const quiet = { log() {}, warn() {} };
const NOW = () => new Date("2027-02-06T00:00:00.000Z");
const run = (fixtures, fetchJson, over = {}) =>
  fetchEspnTries({ fixtures, registry: REGISTRY, cache: {}, fetchJson, log: quiet, now: NOW, ...over });

test("fully cached input makes zero requests", async () => {
  const { urls, fetchJson } = stub(() => { throw new Error("must not fetch"); });
  const cache = { "espn-1": { home: 1, away: 1, league: 180659, source: "summary", at: "x" } };
  const out = await run([row("espn-1")], fetchJson, { cache });
  assert.equal(urls.length, 0);
  assert.equal(out.fetched, 0);
  assert.equal(out.cached, 0);
  assert.deepEqual(out.cache, cache);
});

test("rnc, test, series, tour, seed-*, unscored and live rows are never candidates", () => {
  const rows = [
    row("espn-10", { comp: { key: "rnc-2026", kind: "competition" } }),
    row("espn-11", { comp: { key: "test", kind: "test" } }),
    row("espn-12", { comp: { key: "series-rsa-nzl-2026", kind: "series" } }),
    row("seed-tour-x", { comp: { key: "tour-nzl-2026", kind: "tour" } }),
    row("seed-6n2027-ire-eng"),
    row("espn-13", { homeScore: null, awayScore: null }),
    row("espn-14", { status: { short: "2H", live: true } }),
    row("espn-15", { comp: { key: "trc-2027", kind: "competition" } }), // no espnLeagueId
    row("espn-16"),
  ];
  assert.deepEqual(tryCandidates(rows, REGISTRY, {}).map((c) => c.row.id), ["espn-16"]);
  assert.deepEqual(tryCandidates({ fixtures: rows }, REGISTRY, {}).map((c) => c.league), [180659]);
});

test("a summary with 3 tries + a penalty try home and 2 tries away caches 4-2 from the summary", async () => {
  const { urls, fetchJson } = stub(() => summary());
  const out = await run([row("espn-603600")], fetchJson);
  assert.deepEqual(urls, ["https://site.api.espn.com/apis/site/v2/sports/rugby/180659/summary?event=603600"]);
  assert.deepEqual(out.cache["espn-603600"], { home: 4, away: 2, league: 180659, source: "summary", at: "2027-02-06T00:00:00.000Z" });
  assert.equal(out.cached, 1);
  assert.equal(out.fetched, 1);
});

test("an incomplete summary is not cached", async () => {
  const { fetchJson } = stub(() => summary({ completed: false }));
  const out = await run([row("espn-1")], fetchJson);
  assert.equal(out.cached, 0);
  assert.deepEqual(out.cache, {});
});

const statsJson = (tries, penaltyTries) => ({
  splits: { categories: [{ stats: [
    ...(tries == null ? [] : [{ name: "tries", value: tries }]),
    ...(penaltyTries == null ? [] : [{ name: "penaltyTries", value: penaltyTries }]),
    { name: "yellowCards", value: 1 },
  ] }] },
});
const coreEvent = {
  competitions: [{ competitors: [
    { homeAway: "home", statistics: { $ref: "https://core/stats/home" } },
    { homeAway: "away", statistics: { $ref: "https://core/stats/away" } },
  ] }],
};

test("empty details fall back to the competitors' statistics", async () => {
  const { urls, fetchJson } = stub((url) => {
    if (url.includes("/summary?")) return summary({ details: [] });
    if (url.endsWith("/events/603601")) return coreEvent;
    if (url.endsWith("/stats/home")) return statsJson(3, 1);
    if (url.endsWith("/stats/away")) return statsJson(1);
    throw new Error(`unexpected ${url}`);
  });
  const out = await run([row("espn-603601")], fetchJson);
  assert.equal(urls[1], "https://sports.core.api.espn.com/v2/sports/rugby/leagues/180659/events/603601");
  assert.deepEqual(out.cache["espn-603601"], { home: 4, away: 1, league: 180659, source: "statistics", at: "2027-02-06T00:00:00.000Z" });
  assert.equal(out.fetched, 4);
});

test("statistics without a 'tries' stat are not cached (never a fabricated zero)", async () => {
  const { fetchJson } = stub((url) => {
    if (url.includes("/summary?")) return summary({ details: [] });
    if (url.includes("/events/")) return coreEvent;
    return statsJson(null);
  });
  const out = await run([row("espn-2")], fetchJson);
  assert.equal(out.cached, 0);
  assert.ok(!("espn-2" in out.cache));
});

test("an HTTP error leaves the cache unchanged and does not throw", async () => {
  const { fetchJson } = stub(() => new Error("HTTP 503"));
  const cache = { "espn-9": { home: 2, away: 2, league: 180659, source: "summary", at: "x" } };
  const out = await run([row("espn-3"), row("espn-9")], fetchJson, { cache });
  assert.deepEqual(out.cache, cache);
  assert.equal(out.cached, 0);
  assert.equal(out.fetched, 1);
});

test("a statistics error after an empty summary is skipped, not thrown", async () => {
  const { fetchJson } = stub((url) => (url.includes("/summary?") ? summary({ details: [] }) : new Error("HTTP 404")));
  const out = await run([row("espn-4")], fetchJson);
  assert.equal(out.cached, 0);
});

test("the max cap holds: 21 candidates -> 20 summary fetches, oldest first", async () => {
  const rows = Array.from({ length: 21 }, (_, i) =>
    row(`espn-${700 + i}`, { date: `2027-10-${String(21 - i).padStart(2, "0")}T10:00:00.000Z`, comp: { key: "rwc-2027", kind: "competition" } }));
  const { urls, fetchJson } = stub(() => summary());
  const out = await run(rows, fetchJson);
  assert.equal(urls.length, 20);
  assert.equal(out.cached, 20);
  assert.ok(!("espn-700" in out.cache), "the newest game waits for the next run");
  assert.ok(urls.every((u) => u.includes("/164205/summary?")));
});

test("a registry entry without espnLeagueId is skipped", async () => {
  const { urls, fetchJson } = stub(() => summary());
  await run([row("espn-5", { comp: { key: "trc-2027", kind: "competition" } })], fetchJson);
  assert.equal(urls.length, 0);
});

test("ESPN listing our away side as home is swapped back to our orientation", async () => {
  // ESPN says ENG (1) home, IRE (3) away; our row is IRE v ENG.
  const { fetchJson } = stub(() => summary({ homeId: "1", awayId: "3", details: [det("Try", "1"), det("Try", "3"), det("Try", "3")] }));
  const out = await run([row("espn-6")], fetchJson);
  assert.equal(out.cache["espn-6"].home, 2, "IRE's two tries");
  assert.equal(out.cache["espn-6"].away, 1, "ENG's one try");
});

test("serialiseCache sorts keys so a new game is a one-entry diff", () => {
  const text = serialiseCache({ "espn-9": { home: 1, away: 0 }, "espn-10": { home: 2, away: 2 } });
  assert.ok(text.indexOf("espn-10") < text.indexOf("espn-9"));
  assert.ok(text.endsWith("}\n"));
  assert.equal(serialiseCache({}), "{}\n");
});

// ---- --recent: what the 15-minute and 3-minute callers pass ----------------

test("--recent asks only about games within RECENT_HOURS of kickoff; the daily run takes the backlog", async () => {
  assert.equal(RECENT_HOURS, 6);
  // NOW is 2027-02-06T00:00Z: espn-101 kicked off 3h50m before it, espn-102 26h before.
  const rows = [
    row("espn-101", { date: "2027-02-05T20:10:00.000Z" }),
    row("espn-102", { date: "2027-02-04T22:00:00.000Z" }),
  ];
  const { urls, fetchJson } = stub(() => summary({ details: [] , completed: false }));
  const recent = await run(rows, fetchJson, { recentHours: RECENT_HOURS });
  assert.equal(urls.length, 1, "only the game from the last six hours");
  assert.match(urls[0], /summary\?event=101$/);
  assert.equal(recent.cached, 0);
  urls.length = 0;
  await run(rows, fetchJson);
  assert.equal(urls.length, 2, "without --recent the backlog is retried too");
});

test("--recent with only old misses makes zero requests (the 15-minute no-op stays free)", async () => {
  const { urls, fetchJson } = stub(() => { throw new Error("must not fetch"); });
  const out = await run([row("espn-1", { date: "2027-02-01T20:10:00.000Z" })], fetchJson, { recentHours: RECENT_HOURS });
  assert.deepEqual([urls.length, out.fetched, out.cached], [0, 0, 0]);
  assert.deepEqual(tryCandidates([row("espn-1", { date: "not a date" })], REGISTRY, {}, { since: 0 }), [], "an unreadable date is never 'recent'");
});

test("the default fetch carries a timeout, so a hung ESPN request can't hold up a burst pass", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    seen.push(opts.signal);
    return { ok: true, json: async () => summary() };
  };
  try {
    const out = await fetchEspnTries({ fixtures: [row("espn-603602")], registry: REGISTRY, cache: {}, log: quiet, now: NOW });
    assert.equal(out.cached, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen.length >= 1);
  for (const s of seen) assert.ok(s instanceof AbortSignal, "every request is abortable");
  assert.ok(FETCH_TIMEOUT_MS > 0 && FETCH_TIMEOUT_MS <= 30_000, "well under one 3-minute burst pass");
});
