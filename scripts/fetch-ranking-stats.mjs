// Historical world-ranking stats per tracked nation -> ranking-stats.json on
// the Pages CDN. Feeds the Team page's rank headline ("10 weeks at #1",
// "best ever #3 (2007)") — the live weekly rank itself comes from
// rankings.json (fetch-rankings.mjs).
//
// Two Wikipedia sources (same white-shaded lane as fetch-rankings.mjs):
// 1. World_Rugby_Rankings § "Best and worst ranking positions" — a wikitable
//    of each nation's best/worst rank + the years they held it.
// 2. Template:World Rugby ranking leaders — an EasyTimeline of every #1 spell
//    since 2003 with exact from/till dates, from which we compute total weeks
//    at #1, the longest stretch, spell count, and any current streak.

const TRACKED = new Set([
  "ENG", "FRA", "IRE", "ITA", "SCO", "WAL",
  "ARG", "AUS", "JPN", "NZL", "RSA", "FIJ",
]);

// Timeline rows name teams in full; map back to our codes.
const NAME_TO_CODE = {
  England: "ENG", France: "FRA", Ireland: "IRE", Italy: "ITA",
  Scotland: "SCO", Wales: "WAL", Argentina: "ARG", Australia: "AUS",
  Japan: "JPN", "New Zealand": "NZL", "South Africa": "RSA", Fiji: "FIJ",
};

// § Best and worst: rows look like
//   |align=left| {{ru|ARG}}
//   ! 3
//   | 2007–08
//   ! 12
//   | 2014
export function parseBestWorst(wikitext) {
  const out = {};
  const rowRe =
    /\{\{ru\|([A-Za-z]{3,})\}\}[^!]*!\s*\|?\s*(\d+)\s*\n\|\s*([^\n]+?)\s*\n!\s*(\d+)\s*\n\|(?:align=center\|)?\s*([^\n]+?)\s*\n/g;
  let m;
  while ((m = rowRe.exec(wikitext)) !== null) {
    const [, code, bestRank, bestYears, worstRank, worstYears] = m;
    if (!TRACKED.has(code)) continue;
    const clean = (s) => s.replace(/<br\s*\/?>/g, " ").replace(/\s+/g, " ").trim();
    out[code] = {
      best: { rank: Number(bestRank), years: clean(bestYears) },
      worst: { rank: Number(worstRank), years: clean(worstYears) },
    };
  }
  return out;
}

// Timeline rows: from:dd/mm/yyyy till:(dd/mm/yyyy|$now|end) ... text:"[[...|Name]]"
// ("end" = the timeline's Period end = today; the live template uses it for the
// current spell — seen 2026-07-16 when SA's current streak parsed as closed).
export function parseLeaderSpells(wikitext) {
  const spells = [];
  const re =
    /from:(\d{2}\/\d{2}\/\d{4})\s+till:(\$now|end|\d{2}\/\d{2}\/\d{4})[^\n]*text:"\[\[[^\]|]*\|([^\]]+)\]\]"/g;
  const toIso = (dmy) => {
    const [d, mo, y] = dmy.split("/");
    return `${y}-${mo}-${d}`;
  };
  let m;
  while ((m = re.exec(wikitext)) !== null) {
    const code = NAME_TO_CODE[m[3]];
    if (!code) continue;
    spells.push({ code, from: toIso(m[1]), till: m[2] === "$now" || m[2] === "end" ? null : toIso(m[2]) });
  }
  return spells;
}

const weeksBetween = (fromIso, tillIso, now) => {
  const till = tillIso ? new Date(tillIso).getTime() : now;
  return Math.round((till - new Date(fromIso).getTime()) / (7 * 86400000));
};

// Per-team #1 record from the spell list. `now` injectable for tests.
export function leaderStats(spells, now = Date.now()) {
  const out = {};
  for (const s of spells) {
    const weeks = weeksBetween(s.from, s.till, now);
    const t = (out[s.code] ??= { totalWeeks: 0, longestWeeks: 0, spells: 0, currentSince: null });
    t.totalWeeks += weeks;
    t.longestWeeks = Math.max(t.longestWeeks, weeks);
    t.spells += 1;
    if (s.till === null) t.currentSince = s.from;
  }
  return out;
}

const wikiParse = async (page, extra = "") => {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext${extra}`;
  const res = await fetch(url, {
    headers: { "user-agent": "rugby-nations-tracker (github.com/nico101rsa/rugby-nations-tracker)" },
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status} for ${page}`);
  return (await res.json()).parse.wikitext["*"];
};

async function main() {
  const { writeFile } = await import("node:fs/promises");
  const bestWorst = parseBestWorst(await wikiParse("World_Rugby_Rankings", "&section=3"));
  const no1 = leaderStats(parseLeaderSpells(await wikiParse("Template:World Rugby ranking leaders")));
  if (Object.keys(bestWorst).length < 10) {
    throw new Error(`parsed only ${Object.keys(bestWorst).length}/12 best/worst rows — table layout changed?`);
  }
  const teams = {};
  for (const code of TRACKED) {
    teams[code] = { ...(bestWorst[code] ?? {}), no1: no1[code] ?? null };
  }
  const out = {
    updatedAt: new Date().toISOString(),
    source: "wikipedia:World_Rugby_Rankings",
    teams,
  };
  await writeFile("ranking-stats.json", JSON.stringify(out, null, 1) + "\n");
  const leaders = Object.entries(no1).map(([c, s]) => `${c}:${s.totalWeeks}w`).join(" ");
  console.log(`ranking-stats.json written — ${Object.keys(bestWorst).length} best/worst rows; weeks at #1: ${leaders}`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
