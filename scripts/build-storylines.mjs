// Fixture storylines -> storylines.json at the repo root, which the app's
// Fixtures list reads (Nico, 20 Oct 2026): for every upcoming game involving a
// tracked nation, a headline and four to six beats on the history between the
// teams, the last meeting and form, what's at stake, team and coaching news,
// and one spice angle.
//
// NOT the same thing as editorial/storylines.json. That file is the digests'
// quiet-day backlog of open questions (storylines.mjs, docs/adr/0002 in the
// app repo). This one is per fixture, built here, and published at the root
// next to fixtures.json.
//
// How a story is made:
//   1. A FACT PACK per fixture, from the repo only: fixtures.json (comp, venue,
//      kickoff in Sydney time), team-events.json + team-events-archive.json
//      (each side's form and every previous meeting the repo holds),
//      rankings.json (each side's rank, how it got there, and what every
//      result would do to it: rankings-stakes.mjs does the arithmetic so
//      the writer never does), nations.json's log for an rnc-* game, and the news:
//      editorial/news-pool.json items whose TITLE names either team, plus the
//      digests' search widener (fetchTeamNews, one query per fixture). Rugby
//      league is dropped (dropLeague), so are women's / age-grade / sevens
//      headlines, and anything published more than BACKGROUND_DAYS ago is
//      marked BACKGROUND: history, never news.
//   2. The WRITER role (model-router.mjs: Haiku 5.5, Gemini fallback) writes
//      the story from the pack only and names the news items it used.
//   3. The CHECKER role fact-checks the draft against the same pack, with the
//      digests' rules (only material errors fail; the league rule is the same
//      text, LEAGUE_CHECK_RULE) plus two of its own: a BACKGROUND item told
//      as current fails, and so does a head-to-head total the pack doesn't
//      print. One revision, then the story is dropped (a previous checked
//      story for the same game is kept).
//
// Cost control. Each story stores two hashes: `factsHash` (fixture, form,
// meetings, rankings, log) and `packHash` (that plus the news list). Nothing is
// called while the facts are unchanged and the story is under
// NEWS_REFRESH_HOURS old; past that the widener runs and the story is
// rewritten only if the pack hash moved. A changed fact (a result, a
// ranking, a moved kickoff) rewrites at once. The file is written only when a
// story changes or a game leaves the window (played, or gone from
// fixtures.json), so `updatedAt` is the last change, not the last run.
//
// A failure anywhere is log-only (the workflow step is continue-on-error):
// storylines are a nice-to-have on top of the fixture list, never a reason to
// fail the digests.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TEAM_ALIASES, dropLeague, mentionsTeam, titleSimilarity } from "./news-sources.mjs";
import { unwrapRedirect } from "./novelty.mjs";
import { correctedKickoffMs } from "./kickoff-overrides.mjs";
import { applyHostOverrides } from "./host-overrides.mjs";
import { stakesFor, rankTrajectory, renderStakes, renderTrajectory, ordinal } from "./rankings-stakes.mjs";
import { bannedCopyIn, words } from "./copy-rules.mjs";
import { ROLES, REQUEST_TIMEOUT_MS, modelPlan, buildCallers, describePlan } from "./model-router.mjs";
import {
  TEAMS, LEAGUE_CHECK_RULE, extractJson, parseVerdict, htmlToText,
  fetchTeamNews, fetchWithTimeout, geminiCall, geminiUsage, GEMINI_MODEL,
} from "./generate-digests.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const OUT_FILE = join(ROOT, "storylines.json");
export const SCHEMA_VERSION = 1;

export const WINDOW_DAYS = 14;
export const BACKGROUND_DAYS = 10;
export const NEWS_REFRESH_HOURS = 18;
export const HEADLINE_MAX = 60;
export const BEATS_MIN = 4;
export const BEATS_MAX = 6;
export const MAX_WORDS = 190; // the approved sample is ~140
const BEAT_MAX_CHARS = 320;
const MAX_NEWS = 12;
const MAX_BACKGROUND = 4;
const MAX_BODIES = 3;
const BODY_CHARS = 1800;
const MAX_MEETINGS = 6;
const FORM_GAMES = 5;
export const MAX_GENERATE = 12; // a run's ceiling on stories written

const DAY = 86_400_000;
const HOUR = 3_600_000;

// api-sports id -> code, code -> id and code -> name, from the digests' team table.
const CODE_TO_ID = Object.fromEntries(Object.entries(TEAMS).map(([id, t]) => [t.code, Number(id)]));
const ID_TO_CODE = Object.fromEntries(Object.entries(TEAMS).map(([id, t]) => [Number(id), t.code]));
const CODE_TO_NAME = Object.fromEntries(Object.values(TEAMS).map((t) => [t.code, t.name]));

export const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

// ---- the window --------------------------------------------------------------

// Has the game started or finished? Read off the row as fixtures.json prints
// it: a score on either side, a live status, or a corrected kickoff in the past.
export function isPlayedOrUnderway(f, now) {
  if (f.homeScore != null || f.awayScore != null) return true;
  if (f.status?.live) return true;
  return correctedKickoffMs(f) <= now;
}

// Every fixtures.json row with a tracked side, both sides known, not started,
// kicking off within WINDOW_DAYS. Sorted by kickoff.
export function upcomingFixtures(fixtures, now = Date.now(), days = WINDOW_DAYS) {
  return (fixtures ?? [])
    .filter((f) => f?.id && f.home?.code && f.away?.code && f.home?.name && f.away?.name)
    .filter((f) => f.home.tracked || f.away.tracked)
    .filter((f) => !isPlayedOrUnderway(f, now))
    .filter((f) => correctedKickoffMs(f) - now <= days * DAY)
    .sort((a, b) => correctedKickoffMs(a) - correctedKickoffMs(b));
}

// "Sat 24 Oct 2026, 4:50 pm Sydney time"
export function sydneyKickoff(iso, timeTBC = false) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", weekday: "short", day: "numeric", month: "short", year: "numeric",
  }).format(d).replace(/,/g, "");
  if (timeTBC) return `${day}, time TBC`;
  const time = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(d).replace(/\s/g, " ");
  return `${day}, ${time} Sydney time`;
}

const utcDay = (iso) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
};

// ---- the fact pack -------------------------------------------------------------

const teamsOf = (teamEvents) => teamEvents?.teams ?? {};

// One team's form before `beforeMs`: the last FORM_GAMES results, newest
// first, the current run of results, and the calendar-year record. Counted in
// code so the writer never has to count.
export function teamForm(teamEvents, code, beforeMs) {
  const last = (teamsOf(teamEvents)[code]?.last ?? [])
    .filter((g) => g.us != null && g.them != null && Date.parse(g.date) < beforeMs)
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const results = last.slice(0, FORM_GAMES).map((g) => ({
    date: utcDay(g.date),
    opponent: g.opponent,
    side: g.neutral === true ? "neutral venue" : g.homeAway === "H" ? "home" : "away",
    score: `${g.us}–${g.them}`,
    result: g.result,
    league: g.league ?? null,
    tries: Number.isInteger(g.tries) ? g.tries : null,
  }));
  let streak = null;
  if (last.length) {
    const r = last[0].result;
    let n = 0;
    while (n < last.length && last[n].result === r) n++;
    streak = { result: r, games: n, complete: n < last.length };
  }
  const year = new Date(beforeMs).getUTCFullYear();
  const thisYear = last.filter((g) => new Date(g.date).getUTCFullYear() === year);
  const tally = (res) => thisYear.filter((g) => g.result === res).length;
  return {
    results,
    streak,
    year: { year, played: thisYear.length, W: tally("W"), D: tally("D"), L: tally("L") },
    // team-events.json keeps a rolling last-10, so the year record is only
    // complete when the window reaches back past 1 January.
    yearComplete: last.length < 10 || new Date(last[last.length - 1].date).getUTCFullYear() < year,
  };
}

// Every previous meeting the repo holds, from either side's last-10 and the
// archive, one row per game (deduped by UTC day), newest first, written from
// the host's side. `hosted` is the team-events homeAway; host-overrides.mjs
// corrects the vendor where it lists the wrong home side, and marks a final
// on neutral ground (`neutral`, with the venue) so it is told as neither
// side's home game.
export function previousMeetings({ teamEvents, archive, home, away, names, beforeMs }) {
  const rows = [];
  const add = (code, g) => {
    if (!g || g.us == null || g.them == null) return;
    const opp = code === home ? away : home;
    if (g.opponentCode !== opp) return;
    if (!(Date.parse(g.date) < beforeMs)) return;
    rows.push({ code, g });
  };
  for (const code of [home, away]) {
    for (const g of teamsOf(teamEvents)[code]?.last ?? []) add(code, g);
    for (const g of Object.values(archive?.games?.[code] ?? {})) add(code, g);
  }
  const byDay = new Map();
  for (const { code, g } of rows) {
    const day = utcDay(g.date);
    if (!day || byDay.has(day)) continue;
    const opp = code === home ? away : home;
    const hostCode = g.homeAway === "H" ? code : opp;
    const visitorCode = hostCode === code ? opp : code;
    const hostScore = hostCode === code ? g.us : g.them;
    const visitorScore = hostCode === code ? g.them : g.us;
    byDay.set(day, {
      date: day,
      league: g.league ?? null,
      neutral: g.neutral === true,
      host: g.neutral === true ? null : names[hostCode],
      visitor: g.neutral === true ? null : names[visitorCode],
      score: `${names[hostCode]} ${hostScore}–${visitorScore} ${names[visitorCode]}`,
      winner: hostScore === visitorScore ? null : names[hostScore > visitorScore ? hostCode : visitorCode],
      ...(g.venue ? { venue: g.venue } : {}),
    });
  }
  return [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_MEETINGS);
}

// Each side's next game after this one: part of "what's at stake".
export function nextAfter(teamEvents, code, kickoffMs) {
  const g = (teamsOf(teamEvents)[code]?.next ?? [])
    .filter((n) => Date.parse(n.date) > kickoffMs + 6 * HOUR)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))[0];
  return g ? { date: utcDay(g.date), opponent: g.opponent, side: g.homeAway === "H" ? "home" : "away", league: g.league ?? null } : null;
}

export function rankingsFor(rankings, home, away) {
  const r = rankings?.rankings ?? {};
  const one = (c) => (r[c] ? { rank: r[c].rank, points: r[c].points } : null);
  if (!r[home] && !r[away]) return null;
  return { asOf: rankings.asOf ?? null, [home]: one(home), [away]: one(away) };
}

// Nations Championship log rows for both sides, only for an rnc-* game.
export function logFor(nations, comp, home, away) {
  if (!String(comp?.key ?? "").startsWith("rnc-")) return null;
  const rows = {};
  for (const row of nations?.log ?? []) {
    const code = ID_TO_CODE[row.id];
    if (code === home || code === away) {
      rows[code] = { rank: row.rank, P: row.P, W: row.W, D: row.D, L: row.L, PD: row.PD, Pts: row.Pts };
    }
  }
  return Object.keys(rows).length ? rows : null;
}

// The whole Nations Championship table, only for an rnc-* game, so "what's
// at stake" can say who a win catches. Six pool rounds, then a finals
// weekend that pairs the table's neighbours (1st v 2nd and so on).
export const RNC_POOL_ROUNDS = 6;
export function logTable(nations, comp) {
  if (!String(comp?.key ?? "").startsWith("rnc-")) return null;
  const rows = (nations?.log ?? [])
    .map((row) => ({ rank: row.rank, code: ID_TO_CODE[row.id] ?? null, team: row.team, P: row.P, W: row.W, D: row.D, L: row.L, PD: row.PD, Pts: row.Pts }))
    .sort((a, b) => a.rank - b.rank);
  return rows.length ? rows : null;
}

// Women's, age-grade, sevens and other non-test headlines. The app is men's
// internationals; a fixture story has no business with these at all.
const NON_SENIOR = /\b(women'?s?|wxv|black ferns|wallaroos|red roses|sevens|7s|u-?\d{2}s?|under[- ]?\d{2}|youth|schools?|deaf|academy)\b/i;

const aliasesFor = (code, name) => TEAM_ALIASES[CODE_TO_ID[code]] ?? [name];

const itemMs = (i) => {
  const t = Date.parse(i?.date ?? "");
  if (Number.isFinite(t)) return t;
  const s = Date.parse(i?.firstSeen ?? "");
  return Number.isFinite(s) ? s : NaN;
};

// News items about this fixture: TITLE names either team, no league, no
// women's/age-grade/sevens, deduped (same url, or a near-identical title). Items naming both teams come first, then
// current before background, newest first. Older than BACKGROUND_DAYS (or
// undated) is BACKGROUND.
export function newsFor(items, { home, away, names, now = Date.now() }) {
  const aH = aliasesFor(home, names[home]);
  const aA = aliasesFor(away, names[away]);
  const seen = [];
  const out = [];
  for (const i of dropLeague(items ?? [])) {
    if (!i?.title || !i?.link) continue;
    if (NON_SENIOR.test(`${i.title} ${i.desc ?? ""}`)) continue;
    const about = [mentionsTeam(i.title, aH) && home, mentionsTeam(i.title, aA) && away].filter(Boolean);
    if (!about.length) continue;
    const url = unwrapRedirect(i.link);
    // Near-identical titles only: sameHeadline's looser overlap rule would
    // merge any two stories that both name the two teams.
    if (seen.some((s) => s.url === url || titleSimilarity(s.title, i.title) >= 0.6)) continue;
    seen.push({ url, title: i.title });
    const t = itemMs(i);
    const ageDays = Number.isFinite(t) ? (now - t) / DAY : null;
    out.push({
      title: i.title,
      url,
      outlet: i.feedName ?? null,
      published: Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null,
      background: ageDays == null || ageDays > BACKGROUND_DAYS,
      about,
      desc: String(i.desc ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
      _ms: Number.isFinite(t) ? t : 0,
    });
  }
  out.sort((a, b) =>
    (b.about.length - a.about.length) || (Number(a.background) - Number(b.background)) || (b._ms - a._ms));
  const current = out.filter((n) => !n.background);
  const background = out.filter((n) => n.background).slice(0, MAX_BACKGROUND);
  return [...current, ...background]
    .sort((a, b) => (b.about.length - a.about.length) || (Number(a.background) - Number(b.background)) || (b._ms - a._ms))
    .slice(0, MAX_NEWS)
    .map(({ _ms, ...n }) => n);
}

// The whole pack for one fixture. Pure: every input is passed in.
export function buildPack(fixture, { teamEvents, archive, rankings, nations, newsItems = [], now = Date.now() }) {
  const home = fixture.home.code;
  const away = fixture.away.code;
  const names = { [home]: fixture.home.name, [away]: fixture.away.name };
  const kickoffMs = correctedKickoffMs(fixture);
  const kickoff = new Date(kickoffMs).toISOString();
  return {
    fixture: {
      id: fixture.id,
      home: { code: home, name: names[home], tracked: !!fixture.home.tracked },
      away: { code: away, name: names[away], tracked: !!fixture.away.tracked },
      kickoff,
      kickoffSydney: sydneyKickoff(kickoff, fixture.timeTBC),
      comp: fixture.comp ? { key: fixture.comp.key, label: fixture.comp.label, kind: fixture.comp.kind } : null,
      venue: fixture.venue ?? null,
      ...(fixture.series ? { series: fixture.series } : {}),
    },
    rankings: rankingsFor(rankings, home, away),
    stakes: stakesFor(rankings, home, away, { worldCup: String(fixture.comp?.key ?? "").startsWith("rwc-") }),
    trajectory: { [home]: rankTrajectory(rankings, home), [away]: rankTrajectory(rankings, away) },
    log: logFor(nations, fixture.comp, home, away),
    table: logTable(nations, fixture.comp),
    form: {
      [home]: fixture.home.tracked ? teamForm(teamEvents, home, kickoffMs) : null,
      [away]: fixture.away.tracked ? teamForm(teamEvents, away, kickoffMs) : null,
    },
    meetings: previousMeetings({ teamEvents, archive, home, away, names, beforeMs: kickoffMs }),
    next: { [home]: nextAfter(teamEvents, home, kickoffMs), [away]: nextAfter(teamEvents, away, kickoffMs) },
    news: newsFor(newsItems, { home, away, names, now }),
  };
}

// Stable JSON: sorted keys, so a hash depends on content and never on order.
export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

// factsHash: everything but the news. packHash: that plus the news, by url,
// title and background flag only (a reworded snippet is not a new story).
export function packHashes(pack) {
  const { news, ...facts } = pack;
  const factsHash = sha256(stableStringify(facts)).slice(0, 16);
  const newsKey = (news ?? []).map((n) => ({ url: n.url, title: n.title, background: n.background }))
    .sort((a, b) => a.url.localeCompare(b.url));
  return { factsHash, packHash: sha256(`${factsHash}|${stableStringify(newsKey)}`).slice(0, 16) };
}

// The pack as the writer and checker read it.
export function renderPack(pack, bodies = []) {
  const f = pack.fixture;
  const H = f.home.code;
  const A = f.away.code;
  const nm = { [H]: f.home.name, [A]: f.away.name };
  const L = [];
  L.push(`## The fixture (trusted app data)`);
  L.push(`- ${f.home.name} v ${f.away.name} — ${f.home.name} are the home side.`);
  L.push(`- Kickoff: ${f.kickoffSydney}.`);
  if (f.venue) L.push(`- Venue: ${f.venue}.`);
  if (f.comp) L.push(`- Competition: ${f.comp.kind === "test" ? "a one-off test" : f.comp.label}${f.series ? ` (game ${f.series.game} of ${f.series.of})` : ""}.`);
  if (pack.rankings) {
    const r = (c) => {
      if (!pack.rankings[c]) return `${nm[c]} unranked in our table`;
      const tr = pack.trajectory?.[c] ? renderTrajectory(pack.trajectory[c]) : null;
      return `${nm[c]} ${tr ?? `${ordinal(pack.rankings[c].rank)} (${pack.rankings[c].points} pts)`}`;
    };
    L.push(`- World Rugby rankings${pack.rankings.asOf ? ` (as of ${pack.rankings.asOf})` : ""}: ${r(H)}; ${r(A)}.`);
  }
  if (pack.log) {
    for (const c of [H, A]) {
      const x = pack.log[c];
      if (x) L.push(`- Nations Championship log: ${nm[c]} ${ordinal(x.rank)} of 12, P${x.P} W${x.W} D${x.D} L${x.L}, ${x.Pts} pts, PD ${x.PD}.`);
    }
  }
  if (pack.stakes) {
    L.push("");
    L.push(`## Rankings at stake (trusted; computed from the table with World Rugby's formula — use these numbers as they are)`);
    L.push(`Assumes no other result moves either side first. A side that falls below the lowest nation in this table could also be passed by nations the app does not track, so its new rank reads "at best".`);
    L.push(...renderStakes(pack.stakes, { ...CODE_TO_NAME, ...nm }));
  }
  if (pack.table) {
    const played = Math.max(0, ...pack.table.map((r) => r.P ?? 0));
    L.push("");
    L.push(`## Nations Championship table (trusted; after ${played} of ${RNC_POOL_ROUNDS} pool rounds, then a finals weekend pairing 1st v 2nd, 3rd v 4th and so on)`);
    for (const r of pack.table) {
      const mark = r.code === H || r.code === A ? " ←" : "";
      L.push(`- ${r.rank}. ${r.team}: P${r.P} W${r.W} D${r.D} L${r.L}, PD ${r.PD}, ${r.Pts} pts${mark}`);
    }
    for (const c of [H, A]) {
      const me = pack.table.find((r) => r.code === c);
      if (!me) continue;
      const above = pack.table.find((r) => r.rank === me.rank - 1);
      const below = pack.table.find((r) => r.rank === me.rank + 1);
      const parts = [];
      if (above) parts.push(`${above.Pts - me.Pts} point${above.Pts - me.Pts === 1 ? "" : "s"} behind ${above.team} (${ordinal(above.rank)})`);
      if (below) parts.push(`${me.Pts - below.Pts} point${me.Pts - below.Pts === 1 ? "" : "s"} ahead of ${below.team} (${ordinal(below.rank)})`);
      if (parts.length) L.push(`- ${nm[c]}: ${parts.join(", ")}. A win is 4 points, a draw 2, plus a bonus point for four tries or a loss by seven or fewer.`);
    }
  }
  L.push("");
  L.push(`## Previous meetings held in the app (trusted; NOT a complete head-to-head)`);
  if (pack.meetings.length) {
    pack.meetings.forEach((m, i) => {
      const weeks = i === 0 ? Math.round((Date.parse(pack.fixture.kickoff) - Date.parse(m.date)) / (7 * DAY)) : null;
      const ago = weeks != null && weeks >= 1 && weeks <= 52 ? ` (${weeks} week${weeks === 1 ? "" : "s"} before this game)` : "";
      const where = m.neutral ? `; neutral venue${m.venue ? ` (${m.venue})` : ""}, neither side at home` : `${m.venue ? `, ${m.venue}` : ""}; ${m.host} were at home`;
      L.push(`- ${m.date}${ago}: ${m.score}${m.league ? ` (${m.league})` : ""}${where}.`);
    });
  } else L.push("- none in the app's records");
  L.push("");
  L.push(`## Form (trusted and complete for the dates it covers; counted for you, do not recount)`);
  for (const c of [H, A]) {
    const fm = pack.form[c];
    if (!fm) { L.push(`- ${nm[c]}: no form data (not a tracked nation)`); continue; }
    const s = streakText(fm.streak);
    const y = fm.year.played ? `; ${fm.year.year} so far: won ${fm.year.W} of ${fm.year.played}${fm.yearComplete ? "" : " (of the games on record; may be incomplete)"}` : "";
    L.push(`- ${nm[c]}: ${s}${y}. Most recent first:`);
    for (const g of fm.results) L.push(`  - ${g.date} ${g.result} ${g.score} v ${g.opponent} (${g.side}${g.league ? `, ${g.league}` : ""}${g.tries != null ? `, ${g.tries} ${g.tries === 1 ? "try" : "tries"}` : ""})`);
  }
  L.push("");
  L.push(`## After this game (trusted)`);
  for (const c of [H, A]) {
    const n = pack.next[c];
    L.push(`- ${nm[c]}: ${n ? `${n.opponent} (${n.side}) on ${n.date}${n.league ? `, ${n.league}` : ""}` : "nothing scheduled in the app"}`);
  }
  L.push("");
  L.push(`## News items (numbered; cite by number)`);
  L.push(`CURRENT = published within ${BACKGROUND_DAYS} days. BACKGROUND = older: usable only as dated history ("in July"), never as this week's news.`);
  if (!pack.news.length) L.push("- no news items about either team");
  pack.news.forEach((n, i) => {
    L.push(`[${i + 1}] ${n.background ? "BACKGROUND" : "CURRENT"} ${n.published ?? "undated"} · ${n.outlet ?? "web"} · ${n.title}`);
    if (n.desc) L.push(`    ${n.desc}`);
  });
  if (bodies.length) {
    L.push("");
    L.push(`## Article text (for the numbered items above)`);
    for (const b of bodies) L.push(`### [${b.n}] ${b.title}\n${b.text}`);
  }
  return L.join("\n");
}

export function streakText(streak) {
  if (!streak) return "no results on record";
  const word = { W: ["won", "wins"], L: ["lost", "losses"], D: ["drew", "draws"] }[streak.result] ?? ["played", "games"];
  if (streak.games === 1) return `${word[0]} their last game`;
  return `${streak.complete ? "" : "at least "}${streak.games} straight ${word[1]}`;
}

// ---- prompts -------------------------------------------------------------------

// The shape and tone of the story Nico approved (20 Oct 2026), with its facts
// swapped for placeholders. The approved story was about Japan v Fiji itself,
// so its real facts in the prompt would invite the writer to copy claims (a
// 17-5 head-to-head) that no pack supports.
const SAMPLE = `{"headline": "<Coach>'s <Team> debut: a <City> rematch five weeks on",
 "beats": [
  "<Team B> own this fixture: <head-to-head total, ONLY if a news item states it>, and they beat <Team A> in <the two finals the pack lists>.",
  "Then came <date of last meeting>, on this same ground: <the decisive moment, from a news item> and <Team A> won <score>.",
  "This is <Coach>'s first test as <Team B> coach, with <selection news from a CURRENT item>.",
  "Form favours <Team A>: three straight wins. <Team B> have won 1 of 5 this year.",
  "<What the result changes, from the computed lines: win and Team B go 9th; lose and Team A drop out of the top 12>."
 ],
 "sources": [2, 3]}`;

export function buildWriterPrompt(packText, { revision = null, previousDraft = null } = {}) {
  return `You write the pre-match STORYLINE for one fixture in Rugby Nations Tracker,
an iOS app for men's international rugby union. The reader is a knowledgeable
fan scrolling the Fixtures list. Give them the story of this game in about 140
words.

${packText}

## What to write
A headline (at most ${HEADLINE_MAX} characters) that hooks a neutral — the debut,
the rematch, the streak on the line, the ranking swing — never a label like
"Japan v Fiji preview". Then ${BEATS_MIN} to ${BEATS_MAX} beats, one or two sentences each,
${MAX_WORDS} words at most in all. Cover, in whatever order reads best, as many of
these as the pack supports:
- the history between the teams;
- the last meeting and the recent form;
- what's at stake: what the result CHANGES — a ranking place gained or lost,
  a swap, a drop out of the top 12, a table position, a series, what comes
  next. Take the numbers from "Rankings at stake" as they are; "they are 9th
  and 10th" on its own is not a stake;
- team and coaching news (CURRENT items only);
- one spice angle: a rematch, a debut, a milestone, a grudge, a streak.
Lead with the angle a fan would mention first. Be specific: a score, a date,
a name beats an adjective.

## Rules — every one is checked
- The pack above is your ONLY source. Every fact must trace to it. No outside
  knowledge, however sure you are.
- The previous meetings above are only the games the app holds. Never state a
  head-to-head total, a "first win since", or an all-time record unless a news
  item in the pack states it, and then say it as the item does.
- Each side's Form list is complete for the dates it covers. A news item that
  reports a result for either team on a date the list does not show is about
  a different team (women's, age-grade, sevens or league): ignore it.
- A meeting marked "neutral venue" was hosted by neither side; never place it
  in either country.
- Rankings arithmetic comes only from "Rankings at stake"; never recompute,
  round differently, or state a rank the lines do not give.
- Never present a BACKGROUND item as current. Use it only as dated history.
  Do not call anything "this week", "latest" or "new" unless it is CURRENT.
- Quotation marks only around words that appear inside quotation marks in the
  pack, character for character. Otherwise paraphrase without quote marks.
- Union only: ignore any rugby league story (NRL, Rugby League World Cup,
  Kumuls, Fiji Bati, Kangaroos; there is no union World Cup in 2026), and any
  women's, age-grade or sevens story.
- No clock times or time zones (the app prints the kickoff itself). Dates are fine.
- If the pack is thin, write fewer beats. Never pad, and never write about
  the coverage itself.
- Use the home/away and venue facts exactly as the pack gives them.

## Output — strict JSON, nothing else
{"headline": "<= ${HEADLINE_MAX} chars", "beats": ["...", "..."], "sources": [<numbers of the news items you used>]}

Tone and length target (an approved story with its facts replaced by
<placeholders>; fill nothing in from it):
${SAMPLE}${revision ? `

## Revise your draft
The fact-checker found these material problems. Fix every one (cut the claim
if the pack cannot support it) and return the whole story again as JSON.
Your draft:
${JSON.stringify(previousDraft)}
Problems:
${revision.map((i, n) => `${n + 1}. "${i.claim ?? ""}": ${i.problem ?? ""}${i.fix ? ` (fix: ${i.fix})` : ""}`).join("\n")}` : ""}`;
}

export function buildCheckerPrompt(packText, draft) {
  return `You are the fact-checker for a pre-match storyline in Rugby Nations Tracker,
a men's international rugby union app. Check the draft against the pack.

${packText}

## Draft
${JSON.stringify(draft, null, 2)}

## Your job
Check every factual claim in the draft against the pack. **Only material
errors fail a story** — a reader must be misinformed for you to flag it.
Material errors:
- an invented fact: anything the pack does not support, or that it contradicts;
- a wrong number, score, date, name, ranking, venue or home/away side;
- a head-to-head total, all-time record or "first since" claim that no news
  item in the pack states (the app's list of previous meetings is not
  complete, so it can never support a total);
- a result, score or opponent for either team that the Form list (complete
  for the dates it covers) does not show — that news item is about another
  team — or a meeting marked "neutral venue" placed in either country;
- a ranking, points total or rank change that differs from "Rankings at
  stake", or a rank the lines give only "at best" stated as settled;
- words inside quotation marks that are not character-for-character in the pack;
- a rumour or expectation asserted as settled fact;
- STALENESS: a BACKGROUND item (older than ${BACKGROUND_DAYS} days) presented as current
  or as this week's development, or any item told as newer than its date;
- a women's, age-grade or sevens story;
${LEAGUE_CHECK_RULE}
- a clock time or time zone in the copy.

Do NOT flag: accurate paraphrase or compression, opinion and colour,
incompleteness, or anything you would call "technically true but could be
closer to the source". Trusted app data needs no corroboration from a news
item. If ANY pack item supports a claim, it passes. The pack is the
authority: you check draft-against-pack, not pack-against-reality (except the
league rule, which fails however faithfully the draft reflects the pack).

## Output — strict JSON, nothing else
{"issues": [{"claim": "<the claim>", "problem": "<what is wrong>", "fix": "<corrected wording, or 'cut'>", "severity": "material" | "minor"}]}
When unsure, the severity is "minor". Empty issues array if the draft is clean.`;
}

// ---- validation ----------------------------------------------------------------

// Shape and copy gate. Returns a clean { headline, beats, sources } with the
// cited item numbers turned into {title, url} from the pack, so a source can
// never be a URL the model made up.
export function validateStory(raw, news = []) {
  const errors = [];
  if (!raw || typeof raw !== "object") return { ok: false, errors: ["not an object"] };
  const headline = typeof raw.headline === "string" ? raw.headline.trim() : "";
  const beats = Array.isArray(raw.beats) ? raw.beats.filter((b) => typeof b === "string").map((b) => b.trim()).filter(Boolean) : [];
  if (!headline) errors.push("no headline");
  if (headline.length > HEADLINE_MAX) errors.push(`headline ${headline.length} chars > ${HEADLINE_MAX}`);
  if (beats.length < BEATS_MIN || beats.length > BEATS_MAX) errors.push(`${beats.length} beats, want ${BEATS_MIN}-${BEATS_MAX}`);
  for (const b of beats) if (b.length > BEAT_MAX_CHARS) errors.push(`beat over ${BEAT_MAX_CHARS} chars`);
  const total = words([headline, ...beats].join(" "));
  if (total > MAX_WORDS) errors.push(`${total} words > ${MAX_WORDS}`);
  for (const t of [headline, ...beats]) {
    const bad = bannedCopyIn(t);
    if (bad) { errors.push(`banned copy: ${bad}`); break; }
  }
  const idx = [...new Set((Array.isArray(raw.sources) ? raw.sources : []).map(Number))]
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= news.length);
  const sources = idx.map((n) => ({ title: news[n - 1].title, url: news[n - 1].url }));
  return errors.length ? { ok: false, errors } : { ok: true, story: { headline, beats, sources } };
}

// ---- one story -----------------------------------------------------------------

// Write, check, at most one revision, check again. Throws when no draft
// survives; the caller keeps the previous story for the game, if any.
// `trace`, when given, is filled in as it goes (draft, gate, check, revision,
// gate, check): record only, read by the shadow run (storyline-shadow.mjs),
// and filled even when the story then fails.
export async function writeStory(calls, pack, packText, { trace = null } = {}) {
  if (!calls.writer || !calls.checker) throw new Error("no writer/checker model available");
  const note = (step, data) => trace?.push({ step, ...data });
  let raw = extractJson(await calls.writer(buildWriterPrompt(packText)));
  note("draft", { raw });
  let v = validateStory(raw, pack.news);
  note("gate", v.ok ? { ok: true } : { ok: false, errors: v.errors });
  let issues = [];
  if (v.ok) {
    const verdict = parseVerdict(extractJson(await calls.checker(buildCheckerPrompt(packText, v.story))));
    note("check", verdict);
    if (verdict.verdict === "pass") return { ...v.story, revised: false };
    issues = verdict.issues;
  } else {
    issues = v.errors.map((e) => ({ claim: "format", problem: e }));
  }
  raw = extractJson(await calls.writer(buildWriterPrompt(packText, { revision: issues, previousDraft: raw })));
  note("revision", { raw });
  v = validateStory(raw, pack.news);
  note("gate", v.ok ? { ok: true } : { ok: false, errors: v.errors });
  if (!v.ok) throw new Error(`revision failed the shape gate: ${v.errors.join("; ")}`);
  const verdict = parseVerdict(extractJson(await calls.checker(buildCheckerPrompt(packText, v.story))));
  note("check", verdict);
  if (verdict.verdict !== "pass") {
    throw new Error(`fact-check failed twice: ${verdict.issues.map((i) => i.problem).join(" | ").slice(0, 300)}`);
  }
  return { ...v.story, revised: true };
}

// ---- the run -------------------------------------------------------------------

// keep (no call at all), check (widen the news, then compare pack hashes) or
// write. `prev` is the stored story for this fixture id.
export function decide(prev, factsHash, now, refreshHours = NEWS_REFRESH_HOURS) {
  if (!prev) return "write";
  if (prev.factsHash !== factsHash) return "write";
  const age = now - Date.parse(prev.generatedAt ?? "");
  return Number.isFinite(age) && age < refreshHours * HOUR ? "keep" : "check";
}

const storyOut = (pack, s, hashes, model, now) => ({
  home: pack.fixture.home.code,
  away: pack.fixture.away.code,
  kickoff: pack.fixture.kickoff,
  headline: s.headline,
  beats: s.beats,
  sources: s.sources,
  generatedAt: new Date(now).toISOString(),
  model,
  factsHash: hashes.factsHash,
  packHash: hashes.packHash,
});

// The orchestrator. Everything with I/O is injected, so the tests run it
// offline: widen(fixture) -> extra news items; bodies(newsItems) -> [{n,title,text}];
// write(pack, packText) -> {headline, beats, sources, model}. `write` null
// means no model key: nothing new is written, played games are still dropped.
export async function buildStorylines({
  fixtures, teamEvents, archive, rankings, nations, pool = [], previous = null,
  now = Date.now(), days = WINDOW_DAYS, widen = async () => [], bodies = async () => [], write = null,
  maxGenerate = MAX_GENERATE, log = console.log,
}) {
  const prevStories = previous?.stories ?? {};
  const stories = {};
  const report = { kept: [], checked: [], written: [], failed: [], dropped: [], skipped: [] };
  const data = { teamEvents, archive, rankings, nations, now };
  let budget = maxGenerate;

  for (const f of upcomingFixtures(fixtures, now, days)) {
    const label = `${f.home.code} v ${f.away.code} (${f.id})`;
    const prev = prevStories[f.id] ?? null;
    let pack = buildPack(f, { ...data, newsItems: pool });
    const { factsHash } = packHashes(pack);
    const action = decide(prev, factsHash, now);
    if (action === "keep") {
      stories[f.id] = prev;
      report.kept.push(label);
      continue;
    }
    let extra = [];
    try {
      extra = await widen(f);
    } catch (e) {
      log(`  ${label}: search widener failed (${String(e.message).slice(0, 100)}); pool only`);
    }
    pack = buildPack(f, { ...data, newsItems: [...pool, ...extra] });
    const hashes = packHashes(pack);
    if (action === "check" && prev.packHash === hashes.packHash) {
      stories[f.id] = prev;
      report.checked.push(label);
      continue;
    }
    if (!write || budget <= 0) {
      if (prev) stories[f.id] = prev;
      report.skipped.push(label);
      continue;
    }
    budget--;
    try {
      let texts = [];
      try {
        texts = await bodies(pack.news);
      } catch {
        // snippets alone are a fine pack
      }
      const s = await write(pack, renderPack(pack, texts));
      stories[f.id] = storyOut(pack, s, hashes, s.model, now);
      report.written.push(`${label}${s.revised ? " (revised)" : ""}`);
    } catch (e) {
      if (prev) stories[f.id] = prev;
      report.failed.push(`${label}: ${String(e.message).slice(0, 200)}`);
    }
  }
  for (const id of Object.keys(prevStories)) {
    if (!(id in stories)) report.dropped.push(id);
  }
  return { stories, report };
}

// Same stories, ignoring key order: the write-only-on-change test.
export const sameStories = (a, b) => stableStringify(a ?? {}) === stableStringify(b ?? {});

export function storylinesFile(stories, now) {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: new Date(now).toISOString(), stories };
}

// Article text for the top CURRENT items, fetched only for a story being written.
export async function fetchBodies(news) {
  const out = [];
  for (const [i, n] of news.entries()) {
    if (out.length >= MAX_BODIES) break;
    if (n.background) continue;
    try {
      const res = await fetchWithTimeout(n.url);
      if (!res.ok) continue;
      const text = htmlToText(await res.text());
      if (text.length > 400) out.push({ n: i + 1, title: n.title, text: text.slice(0, BODY_CHARS) });
    } catch {
      // paywalled or slow publishers drop out
    }
  }
  return out;
}

const readJson = (p) => readFile(p, "utf8").then(JSON.parse).catch(() => null);

// The committed inputs, with the hand-confirmed hosts laid over team-events
// and the archive as the team-events writers do, so a meeting reads the right
// home side (or neutral ground) even before the next team-events run has
// rewritten the file. Quiet: those writers log it. Shared with the shadow run.
export async function loadInputs(root = ROOT) {
  const [fixturesFile, teamEvents, archive, rankings, nations, poolFile, previous] = await Promise.all([
    readJson(join(root, "fixtures.json")),
    readJson(join(root, "team-events.json")),
    readJson(join(root, "team-events-archive.json")),
    readJson(join(root, "rankings.json")),
    readJson(join(root, "nations.json")),
    readJson(join(root, "editorial", "news-pool.json")),
    readJson(join(root, "storylines.json")),
  ]);
  const quiet = () => {};
  if (teamEvents?.teams) teamEvents.teams = applyHostOverrides(teamEvents.teams, { log: quiet });
  if (archive?.games) {
    const asTeams = Object.fromEntries(Object.entries(archive.games).map(([c, g]) => [c, { last: Object.values(g) }]));
    const fixed = applyHostOverrides(asTeams, { log: quiet });
    archive.games = Object.fromEntries(Object.entries(fixed).map(([c, t]) => [c, Object.fromEntries(t.last.map((g) => [String(g.id), g]))]));
  }
  return { fixtures: fixturesFile?.fixtures ?? [], teamEvents, archive, rankings, nations, pool: poolFile?.items ?? [], previous };
}

// The storyline writer can run on its own model: the repository variable
// STORYLINE_WRITER_MODEL, when set, replaces DIGEST_WRITER_MODEL for this
// script only (the checker stays the digests'). Set after the shadow run of
// 21 Oct 2026 decides what a storyline is worth; unset, the writer role's
// default applies.
export const storylineEnv = (env = process.env) =>
  env.STORYLINE_WRITER_MODEL?.trim() ? { ...env, DIGEST_WRITER_MODEL: env.STORYLINE_WRITER_MODEL.trim() } : env;

// Narrow a fixture list to one game by fixtures.json id or HOME-AWAY codes.
export const onlyFixture = (fixtures, only) =>
  only ? fixtures.filter((f) => f.id === only || `${f.home?.code}-${f.away?.code}` === only) : fixtures;

// `force` ignores the cache and rewrites every game in the window (a hand run
// after a prompt or pack change); `days` widens the window for that run only.
export async function main({ dryRun = false, only = null, force = false, days = WINDOW_DAYS } = {}) {
  const now = Date.now();
  const loaded = await loadInputs();
  const { teamEvents, archive, rankings, nations, pool } = loaded;
  const previous = force ? null : loaded.previous;
  const fixtures = onlyFixture(loaded.fixtures, only);
  console.log(`storylines: ${upcomingFixtures(fixtures, now, days).length} fixtures in the next ${days} days, news pool ${pool.length} items${force ? " (forced rewrite)" : ""}`);

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  let write = null;
  let tally = null;
  let plan = null;
  if (dryRun) {
    write = async (pack, packText) => {
      console.log(`\n===== ${pack.fixture.home.name} v ${pack.fixture.away.name} — writer prompt (dry run, no model call) =====\n`);
      console.log(buildWriterPrompt(packText));
      throw new Error("dry run");
    };
  } else if (geminiKey || anthropicKey) {
    ({ plan } = modelPlan(storylineEnv(process.env), { gemini: !!geminiKey, anthropic: !!anthropicKey }));
    let client = null;
    if (ROLES.some((r) => plan[r] && plan[r] !== "gemini")) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
    }
    const built = await buildCallers({ plan, geminiCall: geminiKey ? (p) => geminiCall(geminiKey, p) : null, client });
    tally = built.tally;
    const { calls } = built;
    console.log(`storylines models: writer=${plan.writer}, checker=${plan.checker}${geminiKey ? ` (gemini ladder from ${GEMINI_MODEL}${client ? ", as fallback" : ""})` : ""} — ${describePlan(plan)}`);
    write = async (pack, packText) => {
      const before = tally.summary().fellBack;
      const s = await writeStory(calls, pack, packText);
      const model = plan.writer === "gemini" || tally.summary().fellBack > before ? "gemini" : plan.writer;
      return { ...s, model };
    };
  } else {
    console.log("storylines: GEMINI_API_KEY / ANTHROPIC_API_KEY not set — no new stories; played games still dropped");
  }

  const { stories, report } = await buildStorylines({
    fixtures, teamEvents, archive, rankings, nations, pool, previous, now, days,
    widen: (f) => fetchTeamNews(`${f.home.name} ${f.away.name}`),
    bodies: fetchBodies,
    write,
  });
  for (const [k, list] of Object.entries(report)) if (list.length) console.log(`  ${k}: ${list.join("; ")}`);

  if (tally) {
    const paid = tally.summary();
    const g = geminiUsage();
    console.log(
      `storylines spend: anthropic ${paid.calls} calls (${paid.fellBack} fell back), US$${paid.costUSD.toFixed(4)}` +
        (paid.rows.length ? ` — ${paid.rows.map((r) => `${r.model} in=${r.input} out=${r.output}`).join(" | ")}` : "") +
        `; gemini ${g.totalCalls} calls`,
    );
  }

  if (dryRun) return { stories, report };
  // Only on change. An absent file with nothing to say stays absent.
  const before = loaded.previous?.stories ?? {};
  if (sameStories(stories, before) && (loaded.previous || !Object.keys(stories).length)) {
    console.log("storylines.json unchanged — not written");
    return { stories, report, written: false };
  }
  // `only` narrows a hand run; never let it drop every other game's story.
  const merged = only ? { ...before, ...stories } : stories;
  await writeFile(OUT_FILE, JSON.stringify(storylinesFile(merged, now), null, 1) + "\n");
  console.log(`storylines.json written — ${Object.keys(merged).length} stories`);
  return { stories: merged, report, written: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : null;
  };
  main({
    dryRun: process.argv.includes("--dry-run"),
    only: arg("--fixture"),
    force: process.argv.includes("--force"),
    days: Number(arg("--days")) || WINDOW_DAYS,
  }).catch((e) => {
    // Log-only by design: a storyline problem must never fail the digests.
    console.error(`storylines skipped: ${e.stack ?? e}`);
  });
}
