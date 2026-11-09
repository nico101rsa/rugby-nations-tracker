# Claude weekly review — 2026-W46 (Tue 10 Nov 2026, Sydney time)

**Verdict: 🟡 data healthy, round 4 landed cleanly; Aptabase is over its free quota (needs Nico) and four ready news outlets were adopted.**

## Fixed this week
- Adopted Rugbyrama, Midi Olympique, OnRugby and Islands Business into `FEEDS` (Nico's standing yes of 3 Nov; Islands Business gets a rugby topic filter). Data fix, live at the next harvest; tests 972/972.
- Closed #168 (competition window move; fixtures match it) and #183 (its four outlets are now adopted).

## Checks
- **A 🟢** Every tracked nation's next 8 weeks (rounds 5–6, finals weekend 27–29 Nov projected) match fixtures.json; calendars carry the same kickoffs for FRA, WAL, SCO. No override needed.
- **B 🟡** ENG v AUS (8 Nov, FT 45–22 in nations.json) still sits in fixtures.json without a score: the 24h played-grace, so it drops on the next build after 15:10 UTC Mon. By design, nothing missed.
- **C 🟢** check-competitions OK: current = rnc-2026, expired ones not selectable, 36 rnc fixtures.
- **D 🟢** All 6 round-4 games (6–8 Nov) are on both teams' team-events with mirrored scores.
- **E 🟢** Live snapshot refreshed, `npm test` 646/646. `check:reminders` can't reach the CDN from here (known).
- **F 🟡** Data repo: 100 most recent runs all green except 1 Pages deploy failure (18:16 UTC) and 1 cancelled, both superseded by later green ones. App repo: newest TestFlight (run 57, 3 Nov, #411) succeeded and is the newest app-code commit; later commits are docs. 0 "rebase conflicted" seen. The app repo's "Rugby data archive" has failed daily since 6 Nov at its "Surface harvest errors" step (the harvest and publish steps pass; log not readable from here).
- **G 🟢** rankings.json No. 1 is RSA, agrees with history; as-of 3 Nov is the latest before round 4 (the Monday update will move it).
- **H 🟡** ops-status ATTENTION, not paging: Argentina repeat lead since 8 Nov (novelty gate flagged, published). Squads and ladder fine. Open issues: only the two Nico-assigned reviews.
- **I 🟢** Vendor probe 78 entries, latest healthy (all 200); no failures in the last 14. api-sports guard not directly checkable here; 46 cron-worker refreshes all succeeded.
- **J 🟡** North star W44: 24.1 avg daily active devices (+27% WoW, +121% vs last quiet week W40), usage metric in use, trend up. W45 (6 tests) in progress at 2,154 installs. Handoff dates on track; two decisions await Nico (line-ups build, architecture candidate).
- **J2 🔴** Aptabase status ok, through 7 Nov, cookie 19 days old, but `quotaAtRisk`: 81,331 events this month against a 20,000 free limit (projected ~314k). Escalated.
- **K 🟢** Spend ~US$0.17–0.22 a run (Haiku ~0.07–0.10, Sonnet 0.1), ~US$5–6/month, no `failed` or `fellBack`. editor-notes: 8 notes, no near-duplicates. Four Ready outlets adopted; five still probing, none ready.

## Watching
- Round 5 (13–15 Nov): ENG v AUS drop from fixtures.json, rankings move, finals pairings.
- Archive workflow failures; Aptabase quota decision.
