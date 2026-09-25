import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, formatReport, coverageReport, alertSignature, decideIssueAction, repeatLeadReport, ladderReport } from "./watchdog.mjs";
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

// ---- GitHub-issue alerting ---------------------------------------------------
// Email is dead (Gmail SMTP app-passwords 535 from Actions IPs), so alerts go to
// a GitHub issue via the built-in GITHUB_TOKEN. It must not re-notify every day
// for a state it already reported — the signature is what makes it idempotent.

const miss = (workflow) => ({ workflow, label: workflow, maxAgeHours: 6, lastSuccessAt: null, ageHours: null });

test("alertSignature is stable regardless of ordering", () => {
  const a = alertSignature([miss("b.yml"), miss("a.yml")], { gaps: [{ team: "Wales" }, { team: "Fiji" }] });
  const b = alertSignature([miss("a.yml"), miss("b.yml")], { gaps: [{ team: "Fiji" }, { team: "Wales" }] });
  assert.equal(a, b);
  assert.match(a, /Fiji/);
  assert.notEqual(a, alertSignature([miss("a.yml")], { gaps: [{ team: "Fiji" }] })); // different state → different sig
});

test("decideIssueAction opens, stays quiet, updates on change, and closes when healthy", () => {
  const sig = "jobs=[] squads=[Fiji]";
  const open = { number: 7, body: `something\n<!-- sig: ${sig} -->` };

  assert.equal(decideIssueAction(null, sig, false), "create"); // first time
  assert.equal(decideIssueAction(open, sig, false), "noop"); // same state → don't re-ping daily
  assert.equal(decideIssueAction(open, "jobs=[] squads=[Fiji,Wales]", false), "update"); // state worsened
  assert.equal(decideIssueAction(open, "", true), "close"); // recovered
  assert.equal(decideIssueAction(null, "", true), "noop"); // healthy, nothing open
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

test("alertSignature: a repeat that runs a day longer, or a rung change, is a new state", () => {
  const rep = (days) => ({ repeats: [{ team: "South Africa", days }] });
  assert.notEqual(alertSignature([], null, rep(2)), alertSignature([], null, rep(3)));
  assert.notEqual(alertSignature([], null, null, { model: "x" }), alertSignature([], null, null, null));
  assert.equal(alertSignature([], null), "jobs=[] squads=[] leads=[] rung=[]");
});
