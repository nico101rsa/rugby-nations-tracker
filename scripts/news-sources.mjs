// Salience layer for the daily briefings: which story does a team lead with?
//
// Retrieval used to be three Bing queries per team, all anchored on the NEXT
// FIXTURE'S OPPONENT — so a team's actual biggest story was unreachable unless
// it happened to concern that opponent. On 2026-07-20 the Bok edition led with
// the log table while the press led with Erasmus on Feinberg-Mngomezulu's
// fitness, Pollard's hamstring and the Argentina tour. None of it was in the
// pack. See docs/adr/0001 in the app repo.
//
// The fix has two halves. This module is the second: given already-parsed feed
// items, decide what matters. Everything here is pure — fetching lives in
// generate-digests.mjs, so all of this tests offline.
//
// Salience is COMPUTED, not judged. A cheap model handed an unranked pack
// retreats to the safest thing in the prompt (the fixture, the log); handed a
// ranked shortlist of five it picks like an editor. Code ranks, the model
// recognises what is a story.

import { unwrapRedirect } from "./novelty.mjs";

// The spine: publisher feeds pulled once for all 12 teams, filtered by mention.
// Roster held small deliberately — a spine concentrates the product on outlets
// we have no relationship with, so no single one should dominate. Verified live
// 2026-07-20; RugbyPass has no usable feed (/feed/ returns HTML), and the Fiji
// press had no working dedicated feed (Fiji Times returns no items, Fiji Sun
// and fijivillage 404), so Fiji ran on the widener plus the backlog until FBC
// News was adopted on 2026-10-11: the daily review proposed it for a starved
// Fiji tab and the probe (scripts/probe-source-candidates.mjs) found a working
// WordPress feed with 7 Fiji stories in 10 items. It is a national
// broadcaster's news site, so the feed is its rugby category and `topic`
// keeps anything else out (the probe matched "Fiji" in title + description,
// where politics and weather say "Fiji" too; the spine's aboutness test is
// title-only). A feed with `topic` keeps only items whose title or
// description match it (harvest-news.mjs keepItem).
export const FEEDS = [
  { id: "planetrugby", name: "Planet Rugby", url: "https://www.planetrugby.com/rss" },
  { id: "bbc", name: "BBC Rugby Union", url: "https://feeds.bbci.co.uk/sport/rugby-union/rss.xml" },
  { id: "guardian", name: "Guardian Rugby Union", url: "https://www.theguardian.com/sport/rugbyunion/rss" },
  { id: "sarugbymag", name: "SA Rugby Magazine", url: "https://www.sarugbymag.co.za/feed" },
  { id: "rugbyasia247", name: "Rugby Asia 247", url: "https://www.rugbyasia247.com/feed" },
  {
    id: "fbcnews",
    name: "FBC News",
    url: "https://www.fbcnews.com.fj/category/sports/rugby/feed/",
    // If the first harvest logs "fbcnews: FAILED — HTTP 404", fall back to
    // /category/sports/feed/ and then /feed/; the topic filter is what makes
    // the general feed safe.
    topic: /\b(rugby|drua|flying fijians|fijiana|sevens|7s|test match|world cup|super rugby|pacific nations)\b/i,
  },
  // Ireland, adopted by Nico on 18 Oct 2026 (data #155): the 13 Oct review
  // found Ireland's shortlist was club matches and opinion. Both were probed
  // daily from 11 Oct (editorial/source-candidates.md): The42 carried 5-12
  // Ireland stories a day in 40 items, RTÉ 47 in the week. RTÉ's feed is its
  // rugby section. The42's is the whole site (GAA, soccer, boxing all say
  // "Ireland"), so it gets a rugby topic like FBC News.
  {
    id: "the42",
    name: "The42",
    url: "https://www.the42.ie/feed/",
    topic: /\b(rugby|six nations|nations championship|urc|champions cup|leinster|munster|ulster|connacht|andy farrell|lions|scrum|lineout|try|tries)\b/i,
  },
  { id: "rte", name: "RTÉ Sport Rugby", url: "https://www.rte.ie/feeds/rss/?index=/sport/rugby/" },
];

// Aliases decide whether a feed item is ABOUT a team. Coaches and nicknames are
// included because rugby headlines lead with them ("Rassie Erasmus provides…"
// never says South Africa). Matching is word-boundary — "Wales" must not fire on
// "New South Wales", and the untracked nations (Tonga, Georgia, Samoa) must not
// fire on anything.
export const TEAM_ALIASES = {
  386: ["England", "Red Rose", "Borthwick"],
  387: ["France", "French", "Les Bleus", "Galthie", "Galthié"],
  388: ["Ireland", "Irish", "Andy Farrell"],
  389: ["Italy", "Italian", "Azzurri", "Quesada"],
  390: ["Scotland", "Scottish", "Townsend"],
  391: ["Wales", "Welsh", "Sherratt", "Tandy"],
  460: ["Argentina", "Argentine", "Pumas", "Contepomi"],
  461: ["Australia", "Australian", "Wallabies", "Schmidt"],
  463: ["Japan", "Japanese", "Brave Blossoms"],
  465: ["New Zealand", "All Blacks", "Rennie"],
  467: ["South Africa", "Springbok", "Springboks", "Boks", "Rassie", "Erasmus"],
  28: ["Fiji", "Fijian", "Flying Fijians"],
};

// "New South Wales" must not match Wales, and "Tonga" must not match anything.
// Alias matching is therefore anchored on both sides, with an explicit veto list
// for the substrings that would otherwise produce a false positive.
const ALIAS_VETO = [
  [/new south wales/i, "Wales"],
  [/wales\s*(u20|under-20|women)/i, "Wales"],
  [/england\s*(u20|under-20|women)/i, "England"],
];

// Rugby league is a different sport that shares the nations' names. On
// 19 Oct 2026 the New Zealand edition led with a Rugby League World Cup win
// over Fiji as All Blacks news; league titles had reached shortlists on 14 of
// the 19 October run days, and England (1 Sep) and Fiji (6 Oct) had already
// led with league stories. Tested on the TITLE only, like aboutness: a union
// story's description can say "Australian Rugby League Commission" (NZR's
// Chiefs-name case). "Rugby League One" is Japan's top UNION competition, so
// it is excepted. Bare "Kiwis" (union headlines use it for New Zealanders) and
// bare "NRL" (union stories about code-switchers) are deliberately left out.
// There is no union World Cup in 2026 (the women's was Aug-Sep 2025, the
// men's opens Fri 1 Oct 2027), so a "2026 World Cup" is league's. A league
// headline with none of these words ("New Zealand avoid massive World Cup
// shock against Fiji") gets through; the writer and fact-check prompts carry
// the rule for that case (generate-digests.mjs).
//
// Two strengths. A league competition or side (LEAGUE_MARKERS) is league
// whatever else the title says. The code merely named ("rugby league") is
// also how a union story about a code-switcher reads ("Les Kiss reveals
// whether Zac Lomax will still be considered for Wallabies selection after
// confirmation of rugby league return"), so that one yields to a union side or
// body in the same title (UNION_MARKERS). Over all 91 run records to 19 Oct
// the exemption keeps exactly those union stories and no league one.
const LEAGUE_MARKERS = /\b(league world cup|RLWC\w*|kangaroos|kumuls|toa samoa|mate ma.a|state of origin|kiwi ferns|jillaroos|bulikula|fiji bati|2026 world cup|world cup 2026)\b/i;
const LEAGUE_NAMED = /\brugby league\b(?!\s+one\b)/i;
const UNION_MARKERS = /\b(wallabies|all blacks|springboks?|boks|pumas|wru|rfu|irfu|sru|fru|union|six nations|nations championship)\b/i;
// Any league word in a title, before the union exemption.
export const RUGBY_LEAGUE = new RegExp(`${LEAGUE_NAMED.source}|${LEAGUE_MARKERS.source}`, "i");

// A league publisher or section: nrl.com, loverugbyleague.com, or any site's
// /rugby-league/ path (BBC, Sporting News, Fiji Sun). Bing items are unwrapped
// to the article first. These catch the league stories whose titles carry no
// marker ("'Best in the world': New Zealand pack eye statement victory",
// nrl.com, New Zealand's shortlist on 14 Oct).
function leaguePublisher(link) {
  try {
    const u = new URL(unwrapRedirect(link));
    return /(^|\.)nrl\.com$/i.test(u.hostname) || /loverugbyleague/i.test(u.hostname) || /\/rugby-league\//i.test(u.pathname);
  } catch {
    return false;
  }
}

// Is this feed item ({title, link}) a rugby league story?
export function isRugbyLeague(item) {
  const title = item?.title || "";
  if (LEAGUE_MARKERS.test(title)) return true;
  if (LEAGUE_NAMED.test(title) && !UNION_MARKERS.test(title)) return true;
  return leaguePublisher(item?.link);
}

// The one league filter, for every path into a writer prompt: the shortlist,
// the search widener (and so the storyline re-check) and storyline extraction.
export function dropLeague(items) {
  return (items || []).filter((i) => !isRugbyLeague(i));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Word-boundary alias match. \b is wrong for accented aliases (Galthié) because
// é is a non-word char in JS regex, so the trailing boundary is asserted
// manually against a following letter instead.
export function mentionsTeam(text, aliases) {
  const hay = String(text || "");
  for (const alias of aliases) {
    const re = new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}($|[^\\p{L}])`, "iu");
    if (!re.test(hay)) continue;
    const vetoed = ALIAS_VETO.some(([pattern, target]) => target === alias && pattern.test(hay));
    if (!vetoed) return true;
  }
  return false;
}

// Words that carry no identifying signal when deciding whether two outlets are
// covering the same story. Deliberately short — over-stripping makes unrelated
// stories look alike, which would inflate corroboration, the strongest score.
const STOPWORDS = new Set(
  ("a an the and or but of to in on at for with from by as is are was were be been " +
   "his her their its this that these those he she they it after before over under " +
   "who whom what which why how when where new says say said reveals reveal make makes " +
   "rugby union test match"
  ).split(" "),
);

export function significantTokens(title) {
  return new Set(
    String(title || "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

// Jaccard overlap on significant tokens. Two outlets covering the same story
// share the names ("erasmus", "feinberg", "pollard"); unrelated stories about
// the same team share only the team word, which lands well under the threshold.
export function titleSimilarity(a, b) {
  const A = significantTokens(a);
  const B = significantTokens(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared / (A.size + B.size - shared);
}

const SIMILAR_ENOUGH = 0.34;

// Jaccard alone misses a short headline against a long one: on 2026-10-11 the
// Argentina pack held five versions of ONE story (Shaun Edwards joining as
// defence coach — Planet Rugby's 13-token headline, the BBC's 5-token one,
// SA Rugby Magazine's and two search hits) at Jaccard 0.10–0.30, so the
// corroboration stayed at 1–2 where the real figure was four outlets, and
// the review read five candidates for one signing. The overlap coefficient
// (shared ÷ the smaller headline) catches that: three shared names covering
// half of the short headline is the same story.
export function sameHeadline(a, b) {
  if (titleSimilarity(a, b) >= SIMILAR_ENOUGH) return true;
  const A = significantTokens(a);
  const B = significantTokens(b);
  if (!A.size || !B.size) return false;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return shared >= 3 && shared / Math.min(A.size, B.size) >= 0.5;
}

// Group items across outlets that are covering the same story. Greedy
// single-pass clustering: cheap, order-stable, and good enough for ~100 items a
// day. The cluster keeps the EARLIEST feed position and the BEST-placed item as
// its representative, because that is the outlet that led with it.
export function clusterStories(items) {
  const clusters = [];
  for (const item of items) {
    const hit = clusters.find((c) => c.items.some((i) => sameHeadline(i.title, item.title)));
    if (hit) hit.items.push(item);
    else clusters.push({ items: [item] });
  }
  return clusters.map((c) => {
    const outlets = new Set(c.items.map((i) => i.feedId));
    const best = c.items.reduce((a, b) => (a.position <= b.position ? a : b));
    return {
      title: best.title,
      link: best.link,
      desc: best.desc,
      date: best.date,
      feedId: best.feedId,
      feedName: best.feedName,
      position: best.position,
      corroboration: outlets.size,
      outlets: [...outlets],
      items: c.items,
      // When the STORY broke: the earliest first-sighting across the cluster.
      // A second outlet picking it up today does not make a three-day-old
      // story new.
      firstSeenAt: firstSeenAt(c.items),
    };
  });
}

// The earliest moment any item in a cluster broke, as epoch ms, or null when
// none carries a usable stamp. Pool items carry `firstSeen` (the hourly
// harvest's own clock) and usually a pubDate; widener hits carry only the
// outlet's pubDate. The EARLIER of the two counts: a feed can surface an old
// feature late (BBC's "Ospreylia" piece, pubDate 17 Sep 2026, entered the
// pool on 10 Oct and ranked as NEW above a two-outlet Scarlets/WRU story
// from 28 Sep on the 11 Oct Wales shortlist), and a late sighting is not a
// story breaking.
export function firstSeenAt(items) {
  let earliest = null;
  for (const i of items ?? []) {
    for (const stamp of [i?.firstSeen, i?.date]) {
      const t = Date.parse(stamp || "");
      if (!Number.isNaN(t) && (earliest === null || t < earliest)) earliest = t;
    }
  }
  return earliest;
}

// A story is FRESH when it broke inside this window before the run — i.e.
// since the previous daily edition. Fresh candidates rank above everything
// older, whatever the scores say (see buildShortlist); older ones stay on the
// list as background only.
//
// Why a hard partition and not more recency weight: the score already decays
// with age, and it was not enough. Planet Rugby's Springbok team announcement
// sat at feed position 0 on 22 Sep 2026, which is worth 25 points on its
// own; three days later it still out-scored every fresh story and led the
// edition for the third day running. Position rewards where an outlet placed
// a story on the day it broke — it must not keep paying out all week.
export const FRESH_HOURS = 24;

export function isFresh(story, now, windowHours = FRESH_HOURS) {
  const at = story?.firstSeenAt ?? firstSeenAt(story?.items) ?? (() => {
    const t = Date.parse(story?.date || "");
    return Number.isNaN(t) ? null : t;
  })();
  if (at === null) return false;
  return now.getTime() - at <= windowHours * 3_600_000;
}

// Age in hours, or null when the feed gave us no usable pubDate.
export function ageHours(dateStr, now) {
  const t = Date.parse(dateStr || "");
  if (Number.isNaN(t)) return null;
  return (now.getTime() - t) / 3_600_000;
}

// Three signals, all free from a pull we already do:
//
//   corroboration — a story carried by 3 of 5 outlets IS the day's story. This
//                   is the strongest signal available and the old pipeline used
//                   none of it. Weighted highest, with diminishing returns.
//   position      — where the outlet placed it. Editorial ranking, borrowed
//                   from people paid to do it.
//   recency       — real pubDates, decaying over roughly three days.
//
// An unparseable date scores as neutral-old rather than zero: a good story from
// an outlet with a broken pubDate should not be silently buried.
export function scoreStory(story, now) {
  const corroboration = Math.min(story.corroboration, 4);
  // log2(n), NOT log2(1+n): a solo story scores ZERO here and must earn its
  // place on prominence and freshness alone. The 1+ form handed 40 points to
  // every item for merely existing, which floated a two-day-old single-outlet
  // filler piece over the Quiet floor — exactly the failure this layer exists
  // to prevent.
  const corroborationScore = 40 * Math.log2(corroboration);
  const positionScore = 25 / (1 + Math.max(0, story.position));
  const age = ageHours(story.date, now);
  const recencyScore = age == null ? 8 : 30 * Math.exp(-age / 36);
  return Math.round((corroborationScore + positionScore + recencyScore) * 10) / 10;
}

// Match reports are what the log and the fixtures already show — the briefing
// spending its 80 words re-narrating them is the waste this redesign exists to
// remove. They are demoted, not dropped: on a genuinely dead day a match report
// still beats nothing.
const MATCH_REPORT = /\b(\d{1,3}\s*[-–]\s*\d{1,3}|player ratings|team of the week|full-time|match report|as it happened|highlights)\b/i;

export function isMatchReport(title) {
  return MATCH_REPORT.test(String(title || ""));
}

// Being named in a headline is not the same as being its SUBJECT. "All Blacks
// great hails statement shift from forward who will be needed against
// Springboks" names the Boks in a subordinate clause — it is a New Zealand
// story, and on 2026-07-20 it led the Springbok briefing under the kicker "Kiwi
// confidence", which is not what a Bok fan opened the app for.
//
// Two cheap positional signals separate subject from mention:
//   - where in the headline the alias falls (subjects lead)
//   - whether an opposition marker precedes it ("against Springboks", "v Wales")
const OPPOSITION_MARKER = /\b(against|versus|vs?\.?|face|faces|facing|host|hosts|hosting|beat|beaten by|defeat|defeated by|lost to|ahead of|before)\s*$/i;

// 1.0 when the team is plainly the subject, down to 0.35 when it is named in
// passing. A multiplier rather than a filter — a passing mention on a huge story
// can still out-rank a thin story that is genuinely about the team.
export function subjectWeight(title, aliases) {
  const hay = String(title || "");
  let best = 0.35;
  for (const alias of aliases) {
    // Word-boundary, matching mentionsTeam. A plain indexOf found "Boks" INSIDE
    // "Springboks" at a position whose preceding text was "…ainst Spring" — no
    // opposition marker — so Math.max quietly lifted "against Springboks" from
    // 0.35 to 0.55 and the demotion half-failed.
    const at = hay.search(new RegExp(`(^|[^\\p{L}])${escapeRe(alias)}($|[^\\p{L}])`, "iu"));
    if (at === -1) continue;
    const preceding = hay.slice(0, at).replace(/["'‘“(]\s*$/, "");
    if (OPPOSITION_MARKER.test(preceding)) {
      best = Math.max(best, 0.35);
      continue;
    }
    // Fraction of the headline before the mention: 0 is the first word.
    const depth = hay.length ? at / hay.length : 0;
    best = Math.max(best, depth <= 0.35 ? 1 : depth <= 0.6 ? 0.8 : 0.55);
  }
  return best;
}

const SHORTLIST_SIZE = 5;

// The salience floor below which a day counts as Quiet.
//
// Calibrated against the live feeds on 2026-07-20 — a BREAK WEEK, i.e. the
// quietest the season gets, which is the right week to calibrate a quiet-day
// rule on. Observed top scores across the 12 teams ran 7.2 to 54.5. At 22 the
// three teams with nothing but match previews and reports (Japan 7.2, Italy
// 11.6, Fiji 11.7) fall through to the backlog, while genuine if modest stories
// (Australia 17.7 is borderline, Scotland 25.3 passes) still publish.
//
// Roughly: a solo story around position five, half a day old, scores ~25. An
// earlier draft used 45, which read 9 of 12 teams as Quiet and would have sent
// most of the app to data editions daily.
export const QUIET_THRESHOLD = 22;

// Build the ranked shortlist for one team. The writer may not lead with anything
// outside this list — that constraint is the point, not a detail.
export function buildShortlist(items, teamId, now, size = SHORTLIST_SIZE) {
  const aliases = TEAM_ALIASES[teamId];
  if (!aliases) throw new Error(`no aliases for team ${teamId}`);
  // ABOUTNESS IS A TITLE TEST. Matching the description too was the first
  // version and it mis-filed stories wholesale on the 2026-07-20 live run:
  // Fiji's entire shortlist was Scotland stories, Wales led on "Watch: Boks'
  // new bash brothers", Italy on "Why is there no rugby culture in Germany?".
  // A team named in passing in a summary is mentioned, not covered. Headlines
  // name who the story is about — that is what a headline is for.
  // A rugby league story is never a union team's story (isRugbyLeague).
  const mine = dropLeague(items).filter((i) => mentionsTeam(i.title, aliases));
  const scored = clusterStories(mine).map((s) => {
    const matchReport = isMatchReport(s.title);
    const subject = subjectWeight(s.title, aliases);
    const score = scoreStory(s, now) * (matchReport ? 0.45 : 1) * subject;
    const seenHours = s.firstSeenAt === null ? null : (now.getTime() - s.firstSeenAt) / 3_600_000;
    return { ...s, score: Math.round(score * 10) / 10, matchReport, subject, fresh: isFresh(s, now), seenHours };
  });
  // Fresh first, then by score. An older story can still make the list — as
  // background, printed as such — but it never outranks something that broke
  // since the last edition.
  scored.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.score - a.score || a.position - b.position);
  return scored.slice(0, size);
}

// A day is Quiet when nothing on the shortlist clears the floor. Note this is a
// property of the COVERAGE, never of the team's camp — the writer may say "no
// coverage today", never "the camp is clean".
// Quiet is judged on the STRONGEST candidate, not the first: the list is
// ordered fresh-first, so the top entry may be a small new item sitting above
// a big older one, and the calibration above was done on peak score.
export function isQuiet(shortlist) {
  return !shortlist.length || Math.max(...shortlist.map((s) => s.score)) < QUIET_THRESHOLD;
}

// Render the shortlist for the writer prompt. Each candidate is numbered so the
// writer can name its pick, and the score reasons are shown so the daily review
// can later tell a starved team from a badly-chosen lead.
export function renderShortlist(shortlist) {
  if (!shortlist.length) return "(no candidates — today's coverage is silent on this team)";
  return shortlist
    .map((s, n) => {
      const bits = [`${s.corroboration} outlet${s.corroboration === 1 ? "" : "s"} (${s.outlets.join(", ")})`];
      if (s.matchReport) bits.push("match report — demoted");
      // Freshness is printed, not just ranked: the writer picks by reading,
      // and "background" beside a candidate is what stops it leading.
      const tag = s.fresh === undefined ? "" : s.fresh ? "NEW · " : `BACKGROUND${ageLabel(s)} · `;
      return `${n + 1}. [${tag}score ${s.score} · ${bits.join(" · ")}] ${s.title}\n   ${s.feedName} — ${s.link}`;
    })
    .join("\n");
}

// "(first seen 3 days ago)" for a background candidate, or "" when unknown.
function ageLabel(story) {
  const hours = story?.seenHours;
  if (hours == null || Number.isNaN(hours)) return "";
  const days = Math.round(hours / 24);
  return ` (first seen ${days <= 1 ? "yesterday" : `${days} days ago`})`;
}
