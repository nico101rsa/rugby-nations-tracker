import { test } from "node:test";
import assert from "node:assert/strict";
import { countTries } from "./scrape-tries.mjs";

const d = (type, teamId) => ({ type: { text: type }, team: { id: teamId } });

test("countTries counts tries and penalty tries by team id, and nothing else", () => {
  const details = [
    d("Try", "8"), d("Conversion", "8"), d("try", "8"), d("Penalty Try", "8"),
    d("Penalty Goal", "9"), d("Try", "9"), d("Drop Goal", "9"), d("Conversion", "9"),
    d("Try", 9), // numeric ids compare as strings
    d("Yellow Card", "8"),
  ];
  assert.deepEqual(countTries(details, "8"), { home: 3, away: 2 });
  assert.deepEqual(countTries(details, 8), { home: 3, away: 2 });
});

test("countTries on no details is 0-0, never a throw", () => {
  assert.deepEqual(countTries(undefined, "1"), { home: 0, away: 0 });
  assert.deepEqual(countTries([], "1"), { home: 0, away: 0 });
  assert.deepEqual(countTries([{ type: null }], "1"), { home: 0, away: 0 });
});
