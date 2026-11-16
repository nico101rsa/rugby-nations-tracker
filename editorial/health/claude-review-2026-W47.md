# Claude weekly review — 2026-W47 (Tue 17 Nov 2026, Sydney time)

**Verdict: 🟡 round 5 landed right on every surface; Aptabase runs out before round 6 unless Nico moves up a tier (escalated).**

## Fixed this week
- A news outlet adopted through another outlet's feed host now reads "adopted": Midi Olympique (in `FEEDS` since 9 Nov, feed on rugbyrama.fr) still showed "Ready" and would have gone to Nico every week. Data fix, tested; the record flips at the next probe.
- Closed #189 (Nico took the 200k Aptabase plan on 10 Nov); this week's quota item replaces it.

## Checks
- **A 🟢** Round 6 (Sun 22 Nov, first kickoff 01:10) and the six finals (27–29 Nov) match the published times; nothing else for any tracked nation before the Six Nations (6 Feb). Calendars carry the same six kickoffs. No override needed.
- **B 🟢** nations.json: all 6 round-5 games FT. SCO v AUS sits scoreless in fixtures.json under the 24h grace and drops at today's build; by design.
- **C 🟢** check-competitions OK: current rnc-2026, expired ones not offered, no tries pending.
- **D 🟢** All 6 round-5 games on both teams' pages with the same score.
- **E 🟢** Snapshot refreshed, `npm test` 717/717. `check:reminders` can't reach the CDN from here.
- **F 🟡** Data repo, 1,884 runs: 4 failures (an ESPN 503 in the catch-up, now retried; a Pages deploy; two refresh startup failures on Thu 12 Nov about 07:30, self-healed); 75 refresh runs cancelled while queued behind a burst, benign. "[git] rebase conflicted" 29 times in the ten round-5 bursts: 23 were the missing git identity (fixed by #210, unproven until round 6), 6 real conflicts. TestFlight run 69 passed (Mon 04:34) on the newest app-code commit (#486); runs 65–68 hit the certificate limit, cleared by Nico.
- **G 🟡** No. 1 is RSA and agrees with history; "as of 9 Nov" predates round 5, and Monday's World Rugby update lands at today's refresh.
- **H 🟢** ops-status OK since Thu 12 Nov, nothing paging, no signals. No unassigned issues open.
- **I 🟢** Vendor probe: 85 entries, healthy every night. api-sports never neared the guard (floor 10): lowest remaining 35, Sun 15 Nov about 10:00.
- **J 🟢** North star W45: 285.6 avg daily active devices (24.1 the week before; first tournament week, so no comparable and no 4-week average yet), usage metric in use, trend up. W46 at 1,730 installs after 6 of 7 days. Stats job failed twice on Fri 13 Nov, both fixed. Handoff on track: "submit" for 1.3.17 is due Thu 19 Nov.
- **J2 🔴** Aptabase status ok, through Sat 14 Nov, cookie 26 days old, but `quotaAtRisk`: 177,999 of 200,000 events, about 12,000 a day. Escalated.
- **K 🟢** US$0.15–0.21 a run, about US$6–8 a month; no `failed`, no `fellBack`. Editor notes: 8, no near-duplicates. No outlet is waiting on Nico.

## Watching
- Round 6: zero identity errors in the burst logs; finals re-pairing at each full time.
- Aptabase after the tier decision.
