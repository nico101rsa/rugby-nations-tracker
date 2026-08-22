import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, buildTeamEvents, trackedCodeFor, fetchEventsByCode, mergeRefreshed } from "./fetch-team-events.mjs";

const NOW = new Date("2026-07-15T00:00:00Z").getTime();
const ts = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const ev = (id, iso, homeName, awayName, hs, as, tournament = "Test Match") => ({
  id,
  startTimestamp: ts(iso),
  tournament: { name: tournament },
  homeTeam: { id: id * 100, name: homeName },
  awayTeam: { id: id * 100 + 1, name: awayName },
  homeScore: hs == null ? {} : { current: hs },
  awayScore: as == null ? {} : { current: as },
  status: { type: hs == null ? "notstarted" : "finished" },
});

test("normalizeEvent: result from our side, tracked flag, untracked opponent kept by name", () => {
  const lost = normalizeEvent(ev(1, "2026-06-01T00:00:00Z", "South Africa", "New Zealand", 20, 27, "Rugby Championship"), "RSA");
  assert.deepEqual(lost, {
    id: 1, date: "2026-06-01T00:00:00.000Z", league: "Rugby Championship",
    opponent: "New Zealand", opponentCode: "NZL", tracked: true,
    homeAway: "H", us: 20, them: 27, result: "L", finished: true,
  });
  const away = normalizeEvent(ev(2, "2026-06-08T00:00:00Z", "Portugal", "South Africa", 10, 50), "RSA");
  assert.equal(away.opponent, "Portugal");
  assert.equal(away.tracked, false);
  assert.equal(away.opponentCode, null);
  assert.equal(away.homeAway, "A");
  assert.equal(away.result, "W");
});

test("buildTeamEvents: last capped at 10 finished (oldest dropped), next capped at 5 future", () => {
  const lastEvents = [];
  for (let i = 1; i <= 13; i++) {
    lastEvents.push(ev(i, `2026-01-${String(i).padStart(2, "0")}T00:00:00Z`, "England", "France", 20 + i, 10));
  }
  const nextEvents = [];
  for (let i = 1; i <= 7; i++) {
    nextEvents.push(ev(100 + i, `2026-08-${String(i).padStart(2, "0")}T00:00:00Z`, "England", "France", null, null));
  }
  const { ENG } = buildTeamEvents({ ENG: { lastEvents, nextEvents } }, NOW);
  assert.equal(ENG.last.length, 10);
  assert.equal(ENG.last[0].id, 4); // 1..3 dropped
  assert.equal(ENG.next.length, 5);
  assert.equal(ENG.next[0].result, null);
  assert.equal("finished" in ENG.last[0], false); // internal flag stripped
});

test("buildTeamEvents: unfinished entries never land in last; past-dated stale fixtures never in next", () => {
  const { IRE } = buildTeamEvents(
    { IRE: { lastEvents: [ev(1, "2026-05-01T00:00:00Z", "Ireland", "Portugal", null, null)],
             nextEvents: [ev(2, "2026-05-02T00:00:00Z", "Ireland", "Portugal", null, null)] } },
    NOW,
  );
  assert.deepEqual(IRE, { last: [], next: [] });
});

// --- exact-name guard (NZ tour spec, T2): lookalike sides must NEVER -------
// --- resolve to the real nation --------------------------------------------

test("trackedCodeFor: exact tracked names resolve; lookalike sides never do", () => {
  assert.equal(trackedCodeFor("South Africa"), "RSA");
  assert.equal(trackedCodeFor("New Zealand"), "NZL");
  // The negative cases are the point of the guard.
  for (const name of [
    "South Africa A",
    "South Africa XV",
    "New Zealand XV",
    "New Zealand A",
    "Emerging Ireland",
    "Junior Japan",
    "France U20",
    "Australia Under-20",
    "England Women",
    "Fiji Invitational",
    "South Africa Development",
    " South Africa", // whitespace is not the same name
    "south africa",  // nor is a case variant — vendor names are exact
  ]) {
    assert.equal(trackedCodeFor(name), null, `${JSON.stringify(name)} must not resolve`);
  }
  assert.equal(trackedCodeFor(null), null);
  assert.equal(trackedCodeFor("toString"), null); // prototype pollution guard
});

test("normalizeEvent: a lookalike opponent stays untracked with no code", () => {
  const n = normalizeEvent(ev(7, "2026-08-07T17:10:00Z", "South Africa A", "New Zealand", 19, 31), "NZL");
  assert.equal(n.opponent, "South Africa A");
  assert.equal(n.opponentCode, null);
  assert.equal(n.tracked, false);
  assert.equal(n.homeAway, "A");
  assert.equal(n.result, "W");
});

test("normalizeEvent: 'New Zealand XV' as the home side is not us — NZ's game reads as away", () => {
  // If the guard failed, homeCode would be NZL and the real NZ side would be
  // misread as home with the wrong score orientation.
  const n = normalizeEvent(ev(8, "2026-08-11T17:10:00Z", "New Zealand XV", "New Zealand", 10, 40), "NZL");
  assert.equal(n.homeAway, "A");
  assert.equal(n.us, 40);
  assert.equal(n.result, "W");
});

test("normalizeEvent: plain-number scores and ISO date fields also parse", () => {
  const e = {
    id: 9, date: "2026-06-01T00:00:00Z", tournament: { name: "Tour" },
    homeTeam: { name: "Wales" }, awayTeam: { name: "Fiji" },
    homeScore: 12, awayScore: 15, status: { type: "finished" },
  };
  const n = normalizeEvent(e, "WAL");
  assert.equal(n.us, 12);
  assert.equal(n.them, 15);
  assert.equal(n.result, "L");
  assert.equal(n.date, "2026-06-01T00:00:00Z");
});

// --- vendor 5xx tolerance ---
// 21-23 Aug 2026: SportsAPI Pro 503'd on the first team of the walk three runs
// running, each one aborting all twelve. The feed sat three days stale with the
// Springboks' Ellis Park result still filed as an upcoming fixture.
const FAST = { paceMs: 0, backoff: [0, 0, 0] };
const okBody = (name) => ({
  events: [{
    id: 1, startTimestamp: ts("2026-08-22T15:00:00Z"), tournament: { name: "Test Match" },
    homeTeam: { name }, awayTeam: { name: "New Zealand" },
    homeScore: { current: 16 }, awayScore: { current: 33 }, status: { type: "finished" },
  }],
});

// Serves a canned status/body per URL; records every call so retries are visible.
function stubFetch(plan) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const step = plan(url, calls.filter((u) => u === url).length);
    if (step.status && step.status >= 400) return { ok: false, status: step.status };
    return { ok: true, status: 200, json: async () => step.body };
  };
  return calls;
}

test("fetchEventsByCode: a 5xx that clears on retry does not lose the team", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch((url, nth) =>
    url.includes("/events/last/") && nth === 1 ? { status: 503 } : { body: okBody("South Africa") });

  const out = await fetchEventsByCode({ RSA: 4227 }, FAST);
  assert.deepEqual(Object.keys(out), ["RSA"]);
  assert.equal(out.RSA.lastEvents.length, 1);
  // 1 failed + 1 retried last call, plus the next call.
  assert.equal(calls.length, 3);
});

test("fetchEventsByCode: a team that never recovers is skipped, the rest still land", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch((url) => (url.includes("/teams/4227/") ? { status: 503 } : { body: okBody("Wales") }));

  const out = await fetchEventsByCode({ RSA: 4227, WAL: 900 }, FAST);
  assert.deepEqual(Object.keys(out), ["WAL"]);
});

// The 23 Aug 2026 catch-up got 30 good events back for South Africa and then
// lost the whole team because the separate `next` call 503'd — so the Ellis
// Park result it had in hand went unpublished.
test("fetchEventsByCode: a good `last` survives a failing `next`", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch((url) => (url.includes("/next/") ? { status: 503 } : { body: okBody("South Africa") }));

  const out = await fetchEventsByCode({ RSA: 4227 }, FAST);
  assert.equal(out.RSA.lastEvents.length, 1);
  // null, not [] — "didn't get told" must stay distinct from "no fixtures".
  assert.equal(out.RSA.nextEvents, null);
});

test("fetchEventsByCode: neither half answering drops the team entirely", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch((url) => (url.includes("/teams/4227/") ? { status: 503 } : { body: okBody("Wales") }));

  const out = await fetchEventsByCode({ RSA: 4227, WAL: 900 }, FAST);
  assert.equal("RSA" in out, false);
});

test("fetchEventsByCode: nothing coming back at all is still fatal", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch(() => ({ status: 503 }));

  await assert.rejects(() => fetchEventsByCode({ RSA: 4227, WAL: 900 }, FAST), /any of 2 teams/);
});

test("fetchEventsByCode: the retry budget caps a sustained outage", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(() => ({ status: 503 }));

  await assert.rejects(() =>
    fetchEventsByCode({ RSA: 4227, WAL: 900, NZL: 901 }, { ...FAST, retryBudget: 2 }));
  // 6 halves attempted once each, plus exactly 2 retries from the shared pot.
  assert.equal(calls.length, 8);
});

test("fetchEventsByCode: a rejected key is not retried and aborts on the spot", async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const calls = stubFetch(() => ({ status: 401 }));

  await assert.rejects(() => fetchEventsByCode({ RSA: 4227, WAL: 900 }, FAST), /HTTP 401/);
  // One call, not 4 — a bad key will not come good later in the same run.
  assert.equal(calls.length, 1);
});

test("mergeRefreshed: a team missing from the fresh set keeps its previous entry", () => {
  const prev = {
    RSA: { last: [{ id: 1, us: 16, them: 33, tries: 2 }], next: [] },
    WAL: { last: [{ id: 2, us: 0, them: 43 }], next: [] },
  };
  const fresh = { WAL: { last: [{ id: 2, us: 0, them: 43, tries: 0 }], next: [] } };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA, prev.RSA);
  assert.equal(out.WAL.last[0].tries, 0);
});

test("mergeRefreshed: a null enrichment in the fresh copy defers to the old one", () => {
  const prev = { RSA: { last: [{ id: 1, tries: 4, cards: 1, venue: "Ellis Park" }], next: [] } };
  const fresh = { RSA: { last: [{ id: 1, tries: null, cards: null, venue: null }], next: [] } };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA.last[0], { id: 1, tries: 4, cards: 1, venue: "Ellis Park" });
});

test("buildTeamEvents: a null half is marked unknown, an empty one is not", () => {
  const out = buildTeamEvents({ RSA: { lastEvents: [], nextEvents: null } }, NOW);
  assert.equal(out.RSA.lastUnknown, undefined);
  assert.equal(out.RSA.nextUnknown, true);
});

test("mergeRefreshed: an unanswered half keeps what is already published", () => {
  const prev = { RSA: { last: [{ id: 1, us: 16, them: 33 }], next: [{ id: 2, date: "2026-08-29T15:00:00Z" }] } };
  const fresh = { RSA: { last: [{ id: 1, us: 16, them: 33 }], next: [], nextUnknown: true } };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA.next, prev.RSA.next);
  assert.equal("nextUnknown" in out.RSA, false);
});

test("mergeRefreshed: an ANSWERED empty half really does empty it", () => {
  const prev = { RSA: { last: [{ id: 1 }], next: [{ id: 2, date: "2026-08-29T15:00:00Z" }] } };
  const fresh = { RSA: { last: [{ id: 1 }], next: [] } };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA.next, []);
});

// 23 Aug 2026: RSA's `last` came back fresh with Ellis Park at 16-33 while the
// `next` call 503'd, so the kept `next` still carried the same event id
// unscored. The Team page charted the game and listed it as upcoming at once,
// and teamsDue kept re-requesting a result it already had.
test("mergeRefreshed: a kept `next` drops games the fresh `last` has now played", () => {
  const prev = {
    RSA: {
      last: [{ id: 900 }],
      next: [{ id: 16651329, date: "2026-08-22T15:00:00Z" }, { id: 16651327, date: "2026-08-29T15:00:00Z" }],
    },
  };
  const fresh = {
    RSA: { last: [{ id: 900 }, { id: 16651329, us: 16, them: 33 }], next: [], nextUnknown: true },
  };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA.next.map((g) => g.id), [16651327]);
  assert.equal(out.RSA.last.at(-1).them, 33);
});

test("mergeRefreshed: a kept `next` with nothing played through is untouched", () => {
  const prev = { RSA: { last: [{ id: 900 }], next: [{ id: 16651327, date: "2026-08-29T15:00:00Z" }] } };
  const fresh = { RSA: { last: [{ id: 900 }], next: [], nextUnknown: true } };
  const out = mergeRefreshed(prev, fresh);
  assert.deepEqual(out.RSA.next, prev.RSA.next);
});
