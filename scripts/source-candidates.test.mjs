import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROBE_DAYS, MAX_OPEN, READY_HITS, hostOf, mergeCandidates, renderCandidatesForReview, feedUrlsFor, parseAtom, countHits,
  recordProbe, hitTotals, pruneCandidates, dueForProbe, renderCandidatesMd, readCandidates, writeCandidates,
} from "./source-candidates.mjs";
import { FEEDS, TEAM_ALIASES, mentionsTeam } from "./news-sources.mjs";
import { buildReviewPrompt, TEAMS, parseRss } from "./generate-digests.mjs";
import { probeCandidate } from "./probe-source-candidates.mjs";

const proposal = (outlet, homepage, teams = ["Italy"]) => ({ outlet, homepage, teams, why: "Italy starved all week" });

test("mergeCandidates: dedupes by host against the spine and the file, caps the open list, keeps the rest with a reason", () => {
  const existing = [{ outlet: "Old", host: "old.example", status: "dead", teams: [] }];
  const { candidates, added, ignored } = mergeCandidates(existing, [
    proposal("Gazzetta", "https://www.gazzetta.it/rugby/"),
    proposal("Planet Rugby", "https://www.planetrugby.com/"),
    proposal("Old again", "https://old.example/"),
    { outlet: "No URL", homepage: "not a url", teams: [] },
  ], "2026-10-12", FEEDS);
  assert.equal(added.length, 1);
  assert.equal(added[0].host, "gazzetta.it");
  assert.equal(added[0].status, "proposed");
  assert.equal(added[0].proposed, "2026-10-12");
  assert.equal(candidates.length, 2);
  assert.equal(ignored.length, 3);
  assert.match(ignored[0], /planetrugby.com already in the spine/);
  assert.match(ignored[2], /no usable homepage/);

  const full = Array.from({ length: MAX_OPEN }, (_, i) => ({ outlet: `o${i}`, host: `o${i}.example`, status: "proposed", teams: [] }));
  const capped = mergeCandidates(full, [proposal("One more", "https://more.example/")], "2026-10-12");
  assert.equal(capped.added.length, 0);
  assert.match(capped.ignored[0], /already open/);
});

test("renderCandidatesForReview + buildReviewPrompt: the review sees the spine and the file, and the output gains source_candidates only then", () => {
  const block = renderCandidatesForReview(FEEDS, [
    { outlet: "Gazzetta", host: "gazzetta.it", status: "proposed", teams: ["Italy"] },
    { outlet: "Dead", host: "dead.example", status: "dead", teams: [] },
  ]);
  assert.match(block, /Planet Rugby \(planetrugby.com\)/);
  assert.match(block, /Gazzetta \(gazzetta.it\) — for Italy/);
  assert.match(block, /Dead \(dead.example\) — dead/);
  assert.match(block, /An empty array is the normal answer/);

  const editions = [{ team: "Italy", quiet: true, shortlist: [], digest: { edition: "Monday 12 October", sections: [] } }];
  const withSources = buildReviewPrompt(editions, "2026-10-12", [], [], { feeds: FEEDS, candidates: [] });
  assert.match(withSources, /"source_candidates"/);
  assert.match(withSources, /propose an outlet only when a team is starved/);
  const without = buildReviewPrompt(editions, "2026-10-12");
  assert.ok(!/source_candidates/.test(without), "no spine shown → no field asked for");
});

test("feedUrlsFor: advertised feeds first, then the usual paths, no duplicates", () => {
  const html = `<html><head>
    <link rel="alternate" type="application/rss+xml" title="RSS" href="/rugby/rss.xml">
    <link rel="alternate" type="application/atom+xml" href="https://feeds.example.com/atom">
    <link rel="stylesheet" href="/x.css">
  </head></html>`;
  const urls = feedUrlsFor("https://www.example.com/sport/", html);
  assert.equal(urls[0], "https://www.example.com/rugby/rss.xml");
  assert.equal(urls[1], "https://feeds.example.com/atom");
  assert.ok(urls.includes("https://www.example.com/feed"));
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(feedUrlsFor("https://www.example.com/")[0], "https://www.example.com/feed");
});

test("parseAtom reads <entry> feeds; countHits uses the spine's own alias test", () => {
  const atom = `<feed><entry><title>Quesada names Italy squad</title><link href="https://x/1"/><summary>Azzurri</summary><updated>2026-10-12</updated></entry>
    <entry><title>New South Wales cup final</title><link href="https://x/2"/></entry></feed>`;
  const items = parseAtom(atom);
  assert.equal(items.length, 2);
  assert.equal(items[0].link, "https://x/1");
  const byName = Object.fromEntries(Object.entries(TEAM_ALIASES).map(([id, l]) => [TEAMS[id].name, l]));
  const hits = countHits(items, byName, mentionsTeam);
  assert.deepEqual(hits, { Italy: 1 }, "the NSW item does not count for Wales");
  assert.equal(parseRss(atom).length, 0, "the spine's parser does not read atom, which is why parseAtom exists");
});

test("recordProbe: ready after enough stories about its team, dead after a week without, no-feed when nothing ever parsed, adopted once in the spine", () => {
  const base = { outlet: "G", host: "g.example", status: "proposed", teams: ["Italy"], probes: [] };
  let c = recordProbe(base, { feedUrl: "https://g.example/feed", items: 20, hits: { Italy: 2 } }, "2026-10-12");
  assert.equal(c.status, "proposed");
  assert.equal(c.feedUrl, "https://g.example/feed");
  c = recordProbe(c, { feedUrl: "https://g.example/feed", items: 20, hits: { Italy: 1, France: 5 } }, "2026-10-13");
  assert.equal(c.status, "ready", `${READY_HITS} stories about Italy`);
  assert.equal(c.decided, "2026-10-13");
  assert.deepEqual(hitTotals(c.probes), { Italy: 3, France: 5 });

  let d = base;
  for (let i = 1; i <= PROBE_DAYS; i++) d = recordProbe(d, { feedUrl: "f", items: 9, hits: { France: 1 } }, `2026-10-${10 + i}`);
  assert.equal(d.status, "dead", "stories, but not about the team it was proposed for");
  let n = base;
  for (let i = 1; i <= PROBE_DAYS; i++) n = recordProbe(n, { error: "no feed found" }, `2026-10-${10 + i}`);
  assert.equal(n.status, "no-feed");
  assert.equal(n.probes.length, PROBE_DAYS);

  const adopted = recordProbe({ ...base, host: "planetrugby.com" }, { error: "x" }, "2026-10-12", FEEDS);
  assert.equal(adopted.status, "adopted");
  // FBC News went into the spine on 11 Oct 2026; the next probe flips its record.
  const fbc = recordProbe({ ...base, host: "fbcnews.com.fj", status: "ready" }, { feedUrl: "https://www.fbcnews.com.fj/feed/", items: 10, hits: { Fiji: 7 } }, "2026-10-12", FEEDS);
  assert.equal(fbc.status, "adopted");
});

test("pruneCandidates and dueForProbe: decided ones age out, open ones are probed once a day", () => {
  const list = [
    { host: "a", status: "proposed", proposed: "2026-09-01", probes: [{ date: "2026-10-12" }] },
    { host: "b", status: "ready", proposed: "2026-09-01", decided: "2026-09-02", probes: [] },
    { host: "c", status: "dead", proposed: "2026-09-01", decided: "2026-09-10", probes: [] },
    { host: "d", status: "dead", proposed: "2026-10-01", decided: "2026-10-08", probes: [] },
  ];
  assert.deepEqual(pruneCandidates(list, "2026-10-12").map((c) => c.host), ["a", "b", "d"]);
  assert.deepEqual(dueForProbe(list, "2026-10-12").map((c) => c.host), ["b"], "a was probed today; c and d are decided");
});

test("renderCandidatesMd lists every status with its counts; the file round-trips", async () => {
  const root = await mkdtemp(join(tmpdir(), "cands-"));
  const path = join(root, "source-candidates.json");
  assert.deepEqual(await readCandidates(path), []);
  const cands = [
    { outlet: "G", host: "g.example", homepage: "https://g.example/", status: "ready", teams: ["Italy"], why: "starved", proposed: "2026-10-12", feedUrl: "https://g.example/feed", probes: [{ date: "2026-10-12", hits: { Italy: 3 } }, { date: "2026-10-13", error: "HTTP 500" }] },
    { outlet: "D", host: "d.example", homepage: "https://d.example/", status: "no-feed", teams: [], why: "", proposed: "2026-10-12", probes: [] },
  ];
  await writeCandidates(cands, path);
  assert.deepEqual(await readCandidates(path), cands);
  assert.match(await readFile(path, "utf8"), /Nothing here is a news source/);
  const md = renderCandidatesMd(cands, "2026-10-13");
  assert.match(md, /## Ready[\s\S]*\*\*G\*\* \(g.example\)[\s\S]*probes: 2 \(1 failed\); stories about tracked teams: Italy 3/);
  assert.match(md, /## Rejected[\s\S]*\*\*D\*\* \(d.example\)[\s\S]*feed: not found/);
  assert.match(md, /## Adopted\n\n- Nothing adopted yet/);
});

test("probeCandidate: tries the homepage's feeds in order, parses rss or atom, reports a clean failure", async () => {
  const pages = {
    "https://g.example/": `<link rel="alternate" type="application/rss+xml" href="/rss">`,
    "https://g.example/rss": `<rss><item><title>Quesada on Italy</title><link>https://g.example/1</link></item></rss>`,
  };
  const get = async (url) => {
    if (!(url in pages)) throw new Error("HTTP 404");
    return pages[url];
  };
  const ok = await probeCandidate({ outlet: "G", host: "g.example", homepage: "https://g.example/", teams: ["Italy"] }, { fetchText: get });
  assert.equal(ok.feedUrl, "https://g.example/rss");
  assert.equal(ok.items, 1);
  assert.deepEqual(ok.hits, { Italy: 1 });

  const bad = await probeCandidate({ outlet: "X", host: "x.example", homepage: "https://x.example/", teams: [] }, { fetchText: get });
  assert.match(bad.error, /no feed found \(\d+ tried; homepage HTTP 404\)/);
  assert.equal(hostOf("not a url"), null);
});
