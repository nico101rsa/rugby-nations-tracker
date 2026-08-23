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
