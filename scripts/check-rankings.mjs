// Catch a stale-but-well-formed rankings timeline (map #200).
//
// The failure this exists for: the app's "#1 for N wks" figure is COMPUTED
// against today, not stored. `leaderStats()` sets `currentSince` when a spell's
// `till` reads $now/end in Wikipedia's Template:World Rugby ranking leaders,
// and the app measures from that date to now. So the number ticks upward every
// morning on its own.
//
// If a nation loses No. 1 and the Wikipedia template lags, the app KEEPS
// COUNTING UPWARD and reports a figure that is simply wrong — for months, with
// nothing going red. The existing parse guards are structural (it throws below
// 10/12 best-worst rows), which catches a LAYOUT change and is blind to a
// timeline that is perfectly well-formed and merely out of date.
//
// The cheap mitigation: rankings.json and ranking-stats.json are produced by
// the same daily cron from two different Wikipedia pages, so they can be
// cross-checked against each other. The live table's No. 1 and the timeline's
// open-ended spell holder must be the same nation. When they disagree, the
// timeline is the stale one — the live table updates weekly, the template is
// hand-edited.
//
// Note this only sees nations we track. An untracked nation reaching No. 1
// would show up here as "no live No. 1", which is reported rather than ignored.

import { readFile } from "node:fs/promises";
import { postIssue } from "./notify.mjs";

// Pure core: the two published files -> a problem description, or null.
export function checkNo1(rankings, stats) {
  const table = rankings?.rankings ?? {};
  const teams = stats?.teams ?? {};

  const live = Object.entries(table)
    .filter(([, v]) => v?.rank === 1)
    .map(([code]) => code);

  // `no1` is null for nations that have never held it — not a fault.
  const holders = Object.entries(teams)
    .filter(([, v]) => (v?.no1 ?? {}).currentSince)
    .map(([code, v]) => ({ code, since: v.no1.currentSince }));

  if (live.length !== 1) {
    return {
      kind: "no-live-no1",
      title: `World rankings: ${live.length === 0 ? "no" : "more than one"} team at No. 1`,
      detail:
        `rankings.json lists ${live.length} nation(s) at rank 1${live.length ? ` (${live.join(", ")})` : ""}.\n\n` +
        `Exactly one is expected. Either the Wikipedia rankings table changed shape, or an ` +
        `UNTRACKED nation now holds No. 1 — we only carry the 12, so a 13th nation topping the ` +
        `table looks like an empty result from here.`,
    };
  }

  if (holders.length === 0) {
    return {
      kind: "no-current-holder",
      title: "World rankings: the No. 1 timeline has no open spell",
      detail:
        `rankings.json says **${live[0]}** is No. 1, but no nation in ranking-stats.json has an ` +
        `open-ended spell (\`currentSince\`).\n\n` +
        `That means Template:World Rugby ranking leaders has closed every spell with a date. The ` +
        `app's "#1 for N wks" line goes quiet rather than wrong, so this is the benign direction — ` +
        `but it still means the timeline is not tracking the live table.`,
    };
  }

  if (holders.length > 1) {
    return {
      kind: "multiple-holders",
      title: "World rankings: more than one open No. 1 spell",
      detail:
        `${holders.map((h) => `${h.code} (since ${h.since})`).join(", ")} all have an open spell in ` +
        `ranking-stats.json. Only one nation can currently hold No. 1, so this is a parse fault in ` +
        `fetch-ranking-stats.mjs rather than a data lag.`,
    };
  }

  const holder = holders[0];
  if (holder.code !== live[0]) {
    return {
      kind: "stale-timeline",
      title: `World rankings: timeline still has ${holder.code} at No. 1, live table says ${live[0]}`,
      detail:
        `**This is the failure the check exists for, and the app is currently reporting a wrong number.**\n\n` +
        `- rankings.json (live table): **${live[0]}** is No. 1\n` +
        `- ranking-stats.json (timeline): **${holder.code}** has an open spell since ${holder.since}\n\n` +
        `Because the app computes "#1 for N wks" from \`currentSince\` **against today**, ${holder.code}'s ` +
        `streak is still ticking upward on the Team page even though they no longer hold the ranking. ` +
        `It will keep doing so until Template:World Rugby ranking leaders is edited to close the spell.\n\n` +
        `Both files come from the same daily cron (\`rankings.yml\`); the live table updates weekly and ` +
        `the template is hand-edited, so the template is the stale side.\n\n` +
        `Keep any copy fix **streak-first** — longest streak plus its span, never a cumulative total.`,
    };
  }

  return null;
}

// --- the 22 Aug 2026 gap: the WHOLE table can be stale, not just the timeline ---
//
// checkNo1 compares two Wikipedia sources against each other, so when BOTH lag
// a result they agree and it passes. That is exactly what happened when NZ took
// No. 1 off SA at Ellis Park: for two days the app kept showing SA "#1 for 49
// wks" and nothing went red. Two independent signals close that hole.

// Last calendar year mentioned in a "2003, 2004–07, 2025–26" years string
// (same convention as the app's team-page.js). A trailing range ends in the
// LATER year, and a two-digit end borrows the start's century.
export function lastYearIn(years) {
  const m = String(years ?? "").match(/(\d{4})(?:[–-](\d{4}|\d{2}))?\s*$/);
  if (!m) return null;
  if (!m[2]) return Number(m[1]);
  if (m[2].length === 4) return Number(m[2]);
  const from = Number(m[1]);
  const till = Math.floor(from / 100) * 100 + Number(m[2]);
  return till < from ? till + 100 : till;
}

// Signal 1: Wikipedia's "best and worst" section credits a nation with No. 1
// in a year the leaders timeline doesn't know about. The best/worst table was
// edited overnight after the Ellis Park test (NZ's best years gained "2026")
// while the timeline and the live table both still lagged — so the fastest
// hand-edited section can vouch for the slower two.
export function checkYearsAgree(stats) {
  for (const [code, team] of Object.entries(stats?.teams ?? {})) {
    const credited = team?.best?.rank === 1 ? lastYearIn(team.best.years) : null;
    const latest = team?.no1?.latestYear;
    if (credited == null || latest == null || latest === 0) continue;
    if (credited > latest) {
      return {
        kind: "years-ahead-of-timeline",
        title: `World rankings: best-years section credits ${code} with No. 1 in ${credited}, timeline stops at ${latest}`,
        detail:
          `Wikipedia's "best and worst" section says **${code}** reached No. 1 in ${credited}, but the ` +
          `ranking-leaders timeline has no ${code} spell past ${latest}.\n\n` +
          `The best/worst section is usually the FIRST to be edited after the top spot changes hands ` +
          `(seen 23 Aug 2026, the morning after NZ beat SA at Ellis Park), so the live table and the ` +
          `timeline are probably both stale — meaning the app's No. 1 badge and "#1 for N wks" figure ` +
          `may be wrong RIGHT NOW. Check world.rugby and hand-correct rankings.json / ` +
          `ranking-stats.json if the nightly refresh hasn't caught up.`,
      };
    }
  }
  return null;
}

// Signal 2: a result the table cannot have ignored. When the loser of a
// finished test was ranked ABOVE the winner in our own table (an upset by the
// table's own ordering — a draw across a rank gap counts too), World Rugby's
// formula guarantees a points exchange, so the table's "as of" date MUST move
// past that match. Favourite wins are excluded on purpose: they can exchange
// zero points (SA beat ARG on 8 Aug 2026 and the table legitimately stayed
// "as of 20 July"), so they prove nothing about freshness.
const GRACE_DAYS = 4; // result Sat -> official update Mon -> a day for editors

export function checkTableFreshness(rankings, teamEvents, asOfTime, now = Date.now()) {
  if (asOfTime == null) return null;
  const table = rankings?.rankings ?? {};
  const upsets = [];
  for (const [code, entry] of Object.entries(teamEvents?.teams ?? {})) {
    for (const g of entry?.last ?? []) {
      if (g?.us == null || g?.them == null) continue;
      const mine = table[code]?.rank;
      const theirs = table[g.opponentCode]?.rank;
      if (mine == null || theirs == null || mine === theirs) continue;
      const t = new Date(g.date).getTime();
      if (!(t > asOfTime) || now - t < GRACE_DAYS * 86400000) continue;
      const upset = (g.us < g.them && mine < theirs) || (g.us === g.them);
      if (upset) upsets.push({ code, opponentCode: g.opponentCode, date: g.date.slice(0, 10), us: g.us, them: g.them });
    }
  }
  if (!upsets.length) return null;
  const u = upsets.reduce((a, b) => (a.date > b.date ? a : b));
  return {
    kind: "stale-table",
    title: `World rankings: live table predates ${u.code} ${u.us}–${u.them} ${u.opponentCode} (${u.date})`,
    detail:
      `rankings.json is still "as of ${rankings?.asOf}", but on ${u.date} **${u.opponentCode}** ` +
      `${u.us === u.them ? "drew with" : "beat"} higher-ranked **${u.code}** ${u.us}–${u.them}. An upset by the ` +
      `table's own ordering always exchanges ranking points, so a fresh table would carry a later ` +
      `"as of" date by now (${GRACE_DAYS}-day grace already allowed).\n\n` +
      `Wikipedia's Template:World_Rugby_Rankings is lagging the real rankings — every rank, points ` +
      `figure and the No. 1 badge in the app may be out of date. Check world.rugby and hand-correct ` +
      `rankings.json / ranking-stats.json if the nightly refresh hasn't caught up.` +
      (upsets.length > 1 ? `\n\nUnreflected upsets/draws seen: ${upsets.map((x) => `${x.code} ${x.us}–${x.them} ${x.opponentCode} (${x.date})`).join(", ")}.` : ""),
  };
}

async function main() {
  const [rankings, stats] = await Promise.all([
    readFile("rankings.json", "utf8").then(JSON.parse),
    readFile("ranking-stats.json", "utf8").then(JSON.parse),
  ]);
  // team-events.json is built by its own cron; a missing/broken copy must not
  // take the No. 1 cross-check down with it.
  const teamEvents = await readFile("team-events.json", "utf8").then(JSON.parse).catch(() => null);

  const { parseAsOfDate } = await import("./fetch-rankings.mjs");
  const problems = [
    checkNo1(rankings, stats),
    checkYearsAgree(stats),
    checkTableFreshness(rankings, teamEvents, parseAsOfDate(rankings?.asOf)),
  ].filter(Boolean);

  if (!problems.length) {
    const live = Object.entries(rankings.rankings).find(([, v]) => v.rank === 1)?.[0];
    console.log(`Rankings consistent — ${live} is No. 1, and the table looks current.`);
    return;
  }

  // Don't refile the same problem every night for as long as it holds.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let open = new Set();
  try {
    const { stdout } = await execFileAsync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "title"]);
    open = new Set(JSON.parse(stdout).map((i) => i.title));
  } catch { /* no gh: risk a duplicate rather than going silent */ }

  for (const problem of problems) {
    console.log(`::warning::${problem.kind} — ${problem.title}`);
    console.log(problem.detail);
    if (open.has(problem.title)) {
      console.log("An open issue already says this — not filing a duplicate.");
      continue;
    }
    await postIssue({
      title: problem.title,
      body: `${problem.detail}\n\n---\nRaised automatically by \`scripts/check-rankings.mjs\` (map #200).`,
    });
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
