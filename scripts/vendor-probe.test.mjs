import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, verdict, deadStreak } from "./vendor-probe.mjs";
import { vendorEvents } from "./fetch-team-events.mjs";

const res = (status, body) => ({ status, json: async () => body });

test("probe: a 200 reports the event count", async () => {
  const r = await probe(4227, "last", async () => res(200, { events: [1, 2, 3] }));
  assert.deepEqual(r, { status: 200, events: 3 });
});

// The live shape. The probe read the bare `.events` and logged all 147
// healthy answers from 23 Aug to 3 Oct 2026 as "0 events"; the fetcher reads
// `data.events`, so the log said empty while team-events.json filled up.
test("probe: counts a healthy answer's events where the vendor puts them (data.events)", async () => {
  const r = await probe(4227, "last", async () => res(200, { data: { events: [{ id: 1 }, { id: 2 }] } }));
  assert.deepEqual(r, { status: 200, events: 2 });
});

test("probe: counts exactly what fetch-team-events.mjs would read from the same page", async () => {
  const bodies = [
    { data: { events: [1, 2, 3, 4] } },
    { events: [1] },
    { data: { events: [] }, events: [1, 2] }, // an explicit empty data.events wins, as in the fetcher
    { data: {} },
    {},
  ];
  for (const body of bodies) {
    const r = await probe(4231, "next", async () => res(200, body));
    assert.equal(r.events, vendorEvents(body).length, JSON.stringify(body));
  }
});

test("probe: a body that is not JSON records the status with an unknown count", async () => {
  const r = await probe(4227, "next", async () => ({ status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  assert.deepEqual(r, { status: 200, events: null });
});

test("probe: a 503 is recorded, not thrown", async () => {
  const r = await probe(4227, "last", async () => res(503, {}));
  assert.equal(r.status, 503);
});

test("probe: a socket failure is its own row rather than a crashed run", async () => {
  const r = await probe(4227, "last", async () => { throw new Error("ENOTFOUND"); });
  assert.equal(r.status, 0);
  assert.equal(r.error, "ENOTFOUND");
});

test("verdict: a PARTIAL answer is degraded, not healthy", () => {
  // Exactly the New Zealand case — `next` answered, `last` did not, and the
  // chart was wrong anyway.
  const v = verdict([
    { code: "NZL", half: "last", status: 503 },
    { code: "NZL", half: "next", status: 200 },
  ]);
  assert.equal(v.healthy, false);
  assert.match(v.summary, /NZL\/last 503/);
});

test("verdict: every endpoint 200 is healthy", () => {
  assert.equal(verdict([{ status: 200 }, { status: 200 }]).healthy, true);
});

test("deadStreak: counts back from the latest and stops at the first good night", () => {
  assert.equal(deadStreak([
    { healthy: false }, { healthy: true }, { healthy: false }, { healthy: false },
  ]), 2);
  assert.equal(deadStreak([{ healthy: true }]), 0);
  assert.equal(deadStreak([]), 0);
});
