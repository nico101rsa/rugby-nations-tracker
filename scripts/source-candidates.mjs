// News-source candidates: outlets the daily review thinks the publisher spine
// (news-sources.mjs FEEDS) is missing, probed before anyone decides.
//
// The daily review (generate-digests.mjs reviewRun, Sonnet 5.5 from 11 Oct
// 2026) sees which teams were retrieval-starved and may propose up to three
// outlets a day. Those land here as candidates with status "proposed"; nothing
// is added to FEEDS by code. Each day the probe (probe-source-candidates.mjs)
// finds the candidate's feed from its homepage, fetches it, and counts the
// items that mention each tracked team (news-sources.mjs mentionsTeam, the
// same test the spine uses). After PROBE_DAYS probes the candidate is either
// "ready" (it carried items about the teams it was proposed for) or "dead"
// (no feed, or nothing about any tracked team), and the weekly review reads
// the rendered editorial/source-candidates.md and puts the ready ones to
// Nico. Adding an outlet to FEEDS is his call: this repo is public, the spine
// carries publishers' text, and the roster is deliberately small.
//
// Pure helpers test offline; fetching lives in the probe script.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CANDIDATES_FILE = join(ROOT, "editorial", "source-candidates.json");
export const CANDIDATES_MD = join(ROOT, "editorial", "source-candidates.md");

// How many probes decide a candidate, how many open candidates are kept, and
// how long a decided one stays listed before it is dropped from the file.
export const PROBE_DAYS = 7;
export const MAX_OPEN = 8;
export const KEEP_DECIDED_DAYS = 21;
// A candidate with at least this many items about its proposed teams across
// its probes is "ready".
export const READY_HITS = 3;

export const hostOf = (url) => {
  try {
    return new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

export async function readCandidates(path = CANDIDATES_FILE) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  } catch {
    return [];
  }
}

export async function writeCandidates(candidates, path = CANDIDATES_FILE) {
  await writeFile(path, `${JSON.stringify({
    notice: "Outlets proposed by the daily editorial review and probed by code. Nothing here is a news source until it is added to scripts/news-sources.mjs by hand.",
    candidates,
  }, null, 2)}\n`);
}

// What the review is shown: the spine, and the candidates already on file so
// it does not propose them again. Pure.
export function renderCandidatesForReview(feeds, candidates = []) {
  const spine = feeds.map((f) => `- ${f.name} (${hostOf(f.url) ?? f.url})`).join("\n");
  const open = candidates.filter((c) => c.status === "proposed" || c.status === "ready");
  const seen = candidates.filter((c) => c.status !== "proposed" && c.status !== "ready");
  return `## News sources — propose an outlet only when a team is starved

The spine the writer reads from is these feeds, pulled hourly:
${spine}
${open.length ? `
Already proposed and being probed (do NOT propose these again):
${open.map((c) => `- ${c.outlet} (${c.host}) — for ${c.teams.join(", ")}`).join("\n")}` : ""}${seen.length ? `
Probed before and rejected or adopted (do NOT propose these again):
${seen.map((c) => `- ${c.outlet} (${c.host}) — ${c.status}`).join("\n")}` : ""}

If a team was RETRIEVAL-STARVED today and you know an English-language outlet
that covers that team's men's XV regularly (a national paper's rugby desk, a
union's own news page, a dedicated rugby site), you may propose it in
\`source_candidates\`: at most 3, only outlets you are confident exist, with the
real front-page URL. The code will look for the outlet's RSS feed and count
how many of its stories mention the team over a week, so a wrong URL costs one
failed probe, not a bad source. Never propose a social network, an aggregator,
a betting site, a feed already in the spine, or a site whose coverage is paywalled.
An empty array is the normal answer.`;
}

// Merge the review's proposals into the file. Dedupes by host against the
// spine and every candidate already on file (whatever its status), caps the
// open list, and returns what was added and why the rest was ignored. Pure.
export function mergeCandidates(existing, proposed, dateISO, feeds = []) {
  const taken = new Set([...feeds.map((f) => hostOf(f.url)), ...existing.map((c) => c.host)].filter(Boolean));
  const open = existing.filter((c) => c.status === "proposed").length;
  const added = [];
  const ignored = [];
  let room = Math.max(0, MAX_OPEN - open);
  for (const p of proposed) {
    const host = hostOf(p.homepage);
    const outlet = String(p.outlet ?? "").trim().slice(0, 80);
    if (!host || !outlet) {
      ignored.push(`${outlet || "?"}: no usable homepage`);
      continue;
    }
    if (taken.has(host)) {
      ignored.push(`${outlet}: ${host} already in the spine or on file`);
      continue;
    }
    if (!room) {
      ignored.push(`${outlet}: ${MAX_OPEN} candidates already open`);
      continue;
    }
    room--;
    taken.add(host);
    added.push({
      outlet,
      host,
      homepage: String(p.homepage).trim().slice(0, 200),
      teams: (Array.isArray(p.teams) ? p.teams : []).map((t) => String(t).trim()).filter(Boolean).slice(0, 4),
      why: String(p.why ?? "").trim().slice(0, 240),
      proposed: dateISO,
      status: "proposed",
      feedUrl: null,
      probes: [],
    });
  }
  return { candidates: [...existing, ...added], added, ignored };
}

export async function addCandidates(existing, proposed, dateISO, feeds = [], path = CANDIDATES_FILE) {
  const result = mergeCandidates(existing, proposed, dateISO, feeds);
  if (result.added.length) {
    await writeCandidates(result.candidates, path);
    await writeFile(CANDIDATES_MD, renderCandidatesMd(result.candidates, dateISO));
  }
  return result;
}

// ---- probing (pure parts) ----------------------------------------------------

// Feed URLs to try for a homepage: the ones the page itself advertises
// (<link rel="alternate" type="application/rss+xml|application/atom+xml">),
// then the usual paths. Pure.
export function feedUrlsFor(homepage, html = "") {
  const urls = [];
  const base = new URL(homepage);
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel=["']?alternate["']?/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml["']?/i.test(tag)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    try {
      urls.push(new URL(href, base).href);
    } catch {
      // unusable href
    }
  }
  for (const path of ["/feed", "/rss", "/feed/rss", "/rss.xml", "/feed.xml", "/?feed=rss2", "/rugby/feed", "/sport/rugby/rss"]) {
    urls.push(new URL(path, base).href);
  }
  return [...new Set(urls)];
}

// Atom feeds (<entry>) are read too; the spine's parseRss only knows <item>.
export function parseAtom(xml) {
  return [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, it]) => {
    const g = (tag) => (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] ?? "";
    const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
    const link = (it.match(/<link[^>]*href=["']([^"']+)["']/) || [])[1] ?? "";
    return { title: strip(g("title")), link, desc: strip(g("summary") || g("content")), date: g("updated") || g("published") };
  }).filter((i) => i.title && i.link);
}

// Count the feed's items that mention each tracked team. `aliases` is
// news-sources.mjs TEAM_ALIASES ({ teamName: [alias, …] }); `mentions` is its
// mentionsTeam. Pure.
export function countHits(items, aliases, mentions) {
  const hits = {};
  for (const [team, list] of Object.entries(aliases)) {
    const n = items.filter((i) => mentions(`${i.title} ${i.desc ?? ""}`, list)).length;
    if (n) hits[team] = n;
  }
  return hits;
}

// Add a probe result and decide the candidate's status. Pure.
export function recordProbe(candidate, probe, dateISO, feeds = []) {
  const probes = [...(candidate.probes ?? []), { date: dateISO, ...probe }].slice(-14);
  const next = { ...candidate, probes };
  if (probe.feedUrl) next.feedUrl = probe.feedUrl;
  if (feeds.some((f) => hostOf(f.url) === candidate.host)) {
    next.status = "adopted";
    next.decided = next.decided ?? dateISO;
    return next;
  }
  if (candidate.status !== "proposed") return next;
  const scored = probes.filter((p) => !p.error);
  const own = candidate.teams.length ? candidate.teams : Object.keys(hitTotals(probes));
  const ownHits = own.reduce((n, t) => n + (hitTotals(probes)[t] ?? 0), 0);
  if (ownHits >= READY_HITS) {
    next.status = "ready";
    next.decided = dateISO;
  } else if (probes.length >= PROBE_DAYS) {
    next.status = scored.length ? "dead" : "no-feed";
    next.decided = dateISO;
  }
  return next;
}

export function hitTotals(probes = []) {
  const totals = {};
  for (const p of probes) for (const [team, n] of Object.entries(p.hits ?? {})) totals[team] = (totals[team] ?? 0) + n;
  return totals;
}

// Drop decided candidates after KEEP_DECIDED_DAYS. Pure.
export function pruneCandidates(candidates, dateISO) {
  const cutoff = Date.parse(dateISO) - KEEP_DECIDED_DAYS * 86_400_000;
  return candidates.filter((c) => c.status === "proposed" || c.status === "ready" || !(Date.parse(c.decided ?? c.proposed) < cutoff));
}

// Which candidates are due a probe today: open ones not yet probed today.
export function dueForProbe(candidates, dateISO) {
  return candidates.filter((c) => (c.status === "proposed" || c.status === "ready") && !(c.probes ?? []).some((p) => p.date === dateISO));
}

// The human-readable page the weekly review reads. Pure.
export function renderCandidatesMd(candidates, dateISO) {
  const line = (c) => {
    const totals = hitTotals(c.probes);
    const hits = Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(", ") || "none";
    const probed = (c.probes ?? []).length;
    const errors = (c.probes ?? []).filter((p) => p.error).length;
    return `- **${c.outlet}** (${c.host}) — proposed ${c.proposed} for ${c.teams.join(", ") || "no team named"}: ${c.why || "no reason given"}\n` +
      `  - feed: ${c.feedUrl ?? "not found"}; probes: ${probed}${errors ? ` (${errors} failed)` : ""}; stories about tracked teams: ${hits}`;
  };
  const by = (status) => candidates.filter((c) => c.status === status);
  const section = (title, list, empty) => `## ${title}\n\n${list.length ? list.map(line).join("\n") : `- ${empty}`}\n`;
  return `# News-source candidates\n\n_Proposed by the daily editorial review, probed daily by \`scripts/probe-source-candidates.mjs\`, decided after ${PROBE_DAYS} probes. ` +
    `Nothing here feeds the app until it is added to \`scripts/news-sources.mjs\` by hand — the weekly review puts the ready ones to Nico. Updated ${dateISO}._\n\n` +
    section("Ready — carried stories about the team they were proposed for", by("ready"), "Nothing ready.") + "\n" +
    section("Being probed", by("proposed"), "Nothing proposed.") + "\n" +
    section("Rejected (no feed, or nothing about a tracked team in a week)", [...by("dead"), ...by("no-feed")], "Nothing rejected.") + "\n" +
    section("Adopted", by("adopted"), "Nothing adopted yet.");
}
