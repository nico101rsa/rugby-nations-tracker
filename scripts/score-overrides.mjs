// Hand-confirmed final scores laid over a vendor that has the two sides'
// points the wrong way round.
//
// WHY. The 11th-place final of the 2026 Nations Championship (Italy v Fiji,
// Twickenham, Fri 27 Nov 2026 16:40 UTC) reached nations.json mirrored from
// the first point to the last: Fiji 7-0, 17-7 at half time, Fiji 23-21 at
// full time. Italy won 23-21 after leading 17-7 at the break (Federazione
// Italiana Rugby's match report: "gli Azzurri superano le Fiji 23-21 ...
// vantaggio 17-7"; RUGBY.com.au: "Italy edge Fiji ... to end seven-game
// losing streak"). ESPN's ticks and api-sports' ticks agreed with each other,
// so both vendors carried it that way; the overlay's own flip handling
// (espn-live-overlay.mjs) was not the cause. A user saw it on the Results tab
// at 07:17 Sydney time. It also banked the game for the South on the
// Hemisphere Shield card and the morning editions told it as a Fiji win.
// Nothing in a feed can say a score is mirrored, so a person has to.
//
// HOW. Same key as kickoff-overrides.mjs and host-overrides.mjs:
//   key     "<UTC day of the vendor kickoff> <HOME>-<AWAY>", codes as
//           fixtures.json prints them; matched in either orientation.
//   vendor  { CODE: points, CODE: points } the wrong score as the vendor
//           has it, by team. The row applies only while the vendor still
//           says exactly this, so a vendor that corrects itself (or rescores
//           the game) wins, and applying the table twice changes nothing.
//   score   { CODE: points, CODE: points } the confirmed score, by team.
//   source  where it was confirmed.
// Scores are by team code, never home/away, so a row can't be written the
// wrong way round itself. score-overrides.test.mjs checks every row.
import { utcDay } from "./kickoff-overrides.mjs";
import { API_SPORTS_CODE_BY_ID } from "./static-fixtures.mjs";

export const SCORE_OVERRIDES = {
  // 11th-place final. Confirmed Fri 27 Nov 2026 (Sat 28 Nov, Sydney time).
  "2026-11-27 ITA-FIJ": {
    vendor: { ITA: 21, FIJ: 23 },
    score: { ITA: 23, FIJ: 21 },
    source: "Federazione Italiana Rugby match report; RUGBY.com.au",
  },
};

const rowFor = (a, b, day, table) => table[`${day} ${a}-${b}`] ?? table[`${day} ${b}-${a}`] ?? null;
const resultOf = (us, them) => (us > them ? "W" : us < them ? "L" : "D");

// One nations.json slim row (api-sports ids, home/away scores). Same object
// back when nothing applies. Only a finished row is corrected.
export function overrideNationsScore(row, { table = SCORE_OVERRIDES, codeById = API_SPORTS_CODE_BY_ID } = {}) {
  if (row?.status?.short !== "FT") return row;
  const h = codeById[row.home?.id], a = codeById[row.away?.id];
  if (!h || !a || !row.date) return row;
  const o = rowFor(h, a, utcDay(row.date), table);
  if (!o || row.home.score !== o.vendor[h] || row.away.score !== o.vendor[a]) return row;
  return { ...row, home: { ...row.home, score: o.score[h] }, away: { ...row.away, score: o.score[a] } };
}

// Every row of a slim results array; logs each correction.
export function applyNationsScoreOverrides(rows, { table = SCORE_OVERRIDES, log = console.log } = {}) {
  let changed = false;
  const out = rows.map((r) => {
    const o = overrideNationsScore(r, { table });
    if (o !== r) {
      changed = true;
      log(`score override applied: ${r.home.name} ${r.home.score}-${r.away.score} ${r.away.name} → ${o.home.score}-${o.away.score}`);
    }
    return o;
  });
  return changed ? out : rows;
}

// One team-events.json row (`last`) of team `code`: us/them/result. Same
// object back when nothing applies.
export function overrideTeamScore(row, code, { table = SCORE_OVERRIDES } = {}) {
  const opp = row?.opponentCode;
  if (!code || !opp || !row.date || row.us == null || row.them == null) return row;
  const o = rowFor(code, opp, utcDay(row.date), table);
  if (!o || row.us !== o.vendor[code] || row.them !== o.vendor[opp]) return row;
  const us = o.score[code], them = o.score[opp];
  return { ...row, us, them, result: resultOf(us, them) };
}
