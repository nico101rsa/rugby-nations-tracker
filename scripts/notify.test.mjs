import { test } from "node:test";
import assert from "node:assert/strict";
import { issueCreateArgs, postIssue } from "./notify.mjs";

// Who gets pinged is decided here, once. Silent is the default: the rankings,
// competitions, vendor-probe and stats tickets are for the Claude weekly
// review to triage, so they carry no @mention and no assignee. Only an
// explicit `page: true` (the watchdog's persisting-outage tier) reaches Nico.

test("issueCreateArgs: silent by default — no @mention, no assignee", () => {
  const args = issueCreateArgs({ title: "World rankings: table is stale", body: "Detail." });
  assert.deepEqual(args, ["issue", "create", "--title", "World rankings: table is stale", "--body", "Detail."]);
  assert.ok(!args.includes("--assignee"));
  assert.ok(!args.some((a) => a.includes("@")), "no @mention anywhere in a silent issue");
});

test("issueCreateArgs: page: true assigns and @mentions the owner", () => {
  const args = issueCreateArgs({ title: "⚠️ Rugby Tracker ops alert", body: "Team events down.", page: true, owner: "someone" });
  assert.deepEqual(args, ["issue", "create", "--title", "⚠️ Rugby Tracker ops alert", "--body", "@someone\n\nTeam events down.", "--assignee", "someone"]);
});

test("postIssue: callers that pass nothing extra file a silent issue", async () => {
  const calls = [];
  const gh = async (args) => { calls.push(args); return "https://github.com/o/r/issues/1\n"; };
  const url = await postIssue({ title: "Competition integrity: X", body: "Y", gh });
  assert.equal(url, "https://github.com/o/r/issues/1");
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("--assignee"));
  assert.equal(calls[0][calls[0].indexOf("--body") + 1], "Y");

  await postIssue({ title: "T", body: "B", page: true, owner: "someone", gh });
  assert.ok(calls[1].includes("--assignee"));
  assert.match(calls[1][calls[1].indexOf("--body") + 1], /^@someone\n\nB$/);
});
