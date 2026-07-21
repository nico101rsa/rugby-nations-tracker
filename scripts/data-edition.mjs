// The bottom rung of the quiet-day ladder: an edition built from the app's own
// data when the press has nothing and the Backlog is dry. See docs/adr/0002 in
// the app repo.
//
// Everything here is pure — the caller supplies the archive and the ranking
// stats — so the whole rung tests offline.
//
// The governing rule is that a data edition must be **honestly bounded**. The
// per-team archive is an ESPN rolling window of exactly 11 games, which
// comfortably sustains form and streaks and cannot sustain head-to-head
// records. Most pairings in it have one prior meeting or none, so "played 1,
// won 1" would read as a record while being a single result. The last meeting
// is therefore publishable as ONE result and is never aggregated.

// Archive games are keyed by event id; the writer wants them newest-first.
// `date` is an ISO string from ESPN and has been present on every game in every
// harvest, but a missing/unparseable one sorts last rather than throwing.
export function orderedGames(teamGames) {
  return Object.values(teamGames || {})
    .filter((g) => g && g.result)
    .sort((a, b) => {
      const ta = Date.parse(a.date || "");
      const tb = Date.parse(b.date || "");
      if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta;
    });
}

// Current run of the same result, newest-first. A draw breaks a run and starts
// its own (rare in this data, but a "3-game unbeaten run" that quietly folds a
// draw into a win streak is the kind of fused claim the editor notes now ban).
export function currentStreak(ordered) {
  if (!ordered.length) return null;
  const type = ordered[0].result;
  let count = 0;
  for (const g of ordered) {
    if (g.result !== type) break;
    count++;
  }
  return { type, count };
}

// Win/loss/draw tally over the most recent `limit` games, plus the raw
// sequence. `span` names the window explicitly so copy can say "in their last
// five" rather than an unbounded "recently" — the archive is 11 games deep and
// a claim that sounds career-wide would be false.
export function formSummary(ordered, limit = 5) {
  const window = ordered.slice(0, limit);
  if (!window.length) return null;
  const tally = { W: 0, L: 0, D: 0 };
  for (const g of window) if (tally[g.result] != null) tally[g.result]++;
  return {
    span: window.length,
    sequence: window.map((g) => g.result),
    won: tally.W,
    lost: tally.L,
    drawn: tally.D,
    pointsFor: window.reduce((n, g) => n + (Number(g.us) || 0), 0),
    pointsAgainst: window.reduce((n, g) => n + (Number(g.them) || 0), 0),
  };
}

// Normalise a nation name for comparison. Opponent names arrive from two
// different vendors (ESPN in the archive, api-sports in the fixture list), so
// "The Barbarians" vs "Barbarians" and stray case/punctuation must not decide
// whether a meeting is found.
function normaliseName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// The single most recent meeting with a named opponent, or null.
//
// MATCHED ON `opponent` (the NAME), never on `opponentCode`. A null code means
// the opponent sits outside the tracked 12, not that data is missing: today
// four of Fiji's eleven games (Spain, Canada, Samoa, Tonga) carry
// `opponentCode: null`, and keying off the code would silently discard them —
// on a team that is already the most retrieval-starved of the twelve.
//
// Returns ONE game. There is deliberately no "record" variant of this function:
// with an 11-game window, aggregating meetings produces a number that reads as
// a head-to-head record and is not one (docs/adr/0002).
export function lastMeeting(ordered, opponentName) {
  const want = normaliseName(opponentName);
  if (!want) return null;
  return ordered.find((g) => normaliseName(g.opponent) === want) || null;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function monthYear(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// World-ranking history as a fact the writer may use — STREAK-FIRST, ALWAYS.
//
// `ranking-stats.json` exposes `totalWeeks` and `longestWeeks` adjacently and
// they mean very different things: New Zealand's 748 total weeks at No. 1 are
// scattered across nine separate spells, while the 509-week figure is one
// unbroken run from 2009 to 2019. A cumulative total presented as a headline
// number reads as a streak to any fan, so this function NEVER returns
// totalWeeks — it is not in the output shape at all, which is the cheapest way
// to guarantee it cannot leak into copy.
export function rankHistoryFact(stats) {
  if (!stats) return null;
  const { best, no1 } = stats;

  // Currently top of the world: the strongest and most current angle there is.
  if (no1?.currentSince) {
    const since = monthYear(no1.currentSince);
    return since ? `Ranked No. 1 in the world continuously since ${since}.` : null;
  }

  // Held No. 1 before: quote the longest UNBROKEN run and its span.
  if (no1?.longestWeeks) {
    const from = monthYear(no1.longestFrom);
    const till = monthYear(no1.longestTill);
    const span = from && till ? ` (${from} to ${till})` : "";
    const wk = no1.longestWeeks === 1 ? "week" : "weeks";
    return `Longest unbroken spell at No. 1 in the world: ${no1.longestWeeks} ${wk}${span}.`;
  }

  // Never been No. 1 — six of the twelve, and disproportionately the quiet
  // teams, so this branch carries the rung more often than the ones above.
  if (best?.rank) {
    const years = best.years ? ` (${best.years})` : "";
    return `Best world ranking ever reached: No. ${best.rank}${years}.`;
  }
  return null;
}

// Scoring profile over the archive window. Kept separate from formSummary
// because it is a distinct ANGLE, not extra colour on the same one.
export function scoringProfile(ordered, limit = 11) {
  const window = ordered.slice(0, limit);
  if (window.length < 3) return null;
  const pf = window.reduce((n, g) => n + (Number(g.us) || 0), 0);
  const pa = window.reduce((n, g) => n + (Number(g.them) || 0), 0);
  const tries = window.reduce((n, g) => n + (Number(g.tries) || 0), 0);
  const biggest = window.reduce((a, g) =>
    (Number(g.us) - Number(g.them)) > (Number(a.us) - Number(a.them)) ? g : a);
  return {
    span: window.length,
    pointsFor: pf,
    pointsAgainst: pa,
    avgFor: Math.round((pf / window.length) * 10) / 10,
    avgAgainst: Math.round((pa / window.length) * 10) / 10,
    tries,
    biggestWin: biggest && Number(biggest.us) > Number(biggest.them) ? biggest : null,
  };
}

const RESULT_WORD = { W: "beat", L: "lost to", D: "drew with" };

// One-line rendering of a single archived game, home/away made explicit.
export function describeGame(game) {
  if (!game) return null;
  const verb = RESULT_WORD[game.result] || "played";
  const venue = game.homeAway === "H" ? "at home" : game.homeAway === "A" ? "away" : null;
  const when = monthYear(game.date);
  const score = game.result === "L" ? `${game.them}-${game.us}` : `${game.us}-${game.them}`;
  return [
    `${verb} ${game.opponent} ${score}`,
    venue,
    when ? `in ${when}` : null,
    game.league ? `(${game.league})` : null,
  ].filter(Boolean).join(" ");
}

// The four angles a data edition can take. Rotated rather than ranked, because
// a persistently dark team gets one of these every day and a fixed ranking
// would hand it the same edition each time. ADR 0002 is explicit that this
// yields three or four distinct angles before repeating — it is a floor, not an
// infinite well, and it degrades into the honest "no coverage" rung when the
// chosen angle has nothing to say.
export const ANGLES = ["form", "lastMeeting", "ranking", "scoring"];

// Deterministic per-team, per-day angle choice. Seeded on the date and the team
// so (a) a re-run on the same day is stable and (b) the twelve teams don't all
// take the same angle on the same morning.
export function angleFor(dateISO, teamCode, angles = ANGLES) {
  const seed = [...`${dateISO}:${teamCode}`].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return angles[seed % angles.length];
}

// Build the fact block for a data edition, or null when the data genuinely
// cannot support one (which is the signal to fall through to the honest
// "no coverage" rung).
//
// Returns FACTS, not prose. The writer turns them into an edition; letting a
// cheap model near raw numbers without naming the window is how "unbeaten in
// three" and "130 points" got fused into one phrase on 2026-07-21.
export function buildDataEdition({ teamCode, teamName, games, rankingStats, nextOpponent, dateISO }) {
  const ordered = orderedGames(games);
  if (!ordered.length) return null;

  const preferred = angleFor(dateISO, teamCode);
  const form = formSummary(ordered);
  const streak = currentStreak(ordered);
  const meeting = nextOpponent ? lastMeeting(ordered, nextOpponent) : null;
  const ranking = rankHistoryFact(rankingStats);
  const scoring = scoringProfile(ordered);

  // Each angle yields its lines, or nothing. Falling back in ANGLES order (not
  // to a fixed favourite) keeps variety when the preferred angle is empty.
  const build = {
    form: () => {
      if (!form) return null;
      const lines = [
        `In their last ${form.span} games: ${form.won} won, ${form.lost} lost${form.drawn ? `, ${form.drawn} drawn` : ""} (most recent first: ${form.sequence.join(" ")}).`,
      ];
      if (streak && streak.count >= 2) {
        const word = streak.type === "W" ? "wins" : streak.type === "L" ? "defeats" : "draws";
        lines.push(`Current run: ${streak.count} straight ${word}.`);
      }
      lines.push(`Most recent game: ${describeGame(ordered[0])}.`);
      return { angle: "form", lines };
    },
    lastMeeting: () => {
      if (!meeting) return null;
      return {
        angle: "lastMeeting",
        lines: [
          `Last meeting with ${nextOpponent}: ${teamName} ${describeGame(meeting)}.`,
          // The guard rail travels WITH the fact, not just in the prompt
          // preamble — the model reads the nearest instruction.
          `This is a single result, not a head-to-head record. Do not aggregate it or imply a wider pattern of meetings.`,
        ],
      };
    },
    ranking: () => (ranking ? { angle: "ranking", lines: [ranking] } : null),
    scoring: () => {
      if (!scoring) return null;
      const lines = [
        `Across their last ${scoring.span} games: ${scoring.pointsFor} points scored, ${scoring.pointsAgainst} conceded (averages ${scoring.avgFor} and ${scoring.avgAgainst} a game).`,
      ];
      if (scoring.biggestWin) lines.push(`Biggest win in that window: ${describeGame(scoring.biggestWin)}.`);
      return { angle: "scoring", lines };
    },
  };

  const order = [preferred, ...ANGLES.filter((a) => a !== preferred)];
  for (const name of order) {
    const built = build[name]();
    if (built) return built;
  }
  return null;
}

// Render the data-edition fact block for the writer prompt.
export function renderDataEdition(edition, teamName) {
  if (!edition) return "";
  return `## Data edition — today's coverage has nothing, and the backlog is dry

There is no ${teamName} story in today's press and no live storyline to return
to. Write from the app's own match data instead. These facts are trusted and
complete — they are ALL you have, and you may not add context from memory:

${edition.lines.map((l) => `- ${l}`).join("\n")}

Write it as a short, plain, factual note — a stat-desk filler, not a news story.
State the window every number belongs to ("in their last five"), and keep each
statistic in its own phrase: never weld two of them together ("an unbeaten
record of 130 points scored" shipped on 2026-07-21 and reads as nonsense).

Do NOT write about the absence of news, the quiet week, or the state of the
news cycle. Open on the fact itself.`;
}
