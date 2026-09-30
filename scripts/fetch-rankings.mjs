// World Rugby rankings for the 12 competition nations -> rankings.json on the
// Pages CDN (site root, beside nations.json and stats.json).
//
// Source: world.rugby's own rankings feed (the JSON behind
// www.world.rugby/rankings), with Wikipedia's Template:World_Rugby_Rankings as
// the fallback when that feed fails or parses short.
//
// Wikipedia used to be the primary, but it is hand-edited from world.rugby
// and lags: 5 weeks behind on 24 Aug 2026, then stuck "as of 14 September"
// through two official releases (21 and 28 Sep 2026) while the site was
// current. Nico switched the primary to world.rugby on 2026-09-30, knowingly
// reversing the earlier ToU-driven call in the app repo's docs/DATA_RIGHTS.md.
// SportsAPI Pro still has no rugby rankings endpoint.
//
// world.rugby entry shape:
//   { pos: 1, previousPos: 2, pts: 92.5, team: { abbreviation: "RSA", name: "South Africa" } }
// with the release date in `effective.label` ("2026-09-28").
//
// Row shape in the Wikipedia template:
//   ! scope="row"| 1
//   | align=center| {{steady}}|| {{ru|RSA}} || {{0}}93.96

// The 12 competition teams, by the {{ru|XXX}} codes Wikipedia uses (they match
// the app's 3-letter codes in src/teams.js).
const COMPETITION_CODES = new Set([
  "ENG", "FRA", "IRE", "ITA", "SCO", "WAL",
  "ARG", "AUS", "JPN", "NZL", "RSA", "FIJ",
]);

// World Rugby's team names, for a feed row whose abbreviation doesn't match
// ours (belt and braces — the codes have matched so far).
const CODE_BY_NAME = {
  "England": "ENG", "France": "FRA", "Ireland": "IRE", "Italy": "ITA",
  "Scotland": "SCO", "Wales": "WAL", "Argentina": "ARG", "Australia": "AUS",
  "Japan": "JPN", "New Zealand": "NZL", "South Africa": "RSA", "Fiji": "FIJ",
};

// "2026-09-28" -> "28 September 2026" — the Wikipedia caption format that
// rankings.json's `asOf`, its history and check-rankings.mjs all key on.
export function isoToAsOf(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  return `${Number(m[3])} ${month[0].toUpperCase()}${month.slice(1)} ${m[1]}`;
}

// Parse the world.rugby rankings JSON into the same row shape (and `asOf`
// property) as parseRankings, so buildRankingsJson serves both sources.
export function parseWorldRugby(json) {
  const rows = [];
  for (const e of json?.entries ?? []) {
    const abbr = e?.team?.abbreviation;
    const code = COMPETITION_CODES.has(abbr) ? abbr : CODE_BY_NAME[e?.team?.name] ?? abbr;
    const rank = Number(e?.pos);
    const points = Math.round(Number(e?.pts) * 100) / 100;
    if (!code || !Number.isFinite(rank) || !Number.isFinite(points)) continue;
    const prev = Number(e?.previousPos);
    rows.push({ rank, code, points, move: Number.isFinite(prev) && prev > 0 ? prev - rank : 0 });
  }
  const label = json?.effective?.label;
  rows.asOf = isoToAsOf(label) ??
    (Number.isFinite(json?.effective?.millis) ? isoToAsOf(new Date(json.effective.millis).toISOString()) : null);
  return rows;
}

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
export function buildRankingsJson(rows, updatedAt, { min = 10, source = "wikipedia:World_Rugby_Rankings" } = {}) {
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
  return { updatedAt, asOf: rows.asOf, source, rankings };
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

// "24 August 2026" -> epoch ms, or null when the caption didn't parse.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december"];
export function parseAsOfDate(asOf) {
  const m = String(asOf ?? "").match(/^(\d{1,2}) (\w+) (\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase());
  if (month === -1) return null;
  return Date.UTC(Number(m[3]), month, Number(m[1]));
}

// A refetch may only move the table forward. Wikipedia's template lagged 5
// weeks behind reality on 24 Aug 2026 (NZ had taken No. 1 off SA two days
// earlier); a hand-corrected rankings.json would have been silently reverted
// by that night's cron. An OLDER "as of" than the published file means the
// template (or a vandalism revert) is behind whatever we already have — keep
// the published file and let check-rankings.mjs shout instead.
export function isRegression(prevAsOf, nextAsOf) {
  const prev = parseAsOfDate(prevAsOf);
  const next = parseAsOfDate(nextAsOf);
  return prev !== null && next !== null && next < prev;
}

// A release can't be dated in the future. On 27 Aug 2026 the template's
// long-awaited update arrived captioned "as of 24 September 2026" — an
// editor's month typo — and the forward-only rule above happily accepted it.
// Once stored, a future date latches: the typo's correction back to August
// reads as a regression and is refused, and checkTableFreshness goes blind
// for a month (no result can postdate a future table). Two days of slack
// cover a cron seeing Monday's release date from Sunday UTC.
const FUTURE_SLACK_MS = 2 * 86400000;
export function isFutureDated(asOf, now = Date.now()) {
  const t = parseAsOfDate(asOf);
  return t !== null && t > now + FUTURE_SLACK_MS;
}

const WORLD_RUGBY_URL = "https://api.wr-rims-prod.pulselive.com/rugby/v3/rankings/mru?language=en";
const WIKI_URL =
  "https://en.wikipedia.org/w/api.php?action=parse&page=Template:World_Rugby_Rankings&format=json&prop=wikitext";

const UA = { "user-agent": "rugby-nations-tracker (github.com/nico101rsa/rugby-nations-tracker)" };

async function fromWorldRugby(updatedAt) {
  const res = await fetch(WORLD_RUGBY_URL, { headers: UA });
  if (!res.ok) throw new Error(`world.rugby HTTP ${res.status}`);
  const rows = parseWorldRugby(await res.json());
  if (!rows.asOf) throw new Error("world.rugby feed has no effective date");
  return buildRankingsJson(rows, updatedAt, { source: "world.rugby" });
}

async function fromWikipedia(updatedAt) {
  const res = await fetch(WIKI_URL, { headers: UA });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const wikitext = (await res.json()).parse.wikitext["*"];
  return buildRankingsJson(parseRankings(wikitext), updatedAt);
}

async function main() {
  const { readFile, writeFile } = await import("node:fs/promises");
  const updatedAt = new Date().toISOString();
  let fresh;
  try {
    fresh = await fromWorldRugby(updatedAt);
  } catch (err) {
    // The regression guard below stops a lagging Wikipedia table from
    // overwriting a fresher world.rugby one, so falling back is safe.
    console.log(`::warning::world.rugby rankings failed (${err.message}) — falling back to Wikipedia`);
    fresh = await fromWikipedia(updatedAt);
  }
  const prev = await readFile("rankings.json", "utf8").then(JSON.parse).catch(() => null);
  if (isRegression(prev?.asOf, fresh.asOf)) {
    console.log(
      `template says "as of ${fresh.asOf}" but rankings.json is already at "${prev.asOf}" — ` +
      `stale fetch, keeping the published table.`,
    );
    return;
  }
  if (isFutureDated(fresh.asOf)) {
    console.log(
      `template says "as of ${fresh.asOf}", which is in the future — likely a caption typo, ` +
      `keeping the published table${prev?.asOf ? ` ("as of ${prev.asOf}")` : ""}.`,
    );
    return;
  }
  const out = withHistory(prev, fresh);
  await writeFile("rankings.json", JSON.stringify(out, null, 1) + "\n");
  console.log(
    `rankings.json written from ${out.source} — ${Object.keys(out.rankings).length} teams, as of ${out.asOf}, ${out.history.length} archived week(s)`,
  );
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
