// fixtures.json — the app's general upcoming-internationals list (Fixtures
// tab rewrite, spec 2026-07-19). One entry per MATCH (not per team): every
// announced fixture involving at least one of the 12 tracked nations, across
// all competitions, no time cutoff. Built from the same keyless ESPN core-API
// events that supplement team-events.json (fetchEspnEvents), so it costs no
// SportsAPI quota.
//
// Shape (spec §3): { id, date, timeTBC, home, away, comp, round?, series?,
// venue } sorted ascending by kickoff. `comp.kind` is competition | series |
// test; a "series" is 2+ non-competition games between the same pair
// ("SA v NZ · Game 1/4"). NC rounds come from nations.json (ESPN carries no
// round numbers). Live/today status is merged client-side from the live feed.

import { readFile, writeFile } from "node:fs/promises";
import { fetchEspnEvents, ESPN_TEAM_IDS } from "./fetch-espn-fixtures.mjs";

const ID_TO_CODE = Object.fromEntries(Object.entries(ESPN_TEAM_IDS).map(([c, id]) => [String(id), c]));

const CODE_NAMES = {
  ENG: "England", SCO: "Scotland", IRE: "Ireland", WAL: "Wales",
  RSA: "South Africa", AUS: "Australia", NZL: "New Zealand", FRA: "France",
  ARG: "Argentina", FIJ: "Fiji", ITA: "Italy", JPN: "Japan",
};

// Codes for common untracked opponents; anything else falls back to the
// first three letters of the name (flags for these don't exist in the app —
// it renders the code as text).
const UNTRACKED_CODES = {
  Georgia: "GEO", Portugal: "POR", Uruguay: "URU", Spain: "ESP", Chile: "CHI",
  Samoa: "SAM", Tonga: "TGA", Romania: "ROU", Namibia: "NAM", Canada: "CAN",
  "United States": "USA", USA: "USA", Barbarians: "BAR", "Hong Kong": "HKG",
};

// Short forms for series labels ("SA v NZ", not "RSA v NZL").
const SERIES_SHORT = {
  RSA: "SA", NZL: "NZ", AUS: "AUS", ARG: "ARG", ENG: "ENG", FRA: "FRA",
  IRE: "IRE", ITA: "ITA", SCO: "SCO", WAL: "WAL", FIJ: "FIJ", JPN: "JPN",
};

const teamIdFromRef = (ref) => (String(ref ?? "").match(/\/teams\/(\d+)/) ?? [])[1] ?? null;

function side(espnId, names) {
  const code = ID_TO_CODE[espnId];
  if (code) return { code, name: CODE_NAMES[code], tracked: true };
  const name = names.get(espnId) ?? "Unknown";
  return { code: UNTRACKED_CODES[name] ?? name.slice(0, 3).toUpperCase(), name, tracked: false };
}

// League name + fixture year -> comp tag. Test matches get a placeholder the
// series pass may upgrade.
export function compFor(leagueName, year) {
  const yy = String(year).slice(2);
  switch (leagueName) {
    case "Nations Championship":
      return { key: `rnc-${year}`, label: `RNC '${yy}`, kind: "competition" };
    case "The Rugby Championship":
      return { key: `trc-${year}`, label: `TRC '${yy}`, kind: "competition" };
    case "Six Nations":
      return { key: `6n-${year}`, label: `6N '${yy}`, kind: "competition" };
    default:
      return { key: "test", label: "TEST", kind: "test" };
  }
}

// NC round lookup: nations.json fixtures/results matched by both team names
// + kickoff within 36h (static NC fixtures carry placeholder noon times).
export function roundLookup(nations) {
  const all = [...(nations?.fixtures ?? []), ...(nations?.results ?? [])];
  return (homeName, awayName, dateIso) => {
    const t = new Date(dateIso).getTime();
    const hit = all.find(
      (m) =>
        m.home?.name === homeName &&
        m.away?.name === awayName &&
        Math.abs(new Date(m.date).getTime() - t) <= 36 * 3600 * 1000,
    );
    return hit?.week != null ? String(hit.week) : null;
  };
}

// Pure core: raw ESPN events -> the published fixtures array.
export function buildFixtures(events, names, nations) {
  const findRound = roundLookup(nations);
  const out = [];
  for (const { event, leagueName } of events) {
    const comp0 = event.competitions?.[0];
    if (!comp0) continue;
    const sides = {};
    for (const c of comp0.competitors ?? []) sides[c.homeAway] = teamIdFromRef(c.team?.$ref);
    if (!sides.home || !sides.away) continue;
    const home = side(sides.home, names);
    const away = side(sides.away, names);
    if (!home.tracked && !away.tracked) continue;
    const date = new Date(event.date).toISOString();
    const comp = compFor(leagueName, new Date(date).getUTCFullYear());
    const v = comp0.venue;
    const venue = v?.fullName
      ? v.address?.city && v.address.city !== v.fullName
        ? `${v.fullName}, ${v.address.city}`
        : v.fullName
      : null;
    const entry = {
      id: `espn-${event.id}`,
      date,
      timeTBC: comp0.timeValid === false,
      home,
      away,
      comp,
      venue,
    };
    if (comp.kind === "competition" && leagueName === "Nations Championship") {
      const round = findRound(home.name, away.name, date);
      if (round) entry.round = round;
    }
    out.push(entry);
  }

  // Series pass: 2+ test games between the same pair become a named series
  // ("SA v NZ · Game 1/4"); the pair label follows the first game's home side.
  const tests = out.filter((e) => e.comp.kind === "test");
  const byPair = new Map();
  for (const e of tests) {
    const key = [e.home.code, e.away.code].sort().join("-");
    (byPair.get(key) ?? byPair.set(key, []).get(key)).push(e);
  }
  for (const games of byPair.values()) {
    if (games.length < 2) continue;
    games.sort((a, b) => new Date(a.date) - new Date(b.date));
    const first = games[0];
    const label = `${SERIES_SHORT[first.home.code] ?? first.home.code} v ${SERIES_SHORT[first.away.code] ?? first.away.code}`;
    const year = new Date(first.date).getUTCFullYear();
    const key = `series-${first.home.code.toLowerCase()}-${first.away.code.toLowerCase()}-${year}`;
    games.forEach((e, i) => {
      e.comp = { key, label, kind: "series" };
      e.series = { label, game: i + 1, of: games.length };
    });
  }

  return out.sort((a, b) => new Date(a.date) - new Date(b.date) || (a.id < b.id ? -1 : 1));
}

async function main() {
  // 24h grace so today's already-kicked-off matches survive the daily build —
  // the app owns the device-local "until the day ends" cutoff.
  const now = Date.now() - 24 * 3600 * 1000;
  const { events, names } = await fetchEspnEvents(now);
  const nations = JSON.parse(await readFile("public/nations.json", "utf8"));
  const fixtures = buildFixtures(events, names, nations);
  const out = { updatedAt: new Date().toISOString(), source: "espn", fixtures };
  await writeFile("fixtures.json", JSON.stringify(out, null, 1) + "\n");
  const kinds = fixtures.reduce((m, f) => ((m[f.comp.label] = (m[f.comp.label] ?? 0) + 1), m), {});
  console.log(`fixtures.json written — ${fixtures.length} fixtures:`, JSON.stringify(kinds));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
