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
// Must match the string silent-failures.mjs looks for in run titles.
const WORKER_SOURCE = "cloudflare-worker";

async function dispatch(env) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
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
      // `source` lands in the run's title via refresh-data.yml's run-name, and
      // is the ONLY thing distinguishing a Worker fire from the Mac pinger's:
      // both dispatch the same workflow and both authenticate as nico101rsa.
      // Without it the liveness check reports this Worker healthy on pinger
      // traffic alone — a placebo, when the whole point is the months the Mac
      // is asleep.
      body: JSON.stringify({ ref: "main", inputs: { source: WORKER_SOURCE } }),
    },
  );

  // 204 No Content is the success case for this endpoint.
  if (res.status === 204) return { ok: true, status: 204 };

  const body = await res.text();
  return { ok: false, status: res.status, body: body.slice(0, 300) };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatch(env).then((r) => {
        if (r.ok) {
          console.log(`dispatched ${WORKFLOW} (cron ${event.cron})`);
        } else {
          // Worker logs are not somewhere Nico looks, so this is not the
          // alerting path. The durable evidence that the Worker is alive is
          // that `workflow_dispatch`-triggered refresh runs keep appearing in
          // the Actions history — which the weekly health report counts.
          console.error(`dispatch failed ${r.status}: ${r.body}`);
        }
      }),
    );
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
