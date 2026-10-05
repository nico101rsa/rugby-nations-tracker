# Claude weekly review — 2026-W41 (Tue 6 Oct 2026, 07:18 Sydney time)

**Verdict: healthy. One real bug fixed (the lead-story repeat check couldn't read Bing links); nothing needs Nico, so no escalation issue.**

## Fixed this week
- **#137 Novelty: unwrap Bing News redirects** (data fix, live from the next digest run). Bing redirect links all compared as one link, so Scotland's repeated lead (4–5 Oct) slipped through. Test added; 603 pass.
- **App #291**: skill records Apple's real usage report names (doc only).
- **Closed #106** (SportsAPI Pro down): probe healthy 6 of the last 7 nights.

## Checks
- **A 🟡 Coverage.** No wrong or invented games through 1 Dec. AUS v NZ 17 Oct (feed 16:00, stadium 15:45) is already in `kickoff-overrides.js`. Finals weekend (27–29 Nov) waits for round 6's pairings (21 Nov); the app shows projected finals meanwhile.
- **B ✅ Stale state.** No fixtures or nations rows past kickoff + 3h without a result.
- **C ✅ Registry.** `check-competitions` OK; current `rnc-2026`; nothing expired is offered.
- **D ✅ Team pages.** AUS 42–38 RSA on both sides; no tracked-v-tracked game since.
- **E ✅ Reminders.** Today's feeds: 105 matches, 0 coverage gaps; 432 app tests pass on the committed snapshot. Three coverage tests are pinned to that snapshot's date (they fail on a fresh one), so it stays as committed — upkeep, not a regression.
- **F 🟡 Pipelines.**
  - Two Worker refresh runs (06:15, 06:30) were superseded pending runs (by design).
  - The Worker's 06:00 digest dispatch never got a runner (cancelled after 15 min, GitHub-side); today's edition waits for GitHub's own cron, usually ~2.5h late.
  - Two ghost queued runs from Aug/Sep can't be cancelled from here (403); harmless.
  - TestFlight #33 is green and matches main's last app-code commit.
- **G ✅ Rankings.** As of 28 Sep (after AUS v RSA): RSA 93.09, NZL 91.15. No tests since.
- **H 🟡 Ops log.** ATTENTION, nothing paged.
  - Ireland's lead has repeated since 3 Oct (flagged, published after a failed revision; quiet news week).
  - Scotland's repeat was missed; fixed in #137.
  - #106 closed; #48 (ARG v ENG stats, July) open, low priority.
- **I ✅ Vendor.** Probe healthy 6 of 7 nights (one NZL/next 503 on 30 Sep). The `data.events` fix shows real counts (30 last / 7 next).
- **J 🟢 Growth.**
  - North star is still the installs fallback: W39 **51** (+96% vs the last test week, W38 at 26), 4-week average 32.8, trend up.
  - W40, a quiet week, has **41 installs with 6 of 7 days in**, the best quiet week since July.
  - Apple usage now flows: W39 15.4 avg daily active devices in a 38% opt-in sample (~40 real users a day, ~500 sessions a week).
  - On track: the November build shipped 17 days early; Nico's Sun 11 Oct steps are outstanding.

## Watching
- Today's digest edition and the first news-shadow run (`editorial/shadow/2026-10-06.json`).
- Whether the north star switches to usage next week.
- Finals-weekend rows after 21 Nov.
- Issue #48.
- The two ghost queued runs.
