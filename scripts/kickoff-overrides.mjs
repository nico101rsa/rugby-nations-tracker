// Hand-confirmed kickoff times laid over the vendors' times in every feed the
// app reads: fixtures.json, nations.json and team-events.json `next`.
//
// The vendors run late. ESPN and api-sports list Rugby Australia's games
// 10-15 minutes after the time the union itself publishes: Perth on 27 Sep
// 2026 read 17:45 AWST where the Wallabies, Optus Stadium and SA Rugby all
// said 5:30pm. Nico's brother noticed ("constantly 10 min late"), and
// googling the same game shows both numbers.
//
// Policy (Nico, 26 Sep 2026): when sources disagree, show the EARLIER time.
// Someone who tunes in ten minutes early loses nothing; someone ten minutes
// late has missed the anthems. So a row here may only ever move a kickoff
// EARLIER, on the same UTC day, by at most an hour — anything bigger is a
// reschedule and belongs to the vendor. kickoff-overrides.test.mjs enforces
// all three.
//
// Each row carries the vendor's time as it stood when the row was written.
// The override applies only while the feed still says that: if the vendor
// moves the game (a reschedule, or its own correction), the feed wins again
// and the row is dead weight until someone removes it. Rows fall out of
// relevance on their own once the game is played; delete them then.
//
// This table used to live in the app (src/kickoff-overrides.js, 1.3.9), where
// a new row needed a TestFlight build. Here a row reaches every installed copy
// at the next fixtures rebuild — or within minutes of the merge, through the
// push-triggered "Rebuild fixtures & calendars" workflow. The app's table goes
// quiet by itself once the feed carries the earlier time (its own vendor
// guard), and is deleted in the dec-jan build.
//
// KEYED BY MATCH, NOT BY ID. One game has three ids across the feeds —
// fixtures.json "espn-603464", team-events.json either that or a SportsAPI
// number, nations.json an api-sports number or "static-r<week>-<homeId>" — so
// the key is what every feed agrees on: "<UTC day of the VENDOR time>
// <HOME>-<AWAY>", codes as fixtures.json prints them (ESPN_TEAM_IDS keys for
// the 12; UNTRACKED_CODES values for everyone else). Never key a row on a
// seed or placeholder time (static noon slots, seed-6n… estimates): the vendor
// guard would make it a no-op at best and a wrong time at worst.
import { ESPN_TEAM_IDS, UNTRACKED_CODES } from "./fetch-espn-fixtures.mjs";
import { API_SPORTS_CODE_BY_ID } from "./static-fixtures.mjs";

export const KICKOFF_OVERRIDES = {
  "2026-10-17 AUS-NZL": {
    // Sat 17 Oct, 3:45pm AEDT (Sydney is on daylight time from 4 Oct).
    date: "2026-10-17T04:45:00.000Z",
    vendor: "2026-10-17T05:00:00.000Z", // what ESPN and SportsAPI said when the row was written
    note: "AUS v NZL Bledisloe, Accor Stadium, Sydney — the stadium publishes 3:45pm AEDT; ESPN 4:00pm",
  },
};

export { ESPN_TEAM_IDS, UNTRACKED_CODES };

const ms = (iso) => new Date(iso).getTime();
export const utcDay = (iso) => new Date(iso).toISOString().slice(0, 10);

export const matchKey = (home, away, iso) =>
  home && away && iso && Number.isFinite(ms(iso)) ? `${utcDay(iso)} ${home}-${away}` : null;

// One key function per feed shape. The core below never reads ids.
export const keyOf = {
  // fixtures.json rows: { home: { code }, away: { code }, date }
  fixture: (r) => matchKey(r?.home?.code, r?.away?.code, r?.date),
  // nations.json slim rows carry api-sports team ids, not codes.
  nations: (codeById = API_SPORTS_CODE_BY_ID) => (r) =>
    matchKey(codeById[r?.home?.id], codeById[r?.away?.id], r?.date),
  // team-events.json `next` rows are one team's view: opponent + H/A. An
  // untracked opponent has opponentCode null, so fall back to the same
  // name → code map fixtures.json uses (AUS v HKG keys the same everywhere).
  teamNext: (code, untracked = UNTRACKED_CODES) => (r) => {
    const opp = r?.opponentCode ?? untracked[r?.opponent] ?? null;
    if (!code || !opp) return null;
    return r.homeAway === "H" ? matchKey(code, opp, r.date) : matchKey(opp, code, r.date);
  },
};

// One row of any feed. Returns the same object when nothing applies, so
// unchanged feeds keep their identity.
export function overrideKickoff(row, keyFn, table = KICKOFF_OVERRIDES) {
  const key = keyFn(row);
  const o = key ? table[key] : undefined;
  if (!o) return row;
  if (ms(row.date) !== ms(o.vendor)) return row; // the vendor moved it — feed wins
  if (ms(row.date) === ms(o.date)) return row; // vendor caught up
  return { ...row, date: o.date, timeTBC: false };
}

// A whole array. Returns the SAME array when nothing applies, a new one
// otherwise (callers that sort must re-sort: the move can reorder a day).
export function applyKickoffOverrides(rows, keyFn, table = KICKOFF_OVERRIDES, { log = console.log } = {}) {
  if (!Array.isArray(rows)) return rows;
  let changed = false;
  const out = rows.map((r) => {
    const o = overrideKickoff(r, keyFn, table);
    if (o !== r) {
      changed = true;
      log(`kickoff override applied: ${keyFn(r)} ${r.date}→${o.date}`);
    }
    return o;
  });
  return changed ? out : rows;
}
