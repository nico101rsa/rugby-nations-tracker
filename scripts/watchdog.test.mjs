import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluate, formatReport, coverageReport, repeatLeadReport, ladderReport,
  WATCHERS as LIVE_WATCHERS, PAGE_AFTER_HEAL_HOURS, summariseRuns, selectHeals, dispatchArgs, nextHeals,
  pagingMisses, pageSignature, pagedIn, decidePageAction, pageReport, sydney,
  statusLine, appendHistory, buildStatus, renderStatusMarkdown, writeStatus,
  nextPageRecord, heldPages, syncPageIssue,
} from "./watchdog.mjs";
import { PUBLISH_TEAMSHEETS } from "./generate-digests.mjs";

const WATCHERS = [
  { workflow: "a.yml", label: "A", maxAgeHours: 26 },
  { workflow: "b.yml", label: "B", maxAgeHours: 6 },
];
const NOW = new Date("2026-07-13T00:00:00Z");

test("all fresh → no misses", () => {
  const latest = {
    "a.yml": new Date("2026-07-12T20:00:00Z"), // 4h ago
    "b.yml": new Date("2026-07-12T22:00:00Z"), // 2h ago
  };
  assert.deepEqual(evaluate(NOW, latest, WATCHERS), []);
});

test("stale run past its limit is a miss", () => {
  const latest = {
    "a.yml": new Date("2026-07-12T20:00:00Z"), // 4h ago, ok
    "b.yml": new Date("2026-07-12T10:00:00Z"), // 14h ago > 6h
  };
  const misses = evaluate(NOW, latest, WATCHERS);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].workflow, "b.yml");
  assert.ok(misses[0].ageHours > 6);
});

test("no successful run at all is a miss", () => {
  const latest = { "a.yml": null, "b.yml": new Date("2026-07-12T22:00:00Z") };
  const misses = evaluate(NOW, latest, WATCHERS);
  assert.equal(misses.length, 1);
  assert.equal(misses[0].lastSuccessAt, null);
  assert.equal(misses[0].ageHours, null);
});

test("exactly at the limit is not a miss (boundary)", () => {
  const latest = { "a.yml": new Date("2026-07-11T22:00:00Z"), "b.yml": new Date("2026-07-12T18:00:00Z") };
  // a.yml is exactly 26h; b.yml exactly 6h — both allowed.
  assert.deepEqual(evaluate(NOW, latest, WATCHERS), []);
});

test("report names the overdue job and its age", () => {
  const misses = evaluate(NOW, { "a.yml": null, "b.yml": new Date("2026-07-12T10:00:00Z") }, WATCHERS);
  const report = formatReport(misses, NOW);
  assert.match(report, /no successful run found at all/);
  assert.match(report, /14\.0h ago/);
  assert.match(report, /cron drift/);
});

// Squad-coverage email: the safeguard the 2026-07-14 blank-squad miss revealed
// was absent — the watchdog only checked that jobs RAN, never that squads were
// present. It turns teamsheetGaps into a daily alert — but ONLY while squads are
// published. With teamsheets paused (PUBLISH_TEAMSHEETS=false), a missing squad
// is the intended state, so coverageReport must stay silent. This test tracks
// the live flag so it still asserts the gap listing if squads are turned back on.
test("coverageReport: silent while paused, lists missing squads when live", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const nations = {
    fixtures: [
      { date: "2026-07-18T15:40:00+00:00", home: { id: 467, name: "South Africa" }, away: { id: 391, name: "Wales" } },
      { date: "2026-11-06T12:00:00+00:00", home: { id: 386, name: "England" }, away: { id: 460, name: "Argentina" } },
    ],
    digests: { 391: { teamsheet: { starters: [] } } }, // Wales covered; SA not
  };
  const rep = coverageReport(nations, now);
  if (!PUBLISH_TEAMSHEETS) {
    assert.equal(rep, null); // teamsheets paused: a missing squad is not a gap
    return;
  }
  assert.equal(rep.gaps.length, 1);
  assert.equal(rep.gaps[0].team, "South Africa");
  assert.match(rep.text, /South Africa/);
  assert.match(rep.text, /no published squad/i);
});

test("coverageReport is null when every imminent team has a squad", () => {
  const now = new Date("2026-07-14T00:00:00Z");
  const nations = {
    fixtures: [{ date: "2026-07-18T15:40:00+00:00", home: { id: 467, name: "South Africa" }, away: { id: 391, name: "Wales" } }],
    digests: { 467: { teamsheet: {} }, 391: { teamsheet: {} } },
  };
  assert.equal(coverageReport(nations, now), null);
});

// ---- the page tier ------------------------------------------------------------
// Until 2026-10-04 every alert state shared one issue, and its signature carried
// the repeat-lead day count, so it re-pinged Nico on 30 Sep and 1-4 Oct for
// briefings that were a day stale. Now only a user-facing job that stayed down
// after a self-heal pages, and the signature is the set of paged jobs alone.

const miss = (workflow) => ({ workflow, label: workflow, maxAgeHours: 6, lastSuccessAt: null, ageHours: null });

test("pageSignature is stable regardless of ordering, and carries no ages or day counts", () => {
  const a = pageSignature([{ ...miss("b.yml"), ageHours: 30 }, { ...miss("a.yml"), ageHours: 40 }]);
  const b = pageSignature([{ ...miss("a.yml"), ageHours: 54 }, { ...miss("b.yml"), ageHours: 64 }]);
  assert.equal(a, b);
  assert.equal(a, "a.yml,b.yml");
  assert.notEqual(a, pageSignature([miss("a.yml")])); // a different SET of jobs is a different page
  assert.equal(pageSignature([]), "");
  assert.deepEqual([...pagedIn(`x\n<!-- page: ${a} -->`)], ["a.yml", "b.yml"]);
  assert.equal(pagedIn("an old-format body <!-- sig: jobs=[] leads=[Ireland:2] -->").size, 0);
});

test("decidePageAction: opens once, refreshes silently, comments only when a new job joins, closes quietly", () => {
  const open = { number: 7, body: "something\n<!-- page: team-events.yml -->" };
  assert.equal(decidePageAction(null, [miss("team-events.yml")]), "create"); // first page of an outage
  assert.equal(decidePageAction(open, [miss("team-events.yml")]), "edit"); // same outage next day → silent refresh, no ping
  assert.equal(decidePageAction(open, [miss("team-events.yml"), miss("refresh-data.yml")]), "update"); // a NEW job is down → one ping
  assert.equal(decidePageAction({ number: 7, body: "x\n<!-- page: a.yml,b.yml -->" }, [miss("a.yml")]), "edit"); // one recovered → silent
  assert.equal(decidePageAction(open, []), "close"); // nothing pages → close (no recovered comment)
  assert.equal(decidePageAction(null, []), "noop");
  // The pre-2026-10-04 issue (#132) has no page marker: a page on it is news.
  assert.equal(decidePageAction({ number: 132, body: "<!-- sig: jobs=[] squads=[] leads=[Ireland:2] rung=[x] -->" }, [miss("a.yml")]), "update");
});

// ---- run history ---------------------------------------------------------------

test("summariseRuns: newest success whatever the row order, and whether a run is in flight", () => {
  const rows = [
    { createdAt: "2026-10-01T20:00:00Z", status: "completed", conclusion: "success" },
    { createdAt: "2026-10-02T20:00:00Z", status: "completed", conclusion: "failure" },
    { createdAt: "2026-10-01T23:32:00Z", status: "completed", conclusion: "success" },
    { createdAt: "2026-09-26T17:00:00Z", status: "completed", conclusion: "success" },
  ];
  const s = summariseRuns(rows);
  assert.equal(s.lastSuccessAt.toISOString(), "2026-10-01T23:32:00.000Z");
  assert.equal(s.active, false);
  assert.equal(summariseRuns([...rows, { createdAt: "2026-10-03T00:00:00Z", status: "queued", conclusion: null }]).active, true);
  assert.equal(summariseRuns([{ createdAt: "2026-10-03T00:00:00Z", status: "in_progress", conclusion: null }]).active, true);
  assert.deepEqual(summariseRuns([]), { lastSuccessAt: null, active: false });
  assert.deepEqual(summariseRuns(null), { lastSuccessAt: null, active: false });
});

// ---- self-heal -------------------------------------------------------------------

const W = Object.fromEntries(LIVE_WATCHERS.map((w) => [w.workflow, w]));
const overdue = (workflow, lastSuccessAt = null) => ({ ...W[workflow], lastSuccessAt: lastSuccessAt && new Date(lastSuccessAt), ageHours: null });

test("selectHeals: re-runs each overdue job unless one is already in flight", () => {
  const misses = [overdue("generate-digests.yml"), overdue("refresh-data.yml")];
  assert.deepEqual(selectHeals(misses, {}), { dispatch: ["generate-digests.yml", "refresh-data.yml"], skipped: [] });
  const plan = selectHeals(misses, { "refresh-data.yml": true });
  assert.deepEqual(plan.dispatch, ["generate-digests.yml"]);
  assert.deepEqual(plan.skipped, [{ workflow: "refresh-data.yml", reason: "a run is already queued or in progress" }]);
  assert.deepEqual(selectHeals([], {}), { dispatch: [], skipped: [] });
});

test("selectHeals: the catch-up is not dispatched next to a team-events re-run (shared concurrency group)", () => {
  const both = [overdue("team-events.yml"), overdue("team-events-catchup.yml")];
  const plan = selectHeals(both, {});
  assert.deepEqual(plan.dispatch, ["team-events.yml"]);
  assert.deepEqual(plan.skipped, [{ workflow: "team-events-catchup.yml", reason: "covered by team-events.yml" }]);
  // A full run already in flight covers it too.
  assert.deepEqual(selectHeals([overdue("team-events-catchup.yml")], { "team-events.yml": true }).dispatch, []);
  // On its own, the catch-up is re-run like anything else.
  assert.deepEqual(selectHeals([overdue("team-events-catchup.yml")], {}).dispatch, ["team-events-catchup.yml"]);
});

test("dispatchArgs: re-runs on main; only refresh-data gets the source input its run-name reads", () => {
  assert.deepEqual(dispatchArgs(W["team-events.yml"]), ["workflow", "run", "team-events.yml", "--ref", "main"]);
  assert.deepEqual(dispatchArgs(W["refresh-data.yml"]), ["workflow", "run", "refresh-data.yml", "--ref", "main", "-f", "source=watchdog"]);
  // A workflow without declared inputs must get no -f: GitHub 422s unexpected inputs.
  for (const wf of ["generate-digests.yml", "team-events-catchup.yml"]) assert.ok(!dispatchArgs(W[wf]).includes("-f"), wf);
});

test("nextHeals: one record per outage — first heal kept, attempts counted, recovered jobs dropped", () => {
  const day1 = new Date("2026-10-01T01:16:00Z");
  const day2 = new Date("2026-10-02T01:40:00Z");
  const m = [overdue("team-events.yml", "2026-09-29T06:20:44Z")];
  const h1 = nextHeals({}, m, { dispatch: ["team-events.yml"], skipped: [] }, { "team-events.yml": { ok: true } }, day1);
  assert.deepEqual(h1["team-events.yml"], {
    firstAt: day1.toISOString(), lastAt: day1.toISOString(), attempts: 1, outcome: "re-run dispatched", streak: 1, streakSince: day1.toISOString(),
  });

  const h2 = nextHeals(h1, m, { dispatch: ["team-events.yml"], skipped: [] }, { "team-events.yml": { ok: false, error: "HTTP 403" } }, day2);
  assert.equal(h2["team-events.yml"].firstAt, day1.toISOString()); // same outage
  assert.equal(h2["team-events.yml"].attempts, 2);
  assert.equal(h2["team-events.yml"].outcome, "dispatch failed — HTTP 403");

  // A success after the earlier heal means that outage ended; this is a new one.
  const fresh = nextHeals(h1, [overdue("team-events.yml", "2026-10-01T06:38:47Z")], { dispatch: [], skipped: [{ workflow: "team-events.yml", reason: "a run is already queued or in progress" }] }, {}, day2);
  assert.equal(fresh["team-events.yml"].firstAt, day2.toISOString());
  assert.equal(fresh["team-events.yml"].attempts, 1);
  assert.match(fresh["team-events.yml"].outcome, /^not dispatched — a run is already queued/);

  assert.deepEqual(nextHeals(h1, [], { dispatch: [], skipped: [] }, {}, day2), {}); // recovered → dropped
});

test("pagingMisses: only a user-facing job still overdue after an EARLIER heal pages", () => {
  const healAt = new Date("2026-10-01T01:16:00Z");
  const nextDay = new Date("2026-10-02T01:40:00Z");
  const heals = { "team-events.yml": { firstAt: healAt.toISOString(), attempts: 1 }, "team-events-catchup.yml": { firstAt: healAt.toISOString(), attempts: 1 } };
  const m = [overdue("team-events.yml", "2026-09-29T06:20:44Z"), overdue("team-events-catchup.yml", "2026-09-29T06:20:44Z")];

  assert.deepEqual(pagingMisses(m, {}, nextDay), []); // never healed → heal first, don't page
  assert.deepEqual(pagingMisses(m, undefined, nextDay), []);
  assert.deepEqual(pagingMisses(m, heals, nextDay).map((x) => x.workflow), ["team-events.yml"]); // catch-up never pages
  // A heal younger than the floor (a manual watchdog re-run minutes later) does not page yet.
  const soon = new Date(healAt.getTime() + (PAGE_AFTER_HEAL_HOURS - 1) * 3600000);
  assert.deepEqual(pagingMisses(m, heals, soon), []);
  // A success since the heal belongs to a later outage: no page off a stale record.
  assert.deepEqual(pagingMisses([overdue("team-events.yml", "2026-10-01T06:38:47Z")], heals, nextDay), []);
  // Garbage in the committed file never pages.
  assert.deepEqual(pagingMisses(m, { "team-events.yml": { firstAt: "not a date" } }, nextDay), []);
});

test("two-day scenario: day 1 heals silently, day 2 pages once, day 3 recovery closes", () => {
  const latestFail = { "generate-digests.yml": new Date("2026-09-30T23:00:00Z"), "refresh-data.yml": new Date("2026-10-01T00:30:00Z"),
    "team-events.yml": new Date("2026-09-29T06:20:44Z"), "team-events-catchup.yml": new Date("2026-09-30T14:00:00Z") };
  const day1 = new Date("2026-10-01T01:16:00Z");
  const m1 = evaluate(day1, latestFail);
  assert.deepEqual(m1.map((x) => x.workflow), ["team-events.yml"]);
  assert.deepEqual(pagingMisses(m1, {}, day1), []);
  const plan1 = selectHeals(m1, {});
  const heals1 = nextHeals({}, m1, plan1, { "team-events.yml": { ok: true } }, day1);
  assert.equal(decidePageAction(null, []), "noop"); // day 1: nobody is pinged

  const day2 = new Date("2026-10-02T01:40:00Z");
  const m2 = evaluate(day2, { ...latestFail, "generate-digests.yml": new Date("2026-10-01T23:32:00Z"), "refresh-data.yml": new Date("2026-10-02T01:30:00Z"), "team-events-catchup.yml": new Date("2026-10-01T14:00:00Z") });
  const p2 = pagingMisses(m2, heals1, day2);
  assert.deepEqual(p2.map((x) => x.workflow), ["team-events.yml"]);
  assert.equal(decidePageAction(null, p2), "create"); // the one ping
  const heals2 = nextHeals(heals1, m2, selectHeals(m2, {}), { "team-events.yml": { ok: true } }, day2);
  const issue = { number: 140, body: `x\n<!-- page: ${pageSignature(p2)} -->` };

  const day3 = new Date("2026-10-03T01:10:00Z");
  const m3 = evaluate(day3, { ...latestFail, "team-events.yml": new Date("2026-10-02T06:22:17Z"), "generate-digests.yml": new Date("2026-10-02T23:24:00Z"), "refresh-data.yml": new Date("2026-10-03T01:00:00Z"), "team-events-catchup.yml": new Date("2026-10-02T14:00:00Z") });
  assert.deepEqual(m3, []);
  assert.equal(decidePageAction(issue, pagingMisses(m3, heals2, day3)), "close");
});

test("pageReport: names the job, what readers see, and the heal, in Sydney time", () => {
  const now = new Date("2026-10-02T01:40:00Z");
  const p = [{ ...overdue("team-events.yml", "2026-09-29T06:20:44Z") }];
  const text = pageReport(p, { "team-events.yml": { firstAt: "2026-10-01T01:16:00Z", attempts: 2 } }, now, "https://github.com/o/r");
  assert.match(text, /Team events \(Team pages\) \(team-events\.yml\)/);
  assert.match(text, /Tue 29 Sep 2026, 16:20 AEST/); // last success, Sydney time
  assert.match(text, /Thu 1 Oct 2026, 11:16 AEST/); // first re-run
  assert.match(text, /2 attempts/);
  assert.match(text, /Team pages keep finished games listed as upcoming/);
  assert.match(text, /https:\/\/github\.com\/o\/r\/actions\/workflows\/team-events\.yml/);
  assert.match(text, /ops-status\.md/);
});

test("sydney: AEST/AEDT from the offset, across both 2026 changeovers", () => {
  assert.equal(sydney("2026-10-04T00:35:00Z"), "Sun 4 Oct 2026, 11:35 AEDT");
  assert.equal(sydney("2026-10-03T15:59:00Z"), "Sun 4 Oct 2026, 01:59 AEST");
  assert.equal(sydney("2026-04-04T16:00:00Z"), "Sun 5 Apr 2026, 02:00 AEST");
  assert.equal(sydney(null), "never");
});

// ---- the silent status file ------------------------------------------------------

const leads = (days) => ({ repeats: [{ team: "Ireland", days, since: "2026-10-03", heading: "Same story", flagged: true }] });

test("editorial signals never page and never touch the page signature", () => {
  // Was: "a repeat that runs a day longer, or a rung change, is a new state" —
  // that re-pinged Nico daily. Now they are status-file signals only.
  const now = new Date("2026-10-04T00:35:00Z");
  const status = buildStatus({ now, misses: [], paging: [], heals: {}, coverage: { gaps: [{ team: "Fiji", kickoff: "2026-10-10T05:00:00Z" }] }, repeats: leads(2), ladder: { model: "model-b", date: "2026-10-04" } });
  assert.equal(status.state, "attention");
  assert.deepEqual(status.paging, []);
  assert.equal(pageSignature(status.paging), "");
  assert.equal(decidePageAction(null, status.paging), "noop");
  assert.equal(decidePageAction({ number: 132, body: "<!-- sig: leads=[Ireland:2] -->" }, status.paging), "close");
  assert.deepEqual(status.signals.repeatLeads.map((r) => [r.team, r.since]), [["Ireland", "2026-10-03"]]);
  assert.deepEqual(status.signals.ladderLastRung, { model: "model-b", since: "2026-10-04" });
  assert.equal(status.signals.squadGaps[0].team, "Fiji");
});

test("statusLine / appendHistory: the change log grows only when the state changes, and ages out", () => {
  const t = (iso) => new Date(iso);
  const s1 = buildStatus({ now: t("2026-10-01T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: leads(2), ladder: null });
  assert.equal(statusLine(s1), "repeat leads: Ireland"); // no day count: it grew every morning
  const s2 = buildStatus({ now: t("2026-10-02T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: leads(2), ladder: null, prev: s1 });
  assert.equal(s2.history.length, 1); // same state → no new entry
  const s3 = buildStatus({ now: t("2026-10-03T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: null, ladder: null, prev: s2 });
  assert.equal(s3.state, "ok");
  assert.deepEqual(s3.history.map((h) => h.summary), ["repeat leads: Ireland", "all clear"]);
  const old = [{ at: "2026-08-01T00:00:00Z", summary: "a" }, { at: "2026-10-01T00:00:00Z", summary: "b" }];
  assert.deepEqual(appendHistory(old, { at: "2026-10-04T00:00:00Z", summary: "c" }, t("2026-10-04T00:00:00Z")).map((h) => h.summary), ["b", "c"]);
  const many = Array.from({ length: 80 }, (_, i) => ({ at: "2026-10-03T00:00:00Z", summary: `s${i}` }));
  assert.equal(appendHistory(many, { at: "2026-10-04T00:00:00Z", summary: "new" }, t("2026-10-04T00:00:00Z")).length, 60);
});

test("buildStatus + renderStatusMarkdown: overdue, heal and page are all readable for the weekly review", () => {
  const now = new Date("2026-10-02T01:40:00Z");
  const m = [overdue("team-events.yml", "2026-09-29T06:20:44Z"), overdue("team-events-catchup.yml", "2026-09-29T06:20:44Z")];
  const heals = { "team-events.yml": { firstAt: "2026-10-01T01:16:00.000Z", lastAt: now.toISOString(), attempts: 2, outcome: "re-run dispatched" } };
  const status = buildStatus({ now, misses: m, paging: [m[0]], heals, coverage: null, repeats: null, ladder: null });
  assert.equal(status.state, "paging");
  assert.deepEqual(status.overdue.map((o) => [o.workflow, o.userFacing, o.paging]), [["team-events.yml", true, true], ["team-events-catchup.yml", false, false]]);
  assert.equal(statusLine(status), "PAGING: team-events.yml; overdue: team-events.yml, team-events-catchup.yml");
  const md = renderStatusMarkdown(status);
  assert.match(md, /^# Ops status/);
  assert.match(md, /\*\*State: PAGING/);
  assert.match(md, /All times Sydney time/);
  assert.match(md, /`team-events\.yml`, user-facing\) — last success Tue 29 Sep 2026, 16:20 AEST/);
  assert.match(md, /Self-heal: re-run dispatched \(attempt 2; first Thu 1 Oct 2026, 11:16 AEST/);
  assert.match(md, /not user-facing — never pages/);
  // Deterministic: the same status renders the same file, so an unchanged day is no commit.
  assert.equal(md, renderStatusMarkdown(JSON.parse(JSON.stringify(status))));
});

test("writeStatus: writes both files the first time, then only when the state changed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ops-status-"));
  try {
    const paths = { jsonPath: join(dir, "health", "ops-status.json"), mdPath: join(dir, "health", "ops-status.md") };
    const s = buildStatus({ now: new Date("2026-10-04T00:35:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: null, ladder: null });
    assert.equal(await writeStatus(s, paths), true);
    assert.equal(JSON.parse(await readFile(paths.jsonPath, "utf8")).state, "ok");
    assert.match(await readFile(paths.mdPath, "utf8"), /State: OK/);
    assert.equal(await writeStatus(JSON.parse(JSON.stringify(s)), paths), false); // unchanged → no write, no commit
    const s2 = buildStatus({ now: new Date("2026-10-05T00:35:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: leads(2), ladder: null, prev: s });
    assert.equal(await writeStatus(s2, paths), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The digests ran green from 23 to 25 September 2026 while the Springbok tab
// showed the same story under three dates. "Did it run?" is not "did it say
// anything new?" — the run reports are where the second question is answered.
const run = (date, rows, model) => ({
  date,
  teams: rows.map(([team, heading, body, leadLink]) => ({ team, heading, body, leadLink: leadLink ?? null })),
  ...(model ? { model } : {}),
});
const ESTER = "https://www.planetrugby.com/news/springboks-team-v-wallabies";

test("repeatLeadReport: a lead repeated for two days is reported with its run length", () => {
  const reports = [
    run("2026-09-23", [
      ["South Africa", "André Esterhuizen named Springboks captain as Rassie Erasmus rotates the squad", "Erasmus has named Esterhuizen captain in a heavily changed side to face the Wallabies.", ESTER],
      ["England", "Maro Itoje returns to England squad", "Borthwick recalls Itoje."],
    ]),
    run("2026-09-24", [
      ["South Africa", "Andre Esterhuizen captains heavily changed Springboks side to face Wallabies", "Rassie Erasmus has made 13 changes, naming Esterhuizen captain.", ESTER],
      ["England", "Elliot Daly loses central contract", "Borthwick hands out five new contracts."],
    ]),
    run("2026-09-25", [
      ["South Africa", "Andre Esterhuizen captains heavily changed South Africa side against Australia", "Rassie Erasmus has made 13 changes to his starting XV for Sunday's Test, naming Andre Esterhuizen as captain.", ESTER],
      ["England", "Premiership clubs agree law interpretation overhaul", "Borthwick secured a tactical shift."],
    ]),
  ];
  const out = repeatLeadReport(reports);
  assert.equal(out.repeats.length, 1);
  assert.deepEqual({ team: out.repeats[0].team, days: out.repeats[0].days, since: out.repeats[0].since }, { team: "South Africa", days: 3, since: "2026-09-23" });
  assert.match(out.text, /South Africa — same lead story for 3 days \(since Wed 23 Sep\)/);
  assert.match(out.text, /did NOT flag it/);
});

test("repeatLeadReport: nothing to say when every team moved on, or with a single report", () => {
  const a = run("2026-09-24", [["England", "Elliot Daly loses central contract", "Borthwick hands out five new contracts."]]);
  const b = run("2026-09-25", [["England", "Premiership clubs agree law interpretation overhaul", "Borthwick secured a tactical shift."]]);
  assert.equal(repeatLeadReport([a, b]), null);
  assert.equal(repeatLeadReport([b]), null);
  assert.equal(repeatLeadReport([]), null);
});

test("repeatLeadReport: the run length stops at the first different story, and a gate flag is named", () => {
  const reports = [
    run("2026-09-22", [["Fiji", "Fiji name squad for Pacific Nations Cup final", "Seruvakula recalls Muntz."]]),
    run("2026-09-23", [["Fiji", "Fijian forward Saimoni Vunilagi dies in Japan after suspected heatstroke", "The Kyuden Voltex player collapsed in training."]]),
    run("2026-09-24", [["Fiji", "Fijian forward Saimoni Vunilagi dies in Japan from suspected heatstroke", "The Kyuden Voltex player collapsed in training."]]),
  ];
  reports[2].teams[0].repeatLead = { date: "2026-09-23", reason: "heading overlap 0.89" };
  const out = repeatLeadReport(reports);
  assert.equal(out.repeats[0].days, 2);
  assert.equal(out.repeats[0].since, "2026-09-23");
  assert.match(out.text, /flagged it and published anyway/);
});

test("ladderReport: only a run that completed on the last rung is an alert", () => {
  assert.equal(ladderReport(run("2026-09-25", [], { servedBy: "gemini-3.5-flash", onLastRung: false })), null);
  assert.equal(ladderReport(run("2026-09-25", [])), null, "an older report without the field is not an alert");
  const out = ladderReport(run("2026-09-25", [], { servedBy: "gemini-3.5-flash-lite", onLastRung: true, calls: 40, rejections: 36 }));
  assert.equal(out.model, "gemini-3.5-flash-lite");
  assert.match(out.text, /LAST rung .*gemini-3\.5-flash-lite/);
});

// ---- review fixes, 4 Oct 2026 --------------------------------------------------
// Each block below covers a gap found before the quiet-alerts change shipped.

const HOUR = 3600000;
const NOV = Date.UTC(2026, 10, 1, 1, 0); // Sun 1 Nov 2026, 01:00 UTC (12:00 AEDT), a typical watchdog start
const freshAll = (now) => Object.fromEntries(LIVE_WATCHERS.map((w) => [w.workflow, new Date(now - HOUR)]));

// One watchdog run's pure decisions, strung together the way main() does.
function watchdogRun(now, latest, prev, { unknown = [] } = {}) {
  const misses = evaluate(now, latest, LIVE_WATCHERS, { unknown });
  const paging = pagingMisses(misses, prev?.heals, now);
  const plan = selectHeals(misses, {});
  const results = Object.fromEntries(plan.dispatch.map((w) => [w, { ok: true }]));
  const heals = nextHeals(prev?.heals, misses, plan, results, now, { unknown });
  return { misses, paging, plan, heals };
}

// 1. refresh-data's limit is 6h and the watchdog runs daily. With its own cron
// and the Worker both dead, the watchdog's re-run succeeds every morning, which
// reset the outage to attempts:1 each day, so it never paged.
test("streak: a job whose re-run works but whose own schedule stays dead pages on its third overdue run in a row", () => {
  let prev = null;
  const seen = [];
  for (let d = 0; d < 4; d++) {
    const now = new Date(NOV + d * 24 * HOUR);
    // Only the watchdog's own re-run lands, ten minutes after each watchdog run.
    const lastRefresh = d === 0 ? new Date(now - 20 * HOUR) : new Date(NOV + (d - 1) * 24 * HOUR + 10 * 60000);
    const r = watchdogRun(now, { ...freshAll(now), "refresh-data.yml": lastRefresh }, prev);
    const h = r.heals["refresh-data.yml"];
    seen.push({ paging: r.paging.map((m) => m.workflow), streak: h.streak, attempts: h.attempts });
    prev = { heals: JSON.parse(JSON.stringify(r.heals)) };
  }
  assert.deepEqual(seen.map((s) => s.attempts), [1, 1, 1, 1]); // each re-run worked, so the old rule saw a new outage daily
  assert.deepEqual(seen.map((s) => s.streak), [1, 2, 3, 4]);
  assert.deepEqual(seen.map((s) => s.paging), [[], [], ["refresh-data.yml"], ["refresh-data.yml"]]);
});

test("nextHeals streak: counts consecutive overdue runs across a successful re-run; a healthy run clears it", () => {
  const d0 = new Date(NOV);
  const d1 = new Date(NOV + 24 * HOUR);
  const d2 = new Date(NOV + 48 * HOUR);
  const m = (last) => [overdue("refresh-data.yml", last)];
  const plan = { dispatch: ["refresh-data.yml"], skipped: [] };
  const ok = { "refresh-data.yml": { ok: true } };
  const h0 = nextHeals({}, m(new Date(d0 - 20 * HOUR)), plan, ok, d0);
  assert.equal(h0["refresh-data.yml"].streak, 1);
  assert.equal(h0["refresh-data.yml"].streakSince, d0.toISOString());
  // The re-run landed and it is overdue again a day later: a new outage for the
  // attempt count, the same streak.
  const h1 = nextHeals(h0, m(new Date(d0.getTime() + 10 * 60000)), plan, ok, d1);
  assert.equal(h1["refresh-data.yml"].firstAt, d1.toISOString());
  assert.equal(h1["refresh-data.yml"].attempts, 1);
  assert.equal(h1["refresh-data.yml"].streak, 2);
  assert.equal(h1["refresh-data.yml"].streakSince, d0.toISOString());
  // A run that finds it healthy drops the record, so the next outage counts from 1.
  const healthy = nextHeals(h1, [], { dispatch: [], skipped: [] }, {}, d2);
  assert.deepEqual(healthy, {});
  const again = nextHeals(healthy, m(new Date(d2 - 7 * HOUR)), plan, ok, new Date(d2.getTime() + 24 * HOUR));
  assert.equal(again["refresh-data.yml"].streak, 1);
  // A record written before the streak existed counts as one run, starting at its outage.
  const legacy = nextHeals({ "refresh-data.yml": { firstAt: d0.toISOString(), attempts: 1 } }, m(new Date(d0 - 20 * HOUR)), plan, ok, d1);
  assert.equal(legacy["refresh-data.yml"].streak, 2);
  assert.equal(legacy["refresh-data.yml"].streakSince, d0.toISOString());
});

test("pagingMisses streak rule: two earlier overdue runs spanning the heal floor, user-facing jobs only", () => {
  const now = new Date(NOV + 48 * HOUR);
  const afterHeal = new Date(NOV + 24 * HOUR + 10 * 60000); // a success after the latest heal: the first rule stays quiet
  const rec = (streak, streakSince = new Date(NOV).toISOString()) => ({ firstAt: new Date(NOV + 24 * HOUR).toISOString(), attempts: 1, streak, streakSince });
  const m = [overdue("refresh-data.yml", afterHeal), overdue("team-events-catchup.yml", afterHeal)];
  assert.deepEqual(pagingMisses(m, { "refresh-data.yml": rec(1) }, now), []); // second overdue run in a row: not yet
  assert.deepEqual(
    pagingMisses(m, { "refresh-data.yml": rec(2), "team-events-catchup.yml": rec(5) }, now).map((x) => x.workflow),
    ["refresh-data.yml"],
  ); // the catch-up never pages
  // Three watchdog runs inside twenty minutes (manual re-runs) are not a day of failure.
  const quick = new Date(NOV + 20 * 60000);
  assert.deepEqual(pagingMisses([overdue("refresh-data.yml")], { "refresh-data.yml": { firstAt: new Date(NOV).toISOString(), attempts: 1, streak: 2, streakSince: new Date(NOV).toISOString() } }, quick), []);
  assert.deepEqual(pagingMisses(m, { "refresh-data.yml": { ...rec(2), streakSince: "garbage", firstAt: "garbage" } }, now), []);
});

test("pageReport: a job that keeps falling behind says so, instead of 'no success since'", () => {
  const now = new Date(NOV + 48 * HOUR);
  const p = [overdue("refresh-data.yml", new Date(NOV + 24 * HOUR + 10 * 60000).toISOString())];
  const text = pageReport(p, { "refresh-data.yml": { firstAt: now.toISOString(), attempts: 1, streak: 3, streakSince: new Date(NOV).toISOString() } }, now);
  assert.match(text, /overdue on 3 watchdog runs in a row since Sun 1 Nov 2026, 12:00 AEDT/);
  assert.match(text, /live scores, fixtures and tables stop updating/);
  assert.doesNotMatch(text, /still no success since/);
  const md = renderStatusMarkdown(buildStatus({ now, misses: p, paging: p, heals: { "refresh-data.yml": { firstAt: now.toISOString(), lastAt: now.toISOString(), attempts: 1, outcome: "re-run dispatched", streak: 3, streakSince: new Date(NOV).toISOString() } }, coverage: null, repeats: null, ladder: null }));
  assert.match(md, /overdue on 3 watchdog runs in a row since Sun 1 Nov 2026, 12:00 AEDT/);
});

// 2. findAlertIssue only sees OPEN issues, so a page Nico closed while the
// outage went on was re-created, and re-pinged him, every day.
test("page record: a page Nico closed stays closed while that outage continues; a new job or a new outage pages", () => {
  const stored = { signature: "refresh-data.yml", openedAt: "2026-11-02T01:00:00.000Z" };
  assert.equal(decidePageAction(null, [miss("refresh-data.yml")], stored), "noop"); // closed by hand, same outage
  assert.equal(decidePageAction(null, [miss("refresh-data.yml"), miss("team-events.yml")], stored), "create"); // a job he wasn't paged for
  assert.equal(decidePageAction(null, [miss("refresh-data.yml")], null), "create"); // no record: first page
  assert.equal(decidePageAction(null, [miss("refresh-data.yml")]), "create");
  const open = { number: 150, body: "x\n<!-- page: refresh-data.yml -->" };
  assert.equal(decidePageAction(open, [miss("refresh-data.yml")], stored), "edit"); // an open page behaves as before

  const now = new Date("2026-11-04T01:00:00Z");
  const one = [miss("refresh-data.yml")];
  assert.equal(nextPageRecord(stored, [], "close", { now }), null); // nothing pages: cleared
  assert.equal(nextPageRecord(stored, [], "noop", { now }), null);
  assert.deepEqual(nextPageRecord(null, one, "create", { now }), { signature: "refresh-data.yml", openedAt: now.toISOString() });
  assert.deepEqual(nextPageRecord(stored, one, "noop", { now }), stored); // closed by hand: the original page is kept
  assert.deepEqual(nextPageRecord(stored, one, "edit", { now }), stored);
  assert.deepEqual(nextPageRecord(stored, [...one, miss("team-events.yml")], "update", { now }), { signature: "refresh-data.yml,team-events.yml", openedAt: stored.openedAt });
  // An open page found with no record (a lost status write): openedAt from the issue.
  assert.deepEqual(nextPageRecord(null, one, "edit", { now, openedAt: "2026-11-03T00:00:00Z" }), { signature: "refresh-data.yml", openedAt: "2026-11-03T00:00:00Z" });
  // Never remember a page that was not sent, or it would never be retried.
  assert.equal(nextPageRecord(null, one, "create", { now, ok: false }), null);
  assert.equal(nextPageRecord(null, one, "error", { now }), null);
  assert.deepEqual(nextPageRecord(stored, one, "error", { now }), stored);
});

test("a page Nico closes after the first ping is the only ping of that outage; the next outage pages again", () => {
  let prev = null;
  const actions = [];
  const dead = new Date(NOV - 10 * HOUR);
  for (let d = 0; d < 8; d++) {
    const now = new Date(NOV + d * 24 * HOUR);
    // Dead on days 0-4, healthy on day 5, dead again from day 6.
    const lastRefresh = d < 5 ? dead : d === 5 ? new Date(now - HOUR) : new Date(NOV + 5 * 24 * HOUR - HOUR);
    const r = watchdogRun(now, { ...freshAll(now), "refresh-data.yml": lastRefresh }, prev);
    const action = decidePageAction(null, r.paging, prev?.page ?? null); // he closed it straight away: never an open issue
    actions.push(action);
    const page = nextPageRecord(prev?.page ?? null, r.paging, action, { now });
    prev = JSON.parse(JSON.stringify(buildStatus({ now, misses: r.misses, paging: r.paging, heals: r.heals, coverage: null, repeats: null, ladder: null, prev, page })));
    if (d === 2) assert.deepEqual(prev.page, { signature: "refresh-data.yml", openedAt: new Date(NOV + 24 * HOUR).toISOString() });
    if (d === 5) assert.equal(prev.page, null); // the healthy run clears it
  }
  assert.deepEqual(actions, ["noop", "create", "noop", "noop", "noop", "noop", "noop", "create"]);
});

test("syncPageIssue: with the page closed by hand it writes nothing to GitHub, and a create is recorded only once it succeeded", async () => {
  const now = new Date(NOV + 48 * HOUR);
  const paging = [overdue("refresh-data.yml", new Date(NOV - 10 * HOUR).toISOString())];
  const calls = [];
  const fakeGh = (issues, { fail = false } = {}) => async (args) => {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(issues);
    if (fail) throw new Error("HTTP 502");
    return "https://github.com/o/r/issues/151\n";
  };
  const stored = { signature: "refresh-data.yml", openedAt: "2026-11-02T01:00:00.000Z" };
  const quiet = await syncPageIssue(paging, {}, now, "", { stored, gh: fakeGh([]) });
  assert.equal(quiet.action, "noop");
  assert.deepEqual(quiet.page, stored);
  assert.deepEqual(calls, ["issue list"]);

  calls.length = 0;
  const created = await syncPageIssue(paging, {}, now, "", { stored: null, gh: fakeGh([]) });
  assert.equal(created.action, "create");
  assert.deepEqual(created.page, { signature: "refresh-data.yml", openedAt: now.toISOString() });
  assert.deepEqual(calls, ["issue list", "issue create"]);

  await assert.rejects(syncPageIssue(paging, {}, now, "", { stored: null, gh: fakeGh([], { fail: true }) }), /HTTP 502/);
});

// 4. The 35-day age cut removed the ONLY entry after a long unchanged spell:
// day 36 wrote an empty log, day 37 re-added it — two pointless commits.
test("appendHistory always keeps the newest entry, so a long unchanged state never empties the change log", () => {
  const only = [{ at: "2026-11-01T01:00:00.000Z", summary: "all clear" }];
  const later = new Date("2026-12-10T01:00:00Z");
  assert.deepEqual(appendHistory(only, { at: later.toISOString(), summary: "all clear" }, later), only);
  let prev = null;
  const writes = new Set();
  for (let d = 0; d < 40; d++) {
    const now = new Date(NOV + d * 24 * HOUR);
    prev = JSON.parse(JSON.stringify(buildStatus({ now, misses: [], paging: [], heals: {}, coverage: null, repeats: null, ladder: null, prev })));
    writes.add(JSON.stringify(prev));
  }
  assert.equal(writes.size, 1); // forty all-clear days, one write
  assert.equal(prev.history.length, 1);
});

// 5. A failed scheduled run emails Nico through GitHub's own failure notice.
// The ops-status push races the live refresh, so it must neither give up after
// one retry nor turn the run red.
test("watchdog.yml: the ops-status push retries three times and can never fail the run", async () => {
  const yml = await readFile(new URL("../.github/workflows/watchdog.yml", import.meta.url), "utf8");
  const step = yml.split(/\n(?= {6}- )/).find((s) => s.includes("name: Commit the ops status"));
  assert.ok(step, "the commit step exists");
  assert.match(step, /^ {8}continue-on-error: true$/m);
  assert.match(step, /for i in 1 2 3; do git push && exit 0; git pull --rebase --autostash; done; exit 1/);
  assert.doesNotMatch(step, /git push \|\|/);
});

// 6. Day counts, reworded headlines and the ladder's report date changed every
// morning: replaying 21 Sep-4 Oct gave 13 commits in 14 days.
test("status file: a repeat lead and a last-rung ladder that simply carry on are byte-identical the next day", async () => {
  const sa = [
    ["South Africa", "André Esterhuizen named Springboks captain as Rassie Erasmus rotates the squad", "Erasmus has named Esterhuizen captain in a heavily changed side to face the Wallabies.", ESTER],
    ["South Africa", "Andre Esterhuizen captains heavily changed Springboks side to face Wallabies", "Rassie Erasmus has made 13 changes, naming Esterhuizen captain.", ESTER],
    ["South Africa", "Andre Esterhuizen captains heavily changed South Africa side against Australia", "Rassie Erasmus has made 13 changes to his starting XV for Sunday's Test, naming Andre Esterhuizen as captain.", ESTER],
  ];
  const lastRung = { servedBy: "model-c", onLastRung: true, calls: 40, rejections: 36 };
  const reports = ["2026-09-23", "2026-09-24", "2026-09-25"].map((date, i) => run(date, [sa[i]], lastRung));
  const day = (n, prev) => {
    const window = reports.slice(0, n);
    return buildStatus({
      now: new Date(`${window[window.length - 1].date}T01:00:00Z`), misses: [], paging: [], heals: {}, coverage: null,
      repeats: repeatLeadReport(window), ladder: ladderReport(window[window.length - 1]), prev,
    });
  };
  const s2 = day(2, null);
  const s3 = day(3, JSON.parse(JSON.stringify(s2)));
  assert.equal(repeatLeadReport(reports.slice(0, 2)).repeats[0].days, 2);
  assert.equal(repeatLeadReport(reports).repeats[0].days, 3); // the run log still says how long
  assert.equal(JSON.stringify(s3), JSON.stringify(s2)); // ...the committed file does not
  assert.equal(statusLine(s3), "repeat leads: South Africa; model ladder on its last rung");
  assert.deepEqual(s3.signals.repeatLeads[0], { team: "South Africa", since: "2026-09-23", heading: sa[0][1], flagged: false });
  assert.deepEqual(s3.signals.ladderLastRung, { model: "model-c", since: "2026-09-24" });
  const md = renderStatusMarkdown(s3);
  assert.match(md, /South Africa — same lead story since Wed 23 Sep/);
  assert.match(md, /LAST rung \(model-c\) since Thu 24 Sep/);
  const dir = await mkdtemp(join(tmpdir(), "ops-status-"));
  try {
    const paths = { jsonPath: join(dir, "ops-status.json"), mdPath: join(dir, "ops-status.md") };
    assert.equal(await writeStatus(s2, paths), true);
    assert.equal(await writeStatus(s3, paths), false); // no commit
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status file: a repeat as long as the report window keeps the start it was first seen with", () => {
  const window = (from) => Array.from({ length: 3 }, (_, i) => run(`2026-09-${String(from + i).padStart(2, "0")}`, [["Japan", "Eddie Jones names Japan squad for the Pacific Nations Cup final", "Jones recalls three uncapped forwards."]]));
  const full = repeatLeadReport(window(22));
  assert.equal(full.repeats[0].open, true); // the run reaches the oldest report it was given
  const broken = repeatLeadReport([run("2026-09-21", [["Japan", "Japan lose to Fiji", "A different story."]]), ...window(22)]);
  assert.equal(broken.repeats[0].open, false);
  const prev = { signals: { repeatLeads: [{ team: "Japan", since: "2026-09-18", heading: "Eddie Jones names Japan squad", flagged: false }] } };
  const s = buildStatus({ now: new Date("2026-09-25T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: repeatLeadReport(window(23)), ladder: null, prev });
  assert.deepEqual(s.signals.repeatLeads[0], prev.signals.repeatLeads[0]); // the window slid; the story didn't start again
  // A run that visibly starts inside the window is a new one, whatever came before.
  const fresh = buildStatus({ now: new Date("2026-09-25T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: broken, ladder: null, prev });
  assert.equal(fresh.signals.repeatLeads[0].since, "2026-09-22");
});

// 7. A failed `gh run list` used to count as "no success at all": two flaky API
// days would page a healthy job.
test("unknown: a workflow whose run history can't be read is not overdue, not re-run, not paged, keeps its record, and is in the status file", () => {
  const now = new Date(NOV + 24 * HOUR);
  const unknown = [{ ...W["refresh-data.yml"], error: "HTTP 502: Bad Gateway" }];
  const latest = freshAll(now);
  delete latest["refresh-data.yml"]; // the query failed: nothing to say
  const prevHeals = { "refresh-data.yml": { firstAt: new Date(NOV).toISOString(), lastAt: new Date(NOV).toISOString(), attempts: 1, outcome: "re-run dispatched", streak: 1, streakSince: new Date(NOV).toISOString() } };
  const r = watchdogRun(now, latest, { heals: prevHeals }, { unknown });
  assert.deepEqual(r.misses, []);
  assert.deepEqual(r.paging, []);
  assert.deepEqual(r.plan.dispatch, []);
  assert.deepEqual(r.heals, prevHeals); // neither a recovery (that clears it) nor another overdue run
  const status = buildStatus({ now, misses: r.misses, paging: r.paging, heals: r.heals, coverage: null, repeats: null, ladder: null, unknown });
  assert.equal(status.state, "attention");
  assert.deepEqual(status.unknown, [{ workflow: "refresh-data.yml", label: "Live data refresh", error: "HTTP 502: Bad Gateway" }]);
  assert.equal(statusLine(status), "status unknown: refresh-data.yml");
  assert.match(renderStatusMarkdown(status), /Live data refresh\*\* \(`refresh-data\.yml`\) — its run history could not be read \(HTTP 502: Bad Gateway\)/);
  // Without the unknown flag the same gap reads as a miss: the old behaviour.
  assert.deepEqual(evaluate(now, latest, LIVE_WATCHERS).map((m) => m.workflow), ["refresh-data.yml"]);
});

test("unknown: a job that was already paging and can't be read keeps its page as it is (no close, no second ping)", () => {
  const now = new Date(NOV + 48 * HOUR);
  const stored = { signature: "refresh-data.yml", openedAt: new Date(NOV + 24 * HOUR).toISOString() };
  const open = { number: 150, body: "x\n<!-- page: refresh-data.yml -->" };
  const unknown = [{ ...W["refresh-data.yml"], error: "HTTP 502" }, { ...W["team-events.yml"], error: "HTTP 502" }];
  const held = heldPages(unknown, open, stored);
  assert.deepEqual(held.map((h) => h.workflow), ["refresh-data.yml"]); // team-events was not paging: nothing to hold
  assert.equal(decidePageAction(open, held, stored), "edit"); // was "close", then "create" (a ping) the next day
  assert.equal(decidePageAction(null, held, stored), "noop");
  assert.deepEqual(nextPageRecord(stored, held, "edit", { now }), stored);
  assert.deepEqual(heldPages(unknown, null, null), []);
  assert.deepEqual(heldPages(unknown, null, stored).map((h) => h.workflow), ["refresh-data.yml"]);
  assert.match(pageReport(held, {}, now), /could not be read this time \(HTTP 502\)/);
  const status = buildStatus({ now, misses: [], paging: held, heals: {}, coverage: null, repeats: null, ladder: null, unknown, page: stored });
  assert.equal(status.state, "paging");
  assert.deepEqual(status.paging.map((p) => [p.workflow, p.unknown]), [["refresh-data.yml", true]]);
});
