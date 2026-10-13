# Claude weekly review — 2026-W42 (Tue 13 Oct 2026, ~12:30 Sydney time)

**Verdict: healthy. Nothing is broken; one decision is for Nico: two Ireland news outlets are probed and ready to adopt (escalation filed).**

## Fixed this week
- Nothing needed fixing. No fixture, registry or team-page errors, so no code or data change.

## Checks
- **A ✅ Coverage.** Searched AUS v NZ (17 Oct), JPN v FIJ (24 Oct, 14:50 JST = 05:50 UTC) and the Nations Championship Rounds 4–6 (e.g. IRE v ARG Fri 6 Nov 20:10 Irish time, IRE v RSA 21 Nov 16:40). All match fixtures.json; no extra tests announced. AUS v NZ: kickoff row live (feed 04:45 UTC = 15:45 Sydney time) and `AUS.ics`/`NZL.ics` agree. Finals weekend (27–29 Nov) still waits for round 6.
- **B ✅ Stale state.** No test/series/tour row >3h past kickoff without a score; no nations.json row past kickoff+3h not FT. NZ 50–19 AUS (10 Oct) is on both feeds.
- **C ✅ Registry.** `check-competitions` OK; `current` is `rnc-2026`; expired competitions not offered; standings.json consistent.
- **D ✅ Team pages.** NZL 50–19 AUS appears for both teams with the same score; no other tracked-v-tracked game in 7 days.
- **E ✅ Reminders.** Snapshot refreshed from the live feeds (87 fixtures, 18 nations rows) and `npm test` passes 508/508. `check:reminders` can't reach the CDN from here (proxy), so it was not run. Snapshot left as committed.
- **F 🟡 Pipelines.**
  - "Refresh match data (cloudflare-worker)" failed in a storm: 36 runs, Fri 9 Oct 20:30 to Sat 10 Oct 20:00 Sydney time, then none (35 on 2 Oct, 21 on 25 Sep: three Friday storms in three weeks).
  - Cause (log of one run): "Commit and push" hits a rebase conflict on nations.json (a push race with the scheduled run, which kept landing the data). Harmless to data, noisy in the Actions tab; the #148 abort only covers the live burst.
  - The last 24h shows 43 successful Worker runs and no failures. 0 "[git] rebase conflicted" burst aborts found in the runs I could read.
  - App TestFlight run 36 (merge of #311, Tue 13 Oct 11:49 Sydney time) succeeded and matches the newest app-code commit `cf7d518`; the #309 build (run 35) succeeded on its retry. No certificate-limit error.
- **G 🟡 Rankings.** Live No. 1 RSA 93.09 agrees with the timeline; "as of 5 Oct" predates NZ 50–19 AUS (10 Oct). World Rugby's Monday update (12 Oct) isn't in yet (Wikipedia lag); the 21:00 UTC job should pick it up. Re-check next review if still 5 Oct.
- **H 🟡 Ops log.** ATTENTION, nothing paged. Only signal: Ireland's lead repeated since 11 Oct (quiet news week). Open issue #143 (ARG v ENG 18 Jul stats refused by the arithmetic gate, same match as #48): not resolved, left open; low priority.
- **I ✅ Vendor.** Probe healthy on all 6 nights this week (30 last / 7 next events). api-sports November guard: not applicable yet (first live day 6 Nov).
- **J 🟢 Growth.** North star = avg daily active devices (usage; no longer the installs fallback): W40 **10.9**, no WoW/4-week average yet (first usage week, quiet). Installs W40 47 (-8%); W41 (test week) 47 with 6/7 days. Roadmap dates on track: #309 and #311 merged; the build to test Thu 22 Oct is now the one #311 cut (run 36), not #309's; submit Mon 26 Oct.
- **K 🟡 News.** Spend: Haiku 11 Oct US$0.056, 12 Oct US$0.16 (28 Haiku + 1 Sonnet review), about US$5–8/month pace. failed 0, fellBack 0 on both. Editor notes: the last three days added near-duplicates about closing filler / ending on a fact. Source candidates Ready for Nico: The42 (Ireland, 17 stories) and RTÉ Sport (Ireland, 47). Nothing adopted.

## Watching
- Whether the Friday push-race storm recurs on 16 Oct (a test week: AUS v NZ is Sat 17 Oct).
- Rankings catching up with the 10 Oct result.
- Finals-weekend rows after 21 Nov; issues #143/#48.
- Candidates still being probed: Rugby World (feed works), FIJ/FRA/SCO sources (no feed found).
