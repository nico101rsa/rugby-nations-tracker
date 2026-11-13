// One-off probe; prints payload shapes only. Never prints the key.
const show = (label, v, n = 6000) => console.log(`\n===== ${label}\n${JSON.stringify(v, null, 1).slice(0, n)}`);
const get = async (url, headers = {}) => {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text: json ? null : text.slice(0, 300) };
  } catch (e) { return { status: 0, error: String(e.message) }; }
};
const trim = (o, depth = 0) => {
  if (Array.isArray(o)) return o.slice(0, depth > 3 ? 2 : 14).map((x) => trim(x, depth + 1));
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (/logo|href|links|\$ref|uid|guid|flag/i.test(k)) continue;
      out[k] = trim(v, depth + 1);
    }
    return out;
  }
  return o;
};
for (const [name, league, season] of [["rnc", 17567, 2026], ["6n", 180659, 2026], ["rwc", 164205, 2023]]) {
  for (const url of [
    `https://site.api.espn.com/apis/v2/sports/rugby/${league}/standings?season=${season}`,
    `https://site.web.api.espn.com/apis/v2/sports/rugby/${league}/standings?season=${season}`,
  ]) {
    const r = await get(url);
    console.log(`\n##### ${name} ${url} -> ${r.status} ${r.error ?? ""} ${r.text ?? ""}`);
    if (r.json) {
      console.log("top keys:", Object.keys(r.json));
      const groups = r.json.children ?? (r.json.standings ? [r.json] : []);
      console.log("groups:", groups.map((g) => `${g.name ?? g.abbreviation ?? "?"} (${g.standings?.entries?.length ?? 0} entries)`));
      const e = groups[0]?.standings?.entries ?? [];
      for (const g of groups) for (const x of g.standings?.entries ?? []) {
        console.log(`  [${g.name ?? ""}] ${x.team?.abbreviation} ${x.team?.displayName} id=${x.team?.id} :: ${(x.stats ?? []).map((s) => `${s.name ?? s.type}=${s.value ?? s.displayValue}`).join(" ")}`);
      }
      if (e[0]) show(`${name} first entry (trimmed)`, trim(e[0]), 3000);
      else show(`${name} body (trimmed)`, trim(r.json), 2500);
      if (e[0]) break;
    }
  }
}
if (process.env.RUGBY_API_KEY) {
  for (const [league, season] of [[145, 2026]]) {
    const r = await get(`https://v1.rugby.api-sports.io/standings?league=${league}&season=${season}`, { "x-apisports-key": process.env.RUGBY_API_KEY });
    console.log(`\n##### api-sports standings league=${league} season=${season} -> ${r.status}`);
    if (r.json) {
      console.log("errors:", JSON.stringify(r.json.errors), "results:", r.json.results);
      show("api-sports response (trimmed)", trim(r.json.response), 7000);
    }
  }
} else console.log("no RUGBY_API_KEY");
