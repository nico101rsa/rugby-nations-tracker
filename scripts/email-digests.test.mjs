import { test } from "node:test";
import assert from "node:assert/strict";
import { subjectFor, buildEmailHtml, redact } from "./email-digests.mjs";

const report = {
  date: "2026-07-20",
  counts: { editions: 12, quiet: 2, failed: 0, noLead: 0 },
  failed: [],
  teams: [
    {
      team: "South Africa",
      quiet: false,
      kicker: "Injury concern",
      heading: "Rassie Erasmus confirms Handré Pollard hamstring injury",
      body: "Erasmus confirmed the fly-half will be assessed before the Argentina tour.",
      source: "Planet Rugby",
      lead: { candidate: 2, why: "the day's biggest Bok story" },
      candidates: [
        { title: "Team of the Week named", score: 24.6, corroboration: 1, outlets: ["planetrugby"] },
        { title: "Erasmus provides Pollard update", score: 54.2, corroboration: 2, outlets: ["planetrugby", "bbc"] },
      ],
    },
    {
      team: "Fiji",
      quiet: true,
      kicker: "Second-half slide",
      heading: "Tevita Ikanivere leads early charge but Fiji fall to Scotland",
      body: "Fiji led at the break before Scotland pulled away.",
      source: null,
      lead: null,
      candidates: [],
    },
  ],
};

test("subjectFor: carries the counts that matter at a glance", () => {
  assert.equal(subjectFor(report), "Rugby briefings — 2026-07-20 (12/12 editions, 2 quiet)");
});

test("subjectFor: surfaces failures loudly", () => {
  const s = subjectFor({ date: "2026-07-20", counts: { editions: 9, quiet: 1, failed: 3 } });
  assert.match(s, /3 FAILED/);
});

test("subjectFor: survives a missing report shape", () => {
  assert.match(subjectFor(undefined), /0\/12 editions/);
  assert.match(subjectFor({}), /today/);
});

test("buildEmailHtml: distinguishes a data edition from a thin news one", () => {
  // The whole point: in the copy these look identical, but one is a retrieval
  // problem and the other is the format working as designed.
  const html = buildEmailHtml({
    date: "2026-07-21",
    counts: { editions: 12, quiet: 5, storyline: 2, dataEdition: 3 },
    teams: [
      { team: "Japan", rung: "data", dataAngle: "scoring", kicker: "Snapshot", heading: "H", body: "B", quiet: true },
      {
        team: "Fiji", rung: "storyline", kicker: "Contract", heading: "H2", body: "B2", quiet: true,
        storyline: { subject: "Nasova's next club", resolution: "until he signs somewhere", recheckHits: 4 },
      },
    ],
  });
  assert.match(html, /data edition/);
  assert.match(html, /from the storyline backlog/);
  assert.match(html, /written from the app's own match data \(scoring angle\)/);
  // esc() escapes &, <, > and " — an apostrophe needs no escaping in HTML text
  // content, so it survives verbatim.
  assert.match(html, /Nasova's next club/);
  assert.match(html, /until he signs somewhere/);
  assert.match(html, /re-check search found 4 result/);
});

test("buildEmailHtml: a news edition shows no rung chrome", () => {
  const html = buildEmailHtml({
    date: "2026-07-21",
    counts: { editions: 12, quiet: 0 },
    teams: [{ team: "South Africa", rung: "news", kicker: "Injury", heading: "H", body: "B", quiet: false }],
  });
  assert.doesNotMatch(html, /data edition/);
  assert.doesNotMatch(html, /storyline backlog/);
});

test("buildEmailHtml: renders every team's edition", () => {
  const html = buildEmailHtml(report);
  assert.match(html, /South Africa/);
  assert.match(html, /Rassie Erasmus confirms Handré Pollard hamstring injury/);
  assert.match(html, /Source: Planet Rugby/);
  assert.match(html, /Fiji/);
  assert.match(html, /quiet/);
});

test("buildEmailHtml: marks which candidate was picked and why", () => {
  const html = buildEmailHtml(report);
  assert.match(html, /▸ Erasmus provides Pollard update/, "the chosen candidate is flagged");
  assert.match(html, /the day's biggest Bok story/);
  assert.match(html, /2 outlets/);
});

test("buildEmailHtml: escapes HTML in copy rather than injecting it", () => {
  const html = buildEmailHtml({
    date: "2026-07-20",
    counts: { editions: 1 },
    teams: [{ team: "Wales", kicker: "k", heading: "<script>alert(1)</script>", body: "a & b", candidates: [] }],
  });
  assert.ok(!html.includes("<script>alert(1)</script>"), "script tags must not survive into the email");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a &amp; b/);
});

test("buildEmailHtml: shows failures when a run was partial", () => {
  const html = buildEmailHtml({
    date: "2026-07-20",
    counts: { editions: 11, quiet: 0, failed: 1 },
    failed: [{ team: "Japan", reason: "fact-check failed after 2 revisions" }],
    teams: [],
  });
  assert.match(html, /1 failed/);
  assert.match(html, /Japan: fact-check failed/);
});

test("buildEmailHtml: appends the editorial review when present, omits it when not", () => {
  assert.match(buildEmailHtml(report, "### Grade: B\n\nSolid day."), /Editorial review[\s\S]*Grade: B/);
  assert.ok(!/Editorial review/.test(buildEmailHtml(report, "")));
});

test("buildEmailHtml: a team with no candidates still renders", () => {
  const html = buildEmailHtml({ date: "2026-07-20", counts: { editions: 1 }, teams: [report.teams[1]] });
  assert.match(html, /Tevita Ikanivere/);
  assert.ok(!/What retrieval offered/.test(html), "no disclosure block when there was nothing on offer");
});

// This repo is public, so its workflow logs are public.
test("redact: never prints a full address in a log line", () => {
  const out = redact("nico.mcdonald@outlook.com");
  assert.ok(!out.includes("nico.mcdonald"), "local part must not survive");
  assert.ok(!out.includes("outlook"), "the provider must not survive either");
  assert.equal(redact(""), "(unset)");
  assert.equal(redact(undefined), "(unset)");
});
