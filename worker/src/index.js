// Cloudflare Worker cron — the durable match-day scheduler (app map #196).
//
// WHAT THIS FIXES, precisely. GitHub drops scheduled workflow runs, routinely
// and without warning. refresh-data.yml already carries its own */15 and
// Saturday */10 crons, and scripts/refresh.mjs burst-polls in-process for ~2h,
// so ONE landed fire covers a whole match. The Mac pinger raised the hit rate
// against those drops — but it fires from Nico's Mac, and with the Mac asleep
// for months it is not a mechanism at all. RNC rounds 4-6 run 7-22 Nov 2026,
// squarely inside that window.
//
// WHAT IT DOES NOT FIX, said plainly so it isn't mistaken for more than it is.
// This Worker dispatches an Actions workflow, so if Actions itself is down,
// the refresh does not run. It does not share GitHub's SCHEDULER failure mode,
// which is the one that has actually bitten us; it does share GitHub's
// EXECUTION failure mode. A fallback that fails for the same cause as the
// primary is not a fallback, and this one is honest about which half it covers.
//
// Double-firing is harmless by design: refresh-data.yml has
// `concurrency: refresh-data, cancel-in-progress: false`, and GitHub keeps one
// pending run per group, so a Worker fire landing next to a scheduled one
// queues rather than duplicating work or burning api-sports quota twice.

const REPO = "nico101rsa/rugby-nations-tracker";
const WORKFLOW = "refresh-data.yml";
const DIGEST_WORKFLOW = "generate-digests.yml";
// Must match the string silent-failures.mjs looks for in run titles.
const WORKER_SOURCE = "cloudflare-worker";

// generate-digests.yml has the same scheduler-drop exposure as the refresh —
// GitHub dropped its 20:00 UTC fire outright on 2026-08-28 (and ran it 2.5h
// and 7.9h late the two days before), so the 2026-08-29 morning edition never
// existed and the News tab sat on yesterday's digests. Mirror its two crons
// here (daily 20:00 UTC; Sat 08/12/17/22 UTC) off the quarter-hour tick this
// Worker already has — no extra Cloudflare cron triggers, which are capped at
// 5 per account. Only the :00 tick has minute < 15, so each slot dispatches
// exactly once. A double fire next to GitHub's own cron is harmless: the
// workflow's `digests` concurrency group serialises them.
function digestDue(now) {
  if (now.getUTCMinutes() >= 15) return false;
  const h = now.getUTCHours();
  return h === 20 || (now.getUTCDay() === 6 && [8, 12, 17, 22].includes(h));
}

async function dispatch(env, workflow = WORKFLOW, inputs = { source: WORKER_SOURCE }) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        "content-type": "application/json",
        // GitHub rejects requests with no User-Agent.
        "user-agent": "rugby-tracker-cron-worker",
        "x-github-api-version": "2022-11-28",
      },
      // For refresh-data.yml, `source` lands in the run's title via its
      // run-name, and is the ONLY thing distinguishing a Worker fire from the
      // Mac pinger's: both dispatch the same workflow and both authenticate as
      // nico101rsa. Without it the liveness check reports this Worker healthy
      // on pinger traffic alone — a placebo, when the whole point is the
      // months the Mac is asleep. generate-digests.yml declares no inputs, and
      // GitHub 422s a dispatch carrying unexpected ones, so it passes null.
      body: JSON.stringify(inputs ? { ref: "main", inputs } : { ref: "main" }),
    },
  );

  // 204 No Content is the success case for this endpoint.
  if (res.status === 204) return { ok: true, status: 204 };

  const body = await res.text();
  return { ok: false, status: res.status, body: body.slice(0, 300) };
}

export default {
  async scheduled(event, env, ctx) {
    const log = (workflow) => (r) => {
      if (r.ok) {
        console.log(`dispatched ${workflow} (cron ${event.cron})`);
      } else {
        // Worker logs are not somewhere Nico looks, so this is not the
        // alerting path. The durable evidence that the Worker is alive is
        // that `workflow_dispatch`-triggered refresh runs keep appearing in
        // the Actions history — which the weekly health report counts.
        console.error(`${workflow} dispatch failed ${r.status}: ${r.body}`);
      }
    };
    ctx.waitUntil(dispatch(env).then(log(WORKFLOW)));
    // Digests ride the quarter-hour cron only. At Sat 08:00 both crons fire a
    // separate event each; gating on the expression keeps that to one dispatch.
    if (event.cron === "*/15 * * * *" && digestDue(new Date(event.scheduledTime))) {
      ctx.waitUntil(dispatch(env, DIGEST_WORKFLOW, null).then(log(DIGEST_WORKFLOW)));
    }
  },

  // A plain GET is a manual smoke test: visit the workers.dev URL and it
  // reports whether the token still works, without waiting for a cron tick.
  // Deliberately does NOT dispatch — checking should not cost api-sports quota.
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/health") {
      return new Response("rugby-tracker cron worker — GET /health to check the token\n", {
        headers: { "content-type": "text/plain" },
      });
    }
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: {
        authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        "user-agent": "rugby-tracker-cron-worker",
      },
    });
    const ok = res.ok;
    return new Response(
      JSON.stringify({ tokenValid: ok, githubStatus: res.status, repo: REPO, workflow: WORKFLOW }, null, 1) + "\n",
      { status: ok ? 200 : 503, headers: { "content-type": "application/json" } },
    );
  },
};
