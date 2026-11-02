# Claude weekly review — 2026-W45 (run Tue 3 Nov 2026, 07:18 Sydney time)

**Verdict: 🟡 healthy, one item for Nico: four news outlets are Ready (and #167 still waits for a reply).** Data, tests, builds and spend are in order.

## Fixed this week
- Nothing to fix. No kickoff rows or registry changes needed. The live app snapshot was refreshed (app repo).

## Checks
- **A Coverage — ✅** Round 4 (Fri 6 – Sun 8 Nov) through Round 6 and the six projected finals rows are in fixtures.json. Web matches: IRE-ARG Fri 6 Nov 20:10 GMT, ITA-RSA Sat 11:40, ENG-AUS Sun 8 Nov 15:10 GMT (Mon 9 Nov 02:10 Sydney time). SCO-NZL 14:10 and the others had no published time to compare. No union-vs-vendor gap found, so no override row. calendar/*.ics DTSTART equals fixtures.json for all 12 team entries in the next 8 days.
- **B Stale state — ✅** No fixtures.json row more than 3h past kickoff without a score; no nations.json row past kickoff and not FT (the last tracked game was JPN-FIJ, 24 Oct).
- **C Registry — ✅** `check-competitions` OK. current=rnc-2026; pnc-2025, 6n-2026, pnc-2026 expired; 6n-2027 and rwc-2027 offered. Issue #168 (RNC window moved to 29 Nov) is informational and already reflected.
- **D Team pages — ✅** No tracked game was played in the last 7 days; the 24 Oct JPN-FIJ record matched on both teams last week.
- **E Reminders — 🟡** Live snapshot refreshed (93 + 18 rows); `npm test` 641/641 pass. `check:reminders` needs the CDN, which is blocked here, so it didn't run.
- **F Pipeline — 🟡** Last 7 days in the data repo: only 4 "pages build and deployment" failures (Sun 1 Nov, 20:00–20:45 Sydney time, ~20s each, Pages-side; later builds green). No failed data workflow runs. "[git] rebase conflicted" counts not read from logs. TestFlight: run 56 (Mon 2 Nov, #402, 1.3.14 (81)) succeeded and is the newest app-code build; runs 54 (licence agreement) and 55 (certificate cap) failed but Nico cleared both. 1.3.14 is WAITING_FOR_REVIEW. If the certificate cap returns, revoke the runner's "Created via API" Development certificate.
- **G Rankings — ✅** RSA 93.09 No.1, NZL 92.27, IRE 88.08; as of 26 Oct matches the newest timeline entry (19 Oct). No new rated results since.
- **H Ops log — 🟡** ATTENTION, not paging, nothing overdue. Only signal: repeat lead, Argentina (Isa recalled), and earlier Scotland, Italy, Japan, France. Ladder has spare capacity; no squad gaps. Open unassigned automated issue #168 is informational (left open).
- **I Vendor — ✅** vendor-probe-log healthy every night this week (all endpoints 200). First api-sports November live day is Fri 6 Nov; nothing to measure yet.
- **J Growth — 🟡** North star: avg daily active devices (ASC usage metric, not the installs fallback), W43 (19–25 Oct) 19 vs 10.1 in the last comparable test week W41 (+88%); WoW and 4-week average not yet available. Installs 121 (+124%), mostly GB. W44 was a quiet week (166 installs through 6 of 7 days). stats-report succeeded every night. Roadmap dated actions on track: 1.3.14 in review; Fri 6 Nov promotional text is Nico's.
- **J2 Aptabase — ✅** status ok, through 31 Oct, cookie age 12 days (warn from 15 Sep 2027), 866 / 20,000 events this month, quota not at risk.
- **K News — ✅** Haiku writes, Sonnet reviews. Spend US$0.15–0.19 a run (28 Oct – 3 Nov), about US$5 a month; 0 failed, 0 fellBack. editor-notes.md holds 3 distinct notes, no duplication. Four outlets are Ready (below).

## Watching
- Round 4 live days, Fri 6 – Sun 8 Nov: burst, team pages, api-sports budget.
- Finals-weekend listing on ESPN after Mon 23 Nov.
- Lead gate (data #181) grades by Mon 9 Nov.
- Whether `check:reminders` can run where the CDN is reachable.
