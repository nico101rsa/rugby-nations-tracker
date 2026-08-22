// Venue labels for the published fixture files — "<Stadium>, <City>".
//
// WHY THIS EXISTS. Both ESPN ingest paths (the per-team core API in
// fetch-espn-fixtures.mjs and the league-wide site API in
// fetch-league-fixtures.mjs) format the venue the same way, so the formatting
// lived twice, in two files, character for character. A handful of ESPN venue
// records carry no `address` at all, and those published a BARE stadium name:
// "M&T Bank Stadium" for the 4th SA–NZ test and "Allianz Stadium" for Italy v
// South Africa. Bare is worse than it looks — the app has no other country cue
// on a fixture row, so "Allianz Stadium" alone tells a reader nothing about
// which continent the game is on.
//
// WHY NOT ESPN'S OWN `shortName`. It looks like a free fix: the Turin record
// carries `shortName: "Turin"`. It is not a city field. Sampled 2026-08-22:
// Scottish Gas Murrayfield -> "Murrayfield" (the ground's nickname, not
// Edinburgh), and Hanazono Rugby Stadium -> "Kyoto", which contradicts ESPN's
// OWN `address.city` of Osaka for the same record. Wiring it up would print a
// wrong city on the screen, which is precisely the failure this module exists
// to prevent. A curated map, consulted only where ESPN gives us nothing, is
// the honest option.

// Stadium name -> city, for venues ESPN publishes with no address.
//
// A string applies to any venue with that name. An object instead keys the
// city by ESPN venue id, for a name that identifies MORE THAN ONE ground.
//
// ⚠️ The two ESPN APIs partly disagree on venue ids: legacy grounds are
// numbered separately per API (the site API calls Ellis Park 16173), while
// newer records share one id across both (Turin's Allianz Stadium is 308704
// in each). An id-keyed entry must therefore list every id that names the
// same ground, or the fallback silently misses on one of the two paths.
export const VENUE_CITIES = {
  // Baltimore's Ravens ground, hosting SA v NZ game 4 of 4 on 2026-09-12.
  // Unambiguous as a name, so no id needed.
  "M&T Bank Stadium": "Baltimore",
  // Niigata's "Big Swan", hosting Japan v Canada on 2026-09-05. Also
  // unambiguous — the sponsor name belongs to this ground alone.
  "Denka Big Swan Stadium": "Niigata",
  // Three grounds share this name: Turin (Juventus'), London (Twickenham,
  // renamed) and Sydney. ESPN supplies London's and Sydney's city inline, so
  // only Turin's bare record reaches this fallback today — but keying by id
  // means a future bare London or Sydney record stays bare rather than
  // silently inheriting Turin.
  "Allianz Stadium": { 308704: "Turin" },
};

// The city we can stand behind for an address-less venue, or null. Keeping
// this separate from venueLabel is what lets the test assert the ambiguous
// case directly.
export function fallbackCity(venue) {
  const hit = VENUE_CITIES[venue?.fullName];
  if (typeof hit === "string") return hit;
  if (hit && venue?.id != null) return hit[String(venue.id)] ?? null;
  return null;
}

// One ESPN venue object (either API's shape) -> the label we publish, or null
// when ESPN names no venue at all. The city is dropped when it merely repeats
// the stadium name ("Twickenham, Twickenham").
export function venueLabel(venue) {
  const name = venue?.fullName;
  if (!name) return null;
  const city = venue.address?.city || fallbackCity(venue);
  return city && city !== name ? `${name}, ${city}` : name;
}
