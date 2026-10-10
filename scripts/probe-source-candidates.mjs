// Daily probe of the news-source candidates the editorial review proposed
// (source-candidates.mjs). For each open candidate not yet probed today: fetch
// its homepage, find its feed, fetch the feed, count the items about each
// tracked team, record the result, and decide the candidate once it has had
// its week. Writes editorial/source-candidates.{json,md}; touches nothing the
// app reads and adds nothing to the spine.
//
// Runs after the digest in generate-digests.yml (continue-on-error). A dozen
// fetches a day at most, no model calls, no quota.
//
// Usage: node scripts/probe-source-candidates.mjs
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { TEAMS, parseRss } from "./generate-digests.mjs";
import { FEEDS, TEAM_ALIASES, mentionsTeam } from "./news-sources.mjs";
import {
  CANDIDATES_FILE, CANDIDATES_MD, readCandidates, writeCandidates, feedUrlsFor, parseAtom, countHits,
  recordProbe, pruneCandidates, dueForProbe, renderCandidatesMd,
} from "./source-candidates.mjs";

const FETCH_TIMEOUT_MS = 15000;
const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" };

const sydneyDate = (now) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
}).format(now);

// Aliases keyed by team NAME, which is how the review names teams.
const aliasesByName = Object.fromEntries(
  Object.entries(TEAM_ALIASES).map(([id, list]) => [TEAMS[id]?.name ?? id, list]),
);

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// One candidate: { feedUrl, items, hits } or { error }.
export async function probeCandidate(candidate, { fetchText: get = fetchText } = {}) {
  let html = "";
  try {
    html = await get(candidate.homepage);
  } catch (e) {
    // A homepage that will not load still gets its common feed paths tried.
    html = "";
    candidate = { ...candidate, homepageError: String(e.message).slice(0, 80) };
  }
  const tried = candidate.feedUrl ? [candidate.feedUrl, ...feedUrlsFor(candidate.homepage, html)] : feedUrlsFor(candidate.homepage, html);
  const errors = [];
  for (const url of [...new Set(tried)].slice(0, 10)) {
    try {
      const xml = await get(url);
      const items = parseRss(xml).length ? parseRss(xml) : parseAtom(xml);
      if (!items.length) {
        errors.push(`${url}: no items`);
        continue;
      }
      return { feedUrl: url, items: items.length, hits: countHits(items, aliasesByName, mentionsTeam) };
    } catch (e) {
      errors.push(`${url}: ${String(e.message).slice(0, 60)}`);
    }
  }
  return { error: `no feed found (${errors.length} tried${candidate.homepageError ? `; homepage ${candidate.homepageError}` : ""})` };
}

export async function main({ now = new Date() } = {}) {
  const dateISO = sydneyDate(now);
  let candidates = await readCandidates();
  const due = dueForProbe(candidates, dateISO);
  if (!candidates.length) {
    console.log("source candidates: none on file");
    return { probed: 0 };
  }
  for (const c of due) {
    const probe = await probeCandidate(c);
    const next = recordProbe(c, probe, dateISO, FEEDS);
    candidates = candidates.map((x) => (x.host === c.host ? next : x));
    const hits = Object.entries(probe.hits ?? {}).map(([t, n]) => `${t} ${n}`).join(", ") || "none";
    console.log(`${c.outlet} (${c.host}): ${probe.error ?? `${probe.items} items via ${probe.feedUrl}; tracked-team stories: ${hits}`} → ${next.status}`);
  }
  candidates = pruneCandidates(candidates, dateISO);
  await writeCandidates(candidates, CANDIDATES_FILE);
  await writeFile(CANDIDATES_MD, renderCandidatesMd(candidates, dateISO));
  const ready = candidates.filter((c) => c.status === "ready");
  console.log(`source candidates: ${due.length} probed, ${candidates.filter((c) => c.status === "proposed").length} open, ${ready.length} ready${ready.length ? ` (${ready.map((c) => c.outlet).join(", ")})` : ""}`);
  return { probed: due.length, ready: ready.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
