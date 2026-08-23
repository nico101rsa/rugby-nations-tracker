import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, verdict, deadStreak } from "./vendor-probe.mjs";

const res = (status, body) => ({ status, json: async () => body });

test("probe: a 200 reports the event count", async () => {
  const r = await probe(4227, "last", async () => res(200, { events: [1, 2, 3] }));
  assert.deepEqual(r, { status: 200, events: 3 });
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
