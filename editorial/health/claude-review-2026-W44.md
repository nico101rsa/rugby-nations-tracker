# Claude weekly review — 2026-W44 (run Tue 27 Oct 2026, 07:18 Sydney time)

**Verdict: 🟡 healthy, nothing needs Nico.** Data, ranks, tests and spend are in order; the only soft spots are checks this cloud session can't make (CDN reminder coverage, per-run log reads).

## Fixed this week
- Nothing to fix. No kickoff rows needed, no registry changes.

## Checks
- **A Coverage — ✅** Rounds 4–6 and the six projected finals rows are all in fixtures.json (24 rnc-2026 rows from Fri 6 Nov). Round 4 kickoffs match the web: IRE-ARG 20:10 GMT, ITA-RSA 11:40, SCO-NZL 14:10, WAL-JPN 16:40, FRA-FIJ 20:10, ENG-AUS 15:10 (Sun 8 Nov). No union-vs-vendor gap found, so no override row. Venue for ITA-RSA is Turin in the feed; one ticket site says La Nucia, rugby.com.au says Turin. No tracked game is in the next 7 days, so calendar/IRE.ics was checked against the 6 Nov row (20:10Z, matches).
- **B Stale state — ✅** No fixtures.json row more than 3h past kickoff without a score; nations.json has no unplayed row past kickoff.
- **C Registry — ✅** `check-competitions` OK. current=rnc-2026; pnc-2025, 6n-2026, pnc-2026 expired; 6n-2027 and rwc-2027 offered.
- **D Team pages — ✅** JPN 28–34 FIJ (24 Oct) is in both teams' records with the same score. No other tracked-v-tracked game in the last 8 days.
- **E Reminders — 🟡** Live snapshot refreshed (93 + 18 rows, not committed); `npm test` 646/646 pass. `check:reminders` needs the CDN, which is blocked here, so it didn't run.
- **F Pipeline — 🟡** The last ~10h of data-repo runs (100) were all green (refresh-data, catch-up, digests, harvest, probe). Older failures and "[git] rebase conflicted" counts were not read from logs this week; ops-status shows nothing overdue. TestFlight: newest run (#52, 26 Oct, 079f1d8, #383) succeeded and is the newest app-code commit; later app commits are docs/stats. 1.3.12 (77) is in App Review.
- **G Rankings — ✅** RSA 93.09 No.1, NZL 92.27, IRE 88.08; as of 19 Oct, updated 26 Oct, so the 19 Oct update landed. Best-years not examined in depth.
- **H Ops log — 🟡** ATTENTION, not paging, nothing overdue. Only signal: repeat lead, Ireland (Farrell's 36-man squad). Model ladder has spare capacity; no squad gaps. No unassigned automated issues triaged this run.
- **I Vendor — ✅** Nothing flagged; JPN-FIJ landed on 24 Oct. No api-sports November live days yet.
- **J Growth — 🟡** North star (avg daily active devices, ASC usage metric, not the installs fallback): W41 10.1, -7% WoW; W42 14.4 (partial), installs 54, ±0%. Rolling-4 not yet available; no earlier test week to compare. stats-report succeeded every night this week; usage keys present. Roadmap actions on track: 1.3.12 submitted Mon 26 Oct.
- **J2 Aptabase — ✅** status ok, through 24 Oct, cookie age 6 days (warn from 15 Sep 2027), 7,102 / 20,000 events this month, projected 8,900, quota not at risk.
- **K News — ✅** Haiku writes, Sonnet reviews. Spend per run US$0.13–0.18 (20, 26, 27 Oct), about US$5 a month. 0 failed, 0 fellBack. Source candidates: none Ready (Rugby Australia, Rugby365, RNZ Sport still being probed, no feed found yet). Editor-notes duplication not re-examined.

## Watching
- Round 4, Fri 6 – Sun 8 Nov: live burst and team pages; first November api-sports live day.
- Finals weekend listing on ESPN after Mon 23 Nov.
- ITA-RSA venue wording.
- Whether `check:reminders` can run where the CDN is reachable.
