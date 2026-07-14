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

// ---- GitHub-issue alerting ---------------------------------------------------
//
// Email is dead: Gmail SMTP app-passwords are rejected (535 BadCredentials) from
// Actions datacenter IPs — the 2026-07-12 weekly-health run proved it, and the
// 2026-07-14 blank-squad miss went unnoticed partly because nothing could reach
// Nico. So the alert channel is a GitHub issue, opened with the built-in
// GITHUB_TOKEN (no secrets to manage). GitHub's own notification mail already
// routes to the Outlook "iOS App" folder.
//
// One long-lived issue, kept current rather than re-opened daily: the signature
// below encodes the exact alert state, so an unchanged state is a no-op (no
// daily ping) and a recovery closes the issue.
export const ALERT_TITLE = "⚠️ Rugby Tracker ops alert";

export function alertSignature(misses = [], coverage = null) {
  const jobs = misses.map((m) => m.workflow).sort().join(",");
  const squads = coverage ? coverage.gaps.map((g) => g.team).sort().join(",") : "";
  return `jobs=[${jobs}] squads=[${squads}]`;
}

export function decideIssueAction(existing, signature, healthy) {
  if (healthy) return existing ? "close" : "noop";
  if (!existing) return "create";
  return existing.body?.includes(signature) ? "noop" : "update";
}

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args);
  return stdout;
}

async function findAlertIssue() {
  const rows = JSON.parse(await gh(["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body"]));
  return rows.find((r) => r.title === ALERT_TITLE) ?? null;
}

// Post/refresh/close the alert issue. Best-effort: an alerting failure must not
// fail the watchdog — the report is already in the run log either way.
export async function syncAlertIssue(report, signature, healthy) {
  const existing = await findAlertIssue();
  const action = decideIssueAction(existing, signature, healthy);
  const body = `${report}\n\n_Updated ${new Date().toISOString()} by the watchdog._\n<!-- sig: ${signature} -->`;

  if (action === "noop") {
    console.log(`Alert issue: no change (${healthy ? "healthy" : "same state already reported"}).`);
    return action;
  }
  if (action === "create") {
    const url = (await gh(["issue", "create", "--title", ALERT_TITLE, "--body", body])).trim();
    console.log(`Alert issue opened: ${url}`);
  } else if (action === "update") {
    const n = String(existing.number);
    await gh(["issue", "edit", n, "--body", body]);
    await gh(["issue", "comment", n, "--body", `State changed:\n\n${report}`]);
    console.log(`Alert issue #${n} updated.`);
  } else if (action === "close") {
    const n = String(existing.number);
    await gh(["issue", "comment", n, "--body", "✅ Recovered — all watched jobs are current and every imminent team has a published squad."]);
    await gh(["issue", "close", n]);
    console.log(`Alert issue #${n} closed (recovered).`);
  }
  return action;
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

  const healthy = misses.length === 0 && !coverage;
  const report = healthy
    ? "All watched jobs are current and every imminent team has a published squad."
    : [
        misses.length ? formatReport(misses, now) : null,
        coverage ? coverage.text : null,
      ].filter(Boolean).join("\n\n———\n\n");
  console.log(report);

  // Primary channel: a GitHub issue (the email path 535s from Actions). Closes
  // itself on recovery, stays silent while the state is unchanged.
  const signature = healthy ? "" : alertSignature(misses, coverage);
  try {
    await syncAlertIssue(report, signature, healthy);
  } catch (err) {
    console.error(`::warning::alert issue sync failed (${String(err.message).split("\n")[0]}); see report above`);
  }

  if (healthy) return;

  // Email stays as a best-effort second channel: it currently fails (Gmail SMTP
  // app-passwords 535 from Actions IPs), so a send failure must never crash the
  // watchdog or mask the gaps — the issue and the log above are the record.
  const subjectBits = [];
  if (misses.length) subjectBits.push(`${misses.length} job(s) overdue`);
  if (coverage) subjectBits.push(`${coverage.gaps.length} squad gap(s)`);
  try {
    await sendEmail({ subject: `⚠️ Rugby Tracker: ${subjectBits.join(", ")}`, text: report });
  } catch (err) {
    console.error(`::warning::alert email failed (${String(err.message).split("\n")[0]}); the GitHub issue is the live channel`);
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
