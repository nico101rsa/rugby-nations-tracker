# Match-day cron Worker

Dispatches `refresh-data.yml` on a schedule from Cloudflare instead of relying
only on GitHub's scheduler.

## Why

GitHub drops scheduled workflow runs, routinely and without warning. The Mac
pinger (`com.nicomcdonald.rugby-pinger`) used to raise the hit rate against
that — but it fires from the Mac, and with the Mac asleep for months it is not
a mechanism at all. **RNC rounds 4–6 run 7–22 Nov 2026**, squarely inside the
unattended window.

**What this does not fix, stated plainly:** the Worker dispatches an Actions
workflow, so if Actions itself is down, the refresh does not run. It does not
share GitHub's **scheduler** failure mode — the one that has actually bitten
us — but it does share GitHub's **execution** failure mode.

Double-firing is harmless: `refresh-data.yml` uses
`concurrency: refresh-data, cancel-in-progress: false`, and GitHub keeps one
pending run per group, so a Worker fire landing beside a scheduled one queues
rather than duplicating work or spending api-sports quota twice.

## One-time setup (needs Nico — these are credentials)

Three secrets on **this** repo. Deployment then runs from Actions, not the Mac.

### 1. A GitHub token for the Worker to dispatch with

Create a **fine-grained personal access token** at
<https://github.com/settings/personal-access-tokens/new>:

- **Repository access:** only `nico101rsa/rugby-nations-tracker`
- **Permissions:** `Actions` → **Read and write**. Nothing else.
- **Expiry:** set this deliberately long. ⚠️ A token that expires in month two
  silently kills the backstop — exactly the class of failure the credential
  audit (#195) was about. The weekly health report will catch it, but a long
  expiry means it never has to.

```bash
gh secret set GH_DISPATCH_TOKEN --repo nico101rsa/rugby-nations-tracker
```

Paste the token when prompted — **from stdin, never on the command line**, or
it lands in shell history and the process table.

### 2. A Cloudflare API token

Cloudflare dashboard → My Profile → API Tokens → Create Token → **Edit
Cloudflare Workers** template. Scope it to your account.

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo nico101rsa/rugby-nations-tracker
gh secret set CLOUDFLARE_ACCOUNT_ID --repo nico101rsa/rugby-nations-tracker
```

The account ID is on the right-hand sidebar of any Cloudflare dashboard page.

### 3. Deploy

Push to `main` touching `worker/`, or run the workflow manually:

```bash
gh workflow run deploy-worker.yml --repo nico101rsa/rugby-nations-tracker
```

## Checking it works

```bash
curl https://rugby-tracker-cron.<your-subdomain>.workers.dev/health
```

Returns `{"tokenValid": true, ...}`. It deliberately does **not** dispatch, so
checking costs no api-sports quota.

The durable evidence is elsewhere, and needs no Cloudflare login: the Worker's
fires appear in the Actions history as **`workflow_dispatch`** runs, while
GitHub's own scheduler produces **`schedule`** runs. The weekly health report
counts both and raises an alert if the dispatched count hits zero — because a
dead Worker is otherwise invisible until the Saturday the scheduler drops a run
and there is no backstop.

## Cost

Free plan. Cron Triggers are **5 per account** (verified against Cloudflare's
limits page, 2026-07-25); this uses two, and Pages projects on the same account
use none. Request cost is ~96 fires/day plus ~108 on Saturdays, against a
100,000/day allowance.

## Retiring the Mac pinger

Once the health report shows dispatched runs, `com.nicomcdonald.rugby-pinger`
is redundant:

```bash
launchctl bootout gui/$(id -u)/com.nicomcdonald.rugby-pinger
```
