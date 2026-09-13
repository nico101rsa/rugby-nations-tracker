import { test } from "node:test";
import assert from "node:assert/strict";
import { scoredByEspn, liveTracked } from "./espn-scored.mjs";

test("tests and series are ESPN-scored; so is every competition but the Nations Championship", () => {
  assert.equal(scoredByEspn({ kind: "test", key: "test" }), true);
  assert.equal(scoredByEspn({ kind: "series", key: "series-rsa-nzl-2026" }), true);
  assert.equal(scoredByEspn({ kind: "competition", key: "pnc-2026" }), true);
  assert.equal(scoredByEspn({ kind: "competition", key: "rwc-2027" }), true);
  assert.equal(scoredByEspn({ kind: "competition", key: "rnc-2026" }), false); // nations.json
  assert.equal(scoredByEspn({ kind: "tour", key: "tour-nzl-2026" }), false);   // api-sports probe
  assert.equal(scoredByEspn(undefined), false);
});

test("liveTracked adds tour games to the burst set without making them ESPN-scored", () => {
  assert.equal(liveTracked({ kind: "tour" }), true);
  assert.equal(liveTracked({ kind: "competition", key: "pnc-2026" }), true);
  assert.equal(liveTracked({ kind: "competition", key: "rnc-2026" }), false);
  assert.equal(liveTracked(null), false);
});
