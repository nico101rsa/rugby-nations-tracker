// One-off probe; compact lines only.
const get = async (url) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(20000) }); return { status: r.status, json: await r.json().catch(() => null) }; }
  catch (e) { return { status: 0, error: String(e.message) }; }
};
const KEEP = ["rank", "gamesPlayed", "gamesWon", "gamesDrawn", "gamesLost", "pointsFor", "pointsAgainst", "triesFor", "triesAgainst", "bonusPointsTry", "bonusPointsLosing", "bonusPoints", "points"];
for (const [name, league, q] of [["rnc", 17567, "?season=2026"], ["rnc-noseason", 17567, ""], ["6n-2027", 180659, "?season=2027"], ["6n-noseason", 180659, ""], ["rwc-2027", 164205, "?season=2027"], ["trc", 244293, ""], ["l256449", 256449, ""]]) {
  const r = await get(`https://site.api.espn.com/apis/v2/sports/rugby/${league}/standings${q}`);
  const j = r.json ?? {};
  const groups = j.children ?? (j.standings ? [j] : []);
  console.log(`\n## ${name} -> ${r.status} ${r.error ?? ""} name=${j.name} season=${JSON.stringify(j.season ?? null)?.slice(0, 160)} groups=${groups.length} childKeys=${Object.keys(groups[0] ?? {})}`);
  for (const g of groups) for (const x of g.standings?.entries ?? []) {
    const s = Object.fromEntries((x.stats ?? []).map((t) => [t.name, t.value]));
    console.log(`  [${g.name}|${g.abbreviation ?? ""}] ${x.team?.abbreviation} id=${x.team?.id} ${KEEP.map((k) => `${k}=${s[k]}`).join(" ")}`);
  }
}
