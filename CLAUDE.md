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

**`standings.json` is derived, never edited.** `scripts/build-standings.mjs`
computes a points table for every registered competition from results already
in the repo: nations.json for the Nations Championship (pool stage only —
finals weekend repeats pairings and is excluded), fixtures.json for every
ESPN-scored competition, and the two try caches (`scripts/match-tries.json` by
api-sports id; `scripts/match-tries-espn.json` by fixture id, filled by
`scripts/espn-tries.mjs`). Both scripts run in team-events (cron daily 12:00
Sydney time in AEDT, 11:00 in AEST, plus Sun 06:00 Sydney time in AEDT; through
October 2026 GitHub started the daily run 4–6 hours late, at about
16:00–18:00 Sydney time, and the Saturday run 2–3.5 hours late, at about Sun
08:00–09:30 Sydney time), on every refresh-data tick and on every
3-minute fixtures-burst pass, so a result moves its table on the pass that
lands the score. Zero api-sports or SportsAPI Pro
calls; ESPN only for a newly finished game's try counts, and the frequent
callers pass `--recent` so a game ESPN has no counts for is re-asked only
within six hours of kickoff (the daily run takes the backlog). The file is
written only when a table changes (`updatedAt` is the last change, not the last
run), and every job that rebuilds it commits it and the cache alongside
fixtures.json and `calendar` (`fixtures-burst.test.mjs` checks). A table a try
bonus short says so (`triesPending`); a tie the data can't split publishes as a
shared rank with what it `needs`. The app (from the dec-jan build; 1.3.9
doesn't read the file) takes nations.json `log` for `rnc-*` and standings.json
for everything else. Fix an input, never the output — the
next run rewrites it; the one hand edit allowed is a confirmed try count added
to a cache when ESPN never supplies it (the integrity check asks for that a
week after a season ends). The Nations Championship tiebreak order is
computeLog's and **unverified** (`tiebreakVerified: false`): never print it as
a rule.

The World Cup entry adds, from its first game (Fri 1 Oct 2027, 20:45 Sydney
time), `q` on every pool row, the best third-placed teams and the 16-slot
knockout bracket — each filled only once the results prove it. Two things it
deliberately does not do: apply the World Rugby rankings (the last pool
tiebreak; the app repo's `docs/DATA_RIGHTS.md` rule 1), and place an E3 and an
F3 when both qualify (World Rugby's thirds table isn't encoded): those Round of
16 slots wait for ESPN to name the teams, and the entry says so
(`needs: "thirds-rule"`).

**The Nations Championship finals weekend is projected from the data side**
(`scripts/projected-finals.mjs`, issue #165, since 21 Oct 2026). fixtures.json
carries six `rnc-2026-final-<rank>` rows (equal conference ranks meet, the
confirmed GMT kick-offs, Allianz Stadium) built from nations.json's log on
every fixtures build, `final.projected` until every side has played six
rounds, and dropped the moment ESPN lists a real finals-weekend row. The app
projected the same pairings itself but only while an rnc-* row was in the
file, and played pool games leave it, so from the first build after the last
pool game (Mon 23 Nov) until ESPN's listing the finals vanished. The rows
are not appointments: the calendars and the storylines skip `final.projected`,
and the live-score pass never asks ESPN about one. `check-competitions`
accepts a two-conference season at its table count or the table plus its
finals (36 or 42), so ESPN's listing no longer reads as a miscount.

## Calendars follow fixtures.json

`calendar/<CODE>.ics` (the 12 tracked nations) and `calendar/all.ics` are
subscribable calendars served from Pages
(`webcal://nico101rsa.github.io/rugby-nations-tracker/calendar/NZL.ics`; the
support page links all 13 at `index.html#calendars`).
`scripts/build-calendars.mjs` builds them from fixtures.json — after the
kickoff corrections (the command-line run applies them too), never from
nations.json, which carries only the Nations Championship — and
`build-fixtures.mjs` calls it right after every fixtures.json write. So they
follow every rebuild at zero vendor calls: the daily team-events run (cron
12:00 Sydney time in AEDT, 11:00 in AEST; in practice about 16:00–18:00 Sydney
time through October 2026), its Saturday run (cron Sun 06:00 Sydney time in
AEDT; in practice about 08:00–09:30 Sydney time), every refresh-data tick that
`fixtures-refresh-due` calls due, each 3-min
burst pass, and the push-triggered rebuild (below). There is deliberately no
calendar workflow of its own: the bots commit with GITHUB_TOKEN, and those
commits never trigger `on: push`, so a workflow keyed on fixtures.json changing
would never fire. Every committer of fixtures.json puts `calendar` in the same
`git add`; `fixtures-burst.test.mjs` fails if one doesn't.

The files are byte-stable. No scores (GROWTH_STRATEGY rules out score-carrying
pushes; a played game says "Full time — result in the app."), no generation
timestamp, and `calendar/state.json` (committed) carries each event's SEQUENCE
and LAST-MODIFIED, so an unchanged event is reproduced byte for byte and a
quiet burst pass commits nothing. A moved kickoff or a TBC→confirmed flip bumps
SEQUENCE; any other change bumps only LAST-MODIFIED; a game that leaves
fixtures.json leaves the calendars and the state. Don't hand-edit either: the
next build rewrites any file whose bytes differ from what it would produce,
which is also what heals a messy merge. `.gitattributes` keeps the CRLF line
endings RFC 5545 requires. The team calendars carry a 30-minute alert on
confirmed, unplayed games; all.ics carries none.

Freshness, in Sydney time: the data is at most a day old (minutes, through the
rebuild workflow); the Pages CDN adds up to ~10 minutes; the subscriber is the
long pole and can't be forced — iOS refetches on the interval the device
chooses, Google Calendar roughly every 12–24 hours. Every event says times can
move and the app is the live source.

A calendar bug is log-only. `publishFixtures` catches it, prints
`calendars skipped: …` and fixtures.json is already written (a throw would
count toward the burst's failure limit and end it mid-match). That is the
silent tier: the weekly review sees it in the Actions log; nothing pages.

## Kickoff overrides

The vendors list some kickoffs late — Rugby Australia's run 10–15 minutes
behind the union's own time. Policy (Nico, 26 Sep 2026): when sources
disagree, publish the EARLIER time; ten minutes early costs nothing, ten
minutes late misses the anthems. The hand-confirmed corrections live in
`scripts/kickoff-overrides.mjs` — here, not in the app, so a row reaches every
installed copy with no build.

- **Key:** `"<UTC day of the vendor time> <HOME>-<AWAY>"`, codes as
  fixtures.json prints them. One game carries three different ids across the
  feeds; the match is the one thing they agree on.
- **Rules (kickoff-overrides.test.mjs enforces them):** earlier only, same UTC
  day, at most 60 minutes — anything bigger is a reschedule and belongs to the
  vendor. `vendor` records the feed's time when the row was written: the row
  applies only while the feed still says that, so a vendor reschedule beats a
  stale row and a vendor catching up makes it a no-op. Never key a row on a
  seed or static placeholder time. Delete a row once its game is played.
- **Three feed hooks.** `publishFixtures` in build-fixtures (before the
  final sort, so the moved game re-sorts), `slimGames` in fetch-nations (the
  published `results`/`fixtures` arrays only — never the raw games cache:
  `scrapeTries` matches ESPN by the vendor's kickoff minute, so a corrected
  time there would lose the try count), and `mergeUpcoming` in
  fetch-team-events (each team's `next`, after the ESPN merge; the catch-up job
  reuses it). The calendar command line (`node scripts/build-calendars.mjs`,
  `rebuildFromCommitted`) lays the same table over the committed fixtures.json
  before it writes, so a hand run never puts a vendor time back. Each logs
  `kickoff override applied: <key> <vendor>→<date>`.
- **Every "is it on yet?" decision reads the corrected kickoff** through
  `correctedKickoffMs` (the earlier of the row's time and its correction, same
  vendor guard, writes nothing): build-fixtures' live-score candidates
  (`liveCandidates`) and played filter, `fixtures-refresh-due` and the burst's
  `inBurstWindow`. Before 12 Oct the candidates were picked from the rows
  before `publishFixtures` corrected them, so the Bledisloe (Sat 17 Oct, 15:45
  Sydney time) would have burst from 15:30 but fetched no live score until
  16:00. A new decision about kickoff goes through the same function.
- **When a row lands:** at the next fixtures rebuild (cron daily 12:00 Sydney
  time and Sun 06:00 Sydney time, though through October 2026 GitHub started
  the daily run 4–6 hours late, at about 16:00–18:00 Sydney time, and the
  Saturday run 2–3.5 hours late, at about Sun 08:00–09:30 Sydney time; or any
  live-window tick), or about two minutes after the merge through
  **Actions → "Rebuild fixtures & calendars"** (`fixtures-rebuild.yml`), the
  route for anything urgent. That workflow fires on any push to main that
  touches the override table, the calendar builder or the competition seeds,
  and can be run by hand; it is keyless. Don't dispatch "Team events" to
  publish a row early: that is ~25 SportsAPI Pro calls. nations.json and
  team-events.json pick a row up on their own next runs.
- **Ship a row at least a day before the game.** Calendar subscribers refresh
  slowly, and nothing can force them.
- The app's old table (`src/kickoff-overrides.js`, shipped in 1.3.9, keyed by
  fixture id) goes quiet by itself once the feed carries the earlier time — its
  vendor guard sees a different time — and is deleted in the dec-jan build. New
  rows go here only.
- nations.json's November rows (Rounds 4–6) are no longer noon placeholders:
  since #144 (12 Oct 2026) `SCHEDULE` in static-fixtures.mjs carries ESPN's
  confirmed kickoffs (`timeTBC: false`), and nations.json takes them at its
  next write (a sweep at 00/06/12/18 UTC, i.e. 11:00, 17:00, 23:00 or 05:00
  Sydney time in AEDT, or a live window; the first after the merge was due at
  17:00 Sydney time on 12 Oct). All 18 key and time-match their fixtures.json
  rows, so a row written against ESPN's time corrects nations.json too, and all
  three feeds move together. Two limits: once a game is inside api-sports'
  fetch window its own record replaces the static row, and if api-sports lists
  a different minute from ESPN the vendor guard leaves nations.json on
  api-sports' time (harmless, the feed wins; the nations run's log shows
  whether `kickoff override applied` fired). Finals weekend isn't in
  `SCHEDULE`: nations.json carries the finals only once api-sports does.

## Models: who writes, who checks, who reviews

`scripts/model-router.mjs` decides, per role, from the keys and the
`DIGEST_*_MODEL` repository variables. Since 2026-10-11 (the news shadow test,
`editorial/shadow/`): **Haiku 5.5** writes and fact-checks every edition and the
roundup, **Sonnet 5.5** does the post-run review, and Gemini's free ladder is
the fallback for every paid call plus the home of the two housekeeping calls
(storyline extraction, checker tuning). The fixture storylines are the one
exception: **Opus 5.5** writes them (the storyline shadow run of 2026-10-21,
"Storylines" below), with the same Haiku checker. About US$0.16 a run (12 Oct: Haiku
US$0.05 over 28 calls, the one Sonnet review US$0.11), so about US$7–8 a month
with the Saturday extra runs, against the US$12–24 budgeted; the run report's `model.anthropic` block and
the Actions log carry the real spend per model (the block is rewritten after
the review and the tuner have run, so their calls are in it too). A paid model that fails falls
back to Gemini on that call and the log says so (`fellBack`). To try another
model for a week, set the variable (any model priced in
`scripts/compare-digest-models.mjs`, or `gemini`); no code change.

Don't put Opus on the daily review: it reads twelve 90-word editions and
leaves two notes, a Sonnet-shaped job. The weekly review is where the deeper
model earns its price, and it already runs there.

**New news sources are proposed, probed, and adopted by hand.** The review may
name up to three outlets a day for a retrieval-starved team; they land in
`editorial/source-candidates.json`, `scripts/probe-source-candidates.mjs`
finds each one's feed and counts its stories about the tracked teams for a
week, and `editorial/source-candidates.md` shows the result. Nothing adds an
outlet to `scripts/news-sources.mjs` except a person: this repo is public and
the spine carries publishers' text. The weekly review puts the ready ones to
Nico.

## Storylines (fixture previews)

`storylines.json` at the root holds a pre-match story for every unplayed
fixtures.json game with a tracked side kicking off in the next 14 days: a
headline (≤60 characters) and 4–6 beats (history, last meeting and form,
what's at stake, team and coaching news, one spice angle), keyed by the
fixtures.json id, with the `sources` (title + url) it used. Not to be confused
with `editorial/storylines.json`, the digests' quiet-day backlog.
`scripts/build-storylines.mjs` builds it as a step of `generate-digests.yml`,
after the editions (cron 07:00 Sydney time in AEDT, 06:00 in AEST, plus the
Saturday extras at 19:00 and 23:00 Sat and 04:00 and 09:00 Sun Sydney time in
AEDT), on the same keys. The writer is **Opus 5.5 on the "dry" brief**
(both since the shadow runs of 21 Oct 2026, below; the repository variables
`STORYLINE_WRITER_MODEL` and `STORYLINE_VOICE=preview` override them for
this step alone); the checker is the digests' (`DIGEST_CHECKER_MODEL`,
Haiku 5.5).

- **Pack only.** The writer sees a fact pack from repo data (fixtures.json,
  team-events.json + archive, rankings.json, nations.json's log for `rnc-*`)
  plus news-pool.json items whose title names a team and two searches per
  fixture (`widenFixture`: the week's news, and the previews, where the
  colour lives — without the second, Saturday's story could not say Eddie
  Jones was Jake White's adviser on the 2007 Springboks, because nothing in
  the pack did; the writer never knows what the pack doesn't). League, women's,
  age-grade and sevens items are dropped; an item over 10 days old is
  BACKGROUND and may only be told as dated history. The checker fails a
  BACKGROUND item told as current, an unsourced head-to-head total (the
  app's meetings list is not complete), a result the form list doesn't show
  (that item is another team's: the 3 Oct "Ireland beat Japan" was the
  women's game), an invented quote, and league (the digest checker's own
  `LEAGUE_CHECK_RULE`). One revision, then the old story stays.
- **The arithmetic is done for the writer.** `scripts/rankings-stakes.mjs`
  turns rankings.json into "Rankings at stake": what each result does to
  both sides' points and places (a win by 15 or fewer, by 16+, a draw), each
  side's rank history, and for an `rnc-*` game the whole table with the gaps
  to the neighbours. The exchange formula was fitted to rankings.json's own
  history (five clean weeks of 2026, residual ≤ 0.006) and **carries no home
  advantage**, whatever the explainers say; `rankings-stakes.test.mjs` pins
  those real weeks, so a formula change fails a test before it misleads a
  reader. A rank is stated only where the table settles it: a side falling
  below the twelve's lowest nation reads "12th at best", because nations the
  app doesn't track may sit in between. The writer and checker are told to
  use the lines as printed and never recompute. Rights: a projection from the
  published table under a public formula, in prose; the same exposure class
  as the table itself (app repo `docs/DATA_RIGHTS.md`, 2026-10-01 entry).
- **Neutral grounds, venues and finals.** `scripts/host-overrides.mjs` rows
  can mark a game `neutral` (the 2025 PNC final in Salt Lake City; the vendor
  listed Japan at home and the first published story said Fiji won "in
  Japan") and carry a `venue` and a `stage` ("final": the vendor's league
  name says only "Knockout Stage"). The pack then says "neutral venue,
  neither side at home", names the ground, and flags "the same ground as
  this game" when the venues match.
- **The shadow run (21 Oct 2026) and the writer.** `scripts/storyline-
  shadow.mjs` wrote the seven upcoming fixtures on Gemini (free), Haiku 5.5,
  Sonnet 5.5, Opus 5.5 and Fable 5.1 from the same packs, with the Haiku
  checker on every draft: 35 stories, US$2.78, records and the method in
  `editorial/shadow-storylines/`. Opus 5.5 was the only writer with no
  material error on any first draft (7 of 7 published) and read best; Sonnet
  5.5 was accurate and plainer at half the price; Haiku read like the
  spreadsheet it came from and failed twice; Gemini invented a venue and an
  injury and failed twice; Fable 5.1 wrote the best single lines at four
  times Opus's price, failed twice and leaked "[2]" citation marks. The run
  also exposed four harness faults, fixed the same day: a 190-word cap every
  paid model overshot (17 of 35 first drafts revised on length alone; now
  150 asked, 200 allowed), a checker that called a winner-first scoreline
  ("a 40–21 defeat") reversed, a checker shown source URLs it could not see
  in the pack (it called them invented; it now sees the copy only), and copy
  about "the only meeting the app holds" (now a gate failure). Rerun it from
  Actions → "Storyline shadow (model comparison)" (inputs: models, days,
  fixture, cap, voice) or, from a cloud session that can't dispatch, by
  pushing a change to the harness on a `claude/*` branch with the inputs as
  commit trailers (`Shadow-Models:`, `Shadow-Days:`, `Shadow-Cap:`,
  `Shadow-Fixture:`, `Shadow-Voice:`); the workflow runs once and commits
  the records to that branch. The dispatch is capped at US$8 by default; a
  push without trailers runs one writer (Opus 5.5) under US$1, a smoke run
  for the edit, because any push touching the harness runs it (the #173
  push did, on all five writers: US$2.23). The markdown record lists every
  news item a pack carried, dated, so a run doubles as a probe of what the
  search found. `node scripts/build-storylines.mjs --force [--days N]
  [--fixture JPN-FIJ]` rewrites by hand after a prompt change.
- **The brief (the "voice").** Nico read the morning's stories as accurate
  wire-service previews and asked for "the dry wit", so `build-storylines.mjs`
  carries two briefs for the same pack and rules: `preview` (the checklist
  he approved on 20 Oct: history, form, stakes, news, a spice angle, 4–6
  beats) and `dry` (find the one angle first; the friend who knows the game,
  dry, exact, a touch of wit, never a hype man; places in words, never
  rating points — the gate refuses "85.56"; the people in the pack; 3–5
  beats). Two blind judges scored the same seven games three ways
  (`editorial/shadow-storylines/README.md`, the blind round): the preview
  brief 3.9/10, Opus on the dry brief 6.3, Fable on it 6.1, agreeing on the
  winner in all seven games; the preview won none. The dry brief is the
  default, a story written under the other brief is rewritten at the next
  run, and the same harness grades a new brief in fifteen minutes: write
  it as a third voice, push with `Shadow-Voice:`, and judge blind.
- **Cost.** Cached by pack hash: nothing is called while a game's facts are
  unchanged and its story is under 18 hours old; then the search runs and
  the story is rewritten only if the news list moved. A new result, ranking
  or kickoff rewrites at once; at most 12 stories a run. On Opus 5.5 about
  US$0.06 a story including the Haiku check (US$0.10 with a revision), so
  roughly US$0.10–0.50 a day in a test window, nothing between windows,
  ceiling ~US$1 a run; a November-sized month is about US$10–15. The Actions
  log prints `storylines spend`. Sonnet 5.5 halves it, Haiku 5.5 is a tenth.
- **Silent tier.** The step is continue-on-error and the script exits 0
  (`storylines skipped: …` in the log). The file is written only when a story
  changes or a game leaves the window; never hand-edit it, fix the input.
- The app needs a build to show it (a rendering change); the data itself
  then needs none.

## Alerts: who gets pinged

Nico does not review ops output; the scheduled **Claude weekly review** does
(Tuesdays 07:17 Sydney time all year: the routine's cron is in Sydney time, so it is
Monday 20:17 UTC in AEDT and 21:17 UTC in AEST). So
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

The weekly review reads `editorial/health/ops-status.md`, the newest
`editorial/health/<week>.md` and `editorial/source-candidates.md`, triages
the open silent issues, and is the only
other thing that escalates to Nico (its own "🚨 Weekly review <week>: …"
issue, raised only when something needs him).

Don't add an `@nico101rsa`, an `--assignee` or a default-on email anywhere
else. If a new check really is an outage, route it through the watchdog's
page tier and its "still down after a retry" rules. One caveat this can't fix
from code: if Nico watches the repo on "All activity", GitHub still notifies
him on every new issue, which is why the silent tier keeps issues for rare
data-correctness tickets and puts routine findings in files.

## News shadow test (6–12 Oct 2026) — closed

One week of production writer prompts replayed on paid models, recorded in
`editorial/shadow/` (`README.md` there has the method and the grading). It
decided the model split above on 11 Oct; its workflow steps were removed on
12 Oct. The records are public and were never fact-checked, which is why each
opens with a `notice`.

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

The vendor's home side isn't always the host either: SportsAPI Pro listed
Fiji at home for the 2026 PNC final in Tokyo, and the feed has no venue to
correct it from. `scripts/host-overrides.mjs` holds the hand-confirmed hosts
(key `"<UTC day> <VENDOR HOME>-<VENDOR AWAY>"`, applied only while the vendor
still says that), laid over both writers' output after the mirror.

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
