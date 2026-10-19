# Claude weekly review — 2026-W43 (Tue 20 Oct 2026, Sydney time)

**Verdict: 🟢 healthy, one item for Nico: seven news outlets are Ready and the daily grades have slid (B- to C-).** No data fixes were needed.

## Fixed this week
Nothing needed fixing this run. (Overnight 19–20 Oct, data #164 landed the league-news filter and Nations Championship window fix.)

## Checks
- **A Coverage — 🟢** Next 8 weeks: JPN v FIJ Sat 24 Oct (feed 05:50 UTC = 14:50 JST, matches JRFU), all 18 RNC games present with union-matching kickoffs. Finals weekend (27–29 Nov) is not in any feed yet; recheck 22–26 Nov, any override row by Thu 26 Nov. calendar/JPN.ics carries JPN v FIJ at 05:50 UTC, same as fixtures.json. No override rows needed.
- **B Stale state — 🟢** No fixtures.json row >3h past kickoff without a score; no nations.json row past kickoff+3h that isn't finished.
- **C Registry — 🟢** `check-competitions` OK: current = rnc-2026, expired ones not selectable, counts match. Issue #165 (finals vanish until ESPN lists them) is open, Claude-raised, known.
- **D Team pages — 🟢** AUS v NZL (17 Oct) on both teams, 21–43 / 43–21.
- **E Reminders — 🟡** Snapshot refreshed, `npm test` 536/536 pass. `check:reminders` can't reach the CDN from here (proxy), so reminder coverage against the live CDN was not run.
- **F Pipeline — 🟢** Last 7 days, 2 real failures, both Sat 17 Oct: Team events and Team events catch-up, the known SportsAPI Pro 429 day (recovered overnight). 3 Pages deploy failures on 15 Oct (GitHub platform, self-cleared) and 6 cancelled Pages builds 19 Oct (superseded). No "[git] rebase conflicted" seen in the failure list. TestFlight: newest build (#330, dde69ed, success) is the newest app-code commit; later commits are docs/scripts.
- **G Rankings — 🟡** RSA No.1 (93.09), NZL 2nd (91.81), asOf 12 Oct. The 17 Oct AUS v NZL result can't lift NZL past RSA; the 19 Oct World Rugby update should land at the next run. Best-years not examined in depth.
- **H Ops log — 🟡** State ATTENTION, nothing paging, nothing overdue. Only signal: repeat lead (Italy, since 18 Oct). No open unassigned automated issues (the only open one is #165).
- **I Vendor — 🟢** vendor-probe healthy every night 12–19 Oct. Watch Sat 24 Oct for 429s. api-sports: no November live days yet.
- **J Growth — 🟡** North star (avg daily active devices, usage metric from ASC): W41 10.1, -7% WoW; installs 54 (+15%). 2026-W42 still in progress. ASC usage keys are present. Roadmap dated actions are on track (1.3.9 still in review; expedite check Wed 21 Oct is Nico's).
- **K News — 🟡** Spend US$0.16–0.19 a run (14–20 Oct), about US$5–6 a month, inside budget; 0 failed, 0 fellBack. Editor notes: 8 lead-selection notes overlap heavily (all "prefer fresh men's national-team item"), worth pruning. Seven outlets Ready (see below).

## Watching
- Sat 24 Oct JPN v FIJ result on team pages (429 risk).
- Rankings refresh after the 19 Oct World Rugby update.
- Finals weekend listing on ESPN, 22–26 Nov.
- Daily grades: B- on 12 Oct, C- on 19 Oct.
