import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchLeagueFixtures, ingestable, windowFor, PAD_DAYS } from "./fetch-league-fixtures.mjs";

const REGISTRY = {
  competitions: [
    {
      key: "rwc-2027",
      label: "RWC '27",
      name: "Rugby World Cup",
      espnLeagueId: 164205,
      startDate: "2027-10-01",
      endDate: "2027-10-17",
      fixtureCount: 36,
      status: "scheduled",
    },
    {
      key: "6n-2027",
      label: "6N '27",
      name: "Six Nations",
      espnLeagueId: 180659,
      startDate: null,
      endDate: null,
      fixtureCount: 0,
      status: "announced",
    },
  ],
};

const siteEvent = (id, date, home, away) => ({
  id: String(id),
  date: `${date}T10:45Z`,
  competitions: [
    {
      timeValid: true,
      competitors: [
        { homeAway: "home", team: { id: String(home[0]), displayName: home[1] } },
        { homeAway: "away", team: { id: String(away[0]), displayName: away[1] } },
      ],
    },
  ],
});

test("ingestable skips announced competitions with no fixtures", () => {
  assert.deepEqual(
    ingestable(REGISTRY).map((c) => c.key),
    ["rwc-2027"],
  );
  assert.deepEqual(ingestable({}), []);
  assert.deepEqual(ingestable(null), []);
});

test("windowFor pads the competition's own span, and is null when unpublished", () => {
  assert.deepEqual(windowFor(REGISTRY.competitions[0], 30), { from: "2027-09-01", to: "2027-11-16" });
  assert.equal(windowFor(REGISTRY.competitions[1]), null);
  assert.equal(PAD_DAYS, 30);
});

test("fetchLeagueFixtures tags every match with the REGISTRY's comp, not the fixture year", async () => {
  const fetchJson = async () => ({
    events: [siteEvent(1, "2027-10-01", [6, "Australia"], [289268, "Hong Kong"])],
  });
  const { events } = await fetchLeagueFixtures(REGISTRY, fetchJson);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].comp, { key: "rwc-2027", label: "RWC '27", kind: "competition" });
  assert.equal(events[0].leagueName, "Rugby World Cup");
  assert.equal(events[0].registered, true);
});

test("fetchLeagueFixtures resolves display names inline — no follow-up fetch per team", async () => {
  const fetchJson = async () => ({
    events: [siteEvent(1, "2027-10-01", [289243, "Chile"], [289268, "Hong Kong"])],
  });
  const { names } = await fetchLeagueFixtures(REGISTRY, fetchJson);
  assert.equal(names.get("289243"), "Chile");
  assert.equal(names.get("289268"), "Hong Kong");
});

test("fetchLeagueFixtures dedupes across slice boundaries", async () => {
  const fetchJson = async () => ({
    events: [siteEvent(7, "2027-10-01", [6, "Australia"], [289268, "Hong Kong"])],
  });
  const { events } = await fetchLeagueFixtures(REGISTRY, fetchJson);
  assert.equal(events.length, 1);
});

test("a stub 200 body yields no events rather than throwing", async () => {
  const fetchJson = async () => ({ leagues: [] }); // no `events` key at all
  const { events } = await fetchLeagueFixtures(REGISTRY, fetchJson);
  assert.deepEqual(events, []);
});

test("past fixtures are excluded — the file stays a FUTURE fixtures list", async () => {
  const fetchJson = async () => ({
    events: [
      siteEvent(1, "2027-10-01", [6, "Australia"], [289268, "Hong Kong"]),
      siteEvent(2, "2026-02-05", [1, "England"], [4, "Wales"]), // already played
    ],
  });
  const since = new Date("2026-07-25T00:00:00Z").getTime();
  const { events } = await fetchLeagueFixtures(REGISTRY, fetchJson, since);
  assert.deepEqual(events.map((e) => e.event.id), ["1"]);
});
