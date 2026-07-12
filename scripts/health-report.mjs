// Weekly health check — runs Thursday, ALWAYS emails, and always writes a
// dated markdown file to editorial/health/. Covers what a headless job can
// know for sure (run reliability, digest quality grades, what changed) and
// leaves honest, qualified pointers for what it can't reach headless (app
// analytics behind logins, App Store review status that arrives by email).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sendEmail } from "./notify.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REVIEWS_DIR = join(ROOT, "editorial", "reviews");
const HEALTH_DIR = join(ROOT, "editorial", "health");

const WORKFLOWS = [
  { file: "generate-digests.yml", label: "News digests" },
  { file: "refresh-data.yml", label: "Live data refresh" },
];

// ---- pure helpers (unit-tested) ------------------------------------------

export function isoWeekLabel(d) {
  // ISO-8601 week: Thursday-anchored. Copy so we don't mutate the input.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Sun=7
  t.setUTCDate(t.getUTCDate() + 4 - day); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function parseGrade(markdown) {
  // Strip the "(A-F)" scale hint some reports echo, so it isn't mistaken for
  // the grade itself, then take the first letter grade after the word "grade".
  const cleaned = markdown.replace(/\(A[-–]F\)/gi, "");
  const m = cleaned.match(/grade\b\W*([A-F][+-]?)/i);
  return m ? m[1].toUpperCase() : null;
}

export function tallyRuns(rows, now, sinceDays = 7) {
  const cutoff = now.getTime() - sinceDays * 86400000;
  const recent = rows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
  const tally = { total: recent.length, success: 0, failure: 0, cancelled: 0, other: 0, lastAt: null };
  for (const r of recent) {
    if (r.conclusion === "success") tally.success++;
    else if (r.conclusion === "failure") tally.failure++;
    else if (r.conclusion === "cancelled") tally.cancelled++;
    else tally.other++;
  }
  const times = recent.map((r) => new Date(r.createdAt).getTime());
  if (times.length) tally.lastAt = new Date(Math.max(...times));
  return tally;
}

// Drop the high-volume bot commits so "what changed" shows real work.
export function summarizeChanges(commitLines) {
  // Bot commit shapes: "data: live refresh (...)", "Data refresh <date> AEST",
  // "Daily digests <date> AEST", "chore: keepalive". Real PR commits like
  // "Digests: own concurrency group…" have no date after the word and survive.
  const noise = /^\s*(data: live refresh|Data refresh \d|Daily digests \d|chore: keepalive)/i;
  return commitLines.filter((l) => l.trim() && !noise.test(l));
}

// ---- data gathering ------------------------------------------------------

async function recentReviews(now, sinceDays = 7) {
  let files = [];
  try {
    files = (await readdir(REVIEWS_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const cutoff = now.getTime() - sinceDays * 86400000;
  const out = [];
  for (const f of files) {
    const iso = f.replace(".md", "");
    const when = new Date(`${iso}T00:00:00Z`).getTime();
    if (Number.isNaN(when) || when < cutoff) continue;
    const md = await readFile(join(REVIEWS_DIR, f), "utf8");
    out.push({ date: iso, grade: parseGrade(md) });
  }
  return out;
}

async function runRows(workflowFile) {
  try {
    const { stdout } = await execFileAsync("gh", [
      "run", "list", "--workflow", workflowFile,
      "--limit", "100", "--json", "createdAt,conclusion",
    ]);
    return JSON.parse(stdout);
  } catch (err) {
    console.error(`gh query failed for ${workflowFile}: ${err.message}`);
    return null;
  }
}

async function gitChanges(sinceDays = 7) {
  try {
    const { stdout } = await execFileAsync("git", [
      "log", `--since=${sinceDays}.days.ago`, "--pretty=format:%s",
    ], { cwd: ROOT });
    return summarizeChanges(stdout.split("\n"));
  } catch {
    return [];
  }
}

// ---- report --------------------------------------------------------------

export function buildReport({ weekLabel, now, reviews, runTallies, changes }) {
  const L = [`# Weekly health check — ${weekLabel}`, "", `_Generated ${now.toISOString()} (UTC)._`, ""];

  L.push("## Run reliability (last 7 days)", "");
  for (const { label, file, tally } of runTallies) {
    if (!tally) { L.push(`- **${label}** — could not query run history.`); continue; }
    const last = tally.lastAt ? `last ${tally.lastAt.toISOString()}` : "no runs";
    const flag = tally.failure > 0 ? " ⚠️" : "";
    L.push(`- **${label}** (${file}) — ${tally.success}✅ / ${tally.failure}❌ / ${tally.cancelled}⏹ of ${tally.total} runs; ${last}${flag}`);
  }
  L.push("");

  L.push("## Digest quality (post-run editor grades)", "");
  if (reviews.length === 0) {
    L.push("- No review files in the last 7 days (a dropped digest run also drops its review).");
  } else {
    for (const r of reviews) L.push(`- ${r.date}: **${r.grade ?? "?"}**`);
    const graded = reviews.filter((r) => r.grade);
    if (graded.length) L.push("", `_Latest grade: **${graded[graded.length - 1].grade}**. Full notes in \`editorial/reviews/\`._`);
  }
  L.push("");

  L.push("## What changed (non-bot commits, last 7 days)", "");
  if (changes.length === 0) L.push("- No hand-authored changes merged this week.");
  else for (const c of changes.slice(0, 30)) L.push(`- ${c}`);
  L.push("");

  L.push("## App analytics — check manually (not reachable headless)", "");
  L.push(
    "- **Ranks:** run `/app-store-ranks` for App Store category ranks (AppFigures depth needs your Chrome login).",
    "- **Usage:** Aptabase dashboard (us.aptabase.com) for installs/active users/countries.",
    "",
  );

  L.push("## App submission status — LAST-KNOWN, confirm before relying on it", "");
  L.push(
    "- Review-status emails land in **Outlook**, and this job can't read them until the App Store Connect API key (roadmap action) is set.",
    "- **As last recorded:** 1.0.1 (build 7) submitted for review 2026-07-10, auto-release on approval; 1.0 live since 2026-07-09. **This is likely stale — confirm in App Store Connect / Outlook.**",
    "",
  );
  return L.join("\n");
}

async function main() {
  const now = new Date();
  const weekLabel = isoWeekLabel(now);

  const reviews = await recentReviews(now);
  const runTallies = [];
  for (const w of WORKFLOWS) {
    const rows = await runRows(w.file);
    runTallies.push({ ...w, tally: rows ? tallyRuns(rows, now) : null });
  }
  const changes = await gitChanges();

  const report = buildReport({ weekLabel, now, reviews, runTallies, changes });

  await mkdir(HEALTH_DIR, { recursive: true });
  const outPath = join(HEALTH_DIR, `${weekLabel}.md`);
  await writeFile(outPath, report + "\n");
  console.log(`Wrote ${outPath}`);
  console.log(report);

  await sendEmail({ subject: `🩺 Rugby Tracker weekly health check — ${weekLabel}`, text: report });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
