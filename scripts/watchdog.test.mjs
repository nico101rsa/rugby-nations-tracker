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
  assert.deepEqual(h1["team-events.yml"], { firstAt: day1.toISOString(), lastAt: day1.toISOString(), attempts: 1, outcome: "re-run dispatched" });

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
  assert.deepEqual(status.signals.repeatLeads.map((r) => [r.team, r.days]), [["Ireland", 2]]);
  assert.deepEqual(status.signals.ladderLastRung, { model: "model-b", date: "2026-10-04" });
  assert.equal(status.signals.squadGaps[0].team, "Fiji");
});

test("statusLine / appendHistory: the change log grows only when the state changes, and ages out", () => {
  const t = (iso) => new Date(iso);
  const s1 = buildStatus({ now: t("2026-10-01T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: leads(2), ladder: null });
  assert.equal(statusLine(s1), "repeat leads: Ireland 2d");
  const s2 = buildStatus({ now: t("2026-10-02T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: leads(2), ladder: null, prev: s1 });
  assert.equal(s2.history.length, 1); // same state → no new entry
  const s3 = buildStatus({ now: t("2026-10-03T01:00:00Z"), misses: [], paging: [], heals: {}, coverage: null, repeats: null, ladder: null, prev: s2 });
  assert.equal(s3.state, "ok");
  assert.deepEqual(s3.history.map((h) => h.summary), ["repeat leads: Ireland 2d", "all clear"]);
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
