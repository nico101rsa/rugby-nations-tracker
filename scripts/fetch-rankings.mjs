// World Rugby rankings for the 12 competition nations -> rankings.json on the
// Pages CDN (site root, beside nations.json and stats.json).
//
// Source: the wikitext of Wikipedia's Template:World_Rugby_Rankings (which
// editors update from world.rugby after each ranking window). This is the
// white-shaded fallback recorded in the app repo's docs/DATA_RIGHTS.md —
// SportsAPI Pro has no rugby rankings endpoint (checked 2026-07-15) and
// hitting world.rugby's own API directly is off the table (ToU).
//
// Row shape in the template:
//   ! scope="row"| 1
//   | align=center| {{steady}}|| {{ru|RSA}} || {{0}}93.96

// The 12 competition teams, by the {{ru|XXX}} codes Wikipedia uses (they match
// the app's 3-letter codes in src/teams.js).
const COMPETITION_CODES = new Set([
  "ENG", "FRA", "IRE", "ITA", "SCO", "WAL",
  "ARG", "AUS", "JPN", "NZL", "RSA", "FIJ",
]);

// Parse every ranking row from the template wikitext. Returns an array of
// { rank, code, points, move } with an `asOf` property (the template's
// "as of <date>" caption) attached.
export function parseRankings(wikitext) {
  const rows = [];
  const rowRe =
    /! scope="row"\|\s*(\d+)\s*\n\|[^\n]*?\{\{(steady|increase|decrease)\}\}\s*(\d*)[^\n]*?\{\{ru\|([A-Z]{3})\}\}[^\n]*?\|\|\s*(?:\{\{0\}\})?([\d.]+)/g;
  let m;
  while ((m = rowRe.exec(wikitext)) !== null) {
    const [, rank, dir, steps, code, points] = m;
    const n = steps ? Number(steps) : dir === "steady" ? 0 : 1;
    rows.push({
      rank: Number(rank),
      code,
      points: Number(points),
      move: dir === "increase" ? n : dir === "decrease" ? -n : 0,
    });
  }
  rows.asOf = wikitext.match(/as of ([\d]{1,2} \w+ \d{4})/)?.[1] ?? null;
  return rows;
}

// Keep only competition teams, keyed by code. Throws if the parse looks broken
// (a template rewrite should fail the run loudly, not publish an empty file).
export function buildRankingsJson(rows, updatedAt, { min = 10 } = {}) {
  const rankings = {};
  for (const r of rows) {
    if (COMPETITION_CODES.has(r.code)) {
      rankings[r.code] = { rank: r.rank, points: r.points, move: r.move };
    }
  }
  const found = Object.keys(rankings).length;
  if (found < min) {
    throw new Error(`parsed only ${found}/12 competition teams — template layout changed?`);
  }
  return { updatedAt, asOf: rows.asOf, source: "wikipedia:World_Rugby_Rankings", rankings };
}

// Accumulate a rankings time series: whenever the template's "as of" date
// advances, the previous snapshot is archived into `history` (oldest first).
// Re-runs within the same ranking week are no-ops for history. This grows a
// small on-CDN database for future trend features (rank-over-time graphs).
export function withHistory(prev, next) {
  const history = [...(prev?.history ?? [])];
  if (prev && prev.asOf && prev.asOf !== next.asOf) {
    history.push({ asOf: prev.asOf, rankings: prev.rankings });
  }
  return { ...next, history };
}

const WIKI_URL =
  "https://en.wikipedia.org/w/api.php?action=parse&page=Template:World_Rugby_Rankings&format=json&prop=wikitext";

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const res = await fetch(WIKI_URL, {
    headers: { "user-agent": "rugby-nations-tracker (github.com/nico101rsa/rugby-nations-tracker)" },
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const wikitext = (await res.json()).parse.wikitext["*"];
  const fresh = buildRankingsJson(parseRankings(wikitext), new Date().toISOString());
  const prev = await readFile("rankings.json", "utf8").then(JSON.parse).catch(() => null);
  const out = withHistory(prev, fresh);
  await writeFile("rankings.json", JSON.stringify(out, null, 1) + "\n");
  console.log(
    `rankings.json written — ${Object.keys(out.rankings).length} teams, as of ${out.asOf}, ${out.history.length} archived week(s)`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
