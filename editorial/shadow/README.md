# News shadow test, 6–12 Oct 2026

A one-week side-by-side trial of a paid news writer, run before paying for one
(Nico's decision 3, 4 Oct 2026, in `docs/GROWTH_STRATEGY.md` in the app repo).
Nothing in this folder reaches the app. The app never reads it, and the
shadow step never touches `nations.json`. It is **not private**, though: this
repo is public and GitHub Pages serves all of it (`.nojekyll`, so no path can
be left out). The drafts here were never fact-checked and may be wrong about
real people, so every record opens with a `notice` field that says so.

## What runs

- **When:** after the first production digest run of each Sydney date from
  6 to 12 Oct 2026. That is usually the 20:00 UTC run (07:00 AEDT). On Sunday
  11 Oct it is the Saturday 17:00 UTC match-day extra (04:00 AEDT Sunday),
  because that run comes first. The script stops itself after 12 Oct.
- **What:** the writer step only. Production (`scripts/generate-digests.mjs`)
  records each team's exact first-draft writer prompt in the runner's temp
  directory: the template, the standing editor notes, the "already reported"
  block and the day's source pack. `scripts/news-shadow.mjs` sends that same
  prompt to the paid model, once per team. There is no fact-check, no
  revision and no roundup. The prompt itself is **not** committed, because it
  carries article text from publishers and this repo is public. Each team's
  record keeps the prompt's sha256 and length instead.
- **Model:** the Sonnet entry in `scripts/compare-digest-models.mjs` (`MODELS`,
  exported as `SONNET`). The repository variable `SHADOW_MODEL` overrides it,
  but only with a model that has a price in that table. The spend guard needs
  a price, so an unpriced model is refused.
- **Output ceiling:** 12,000 tokens a call, production's own figure for this
  model. Thinking counts against it and bills as output; at 8,000 a
  long-thinking team could stop before writing its JSON, be paid for anyway,
  and count as "invalid" against the paid writer.
- **Caps:** before each request, the guard adds that request's worst case
  (input over-counted at 2 characters a token, plus a full 12,000 output
  tokens, about US$0.15 for a typical prompt). It makes the request only if the
  total stays within **US$1.50 a run** and **US$9 for the window**. Retries are
  made by the script, not the SDK, so each attempt (up to 3 a team) passes the
  guard and reserves its own worst case; one that gets no answer (timeout,
  dropped connection) keeps it on the books, because it may have been billed.
  Output is capped hard by `max_tokens`, so a cap can only be passed if a
  prompt beats the input over-count, and the guard then plans on the dearest
  call so far. A team with no answer on all 3 attempts stops the run. The
  strategy's estimate (US$12–24 a month for this writer) comes to roughly
  US$0.40–0.80 a run, or US$3–6 for the week. Measuring the real figure is
  half the point.

## `<date>.json`

| field | meaning |
|---|---|
| `teams[].production.firstDraft` | Gemini's first draft from the same prompt, before fact-check |
| `teams[].production.firstCheck` | that draft's first fact-check verdict and its number of material issues |
| `teams[].production.revisions` / `.published` / `.failed` | what production then did: revisions, the edition it published (before the roundup), or why it failed |
| `teams[].shadow.draft` | the paid writer's draft, after the same `validateDigest` gate production uses (`null` if it failed the gate) |
| `teams[].shadow.valid` / `.errors` / `.rawTail` | whether the draft passed the gate, and why not |
| `teams[].shadow.usage` / `.costUSD` / `.seconds` | tokens (thinking bills as output), cost at the table's prices, wall time |
| `teams[].shadow.attempts` / `.failedAttempts` | how many requests the team took, and why any failed (an `.error` team got no draft at all; `.retryRefused` says a retry was stopped by the cap or the time budget) |
| `teams[].shadow.stopReason` | `max_tokens` means the answer was cut off at the ceiling, not that the writer failed the format |
| `teams[].shadow.sameLeadAsProductionFirstDraft` | whether both writers led with the same shortlist candidate |
| `counts`, `cost` | the day in totals; `cost.windowAfterUSD` is the running total for the week |

## How the weekly review compares them

The Claude weekly review on **Tue 13 Oct (07:30 AEDT)** has the whole week.
Earlier reviews can report progress.

1. **Reliability and cost** come straight from the JSON:
   - How many shadow drafts passed the gate each day, against production's
     first-draft fact-check passes (`firstCheck.verdict`) and published editions.
     Count `shadowValidWhereProductionFailed` separately, because the free
     writer's failures are the reason for this test (Gemini is on its last
     fallback model).
   - Cost per team and per run. Project a month as the mean `cost.runUSD` ×
     the number of writer runs a month: about 30 daily runs plus about 16
     Saturday extras. Fact-check revisions would add writer calls on top.
     Compare the result with the strategy's US$12–24 a month.
   - Format: `words` (the contract is a 10–12-word heading and a 55–90-word
     body), and how often the two writers chose the same lead.
2. **Quality** uses the daily review's own rubric (`buildReviewPrompt` in
   `generate-digests.mjs`), so both writers are judged by the grader that
   already judges production. For each date run:

   ```
   node scripts/news-shadow.mjs --grade 2026-10-07
   ```

   This prints two prompts, **Set X** and **Set Y**: that day's first drafts
   from each writer, labelled blind. Grade both sets the way the prompt asks
   (a letter grade, the two or three observations that matter, and
   retrieval-starved against badly-chosen). Ignore the `prompt_notes` /
   `source_notes` fields, because nothing here feeds back into production.
   Only after grading both, run `--key 2026-10-07` to see which set was which.
   The grader sees each shortlist but not the article bodies. Judge facts on
   what can be checked (internal consistency, the shortlist, the app data in
   the prompt) and say so. The shadow drafts were never fact-checked.
3. **Write it up** as a "News shadow test" section in that week's
   `editorial/health/claude-review-<week>.md`. Cover the days covered, the
   reliability counts, the mean grade for each writer after unblinding, the
   cost per team, run and projected month, and a one-line recommendation.
   This is the input Nico asked for. If it confirms the plan (switch the
   writer), say so; the switch is its own change. If it argues against the
   plan (the paid writer is no better, is unreliable, or projects above
   US$24 a month), that needs Nico, and it goes in the review's escalation
   issue.

## After the week

Delete the three "News shadow test" steps and `DIGEST_PROMPTS_DIR` from
`.github/workflows/generate-digests.yml`. Keep these records, and leave
`scripts/news-shadow.mjs` and its test in place (the test checks the workflow
with or without the steps, so the cleanup cannot fail the digest run). The
steps are harmless if they are left in, because they skip themselves, but they
are dead weight.
