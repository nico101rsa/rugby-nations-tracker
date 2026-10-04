# Working agreements

## Ship it — don't ask

This repo feeds a hobby app, not a mission-critical service, and every change is
one revert away from undone. Interrupting to ask for approval costs more than the
mistakes it prevents.

**Once Nico has asked for a change, carry it all the way through without checking
back**: make the change, open the PR, merge it. A merged PR is the expected end
state of a request, not a step that needs its own sign-off. The same goes for the
follow-on steps — a failing workflow, a second push to get a job green.

**Report after, not before.** Say what shipped and anything that surprised you.

**Give Nico every time in Sydney time.** Crons, run timestamps and check-ins
are UTC under the hood; convert before reporting (AEST is UTC+10, AEDT is
UTC+11 from the first Sunday in October to the first Sunday in April) and
label it "Sydney time". A bare UTC time in a report is a bug.

### Still worth stopping for

- Something genuinely destructive or irreversible — force-pushing over other
  people's commits, deleting branches or data, rewriting published history.
- A real fork in the design where the options look materially different and
  picking wrong means redoing the work. Ask with the options costed, then
  implement the answer end to end.
- Anything where Nico's answer would change *what* gets built, rather than
  merely confirming that it should be.

Everything else: proceed.

## What this repo is

The data pipeline behind the iOS app, whose source lives in the private sibling
repo `nico101rsa/rugby-nations-tracker-app`. GitHub Pages serves the JSON from
this repo's root, and the app fetches it at runtime.

**That means a data fix needs no app build.** Anything wrong in `nations.json`,
`team-events.json`, `fixtures.json`, `stats.json` or `rankings.json` reaches every
installed copy — TestFlight and App Store alike — as soon as a workflow commits
it. Only a rendering change needs a new build. Say which kind a fix is when
reporting it; the difference decides whether Nico has to wait for TestFlight.

## Scheduled jobs own the data

Nothing here is refreshed by hand. Each JSON file has a workflow that owns it,
on its own cron and its own concurrency group — `.github/workflows/` comments
carry the reasoning, including why the groups are deliberately not shared.

When data looks stale, find the workflow that writes that file and check its
cadence against when the event happened, in **UTC**. Crons are UTC while the
audience is AEST/SAST, and that gap is exactly how the 2026-08-15 form-chart bug
happened: the Saturday catch-up was timed for Northern-Hemisphere kickoffs and
an Asia-Pacific test finished twelve hours from any scheduled run.

Quota is the real constraint on fixes here: SportsAPI Pro is 100 calls/day
shared across jobs. Prefer a targeted refresh over a broader schedule, and make
the no-op path cost nothing —
`scripts/refresh-played-teams.mjs` is the worked example.

## Alerts: who gets pinged

Nico does not review ops output; the scheduled **Claude weekly review** does
(Mondays 20:30 UTC = Tuesday 07:30 Sydney time in AEDT, 06:30 in AEST). So
automation has two tiers, and `scripts/notify.mjs` holds the switch: silent
unless a caller passes `page: true`.

- **Page — pings Nico.** Only the watchdog, and only when a user-facing job
  (`refresh-data.yml`, `team-events.yml`, `generate-digests.yml`) stays broken
  despite the automatic retry: *still* overdue on a watchdog run after an
  earlier run re-dispatched it, with no success since (about a day down), or
  overdue on three watchdog runs in a row (the re-run lands but its own
  schedule doesn't keep it current; refresh-data's 6h limit is far shorter
  than the watchdog's day). One "⚠️ Rugby Tracker ops alert" issue, assigned
  and @mentioning him. Its signature is the set of paged jobs and nothing
  else, so one outage is one ping; another job joining adds one comment;
  recovery closes it with no comment. If he closes it while the outage goes
  on, it stays closed: `ops-status.json` keeps the page he was sent (`page`),
  and only a job not in it opens a new one. The watchdog runs daily at 22:15
  UTC, plus 10:15 UTC (21:15 AEDT) **in November only**, for the match
  weekends. GitHub's start delays (the 10:15 cron's is unmeasured) put those
  two runs as little as ~8h20 apart, which is why the heal-to-page floor
  (`PAGE_AFTER_HEAL_HOURS`) is 6h and not 12. Keep it under the shortest gap
  between runs if the cadence changes. The second run doesn't double the
  quota spend: `team-events.yml` (SportsAPI Pro, ~25 calls) is re-run at most
  once every 20h (`reHealAfterHours`), though it is checked and paged on
  every run.
- **Silent — everything else.** The watchdog re-dispatches any overdue job
  first (self-heal) and records the state in `editorial/health/ops-status.json`
  and `ops-status.md`: current signals, heal attempts and streaks, a 35-day
  change log (the newest entry always kept), committed only when something
  changed. Day counts, the latest reworded headline and the ladder's report
  date are kept out of it, so a signal that just carries on commits nothing.
  A workflow whose run history can't be read is `unknown`: not re-run, not
  paged, and never the reason a page closes. Repeat leads, the model ladder on its
  last rung, squad gaps and the catch-up job never page. The weekly health
  check commits `editorial/health/<week>.md` and files no issue and sends no
  email (email is opt-in: repository variable `HEALTH_EMAIL=1`). The rankings,
  competitions, vendor-probe and box-score checks still file their
  deduplicated issues, with no @mention and no assignee.

The weekly review reads `editorial/health/ops-status.md` and the newest
`editorial/health/<week>.md`, triages the open silent issues, and is the only
other thing that escalates to Nico (its own "🚨 Weekly review <week>: …"
issue, raised only when something needs him).

Don't add an `@nico101rsa`, an `--assignee` or a default-on email anywhere
else. If a new check really is an outage, route it through the watchdog's
page tier and its "still down after a retry" rules. One caveat this can't fix
from code: if Nico watches the repo on "All activity", GitHub still notifies
him on every new issue, which is why the silent tier keeps issues for rare
data-correctness tickets and puts routine findings in files.

## News shadow test (6–12 Oct 2026)

For one week the digests workflow replays each day's production writer
prompts on the paid model and writes the drafts, token counts and cost to
`editorial/shadow/<date>.json` (`scripts/news-shadow.mjs`). It runs after
publication and only on the first run of each Sydney date. It is capped at
US$1.50 a run and US$9 for the week, and it stops itself after 12 Oct. It
never writes `nations.json`. The prompts carry publishers' article text, so
they stay in the runner's temp directory (`DIGEST_PROMPTS_DIR`) and are never
committed. The drafts it does commit were never fact-checked and this repo is
public (Pages serves it all), so each record opens with a `notice` saying so.
`editorial/shadow/README.md` says how the weekly review grades it. Remove the
three shadow steps and `DIGEST_PROMPTS_DIR` once that is done; the workflow
test in `scripts/news-shadow.test.mjs` passes either way, by design, because
the suite runs first in the digest job and a failing test stops publication.

## A result is symmetric — never trust one team's record alone

`team-events.json` holds twelve **separately-fetched** per-team records, so a
single game exists twice and either copy can be missing. A tracked-vs-tracked
international is one game with two sides: a result present on one side and
absent from the other is a vendor gap, not a fact about the match.

`mirrorMissingResults` in `scripts/fetch-team-events.mjs` rebuilds the absent
side from the side that landed. Two rules it encodes, both easy to break:

- **Only the scoreline travels.** `tries` and `cards` are per-team counts
  belonging to whichever side reported them, so a mirrored row carries null.
  Copying them across would credit an opponent's tries to the wrong team.
- **The repair runs BEFORE the vendor call**, in both `fetch-team-events.mjs`
  and `refresh-played-teams.mjs`. This is load-bearing, not stylistic: the fetch
  throws when the vendor answers nothing, so a repair placed after it is never
  reached in the exact case it exists for. It also costs zero calls, which
  matters on a 100/day tier.

Don't diagnose a missing game from one team's entry, and don't move the mirror
after the fetch. Both were the 2026-08-23 bug: New Zealand's 22 Aug loss charted
for South Africa and not for New Zealand.

## SportsAPI Pro may be going away (2026-08-23)

The free tier has returned 503s for five days; the nightly `team-events` job
logged 36 of them and skipped all twelve teams on 23 Aug. It is **not**
team-specific — South Africa probed worse than New Zealand — and the results
(`last`) endpoint is sicker than fixtures (`next`).

`scripts/vendor-probe.mjs` records health nightly to `vendor-probe-log.json`.
**Read that log before claiming anything about vendor health**, and don't assume
this vendor is up when planning work that depends on it. The likely answer is
moving the results call onto keyless ESPN, which already feeds `next` through
`scripts/fetch-espn-fixtures.mjs`.

## Handing unfinished tasks to Nico's PA

Unfinished tasks for Nico's PA go in `~/Documents/Life-os/journal/admin-tasks.md`
(append, date-stamp `YYYY-MM-DD`, heading `## From <project name>`); don't edit
other sections. That file is the one thing `/pa` reads every session, so anything
appended there gets picked up.

A remote session (Claude Code on the web) has no access to that path — hand the
list back in chat instead, formatted ready to paste, and say why. The PA's own
rules live at `~/Documents/Life-os/agents/administrator.md` if they are needed.
