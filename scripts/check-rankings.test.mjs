import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNo1 } from "./check-rankings.mjs";

const rankings = (top, others = {}) => ({
  rankings: { [top]: { rank: 1, points: 93.96, move: 0 }, ...others },
});
const stats = (entries) => ({
  teams: Object.fromEntries(
    Object.entries(entries).map(([code, since]) => [
      code,
      { no1: since === null ? null : { totalWeeks: 40, longestWeeks: 30, currentSince: since } },
    ]),
  ),
});

test("the healthy case: live No. 1 and the open spell agree", () => {
  assert.equal(checkNo1(rankings("RSA", { NZL: { rank: 2 } }), stats({ RSA: "2025-09-15", NZL: null })), null);
});

test("a nation that has never held No. 1 carries a null no1 and is not a fault", () => {
  assert.equal(checkNo1(rankings("RSA"), stats({ RSA: "2025-09-15", ITA: null, FIJ: null })), null);
});

test("THE failure: timeline still open for the previous holder", () => {
  // RSA lost No. 1 to NZL; Wikipedia's template hasn't closed RSA's spell, so
  // the app keeps counting RSA's streak upward against today.
  const p = checkNo1(rankings("NZL", { RSA: { rank: 2 } }), stats({ RSA: "2025-09-15", NZL: null }));
  assert.equal(p.kind, "stale-timeline");
  assert.match(p.title, /timeline still has RSA at No\. 1, live table says NZL/);
  assert.match(p.detail, /ticking upward/);
  assert.match(p.detail, /streak-first/);
});

test("no open spell at all is reported, and named as the benign direction", () => {
  const p = checkNo1(rankings("RSA"), stats({ RSA: null, NZL: null }));
  assert.equal(p.kind, "no-current-holder");
  assert.match(p.detail, /benign direction/);
});

test("two open spells is a parse fault, not a data lag", () => {
  const p = checkNo1(rankings("RSA"), stats({ RSA: "2025-09-15", NZL: "2024-01-01" }));
  assert.equal(p.kind, "multiple-holders");
  assert.match(p.detail, /parse fault/);
});

test("no live No. 1 is reported, and names the untracked-nation explanation", () => {
  // We only carry 12 nations; a 13th topping the table looks empty from here.
  const p = checkNo1({ rankings: { RSA: { rank: 2 }, NZL: { rank: 3 } } }, stats({ RSA: "2025-09-15" }));
  assert.equal(p.kind, "no-live-no1");
  assert.match(p.detail, /UNTRACKED nation/);
});

test("two teams at rank 1 is reported", () => {
  const p = checkNo1(
    { rankings: { RSA: { rank: 1 }, NZL: { rank: 1 } } },
    stats({ RSA: "2025-09-15" }),
  );
  assert.equal(p.kind, "no-live-no1");
  assert.match(p.title, /more than one/);
});

test("empty or missing files are reported rather than silently passing", () => {
  assert.equal(checkNo1({}, {}).kind, "no-live-no1");
  assert.equal(checkNo1(null, null).kind, "no-live-no1");
});
