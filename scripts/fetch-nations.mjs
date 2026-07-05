// Fetches Nations Championship data from api-sports.io and writes a static
// public/nations.json that the React app reads. The API key stays here
// (server/build side) and is NEVER shipped to the browser.
//
// Usage:
//   RUGBY_API_KEY=xxxx node scripts/fetch-nations.mjs 2026-07-01 2026-07-15
//   (start end dates optional; defaults to a window around today, AEST)
//
// Re-runnable: raw games are merged into scripts/.cache-games.json so repeated
// runs (e.g. to backfill the November window) accumulate rather than overwrite.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeStaticFixtures } from "./static-fixtures.mjs";
import { scrapeTries } from "./scrape-tries.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const KEY = process.env.RUGBY_API_KEY;
const BASE = "https://v1.rugby.api-sports.io";
const LEAGUE_ID = 145; // Nations Championship
const SEASON = 2026;

if (!KEY) {
  console.warn("No RUGBY_API_KEY set — skipping the API fetch and rebuilding from the cached games + static fixture list.");
}

const CACHE = join(__dirname, ".cache-games.json");
const OUT = join(ROOT, "public", "nations.json");

// ---- date helpers (AEST) ----
function aestDateStr(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
function* dateRange(startStr, endStr) {
  const start = new Date(`${startStr}T00:00:00Z`);
  const end = new Date(`${endStr}T00:00:00Z`);
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    yield aestDateStr(new Date(t));
  }
}

async function apiGames(date) {
  const r = await fetch(`${BASE}/games?date=${date}`, {
    headers: { "x-apisports-key": KEY },
  });
  const rem = r.headers.get("x-ratelimit-requests-remaining");
  const j = await r.json();
  if (j.errors && !Array.isArray(j.errors) && Object.keys(j.errors).length) {
    throw new Error(`${date}: ${Object.values(j.errors).join(" ")}`);
  }
  return { games: j.response || [], remaining: rem };
}

// ---- news via Google News RSS (public, no key). Parsed with light regex. ----
async function fetchNews() {
  const q = encodeURIComponent('"Nations Championship" rugby');
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-AU&gl=AU&ceid=AU:en`;
  try {
    const r = await fetch(url);
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 15);
    const pick = (block, tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      if (!m) return "";
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
    };
    return items.map((it) => {
      const b = it[1];
      const rawTitle = pick(b, "title");
      // Google News titles are "Headline - Source"
      const source = pick(b, "source") || (rawTitle.includes(" - ") ? rawTitle.split(" - ").pop() : "");
      const title = source && rawTitle.endsWith(` - ${source}`)
        ? rawTitle.slice(0, -(source.length + 3))
        : rawTitle;
      return {
        title: title.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"'),
        link: pick(b, "link"),
        source,
        published: pick(b, "pubDate"),
      };
    });
  } catch (e) {
    console.warn("news fetch failed:", e.message);
    return [];
  }
}

// ---- log computation from finished results ----
// Official rules: win 4, draw 2, loss 0; +1 bonus for scoring 4+ tries (win
// or lose); +1 bonus for losing by 7 or fewer. Try counts are scraped from
// ESPN (the api-sports plan doesn't expose them) — see scrape-tries.mjs.
// Tiebreak: table points, then wins, then points difference.
function computeLog(finished, matchTries) {
  const t = {};
  const row = (team) =>
    (t[team.id] ??= {
      id: team.id, team: team.name, logo: team.logo,
      P: 0, W: 0, D: 0, L: 0, PF: 0, PA: 0, PD: 0, TF: 0, TA: 0, BP: 0, Pts: 0,
    });
  for (const g of finished) {
    const hs = g.scores?.home, as = g.scores?.away;
    if (hs == null || as == null) continue;
    const h = row(g.teams.home), a = row(g.teams.away);
    h.P++; a.P++;
    h.PF += hs; h.PA += as; a.PF += as; a.PA += hs;
    if (hs > as) { h.W++; a.L++; h.Pts += 4; }
    else if (as > hs) { a.W++; h.L++; a.Pts += 4; }
    else { h.D++; a.D++; h.Pts += 2; a.Pts += 2; }
    // losing bonus: beaten by 7 or fewer
    const margin = Math.abs(hs - as);
    if (margin > 0 && margin <= 7) {
      const loser = hs > as ? a : h;
      loser.BP++; loser.Pts++;
    }
    // try bonus: 4+ tries, win or lose
    const tries = matchTries[g.id];
    if (tries) {
      h.TF += tries.home; h.TA += tries.away;
      a.TF += tries.away; a.TA += tries.home;
      if (tries.home >= 4) { h.BP++; h.Pts++; }
      if (tries.away >= 4) { a.BP++; a.Pts++; }
    }
  }
  return Object.values(t)
    .map((r) => ({ ...r, PD: r.PF - r.PA }))
    .sort((x, y) => y.Pts - x.Pts || y.W - x.W || y.PD - x.PD || y.PF - x.PF)
    .map((r, i) => ({ rank: i + 1, ...r }));
}

const LIVE = new Set(["1H", "2H", "HT", "ET", "BT", "PT", "SH", "LIVE"]);
const isLive = (g) => LIVE.has((g.status?.short || "").toUpperCase());
const isFinished = (g) => /finish/i.test(g.status?.long || "") || (g.status?.short || "") === "FT";
const isUpcoming = (g) => /not started/i.test(g.status?.long || "") || (g.status?.short || "") === "NS";

// Kickoff display is formatted client-side from `date` in the device timezone.
const slim = (g) => ({
  id: g.id, date: g.date, week: g.week,
  status: { short: g.status?.short, long: g.status?.long, live: isLive(g) },
  home: { id: g.teams.home.id, name: g.teams.home.name, logo: g.teams.home.logo, score: g.scores?.home ?? null },
  away: { id: g.teams.away.id, name: g.teams.away.name, logo: g.teams.away.logo, score: g.scores?.away ?? null },
});

async function main() {
  const today = aestDateStr();
  const start = process.argv[2] || today;
  // default window: today .. +14 days
  const end = process.argv[3] || aestDateStr(new Date(Date.now() + 14 * 86400000));

  // load cache
  let cache = {};
  try { cache = JSON.parse(await readFile(CACHE, "utf8")); } catch { /* first run */ }

  let remaining = null;
  for (const date of KEY ? dateRange(start, end) : []) {
    try {
      const { games, remaining: rem } = await apiGames(date);
      if (rem != null) remaining = rem;
      const nations = games.filter((g) => (g.league?.id === LEAGUE_ID));
      for (const g of nations) cache[g.id] = g; // merge by id
      console.log(`${date}: ${nations.length} Nations games (rate left: ${rem})`);
    } catch (e) {
      console.warn(e.message);
    }
  }

  await writeFile(CACHE, JSON.stringify(cache, null, 0));

  const all = Object.values(cache).sort((a, b) => new Date(a.date) - new Date(b.date));
  const results = all.filter((g) => isFinished(g) || isLive(g)).map(slim);
  const fixtures = mergeStaticFixtures(all.filter(isUpcoming).map(slim), all);
  const finished = all.filter(isFinished);
  const matchTries = await scrapeTries(finished);
  const log = computeLog(finished, matchTries);
  const news = await fetchNews();

  const out = {
    competition: {
      id: LEAGUE_ID, name: "Nations Championship", season: SEASON,
      logo: `https://media.api-sports.io/rugby/leagues/${LEAGUE_ID}.png`,
    },
    updatedAt: new Date().toISOString(),
    counts: { fixtures: fixtures.length, results: results.length, teams: log.length, news: news.length },
    fixtures, results, log, news,
  };

  await mkdir(join(ROOT, "public"), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(out.counts, `| rate remaining: ${remaining}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
