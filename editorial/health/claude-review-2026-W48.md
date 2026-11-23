# Claude weekly review — 2026-W48 (Tue 24 Nov 2026, Sydney time)

**Verdict: 🟢 round 6 landed right everywhere and the finals are set; the only open item is Aptabase, already with Nico in #212 (no new escalation).**

## Fixed this week
- Editor notes: four near-duplicate "the fixture is already played" notes of 22 Nov, which the writer reads every day, merged into one (8 notes down to 5). Data repo, no app build.

## Checks
- **A 🟢** Six finals in fixtures.json are ESPN's real rows: ITA v FIJ Sat 28 Nov 03:40, IRE v AUS 07:10, WAL v JPN Sun 29 Nov 00:10, ENG v NZL 03:40, SCO v ARG Mon 30 Nov 00:10, FRA v RSA 03:40 (grand final; 16:40 GMT, as Visit London lists it). The pairings match the final table (equal conference ranks). All 12 team calendars and all.ics carry the same times. Nothing else for any tracked nation before the Six Nations (Sat 6 Feb, Sydney time). No override needed.
- **B 🟢** All six round-6 games are FT in nations.json. No played row without a score left in fixtures.json.
- **C 🟢** check-competitions OK. Current is rnc-2026; expired seasons aren't offered; 42 fixtures (36 + 6 finals); no tries pending. The ESPN table compare couldn't fetch from here (proxy).
- **D 🟢** All six round-6 games are on both teams' pages, with the same scores as nations.json.
- **E 🟢** Snapshot refreshed and `npm test` 743/743. I did not commit the snapshot. `check:reminders` can't reach the CDN from here.
- **F 🟢** Data repo: 0 failures in 778 refresh runs; 31 queued runs cancelled behind the Sunday bursts, which is expected. "Deploy fans worker" failed twice on Sun 22 Nov at 11:02 and 11:05: the Durable Object free-tier row limit, the known outage, back at 11:29. Round 6 had 3 "[git] rebase conflicted", all real conflicts, each published on the next pass. There were **0 git identity errors**, so #210 is proven. TestFlight run on Sun 22 Nov at 12:11 built the newest app-code commit (1.3.18, 100). 1.3.18 is live in the stores.
- **G 🟡** RSA is No. 1 and agrees with history. "As of 16 Nov" predates round 6; Monday's World Rugby update lands at today's refresh.
- **H 🟢** ops-status OK since Sun 22 Nov 04:31, nothing paging. Repeat leads flagged Japan (21 Nov) and South Africa (19 Nov), both cleared. There are no unassigned issues; #212 and #167 sit with Nico.
- **I 🟢** Vendor probe healthy every night (91 entries). api-sports round 6: 91 → 44 remaining (47 calls), lowest at 10:02 Sun 22 Nov; the guard never tripped.
- **J 🟢** North star W46: 490.4 avg daily active devices, +72% WoW. The previous tournament week, W45, was 285.6. 4-week average 204.8, trend up, usage metric in use. W47: 1,014 installs after 6 of 7 days, against 2,219 in W46, so the November surge is tapering. Stats job green all week. 1.3.18 is out ahead of the vote-resend deadline (Wed 25 Nov, 11:00).
- **J2 🔴 (known)** Status ok, cookie 33 days old, but 199,110 of 200,000 events through Thu 19 Nov. It has been blank since the cap and stays blank until Tue 1 Dec 11:05, so `through` is 5 days old. The plan change is with Nico in #212 (PayPal blocks it). The export re-reads 42 days, so the gap heals once the tier lifts or the month resets.
- **K 🟡** Opus 5.5 writes, at US$1.2–1.9 a run (about US$1.6). Daily runs plus the Saturday extras come to roughly US$55 a month, against the US$24 ceiling. That is Nico's choice of 17 Nov, reviewed in the weekly email. No `failed`, no `fellBack`. Near-duplicate notes merged (above). No outlet is Ready.

## Watching
- Finals weekend (Sat 28 to Mon 30 Nov): live bursts from the fixtures.json finals rows, since nations.json has no finals until api-sports lists them. Also the fans Worker's row limit under a full weekend's votes.
- Aptabase from Tue 1 Dec 11:05.
