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

async function main() {
  const [rankings, stats] = await Promise.all([
    readFile("rankings.json", "utf8").then(JSON.parse),
    readFile("ranking-stats.json", "utf8").then(JSON.parse),
  ]);

  const problem = checkNo1(rankings, stats);
  if (!problem) {
    const live = Object.entries(rankings.rankings).find(([, v]) => v.rank === 1)?.[0];
    console.log(`Rankings consistent — ${live} is No. 1 in both the live table and the timeline.`);
    return;
  }

  console.log(`::warning::${problem.kind} — ${problem.title}`);
  console.log(problem.detail);

  // Don't refile the same problem every night for as long as it holds.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  let open = new Set();
  try {
    const { stdout } = await execFileAsync("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "title"]);
    open = new Set(JSON.parse(stdout).map((i) => i.title));
  } catch { /* no gh: risk a duplicate rather than going silent */ }
  if (open.has(problem.title)) {
    console.log("An open issue already says this — not filing a duplicate.");
    return;
  }
  await postIssue({
    title: problem.title,
    body: `${problem.detail}\n\n---\nRaised automatically by \`scripts/check-rankings.mjs\` (map #200).`,
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
