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
