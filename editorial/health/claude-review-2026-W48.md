# Claude weekly review — 2026-W48 (Tue 24 Nov 2026, Sydney time)

**Verdict: 🟢 round 6 landed right everywhere and the finals are set; the only open item is Aptabase, already with Nico in #212 (no new escalation).**

## Fixed this week
- Editor notes: four near-duplicate "the fixture is already played" notes of 22 Nov, which the writer reads every day, merged into one (8 notes down to 5). Data repo, no app build.

## Checks
- **A 🟢** The six finals are ESPN's real rows (Sat 28 Nov 03:40 ITA v FIJ to Mon 30 Nov 03:40 FRA v RSA, which matches 16:40 GMT published), paired as the final table says. The calendars carry the same times. Nothing else before the Six Nations (Sat 6 Feb). No override needed.
- **B 🟢** All six round-6 games are FT in nations.json.
- **C 🟢** check-competitions OK. Current is rnc-2026; expired seasons aren't offered, 42 fixtures, no tries pending.
- **D 🟢** All six round-6 games are on both teams' pages.
- **E 🟢** Snapshot refreshed and `npm test` 743/743. `check:reminders` can't reach the CDN from here.
- **F 🟢** 0 failures in 778 refresh runs (31 queued runs cancelled behind bursts, benign). Fans-worker deploy failed twice on Sun 22 Nov at 11:02 and 11:05 (the Durable Object row limit, the known outage), green at 11:29. Round 6 had 3 real rebase conflicts, each published on the next pass, and **0 git identity errors**, so #210 is proven. TestFlight on Sun 22 Nov at 12:11 built the newest app-code commit (1.3.18, 100), now live.
- **G 🟡** RSA is No. 1 and agrees with history. "As of 16 Nov" predates round 6; Monday's World Rugby update lands at today's refresh.
- **H 🟢** ops-status OK since Sun 22 Nov 04:31, nothing paging. No unassigned issues.
- **I 🟢** Vendor probe healthy every night (91 entries). api-sports round 6: 91 → 44 remaining (47 calls), lowest at 10:02 Sun 22 Nov; the guard never tripped.
- **J 🟢** North star W46: 490.4 avg daily active devices (usage metric), +72% on W45, the previous tournament week. 4-week average 204.8, trend up. W47 installs 1,014 after 6 of 7 days against 2,219 in W46: the surge is tapering. Stats job green all week. Handoff on track.
- **J2 🔴 (known)** Status ok, cookie 33 days, but 199,110 of 200,000 events through Thu 19 Nov: blank since the cap, until Tue 1 Dec 11:05. Already with Nico in #212 (PayPal blocks the plan change). The export re-reads 42 days, so the gap heals.
- **K 🟡** Opus 5.5 writes at about US$1.6 a run, about US$55 a month against the US$24 ceiling: Nico's choice of 17 Nov. No `failed` or `fellBack`. Duplicate notes merged. No outlet Ready.

## Watching
- Finals weekend: live bursts run off the fixtures.json finals rows (nations.json has none yet), and the fans Worker's row limit.
- Aptabase from Tue 1 Dec 11:05.
