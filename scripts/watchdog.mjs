// Watchdog — did the scheduled jobs actually run, and if not, put it right.
//
// GitHub silently drops scheduled runs under load (cron drift). That froze the
// live scores on 2026-07-11 and dropped the 2026-07-12 morning digest with no
// warning. This job runs daily (twice a day in November) and checks each
// watched workflow had a recent SUCCESSFUL run. Then, in this order:
//
//   1. SELF-HEAL. Every overdue workflow is re-dispatched (unless a run of it
//      is already queued or in progress, or it is team-events.yml and the
//      watchdog re-ran it under reHealAfterHours ago: that one spends vendor
//      quota, so it is re-run once a day even in November). Most misses are
//      a dropped cron or a one-off vendor blip, and a re-run is the whole fix
//      — the 30 Sep 2026 team-events failure recovered on its next scheduled
//      run without anyone touching it. The dispatch uses the built-in
//      GITHUB_TOKEN, which GitHub deliberately allows to start a
//      workflow_dispatch run.
//   2. WRITE IT DOWN, SILENTLY. editorial/health/ops-status.json (+ a readable
//      ops-status.md) holds the current signals, each workflow's heal attempts
//      and a short change log. The Claude weekly review reads it. Nobody is
//      notified by it.
//   3. PAGE NICO only for a user-facing job that stays broken despite the
//      retry: STILL overdue on a run after the watchdog already re-ran it on an
//      earlier run with no success since (about a day down), or overdue on
//      three watchdog runs in a row (the re-run gets it going, its own schedule
//      doesn't keep it current: refresh-data's 6h limit is far shorter than the
//      watchdog's day). That is the one case that assigns + @mentions him, on
//      the "⚠️ Rugby Tracker ops alert" issue — once per outage. If he closes
//      it while the outage goes on, the page stored in ops-status.json keeps it
//      closed; only a job he has not been paged for opens a new one.
//
// A workflow whose run history can't be read this run is UNKNOWN, not overdue:
// no re-run, no page, its heal record kept as it was, and a page it was already
// part of left alone (neither closed nor re-sent).
//
// The editorial checks (repeated leads, the model ladder on its last rung,
// squad coverage) and the catch-up job NEVER page: they are quality signals for
// the weekly review, not outages. Until 2026-10-04 they shared the alert issue,
// and the repeat-lead day count in its signature changed every morning, so it
// re-pinged Nico on 30 Sep and 1, 2, 3 and 4 Oct for briefings that were merely
// a day stale.
//
// Scope: the data repo's own workflows (queried with the built-in GITHUB_TOKEN).
// The archive workflow lives in the app repo — watching it needs a cross-repo
// PAT (tracked as a follow-up), so it's out of v1.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { issueCreateArgs, ALERT_OWNER } from "./notify.mjs";
import { teamsheetGaps, PUBLISH_TEAMSHEETS, readRecentRunReports } from "./generate-digests.mjs";
import { sameStory, shortDate } from "./novelty.mjs";

const execFileAsync = promisify(execFile);

// maxAgeHours = how stale the last success may be before we alarm.
// refresh runs every 15 min but drift/idle make short gaps normal; the real
// floor is the 6-hourly sweep, so 6h catches a genuine stall without noise.
//
// userFacing = a stall shows up in the app. Only these can page Nico.
// impact     = what a reader sees meanwhile (goes in the page, so he can judge
//              how much it matters without opening anything).
// inputs     = workflow_dispatch inputs for the self-heal re-run.
// coveredBy  = a re-run of that workflow does this one's job too, so it is not
//              dispatched alongside it.
export const WATCHERS = [
  {
    workflow: "generate-digests.yml", label: "Daily news digests", maxAgeHours: 26,
    userFacing: true, impact: "the News tab keeps showing the last briefing that published",
  },
  {
    workflow: "refresh-data.yml", label: "Live data refresh", maxAgeHours: 6,
    userFacing: true, impact: "live scores, fixtures and tables stop updating",
    // The run title carries who asked (refresh-data.yml run-name), so a heal is
    // never mistaken for Worker traffic by silent-failures.mjs.
    inputs: { source: "watchdog" },
  },
  // Daily 01:00 UTC (+ Sat 19:00) — feeds the app's Team pages; a dropped run
  // leaves finished games showing as upcoming fixtures (seen 2026-07-19).
  //
  // reHealAfterHours: it spends SportsAPI Pro quota (~25 calls a run, up to
  // 12 retries, against 100 a day shared with every other job), so the
  // watchdog re-runs it at most once in that many hours. In November the
  // watchdog runs twice a day, and with the vendor down (flaky since 23 Aug
  // 2026) a re-run on every check would spend quota the other jobs need on a
  // match weekend. Only the RE-RUN waits: the job is still evaluated, recorded
  // and paged on every check, exactly as before. 20h sits above the longest
  // gap between the two November runs (~15h40) and below the shortest gap
  // between two daily runs (~22h05), so outside November nothing changes.
  {
    workflow: "team-events.yml", label: "Team events (Team pages)", maxAgeHours: 26,
    userFacing: true, impact: "Team pages keep finished games listed as upcoming",
    reHealAfterHours: 20,
  },
  // Every 3h across 05:00-14:00 UTC — publishes a finished game to the Team
  // pages between full runs (an Asia-Pacific kickoff otherwise waits ~12h).
  // Most runs are deliberate no-ops, so success here means "the check ran",
  // which is exactly the liveness signal worth watching. Four runs a day, so
  // 26h only fires after several consecutive drops. Not user-facing on its
  // own: the daily full run still publishes everything it would. It shares the
  // team-events-pipeline concurrency group, so it is never dispatched next to a
  // team-events.yml re-run (one would evict the other's pending slot).
  {
    workflow: "team-events-catchup.yml", label: "Team events catch-up (post-match)", maxAgeHours: 26,
    userFacing: false, coveredBy: "team-events.yml",
  },
];

// A heal attempt must be at least this old before a still-overdue job pages.
// The floor stops a manual re-run of the watchdog, minutes or a few hours after
// a heal, from paging before the re-run has had a chance to land (a digest
// re-run takes ~20 minutes, the others less).
//
// It must also stay BELOW the shortest gap between two scheduled runs, or the
// next run cannot page and the page slips a whole run. Most of the year the
// watchdog runs daily, so any value under 24h means "on the next day's run".
// In November it runs twice a day (22:15 and 10:15 UTC, watchdog.yml). GitHub
// starts the 22:15 cron 1h45-3h40 late (00:00-01:55 UTC through Sep-Oct 2026);
// the 10:15 cron's delay has never been measured, so it is planned for as
// anything from on time to as late as the other. A late morning run (01:55)
// and an on-time evening one (10:15) are then only 8h20 apart, so the 12 used
// until 4 Oct 2026, and even 8, could make a November page wait a whole extra
// run. 6 leaves over 2h of margin and is still far longer than any re-run.
export const PAGE_AFTER_HEAL_HOURS = 6;

// The second page rule: the previous runs' record must already show at least
// this many consecutive overdue runs, so the run that pages is the third in a
// row. That gives a job whose re-run keeps succeeding one more day than a job
// that is plainly dead (which pages on its second run), and it still has to
// span PAGE_AFTER_HEAL_HOURS, so a burst of manual watchdog runs can't page.
export const PAGE_AFTER_STREAK = 2;

const workflowSet = (xs) => new Set((xs ?? []).map((x) => (typeof x === "string" ? x : x?.workflow)).filter(Boolean));

// Pure core: given the last-success time per workflow, decide what's overdue.
// latestByWorkflow: { [workflow]: Date | null }
// unknown: the watchers whose run history could not be read this run. They are
// neither fresh nor overdue, so they are left out: no re-run and no page off an
// API failure.
export function evaluate(now, latestByWorkflow, watchers = WATCHERS, { unknown = [] } = {}) {
  const skip = workflowSet(unknown);
  const misses = [];
  for (const w of watchers) {
    if (skip.has(w.workflow)) continue;
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
    "Likely cause: GitHub dropped the scheduled run (cron drift). The watchdog",
    "re-dispatches it (self-heal) and pages only if it stays overdue after that.",
  );
  return lines.join("\n");
}

// ---- run history → last success + "is one already running?" ----------------
//
// One unfiltered listing per workflow, judged here, rather than
// `gh run list --status success --limit 1`. The status-filtered query answered
// "last success 26 Sep 17:00" for the digests on 2 Oct 2026 — 128.7h, a false
// alarm — while the same workflow had green runs at 20:00 and 23:32 UTC the
// evening before. The unfiltered list also says whether a run is in flight,
// which the self-heal needs anyway.
export const RUN_WINDOW = 100;
const ACTIVE = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

export function summariseRuns(rows = []) {
  const sorted = [...(rows ?? [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const success = sorted.find((r) => r.conclusion === "success");
  return {
    lastSuccessAt: success ? new Date(success.createdAt) : null,
    active: sorted.some((r) => ACTIVE.has(r.status)),
  };
}

// ---- self-heal ----------------------------------------------------------------

// Pure: which overdue workflows to re-dispatch now, and why the rest are not.
// active: { [workflow]: boolean } — a run is already queued or in progress.
// prevHeals + now: a watcher with reHealAfterHours is not re-dispatched again
// until that long after the watchdog last dispatched it (`lastDispatchAt`).
export function selectHeals(misses, active = {}, { prevHeals = null, now = null } = {}) {
  const overdue = new Set(misses.map((m) => m.workflow));
  const dispatch = [];
  const skipped = [];
  for (const m of misses) {
    const lastDispatch = Date.parse(prevHeals?.[m.workflow]?.lastDispatchAt ?? "");
    const sinceDispatch = now && Number.isFinite(lastDispatch) ? (now.getTime() - lastDispatch) / 3600000 : null;
    if (active[m.workflow]) {
      skipped.push({ workflow: m.workflow, reason: "a run is already queued or in progress" });
    } else if (m.reHealAfterHours && sinceDispatch !== null && sinceDispatch >= 0 && sinceDispatch < m.reHealAfterHours) {
      skipped.push({
        workflow: m.workflow,
        reason: `re-run ${sinceDispatch.toFixed(1)}h ago; it spends SportsAPI Pro quota, so it is re-run at most once every ${m.reHealAfterHours}h`,
      });
    } else if (m.coveredBy && (overdue.has(m.coveredBy) || active[m.coveredBy])) {
      skipped.push({ workflow: m.workflow, reason: `covered by ${m.coveredBy}` });
    } else {
      dispatch.push(m.workflow);
    }
  }
  return { dispatch, skipped };
}

// Pure: the `gh` argv that re-runs a watched workflow on main.
export function dispatchArgs(watcher) {
  const args = ["workflow", "run", watcher.workflow, "--ref", "main"];
  for (const [k, v] of Object.entries(watcher.inputs ?? {})) args.push("-f", `${k}=${v}`);
  return args;
}

// Pure: the heal record for every workflow overdue NOW. A record carries on
// from the previous run's while the same outage continues — `firstAt` is the
// first heal of THIS outage, and a success since then means it is a new one.
// Workflows that are no longer overdue drop out (they recovered).
//
// Skipping the dispatch because a run is already in flight still counts as an
// attempt: that run IS the retry, and if the job is still overdue a day later
// it did not fix it either.
//
// `streak` counts consecutive watchdog runs that found it overdue, from
// `streakSince`. Unlike `firstAt` it survives a successful re-run: a previous
// record only exists if the job was also overdue on the last run (a run that
// finds it healthy drops it), so carrying on from one is what "in a row" means.
//
// `lastDispatchAt` is the last time the watchdog actually re-ran it (a
// successful dispatch), carried while the record lives; selectHeals reads it
// for the quota throttle.
//
// An UNKNOWN workflow (its run history couldn't be read) keeps its record
// exactly as it was: not a recovery, which would clear it, and not another
// overdue run, which would count against it.
export function nextHeals(prev = {}, misses, plan, results = {}, now, { unknown = [] } = {}) {
  const skippedWhy = new Map(plan.skipped.map((s) => [s.workflow, s.reason]));
  const out = {};
  for (const m of misses) {
    let outcome;
    if (skippedWhy.has(m.workflow)) outcome = `not dispatched — ${skippedWhy.get(m.workflow)}`;
    else if (results[m.workflow]?.ok) outcome = "re-run dispatched";
    else outcome = `dispatch failed — ${results[m.workflow]?.error ?? "unknown error"}`;
    const p = prev?.[m.workflow];
    const continuing = Boolean(p?.firstAt) && (!m.lastSuccessAt || m.lastSuccessAt < new Date(p.firstAt));
    out[m.workflow] = {
      firstAt: continuing ? p.firstAt : now.toISOString(),
      lastAt: now.toISOString(),
      attempts: continuing ? (p.attempts ?? 1) + 1 : 1,
      outcome,
      streak: p ? (Number(p.streak) || 1) + 1 : 1,
      streakSince: (p && (p.streakSince ?? p.firstAt)) || now.toISOString(),
      lastDispatchAt: results[m.workflow]?.ok && !skippedWhy.has(m.workflow) ? now.toISOString() : (p?.lastDispatchAt ?? null),
    };
  }
  for (const wf of workflowSet(unknown)) if (prev?.[wf] && !out[wf]) out[wf] = prev[wf];
  return out;
}

// ---- the page tier --------------------------------------------------------------

// Pure: the overdue jobs that page. User-facing, judged on the PREVIOUS runs'
// record (not this run's), and either
//   - still down after a re-run: a heal for this same outage at least
//     PAGE_AFTER_HEAL_HOURS ago and no success since. A heal that a later
//     success superseded belongs to an outage that ended, so it does not count;
//   - or keeps falling behind: already overdue on PAGE_AFTER_STREAK runs in a
//     row, over at least PAGE_AFTER_HEAL_HOURS, and overdue again now. This is
//     the refresh-data case — its re-run succeeds every morning, so the first
//     rule never fires, while live scores update once a day.
export function pagingMisses(misses, prevHeals = {}, now, { afterHours = PAGE_AFTER_HEAL_HOURS, afterStreak = PAGE_AFTER_STREAK } = {}) {
  const hoursSince = (when) => {
    const t = when == null ? NaN : new Date(when).getTime();
    return Number.isNaN(t) ? null : (now.getTime() - t) / 3600000;
  };
  return misses.filter((m) => {
    if (!m.userFacing) return false;
    const h = prevHeals?.[m.workflow];
    if (!h?.firstAt) return false;
    const sinceHeal = hoursSince(h.firstAt);
    const stillDown = sinceHeal !== null && sinceHeal >= afterHours && !(m.lastSuccessAt && m.lastSuccessAt >= new Date(h.firstAt));
    const sinceStreak = hoursSince(h.streakSince ?? h.firstAt);
    const keepsFalling = (Number(h.streak) || 1) >= afterStreak && sinceStreak !== null && sinceStreak >= afterHours;
    return stillDown || keepsFalling;
  });
}

export const ALERT_TITLE = "⚠️ Rugby Tracker ops alert";

// The page signature is the SET of paged workflows and nothing else — no ages,
// no day counts — so one outage is one ping however long it lasts.
export function pageSignature(paging = []) {
  return [...new Set(paging.map((m) => m.workflow))].sort().join(",");
}

const signatureSet = (sig) => new Set(String(sig ?? "").split(",").map((s) => s.trim()).filter(Boolean));

const PAGE_MARKER = /<!-- page: ([^>]*?) -->/;
export function pagedIn(body) {
  const m = PAGE_MARKER.exec(String(body ?? ""));
  return signatureSet(m ? m[1] : "");
}

// Pure: what to do with the alert issue.
//   create — first page of an outage
//   update — a NEW user-facing job joined an open page (edit + one comment)
//   edit   — same jobs, or fewer: refresh the body silently (edits don't notify)
//   close  — nothing pages any more: close, with no "recovered" comment
//   noop   — nothing pages and nothing is open, OR Nico closed the page while
//            the same outage goes on (stored = the page ops-status.json keeps)
//
// findAlertIssue only sees open issues, so without `stored` a page he closed
// was re-created, and re-pinged him, every morning. Only a job he has not been
// paged for in this outage opens a new one; one dropping out never does.
export function decidePageAction(existing, paging = [], stored = null) {
  const current = new Set(paging.map((m) => m.workflow));
  if (!current.size) return existing ? "close" : "noop";
  if (existing) {
    const before = pagedIn(existing.body);
    return [...current].some((w) => !before.has(w)) ? "update" : "edit";
  }
  const paged = signatureSet(stored?.signature);
  return [...current].some((w) => !paged.has(w)) ? "create" : "noop";
}

// Pure: the page record ops-status.json keeps — { signature, openedAt } of the
// page Nico was sent, or null when nothing pages. A create is remembered only
// once it went through (ok), and an "error" (the issue sync failed) changes
// nothing, so a page that was never sent is retried on the next run rather
// than taken as already sent.
export function nextPageRecord(stored, paging = [], action, { ok = true, now, openedAt = null } = {}) {
  if (!paging.length) return null;
  const signature = pageSignature(paging);
  if (action === "create") return ok ? { signature, openedAt: now.toISOString() } : stored ?? null;
  if (action === "edit" || action === "update" || action === "noop") {
    return { signature, openedAt: stored?.openedAt ?? openedAt ?? now.toISOString() };
  }
  return stored ?? null;
}

// Pure: UNKNOWN workflows that were part of the current page (the open issue's
// marker or the stored record). They stay in it as they are: an API failure is
// no evidence the job recovered, and closing on it would mean a second ping
// when the next run can read it again.
export function heldPages(unknown = [], existing = null, stored = null) {
  const was = new Set([...pagedIn(existing?.body), ...signatureSet(stored?.signature)]);
  return (unknown ?? [])
    .filter((u) => was.has(u.workflow))
    .map((u) => ({ ...u, held: true, lastSuccessAt: null, ageHours: null }));
}

// ---- Sydney time ----------------------------------------------------------------
//
// Nico reads these in Sydney. Numeric parts only, with fixed tables, for the
// same reason novelty.mjs avoids toLocaleDateString: ICU's en-AU strings drift
// between Node builds ("Sept"). The zone label comes from the offset.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const SYD = new Intl.DateTimeFormat("en-US", {
  timeZone: "Australia/Sydney", hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
});
export function sydney(when) {
  if (when == null) return "never";
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) return String(when);
  const p = Object.fromEntries(SYD.formatToParts(d).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  const offset = Math.round((local - Math.floor(d.getTime() / 60000) * 60000) / 3600000);
  const zone = offset === 11 ? "AEDT" : offset === 10 ? "AEST" : `UTC+${offset}`;
  const wd = DAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return `${wd} ${+p.day} ${MONTHS[+p.month - 1]} ${p.year}, ${String(+p.hour % 24).padStart(2, "0")}:${p.minute.padStart(2, "0")} ${zone}`;
}

const ageText = (m, now) =>
  m.lastSuccessAt
    ? `last success ${sydney(m.lastSuccessAt)} (${((now - m.lastSuccessAt) / 3600000).toFixed(1)}h ago; limit ${m.maxAgeHours}h)`
    : `no successful run in the last ${RUN_WINDOW} runs (limit ${m.maxAgeHours}h)`;

// True when the job did run successfully during its overdue streak (the
// re-runs work) but keeps going stale between watchdog runs.
const fallingBehind = (m, h) =>
  Number(h?.streak) >= 2 && Boolean(h.streakSince) && Boolean(m.lastSuccessAt) && m.lastSuccessAt >= new Date(h.streakSince);

export function pageReport(paging, heals, now, repoUrl = "") {
  const lines = ["A user-facing job is still overdue despite the watchdog's automatic re-runs.", ""];
  for (const m of paging) {
    const h = heals?.[m.workflow];
    if (m.held) {
      lines.push(
        `• ${m.label} (${m.workflow}) — its run history could not be read this time (${m.error ?? "GitHub API error"}). ` +
          "It was already down, so this stays open until a run can confirm it recovered.",
      );
    } else {
      lines.push(`• ${m.label} (${m.workflow}) — ${ageText(m, now)}.`);
      if (fallingBehind(m, h)) {
        lines.push(
          `  Found overdue on ${h.streak} watchdog runs in a row since ${sydney(h.streakSince)}. Each automatic re-run got it going, ` +
            "but its own schedule is not keeping it current.",
        );
      } else if (h) {
        lines.push(`  The watchdog first re-ran it ${sydney(h.firstAt)} (${h.attempts} attempt${h.attempts === 1 ? "" : "s"} so far); still no success since.`);
      }
    }
    if (m.impact) lines.push(`  Meanwhile in the app: ${m.impact}.`);
    if (repoUrl) lines.push(`  Runs: ${repoUrl}/actions/workflows/${m.workflow}`);
  }
  lines.push(
    "",
    "All times Sydney time. The watchdog keeps re-running it (team events at most once a day,",
    "to spare the sports-data quota) and closes this issue by itself once it succeeds. Routine",
    "findings (repeat leads, the model ladder, squad gaps) never come here — they are in",
    "editorial/health/ops-status.md for the weekly review.",
  );
  return lines.join("\n");
}

// Squad coverage: which teams playing this week have no published teamsheet in
// nations.json, resolved to names via the fixtures. Returns null when coverage
// is complete. The 2026-07-14 blank-squad miss slipped through because nothing
// here checked squads — the watchdog only asked whether the jobs RAN.
// Early-week the list doubles as a "who's still to name" tracker; a name
// persisting late in the week is a real gap the pipeline failed to catch.
// Silent signal: it goes to the status file, never to a page.
export function coverageReport(nations, now = new Date()) {
  if (!PUBLISH_TEAMSHEETS) return null; // teamsheets paused — no squad to be missing
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

// ---- editorial checks: repeated leads, the model ladder --------------------------
//
// The watchdog asked one question — did the jobs RUN? — and the digests
// answered yes every day from 23 to 25 September 2026 while the Springbok
// tab showed the same story under three different dates. A healthy job
// writing a stale edition is a failure the run log alone will never raise.
// Both are silent signals for the weekly review; neither pages.

// How many consecutive editions a team has led with one story, judged on the
// run reports (oldest → newest, one per day). A team's latest lead that reads
// as the same story as the day before counts 2; the day before that, 3.
// Alerts at `minDays`. Uses the generator's own similarity (novelty.mjs), so
// what the gate calls a repeat, the watchdog calls a repeat.
export function repeatLeadReport(reports, { minDays = 2 } = {}) {
  const ordered = (reports ?? []).filter((r) => r && Array.isArray(r.teams));
  if (ordered.length < 2) return null;
  const latest = ordered[ordered.length - 1];
  const repeats = [];
  for (const row of latest.teams) {
    if (!row?.heading) continue;
    let days = 1;
    let since = latest.date;
    let current = row;
    // open: the run reaches the oldest report given, so it may have started
    // earlier than `since` (the window is a week of reports).
    let open = true;
    for (let i = ordered.length - 2; i >= 0; i--) {
      const prev = ordered[i].teams.find((t) => t?.team === row.team);
      const reason = prev?.heading && sameStory(
        { heading: current.heading, body: current.body, link: current.leadLink },
        { heading: prev.heading, body: prev.body, link: prev.leadLink },
      );
      if (!reason) {
        open = false;
        break;
      }
      days++;
      since = ordered[i].date;
      current = prev;
    }
    if (days >= minDays) {
      repeats.push({ team: row.team, days, since, heading: row.heading, firstHeading: current.heading, flagged: Boolean(row.repeatLead), open });
    }
  }
  if (!repeats.length) return null;
  repeats.sort((a, b) => b.days - a.days || a.team.localeCompare(b.team));
  const text = [
    `Rugby Tracker — the daily briefing is repeating itself (run report ${latest.date}):`,
    "",
    ...repeats.map((r) =>
      `• ${r.team} — same lead story for ${r.days} days (since ${shortDate(r.since)}): "${r.heading}"` +
        (r.flagged ? " — the novelty gate flagged it and published anyway" : " — the novelty gate did NOT flag it"),
    ),
    "",
    "The generator's novelty gate should have revised these. Check the latest",
    "generate-digests run log for the per-team novelty= lines, and the team's",
    "candidates in editorial/runs/<date>.json for whether anything fresh was on offer.",
  ].join("\n");
  return { repeats, text };
}

// The run completed on the LAST rung of the Gemini ladder: every model above
// it shed the traffic, so there is no spare left and a bad afternoon on this
// one takes the whole digest down. The generator prints a ::warning:: for
// this, in an Actions log nobody opens; this puts it in the status file. If
// the ladder runs out entirely the digests stop succeeding, and THAT pages
// through generate-digests.yml going overdue.
export function ladderReport(latest) {
  const model = latest?.model;
  if (!model?.onLastRung) return null;
  const text = [
    `Rugby Tracker — the digest run on ${latest.date} completed on the LAST rung of the model ladder (${model.servedBy}).`,
    "",
    `Every model above it answered 429/503 (${model.rejections ?? "?"} rejections across ${model.calls ?? "?"} served calls).`,
    "If this persists, the ladder needs another rung — the Claude fallback in",
    "generate-digests.mjs is wired but costs money; that is Nico's call.",
  ].join("\n");
  return { model: model.servedBy, date: latest.date ?? null, text };
}

// ---- the silent status file ------------------------------------------------------

export const STATUS_JSON = new URL("../editorial/health/ops-status.json", import.meta.url);
export const STATUS_MD = new URL("../editorial/health/ops-status.md", import.meta.url);
export const HISTORY_DAYS = 35;
export const HISTORY_MAX = 60;

const iso = (d) => (d ? new Date(d).toISOString() : null);

// One line per state, free of timestamps and day counts, so the change log
// only grows when something actually changed.
export function statusLine(status) {
  const parts = [];
  if (status.paging.length) parts.push(`PAGING: ${status.paging.map((p) => p.workflow).join(", ")}`);
  if (status.overdue.length) parts.push(`overdue: ${status.overdue.map((o) => o.workflow).join(", ")}`);
  if (status.unknown?.length) parts.push(`status unknown: ${status.unknown.map((u) => u.workflow).join(", ")}`);
  const s = status.signals;
  if (s.repeatLeads.length) parts.push(`repeat leads: ${s.repeatLeads.map((r) => r.team).sort().join(", ")}`);
  if (s.ladderLastRung) parts.push("model ladder on its last rung");
  if (s.squadGaps.length) parts.push(`squad gaps: ${s.squadGaps.map((g) => g.team).join(", ")}`);
  return parts.length ? parts.join("; ") : "all clear";
}

// The newest entry is always kept, however old: it is the current state, and
// ageing it out emptied the log after 35 unchanged days (then re-added it the
// next day — two commits about nothing).
export function appendHistory(history = [], entry, now, { days = HISTORY_DAYS, max = HISTORY_MAX } = {}) {
  const kept = [...(Array.isArray(history) ? history : [])];
  if (kept[kept.length - 1]?.summary !== entry.summary) kept.push(entry);
  const cutoff = now.getTime() - days * 86400000;
  return kept.filter((h, i, all) => i === all.length - 1 || new Date(h.at).getTime() >= cutoff).slice(-max);
}

// The committed form of the editorial signals carries nothing that moves while
// the situation stands still, so an unchanged day writes the same bytes and
// makes no commit. Replaying 21 Sep-4 Oct 2026, the day counts ("Ireland 2d",
// "3d"), each morning's reworded headline and the ladder's report date gave 13
// commits in 14 days. So: a repeat lead is its team, the date it started and
// the headline it FIRST ran under; the ladder is its model and the date it
// first hit the last rung. The run log keeps the full daily text.
//
// A repeat as long as the report window has no visible start (`open`), and
// its `since` would slide forward a day each morning; it keeps the start the
// previous run recorded.
function committedLeads(repeats, prev) {
  if (!repeats?.repeats?.length) return [];
  const before = new Map((prev?.signals?.repeatLeads ?? []).map((r) => [r.team, r]));
  return repeats.repeats
    .map((r) => {
      const p = before.get(r.team);
      const carry = Boolean(r.open && p?.since && String(p.since) < String(r.since));
      return {
        team: r.team,
        since: carry ? p.since : r.since,
        heading: carry ? p.heading : r.firstHeading ?? r.heading,
        flagged: Boolean(r.flagged),
      };
    })
    .sort((a, b) => String(a.since).localeCompare(String(b.since)) || String(a.team).localeCompare(String(b.team)));
}

function committedLadder(ladder, prev) {
  if (!ladder) return null;
  const p = prev?.signals?.ladderLastRung;
  const since = p && p.model === ladder.model ? p.since ?? p.date ?? ladder.date ?? null : ladder.date ?? null;
  return { model: ladder.model, since };
}

// paging: what is on the page — this run's pagingMisses plus any heldPages.
// unknown: watchers whose run history could not be read ({ workflow, label, error }).
// page: the nextPageRecord for this run.
export function buildStatus({ now, misses, paging, heals, coverage, repeats, ladder, prev = null, unknown = [], page = null }) {
  const pagingSet = new Set(paging.map((m) => m.workflow));
  const status = {
    about:
      "Written by scripts/watchdog.mjs, only when something changes. The silent ops log: " +
      "routine findings land here instead of notifying anyone, and the Claude weekly review reads it. " +
      "state=paging is the only state that pinged Nico (the '⚠️ Rugby Tracker ops alert' issue); " +
      "`page` is the page he was sent, kept so that closing the issue by hand ends the pings for that outage.",
    state: paging.length ? "paging" : misses.length || unknown.length || coverage || repeats || ladder ? "attention" : "ok",
    paging: paging.map((m) => ({
      workflow: m.workflow, label: m.label, lastSuccessAt: iso(m.lastSuccessAt), healFirstAt: heals?.[m.workflow]?.firstAt ?? null,
      ...(m.held ? { unknown: true } : {}),
    })),
    page: page ?? null,
    overdue: misses.map((m) => ({
      workflow: m.workflow, label: m.label, userFacing: Boolean(m.userFacing), maxAgeHours: m.maxAgeHours,
      lastSuccessAt: iso(m.lastSuccessAt), paging: pagingSet.has(m.workflow),
    })),
    unknown: (unknown ?? []).map((u) => ({ workflow: u.workflow, label: u.label ?? u.workflow, error: u.error ?? null })),
    heals: heals ?? {},
    signals: {
      repeatLeads: committedLeads(repeats, prev),
      ladderLastRung: committedLadder(ladder, prev),
      squadGaps: coverage ? coverage.gaps.map((g) => ({ team: g.team, kickoff: g.kickoff })) : [],
    },
    history: [],
  };
  status.history = appendHistory(prev?.history, { at: now.toISOString(), summary: statusLine(status) }, now);
  return status;
}

const STATE_WORDS = {
  ok: "OK — every watched job is current and no editorial signal is up.",
  attention: "ATTENTION — something is off, nothing has paged. Triage in the weekly review.",
  paging: "PAGING — a user-facing job stayed down after a re-run; Nico has been pinged on the ops alert issue.",
};

export function renderStatusMarkdown(status) {
  const L = [
    "# Ops status",
    "",
    "_The silent ops log, written by the daily watchdog (`scripts/watchdog.mjs`) only when something changes._",
    "_Nothing here notifies anyone except state **PAGING**. The Claude weekly review reads this file with the newest weekly report in this folder._",
    "_All times Sydney time._",
    "",
    `**State: ${STATE_WORDS[status.state] ?? status.state}**`,
    "",
    "## Paging Nico",
    "",
  ];
  if (!status.paging.length) L.push("- Nothing pages.");
  for (const p of status.paging) {
    L.push(p.unknown
      ? `- **${p.label}** (\`${p.workflow}\`) — status unknown this run (see below); it was already paging, so the page stays as it is.`
      : `- **${p.label}** (\`${p.workflow}\`) — last success ${sydney(p.lastSuccessAt)}; first re-run ${sydney(p.healFirstAt)}.`);
  }
  if (status.page) {
    L.push(
      `- Page sent ${sydney(status.page.openedAt)} for \`${status.page.signature}\`. If that issue was closed by hand it stays ` +
        "closed for this outage; only a job not in it pages again.",
    );
  }
  L.push("", "## Overdue jobs and self-heal", "");
  if (!status.overdue.length) L.push("- Every watched job has a recent successful run.");
  for (const o of status.overdue) {
    const h = status.heals?.[o.workflow];
    const streak = Number(h?.streak) >= 2 ? ` Streak: overdue on ${h.streak} watchdog runs in a row since ${sydney(h.streakSince)}.` : "";
    const heal = h
      ? ` Self-heal: ${h.outcome} (attempt ${h.attempts}; first ${sydney(h.firstAt)}, latest ${sydney(h.lastAt)}).${streak}`
      : "";
    L.push(
      `- **${o.label}** (\`${o.workflow}\`${o.userFacing ? ", user-facing" : ", not user-facing — never pages"}) — ` +
        `last success ${sydney(o.lastSuccessAt)}; limit ${o.maxAgeHours}h.${heal}`,
    );
  }
  for (const u of status.unknown ?? []) {
    L.push(
      `- **${u.label}** (\`${u.workflow}\`) — its run history could not be read (${u.error ?? "no error text"}). ` +
        "Not re-run and not paged on that; its self-heal record is kept as it was.",
    );
  }
  const s = status.signals;
  L.push("", "## Editorial signals (never page)", "", "**Repeat leads**", "");
  if (!s.repeatLeads.length) L.push("- None — every briefing moved on.");
  for (const r of s.repeatLeads) {
    L.push(
      `- ${r.team} — same lead story since ${shortDate(r.since)}, first run as "${r.heading}"` +
        (r.flagged ? " — the novelty gate flagged the latest edition and published anyway" : " — the novelty gate did NOT flag the latest edition"),
    );
  }
  L.push("", "**Model ladder**", "");
  L.push(s.ladderLastRung
    ? `- Digest runs are completing on the LAST rung (${s.ladderLastRung.model})${s.ladderLastRung.since ? ` since ${shortDate(s.ladderLastRung.since)}` : ""} — no spare left above it.`
    : "- Spare capacity above the serving model.");
  L.push("", "**Squad coverage**", "");
  if (!s.squadGaps.length) L.push("- No gaps (or teamsheets are paused).");
  for (const g of s.squadGaps) L.push(`- ${g.team} — kickoff ${g.kickoff}: no published squad in nations.json`);
  L.push("", `## Change log (last ${HISTORY_DAYS} days, newest first; the current state is always kept)`, "");
  for (const h of [...(status.history ?? [])].reverse()) L.push(`- ${sydney(h.at)} — ${h.summary}`);
  return L.join("\n") + "\n";
}

// Writes both files only when the JSON changed, so an unchanged day is no
// commit. Returns whether anything was written.
export async function writeStatus(status, { jsonPath = STATUS_JSON, mdPath = STATUS_MD } = {}) {
  const json = JSON.stringify(status, null, 1) + "\n";
  const before = await readFile(jsonPath, "utf8").catch(() => null);
  const mdBefore = await readFile(mdPath, "utf8").catch(() => null);
  if (before === json && mdBefore !== null) return false;
  await mkdir(jsonPath instanceof URL ? new URL(".", jsonPath) : dirname(String(jsonPath)), { recursive: true });
  await writeFile(jsonPath, json);
  await writeFile(mdPath, renderStatusMarkdown(status));
  return true;
}

// ---- GitHub plumbing (best-effort; only syncPageIssue is unit-tested, with a fake gh) ----

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args);
  return stdout;
}

async function findAlertIssue(run = gh) {
  const rows = JSON.parse(await run(["issue", "list", "--state", "open", "--limit", "50", "--json", "number,title,body,createdAt"]));
  return rows.find((r) => r.title === ALERT_TITLE) ?? null;
}

// Post/refresh/close the page, and return what the status file should record:
// { action, paged, page }. `paged` is this run's pages plus any held ones (an
// unknown job that was already on the page); `page` is the nextPageRecord.
// Throws if GitHub does — main() then keeps the stored page as it was, so a
// page that failed to send is retried rather than remembered as sent.
export async function syncPageIssue(paging, heals, now, repoUrl = "", { stored = null, unknown = [], gh: run = gh } = {}) {
  const existing = await findAlertIssue(run);
  const paged = [...paging, ...heldPages(unknown, existing, stored)];
  const action = decidePageAction(existing, paged, stored);
  const report = paged.length ? pageReport(paged, heals, now, repoUrl) : "";
  const marker = `<!-- page: ${pageSignature(paged)} -->`;
  const body = `@${ALERT_OWNER}\n\n${report}\n\n_Updated ${now.toISOString()} by the watchdog._\n${marker}`;

  if (action === "noop") {
    console.log(paged.length
      ? `Ops alert: the page for ${pageSignature(paged)} was closed by hand and that outage goes on — not paging again.`
      : "Ops alert: nothing pages, nothing open.");
  } else if (action === "create") {
    // issueCreateArgs adds the @mention and the assignee itself.
    const createBody = `${report}\n\n_Updated ${now.toISOString()} by the watchdog._\n${marker}`;
    const url = (await run(issueCreateArgs({ title: ALERT_TITLE, body: createBody, page: true }))).trim();
    console.log(`Ops alert opened, paging ${ALERT_OWNER}: ${url}`);
  } else if (action === "edit") {
    await run(["issue", "edit", String(existing.number), "--body", body]);
    console.log(`Ops alert #${existing.number} refreshed silently (no new job paging).`);
  } else if (action === "update") {
    const n = String(existing.number);
    const joined = paged.filter((m) => !pagedIn(existing.body).has(m.workflow));
    await run(["issue", "edit", n, "--body", body, "--add-assignee", ALERT_OWNER]);
    // A comment (not a silent body edit) is what notifies — once, for a job
    // that was not already paging.
    await run(["issue", "comment", n, "--body", `@${ALERT_OWNER} now also down: ${joined.map((m) => m.label).join(", ")}.\n\n${pageReport(joined, heals, now, repoUrl)}`]);
    console.log(`Ops alert #${n} updated (new job paging).`);
  } else if (action === "close") {
    // No "recovered" comment: a comment is a notification, and good news can
    // wait for the weekly review.
    await run(["issue", "close", String(existing.number)]);
    console.log(`Ops alert #${existing.number} closed — nothing pages any more.`);
  }
  return { action, paged, page: nextPageRecord(stored, paged, action, { now, openedAt: existing?.createdAt ?? null }) };
}

async function recentRuns(workflow) {
  // gh uses GH_TOKEN (the workflow's GITHUB_TOKEN) in Actions.
  return JSON.parse(await gh([
    "run", "list", "--workflow", workflow, "--limit", String(RUN_WINDOW), "--json", "createdAt,status,conclusion",
  ]));
}

// Only when none of the last RUN_WINDOW runs succeeded — the job is overdue
// either way, this just finds the age to report.
async function lastSuccessFallback(workflow) {
  try {
    const rows = JSON.parse(await gh(["run", "list", "--workflow", workflow, "--status", "success", "--limit", "1", "--json", "createdAt"]));
    return rows.length ? new Date(rows[0].createdAt) : null;
  } catch {
    return null;
  }
}

const firstLine = (s) => String(s ?? "").split("\n")[0].slice(0, 200);

async function main() {
  const now = new Date();
  const repoUrl = process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}` : "";
  const prev = await readFile(STATUS_JSON, "utf8").then(JSON.parse).catch(() => null);

  const latest = {};
  const active = {};
  const unknown = [];
  for (const w of WATCHERS) {
    try {
      const s = summariseRuns(await recentRuns(w.workflow));
      latest[w.workflow] = s.lastSuccessAt ?? (await lastSuccessFallback(w.workflow));
      active[w.workflow] = s.active;
    } catch (err) {
      // UNKNOWN, not a miss: counted as "no success at all", two flaky API
      // days in a row would page a healthy job.
      const error = firstLine(err.stderr || err.message);
      console.error(`::warning::could not read the run history of ${w.workflow} (${error}) — status unknown: not re-run, not paged`);
      unknown.push({ ...w, error });
    }
  }

  const misses = evaluate(now, latest, WATCHERS, { unknown });
  // Judged on the PREVIOUS runs' heal records, before this run adds its own.
  const paging = pagingMisses(misses, prev?.heals, now);

  const plan = selectHeals(misses, active, { prevHeals: prev?.heals, now });
  const results = {};
  for (const wf of plan.dispatch) {
    const w = WATCHERS.find((x) => x.workflow === wf);
    try {
      await gh(dispatchArgs(w));
      results[wf] = { ok: true };
      console.log(`Self-heal: dispatched ${wf}`);
    } catch (err) {
      results[wf] = { ok: false, error: firstLine(err.stderr || err.message) };
      console.error(`::warning::self-heal dispatch of ${wf} failed (${results[wf].error})`);
    }
  }
  for (const s of plan.skipped) console.log(`Self-heal: ${s.workflow} not dispatched — ${s.reason}`);
  const heals = nextHeals(prev?.heals, misses, plan, results, now, { unknown });

  // Squad coverage runs off the committed nations.json (repo root, one level up).
  let coverage = null;
  try {
    const nations = JSON.parse(await readFile(new URL("../nations.json", import.meta.url), "utf8"));
    coverage = coverageReport(nations, now);
  } catch (err) {
    console.error(`Coverage check skipped: ${err.message}`);
  }

  // Editorial checks run off the committed run reports (editorial/runs/).
  let repeats = null;
  let ladder = null;
  try {
    const recent = await readRecentRunReports(7); // newest first
    repeats = repeatLeadReport([...recent].reverse());
    ladder = ladderReport(recent[0]);
  } catch (err) {
    console.error(`Editorial checks skipped: ${err.message}`);
  }

  // The run log keeps the full text of every signal, as before.
  for (const text of [misses.length ? formatReport(misses, now) : null, repeats?.text, ladder?.text, coverage?.text]) {
    if (text) console.log(`${text}\n\n———\n`);
  }

  // The page goes first so the status file records the page actually sent.
  // Best-effort: an alerting failure must not fail the watchdog.
  const stored = prev?.page ?? null;
  let paged;
  let page;
  try {
    ({ paged, page } = await syncPageIssue(paging, heals, now, repoUrl, { stored, unknown }));
  } catch (err) {
    console.error(`::warning::ops alert sync failed (${firstLine(err.message)}); the status file has the state`);
    paged = [...paging, ...heldPages(unknown, null, stored)];
    page = nextPageRecord(stored, paged, "error", { now });
  }

  const status = buildStatus({ now, misses, paging: paged, heals, coverage, repeats, ladder, prev, unknown, page });
  const changed = await writeStatus(status);
  console.log(changed ? "Ops status changed — editorial/health/ops-status.{json,md} rewritten." : "Ops status unchanged.");
  console.log(renderStatusMarkdown(status));
}

// Only run main when invoked directly (not when imported by the test).
import { pathToFileURL } from "node:url";
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
