import { test } from "node:test";
import assert from "node:assert/strict";
import { venueLabel, fallbackCity } from "./venues.mjs";

test("venueLabel: stadium + city when ESPN supplies an address", () => {
  assert.equal(
    venueLabel({ fullName: "Ellis Park", address: { city: "Johannesburg" } }),
    "Ellis Park, Johannesburg",
  );
});

test("venueLabel: no venue at all -> null", () => {
  assert.equal(venueLabel(undefined), null);
  assert.equal(venueLabel(null), null);
  assert.equal(venueLabel({}), null);
});

test("venueLabel: a city that merely repeats the stadium name is dropped", () => {
  assert.equal(venueLabel({ fullName: "Twickenham", address: { city: "Twickenham" } }), "Twickenham");
});

test("venueLabel: unknown address-less venue stays bare rather than guessing", () => {
  assert.equal(venueLabel({ id: "999999", fullName: "Somewhere Park" }), "Somewhere Park");
});

// The two fixtures that motivated the fallback (both live records, 2026-08-22).
test("venueLabel: address-less M&T Bank Stadium gains Baltimore", () => {
  assert.equal(venueLabel({ id: "308782", fullName: "M&T Bank Stadium" }), "M&T Bank Stadium, Baltimore");
});

test("venueLabel: address-less Denka Big Swan Stadium gains Niigata", () => {
  assert.equal(
    venueLabel({ id: "308785", fullName: "Denka Big Swan Stadium" }),
    "Denka Big Swan Stadium, Niigata",
  );
});

test("venueLabel: address-less Allianz Stadium resolves by id, not by name", () => {
  // Turin (ITA v RSA) is the one ESPN publishes bare.
  assert.equal(venueLabel({ id: "308704", fullName: "Allianz Stadium" }), "Allianz Stadium, Turin");
  // London (16145, Twickenham renamed) and Sydney share the NAME. A bare
  // record for either must NOT inherit Turin — better bare than wrong.
  assert.equal(venueLabel({ id: "16145", fullName: "Allianz Stadium" }), "Allianz Stadium");
  assert.equal(venueLabel({ fullName: "Allianz Stadium" }), "Allianz Stadium");
});

test("venueLabel: ESPN's own address always wins over the fallback map", () => {
  assert.equal(
    venueLabel({ id: "16145", fullName: "Allianz Stadium", address: { city: "London" } }),
    "Allianz Stadium, London",
  );
  // Even for an id the map does know about.
  assert.equal(
    venueLabel({ id: "308704", fullName: "Allianz Stadium", address: { city: "Torino" } }),
    "Allianz Stadium, Torino",
  );
});

test("fallbackCity: null for anything the map cannot vouch for", () => {
  assert.equal(fallbackCity({ fullName: "Unknown Ground" }), null);
  assert.equal(fallbackCity({ id: "1", fullName: "Allianz Stadium" }), null);
  assert.equal(fallbackCity(null), null);
});
