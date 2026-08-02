import { test } from "node:test";
import assert from "node:assert/strict";
import { tourFixtures, HAND_RESULTS, TOUR_COMP, loadProbeResults } from "./seed-tour.mjs";
import { buildFixtures } from "./build-fixtures.mjs";

test("tour seed: 4 games, NZ tracked-away, franchise untracked-home, kind tour", () => {
  const out = tourFixtures();
  assert.equal(out.length, 4);
  for (const f of out) {
    assert.deepEqual(f.away, { code: "NZL", name: "New Zealand", tracked: true });
    assert.equal(f.home.tracked, false);
    assert.deepEqual(f.comp, { key: "tour-nzl-2026", label: "TOUR", kind: "tour" });
    assert.equal(f.timeTBC, false);
    assert.equal(f.seeded, true);
    assert.ok(f.date.endsWith("T17:10:00Z")); // 19:10 SAST throughout
  }
  assert.deepEqual(
    out.map((f) => [f.date.slice(0, 10), f.home.code]),
    [
      ["2026-08-07", "STO"],
      ["2026-08-11", "SHA"],
      ["2026-08-15", "BUL"],
      ["2026-08-25", "LIO"],
    ],
  );
});

test("tour seed: score null until played; probe result fills it", () => {
  assert.equal(tourFixtures().every((f) => f.score === null), true);
  const out = tourFixtures({ "seed-tour-nzl2026-sto": { home: 19, away: 31 } });
  assert.deepEqual(out.find((f) => f.home.code === "STO").score, { home: 19, away: 31 });
  assert.equal(out.find((f) => f.home.code === "SHA").score, null);
});

test("tour seed: every fixture id has a HAND_RESULTS slot (the hand-edit fallback)", () => {
  // The results mechanism only works if the keys line up — a typo'd slot
  // would silently never publish a hand-edited score.
  assert.deepEqual(Object.keys(HAND_RESULTS).sort(), tourFixtures().map((f) => f.id).sort());
});

test("loadProbeResults: missing file is the normal empty state, not an error", async () => {
  assert.deepEqual(await loadProbeResults("/nonexistent/tour-results.json"), {});
});

test("series pass never touches tour fixtures — kind tour is not kind test", () => {
  // Tour games are appended AFTER buildFixtures, so the series-folding pass
  // (which pairs kind:"test" games) structurally cannot see them; this pins
  // the invariant it relies on. Two NZ tour games at the same venue pair
  // would otherwise be exactly the shape the pass folds.
  assert.equal(TOUR_COMP.kind, "tour");
  const merged = [...buildFixtures([], new Map(), {}), ...tourFixtures()];
  assert.equal(merged.every((f) => f.series === undefined), true);
  assert.equal(merged.filter((f) => f.comp.kind === "tour").length, 4);
});
