# Claude weekly review — 2026-W38

_Run 2026-09-14 20:30 UTC (Tue 06:30 AEST) in the session that set it up. First edition._

**Verdict: healthy — nothing needs Nico this week.** The Pacific Nations Cup gap that prompted this review is closed end to end, every pipeline is green, and the feeds agree with the announced calendar for the next eight weeks.

## Fixed this week

- **#108** registered the Pacific Nations Cup (declared knockout, side competition, season read from fixtures). **#110** scores and keeps its games like tests; the semi-final finals (FIJ 45–29 CAN, JPN 63–14 USA) landed in `fixtures.json` on the first refresh tick.
- **#109** stops the team-events push race that killed the Saturday runs on 5 and 12 Sep (`-X theirs` on the fallback rebase).
- App **#278/#279**: "Pacific Nations Cup" caption, side comps kept off the default view, PNC games on Results and the live strip. Shipped as TestFlight **1.3.6 (53)** and **(54)**; **1.3.6 (54) submitted for App Store review** on 13 Sep (#280), state WAITING_FOR_REVIEW.

## Checks

- **A Coverage** ✅ — every announced game for the 12 nations to 9 Nov is in the feed, correctly tagged: PNC final and 3rd place (19 Sep), AUS v RSA (27 Sep), Bledisloe 10/17 Oct, JPN v FIJ (24 Oct), NC round 4 (6–8 Nov, kick-offs match). No Six Nations side plays before November.
- **B Stale state** ✅ — no row past kickoff+3h without a score or full-time status.
- **C Registry** ✅ — `current` rnc-2026; pnc-2026 offered to 3 Oct; keys match fixture years; integrity check prints OK. `trc-2026` sits as an empty "announced" shell (see Watching).
- **D Team pages** ✅ — RSA 43–28 NZL (Baltimore, 12 Sep) on both records with the same score; JPN and FIJ PNC wins present. Daily runs 78/79 and all catch-up runs green.
- **E Reminders** ✅ — 282/284 app tests pass against the 14 Sep feed shape; the two failures assert August-specific series legs (date assumptions, not shape). Coverage and dedupe assertions pass. `check:reminders` needs the CDN, unreachable from the sandbox.
- **F Pipelines** ✅ — last 7 days: refresh-data 100/100, digests 23/23, news 47/47, rankings, stats, vendor probe, watchdog, weekly health all green; team-events 1 failure (#77, the race #109 fixed). Crons run ~4.5 h late; harmless. TestFlight run 29 matches the last app-code commit on main.
- **G Rankings** ✅ — live No. 1 RSA (as of 7 Sep) agrees with the stats' open spell from 31 Aug; NZL's 2026 spell is in the timeline, so its "2026" best-year is supported. Closed **#90** and **#102**.
- **H Issues** ✅ — W37 report folded in (1 of 18 box scores refused, digests B+). Closed superseded weekly reports W29–W34. Open: #105, #107 (reports), #106 (vendor), #48 (old stats gap).
- **I Vendor** 🟡 — SportsAPI Pro probe returned 503 on NZL endpoints on 10, 11 and 14 Sep; RSA endpoints fine; team-events fetches still succeeded. Not worse than last week, not better.

## Watching

- Perth kick-off: feed says 17:45 AWST; the Wallabies' own post says 17:30. Re-check when ESPN settles it.
- `trc-2026` "announced" with no fixtures: an empty ESPN season shell (no Rugby Championship in 2026). Not selectable, cosmetic.
- The two date-pinned reminder tests will fail on any refreshed snapshot; re-base them once the NC finals are in.
- One listing puts Italy v South Africa in La Nucía, Spain; World Rugby, ESPN and Sky say Turin, as does the feed.
