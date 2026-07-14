// Watchdog — did the scheduled jobs actually run?
//
// GitHub silently drops scheduled runs under load (cron drift). That froze the
// live scores on 2026-07-11 and dropped the 2026-07-12 morning digest with no
// warning. This job runs daily, checks each watched workflow had a recent
// SUCCESSFUL run, and emails ONLY when one is overdue. Silent when healthy.
//
// Scope: the data repo's own workflows (queried with the built-in GITHUB_TOKEN).
// The archive workflow lives in the app repo — watching it needs a cross-repo
// PAT (tracked as a follow-up), so it's out of v1.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { sendEmail } from "./notify.mjs";
import { teamsheetGaps } from "./generate-digests.mjs";

const execFileAsync = promisify(execFile);

// maxAgeHours = how stale the last success may be before we alarm.
// refresh runs every 15 min but drift/idle make short gaps normal; the real
// floor is the 6-hourly sweep, so 6h catches a genuine stall without noise.
export const WATCHERS = [
  { workflow: "generate-digests.yml", label: "Daily news digests", maxAgeHours: 26 },
  { workflow: "refresh-data.yml", label: "Live data refresh", maxAgeHours: 6 },
];

// Pure core: given the last-success time per workflow, decide what's overdue.
// latestByWorkflow: { [workflow]: Date | null }
export function evaluate(now, latestByWorkflow, watchers = WATCHERS) {
  const misses = [];
  for (const w of watchers) {
    const last = latestByWorkflow[w.workflow] ?? null;
    const ageHours = last ? (now.getTime() - last.getTime()) / 3600000 : null;
    if (last === null || ageHours > w.maxAgeHours) {
      misses.push({ ...w, lastSuccessAt: last, ageHours });
    }
  }
  return misses;
}

export function formatReport(misses, now) {
  const lines = [
    "Rugby Tracker watchdog — a scheduled job is overdue.",
    "",
    `Checked at ${now.toISOString()} (UTC).`,
    "",
  ];
  for (const m of misses) {
    const when =
      m.lastSuccessAt === null
        ? "no successful run found at all"
        : `last success ${m.lastSuccessAt.toISOString()} (${m.ageHours.toFixed(1)}h ago; limit ${m.maxAgeHours}h)`;
    lines.push(`• ${m.label} (${m.workflow}) — ${when}`);
  }
  lines.push(
    "",
    "Likely cause: GitHub dropped the scheduled run (cron drift). Check the",
    "Actions tab and re-run manually if needed (workflow_dispatch).",
  );
  return lines.join("\n");
}

// Squad coverage: which teams playing this week have no published teamsheet in
// nations.json, resolved to names via the fixtures. Returns null when coverage
// is complete (nothing to email). The 2026-07-14 blank-squad miss slipped
// through because nothing here checked squads — the watchdog only asked whether
// the jobs RAN. Early-week the list doubles as a "who's still to name" tracker;
// a name persisting late in the week is a real gap the pipeline failed to catch.
export function coverageReport(nations, now = new Date()) {
  const gaps = teamsheetGaps(nations?.fixtures, nations?.digests, now);
  if (!gaps.length) return null;
  const nameFor = (id) => {
    for (const f of nations?.fixtures || []) {
      if (f?.home?.id === id) return f.home.name;
      if (f?.away?.id === id) return f.away.name;
    }
    return String(id);
  };
  const enriched = gaps.map((g) => ({ team: nameFor(g.teamId), kickoff: g.kickoff }));
  const text = [
    "Rugby Tracker — teams playing within ~5 days with no published squad:",
    "",
    ...enriched.map((g) => `• ${g.team} — kickoff ${g.kickoff}: no published squad in nations.json`),
    "",
    "If a numbered XV is already out in the press, the digest pipeline missed it —",
    "check the latest generate-digests run log for “lineup in pack but NOT extracted”.",
  ].join("\n");
  return { gaps: enriched, text };
}

async function lastSuccessAt(workflow) {
  // gh uses GH_TOKEN (the workflow's GITHUB_TOKEN) in Actions.
  const { stdout } = await execFileAsync("gh", [
    "run", "list",
    "--workflow", workflow,
    "--status", "success",
    "--limit", "1",
    "--json", "createdAt",
  ]);
  const rows = JSON.parse(stdout);
  return rows.length ? new Date(rows[0].createdAt) : null;
}

async function main() {
  const now = new Date();
  const latest = {};
  for (const w of WATCHERS) {
    try {
      latest[w.workflow] = await lastSuccessAt(w.workflow);
    } catch (err) {
      console.error(`Failed to query ${w.workflow}: ${err.message}`);
      latest[w.workflow] = null; // treat an unqueryable workflow as a miss
    }
  }

  const misses = evaluate(now, latest);

  // Squad coverage runs off the committed nations.json (repo root, one level up).
  let coverage = null;
  try {
    const nations = JSON.parse(await readFile(new URL("../nations.json", import.meta.url), "utf8"));
    coverage = coverageReport(nations, now);
  } catch (err) {
    console.error(`Coverage check skipped: ${err.message}`);
  }

  if (misses.length === 0 && !coverage) {
    console.log("Watchdog: watched workflows healthy, squads covered — no email sent.");
    return;
  }

  const report = [
    misses.length ? formatReport(misses, now) : null,
    coverage ? coverage.text : null,
  ].filter(Boolean).join("\n\n———\n\n");
  console.log(report);

  const subjectBits = [];
  if (misses.length) subjectBits.push(`${misses.length} job(s) overdue`);
  if (coverage) subjectBits.push(`${coverage.gaps.length} squad gap(s)`);
  // The report is already in the log above — that's the durable record. Email is
  // best-effort: Gmail SMTP app-passwords 535 from Actions datacenter IPs (seen
  // 2026-07-12), so a send failure must not crash the watchdog or mask the gaps.
  try {
    await sendEmail({ subject: `⚠️ Rugby Tracker: ${subjectBits.join(", ")}`, text: report });
  } catch (err) {
    console.error(`::warning::alert email failed (${String(err.message).split("\n")[0]}); see report above`);
  }
}

// Only run main when invoked directly (not when imported by the test).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
