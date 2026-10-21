# Storyline shadow runs

Side-by-side trials of the fixture-storyline writer (`scripts/build-storylines.mjs`
→ `storylines.json`, shown under upcoming games in the app's Fixtures tab).
Nothing in this folder reaches the app, and the app never reads it. The repo is
public and GitHub Pages serves all of it, so every record opens with a
`notice`: the drafts were fact-checked against the app's own data only, never
against the world, and may be wrong about real people and events.

## What a run does

`scripts/storyline-shadow.mjs` builds the fact pack for every unplayed game
with a tracked side in the window (default 20 days) exactly as production
does — repo data, the news pool, the search widener and the article text —
and sends production's exact writer prompt to each writer. Production's
checker (Haiku 5.5 unless `DIGEST_CHECKER_MODEL` says otherwise) fact-checks
every draft under the same one-revision rule, so a writer is judged on what
it would have published, and its first draft's verdict is a quality signal
that costs no human time.

Each `<stamp>.json` (the Sydney date and time the run started) keeps, per
writer and fixture: the first draft, the format gate, the first fact-check
verdict, the revision if any, the final story, tokens, cost at list price
(`scripts/compare-digest-models.mjs`) and wall time, plus the trusted facts
of each pack and the news items' titles and links. The pack text and the
article bodies — publishers' copy — are never kept; the pack's sha256 and
length are. `<stamp>.md` is the same record for reading.

Run it from Actions → "Storyline shadow (model comparison)" (inputs: models,
days, fixture, cap), or push a change to the harness on a `claude/*` branch
with the inputs as commit trailers (`Shadow-Models:`, `Shadow-Days:`,
`Shadow-Cap:`, `Shadow-Fixture:`); the workflow runs once and commits the
records to that branch. A writer without a price in
`compare-digest-models.mjs` is refused, and the run reserves every writer's
worst case against the cap (US$8 by default) before each fixture.

## 21 Oct 2026 — `2026-10-21-0725`

Seven fixtures (Japan v Fiji on 24 Oct and the six Round 4 Nations
Championship games of 7–9 Nov) on Gemini (free ladder), Haiku 5.5, Sonnet
5.5, Opus 5.5 and Fable 5.1: 35 stories, US$2.78, ten minutes.

| Writer | Published | First-draft material errors | Cost per story | Read |
|---|---|---|---|---|
| Gemini | 5 of 7 | 6 (an invented venue, an injury told as a Test ruling, a "lowest of the season") | free, 79 s | lively, least reliable |
| Haiku 5.5 | 5 of 7 | 3 (one real) | US$0.006 | a spreadsheet read aloud; "the app holds" everywhere |
| Sonnet 5.5 | 6 of 7 | 2 (both the checker's own fault, below) | US$0.047 | accurate, plain, stakes-led |
| Opus 5.5 | 7 of 7 | 0 | US$0.085 | best: "This time it counts"; used the tries data |
| Fable 5.1 | 5 of 7 | 3 (one real) | US$0.257 | best single lines, leaked "[2]" citation marks, one draft too long twice |

**Decision:** Opus 5.5 writes the storylines (`STORYLINE_DEFAULT_WRITER` in
`build-storylines.mjs`; the repository variable `STORYLINE_WRITER_MODEL`
overrides it). With the harness faults below fixed its revisions mostly go
away, so a story costs about US$0.06 including the check — a few dollars in
a test month.

**Harness faults the run exposed, fixed the same day (PR #171):**

1. The 190-word cap: every paid model landed at 191–236 words on the richer
   pack, so 17 of 35 first drafts were revised on length alone, each a paid
   second call. The prompt now asks for about 150 and the gate allows 200.
2. The checker called a winner-first scoreline ("a 40–21 defeat to New
   Zealand") a reversed score and failed three stories on it, two of them
   twice. It is told the convention now.
3. The checker was shown the draft's source URLs, which the pack text does
   not carry, and called them invented. It now sees the copy only; the
   sources are code-checked.
4. "The only meeting the app holds" and its kin leaked into every writer's
   copy. The gate now fails any mention of the app or its records.

## 21 Oct 2026 — `2026-10-21-0744`, the confirmation

The same seven fixtures on Sonnet 5.5 and Opus 5.5 with faults 2–4 fixed:
14 stories, US$0.96, five minutes. Both 7 of 7 published with no material
error on any first draft; Opus 3 first time, Sonnet 1. The remaining
revisions were length again — first drafts of 203–232 words against a
stated cap of 200 with "about 150" asked. Writers write to the ceiling they
are given and overshoot it, so from this run the prompt states 170 and the
gate enforces 200; the overshoot lands inside the gate and the second call
is saved. One checker misread was also fixed: a clipped conditional headline
("Wallabies win and they leapfrog England into 5th") taken as a result
reported before the game.

Opus 5.5 stays the writer: US$0.086 a story in this run with four length
revisions, about US$0.06 without them. Sonnet 5.5 at US$0.051 (US$0.03
without its six) was accurate and stakes-led, and the frugal choice if the
bill ever matters.

## 21 Oct 2026 — `2026-10-21-1027` and the blind round: the dry brief

Nico's read of the morning's runs: accurate, but wire-service previews —
the same skeleton every game and no line worth repeating — and the register
he wants is dry and knowledgeable with a touch of wit. A second brief for
the same pack and the same rules ("dry": find the one angle first, a stated
voice, places in words rather than rating points, the people in the pack,
three to five beats with room to turn) was written and run on Opus 5.5 and
Fable 5.1 over the same seven fixtures: 14 stories, US$1.69, both 7 of 7
with no material error (Opus 7 first time; Fable one length revision).

Two judges, Claude Opus 5.5 and Claude Sonnet 5.5 in separate sessions,
then scored the three versions of each game — Opus on the preview brief
(`2026-10-21-0751`), Opus dry and Fable dry — labelled A, B and C in a
shuffled order per game with no model or brief named, on hook, voice,
specificity and cliché (1–5) and overall (1–10). `2026-10-21-blind.json`
holds the key, every score and the judges' notes.

| Version | Hook | Voice | Specificity | Cliché | Overall /10 | Games won |
|---|---|---|---|---|---|---|
| Opus 5.5, preview brief | 2.4 | 2.0 | 2.9 | 2.4 | 3.9 | 0 |
| Opus 5.5, dry brief | 3.4 | 3.6 | 3.7 | 3.9 | 6.3 | 4 |
| Fable 5.1, dry brief | 3.2 | 3.4 | 3.7 | 3.6 | 6.1 | 3 |

The judges agreed on the best version in all seven games, and the preview
brief won none. Between the two dry versions the writers were a coin toss
at three times the price, so **production runs the dry brief on Opus 5.5**
(`STORYLINE_DEFAULT_VOICE`; the repository variable `STORYLINE_VOICE=preview`
brings the checklist back, and a story written under the other brief is
rewritten at the next run). What the judges still marked down in the dry
versions, for the next iteration: a first beat that restates the headline, a
rankings beat that covers three outcomes instead of one, and the odd wire
tic ("Fifty-two weeks after"). One caveat: the judges are the writers'
relatives, and a model may favour its own prose; the agreement between two
of them and the size of the gap are the reasons to trust the order.

## 21 Oct 2026 — `2026-10-21-0751`, the preview brief at its best

Opus 5.5 alone on the same seven fixtures with the 170-stated, 200-enforced
gap: first drafts of 163–185 words, 6 of 7 passed first time, 7 of 7
published, US$0.455 — US$0.065 a story, 23 seconds each. The one revision
was a real catch: the checker failed a headline calling Fiji "winless" in
2026 (they beat Canada 45–29 on 12 September), and the rewrite passed. This
was production for a morning; the blind round above replaced the brief the
same day, keeping the writer, the gate and the checker.

## The second blind round (21 Oct, evening): dry against dry2

The judges' three notes on the dry stories became the `dry2` brief: the
angle held from the headline to the last line, a first beat that carries a
fact the headline did not give, one outcome in one sentence inside a rugby
beat, scores with the point they make, a name only with the thing that makes
it matter, three to four beats, an ending that lands. The harness then wrote
both briefs on Opus 5.5 from the same seven packs (`2026-10-21-2055`: 14
stories, US$1.01; dry 7 of 7 first time, dry2 7 of 7 with four length
revisions, a 62-character headline among them), and the same two judges
scored each pair blind, A and B shuffled per game (`2026-10-21-blind2.json`).

| Version | Hook | Voice | Specificity | Cliché | Overall /10 | Verdicts won (of 14) |
|---|---|---|---|---|---|---|
| Opus 5.5, dry brief | 3.2 | 2.8 | 2.9 | 2.7 | 4.6 | 0 |
| Opus 5.5, dry2 brief | 4.0 | 3.8 | 3.9 | 4.1 | 6.9 | 14 |

Both judges picked dry2 in all seven games. What they praised is what the
brief asked for: an angle a fan would say aloud, every detail chosen to serve
it, and a last line that turns it ("Scotland do not really do static",
"fluent in that kind of defeat", "a margin is worth more than a lesson").
What they still marked down in dry2: an opening beat of appointments-desk
detail, a squad-news sentence in press-release register, an ending that bolts
a quote onto travel plans. **Production runs dry2 on Opus 5.5** from the
merge; a story written under dry is rewritten at the next run. The dry
stories scored 6.3 in the morning round and 4.6 here because a judge scores
against the other version on the page, not because the stories got worse.
Same caveat as before: the judges are the writer's relatives.
