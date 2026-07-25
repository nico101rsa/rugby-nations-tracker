// The two failures that are SILENT by design (map #201, #203).
//
// Both of these are deliberately non-fatal, and that is exactly why they need
// watching: nothing else will ever go red for them.
//
// 1. STORYLINE BACKLOG (#201). Backlog extraction runs AFTER publishing, in a
//    try/catch, so it can never cost an edition. That same design means it can
//    fail every day for a month with nothing going red — and every quiet team
//    silently drops a rung to the data edition. The tell is already in the
//    file: `writeBacklog` is only reached when extraction SUCCEEDS, so a
//    stalled `updatedAt` is a precise signal, not a proxy.
//
// 2. REFUSED BOX SCORES (#203). The arithmetic gate in the stats pipeline is
//    right to refuse a match whose scoring events don't reconcile with the
//    final score. The problem is that nothing surfaces the refusal, so if
//    these accumulate every "last N" denominator shrinks with no visible
//    cause. This does NOT change the gate or the averaging — it only makes
//    the refusals countable.

const DAY = 86400000;

// The digest runs daily. Three days tolerates a couple of GitHub's dropped
// scheduled runs before crying wolf, while still catching a real stall inside
// the first week.
export const BACKLOG_STALE_DAYS = 3;

export function checkStorylineBacklog(backlog, now = Date.now(), maxAgeDays = BACKLOG_STALE_DAYS) {
  if (!backlog?.updatedAt) {
    return {
      ok: false,
      severity: "warn",
      headline: "Storyline backlog has never been written",
      detail:
        "`editorial/storylines.json` has no `updatedAt`. On a cold start this is expected — " +
        "the backlog is extracted from the same pool that decides who is quiet, so on day one " +
        "the teams *with* storylines are largely the teams that didn't need one. The data " +
        "edition does most of the work; treat the Storyline rung as upside.",
    };
  }

  const ageDays = (now - new Date(backlog.updatedAt).getTime()) / DAY;
  if (ageDays > maxAgeDays) {
    return {
      ok: false,
      severity: "alert",
      headline: `Storyline backlog hasn't grown in ${Math.floor(ageDays)} days`,
      detail:
        `\`editorial/storylines.json\` last moved ${new Date(backlog.updatedAt).toISOString().slice(0, 10)} ` +
        `(${Math.floor(ageDays)} days ago), holding ${backlog.count ?? 0} open storylines.\n\n` +
        "`writeBacklog` is only reached when extraction succeeds, so a stalled timestamp means the " +
        "**backlog extraction call is failing** — silently, by design, because it runs after " +
        "publishing inside a try/catch so it can never cost an edition.\n\n" +
        "Consequence: every quiet team drops a rung to the data edition. Editions keep publishing, " +
        "so nothing goes red. Look for `storyline backlog refresh failed` in the digest run log.",
    };
  }

  return {
    ok: true,
    headline: `Storyline backlog fresh — ${backlog.count ?? 0} open, updated ${Math.floor(ageDays)}d ago`,
  };
}

// Matches the arithmetic gate refused, and who loses a game because of it.
export function checkUnreconciled(stats) {
  const matches = stats?.matches ?? [];
  if (!matches.length) {
    return { ok: false, severity: "warn", headline: "No box scores in stats.json", refused: [] };
  }

  const refused = matches.filter((m) => m.reconciled === false);
  if (!refused.length) {
    return { ok: true, headline: `All ${matches.length} box scores reconcile`, refused: [] };
  }

  // A refusal costs BOTH sides a game from their tries/cards averages, which
  // is the part that isn't obvious from a raw count.
  const affected = new Set();
  for (const m of refused) {
    if (m.home?.name) affected.add(m.home.name);
    if (m.away?.name) affected.add(m.away.name);
  }

  const lines = refused.map(
    (m) =>
      `- ${String(m.date ?? "").slice(0, 10)} — ${m.home?.name ?? "?"} ${m.home?.score ?? "?"}` +
      `-${m.away?.score ?? "?"} ${m.away?.name ?? "?"}`,
  );

  return {
    ok: false,
    severity: refused.length / matches.length > 0.2 ? "alert" : "warn",
    headline: `${refused.length} of ${matches.length} box scores refused by the arithmetic gate`,
    refused,
    detail:
      `${lines.join("\n")}\n\n` +
      `The gate is right to refuse these — the scoring events don't add up to the final score, and ` +
      `publishing them would put wrong numbers on the Team page. But **both** sides of each refused ` +
      `match lose a game from their tries and cards averages, so these teams are averaging over a ` +
      `shorter window than their points average uses: **${[...affected].sort().join(", ")}**.\n\n` +
      `This is a coverage signal, not a bug to fix here. Watch the ratio: one refusal in eighteen is ` +
      `noise, a growing share means the vendor's event feed is degrading.`,
  };
}

// Both checks as one markdown section for the weekly health report.
export function silentFailuresSection(backlog, stats, now = Date.now(), refreshRows = null) {
  const b = checkStorylineBacklog(backlog, now);
  const u = checkUnreconciled(stats);
  const w = refreshRows === null ? null : checkCronWorker(refreshRows, now);
  const mark = (c) => (c.ok ? "✅" : c.severity === "alert" ? "🔴" : "🟡");

  const parts = [
    "## Silent failures",
    "",
    "Two pipelines are deliberately non-fatal, so nothing else will ever go red for them.",
    "",
    `${mark(b)} **Storyline backlog** — ${b.headline}`,
  ];
  if (!b.ok) parts.push("", b.detail);
  parts.push("", `${mark(u)} **Box-score reconciliation** — ${u.headline}`);
  if (!u.ok && u.detail) parts.push("", u.detail);
  if (w) {
    parts.push("", `${mark(w)} **Match-day cron Worker** — ${w.headline}`);
    if (!w.ok && w.detail) parts.push("", w.detail);
  }
  return parts.join("\n");
}

// The string the Worker stamps into a run's title via refresh-data.yml's
// run-name. Counting bare `workflow_dispatch` runs is NOT enough: the Mac
// pinger dispatches the same workflow and authenticates as the same user, so
// an event-only check reports the Worker healthy on pinger traffic — a placebo,
// when the Worker exists precisely for the months the Mac is asleep.
export const WORKER_SOURCE = "cloudflare-worker";

// Is the Cloudflare cron Worker actually firing? (map #196)
//
// The Worker's own logs are in a Cloudflare dashboard nobody opens, so they
// are not evidence. What IS evidence, and visible from here, is its stamped
// runs appearing in the Actions history — no Cloudflare access needed.
//
// A dead Worker is invisible otherwise: GitHub's scheduled crons still fire
// often enough that nothing looks broken, right up until the Saturday they
// don't.
export function checkCronWorker(refreshRows, now = Date.now(), sinceDays = 7) {
  if (!refreshRows) {
    return { ok: false, severity: "warn", headline: "Could not query refresh-data run history" };
  }
  const cutoff = now - sinceDays * DAY;
  const recent = refreshRows.filter((r) => new Date(r.createdAt).getTime() >= cutoff);
  const dispatched = recent.filter((r) => (r.displayTitle ?? "").includes(WORKER_SOURCE)).length;
  const scheduled = recent.filter((r) => r.event === "schedule").length;

  if (dispatched === 0) {
    return {
      ok: false,
      severity: "alert",
      headline: `No Worker-dispatched refresh runs in ${sinceDays} days (${scheduled} from GitHub's scheduler)`,
      detail:
        "The Cloudflare cron Worker stamps `" + WORKER_SOURCE + "` into the title of every run it " +
        "dispatches. None have appeared, so either the Worker is not deployed, its GitHub token has " +
        "expired, or its cron triggers are off.\n\n" +
        "Note this counts the STAMP, not the event: the Mac pinger dispatches the same workflow as " +
        "the same user, so counting `workflow_dispatch` runs would report the Worker healthy on " +
        "pinger traffic alone.\n\n" +
        "**This is invisible without the check**: GitHub's own scheduler still fires often enough " +
        "that nothing looks broken — right up until a Saturday when it drops the run and there is " +
        "no backstop. Hit the Worker's `/health` route to test the token without spending " +
        "api-sports quota.",
    };
  }

  return {
    ok: true,
    headline: `Cron Worker alive — ${dispatched} dispatched + ${scheduled} scheduled refresh runs in ${sinceDays}d`,
  };
}
