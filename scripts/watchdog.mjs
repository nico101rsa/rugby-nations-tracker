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
import { sendEmail } from "./notify.mjs";

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
  if (misses.length === 0) {
    console.log("Watchdog: all watched workflows healthy — no email sent.");
    return;
  }

  const report = formatReport(misses, now);
  console.log(report);
  await sendEmail({
    subject: `⚠️ Rugby Tracker: ${misses.length} scheduled job(s) overdue`,
    text: report,
  });
}

// Only run main when invoked directly (not when imported by the test).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
