// How each competition turns results into a points table — as DATA, with the
// source each value was taken from. build-standings.mjs reads this and nothing
// else for its arithmetic and its tiebreak order, so a rule change is a one-row
// edit here, and the test pins every value so a drift is caught.
//
// Keyed by competition-key PREFIX (`6n-2027` -> `6n`). Researched 2026-10-11;
// the proxy refused every primary page body (world.rugby, rugbyworldcup.com,
// sixnationsrugby.com, wikipedia.org), so each rule was confirmed through the
// search-index text of the pages below. `tiebreakVerified` says how far to
// trust the ORDER: true = the organiser's own rules page; "secondary" = a
// well-sourced secondary page citing the organiser; false = not confirmed —
// the app must not print a tiebreak sentence for it.
//
//   6n   https://www.sixnationsrugby.com/rules/ ("The Table, Match Points and
//        Bonus Points"): 4/2/0, +1 for 4+ tries win or lose, +1 for losing by
//        7 or fewer, Grand Slam +3. Level on match points -> points difference
//        -> tries scored (penalty tries included) -> the place is SHARED. No
//        head-to-head and no wins criterion.
//   rwc  https://en.wikipedia.org/wiki/2027_Men%27s_Rugby_World_Cup (citing the
//        RWC 2027 Tournament Rules): 4/2/0, 4-try bonus, 7-point losing bonus.
//        Level on points -> winner of the match between the tied teams -> PD
//        -> try difference -> points scored -> tries scored -> World Rugby
//        rankings of 18 Oct 2027. Three or more level: apply from the top to
//        find one team, then RESTART at the top for the rest. Best thirds:
//        points -> PD -> try difference
//        (https://www.world.rugby/news/1019814/the-new-mens-rugby-world-cup-draw-format-explained).
//        The rankings step is never computed here — the app repo's
//        docs/DATA_RIGHTS.md rule 1 (no World Rugby-derived stat is shipped
//        beyond the rankings table itself) — so a pool level that far
//        publishes as a shared rank that `needs: "ranking"`.
//   trc  https://en.wikipedia.org/wiki/The_Rugby_Championship and
//        https://www.rugby.com.au/news/2016/06/23/02/37/new-bonus-points-for-rugby-championship:
//        the try bonus is 3+ tries MORE than the opponent (not 4 tries).
//        Level -> wins -> head-to-head wins -> PD -> head-to-head PD -> tries.
//        No SANZAAR regulations page was reachable: unverified. There is no
//        TRC in 2026 (SANZAAR calendar of 16 Oct 2025), so this row is
//        test-only until 2027 — re-check it when the 2027 regulations publish.
//   rnc  Points confirmed (https://www.allblacks.com/news/the-nations-championship-explained,
//        https://en.wikipedia.org/wiki/2026_Nations_Championship). The
//        TIEBREAK IS NOT: ~12 searches found no official text. The order here
//        is computeLog's (fetch-nations.mjs, Pts -> W -> PD -> PF) so the two
//        RNC tables can never disagree; the Six Nations-style alternative is
//        kept as `altTiebreak`, and the app's scenarios.js keeps requiring
//        both orders to agree before it says anything.
//   pnc  2026 is a four-team straight knockout (Osaka/Tokyo, 12 and 19 Sep):
//        no table, no competition points.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

// Every criterion a tiebreak chain may name. Each evaluates, for a set of
// teams level on everything before it, to a value per team, or to
// "inapplicable" (skip to the next), or to "unprovable" (stop: the set is
// published as tied with what it `needs`):
//   pts w pd pf    season totals — always provable
//   tf td          tries for / try difference — unprovable while any of the
//                  set has a game without try counts
//   h2h            the winner of the match between EXACTLY two tied teams
//                  (inapplicable for 3+, an unplayed or a drawn meeting)
//   h2hW h2hPd     wins / PD in the games played among the tied set
//   ranking        World Rugby ranking — never computed (DATA_RIGHTS rule 1)
//   shared         terminal: the rules say the place is shared
export const TOKENS = Object.freeze(["pts", "w", "pd", "pf", "tf", "td", "h2h", "h2hW", "h2hPd", "ranking", "shared"]);

// `meetings`: how many times each pair meets in the TABLE stage. A later
// meeting of a pair that has already met is not a table game — the Nations
// Championship finals weekend and the World Cup knockouts are both repeats
// filed under the same competition key. null = unknown, so no repeat filter
// (TRC has been single round in World Cup years and double otherwise).
export const RULES = deepFreeze({
  "6n": {
    id: "6n", win: 4, draw: 2, loss: 0,
    tryBonus: { type: "tries", min: 4 },
    losingBonus: { within: 7 },
    grandSlam: 3,
    tiebreak: ["pts", "pd", "tf", "shared"],
    restart: false,
    tiebreakVerified: true,
    meetings: 1,
    source: "https://www.sixnationsrugby.com/rules/",
  },
  rwc: {
    id: "rwc", win: 4, draw: 2, loss: 0,
    tryBonus: { type: "tries", min: 4 },
    losingBonus: { within: 7 },
    grandSlam: 0,
    tiebreak: ["pts", "h2h", "pd", "td", "pf", "tf", "ranking"],
    restart: true,
    tiebreakVerified: "secondary",
    thirds: ["pts", "pd", "td"],
    qualify: 2,
    thirdsQualify: 4,
    meetings: 1,
    source: "https://en.wikipedia.org/wiki/2027_Men%27s_Rugby_World_Cup",
  },
  trc: {
    id: "trc", win: 4, draw: 2, loss: 0,
    tryBonus: { type: "differential", min: 3 },
    losingBonus: { within: 7 },
    grandSlam: 0,
    tiebreak: ["pts", "w", "h2hW", "pd", "h2hPd", "tf"],
    restart: false,
    tiebreakVerified: false,
    meetings: null,
    source: "https://en.wikipedia.org/wiki/The_Rugby_Championship",
  },
  rnc: {
    id: "rnc", win: 4, draw: 2, loss: 0,
    tryBonus: { type: "tries", min: 4 },
    losingBonus: { within: 7 },
    grandSlam: 0,
    tiebreak: ["pts", "w", "pd", "pf"],
    restart: false,
    tiebreakVerified: false,
    altTiebreak: ["pts", "pd", "tf"],
    meetings: 1,
    source: null,
    note: "wins-vs-PD order unconfirmed; computeLog parity (fetch-nations.mjs sort); keep the app's dual-order hedge",
  },
  pnc: { id: "pnc", table: false },
});

// `6n-2027` -> RULES["6n"]; null for a prefix with no rules.
export function rulesFor(key) {
  const prefix = String(key ?? "").split("-")[0];
  return Object.hasOwn(RULES, prefix) ? RULES[prefix] : null;
}

// Official pool letters, from the draw in Sydney on 3 Dec 2025:
// https://www.skysports.com/rugby-union/news/12321/13478666/2027-rugby-world-cup-england-drawn-with-wales-in-pool-stages-as-ireland-face-scotland-and-hosts-australia-play-new-zealand
// (also https://www.hkrugby.com/news/details/mens-rugby-world-cup-2027-draw-results-and-reaction).
// build-competitions names a group only when its team set equals one of
// these EXACTLY, so a vendor team-set change drops the letter to null rather
// than mislabelling a pool.
export const POOL_NAMES = deepFreeze({
  "rwc-2027": {
    A: ["NZL", "AUS", "CHI", "HKG"],
    B: ["RSA", "ITA", "GEO", "ROU"],
    C: ["ARG", "FIJ", "ESP", "CAN"],
    D: ["IRE", "SCO", "URU", "POR"],
    E: ["FRA", "JPN", "USA", "SAM"],
    F: ["ENG", "WAL", "TGA", "ZIM"],
  },
});

// RWC 2027 Round of 16, official match numbering R16 (1)-(8), 23-24 Oct 2027
// (local match days). Sources: https://www.rugby.com.au/news/2027-rugby-world-cup-fixtures-matches-schedule-wallabies-games-how-to-watch-202622 ;
// https://experiences.rugbyworldcup.com/rwc2027/match-schedule ; the thirds
// rule https://www.world.rugby/media-zone/advisory/1019814. R16 (1)'s venue
// and every R16 kickoff time were not retrieved, so they stay null.
export const RWC_R16_SLOTS = deepFreeze([
  { stage: "R16", n: 1, home: { pool: "C", place: 2 }, away: { pool: "F", place: 2 }, date: "2027-10-23", venue: null },
  { stage: "R16", n: 2, home: { pool: "A", place: 1 }, away: { thirds: ["C", "E", "F"] }, date: "2027-10-23", venue: "Brisbane Stadium" },
  { stage: "R16", n: 3, home: { pool: "E", place: 1 }, away: { pool: "D", place: 2 }, date: "2027-10-23", venue: "Docklands Stadium, Melbourne" },
  { stage: "R16", n: 4, home: { pool: "B", place: 1 }, away: { thirds: ["D", "E", "F"] }, date: "2027-10-23", venue: "Perth Stadium" },
  { stage: "R16", n: 5, home: { pool: "C", place: 1 }, away: { thirds: ["A", "E", "F"] }, date: "2027-10-24", venue: "Sydney Football Stadium" },
  { stage: "R16", n: 6, home: { pool: "D", place: 1 }, away: { thirds: ["B", "E", "F"] }, date: "2027-10-24", venue: "Docklands Stadium, Melbourne" },
  { stage: "R16", n: 7, home: { pool: "A", place: 2 }, away: { pool: "E", place: 2 }, date: "2027-10-24", venue: "Brisbane Stadium" },
  { stage: "R16", n: 8, home: { pool: "F", place: 1 }, away: { pool: "B", place: 2 }, date: "2027-10-24", venue: "Perth Stadium" },
]);

// A qualifying third from pools A-D always takes the same R16 slot (A3 plays
// C1, B3 plays D1, C3 plays A1, D3 plays B1). An E3 or F3 takes whichever of
// those slots is left vacant, per World Rugby's 15-combination permutation
// table — NOT encoded (it was not captured verbatim), so a bracket with an E3
// or F3 among the best four thirds stays unresolved until ESPN names the
// teams.
export const RWC_FIXED_THIRDS = deepFreeze({ A: 5, B: 6, C: 2, D: 4 });

// Quarter-finals onward. `date` is the local match day; `kickoff` is UTC
// where the time was published (Sydney and Melbourne are on AEDT, UTC+11, by
// then; Brisbane stays on AEST, UTC+10). Sources:
// https://scottishrugby.org/news-and-features/rugby-world-cup-2027-schedule-confirmed/ ;
// https://www.world.rugby/news/1020949/mens-rugby-world-cup-2027-schedule-revealed-with-first-tickets-available-from-18-february ;
// https://experiences.rugbyworldcup.com/rwc2027/match-schedule.
const W = (stage, n) => ({ winner: { stage, n } });
const L = (stage, n) => ({ loser: { stage, n } });
export const RWC_KNOCKOUT = deepFreeze([
  // Sat 30 Oct 16:45 Sydney time (AEDT)
  { stage: "QF", n: 1, home: W("R16", 2), away: W("R16", 4), date: "2027-10-30", kickoff: "2027-10-30T05:45:00Z", venue: "Stadium Australia, Sydney" },
  // Sat 30 Oct 18:45 AEST Brisbane = 19:45 Sydney time (AEDT)
  { stage: "QF", n: 2, home: W("R16", 1), away: W("R16", 3), date: "2027-10-30", kickoff: "2027-10-30T08:45:00Z", venue: "Brisbane Stadium" },
  // Sun 31 Oct 16:00 AEST Brisbane = 17:00 Sydney time (AEDT)
  { stage: "QF", n: 3, home: W("R16", 5), away: W("R16", 6), date: "2027-10-31", kickoff: "2027-10-31T06:00:00Z", venue: "Brisbane Stadium" },
  // Sun 31 Oct 20:00 Sydney time (AEDT)
  { stage: "QF", n: 4, home: W("R16", 7), away: W("R16", 8), date: "2027-10-31", kickoff: "2027-10-31T09:00:00Z", venue: "Stadium Australia, Sydney" },
  // Fri 5 Nov 20:00 Sydney time (AEDT)
  { stage: "SF", n: 1, home: W("QF", 1), away: W("QF", 2), date: "2027-11-05", kickoff: "2027-11-05T09:00:00Z", venue: "Stadium Australia, Sydney" },
  // Sat 6 Nov, kickoff not retrieved
  { stage: "SF", n: 2, home: W("QF", 3), away: W("QF", 4), date: "2027-11-06", kickoff: null, venue: "Stadium Australia, Sydney" },
  // Fri 12 Nov 19:45 Sydney time (AEDT)
  { stage: "BRONZE", n: 1, home: L("SF", 1), away: L("SF", 2), date: "2027-11-12", kickoff: "2027-11-12T08:45:00Z", venue: "Stadium Australia, Sydney" },
  // Sat 13 Nov 20:00 Sydney time (AEDT)
  { stage: "FINAL", n: 1, home: W("SF", 1), away: W("SF", 2), date: "2027-11-13", kickoff: "2027-11-13T09:00:00Z", venue: "Stadium Australia, Sydney" },
]);
