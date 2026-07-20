import { test } from "node:test";
import assert from "node:assert/strict";
import { itemKey, mergeIntoPool, prunePool, RETENTION_HOURS } from "./harvest-news.mjs";

const NOW = new Date("2026-07-20T10:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

const item = (over = {}) => ({
  title: "Rassie Erasmus provides Feinberg-Mngomezulu fitness update",
  link: "https://www.planetrugby.com/news/rassie-fitness-update",
  desc: "",
  date: "Mon, 20 Jul 2026 08:00:00 +0000",
  feedId: "planetrugby",
  feedName: "Planet Rugby",
  position: 1,
  ...over,
});

test("itemKey: ignores tracking parameters and trailing slashes", () => {
  const a = itemKey(item({ link: "https://www.bbc.co.uk/sport/articles/abc?at_medium=RSS&at_campaign=rss" }));
  const b = itemKey(item({ link: "https://www.bbc.co.uk/sport/articles/abc" }));
  const c = itemKey(item({ link: "https://www.bbc.co.uk/sport/articles/abc/" }));
  assert.equal(a, b);
  assert.equal(b, c);
});

test("itemKey: falls back to the title when there is no link", () => {
  assert.equal(itemKey(item({ link: "" })), "title:rassie erasmus provides feinberg-mngomezulu fitness update");
});

test("itemKey: distinct stories get distinct keys", () => {
  assert.notEqual(itemKey(item()), itemKey(item({ link: "https://www.planetrugby.com/news/mallett-blight" })));
});

test("mergeIntoPool: adds new items with a firstSeen stamp", () => {
  const pool = mergeIntoPool([], [item()], hoursAgo(0));
  assert.equal(pool.length, 1);
  assert.equal(pool[0].firstSeen, hoursAgo(0));
  assert.equal(pool[0].lastSeen, hoursAgo(0));
});

// The whole point of harvesting hourly: a story seen at 08:00 must still be
// available to the daily run at 20:00, holding the position it broke at.
test("mergeIntoPool: an item seen again keeps its original firstSeen and position", () => {
  const first = mergeIntoPool([], [item({ position: 0 })], hoursAgo(12));
  const second = mergeIntoPool(first, [item({ position: 9 })], hoursAgo(0));
  assert.equal(second.length, 1, "re-seeing a story must not duplicate it");
  assert.equal(second[0].firstSeen, hoursAgo(12), "firstSeen is when it broke");
  assert.equal(second[0].lastSeen, hoursAgo(0));
  assert.equal(second[0].position, 0, "position it broke at is the editorial signal");
});

test("mergeIntoPool: a real pubDate arriving later replaces a missing one", () => {
  const first = mergeIntoPool([], [item({ date: "" })], hoursAgo(3));
  const second = mergeIntoPool(first, [item({ date: "Mon, 20 Jul 2026 07:00:00 +0000" })], hoursAgo(0));
  assert.equal(second[0].date, "Mon, 20 Jul 2026 07:00:00 +0000");
});

test("mergeIntoPool: the same story from two outlets is kept twice", () => {
  const pool = mergeIntoPool(
    [],
    [
      item({ feedId: "planetrugby", link: "https://www.planetrugby.com/a" }),
      item({ feedId: "bbc", link: "https://www.bbc.co.uk/b" }),
    ],
    hoursAgo(0),
  );
  assert.equal(pool.length, 2, "corroboration is counted from separate items, not merged away here");
});

test("prunePool: drops items past the retention window, keeps the rest", () => {
  const pool = [
    { ...item(), firstSeen: hoursAgo(1) },
    { ...item({ link: "https://x.test/b" }), firstSeen: hoursAgo(RETENTION_HOURS - 1) },
    { ...item({ link: "https://x.test/c" }), firstSeen: hoursAgo(RETENTION_HOURS + 1) },
  ];
  const kept = prunePool(pool, NOW);
  assert.equal(kept.length, 2);
  assert.ok(!kept.some((i) => i.link === "https://x.test/c"));
});

test("prunePool: falls back to pubDate when firstSeen is absent", () => {
  const kept = prunePool([{ ...item(), firstSeen: undefined, date: "Mon, 20 Jul 2026 08:00:00 +0000" }], NOW);
  assert.equal(kept.length, 1);
});

test("prunePool: an item with no usable timestamp is dropped, not kept forever", () => {
  const kept = prunePool([{ ...item(), firstSeen: undefined, date: "nonsense" }], NOW);
  assert.equal(kept.length, 0);
});
